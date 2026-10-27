// The llama-server sidecar: spawn/health/stop lifecycle, the single-
// flight chat queue, and SSE/think-tag streaming helpers. Plain-node
// testable: initLlmServer accepts path/spawn overrides and the download
// helpers accept injected fetchers.

// 2026-10-25 split: the paths + download layer live in binaries.ts, the
// shared init state in runtime.ts (field-assigned, never rebound); this
// module owns the running sidecar and the chat path.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import { trackChild, killTrackedChild } from "../child-registry.ts";
import { broadcastLlm, fetchImpl, llmStatusEvent, state } from "./runtime.ts";
import {
	binaryDownloaded,
	binaryMetaPath,
	binaryPath,
	modelDownloaded,
	modelFilePath,
} from "./binaries.ts";
import { getLlmModel, resolveLlmModelId } from "./models.ts";

// One answer's generation ceiling — also the natural upper bound on how
// long a stalled HTTP body stays open. A 1.7B on 4 threads answers well
// inside this; the cap exists so a wedged server can never hang Ask.
const CHAT_TIMEOUT_MS = 300_000;
// Model load on first spawn (mmap + warmup) is seconds, but a cold 3B on a
// busy 8GB machine may page — the health poll deadline stays generous.
const HEALTH_TIMEOUT_MS = 180_000;
// Kill the sidecar after this long with no chat (Ask is a burst feature).
const IDLE_STOP_MS = 5 * 60_000;

interface LlmServerState {
	proc: ChildProcess | null;
	port: number;
	modelId: string | null;
	ready: boolean;
	starting: Promise<number> | null;
	startingModelId: string | null;
	lastUsed: number;
	idleTimer: NodeJS.Timeout | null;
	stderrTail: string;
	chatQueue: Promise<unknown>;
}

const server: LlmServerState = {
	proc: null,
	port: 0,
	modelId: null,
	ready: false,
	starting: null,
	// Which model the in-flight startup is for: a switch requested mid-start
	// must not join (and inherit) the wrong model's promise.
	startingModelId: null,
	lastUsed: 0,
	idleTimer: null,
	stderrTail: "",
	// Serializes chat calls: Ask is single-flight by design, and a second
	// question queued behind a generating one beats interleaved 503s.
	chatQueue: Promise.resolve(),
};

// The in-flight startup, if any.
//
// The child is only ADOPTED into server.proc once it is healthy, so during
// the (up to HEALTH_TIMEOUT_MS) health window there was no handle on it at
// all: a quit in that window orphaned a llama-server holding the model
// resident. The start is cancelled explicitly now — stopServer() cancels it
// and the child is killed through the tracked-child registry.
interface PendingStart {
	cancelled: boolean;
	cancel: () => void;
}

let pendingStart: PendingStart | null = null;

/**
 * Thrown when a start was cancelled (quit, or a stop landing mid-start).
 *
 * Distinct from a spawn failure on purpose: a cancelled start must NOT be
 * retried — the caller wants the server DOWN, and a retry would spawn a
 * fresh child that outlives the app.
 */
export class StartCancelledError extends Error {
	constructor() {
		super("llama-server start cancelled");
		this.name = "StartCancelledError";
	}
}

// ---------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------

function pickFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.unref();
		srv.on("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address() as AddressInfo;
			srv.close(() => resolve(port));
		});
	});
}

function chatThreads(): number {
	return Math.max(1, Math.min(4, os.cpus() ? os.cpus().length : 1));
}

function noteStderr(chunk: Buffer | string | null | undefined): void {
	if (!chunk) return;
	server.stderrTail = (server.stderrTail + chunk.toString()).slice(-4000);
}

function spawnArgs(
	modelPath: string,
	port: number,
	ctxTokens: number,
	withReasoningFlag: boolean,
): string[] {
	const args = [
		"-m",
		modelPath,
		"--host",
		"127.0.0.1",
		"--port",
		String(port),
		"-c",
		String(ctxTokens),
		"-t",
		String(chatThreads()),
	];
	// Qwen3's chat template enables thinking by default — Ask answers cite
	// evidence and don't want a hidden reasoning preamble burning the ctx.
	// Older builds reject the flag: the caller retries without it once.
	if (withReasoningFlag) args.push("--reasoning-budget", "0");
	return args;
}

async function pollHealth(
	port: number,
	deadlineMs: number,
	start?: PendingStart,
): Promise<boolean> {
	const started = Date.now();
	const fetchNow = fetchImpl();
	for (;;) {
		if (start?.cancelled) {
			throw new Error("llama-server health poll cancelled");
		}
		if (Date.now() - started > deadlineMs) {
			throw new Error("llama-server did not become healthy in time");
		}
		try {
			const res = await fetchNow(`http://127.0.0.1:${port}/health`, {
				signal: AbortSignal.timeout(2000),
			});
			if (res.ok) return true;
		} catch {
			/* not up yet — poll again */
		}
		if (start?.cancelled) {
			throw new Error("llama-server health poll cancelled");
		}
		await new Promise((r) => setTimeout(r, 300));
	}
}

function armIdleStop(): void {
	if (server.idleTimer) clearTimeout(server.idleTimer);
	server.idleTimer = setTimeout(() => {
		stopServer("idle");
	}, IDLE_STOP_MS);
	if (server.idleTimer.unref) server.idleTimer.unref();
}

// One sidecar for one model at a time — a model switch is a respawn (the
// weights stay resident otherwise), mirroring the CLIP pool's contract.
export function stopServer(reason?: string): void {
	if (server.idleTimer) {
		clearTimeout(server.idleTimer);
		server.idleTimer = null;
	}
	// Cancel an in-flight startup. The child is not in server.proc yet (it is
	// only adopted once healthy), so this is the ONLY handle on it during the
	// health window — without the cancel, a quit mid-cold-start orphaned a
	// llama-server holding the model resident.
	if (pendingStart) {
		const start = pendingStart;
		pendingStart = null;
		start.cancel();
	}
	if (server.proc) {
		try {
			server.proc.kill("SIGKILL");
		} catch {
			/* already gone */
		}
	}
	const wasRunning = Boolean(server.proc);
	server.proc = null;
	server.port = 0;
	server.modelId = null;
	server.ready = false;
	server.starting = null;
	server.startingModelId = null;
	server.stderrTail = "";
	if (wasRunning || reason === "quit") {
		broadcastLlm(llmStatusEvent("idle", { detail: reason || null }));
	}
}

async function spawnAndAwait(modelId: unknown): Promise<number> {
	const id = resolveLlmModelId(modelId);
	const model = getLlmModel(id);
	if (!model) throw new Error(`Unknown LLM model: ${modelId}`);
	const bin = binaryPath();
	const modelPath = modelFilePath(id);
	if (!state.overrides.binaryPath && !binaryDownloaded()) {
		throw new Error("llama-server is not downloaded yet");
	}
	if (!state.overrides.modelPath && !modelDownloaded(id)) {
		throw new Error(`model ${id} is not downloaded yet`);
	}
	// The start's cancel channel. Registered BEFORE the port pick so a stop
	// that lands in any window is caught: the health poll can run for up to
	// HEALTH_TIMEOUT_MS, so without an explicit cancel the start promise
	// (and with it server.starting) would stay pending for minutes after the
	// child is gone.
	let resolveCancelled: () => void = () => {};
	const cancelPromise = new Promise<"cancelled">((resolve) => {
		resolveCancelled = () => resolve("cancelled");
	});
	const start: PendingStart = { cancelled: false, cancel: () => {} };
	start.cancel = () => {
		start.cancelled = true;
		resolveCancelled();
	};
	pendingStart = start;
	const port = await pickFreePort();
	// Every child is registered at SPAWN time, not when it is adopted: the
	// tracked registry is the only thing that can kill it during the health
	// window (the 2026-10-19 audit — the old code orphaned a llama-server
	// holding the model resident on a quit mid-cold-start).
	let childId: number | null = null;
	const launch = (withReasoningFlag: boolean): ChildProcess => {
		const child = spawn(
			bin,
			spawnArgs(modelPath, port, model.ctxTokens, withReasoningFlag),
			{
				stdio: ["ignore", "ignore", "pipe"],
			},
		);
		child.stderr.on("data", noteStderr);
		childId = trackChild(child, "llama-server");
		return child;
	};
	broadcastLlm(llmStatusEvent("loading", { modelId: id }));
	let proc: ChildProcess | null = launch(true);
	// The first child, captured before `proc` goes nullable for the retry
	// path below — the exit listener and the health race both target it.
	const firstProc = proc;
	// Race health against an actual EXIT (bad flag, bad binary, bad weights).
	// A slow-but-alive load (3B paging on a busy 8GB machine) must keep
	// polling — only a real exit fails fast here.
	const healthPromise = pollHealth(port, HEALTH_TIMEOUT_MS, start);
	const exitPromise = new Promise<{
		code: number | null;
		signalName: NodeJS.Signals | null;
	}>((resolve) => {
		firstProc.once("exit", (code, signalName) => resolve({ code, signalName }));
	});
	let outcome: "healthy" | "exited" | "cancelled";
	try {
		outcome = await Promise.race([
			healthPromise.then(() => "healthy" as const),
			exitPromise.then(() => "exited" as const),
			cancelPromise,
		]);
	} catch (err) {
		// Health deadline hit while the process was still up.
		try {
			proc.kill("SIGKILL");
		} catch {
			/* already gone */
		}
		if (start.cancelled) throw new StartCancelledError();
		throw err;
	}
	if (outcome === "cancelled") {
		// A stop landed during the health window (quit, or a model switch):
		// the child never becomes server.proc, and it must not outlive the
		// app — kill it through the tracked registry.
		killTrackedChild(childId);
		throw new StartCancelledError();
	}
	if (outcome !== "healthy") {
		// Early death: retry once without the reasoning flag when stderr says
		// the flag was rejected; otherwise surface the stderr tail.
		proc = null;
		const tail = server.stderrTail;
		const flagRejected =
			/invalid argument|unknown (argument|option)|unrecognized/i.test(tail) &&
			/reasoning/i.test(tail);
		if (flagRejected) {
			server.stderrTail = "";
			proc = launch(false);
			try {
				await pollHealth(port, HEALTH_TIMEOUT_MS, start);
			} catch (err) {
				if (start.cancelled) {
					killTrackedChild(childId);
					throw new StartCancelledError();
				}
				throw err;
			}
		} else {
			throw new Error(
				`llama-server failed to start: ${tail.trim().slice(-400) || "no output"}`,
			);
		}
	}
	// A stop that landed between "healthy" and this line must NOT resurrect
	// the child into server.proc — nothing would kill it afterwards.
	if (start.cancelled) {
		killTrackedChild(childId);
		throw new StartCancelledError();
	}
	server.proc = proc;
	server.port = port;
	server.modelId = id;
	server.ready = true;
	server.lastUsed = Date.now();
	proc.once("exit", () => {
		if (server.proc === proc) stopServer("exit");
	});
	armIdleStop();
	broadcastLlm(llmStatusEvent("ready", { modelId: id }));
	return port;
}

// Single-flight ensure: concurrent first asks share one startup.
export function ensureServer(modelId: unknown): Promise<number> {
	const id = resolveLlmModelId(modelId);
	if (server.proc && server.ready && server.modelId === id) {
		server.lastUsed = Date.now();
		armIdleStop();
		return Promise.resolve(server.port);
	}
	if (server.starting) {
		// Same model still starting: join it. A different model requested
		// mid-start waits for the in-flight spawn, then switches — joining
		// the wrong promise would hand a Qwen port to a Llama waiter.
		if (server.startingModelId === id) return server.starting;
		return server.starting.then(
			() => ensureServer(id),
			(err) => {
				// A cancelled start (quit, or a stop landing mid-start) must
				// NOT be retried: the caller wants the server DOWN, and a
				// retry would spawn a fresh child that outlives the app.
				if (err instanceof StartCancelledError) throw err;
				return ensureServer(id);
			},
		);
	}
	// Switching away from a resident server: kill it FIRST. Spawning without
	// this overwrites server.proc/port with the new child and leaks the old
	// one (orphaned llama-server, bound port, resident weights) — the exact
	// state a Settings model switch leaves behind.
	if (server.proc) stopServer("switch");
	server.startingModelId = id;
	// spawnAndAwait registers its cancel channel synchronously (before its
	// first await), so pendingStart is THIS call's start object here. The
	// identity check in the finally keeps a late-finishing start from
	// clearing a NEWER start's cancel channel.
	const starting = spawnAndAwait(id);
	const thisStart = pendingStart;
	server.starting = starting.finally(() => {
		server.starting = null;
		server.startingModelId = null;
		// The start is over (settled or cancelled) — a later stop must not
		// cancel it again.
		if (pendingStart === thisStart) pendingStart = null;
	});
	return server.starting;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

// Qwen3 emits a <think>…</think> preamble when the template's thinking mode
// stays on; the answer lives after the last closing tag.
export function stripThink(text: unknown): string {
	const src = String(text || "");
	if (!src.includes("</think>")) {
		return src.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
	}
	const idx = src.lastIndexOf("</think>");
	return src.slice(idx + "</think>".length).trim();
}

export interface ThinkStripper {
	push(chunk: unknown): string;
	flush(): string;
}

// Incremental <think> stripper for streamed output. The whole-text
// stripThink leaks a partial tag mid-stream ("<think>a" has no close yet,
// so it passes through, then vanishes when the close arrives — visible
// flicker). Instead: hold back from a possible tag start until the matching
// close is seen, then release. Two deliberate divergences from stripThink,
// both in the keep-output direction: pre-tag text is KEPT (stripThink drops
// everything before the last close) and a never-closed tail flushes as-is.
// With --reasoning-budget 0 this path is a near-no-op guard.
export function createThinkStripper(): ThinkStripper {
	let hold = "";
	let closed = false;
	// A tail that could still grow into <think…> or </think>.
	const PARTIAL_TAG = /^<(\/)?t(h(i(n(k(\s[^<>]*)?)?)?)?)?$/i;
	return {
		push(chunk: unknown): string {
			if (closed) return String(chunk || "");
			hold += String(chunk || "");
			const openMatch = hold.match(/<think(\s[^<>]*)?>/i);
			if (!openMatch) {
				// No open tag yet: release everything except a possibly
				// still-forming tag tail ("<", "</th", …).
				const lt = hold.lastIndexOf("<");
				let cut = hold.length;
				if (lt !== -1 && PARTIAL_TAG.test(hold.slice(lt))) cut = lt;
				const out = hold.slice(0, cut);
				hold = hold.slice(cut);
				return out;
			}
			const out = hold.slice(0, openMatch.index);
			const rest = hold.slice(openMatch.index);
			const closeMatch = rest.match(/<\/think\s*>/i);
			if (!closeMatch) {
				hold = rest;
				return out;
			}
			const after = rest.slice(
				(closeMatch.index as number) + (closeMatch[0] as string).length,
			);
			hold = "";
			closed = true;
			return out + after;
		},
		flush(): string {
			const out = hold;
			hold = "";
			return out;
		},
	};
}

interface ParsedSse {
	delta?: string;
	finishReason?: unknown;
	timings?: unknown;
	done?: boolean;
}

// One llama-server SSE line → { delta } | { done } | { finishReason } |
// { timings } | null (not a data line or malformed — skipped, never fatal).
// The final frame before [DONE] carries the server's own `timings`
// (prompt_n / predicted_n / predicted_ms) when the build reports them.
export function parseSseLine(line: unknown): ParsedSse | null {
	const s = String(line || "").trim();
	if (!s.startsWith("data:")) return null;
	const payload = s.slice(5).trim();
	if (payload === "[DONE]") return { done: true };
	try {
		const json = JSON.parse(payload);
		const choice = json && json.choices && json.choices[0];
		return {
			delta:
				choice && choice.delta && typeof choice.delta.content === "string"
					? choice.delta.content
					: undefined,
			finishReason: (choice && choice.finish_reason) || undefined,
			timings:
				json && json.timings && typeof json.timings === "object"
					? json.timings
					: undefined,
		};
	} catch {
		return null;
	}
}

export interface LlmTimings {
	promptTokens: number;
	predictedTokens: number;
	predictedMs: number | null;
}

// Server `timings` → { promptTokens, predictedTokens, predictedMs } with
// numbers only (a half-present object degrades to null — the caller shows
// client-side estimates instead, flagged approximate).
export function normalizeLlmTimings(t: unknown): LlmTimings | null {
	if (!t || typeof t !== "object") return null;
	const src = t as {
		prompt_n?: unknown;
		predicted_n?: unknown;
		predicted_ms?: unknown;
	};
	const promptTokens = Number(src.prompt_n);
	const predictedTokens = Number(src.predicted_n);
	const predictedMs = Number(src.predicted_ms);
	if (!Number.isFinite(promptTokens) || !Number.isFinite(predictedTokens)) {
		return null;
	}
	return {
		promptTokens,
		predictedTokens,
		predictedMs: Number.isFinite(predictedMs) ? predictedMs : null,
	};
}

interface ChatResult {
	content: string;
	stopReason: unknown;
	timings: LlmTimings | null;
}

// Consume a streaming chat-completions response, forwarding cleaned text
// through onToken as it arrives. Resolves with the full cleaned content.
async function readChatStream(
	res: Response,
	onToken: (text: string) => void,
): Promise<ChatResult> {
	const stripper = createThinkStripper();
	const parts: string[] = [];
	let finishReason: unknown = null;
	let timings: LlmTimings | null = null;
	let finished = false;
	const emit = (text: string): void => {
		if (text) {
			parts.push(text);
			onToken(text);
		}
	};
	const handleLine = (line: string): void => {
		const parsed = parseSseLine(line);
		if (!parsed) return;
		if (parsed.done) {
			finished = true;
			return;
		}
		if (typeof parsed.delta === "string" && parsed.delta) {
			emit(stripper.push(parsed.delta));
		}
		if (parsed.finishReason) finishReason = parsed.finishReason;
		const normalized = normalizeLlmTimings(parsed.timings);
		if (normalized) timings = normalized;
	};
	const reader = (res.body as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let buf = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (value) buf += decoder.decode(value, { stream: !done });
		if (buf.includes("\n") || done) {
			const lines = buf.split("\n");
			buf = done ? "" : (lines.pop() as string);
			for (const line of lines) handleLine(line);
			if (done && buf) handleLine(buf);
		}
		if (done || finished) break;
	}
	emit(stripper.flush());
	try {
		await reader.cancel().catch(() => {});
	} catch {
		/* already closed */
	}
	return { content: parts.join(""), stopReason: finishReason, timings };
}

interface ChatOnceOptions {
	messages?: unknown;
	modelId?: unknown;
	timeoutMs?: number;
	signal?: AbortSignal | null;
	stream?: boolean;
	onToken?: ((text: string) => void) | null;
}

function chatOnce({
	messages,
	modelId,
	timeoutMs,
	signal,
	stream,
	onToken,
}: ChatOnceOptions): Promise<ChatResult> {
	const doChat = async (): Promise<ChatResult> => {
		const port = await ensureServer(modelId);
		const ctrl = new AbortController();
		const timer = setTimeout(
			() => ctrl.abort(new Error("chat timed out")),
			timeoutMs || CHAT_TIMEOUT_MS,
		);
		const onOuterAbort = () => ctrl.abort(new Error("chat canceled"));
		if (signal) {
			if (signal.aborted) onOuterAbort();
			else signal.addEventListener("abort", onOuterAbort, { once: true });
		}
		const post = () =>
			fetchImpl()(`http://127.0.0.1:${port}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					messages,
					temperature: 0.2,
					max_tokens: 1024,
					stream: stream === true,
				}),
				signal: ctrl.signal,
			});
		const failStatus = async (res: Response): Promise<never> => {
			const detail = await res.text().catch(() => "");
			throw new Error(
				`llama-server ${res.status}${detail ? `: ${detail.slice(-200)}` : ""}`,
			);
		};
		try {
			if (stream === true && typeof onToken === "function") {
				const res = await post();
				if (!res.ok) await failStatus(res);
				return await readChatStream(res, onToken);
			}
			const res = await post();
			if (!res.ok) await failStatus(res);
			const data = await res.json();
			const content = data?.choices?.[0]?.message?.content ?? "";
			return {
				content: stripThink(content),
				stopReason: data?.choices?.[0]?.finish_reason ?? null,
				timings: normalizeLlmTimings(data && data.timings),
			};
		} finally {
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onOuterAbort);
			server.lastUsed = Date.now();
			if (server.ready) armIdleStop();
		}
	};
	// Serialize through the queue so concurrent asks run one at a time; a
	// failure must not poison later turns (the persistQueue pattern).
	const run = server.chatQueue.then(doChat, doChat);
	server.chatQueue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

export function llmChat(params: ChatOnceOptions): Promise<ChatResult> {
	return chatOnce(params);
}

// ---------------------------------------------------------------------------
// Init + snapshot
// ---------------------------------------------------------------------------

interface InitLlmServerOptions {
	userDataDir?: string;
	broadcast?: ((payload: unknown) => void) | null;
	binaryPath?: string | null;
	modelPath?: string | null;
	fetchImpl?: typeof fetch | null;
}

export function initLlmServer({
	userDataDir,
	broadcast,
	binaryPath: binaryOverride,
	modelPath: modelOverride,
	fetchImpl: fetchOverride,
}: InitLlmServerOptions = {}): void {
	state.init = true;
	state.userDataDir = userDataDir ?? null;
	state.broadcast = typeof broadcast === "function" ? broadcast : null;
	state.overrides.binaryPath = binaryOverride || null;
	state.overrides.modelPath = modelOverride || null;
	state.overrides.fetchImpl = fetchOverride || null;
}

export function llmServerSnapshot(): {
	binaryDownloaded: boolean;
	binaryTag: unknown;
	running: boolean;
	modelId: string | null;
} {
	return {
		binaryDownloaded: binaryDownloaded(),
		binaryTag: (() => {
			try {
				return (
					JSON.parse(fs.readFileSync(binaryMetaPath(), "utf-8")).tag || null
				);
			} catch {
				return null;
			}
		})(),
		running: server.ready,
		modelId: server.modelId,
	};
}

export { chatThreads as chatThreadCount };
