// The ffmpeg process layer for the indexer/transcribe workers and main:
// tracked spawning (orphan-proof, 2026-09-28), the binary resolver,
// stderr-scraping probes, and raw frame extraction. Split out of
// video-utils.ts (2026-10-25); scene detection lives in scene-detect.ts,
// the quality/budget math in video-budget.ts (both import this module).

// Uses a bundled ffmpeg binary (ffmpeg-static in dev; resources/ffmpeg in
// the packaged app, passed as FFMPEG_PATH). Exposes:
//   VIDEO_EXTENSIONS — accepted import extensions
//   resolveFfmpeg()  — the binary path (throws a clear error if missing)
//   probeDuration()  — seconds as a float, from `ffmpeg -i` stderr
//   extractFrames()  — N evenly spaced raw RGB frames (in-memory buffers)
//   extractFrameRaw()— one raw RGB24 frame as {data,width,height,channels}
//   extractFrameAt() — one JPEG at destPath (poster / legacy path)
//   extractPoster()  — one JPEG at destPath (width >= 224 for the grid)

import {
	spawn,
	type ChildProcess,
	type SpawnOptions,
} from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Orphan-proof ffmpeg tracking (2026-09-28 ffmpeg-CPU fix).
//
// Every ffmpeg child spawned through this module is registered here so a
// worker restart / pool stop / app quit can SIGKILL grandchildren instead of
// orphaning them to PID 1 (the old `worker.process.kill()` only killed the
// Node worker; its ffmpeg children survived with no timers left to stop
// them — the 500%+ CPU after "done" and after app close).
//
// The worker also reports spawn/exit to main via setFfmpegReporter() so main
// can kill by PID even AFTER the worker is dead (main-side PID map survives
// the worker). See indexer.js / transcribe-worker.js wiring + main.js
// killTrackedFfmpegPids().
// ---------------------------------------------------------------------------
const activeFfmpegChildren = new Set<ChildProcess>();
let ffmpegReporter: ((event: Record<string, unknown>) => void) | null = null;

export function setFfmpegReporter(fn: unknown) {
	ffmpegReporter =
		typeof fn === "function"
			? (fn as (event: Record<string, unknown>) => void)
			: null;
}

function reportFfmpeg(event: Record<string, unknown>) {
	if (!ffmpegReporter) return;
	try {
		ffmpegReporter(event);
	} catch {
		/* reporting must never fail the spawn */
	}
}

function trackFfmpegChild(child: ChildProcess, label: unknown) {
	if (typeof child.pid !== "number") return child;
	activeFfmpegChildren.add(child);
	try {
		reportFfmpeg({
			type: "ffmpeg-spawn",
			pid: child.pid,
			label: String(label || "ffmpeg"),
		});
	} catch {
		/* best-effort */
	}
	const untrack = () => {
		if (activeFfmpegChildren.has(child)) activeFfmpegChildren.delete(child);
		try {
			reportFfmpeg({ type: "ffmpeg-exit", pid: child.pid });
		} catch {
			/* best-effort */
		}
	};
	child.on("close", untrack);
	child.on("error", untrack);
	// Safety: if the event loop drains without close/error (killed externally),
	// the set entry is dropped on the next spawn/kill sweep — see killAllFfmpeg.
	return child;
}

export function spawnFfmpeg(
	ffmpeg: string,
	args: string[],
	opts: SpawnOptions = { stdio: ["ignore", "pipe", "pipe"] },
): ChildProcess {
	const child = spawn(ffmpeg, args, opts);
	return trackFfmpegChild(
		child,
		`ffmpeg ${Array.isArray(args) ? args.slice(0, 4).join(" ") : ""}`.slice(
			0,
			120,
		),
	);
}

// SIGKILL every tracked ffmpeg child. Called from worker shutdown /
// kill-ffmpeg IPC / process exit handlers. Returns the number of PIDs
// signaled. Never throws; already-exited children are skipped.
export function killAllFfmpeg(reason: string) {
	let killed = 0;
	for (const child of [...activeFfmpegChildren]) {
		const pid = child.pid;
		try {
			// Skip children that already exited (exitCode/signal set, no pid).
			if (child.exitCode !== null || child.signalCode !== null) {
				activeFfmpegChildren.delete(child);
				continue;
			}
			try {
				child.kill("SIGKILL");
				killed++;
			} catch {
				/* already gone — fall through to PID kill */
			}
			// Belt-and-braces: if the handle is stale but the OS process
			// lives on, signal by PID directly.
			if (typeof pid === "number") {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					/* ESRCH = already gone, EPERM = not ours — both fine */
				}
			}
		} finally {
			activeFfmpegChildren.delete(child);
		}
	}
	if (killed > 0 || reason) {
		try {
			console.warn(
				`[video] killAllFfmpeg(${reason || "unknown"}): signaled ${killed} child(ren)`,
			);
		} catch {
			/* logging must never throw */
		}
	}
	return killed;
}

export function getActiveFfmpegCount() {
	return activeFfmpegChildren.size;
}

// Last-resort self-cleanup: if THIS worker process is going down, do not
// leave ffmpeg behind. 'exit' handlers must be synchronous — kill() is.
try {
	if (typeof process.on === "function") {
		process.on("exit", () => {
			for (const child of [...activeFfmpegChildren]) {
				try {
					child.kill("SIGKILL");
				} catch {
					/* best-effort */
				}
			}
		});
	}
} catch {
	/* handler install is best-effort */
}

// Everything ffmpeg can decode becomes searchable + posterable. Playability
// in the renderer is a separate, narrower set (src/lib/media.ts).
export const VIDEO_EXTENSIONS = new Set([
	".mp4",
	".mov",
	".m4v",
	".webm",
	".mkv",
	".avi",
	".ts",
	".m2ts",
	".mts",
	".mpg",
	".mpeg",
	".wmv",
	".flv",
	".3gp",
	".MP4",
	".MOV",
	".M4V",
	".WEBM",
	".MKV",
	".AVI",
	".TS",
	".M2TS",
	".MTS",
	".MPG",
	".MPEG",
	".WMV",
	".FLV",
	".3GP",
]);

// Clip boundaries past the true duration would make ffmpeg fail or emit a
// black frame; safety margin used when timestamping extractions.
export const EDGE_MARGIN = 0.5; // seconds off each end
const MAX_DURATION = 24 * 60 * 60; // sanity cap for pathological files
const FRAME_FRACTIONS = [0.2, 0.5, 0.8];

/** @returns the ffmpeg binary path (throws when none is usable) */
export function resolveFfmpeg(): string {
	if (process.env.FFMPEG_PATH) {
		const p = process.env.FFMPEG_PATH;
		if (fs.existsSync(p)) return p;
		throw new Error(`FFMPEG_PATH set but missing: ${p}`);
	}
	// Packaged app: the binary is copied to Contents/Resources/ffmpeg
	// (package.json "build.extraResources").
	if (process.resourcesPath) {
		const p = path.join(process.resourcesPath, "ffmpeg");
		if (fs.existsSync(p)) return p;
	}
	try {
		// Deliberately-lazy require (unchanged): optional dev dependency.
		// ffmpeg-static's d.ts models the path as an ESM default export, but
		// the package ships CJS: require() returns the path string itself.
		// eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberately-lazy (optional dev dependency — absent in packaged runs)
		const p = require("ffmpeg-static") as string | null;
		if (p && fs.existsSync(p)) return p;
	} catch {
		/* fall through to the error below */
	}
	throw new Error(
		"No ffmpeg binary available (set FFMPEG_PATH or install ffmpeg-static)",
	);
}

export function runFfmpeg(ffmpeg: string, args: string[], timeoutMs = 120000) {
	return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
		const child = spawnFfmpeg(ffmpeg, args, {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d) => (stdout += d));
		child.stderr?.on("data", (d) => (stderr += d));
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(
				new Error(
					`ffmpeg timed out after ${timeoutMs}ms: ${stderr.slice(-500)}`,
				),
			);
		}, timeoutMs);
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve({ stdout, stderr });
			else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
		});
	});
}

// Binary-safe twin of runFfmpeg: stdout is collected as Buffer chunks (utf8
// concat would corrupt rawvideo), stderr stays a string for diagnostics.
export function runFfmpegBuffer(
	ffmpeg: string,
	args: string[],
	timeoutMs = 120000,
) {
	return new Promise<{ stdout: Buffer; stderr: string }>((resolve, reject) => {
		const child = spawnFfmpeg(ffmpeg, args, {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks: Buffer[] = [];
		let stderr = "";
		child.stdout?.on("data", (d) => chunks.push(d));
		child.stderr?.on("data", (d) => (stderr += d));
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(
				new Error(
					`ffmpeg timed out after ${timeoutMs}ms: ${stderr.slice(-500)}`,
				),
			);
		}, timeoutMs);
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve({ stdout: Buffer.concat(chunks), stderr });
			else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
		});
	});
}

// Output-stream WxH from a rawvideo encode's stderr (the INPUT line may
// report a different size once -vf scale has run). Falls back to 224x224
// for the fixed scale=224:224 path when the Output section is missing.
//
// SAR/DAR tolerance (2026-09-26 poison-pill fix): ffmpeg prints
// `480x270 [SAR 1:1 DAR 16:9]` when SAR is known but bare `480x270, q=2-31`
// for scaled bt709 outputs with unknown SAR — the old regex required the
// `[` and returned null for those, so EVERY segment of such files skipped
// and the file re-queued on every launch forever ("Embedding scenes" loop).
export function parseRawFrameSize(
	stderr: string,
	width: number | null,
): { width: number; height: number } | null {
	const outIdx = stderr.lastIndexOf("Output #");
	const section = outIdx >= 0 ? stderr.slice(outIdx) : stderr;
	const m = section.match(
		/Video:\s*rawvideo[\s\S]*?,\s*(\d{1,5})x(\d{1,5})(?:\s*\[|,|\s|$)/,
	);
	// Cast: the capture groups always participate in this pattern.
	if (m) return { width: +(m[1] as string), height: +(m[2] as string) };
	if (width != null && width <= 224) return { width: 224, height: 224 };
	return null;
}

// Duration in seconds, parsed from `ffmpeg -i` metadata output. Returns null
// when the file has no decodable duration (unusual but not fatal). Note:
// `ffmpeg -i` with no output always exits 1 — that is the normal probe
// shape, so the exit code is deliberately ignored here.
export async function probeDuration(
	ffmpeg: string,
	filePath: string,
): Promise<number | null> {
	const { stderr } = await new Promise<{ stdout: string; stderr: string }>(
		(resolve, reject) => {
			const child = spawnFfmpeg(ffmpeg, ["-i", filePath], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let out = "";
			let err = "";
			child.stdout?.on("data", (d) => (out += d));
			child.stderr?.on("data", (d) => (err += d));
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				reject(new Error("ffmpeg probe timed out"));
			}, 30000);
			child.on("error", reject);
			child.on("close", () => {
				clearTimeout(timer);
				resolve({ stdout: out, stderr: err });
			});
		},
	);
	const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
	if (!m) return null;
	// Casts: the capture groups always participate in this pattern.
	const hours = parseInt(m[1] as string, 10);
	const minutes = parseInt(m[2] as string, 10);
	const seconds = parseFloat(m[3] as string);
	const total = hours * 3600 + minutes * 60 + seconds;
	if (!Number.isFinite(total) || total <= 0) return null;
	return Math.min(total, MAX_DURATION);
}

// Whether the file carries at least one audio stream, parsed from the same
// `ffmpeg -i` metadata output probeDuration reads. A silent/muted video has
// no `Audio:` stream line — its empty transcript is legitimate and must
// never be retried. A stub-era empty (recorded before the whisper engine
// existed) WITH an audio stream is poison and must be re-queued (see
// repairUntranscribedWithAudio in main.ts). Resolves false (not throws) on
// probe failure — an undecodable file is not evidence of speech.
export async function probeHasAudio(
	ffmpeg: string,
	filePath: string,
): Promise<boolean> {
	let stderr: string;
	try {
		const { stderr: err } = await new Promise<{
			stdout: string;
			stderr: string;
		}>((resolve, reject) => {
			const child = spawnFfmpeg(ffmpeg, ["-i", filePath], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let out = "";
			let errText = "";
			child.stdout?.on("data", (d) => (out += d));
			child.stderr?.on("data", (d) => (errText += d));
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				reject(new Error("ffmpeg audio probe timed out"));
			}, 30000);
			child.on("error", reject);
			child.on("close", () => {
				clearTimeout(timer);
				resolve({ stdout: out, stderr: errText });
			});
		});
		stderr = err;
	} catch {
		return false;
	}
	return /^\s*Stream #\d+:\d+.*Audio:/m.test(stderr);
}

// Timestamps at fractions of the duration, clamped inside [0, duration - 0.5].
function sampleTimestamps(duration: number, fractions: number[]) {
	const end = duration - EDGE_MARGIN;
	if (end <= 0) return [0];
	return fractions.map((f) => Math.max(0, Math.min(end, duration * f)));
}

// Extract one JPEG frame at `atSeconds`. Returns the output file path.
// Fast-seek (`-ss` before `-i`) is instant but has a known ffmpeg bug on some
// containers (MPEG-TS): it can encode ZERO frames while still exiting 0.
// So the result is verified on disk, and a slow decode-from-start seek
// (`-ss` after `-i`) is retried before the frame is declared failed.
//
// Never-stall contract (long-film fix): the slow path decodes from 0→t, so
// its cost is O(t) — a single segment deep in a 2–3 h film can take minutes.
// Callers (enrichVideo) catch per-segment failures and SKIP the segment, so
// this throws rather than hanging: fast and slow attempts each have their
// own timeout (overridable via `opts`), and the slow fallback is logged with
// its timestamp so a frozen tray can be attributed to ffmpeg vs CLIP.
export async function extractFrameAt(
	ffmpeg: string,
	filePath: string,
	atSeconds: number,
	destPath: string,
	width: number,
	opts: { fastTimeoutMs?: unknown; slowTimeoutMs?: unknown } = {},
): Promise<string> {
	const fastTimeoutMs =
		Number(opts?.fastTimeoutMs) > 0 ? Number(opts.fastTimeoutMs) : 90000;
	const slowTimeoutMs =
		Number(opts?.slowTimeoutMs) > 0 ? Number(opts.slowTimeoutMs) : 150000;
	const frameArgs = (seekBefore: boolean) => {
		const args = ["-y"];
		if (seekBefore) args.push("-ss", atSeconds.toFixed(3), "-i", filePath);
		else args.push("-i", filePath, "-ss", atSeconds.toFixed(3));
		args.push("-frames:v", "1", "-q:v", "3");
		args.push(
			"-vf",
			width > 224 ? `scale='min(${width},iw)':-2` : "scale=224:224",
		);
		args.push(destPath);
		return args;
	};
	const startedFast = Date.now();
	try {
		await runFfmpeg(ffmpeg, frameArgs(true), fastTimeoutMs);
		if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
			return destPath;
		}
	} catch (err) {
		/* fall through to the slow seek — logged below with timing */
		if (process.env.SCM_DEBUG_FFMPEG) {
			console.warn(
				`[video] fast seek failed at ${atSeconds.toFixed(1)}s ` +
					`(${Date.now() - startedFast}ms): ${(err as { message?: string }).message}`,
			);
		}
	}
	// Fast path produced nothing usable (zero-byte file or thrown error):
	// the slow decode-from-start is O(t), so name the timestamp — a tray
	// frozen here is ffmpeg decoding, not CLIP.
	const startedSlow = Date.now();
	try {
		await runFfmpeg(ffmpeg, frameArgs(false), slowTimeoutMs);
	} catch (err) {
		// cause set post-construction: the root tsconfig lib predates
		// ErrorOptions (runtime behavior identical).
		const failure = new Error(
			`ffmpeg slow-seek failed at ${atSeconds.toFixed(1)}s ` +
				`after ${Date.now() - startedSlow}ms: ${(err as { message?: string }).message}`,
		) as Error & { cause?: unknown };
		failure.cause = err;
		throw failure;
	}
	if (!fs.existsSync(destPath) || fs.statSync(destPath).size === 0) {
		throw new Error(
			`ffmpeg produced no frame at ${atSeconds.toFixed(1)}s ` +
				`for ${path.basename(filePath)} (fast ${Date.now() - startedFast}ms total)`,
		);
	}
	if (atSeconds > 60 && process.env.SCM_DEBUG_FFMPEG) {
		console.warn(
			`[video] slow-seek fallback used at ${atSeconds.toFixed(1)}s ` +
				`(${Date.now() - startedSlow}ms)`,
		);
	}
	return destPath;
}

export interface RawFrame {
	data: Buffer;
	width: number;
	height: number;
	channels: number;
}

// Pipe one frame as rawvideo rgb24 (no JPEG encode, no temp file — plan 0.5).
// Same fast/slow-seek contract and timeouts as extractFrameAt; returns
// { data: Buffer, width, height, channels: 3 }. Scale filter matches
// extractFrameAt so the CLIP decode path sees the same pixels.
export async function extractFrameRaw(
	ffmpeg: string,
	filePath: string,
	atSeconds: number,
	width: number,
	opts: { fastTimeoutMs?: unknown; slowTimeoutMs?: unknown } = {},
): Promise<RawFrame> {
	const fastTimeoutMs =
		Number(opts?.fastTimeoutMs) > 0 ? Number(opts.fastTimeoutMs) : 90000;
	const slowTimeoutMs =
		Number(opts?.slowTimeoutMs) > 0 ? Number(opts.slowTimeoutMs) : 150000;
	const scale = width > 224 ? `scale='min(${width},iw)':-2` : "scale=224:224";
	const frameArgs = (seekBefore: boolean) => {
		const args = ["-y"];
		if (seekBefore) args.push("-ss", atSeconds.toFixed(3), "-i", filePath);
		else args.push("-i", filePath, "-ss", atSeconds.toFixed(3));
		args.push("-frames:v", "1", "-vf", scale);
		args.push("-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1");
		return args;
	};
	const coerce = (stdout: Buffer, stderr: string): RawFrame | null => {
		if (!stdout || stdout.length === 0) return null;
		const dims = parseRawFrameSize(stderr, width);
		if (!dims) return null;
		const expected = dims.width * dims.height * 3;
		if (stdout.length !== expected) return null;
		return {
			data: stdout,
			width: dims.width,
			height: dims.height,
			channels: 3,
		};
	};
	const startedFast = Date.now();
	try {
		const { stdout, stderr } = await runFfmpegBuffer(
			ffmpeg,
			frameArgs(true),
			fastTimeoutMs,
		);
		const frame = coerce(stdout, stderr);
		if (frame) return frame;
	} catch (err) {
		if (process.env.SCM_DEBUG_FFMPEG) {
			console.warn(
				`[video] fast raw-seek failed at ${atSeconds.toFixed(1)}s ` +
					`(${Date.now() - startedFast}ms): ${(err as { message?: string }).message}`,
			);
		}
	}
	const startedSlow = Date.now();
	let frame: RawFrame | null;
	try {
		const { stdout, stderr } = await runFfmpegBuffer(
			ffmpeg,
			frameArgs(false),
			slowTimeoutMs,
		);
		frame = coerce(stdout, stderr);
	} catch (err) {
		// cause set post-construction: the root tsconfig lib predates
		// ErrorOptions (runtime behavior identical).
		const failure = new Error(
			`ffmpeg slow-seek failed at ${atSeconds.toFixed(1)}s ` +
				`after ${Date.now() - startedSlow}ms: ${(err as { message?: string }).message}`,
		) as Error & { cause?: unknown };
		failure.cause = err;
		throw failure;
	}
	if (!frame) {
		throw new Error(
			`ffmpeg produced no frame at ${atSeconds.toFixed(1)}s ` +
				`for ${path.basename(filePath)} (fast ${Date.now() - startedFast}ms total)`,
		);
	}
	if (atSeconds > 60 && process.env.SCM_DEBUG_FFMPEG) {
		console.warn(
			`[video] slow-seek fallback used at ${atSeconds.toFixed(1)}s ` +
				`(${Date.now() - startedSlow}ms)`,
		);
	}
	return frame;
}

// Extract N evenly spaced frames as in-memory raw RGB buffers (no temp dir).
// Degrades gracefully: a probe failure extracts from t=0 only; an extraction
// failure is reported per-frame and the survivors are returned.
export async function extractFrames(ffmpeg: string, filePath: string) {
	let duration: number | null = null;
	try {
		duration = await probeDuration(ffmpeg, filePath);
	} catch {
		/* probe failure: fall back to t=0 below */
	}
	const timestamps = sampleTimestamps(duration ?? 0, FRAME_FRACTIONS);
	// Independent ffmpeg spawns — run them concurrently. Each keeps its own
	// fast/slow-seek fallback; a failure still fails the whole extraction.
	const out: Array<RawFrame | undefined> = new Array(timestamps.length);
	await Promise.all(
		timestamps.map((atSeconds, i) =>
			extractFrameRaw(ffmpeg, filePath, atSeconds, 224).then((frame) => {
				out[i] = frame;
			}),
		),
	);
	return out;
}

// One representative JPEG for the grid card: a frame inside the clip (not
// t=0 — that is often a fade-in or title card), decoded to `width` px.
// Returns the poster file path; throws if extraction fails.
export async function extractPoster(
	ffmpeg: string,
	filePath: string,
	destPath: string,
	width = 480,
): Promise<string> {
	let duration: number | null = null;
	try {
		duration = await probeDuration(ffmpeg, filePath);
	} catch {
		/* probe failure: fall back to t=0 below */
	}
	let at = 0;
	if (duration !== null && duration > 0.5) {
		at = Math.max(0, Math.min(duration - EDGE_MARGIN, duration * 0.3));
	}
	return extractFrameAt(ffmpeg, filePath, at, destPath, width);
}
