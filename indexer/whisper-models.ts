// The whisper model registry and the transcribe pump's knobs: engine
// ids, per-model chunk sizes, timeout ladders, retry caps, and the
// exit/failure label helpers. Pure data + pure functions — split out of
// transcript-store-utils.ts (2026-10-25) so the registry travels without
// the row-store pipeline. Mirrors src/lib/whisperModel.ts (renderer
// blurbs); the engine ids and timeout math live here.

// Each transcribe-video call embeds at most this many chunks
// (transcribe-worker.js); a long film spans multiple calls. Centralized here
// so main.ts, the worker, and the unit tests share one value.
export const TRANSCRIPTS_PER_CHUNK = 16;

// Never-stall timeouts (mirror ENRICH_* in segment-store-utils.ts).
// A transcription call decodes up to slicesPerChunk wav slices + whisper
// decodes: the chunk ceiling covers a worst-case-but-alive call; the stall
// interval is the longest silence (no transcribe-progress heartbeat)
// tolerated before the worker is considered wedged and restarted; the
// per-slice decode ceiling bounds ONE pathological slice (music/noise beds
// can stall a single whisper decode for 15+ minutes with zero ticks —
// observed on a 1.7 GB WEBRip at slice ~80/205, heartbeat 959 s stale —
// while the 120 s ffmpeg-extract ceiling already bounds the wav step).
//
// Budget arithmetic (measured 2026-10-12): base.en needs ~75-150 s per
// 30 s slice on a loaded 8 GB M1, so 16 slices do NOT fit the 20 min chunk
// ceiling — base.en runs 8 slices/call (≈10-20 min, fits), tiny.en keeps
// 16 (≈8-13 min of a 10 min ceiling… worst-case-but-alive, backstop only).
// Per-slice decode ceilings (2 min tiny / 4 min base) catch outliers only.
//
// Whisper model ladder: English-only `.en` rungs (default — the library is
// mostly English, and `.en` wins on English words/second) plus the
// multilingual twins with per-file language auto-detect in the worker
// (Xenova/whisper-{tiny,base}, 99 languages) for non-English dialogue.
// Timings are sized per model: base decodes ~2x slower than tiny on M1 CPU,
// so its ceilings scale up; both share slicesPerChunk by speed rung.
// small.en (244M, ~1GB fp32) was removed: it OOM-crashed the transcribe
// worker on 8GB Macs on every file (exit code 5, load-phase) — see
// MDs/archive/Whisper-Memory-Fix-Plan.md. large-v3 was evaluated and rejected (GBs
// of download vs the 3GB budget, ~4GB+ peak RAM on base 8GB M1, weeks of
// background CPU for a 30-film library) — see MDs/archive/Dialogue-Exact-Search-Plan.md §2.
export interface WhisperModel {
	hfId: string;
	paramsM: number;
	downloadMB: number;
	speedVsTiny: number;
}

export const WHISPER_MODELS: Record<string, WhisperModel> = {
	"tiny.en": {
		hfId: "Xenova/whisper-tiny.en",
		paramsM: 39,
		downloadMB: 150,
		speedVsTiny: 1,
	},
	"base.en": {
		hfId: "Xenova/whisper-base.en",
		paramsM: 74,
		downloadMB: 300,
		speedVsTiny: 2,
	},
	// Multilingual (language auto-detect per file, worker-side). Same
	// parameter count/speed as their .en twins; slightly worse on English.
	tiny: {
		hfId: "Xenova/whisper-tiny",
		paramsM: 39,
		downloadMB: 150,
		speedVsTiny: 1,
	},
	base: {
		hfId: "Xenova/whisper-base",
		paramsM: 74,
		downloadMB: 300,
		speedVsTiny: 2,
	},
};
export const DEFAULT_WHISPER_MODEL = "tiny.en";
export const TRANSCRIBE_CHUNK_TIMEOUT_MS = 10 * 60 * 1000;
export const TRANSCRIBE_HEARTBEAT_INTERVAL_MS = 15000;
export const TRANSCRIBE_STALL_TIMEOUT_MS = 3 * 60 * 1000;
// Per-slice whisper-decode ceiling (tiny.en unit; scaled by speedVsTiny —
// base.en gets 4 min). Only outliers hit it; the ffmpeg-extract step keeps
// its own 120 s ceiling in the worker.
export const TRANSCRIBE_SLICE_DECODE_TIMEOUT_MS = 2 * 60 * 1000;
// Slices per transcribe-video call (tiny.en unit; base.en runs fewer so the
// window fits the chunk ceiling — see the budget arithmetic above).
export const TRANSCRIPTS_PER_CHUNK_TINY = 16;
export const TRANSCRIPTS_PER_CHUNK_BASE = 8;
export const TRANSCRIBE_MAX_RETRIES = 3;
// Load-phase crashes (worker dies before its first transcribe-phase tick —
// model download/ONNX load, never a slice decode) are systematic, not
// transient: re-loading the same weights 4× just burns minutes. Bound them
// to a single retry; decode-phase failures keep the full budget.
export const TRANSCRIBE_LOAD_MAX_RETRIES = 1;

export type WhisperModelId = "tiny.en" | "base.en" | "tiny" | "base";

// Validated whisper-model parse (mirror parseVideoQuality): unknown →
// default, so a hand-edited settings.json can never break the queue.
// Legacy alias: "small.en" was removed (OOM on 8GB) — stored values and
// sidecar stamps carrying it resolve to "base.en" (closest surviving rung),
// so existing small.en users migrate with a single re-transcribe instead of
// silently dropping to tiny.
export function parseWhisperModel(raw: string | undefined): WhisperModelId {
	if (raw === "small.en") return "base.en";
	return raw && Object.prototype.hasOwnProperty.call(WHISPER_MODELS, raw)
		? (raw as WhisperModelId)
		: DEFAULT_WHISPER_MODEL;
}

// The "base" speed rung (either flavor): fewer slices per call so the
// window fits the chunk ceiling (see the budget arithmetic above).
function isBaseRung(id: WhisperModelId): boolean {
	return id === "base.en" || id === "base";
}

export interface TranscribeTimeouts {
	chunkTimeoutMs: number;
	heartbeatIntervalMs: number;
	stallTimeoutMs: number;
	sliceDecodeTimeoutMs: number;
	slicesPerChunk: number;
	maxRetries: number;
}

// Per-model never-stall ceilings: decode time scales with params, so the
// chunk + stall + per-slice timeouts scale with the model's measured
// slowdown vs tiny. Heartbeat interval is model-independent (progress ticks
// per slice). slicesPerChunk shrinks for slower models so the window still
// fits the chunk ceiling (base.en: 8 slices ≈ 10-20 min of a 20 min budget).
export function transcribeTimeoutsFor(
	model: string | undefined,
): TranscribeTimeouts {
	// Cast: parseWhisperModel only returns registry ids — the lookup is
	// always dense (the default-model fallback is belt-and-braces).
	const m = (WHISPER_MODELS[parseWhisperModel(model)] ||
		WHISPER_MODELS[DEFAULT_WHISPER_MODEL]) as WhisperModel;
	return {
		chunkTimeoutMs: TRANSCRIBE_CHUNK_TIMEOUT_MS * m.speedVsTiny,
		heartbeatIntervalMs: TRANSCRIBE_HEARTBEAT_INTERVAL_MS,
		stallTimeoutMs: TRANSCRIBE_STALL_TIMEOUT_MS * m.speedVsTiny,
		sliceDecodeTimeoutMs: TRANSCRIBE_SLICE_DECODE_TIMEOUT_MS * m.speedVsTiny,
		slicesPerChunk: isBaseRung(parseWhisperModel(model))
			? TRANSCRIPTS_PER_CHUNK_BASE
			: TRANSCRIPTS_PER_CHUNK_TINY,
		maxRetries: TRANSCRIBE_MAX_RETRIES,
	};
}

// Slices per call for a model id (worker + pump share this; the legacy
// TRANSCRIPTS_PER_CHUNK constant stays 16 for tiny.en compatibility).
export function transcriptsPerChunkFor(model: string | undefined) {
	return isBaseRung(parseWhisperModel(model))
		? TRANSCRIPTS_PER_CHUNK_BASE
		: TRANSCRIPTS_PER_CHUNK_TINY;
}

// Record a stalled/poison slice index into a skip list: validated ints,
// deduplicated, sorted, capped (a runaway list means the whole film is
// pathological — the pump drops the job past the cap instead). Pure.
export function addSkippedSlice(
	skipped: unknown,
	si: unknown,
	cap = 32,
): number[] {
	const list = Array.isArray(skipped) ? skipped.slice() : [];
	if (
		Number.isInteger(si) &&
		(si as number) >= 0 &&
		!list.includes(si as number)
	)
		list.push(si as number);
	list.sort((a, b) => a - b);
	return list.slice(0, cap);
}

// Human-readable label for a utilityProcess exit: code and/or signal, with
// an OOM hint for SIGKILL (the kernel/OOM-killer signature on 8 GB Macs —
// the prime suspect when a Whisper worker dies during fp32 weight load).
// Pure + unit-tested; main.ts uses it so `Transcribe worker exited` is never
// the whole story again.
export function transcribeExitLabel(
	code: number | null | undefined,
	signal: string | null | undefined,
): string {
	if (signal) {
		const hint =
			signal === "SIGKILL"
				? " (likely OOM-killed — check memory pressure + model cache size)"
				: "";
		return `exit signal ${signal}${hint}`;
	}
	if (Number.isInteger(code)) return `exit code ${code}`;
	return "exited (no code/signal reported)";
}

// Compact failure context for pumpTranscription retry/drop lines: model,
// load-vs-decode phase, exit cause, and heartbeat silence. Every field is
// optional — missing pieces render as `unknown` rather than throwing, so
// logging can never fail the pump. Pure + unit-tested.
export function transcribeFailureLabel(
	opts: {
		model?: unknown;
		phase?: unknown;
		code?: number | null;
		signal?: string | null;
		heartbeatAgeMs?: unknown;
	} = {},
): string {
	const model =
		typeof opts.model === "string" && opts.model ? opts.model : "unknown model";
	const phase =
		opts.phase === "load" || opts.phase === "decode"
			? opts.phase
			: "unknown phase";
	const exit =
		opts.code !== undefined || opts.signal
			? transcribeExitLabel(opts.code, opts.signal)
			: null;
	const hb =
		Number.isFinite(opts.heartbeatAgeMs) && (opts.heartbeatAgeMs as number) >= 0
			? `heartbeat ${Math.round((opts.heartbeatAgeMs as number) / 1000)}s ago`
			: "no heartbeat yet";
	const parts = [`model ${model}`, `phase ${phase}`];
	if (exit) parts.push(exit);
	parts.push(hb);
	return parts.join(", ");
}

// Load-phase crash test: the worker died before any transcribe-phase tick
// for this job (model download/ONNX load — systematic), as opposed to dying
// mid-decode (possibly a single bad slice — transient). `hadProgress` is
// whether a transcribe-phase tick for THIS job was ever observed;
// `phase` is the last matching tick's phase ("model"/"transcribe"/null).
// Pure + unit-tested; main.ts bounds load-phase retries to 1.
export function isLoadPhaseCrash(
	opts: { hadProgress?: unknown; phase?: unknown } = {},
): boolean {
	if (opts.hadProgress) return false;
	return opts.phase !== "transcribe";
}
