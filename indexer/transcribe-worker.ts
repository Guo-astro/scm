// Transcribe worker. Runs under Electron's utilityProcess (plain Node — same
// environment as the OCR worker). Speech transcription is CPU-heavy and long
// (minutes per film), unrelated to onnxruntime CLIP inference, so it lives
// in a DEDICATED process rather than inside the CLIP indexer worker. Answers:
//   { type: "transcribe-video", path, filename, fromIndex, id } →
//   { type: "transcribe-done", id, ok, chunks:[{t0,t1,text}], fromIndex, total, done, error }
//   { type: "shutdown" } → process.exit(0)
// Progress is broadcast as { type: "transcribe-progress", filename, ...p }
// per 30 s audio slice, so the renderer's tray ticks while a film decodes.
//
// Engine: transformers.js Whisper (`Xenova/whisper-{tiny,base}[.en]`,
// automatic-speech-recognition) — fully local, no native binary to package
// or notarize, ~150-300 MB download reused offline from
// TRANSFORMERS_CACHE, CPU background-friendly on base M1. The multilingual
// models need an explicit language in transformers.js (it defaults to
// English with a warning; English-only models THROW if given one), so each
// transcribe call auto-detects the language once from its first decodable
// slice (one seeded decoder step — whisper's own probe) and passes it down.
// Audio comes from the bundled ffmpeg (16 kHz mono wav slices, one per 30 s
// window). When the engine is unavailable (model download failed, no
// ffmpeg) the worker returns valid empty chunks (silent-film shape) instead
// of failing — the speech index stays visual-only and everything else keeps
// working. Tests drive deterministic output via TRANSCRIBE_FIXTURE=json
// (no model, no ffmpeg).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { assertNever } from "../main-lib/assert-never.ts";

import {
	TRANSCRIPTS_PER_CHUNK,
	TRANSCRIBE_HEARTBEAT_INTERVAL_MS,
	TRANSCRIBE_SLICE_DECODE_TIMEOUT_MS,
	buildTranscriptChunks,
	parseWhisperModel,
	transcriptsPerChunkFor,
	WHISPER_MODELS,
} from "./transcript-store-utils.ts";

import type { WhisperModel, WhisperModelId } from "./transcript-store-utils.ts";

// Slice-stall suicide exit code: a single whisper decode exceeded its
// per-slice ceiling while holding native ONNX session state that cannot be
// cancelled — the process must die so the next attempt starts clean (the
// transformers pipeline is not reentrant; an orphaned decode overlapping
// the next slice risks tensor corruption). Main respawns on demand and the
// poison slice rides the skip list, so no progress is lost but the gap.
const SLICE_STALL_EXIT_CODE = 7;

export type CodedError = Error & {
	code?: string;
	stalledSlice?: number | null;
};

export type TranscribeProgress = {
	phase?: string;
	filename?: string;
	model?: string;
	done?: number;
	total?: number;
	loaded?: number;
	slice?: number;
	heartbeat?: boolean;
	heartbeatAt?: number;
};

type AsrPipeline =
	import("@huggingface/transformers").AutomaticSpeechRecognitionPipeline;

type AsrOutput = {
	text?: string;
	chunks?: Array<{ text: string; timestamp?: [number | null, number | null] }>;
} | null;

/**
 * Progress payload for transcribe-progress / the internal onProgress hook.
 * Telemetry only: filename + model identify the job; slice/heartbeat drive
 * main's stall watchdog.
 * @typedef {object} TranscribeProgress
 * @property {string} [phase]
 * @property {string} [filename]
 * @property {string} [model]
 * @property {number} [done]
 * @property {number} [total]
 * @property {number} [loaded]
 * @property {number} [slice]
 * @property {boolean} [heartbeat]
 * @property {number} [heartbeatAt]
 */

// Race a promise against a ceiling: on expiry the underlying work is NOT
// cancelled (callers must treat the worker as tainted — see above).
function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	label: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	const gate = new Promise((_, reject) => {
		timer = setTimeout(() => {
			const err = new Error(`${label} timed out after ${ms}ms`) as CodedError;
			err.code = "SLICE_TIMEOUT";
			reject(err);
		}, ms);
		if (timer && typeof timer.unref === "function") timer.unref();
	});
	return Promise.race([promise, gate]).then(
		(v) => {
			if (timer) clearTimeout(timer);
			return v as T;
		},
		(err) => {
			if (timer) clearTimeout(timer);
			throw err;
		},
	);
}

// One whisper slice covers this many seconds of film. Matches Whisper's
// native 30 s window, so no intra-slice chunking/stride is needed.
const SLICE_SECONDS = 30;
// Default model (env override for benchmarks/CI). Production passes
// `modelId` per transcribe-video message (Settings → Speech model); the
// pipeline below reloads on change.
const WHISPER_MODEL_ID =
	process.env.WHISPER_MODEL_ID ||
	// Cast: the default id is always present in the registry.
	(WHISPER_MODELS["tiny.en"] as WhisperModel).hfId;

// Full utterance text cap for the sidecar (whisper chunk texts are seconds
// of speech, ~100-200 chars; the cap is a guard, never a truncation in
// practice — unlike the 240-char search-window cap in buildTranscriptChunks).
const UTTERANCE_MAX_CHARS = 500;

function post(
	message:
		| import("../shared/worker-messages.ts").TranscribeOutbound
		| { type: string; id?: string; ok: false; error: string },
) {
	if (process.parentPort) {
		process.parentPort.postMessage(message);
	}
}

// Orphan-proof ffmpeg tracking (same fix as video-utils): every wav-slice
// ffmpeg is registered so kill-ffmpeg / shutdown / process exit SIGKILLs it
// instead of orphaning to PID 1. Main also tracks reported PIDs so it can
// kill by PID after this worker dies.
import * as videoUtilsModule from "./video-utils.ts";

// Deliberately lazy at RUNTIME (the import above is type-only usage): the
// worker can run without ffmpeg for the fixture path. Kept as a nullable
// module ref like the pre-conversion require.
let transcribeVideoUtils: typeof videoUtilsModule | null = null;
try {
	transcribeVideoUtils = videoUtilsModule;
	transcribeVideoUtils.setFfmpegReporter((event: Record<string, unknown>) => {
		if (!event) return;
		if (event.type === "ffmpeg-spawn" || event.type === "ffmpeg-exit") {
			post({ ...event } as Parameters<typeof post>[0]);
		}
	});
} catch {
	transcribeVideoUtils = null;
}

function killTranscribeFfmpeg(reason?: string) {
	if (
		transcribeVideoUtils &&
		typeof transcribeVideoUtils.killAllFfmpeg === "function"
	) {
		try {
			return transcribeVideoUtils.killAllFfmpeg(reason || "transcribe");
		} catch {
			return 0;
		}
	}
	return 0;
}

try {
	if (typeof process.on === "function") {
		process.on("exit", () => {
			killTranscribeFfmpeg("exit");
		});
	}
} catch {
	/* best-effort */
}

// Slice plan for a film of `durationSeconds` (null/unknown → single pass).
// Pure: { total, start(i), dur(i) }. fromIndex/total in replies count SLICES;
// returned `chunks` are transcript WINDOWS found in those slices (fewer when
// speech is sparse — mergeChunkTranscripts only appends, so this is safe).
function slicesForDuration(durationSeconds: number | null | undefined): {
	total: number;
	start: (i: number) => number;
	dur: (i: number) => number;
} {
	// Number() keeps the original loose-compare semantics for null /
	// undefined / numeric strings (all → falsy or NaN → single pass).
	const duration = Number(durationSeconds);
	if (!(duration > 0)) {
		return {
			total: 1,
			start: () => 0,
			dur: () => 0, // 0 = whole file (no -t cap)
		};
	}
	const total = Math.max(1, Math.ceil(duration / SLICE_SECONDS));
	return {
		total,
		start: (i) => i * SLICE_SECONDS,
		dur: () => SLICE_SECONDS + 5, // 5 s overlap so boundary words survive
	};
}

// Validated chunk-window size (slices per transcribe call): hand-edited
// settings must never break the queue — garbage falls back, bounds keep the
// window inside the per-call chunk budget (see transcript-store-utils).
function chunkWindow(raw: number | undefined, fallback: number): number {
	return typeof raw === "number" &&
		Number.isInteger(raw) &&
		raw >= 1 &&
		raw <= 32
		? raw
		: fallback;
}

// Shift slice-relative whisper timestamps to film-absolute time.
// Pure: [{t0, t1, text}] with sliceStart added, non-finite dropped.
function offsetUtterances(
	utterances: Array<{ t0: number; t1: number; text: string }>,
	sliceStart: number,
): Array<{ t0: number; t1: number; text: string }> {
	const out: Array<{ t0: number; t1: number; text: string }> = [];
	for (const u of utterances || []) {
		if (!u || !Number.isFinite(u.t0) || !Number.isFinite(u.t1) || u.t1 <= u.t0)
			continue;
		if (typeof u.text !== "string" || u.text.trim().length === 0) continue;
		out.push({
			t0: u.t0 + sliceStart,
			t1: u.t1 + sliceStart,
			text: u.text.trim(),
		});
	}
	return out;
}

// Parse a 16-bit PCM mono WAV (ffmpeg `pcm_s16le`) into Float32 samples.
// Pure: skips the 44-byte header, normalizes int16 → [-1, 1]. Throws on
// truncated/garbage buffers (caller treats as silence, never a failure).
function wavToFloat32(buffer: Buffer | ArrayBuffer | Uint8Array): Float32Array {
	// Branch keeps Buffer.from's overloads happy (Uint8Array copies the
	// bytes, ArrayBuffer is viewed in place — exactly the prior behavior).
	const bytes = Buffer.isBuffer(buffer)
		? buffer
		: buffer instanceof Uint8Array
			? Buffer.from(buffer)
			: Buffer.from(buffer);
	if (bytes.length < 44 + 2) throw new Error("wav too short");
	const data = bytes.subarray(44);
	if (data.length % 2 !== 0) throw new Error("wav data not int16-aligned");
	const samples = new Float32Array(data.length / 2);
	for (let i = 0; i < samples.length; i++) {
		samples[i] = data.readInt16LE(i * 2) / 32768;
	}
	return samples;
}

function runCmd(
	bin: string,
	args: string[],
	timeoutMs: number,
): Promise<{ stderr: string }> {
	return new Promise((resolve, reject) => {
		// The sanctioned-lie cast (context.ts precedent): both branches below
		// assign a real child synchronously before any use.
		// Sanctioned-lie init (context.ts precedent): both branches below
		// assign a real child synchronously before any use.
		let child = null as unknown as ChildProcess;
		if (
			transcribeVideoUtils &&
			typeof transcribeVideoUtils.spawnFfmpeg === "function"
		) {
			child = transcribeVideoUtils.spawnFfmpeg(bin, args, {
				stdio: ["ignore", "pipe", "pipe"],
			});
		} else {
			child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
		}
		let stderr = "";
		// ?. : pipe stdio always provides both streams (typed nullable).
		child.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		// stdout is the wav bytes — drained by the caller via pipe, not here.
		child.stdout?.resume();
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(
				new Error(`timed out after ${timeoutMs}ms: ${stderr.slice(-300)}`),
			);
		}, timeoutMs);
		child.on("error", (err: Error) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code: number | null) => {
			clearTimeout(timer);
			if (code === 0) resolve({ stderr });
			else reject(new Error(`exited ${code}: ${stderr.slice(-300)}`));
		});
	});
}

// Extract one wav slice to `destPath` (16 kHz mono s16le). Whole file when
// sliceDur is 0 (unknown duration). Rejects on failure (caller skips the
// slice — a gap, never a stuck queue).
async function extractWavSlice(
	ffmpeg: string,
	filePath: string,
	sliceStart: number,
	sliceDur: number,
	destPath: string,
): Promise<void> {
	const args =
		sliceDur > 0
			? [
					"-y",
					"-ss",
					String(sliceStart),
					"-i",
					filePath,
					"-t",
					String(sliceDur),
				]
			: ["-y", "-i", filePath];
	args.push("-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", destPath);
	await runCmd(ffmpeg, args, 120000);
	const stat = fs.statSync(destPath);
	if (!stat.size || stat.size < 44 + 3200) {
		// <0.1 s of audio — silence / no audio stream.
		throw new Error("empty audio slice");
	}
}

function resolveFfmpeg(): string {
	if (process.env.FFMPEG_PATH) {
		if (fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
		throw new Error(`FFMPEG_PATH set but missing: ${process.env.FFMPEG_PATH}`);
	}
	if (process.resourcesPath) {
		const p = path.join(process.resourcesPath, "ffmpeg");
		if (fs.existsSync(p)) return p;
	}
	try {
		// Deliberately-lazy require (unchanged): optional dev dependency.
		// eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberately-lazy (optional dev dependency — absent in packaged runs)
		const p = require("ffmpeg-static") as string | null;
		if (p && fs.existsSync(p)) return p;
	} catch {
		/* fall through */
	}
	throw new Error("No ffmpeg binary available");
}

// Fixture path for deterministic tests: TRANSCRIBE_FIXTURE=json array of
// {t0,t1,text} utterances covering the whole film. When set, no ffmpeg or
// model runs — the fixture is chunked directly.
function fixtureUtterances() {
	if (!process.env.TRANSCRIBE_FIXTURE) return null;
	try {
		const parsed = JSON.parse(process.env.TRANSCRIBE_FIXTURE);
		if (Array.isArray(parsed)) return parsed;
	} catch {
		/* fall through to real path */
	}
	return null;
}

// Keyed singleton: { model, pipeline }. A model switch drops the old
// pipeline (frees the resident weights) and loads the new one — the worker
// is long-lived, so without this a Settings change would never take effect.
let asrState: { model: WhisperModelId | null; pipeline: AsrPipeline | null } = {
	model: null,
	pipeline: null,
};
let asrFailedFor: WhisperModelId | null = null;

async function ensureAsr(
	modelId: string | undefined,
	onProgress?: ((progress: TranscribeProgress) => void) | null,
): Promise<AsrPipeline | null> {
	const want = parseWhisperModel(modelId);
	if (asrState.pipeline && asrState.model === want) return asrState.pipeline;
	if (asrFailedFor === want) return null;
	asrState = { model: null, pipeline: null };
	try {
		const mod = await import("@huggingface/transformers");
		if (process.env.TRANSFORMERS_CACHE) {
			mod.env.cacheDir = process.env.TRANSFORMERS_CACHE;
		}
		const hfId =
			(WHISPER_MODELS[want] && WHISPER_MODELS[want].hfId) || WHISPER_MODEL_ID;
		const pipeline = await mod.pipeline("automatic-speech-recognition", hfId, {
			progress_callback: (progress) => {
				if (
					progress.status === "progress" &&
					progress.total > 0 &&
					onProgress
				) {
					try {
						onProgress({
							phase: "model",
							model: want,
							loaded: progress.loaded,
							total: progress.total,
						});
					} catch {
						/* progress must never fail the chunk */
					}
				}
			},
		});
		asrState = { model: want, pipeline };
		asrFailedFor = null;
		return pipeline;
	} catch (err) {
		const e = err as { message?: string };
		console.warn(
			`[transcribe] whisper model ${want} unavailable (${e.message}) — speech index stays visual-only`,
		);
		asrFailedFor = want;
		return null;
	}
}

function capUtteranceText(text: string | null | undefined) {
	return String(text || "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, UTTERANCE_MAX_CHARS);
}

// Auto-detect the spoken language for a MULTILINGUAL whisper model: the
// standard probe — seed the decoder with just <|startoftranscript|> and
// read the first sampled token (whisper's own language guess). Seeding
// decoder_input_ids replaces the init tokens, so transformers.js never
// injects its English default. Returns the two-letter code via the model's
// own lang_to_id map, or null (English-only model, no lang map, jumbled
// output — callers simply omit the language kwarg).
async function detectWhisperLanguage(
	asr: AsrPipeline,
	samples: Float32Array,
): Promise<string | null> {
	// The pipeline exposes model/processor (public in transformers.js but
	// loosely typed); the cast keeps this resilient to dtype/session
	// selection while the shape stays pinned by test:transcribe-language.
	const a = asr as unknown as {
		processor: (audio: Float32Array) => Promise<{ input_features: unknown }>;
		model: {
			generation_config?: {
				is_multilingual?: boolean;
				decoder_start_token_id?: number | null;
				lang_to_id?: Record<string, number> | null;
			} | null;
			generate: (opts: Record<string, unknown>) => Promise<unknown>;
		};
	};
	const cfg = a.model.generation_config;
	if (!cfg || cfg.is_multilingual !== true || !cfg.lang_to_id) return null;
	const sot = cfg.decoder_start_token_id;
	if (typeof sot !== "number") return null;
	const { input_features } = await a.processor(samples);
	// max_new_tokens:1 also keeps generate() OFF the seek path (it is
	// entered only for return_timestamps without a token cap).
	const out = await a.model.generate({
		inputs: input_features,
		decoder_input_ids: [sot],
		max_new_tokens: 1,
	});
	const seq = (
		Array.isArray(out) ? out : (out as { tolist?: () => unknown })?.tolist?.()
	) as unknown[] | undefined;
	const row = Array.isArray(seq?.[0]) ? (seq[0] as unknown[]) : seq;
	if (!row || row.length === 0) return null;
	// Rows can carry BigInt (int64 tensors); Number() normalizes both.
	const predicted = Number(row[row.length - 1]);
	for (const [token, id] of Object.entries(cfg.lang_to_id)) {
		if (id === predicted) {
			const m = /^<\|([a-z]{2,3})\|>$/.exec(token);
			return m ? (m[1] as string) : null;
		}
	}
	return null;
}

// One whisper decode with timestamp collapse fallback. The timestamped
// decode can collapse to EMPTY text + zero chunks on sparse/quiet speech
// (verified: a 19 s clip with clear speech decodes verbatim without
// timestamps but empty with return_timestamps:true) while a plain decode
// of the same samples hears it fine — and an empty result here becomes a
// permanent transcript gap (never retried). So when the timestamped decode
// comes back empty, retry ONCE without timestamps; the caller then keeps
// the whole-slice text via its existing no-timestamps fallback. Bounded:
// one extra decode, only for slices that decoded empty. Returns the
// effective pipeline output ({ text, chunks }) for the slice.
// `language` (two-letter code or null): multilingual runs pass the
// auto-detected language + task "transcribe" so the text stays in the
// spoken language; English-only models never receive it (transformers.js
// throws on language/task for them).
async function decodeSliceWithFallback(
	asr: AsrPipeline,
	samples: Float32Array,
	label: string,
	language: string | null = null,
): Promise<AsrOutput> {
	const langKwargs = language ? { language, task: "transcribe" } : {};
	const timed = await asr(samples, {
		chunk_length_s: 30,
		stride_length_s: 5,
		return_timestamps: true,
		...langKwargs,
	});
	const timedText =
		timed && typeof timed.text === "string" ? timed.text.trim() : "";
	const timedChunks = (timed && timed.chunks) || [];
	if (timedText.length > 0 || timedChunks.length > 0) return timed;
	let plain;
	try {
		plain = await asr(samples, {
			chunk_length_s: 30,
			stride_length_s: 5,
			...langKwargs,
		});
	} catch (err) {
		const e = err as { message?: string } | null;
		console.warn(
			`[transcribe] plain-decode retry failed for ${label}: ${e && e.message}`,
		);
		return timed;
	}
	const plainText =
		plain && typeof plain.text === "string" ? plain.text.trim() : "";
	if (plainText.length === 0) return timed;
	return { ...plain, chunks: [] };
}

async function transcribeVideo(
	filePath: string,
	fromIndex = 0,
	opts: {
		filename?: string;
		modelId?: string;
		slicesPerChunk?: number;
		sliceDecodeTimeoutMs?: number;
		skipSlices?: number[];
		onProgress?: ((progress: TranscribeProgress) => void) | null;
	} = {},
) {
	const onProgress = opts.onProgress || null;
	const model = parseWhisperModel(opts.modelId || process.env.WHISPER_MODEL_ID);
	const report = (p: TranscribeProgress) => {
		if (!onProgress) return;
		try {
			onProgress(p);
		} catch {
			/* progress must never fail the chunk */
		}
	};
	// Deterministic fixture (tests, CI without binaries).
	const fixture = fixtureUtterances();
	if (fixture) {
		const chunks = buildTranscriptChunks(fixture);
		const fixtureWin = chunkWindow(opts.slicesPerChunk, TRANSCRIPTS_PER_CHUNK);
		const slice = chunks.slice(fromIndex, fromIndex + fixtureWin);
		report({
			phase: "transcribe",
			done: fromIndex + slice.length,
			total: chunks.length,
		});
		// Utterances overlapped by this call's chunk span (same paging
		// contract as chunks: time-bounded, full text, absolute times).
		let utterances: Array<{ t0: number; t1: number; text: string }> = [];
		if (slice.length > 0) {
			const first = slice[0];
			const last = slice[slice.length - 1];
			if (first && last) {
				const spanT0 = first.t0;
				const spanT1 = last.t1;
				utterances = fixture
					.filter((u) => u && u.t1 > spanT0 && u.t0 < spanT1)
					.map((u) => ({ t0: u.t0, t1: u.t1, text: capUtteranceText(u.text) }))
					.filter((u) => u.text.length > 0);
			}
		}
		return {
			done: fromIndex + slice.length >= chunks.length,
			chunks: slice,
			utterances,
			fromIndex: fromIndex + slice.length,
			total: chunks.length,
			model,
		};
	}
	// Plan slices across the film's duration (probe failure → whole file).
	let duration;
	let ffmpeg;
	try {
		ffmpeg = resolveFfmpeg();
		try {
			duration = await videoUtilsModule.probeDuration(ffmpeg, filePath);
		} catch {
			duration = null;
		}
	} catch (err) {
		// No ffmpeg at all: valid empty result (never retry-forever).
		const e = err as { message?: string };
		return {
			done: true,
			chunks: [],
			utterances: [],
			fromIndex,
			total: 0,
			model,
			note: String(e.message).slice(0, 120),
		};
	}
	const plan = slicesForDuration(duration);
	// Window size is per-model (base.en runs fewer slices so the call fits
	// its chunk ceiling — see transcript-store-utils budget arithmetic).
	// Validated: garbage falls back to the legacy 16.
	const slicesPerChunk = chunkWindow(
		opts.slicesPerChunk,
		transcriptsPerChunkFor(model),
	);
	const modelSpeed =
		(WHISPER_MODELS[model] && WHISPER_MODELS[model].speedVsTiny) || 1;
	const requestedTimeoutMs = opts.sliceDecodeTimeoutMs;
	const sliceDecodeTimeoutMs =
		typeof requestedTimeoutMs === "number" &&
		Number.isFinite(requestedTimeoutMs) &&
		requestedTimeoutMs > 0
			? requestedTimeoutMs
			: TRANSCRIBE_SLICE_DECODE_TIMEOUT_MS * modelSpeed;
	const skipSet = new Set(
		(Array.isArray(opts.skipSlices) ? opts.skipSlices : []).filter(
			(s) => Number.isInteger(s) && s >= 0,
		),
	);
	const sliceIndexes: number[] = [];
	for (
		let i = fromIndex;
		i < Math.min(plan.total, fromIndex + slicesPerChunk);
		i++
	) {
		sliceIndexes.push(i);
	}
	if (sliceIndexes.length === 0) {
		return {
			done: true,
			chunks: [],
			utterances: [],
			fromIndex,
			total: plan.total,
			model,
		};
	}
	// Announce load start BEFORE the weights load: ONNX graph construction
	// emits zero download-progress ticks, so without this the main process
	// cannot tell "model loading for minutes" from "wedged with no output"
	// when the worker later dies — every load-phase crash would look phaseless.
	report({
		phase: "model",
		filename: opts.filename,
		model,
		loaded: 0,
		total: 0,
	});
	const asr = await ensureAsr(model, (p) =>
		report({ filename: opts.filename, ...p }),
	);
	if (!asr) {
		// Model unavailable: valid empty result for THIS call only — the
		// main process records chunks:[] so the file is not retried.
		return {
			done: true,
			chunks: [],
			utterances: [],
			fromIndex,
			total: plan.total,
			model,
		};
	}
	const utterances: Array<{ t0: number; t1: number; text: string }> = [];
	// Multilingual models: language auto-detected once per CALL from the
	// first decodable slice. Call-scoped (not per file) on purpose — a
	// mis-probe on a silent opening self-heals in later calls, and the
	// probe costs one encoder pass per call. English-only models never
	// enter this path (detection returns null). A throwing probe is
	// retried on the next slice, capped: beyond the cap the call proceeds
	// language-less (transformers.js then defaults to English).
	let language: string | null = null;
	let detectAttempts = 0;
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memories-transcribe-"));
	// Interval heartbeat: a single whisper decode can run minutes with zero
	// per-slice ticks (the 959 s-silence class) — tick the current slice so
	// the main process can tell slow-but-alive from wedged and can name the
	// poison slice on a stall kill. Heartbeat-only ticks never mark decode
	// progress (main checks `heartbeat`, like the enrich pump).
	let hbSlice = fromIndex;
	let hbDone = fromIndex;
	const hbTimer = setInterval(() => {
		report({
			phase: "transcribe",
			done: hbDone,
			total: plan.total,
			filename: opts.filename,
			model,
			slice: hbSlice,
			heartbeat: true,
			heartbeatAt: Date.now(),
		});
	}, TRANSCRIBE_HEARTBEAT_INTERVAL_MS);
	if (hbTimer && typeof hbTimer.unref === "function") hbTimer.unref();
	try {
		for (const [n, si] of sliceIndexes.entries()) {
			hbSlice = si;
			const sliceStart = duration && duration > 0 ? plan.start(si) : 0;
			const sliceDur = duration && duration > 0 ? plan.dur(si) : 0;
			if (skipSet.has(si)) {
				// Previously-stalled slice (poison): record the gap and move
				// on — replaying it would wedge this call identically.
				console.warn(
					`[transcribe] slice ${si} skipped for ${opts.filename || filePath} (previously stalled — gap, not failure)`,
				);
				hbDone = fromIndex + n + 1;
				report({
					phase: "transcribe",
					done: hbDone,
					total: plan.total,
					filename: opts.filename,
					model,
					slice: si,
				});
				continue;
			}
			const wavPath = path.join(tmpDir, `slice-${si}.wav`);
			try {
				await extractWavSlice(ffmpeg, filePath, sliceStart, sliceDur, wavPath);
				const samples = wavToFloat32(fs.readFileSync(wavPath));
				if (samples.length < 16000 * 0.5) continue; // <0.5 s — silence
				if (language === null && detectAttempts < 3) {
					detectAttempts++;
					try {
						language = await withTimeout(
							detectWhisperLanguage(asr, samples),
							sliceDecodeTimeoutMs,
							`slice ${si} language detect`,
						);
						if (language) {
							console.log(
								`[transcribe] ${opts.filename || filePath}: language ${language} (auto-detected)`,
							);
						}
					} catch (langErr) {
						const le = langErr as CodedError | null;
						if (le && le.code === "SLICE_TIMEOUT") {
							// Same non-reentrancy contract as a wedged decode:
							// the native session may still be running, so the
							// worker must die before the next slice touches it.
							const stall = new Error(
								`slice ${si} language detect stalled (${sliceDecodeTimeoutMs}ms ceiling) for ${opts.filename || filePath} — gap, worker restarting`,
							) as CodedError;
							stall.code = "SLICE_STALL";
							stall.stalledSlice = si;
							throw stall;
						}
						console.warn(
							`[transcribe] language detect failed on slice ${si} for ${opts.filename || filePath}: ${le && le.message}`,
						);
					}
				}
				let out;
				try {
					out = await withTimeout(
						decodeSliceWithFallback(
							asr,
							samples,
							opts.filename || filePath,
							language,
						),
						sliceDecodeTimeoutMs,
						`slice ${si} decode`,
					);
				} catch (decodeErr) {
					const de = decodeErr as CodedError | null;
					if (de && de.code === "SLICE_TIMEOUT") {
						// Wedged decode holding native session state: the call
						// cannot continue safely (orphan vs next-slice overlap
						// on a non-reentrant pipeline). Report the slice and
						// suicide; main respawns fresh and skips it next try.
						const stall = new Error(
							`slice ${si} decode stalled (${sliceDecodeTimeoutMs}ms ceiling) for ${opts.filename || filePath} — gap, worker restarting`,
						) as CodedError;
						stall.code = "SLICE_STALL";
						stall.stalledSlice = si;
						throw stall;
					}
					throw decodeErr;
				}
				const rawChunks = (out && out.chunks) || [];
				const sliceUtterances = rawChunks
					.filter(
						(c) => c && typeof c.text === "string" && c.text.trim().length > 0,
					)
					.map((c) => ({
						t0: Number(c.timestamp?.[0]),
						t1: Number(c.timestamp?.[1]),
						text: capUtteranceText(c.text),
					}))
					.filter(
						(u) =>
							Number.isFinite(u.t0) &&
							Number.isFinite(u.t1) &&
							u.t1 > u.t0 &&
							u.text.length > 0,
					);
				// No chunk timestamps (very short slice): keep whole-slice text.
				if (
					sliceUtterances.length === 0 &&
					out &&
					typeof out.text === "string" &&
					out.text.trim().length > 0
				) {
					const end =
						sliceDur > 0
							? sliceStart + Math.min(sliceDur, 30)
							: sliceStart + 30;
					const whole = capUtteranceText(out.text);
					if (whole.length > 0)
						utterances.push({ t0: sliceStart, t1: end, text: whole });
				} else {
					utterances.push(...offsetUtterances(sliceUtterances, sliceStart));
				}
			} catch (sliceErr) {
				const se = sliceErr as CodedError;
				if (se.code === "SLICE_STALL") throw sliceErr;
				// One bad slice (corrupt GOP, silent stretch) is a gap, never
				// a stuck queue.
				console.warn(
					`[transcribe] slice ${si} skipped for ${opts.filename || filePath}: ${se.message}`,
				);
			} finally {
				try {
					fs.unlinkSync(wavPath);
				} catch {
					/* best-effort */
				}
				hbDone = fromIndex + n + 1;
				report({
					phase: "transcribe",
					done: hbDone,
					total: plan.total,
					filename: opts.filename,
					model,
					slice: si,
				});
			}
		}
	} finally {
		if (hbTimer) clearInterval(hbTimer);
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
	const chunks = buildTranscriptChunks(utterances);
	const nextIndex = fromIndex + sliceIndexes.length;
	return {
		done: nextIndex >= plan.total,
		chunks,
		// Absolute-time, full-text utterances for THIS call's slices (the
		// exact-search index; main accumulates them like chunks). Capped per
		// utterance by capUtteranceText, never by the 240-char window cap.
		utterances: utterances
			.map((u) => ({ t0: u.t0, t1: u.t1, text: capUtteranceText(u.text) }))
			.filter((u) => u.text.length > 0),
		fromIndex: nextIndex,
		total: plan.total,
		model,
	};
}

// Inbound dispatch (protocol: shared/worker-messages.ts TranscribeInbound).
async function handleMessage(
	message: import("../shared/worker-messages.ts").TranscribeInbound,
): Promise<void> {
	const type = message.type;
	// id exists on transcribe-video / kill-ffmpeg (shutdown has none) — keep
	// it for the failure echoes below.
	const id = message.type === "shutdown" ? undefined : message.id;
	try {
		if (type === "transcribe-video") {
			const {
				path: filePath,
				fromIndex = 0,
				filename,
				modelId,
				slicesPerChunk,
				sliceDecodeTimeoutMs,
				skipSlices,
			} = message;
			try {
				const out = await transcribeVideo(filePath, fromIndex, {
					filename,
					modelId,
					slicesPerChunk,
					sliceDecodeTimeoutMs,
					skipSlices,
					onProgress: (p) =>
						post({ type: "transcribe-progress", filename, ...p }),
				});
				post({ type: "transcribe-done", id, ok: true, ...out });
			} catch (err) {
				const e = err as CodedError | null;
				if (e && e.code === "SLICE_STALL") {
					// See the suicide contract above: report the exact slice,
					// then die so the orphaned native decode dies with us.
					// The exit is deferred one tick — parentPort delivery is
					// async and an immediate process.exit() can drop the
					// report (main falls back to its last slice tick then,
					// which the interval heartbeat keeps fresh anyway).
					post({
						type: "transcribe-done",
						id,
						ok: false,
						error: e.message || String(err),
						stalledSlice: Number.isInteger(e.stalledSlice)
							? e.stalledSlice
							: null,
					});
					console.warn(`[transcribe] ${e.message}`);
					setTimeout(() => process.exit(SLICE_STALL_EXIT_CODE), 250);
					return;
				}
				throw err;
			}
			return;
		}
		if (type === "kill-ffmpeg") {
			let killed = 0;
			try {
				killed = killTranscribeFfmpeg("ipc kill-ffmpeg");
			} catch {
				/* best-effort */
			}
			post({ type: "ffmpeg-killed", id, ok: true, killed });
			return;
		}
		if (type === "shutdown") {
			try {
				killTranscribeFfmpeg("shutdown");
			} catch {
				/* best-effort */
			}
			process.exit(0);
		}
		// Exhaustiveness (Tier 4): a new TranscribeInbound variant must be
		// handled above, never silently dropped.
		assertNever(type);
	} catch (err) {
		const e = err as CodedError | null;
		post({
			type,
			ok: false,
			id,
			error: (e && e.message) || String(err),
		});
	}
}

if (process.parentPort) {
	process.parentPort.on("message", (event) => {
		/** @type {import("../shared/worker-messages.ts").TranscribeInbound} */
		const message = event.data;
		void handleMessage(message);
	});
}

// Standalone: `node indexer/transcribe-worker.js --smoke` exercises the
// fixture path without Electron, ffmpeg, or model download.
if (require.main === module && process.argv.includes("--smoke")) {
	(async () => {
		process.env.TRANSCRIBE_FIXTURE = JSON.stringify([
			{ t0: 0, t1: 8, text: "Welcome to the pricing overview today." },
			{ t0: 10, t1: 18, text: "Where she explains the refund policy clearly." },
			{ t0: 40, t1: 48, text: "The architecture diagram shows the new flow." },
		]);
		const out = await transcribeVideo("smoke.mp4", 0, {});
		console.log(JSON.stringify(out, null, 2));
	})();
}

export {
	transcribeVideo,
	detectWhisperLanguage,
	slicesForDuration,
	offsetUtterances,
	wavToFloat32,
	withTimeout,
	SLICE_SECONDS,
	WHISPER_MODEL_ID,
	UTTERANCE_MAX_CHARS,
	SLICE_STALL_EXIT_CODE,
	capUtteranceText,
	decodeSliceWithFallback,
};
