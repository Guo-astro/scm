// Phase 1 (llm/ask): pure move of main.js:7890-8252 (2026-10-10).
// No behavior change: same handlers, channels, gates, and retry. The one
// shared helper still owned by main.js (isVideo) arrives via
// main/context.js and is read AT CALL TIME (ctx.isVideo). Everything else
// is required directly — this module never requires main.js (no cycle).
import { BrowserWindow } from "electron";
import { handle, on } from "../ipc-wrapper.ts";
import ctx from "../context.ts";
import { getModel, DEFAULT_MODEL_ID } from "../../indexer/models.ts";
import { buildFilenamePhrase } from "../../indexer/memory-embedding-utils.ts";
import {
	loadLibrary,
	loadSampleQueries,
	loadSegments,
	loadTranscripts,
} from "../../main-lib/library-store.ts";
import {
	readLlmConfig,
	writeLlmConfig,
	llmModelInfos,
} from "../../main-lib/llm/config.ts";
import {
	binaryDownloaded as llmBinaryDownloaded,
	modelDownloaded as llmModelDownloaded,
	downloadBinary as llmDownloadServerBinary,
	downloadModel as llmDownloadModelWeights,
} from "../../main-lib/llm/binaries.ts";
import {
	llmServerSnapshot,
	llmChat,
	chatThreadCount as llmChatThreadCount,
} from "../../main-lib/llm/server.ts";
import {
	validateScopedFilenames,
	partitionScoped,
	buildAskEvidence,
} from "../../main-lib/ask/retrieve.ts";
import { buildAskMessages } from "../../main-lib/ask/prompts.ts";

// ---------------------------------------------------------------------------
// AI Insights: what the AI sees in a photo
// ---------------------------------------------------------------------------

handle("memories:get-ai-insights", (_event: unknown, filename: unknown) => {
	if (typeof filename !== "string") return null;
	const l = loadLibrary();
	const idx = l.filenames.indexOf(filename);
	if (idx === -1) return null;

	// 1. Filename-derived keywords.
	const phrase = buildFilenamePhrase(filename);
	const keywords = phrase ? phrase.split(/\s+/).filter(Boolean) : [];

	// 2. OCR text (if any).
	const ocrText = (l.ocr && l.ocr[idx]) || null;

	// 3. Which model processed this image.
	const modelId = l.modelId;
	const config = getModel(modelId) || getModel(DEFAULT_MODEL_ID);

	// 4. Visual concept tags: reverse-lookup which sample queries this
	//    image appears in (from the precomputed memory-queries.json).
	const queries = loadSampleQueries();
	const concepts: Array<{ query: unknown; score: number }> = [];
	if (Array.isArray(queries.queries)) {
		for (const entry of queries.queries) {
			if (!entry || !entry.q || !Array.isArray(entry.top)) continue;
			const match = entry.top.find((t: any) => t && t.filename === filename);
			if (match && typeof match.score === "number") {
				concepts.push({ query: entry.q, score: match.score });
			}
		}
	}
	// Sort by score descending, take top 8.
	concepts.sort((a, b) => b.score - a.score);

	return {
		filename,
		keywords,
		ocrText,
		modelId,
		modelName: config?.label || modelId,
		concepts: concepts.slice(0, 8),
	};
});

// ---------------------------------------------------------------------------
// LLMs mode (MDs/Ask-Mode-Plan.md): embedded llama.cpp sidecar answering
// from OCR text + dialogue transcripts + filename evidence. The retrieval
// path is worker-free (no CLIP embed, no pending flags) and read-only.
// ---------------------------------------------------------------------------

function broadcastLlmStatus(payload: unknown) {
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send("memories:status", payload);
	}
}

// One download at a time — a second Settings click while the binary or a
// model streams joins the in-flight request instead of racing the same
// destination file.
// Per-target single-flight: clicking Download for a model while the engine
// still streams must START the model download (or at worst queue it), never
// silently join the engine's promise — on a slow link that join read as a
// dead button. Different targets download in parallel; the same target
// joins its own in-flight request.
const llmDownloadInflight = new Map<
	string,
	Promise<{ ok: boolean; error?: string }>
>();
function llmDownload(target: string) {
	const existing = llmDownloadInflight.get(target);
	if (existing) return existing;
	const run = (async () => {
		try {
			if (target === "binary") {
				if (!llmBinaryDownloaded()) await llmDownloadServerBinary();
			} else {
				await llmDownloadModelWeights(target);
			}
			return { ok: true };
		} catch (err) {
			const e = err as { message?: string } | null;
			broadcastLlmStatus({
				type: "llm",
				phase: "error",
				target,
				detail: String((e && e.message) || err),
			});
			return { ok: false, error: String((e && e.message) || err) };
		} finally {
			llmDownloadInflight.delete(target);
		}
	})();
	llmDownloadInflight.set(
		target,
		run.finally(() => llmDownloadInflight.delete(target)),
	);
	return run;
}

handle("memories:llm-status", () => {
	const cfg = readLlmConfig();
	return {
		enabled: cfg.enabled,
		chatModel: cfg.chatModel,
		models: llmModelInfos(llmModelDownloaded),
		server: llmServerSnapshot(),
	};
});

handle("memories:llm-set-config", (_event: unknown, patch: unknown) => {
	const p = patch as { enabled?: unknown; chatModel?: unknown } | null;
	if (!p || typeof p !== "object") {
		return { ok: false, error: "Expected an object" };
	}
	const allowed: { enabled?: boolean; chatModel?: string } = {};
	if (typeof p.enabled === "boolean") allowed.enabled = p.enabled;
	if (typeof p.chatModel === "string") allowed.chatModel = p.chatModel;
	try {
		const config = writeLlmConfig(allowed);
		// Config changes must reach every open surface immediately: the
		// grid's Ask toggle reads the flag through useAsk, which would
		// otherwise keep the toggle hidden until the next "llm" event or an
		// app restart (the "enabled it and nothing appeared" bug).
		broadcastLlmStatus({
			type: "llm",
			phase: "idle",
			detail: "config-changed",
		});
		return { ok: true, config };
	} catch (err) {
		const e = err as { message?: string } | null;
		return { ok: false, error: String((e && e.message) || err) };
	}
});

handle("memories:llm-download", (_event: unknown, target: unknown) => {
	if (target !== "binary" && typeof target !== "string") {
		return Promise.resolve({ ok: false, error: "Unknown download target" });
	}
	return llmDownload(target);
});

// The LLMs answer: evidence → prompt → sidecar. Never throws across IPC
// (the get-ai-insights shape): every outcome is {ok, reason?|error?, answer?,
// evidence[]}. Empty evidence short-circuits BEFORE the LLM — the model is
// never asked a question the library has no textual evidence for.
// In-flight Ask generations, keyed by the renderer's reqId: Stop wires
// through here — memories:ask-stop aborts the sidecar fetch mid-stream and
// the handler resolves with the partial text instead of vanishing it.
const askAborts = new Map<number, AbortController>();
const askStopFlags = new Set<number>();

on("memories:ask-stop", (_event: unknown, rawPayload: unknown) => {
	const payload = rawPayload as { reqId?: number } | null;
	const reqId = payload ? payload.reqId : undefined;
	const ctrl = reqId != null ? askAborts.get(reqId) : undefined;
	if (ctrl && reqId != null) {
		askStopFlags.add(reqId);
		try {
			ctrl.abort();
		} catch {
			/* already settled */
		}
	}
});

handle(
	"memories:ask",
	async (event: Electron.IpcMainInvokeEvent, rawPayload: unknown) => {
		try {
			const cfg = readLlmConfig();
			if (!cfg.enabled) return { ok: false, reason: "disabled", evidence: [] };
			// `payload` keeps the pre-conversion name: the source-scanning
			// tests grep the validated call shape
			// (`validateScopedFilenames(payload.…`).
			const payload = rawPayload as {
				query?: unknown;
				filenames?: unknown;
				reqId?: unknown;
			} | null;
			const query =
				payload && typeof payload.query === "string"
					? payload.query.trim()
					: "";
			if (!query)
				return { ok: true, answer: null, reason: "empty", evidence: [] };
			const l = loadLibrary();
			const scoped =
				payload && Array.isArray(payload.filenames)
					? validateScopedFilenames(payload.filenames, l.filenames)
					: new Set(l.filenames);
			if (scoped.size === 0) {
				return { ok: true, answer: null, reason: "no-evidence", evidence: [] };
			}
			const askT0 = Date.now();
			const { photoRows, videoNames } = partitionScoped(scoped, ctx.isVideo);
			for (const row of photoRows) {
				const idx = l.filenames.indexOf(row.filename);
				row.ocr = idx >= 0 && Array.isArray(l.ocr) ? l.ocr[idx] || "" : "";
			}
			const transcripts = loadTranscripts(l.modelId);
			const segments = loadSegments(l.modelId);
			const evidence = buildAskEvidence({
				query,
				photoRows,
				videoNames,
				transcripts,
				segVideos: segments && segments.loaded ? segments.videos : new Map(),
			});
			if (evidence.all.length === 0) {
				return { ok: true, answer: null, reason: "no-evidence", evidence: [] };
			}
			// Process stats for the card's readout: retrieval cost is measured,
			// generation numbers arrive with the sidecar reply (or stay absent —
			// the card estimates live and prints exacts on completion).
			const retrievalMs = Date.now() - askT0;
			const evidenceStats = {
				filesScanned: scoped.size,
				dialogueHits: evidence.dialogue.length,
				ocrHits: evidence.ocr.length,
				keywordHits: evidence.keyword.length,
				tier: evidence.tier,
				retrievalMs,
			};
			if (!llmBinaryDownloaded() || !llmModelDownloaded(cfg.chatModel)) {
				return {
					ok: false,
					reason: "not-installed",
					missing: !llmBinaryDownloaded() ? "binary" : "model",
					evidence: evidence.all,
				};
			}
			const messages = buildAskMessages({ query, evidenceRows: evidence.all });
			// Streaming generation: the renderer passes a reqId, gets the
			// evidence first (chips + grid populate mid-answer), then token
			// deltas, then this invoke resolves with the full text. A caller
			// without reqId (tests, scripts) gets the same final answer with
			// nowhere for the events to go.
			const reqId =
				payload && Number.isFinite(payload.reqId)
					? (payload.reqId as number)
					: 0;
			const sender = event.sender;
			const sendAsk = (channel: string, body: unknown) => {
				try {
					sender.send(channel, body);
				} catch {
					/* window gone mid-answer */
				}
			};
			if (reqId)
				sendAsk("memories:ask-evidence", {
					reqId,
					evidence: evidence.all,
					stats: evidenceStats,
				});
			// Cold start shows its own phase: a resident sidecar answers in
			// seconds, a fresh spawn takes seconds to mmap + warm up.
			const snap = llmServerSnapshot();
			const warm =
				snap.running === true &&
				!!snap.modelId &&
				snap.modelId === cfg.chatModel;
			const modelInfo =
				llmModelInfos(llmModelDownloaded).find((m) => m.id === cfg.chatModel) ||
				null;
			if (!warm && reqId) {
				sendAsk("memories:ask-phase", {
					reqId,
					phase: "spawning",
					modelLabel: modelInfo ? modelInfo.label : cfg.chatModel,
					sizeBytes: modelInfo ? modelInfo.sizeBytes : null,
				});
			}
			const finishStats = (
				elapsedMs: number,
				timings: {
					promptTokens?: number | null;
					predictedTokens?: number | null;
					predictedMs?: number | null;
				} | null,
			) => {
				const out: Record<string, unknown> = {
					...evidenceStats,
					coldStart: !warm,
					elapsedMs,
					modelLabel: modelInfo ? modelInfo.label : cfg.chatModel,
					ctxTokens: modelInfo ? modelInfo.ctxTokens : null,
					sizeBytes: modelInfo ? modelInfo.sizeBytes : null,
					threads: llmChatThreadCount(),
					accelerator: process.platform === "darwin" ? "Metal" : null,
				};
				if (timings) {
					out.promptTokens = timings.promptTokens;
					out.predictedTokens = timings.predictedTokens;
					if (
						timings.predictedMs &&
						timings.predictedTokens &&
						timings.predictedTokens > 0 &&
						timings.predictedMs > 0
					) {
						out.tokensPerSec =
							Math.round(
								(timings.predictedTokens / (timings.predictedMs / 1000)) * 10,
							) / 10;
					}
				}
				return out;
			};
			const ctrl = new AbortController();
			if (reqId) askAborts.set(reqId, ctrl);
			const parts: string[] = [];
			const onToken = (delta: string) => {
				parts.push(delta);
				if (reqId) sendAsk("memories:ask-token", { reqId, delta });
			};
			const genT0 = Date.now();
			try {
				const reply = await llmChat({
					messages,
					modelId: cfg.chatModel,
					stream: true,
					signal: ctrl.signal,
					onToken,
				});
				return {
					ok: true,
					answer: parts.join(""),
					evidence: evidence.all,
					stats: finishStats(Date.now() - genT0, reply.timings || null),
				};
			} catch {
				if (reqId) {
					askAborts.delete(reqId);
					if (askStopFlags.delete(reqId)) {
						// User Stop: keep the partial text visible, marked stopped.
						return {
							ok: false,
							reason: "stopped",
							evidence: evidence.all,
							partial: parts.join("") || null,
							stats: finishStats(Date.now() - genT0, null),
						};
					}
				}
				// Stream failure (not a Stop): one legacy non-streaming retry
				// with the same evidence — a slow answer beats an error card.
				// Fresh controller: the stream's one may already be settled.
				const retryCtrl = new AbortController();
				if (reqId) askAborts.set(reqId, retryCtrl);
				try {
					const genT1 = Date.now();
					const reply = await llmChat({
						messages,
						modelId: cfg.chatModel,
						stream: false,
						signal: retryCtrl.signal,
					});
					return {
						ok: true,
						answer: reply.content,
						evidence: evidence.all,
						stats: finishStats(Date.now() - genT1, reply.timings || null),
					};
				} catch (err2) {
					if (reqId && askStopFlags.delete(reqId)) {
						return {
							ok: false,
							reason: "stopped",
							evidence: evidence.all,
							partial: parts.join("") || null,
							stats: finishStats(Date.now() - genT0, null),
						};
					}
					const e = err2 as { message?: string } | null;
					return {
						ok: false,
						reason: "error",
						error: String((e && e.message) || err2),
						evidence: [],
					};
				}
			} finally {
				if (reqId) askAborts.delete(reqId);
			}
		} catch (err) {
			const e = err as { message?: string } | null;
			return {
				ok: false,
				reason: "error",
				error: String((e && e.message) || err),
				evidence: [],
			};
		}
	},
);
