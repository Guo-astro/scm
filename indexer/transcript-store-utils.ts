// Pure helpers for the transcript sidecar store (the transcription pump).
// Mirrors indexer/segment-store-utils.ts file-for-file so every guarantee
// transfers: chunked commits accumulate (never replace), offsets land inside
// the bin, timeouts bound worst-case chunks, truncation is detectable.
//
// A transcript chunk is one {t0, t1, off, n, text} row — n is always 1 (one
// embedding per ~30 s speech window). text is capped by the worker (~240
// chars) for tooltip snippets; ranking uses the embedding row only.
//
// These functions are free of fs/Electron so the contract is pinned by a
// seconds-fast unit test (test/pump-transcription.test.js) instead of an
// Electron smoke.

import { CJK_RUN_RE, cjkBigramsForText } from "../shared/cjk-tokens.ts";

export const TRANSCRIPT_ROW_PER = 1;

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

// Speech-window grouping defaults: ~30 s windows with 5 s overlap,
// sentence-safe (never split mid-sentence; carry remainder). Cheap to store
// (2 hr film ≈ 240 chunks max), so no preset-scaled budget like segments.
export const TRANSCRIPT_TARGET_SECONDS = 30;
export const TRANSCRIPT_OVERLAP_SECONDS = 5;
export const TRANSCRIPT_MAX_CHARS = 240;

// A chunk worth indexing: filters whisper junk before it is stored (chunk
// windows AND the embedded rows). Real text is:
//   - ≥ 8 chars with ≥ 2 latin words (original rule), OR
//   - ≥ 4 CJK runes — spaceless scripts give the latin split nothing to
//     chew on, so every Korean/Japanese/Chinese line used to read as junk
//     and the multilingual transcript never reached the index.
// Decode loops are rejected by repeated-adjacent-unit and low-uniqueness
// rules over BOTH latin words and CJK runs (runs, not bigrams: this is a
// "is it speech" gate, not the search tokenizer). Pure + unit-tested.
export function isRealTranscriptText(text: unknown): boolean {
	const clean = String(text || "")
		.replace(/\s+/g, " ")
		.trim();
	const words = clean.split(/[^a-zA-Z0-9']+/).filter(Boolean);
	// CJK runes via the shared rune class (never re-inline); a run's length
	// is code units, so count code points per run (astral Han = 2 units).
	const cjkRuns = clean.match(CJK_RUN_RE) || [];
	let cjkRunes = 0;
	for (const run of cjkRuns) cjkRunes += [...run].length;
	if (words.length < 2 && cjkRunes < 4) return false;
	if (clean.length < 8 && cjkRunes < 4) return false;
	// Collapse exact-repeat loops: more than 4 identical adjacent units is
	// a decode loop, not speech.
	if (hasRepeatLoop(words) || hasRepeatLoop(cjkRuns)) return false;
	// Collapse short-phrase loops ("thank you thank you …", music-bed
	// hallucinations): ≤2 unique units across ≥6 units is a loop.
	const units = [...words, ...cjkRuns];
	if (units.length >= 6) {
		const uniq = new Set(units.map((w) => w.toLowerCase()));
		if (uniq.size <= 2) return false;
	}
	return true;
}

// True when >4 identical adjacent units (case-insensitive) appear in a row.
function hasRepeatLoop(units: string[]): boolean {
	let repeats = 0;
	for (let i = 1; i < units.length; i++) {
		// Casts: i and i-1 are in [1, units.length) — dense by the loop.
		const cur = (units[i] as string).toLowerCase();
		const prev = (units[i - 1] as string).toLowerCase();
		if (cur === prev) repeats++;
		else repeats = 0;
		if (repeats >= 4) return true;
	}
	return false;
}

export function cleanTranscriptText(text: unknown): string {
	return String(text || "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, TRANSCRIPT_MAX_CHARS);
}

export interface TranscriptChunk {
	t0: number;
	t1: number;
	text: string;
}

// Group whisper utterances [{t0, t1, text}] into ~30 s search windows.
// Pure + deterministic: sorts by t0, drops non-finite/empty, groups until
// target seconds reached then extends to sentence end, overlaps by 5 s via
// time (not utterance count) so long silences don't glue distant speech.
// Returns [{t0, t1, text}] with text cleaned + capped. Empty input → [].
export function buildTranscriptChunks(
	utterances: unknown,
	opts: { targetSeconds?: unknown; overlapSeconds?: unknown } = {},
): TranscriptChunk[] {
	const target = Number(opts.targetSeconds) || TRANSCRIPT_TARGET_SECONDS;
	const overlap = Number(opts.overlapSeconds ?? TRANSCRIPT_OVERLAP_SECONDS);
	const list = (Array.isArray(utterances) ? utterances : [])
		.filter(
			(u: any) =>
				u &&
				Number.isFinite(u.t0) &&
				Number.isFinite(u.t1) &&
				u.t1 > u.t0 &&
				typeof u.text === "string" &&
				u.text.trim().length > 0,
		)
		.map((u: any) => ({ t0: u.t0, t1: u.t1, text: u.text.trim() }))
		.sort((a, b) => a.t0 - b.t0);
	if (list.length === 0) return [];
	const chunks: TranscriptChunk[] = [];
	let i = 0;
	while (i < list.length) {
		// Casts: i/j index list inside their bounds checks (the loop-bound
		// read pattern).
		const start = (list[i] as TranscriptChunk).t0;
		const windowEnd = start + target;
		let j = i;
		let end = (list[i] as TranscriptChunk).t1;
		// Extend to sentence end past the target: include utterances whose
		// start falls inside the window, plus one more if the last included
		// text does not end with sentence punctuation.
		while (j < list.length && (list[j] as TranscriptChunk).t0 < windowEnd) {
			end = Math.max(end, (list[j] as TranscriptChunk).t1);
			j++;
		}
		if (j < list.length && j > i) {
			const joined = list
				.slice(i, j)
				.map((u) => u.text)
				.join(" ");
			if (
				!/[.!?]$/.test(joined.trim()) &&
				(list[j] as TranscriptChunk).t0 - end < 8
			) {
				end = Math.max(end, (list[j] as TranscriptChunk).t1);
				j++;
			}
		}
		if (j === i) j = i + 1;
		const text = cleanTranscriptText(
			list
				.slice(i, j)
				.map((u) => u.text)
				.join(" "),
		);
		if (isRealTranscriptText(text)) {
			chunks.push({ t0: start, t1: end, text });
		}
		// Overlap: when the window reached the target length, the next
		// window starts at the first utterance ending after (end - overlap)
		// so boundary speech is searchable from both sides. When speech is
		// sparse (window shorter than target) advance past the window —
		// overlapping a 2-utterance film would only duplicate rows.
		let next = j;
		if (end - start >= target) {
			const overlapFrom = end - overlap;
			for (let k = i + 1; k < j; k++) {
				if ((list[k] as TranscriptChunk).t1 > overlapFrom) {
					next = k;
					break;
				}
			}
		}
		i = Math.max(next, i + 1);
	}
	// Collapse exact-duplicate adjacent chunks (whisper repeat loops
	// surviving the word filter at chunk scale).
	return chunks.filter((c, idx, arr) => {
		if (idx === 0) return true;
		// Cast: idx > 0 — the previous element exists.
		return (
			c.text.toLowerCase() !==
			(arr[idx - 1] as TranscriptChunk).text.toLowerCase()
		);
	});
}

export interface TranscriptRecord {
	t0: number;
	t1: number;
	off: number;
	n: number;
	text: string;
}

// Turn one reply chunk into sidecar rows stamped with the bin offsets where
// their embedding rows were (or will be) appended, then append them to the
// file's accumulated chunk list. Mirrors mergeChunkSegments exactly:
// ACCUMULATES — replacing the entry with only the current chunk used to
// leave just the last chunk's segments in the visual sidecar.
export function mergeChunkTranscripts(
	existing: any[],
	chunkChunks: any[],
	base: number,
	rowPer: number,
): TranscriptRecord[] {
	if (!Array.isArray(existing)) {
		throw new TypeError("existing must be an array");
	}
	if (!Array.isArray(chunkChunks)) {
		throw new TypeError("chunkChunks must be an array");
	}
	if (!Number.isInteger(base) || base < 0) {
		throw new TypeError(
			"base must be a non-negative integer (row count before this chunk)",
		);
	}
	if (!Number.isInteger(rowPer) || rowPer < 1) {
		throw new TypeError("rowPer must be a positive integer");
	}
	const records = chunkChunks.map((c: any, i: number) => ({
		t0: c.t0,
		t1: c.t1,
		off: base + i,
		n: rowPer,
		text: cleanTranscriptText(c.text),
	}));
	return [...existing, ...records];
}

// Split one transcribe-video reply chunk into successful rows vs skipped.
// Worker returns parallel arrays (chunks[i] ↔ vecs[i], null = skipped) so
// fromIndex still advances past failures. Mirrors partitionChunkReply.
export function partitionTranscriptReply(chunks: unknown, vecs: unknown) {
	const cs = Array.isArray(chunks) ? chunks : [];
	const vs = Array.isArray(vecs) ? vecs : [];
	const okChunks: TranscriptChunk[] = [];
	const okVecs: unknown[] = [];
	let skipped = 0;
	for (let i = 0; i < cs.length; i++) {
		const c = cs[i];
		const vec = i < vs.length ? vs[i] : null;
		if (c && c.skipped) {
			skipped++;
			continue;
		}
		if (
			!c ||
			!Number.isFinite(c.t0) ||
			!Number.isFinite(c.t1) ||
			c.t1 <= c.t0
		) {
			skipped++;
			continue;
		}
		if (!Array.isArray(vec) || vec.length === 0) {
			skipped++;
			continue;
		}
		if (!isRealTranscriptText(c.text)) {
			skipped++;
			continue;
		}
		okChunks.push({ t0: c.t0, t1: c.t1, text: cleanTranscriptText(c.text) });
		okVecs.push(vec);
	}
	return { okChunks, okVecs, skipped };
}

// Heuristic detection of truncated transcript sidecars (mirror of
// suspectedTruncated): multi-chunk plan, fewer survived than planned, tail
// cluster. Duration estimated from sidecar alone (last t1), no ffmpeg probe.
export function suspectedTruncatedTranscripts(
	videos: Map<string, any[]>,
	chunkSize = TRANSCRIPTS_PER_CHUNK,
): Array<{
	filename: string;
	planned: number;
	actual: number;
	duration: number;
}> {
	const flagged: Array<{
		filename: string;
		planned: number;
		actual: number;
		duration: number;
	}> = [];
	if (!(videos instanceof Map)) return flagged;
	for (const [filename, chunks] of videos) {
		if (!Array.isArray(chunks) || chunks.length === 0) continue;
		let first = chunks[0].t0;
		let last = chunks[0].t1;
		for (const c of chunks) {
			if (c.t0 < first) first = c.t0;
			if (c.t1 > last) last = c.t1;
		}
		const duration = last;
		if (!(duration > 0)) continue;
		const planned = Math.ceil(duration / TRANSCRIPT_TARGET_SECONDS);
		if (planned <= chunkSize) continue;
		if (chunks.length >= planned) continue;
		if (last - first < duration * 0.5) {
			flagged.push({ filename, planned, actual: chunks.length, duration });
		}
	}
	return flagged;
}

// Fusion weights / bucketing / caps (mirror main.ts rankers).
// Kept here so the fusion contract is unit-testable without Electron.
export const FUSION_W_VISUAL = 0.4;
export const FUSION_W_TEXT = 0.6;
export const FUSION_SLOT_SECONDS = 5;
export const FUSION_SCENES_PER_VIDEO = 3;
export const FUSION_NOISE_FRACTION = 0.25;
export const FUSION_NOISE_MIN_TOTAL = 20;
// The visual-only fraction gate below is statistically meaningless on a
// tiny corpus — with a handful of segments each one is ~10% and any
// two-shot video trips it, so small libraries get "no scene match" for
// genuine queries. Below this many visual rows the gate stands down (the
// ranking cutoff still applies). The text side keeps its strict gate at
// every size: transcript matching discriminates on small corpora and the
// dialogue honesty tests pin gibberish → [] there. Movie-heavy libraries,
// where the visual gate matters, always clear the minimum.
// Ordering-only literal boost for dialogue (mirrors RANK_OCR_WORD_BOOST):
// a query token literally spoken in the chunk lifts that moment to the
// front AFTER the cutoff — it reorders but can never shrink the set.
// 0.5 dominates the fused spread (~0.2) for full matches.
export const DIALOGUE_LITERAL_BOOST = 0.5;

// Fraction of query tokens literally present in a transcript chunk (0..1).
// Whole-word match, plus inflection-tolerant prefix match in BOTH directions
// ("love" ↔ "loves"/"loving"/"loved") for tokens of length ≥ 3 — short
// tokens stay exact-only ("ai" must not match "air"). Case-insensitive,
// punctuation-stripped, query deduped. CJK rides the shared bigrams
// (spaceless scripts have no words to split): query "멤버들의" meets a
// chunk saying 멤버들의 via [멤버,버들,들의] = 1.0. Pure + unit-tested.
export function literalFraction(query: unknown, text: unknown): number {
	const q = String(query || "");
	const qTokens = [
		...new Set([
			...q
				.toLowerCase()
				.split(/[^a-z0-9]+/)
				.filter((t) => t.length >= 2),
			...cjkBigramsForText(q),
		]),
	];
	if (qTokens.length === 0) return 0;
	const t = String(text || "");
	const words = new Set([
		...t
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((w) => w.length >= 2),
		...cjkBigramsForText(t),
	]);
	if (words.size === 0) return 0;
	let hits = 0;
	for (const tok of qTokens) {
		let found = words.has(tok);
		if (!found && tok.length >= 3) {
			for (const w of words) {
				if (w.length >= 3 && (w.startsWith(tok) || tok.startsWith(w))) {
					found = true;
					break;
				}
			}
		}
		if (found) hits++;
	}
	return hits / qTokens.length;
}

export interface VisualHit {
	filename: string;
	t: number;
	dur: number;
	poster: number;
	score: number;
	[key: string]: unknown;
}

export interface TextHit {
	filename: string;
	t: number;
	dur: number;
	snippet?: string | null;
	score: number;
	literal?: number;
	[key: string]: unknown;
}

export interface FusedMoment {
	filename: string;
	score: number;
	t: number;
	dur: number;
	poster: number;
	why: string;
	snippet: string | null;
}

interface FusionSlot {
	filename: string;
	t: number;
	visual: number;
	text: number;
	literal: number;
	poster: number;
	dur: number;
	snippet: string | null;
}

// Fuse pre-scored visual + transcript hits into ranked moments.
// Pure + deterministic (no embeddings, no fs, no Electron).
//
// visualHits: [{filename, t, dur, poster, score}] (already ≥ minScore)
// textHits:   [{filename, t, dur, snippet, score}] (already ≥ minScore)
// segVideos:  Map(filename → [{t, poster}]) for text-only poster backfill
//             (null/undefined = skip backfill, poster stays 0).
// visualTotal / textTotal: total rows scored per side (for noise gates).
// Returns [{filename, score, t, dur, poster, why, snippet}] sorted desc,
// capped per-video + topK, cut at max(minScore, top*relativeKeep).
// Gibberish floods (both sides hot everywhere) → [].
export function fuseVisualTextMoments({
	visualHits = [],
	textHits = [],
	segVideos = null,
	visualTotal = 0,
	textTotal = 0,
	minScore = 0.04,
	relativeKeep = 0.6,
	topK = 24,
	wVisual = FUSION_W_VISUAL,
	wText = FUSION_W_TEXT,
	slotSeconds = FUSION_SLOT_SECONDS,
	scenesPerVideo = FUSION_SCENES_PER_VIDEO,
	noiseFraction = FUSION_NOISE_FRACTION,
}: {
	visualHits?: any[];
	textHits?: any[];
	segVideos?: Map<string, any[]> | null;
	visualTotal?: unknown;
	textTotal?: unknown;
	minScore?: number;
	relativeKeep?: number;
	topK?: unknown;
	wVisual?: number;
	wText?: number;
	slotSeconds?: unknown;
	scenesPerVideo?: number;
	noiseFraction?: number;
} = {}): FusedMoment[] {
	const k = Math.max(1, Math.min(96, Number(topK) || 24));
	const slot = Math.max(1, Number(slotSeconds) || FUSION_SLOT_SECONDS);
	const vHits = Array.isArray(visualHits) ? visualHits : [];
	const tHits = Array.isArray(textHits) ? textHits : [];
	if (vHits.length === 0 && tHits.length === 0) return [];
	const slots = new Map<string, FusionSlot>();
	const slotKey = (filename: string, t: number) =>
		`${filename}::${Math.floor(t / slot)}`;
	for (const h of vHits) {
		if (
			!h ||
			typeof h.filename !== "string" ||
			!Number.isFinite(h.t) ||
			!Number.isFinite(h.score)
		)
			continue;
		const key = slotKey(h.filename, h.t);
		let s = slots.get(key);
		if (!s) {
			s = {
				filename: h.filename,
				t: h.t,
				visual: 0,
				text: 0,
				literal: 0,
				poster: Number.isFinite(h.poster) ? h.poster : 0,
				dur: Number.isFinite(h.dur) && h.dur > 0 ? h.dur : 0.5,
				snippet: null,
			};
			slots.set(key, s);
		}
		if (h.score > s.visual) {
			s.visual = h.score;
			s.t = h.t;
			s.poster = Number.isFinite(h.poster) ? h.poster : s.poster;
			if (Number.isFinite(h.dur) && h.dur > 0) s.dur = h.dur;
		}
	}
	for (const h of tHits) {
		if (
			!h ||
			typeof h.filename !== "string" ||
			!Number.isFinite(h.t) ||
			!Number.isFinite(h.score)
		)
			continue;
		const key = slotKey(h.filename, h.t);
		let s = slots.get(key);
		if (!s) {
			s = {
				filename: h.filename,
				t: h.t,
				visual: 0,
				text: 0,
				literal: 0,
				poster: 0,
				dur: Number.isFinite(h.dur) && h.dur > 0 ? h.dur : 0.5,
				snippet: null,
			};
			slots.set(key, s);
		}
		const lit =
			Number.isFinite(h.literal) && h.literal > 0 ? Math.min(1, h.literal) : 0;
		if (h.score > s.text) {
			s.text = h.score;
			s.literal = lit;
			if (!s.snippet && typeof h.snippet === "string" && h.snippet.length > 0)
				s.snippet = h.snippet;
			if (s.visual === 0) {
				s.t = h.t;
				if (Number.isFinite(h.dur) && h.dur > 0) s.dur = h.dur;
			}
		} else if (lit > s.literal) {
			s.literal = lit;
			if (
				!s.snippet &&
				typeof h.snippet === "string" &&
				h.snippet.length > 0 &&
				s.text > 0
			)
				s.snippet = h.snippet;
		} else if (
			!s.snippet &&
			typeof h.snippet === "string" &&
			h.snippet.length > 0 &&
			s.text > 0
		) {
			// Keep first snippet when a weaker text hit arrives second.
		}
	}
	// Text-only slots need a poster: nearest visual segment poster in the
	// same video (pure view concern; ranking unaffected). (The pre-conversion
	// `s.poster !== undefined` check is dead — poster is always a number:
	// initialized 0 or set from a finite value.)
	if (segVideos instanceof Map) {
		for (const s of slots.values()) {
			if (s.poster !== 0) continue;
			const segs = segVideos.get(s.filename);
			if (!segs || segs.length === 0) {
				s.poster = 0;
				continue;
			}
			let best = segs[0];
			let bestD = Math.abs(segs[0].t - s.t);
			for (const sg of segs) {
				if (!Number.isFinite(sg.t)) continue;
				const d = Math.abs(sg.t - s.t);
				if (d < bestD) {
					bestD = d;
					best = sg;
				}
			}
			s.poster = Number.isFinite(best.poster) ? best.poster : 0;
		}
	}
	const fused = [...slots.values()].map((s) => ({
		...s,
		score: wVisual * s.visual + wText * s.text,
		why: s.visual > 0 && s.text > 0 ? "both" : s.text > 0 ? "text" : "visual",
	}));
	fused.sort((a, b) => b.score - a.score);
	if (fused.length === 0) return [];
	// Cast: fused is non-empty here.
	const cutoff = Math.max(
		minScore,
		(fused[0] as { score: number }).score * relativeKeep,
	);
	// Literal spoken evidence IS discriminative evidence (the query's words
	// were literally uttered in that moment — same philosophy as the OCR
	// word boost and the scene-evidence gate): when any surviving candidate
	// carries it, the fraction gate stands down. Gibberish (zero literals
	// anywhere) still faces the gate and still returns [].
	const hasLiteralEvidence = fused.some(
		(f) => f.score >= cutoff && f.literal > 0,
	);
	const vTotal = Math.max(0, Number(visualTotal) || 0);
	const tTotal = Math.max(0, Number(textTotal) || 0);
	if (!hasLiteralEvidence) {
		if (vTotal > 0 && tTotal > 0) {
			let vAbove = 0;
			for (const h of vHits)
				if (h && Number.isFinite(h.score) && h.score >= cutoff) vAbove++;
			let tAbove = 0;
			for (const h of tHits)
				if (h && Number.isFinite(h.score) && h.score >= cutoff) tAbove++;
			if (
				vAbove / Math.max(1, vTotal) > noiseFraction &&
				tAbove / Math.max(1, tTotal) > noiseFraction
			) {
				return [];
			}
		} else if (vTotal > 0) {
			let vAbove = 0;
			for (const h of vHits)
				if (h && Number.isFinite(h.score) && h.score >= cutoff) vAbove++;
			if (
				vTotal >= FUSION_NOISE_MIN_TOTAL &&
				vAbove / Math.max(1, vTotal) > noiseFraction
			)
				return [];
		} else if (tTotal > 0) {
			let tAbove = 0;
			for (const h of tHits)
				if (h && Number.isFinite(h.score) && h.score >= cutoff) tAbove++;
			if (tAbove / Math.max(1, tTotal) > noiseFraction) return [];
		}
	}
	const perVideo = new Map<string, number>();
	const hits: FusedMoment[] = [];
	for (const f of fused) {
		if (f.score < cutoff) break;
		const seen = perVideo.get(f.filename) ?? 0;
		if (seen >= scenesPerVideo) continue;
		perVideo.set(f.filename, seen + 1);
		hits.push({
			filename: f.filename,
			// Ordering-only literal boost, applied AFTER the cutoff (same
			// contract as RANK_OCR_WORD_BOOST): a literally-spoken moment
			// leads the grid but the boost can never shrink the set.
			// Zero for visual-only callers (no literal field) — their
			// scores are byte-identical to before.
			score: f.score + DIALOGUE_LITERAL_BOOST * (f.literal > 0 ? f.literal : 0),
			t: f.t,
			dur: f.dur,
			poster: f.poster,
			why: f.why,
			snippet: f.snippet,
		});
		if (hits.length >= k) break;
	}
	hits.sort((a, b) => b.score - a.score);
	return hits;
}

// Attach the centered query vector to a results array WITHOUT changing its
// shape (M-11 single round-trip). Structured clone preserves own props on
// arrays, so `Array.isArray()` stays true for every existing consumer (perf
// battery, search-matrix diagnostics, older renderers) while new callers
// read `.queryVec`. Non-array input → empty array (never throws).
export function attachQueryVec(results: unknown, queryVec: unknown): any[] {
	const out: any = Array.isArray(results) ? results : [];
	out.queryVec = queryVec || null;
	return out;
}

// Apply one transcribed+embedded reply chunk to the sidecar store — the exact
// commit path pumpTranscription runs in production, extracted pure so the
// accumulation contract is unit-testable without Electron:
//   videos — Map(filename → [{t0,t1,off,n,text}]) so far
//   rows   — Float32Array[] embedding rows so far
//   okChunks/okVecs — partitioned successes for THIS call only
// Returns { videos: Map(new), rows: new[] }. Offsets are stamped at
// rows.length BEFORE this chunk's rows are pushed (they must land inside
// the bin); the file's list ACCUMULATES (replacing it used to leave only
// the last drain's chunks — the truncation bug class).
export function applyTranscriptReply(
	videos: unknown,
	rows: unknown,
	filename: string,
	okChunks: unknown,
	okVecs: unknown,
	rowPer: number,
): { videos: Map<string, TranscriptRecord[]>; rows: Float32Array[] } {
	if (!(videos instanceof Map)) throw new TypeError("videos must be a Map");
	if (!Array.isArray(rows)) throw new TypeError("rows must be an array");
	if (!Array.isArray(okChunks) || !Array.isArray(okVecs)) {
		throw new TypeError("okChunks/okVecs must be arrays");
	}
	if (okChunks.length !== okVecs.length)
		throw new TypeError("chunks/vecs length mismatch");
	if (!Number.isInteger(rowPer) || rowPer < 1) {
		throw new TypeError("rowPer must be a positive integer");
	}
	const merged = mergeChunkTranscripts(
		(videos.get(filename) as any[]) || [],
		okChunks as any[],
		rows.length,
		rowPer,
	);
	const nextVideos = new Map(videos as Map<string, TranscriptRecord[]>);
	nextVideos.set(filename, merged);
	return {
		videos: nextVideos,
		rows: (rows as Float32Array[]).concat(
			(okVecs as unknown[]).map(
				(v) => new Float32Array(v as ArrayLike<number>),
			),
		),
	};
}

// Repair candidates for the stub-era poisoning (main.ts
// repairUntranscribedWithAudio): video entries recorded with ZERO chunks
// before the whisper engine existed. Empty is ambiguous (silent vs never
// attempted), so the caller probes each candidate for an audio stream and
// drops only those WITH audio — silent films keep their legitimate empty.
// Pure: returns [filename] with zero chunks, in map order.
export function repairCandidates(videos: unknown): string[] {
	if (!(videos instanceof Map)) return [];
	const out: string[] = [];
	for (const [filename, chunks] of videos) {
		if (Array.isArray(chunks) && chunks.length === 0) out.push(filename);
	}
	return out;
}

// Compact a transcript store back to 1:1 rows↔records (self-heal for orphan
// rows / gapped offsets from pre-fix writers): rebuilds rows from records
// in (video, chunk) order and restamps off contiguously. Returns
// { videos, rows, dropped } — dropped is the orphan count (0 = already
// clean; caller skips the save then). Pure; never throws on malformed
// input (bad records are dropped like loadTranscripts does).
export function compactTranscriptStore(videos: unknown, rows: unknown) {
	const inVideos = videos instanceof Map ? videos : new Map();
	const inRows = Array.isArray(rows) ? rows : [];
	const outVideos = new Map<string, TranscriptRecord[]>();
	const outRows: unknown[] = [];
	let off = 0;
	for (const [filename, chunks] of inVideos) {
		if (!Array.isArray(chunks)) {
			outVideos.set(filename, []);
			continue;
		}
		const kept: TranscriptRecord[] = [];
		for (const c of chunks) {
			const row =
				c && Number.isInteger(c.off) && c.off >= 0 && c.off < inRows.length
					? inRows[c.off]
					: null;
			if (
				!row ||
				!Number.isFinite(c.t0) ||
				!Number.isFinite(c.t1) ||
				c.t1 <= c.t0
			)
				continue;
			kept.push({
				t0: c.t0,
				t1: c.t1,
				off: off++,
				n: 1,
				text: String(c.text || ""),
			});
			outRows.push(row);
		}
		outVideos.set(filename, kept);
	}
	return {
		videos: outVideos,
		rows: outRows,
		dropped: inRows.length - outRows.length,
	};
}

export function cosineVec(a: ArrayLike<number>, b: ArrayLike<number>) {
	let dot = 0;
	let na = 0;
	let nb = 0;
	// Casts: dense parallel vectors (the loop-bound read pattern).
	for (let i = 0; i < a.length; i++) {
		dot += (a[i] as number) * (b[i] as number);
		na += (a[i] as number) * (a[i] as number);
		nb += (b[i] as number) * (b[i] as number);
	}
	return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Rank dialogue moments from pre-embedded items — the exact scoring
// main.ts rankTranscriptMoments runs, extracted pure so the full ranking
// (cosine → literal → fuse → boost → gate → caps) is unit-testable with
// REAL tower vectors and no Electron:
//   qVec  — centered query vector (Float32Array)
//   items — [{filename, t0, t1, text, vec}] (vecs centered, same dim)
//   query — raw query text (for literalFraction)
// Returns fuseVisualTextMoments hits (text-only). Throws TypeError on bad
// shapes (never silent wrong answers).
export function rankDialogueMoments({
	qVec,
	items = [],
	segVideos = null,
	minScore = 0.04,
	relativeKeep = 0.6,
	topK = 24,
	query = "",
}: {
	qVec?: ArrayLike<number> | null;
	items?: any[];
	segVideos?: Map<string, any[]> | null;
	minScore?: number;
	relativeKeep?: number;
	topK?: unknown;
	query?: string;
} = {}): FusedMoment[] {
	if (!qVec || typeof qVec.length !== "number" || qVec.length === 0) {
		throw new TypeError("qVec must be a non-empty vector");
	}
	if (!Array.isArray(items)) throw new TypeError("items must be an array");
	const k = Math.max(1, Math.min(96, Number(topK) || 24));
	const textHits: TextHit[] = [];
	for (const it of items) {
		if (
			!it ||
			typeof it.filename !== "string" ||
			!(it.vec && it.vec.length === qVec.length)
		)
			continue;
		if (!Number.isFinite(it.t0) || !Number.isFinite(it.t1) || it.t1 <= it.t0)
			continue;
		if (typeof it.text !== "string" || it.text.trim().length === 0) continue;
		const sc = cosineVec(qVec, it.vec);
		if (sc >= minScore) {
			const mid = (it.t0 + it.t1) / 2;
			textHits.push({
				filename: it.filename,
				t: mid,
				dur: Math.max(0.5, it.t1 - it.t0),
				snippet: it.text.slice(0, 80) || null,
				literal: literalFraction(query, it.text),
				score: sc,
			});
		}
	}
	textHits.sort((a, b) => b.score - a.score);
	if (textHits.length > k * 8) textHits.length = k * 8;
	if (textHits.length === 0) return [];
	return fuseVisualTextMoments({
		visualHits: [],
		textHits,
		segVideos,
		visualTotal: 0,
		textTotal: items.length,
		minScore,
		relativeKeep,
		topK: k,
		wVisual: FUSION_W_VISUAL,
		wText: FUSION_W_TEXT,
		slotSeconds: FUSION_SLOT_SECONDS,
		scenesPerVideo: FUSION_SCENES_PER_VIDEO,
		noiseFraction: FUSION_NOISE_FRACTION,
	});
}

// ---------------------------------------------------------------------------
// Exact dialogue search (v3): literal spoken-word retrieval — no vectors, no
// thresholds, no model. The query's normalized+stemmed tokens must actually
// occur in the transcript; tiers rank phrase > proximity > scattered-AND.
// CJK text tokenizes to overlapping bigrams (shared spec), so the same tier
// logic serves Korean/Japanese/Chinese dialogue. Pure + deterministic;
// main.ts rankTranscriptMoments calls it with utterance lines when present
// (precise seek) else chunk rows (coarse seek).
// ---------------------------------------------------------------------------

// Comparison key for one raw token: NFKD fold → lowercase → stem → trailing-e
// fold (len≥4). The e-fold merges inflection pairs Porter splits
// ("love"/"loving" → "lov") while keeping distinct roots apart
// ("car" vs "carpet" never merge — neither gains/loses a trailing e to meet).
// Returns "" for noise (len<2 after cleaning).
export function dialogueKey(raw: unknown): string {
	const clean = String(raw || "")
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");
	if (clean.length < 2) return "";
	let stem = /^[a-z]+$/.test(clean) ? porterStem(clean) : clean;
	// Porter wart fix: "flies"→"fli" but "flying"/"fly"→"fly", so inflections
	// of the same word land on different keys. Folding a trailing i→y
	// (len≥3) reunites them (fli→fly) and also city/cities, ski/sky.
	if (stem.length >= 3 && stem.endsWith("i")) stem = stem.slice(0, -1) + "y";
	if (stem.length >= 4 && stem.endsWith("e")) return stem.slice(0, -1);
	return stem;
}

export interface DialogueToken {
	raw: string;
	key: string;
	start: number;
	end: number;
}

// Tokenize text into [{raw, key, start, end}] in order (raw offsets into the
// original string for snippet highlighting). Punctuation/diacritics folded by
// dialogueKey; noise tokens dropped.
//
// Two passes, merged by position:
//   1. Latin words via the original regex (dialogueKey normalization).
//   2. CJK runs (Han/Hiragana/Katakana/Hangul) via the shared rune class —
//      spaceless scripts cannot ride word splitting ("멤버들의" is one
//      whitespace token but searchable units are the overlapping bigrams
//      멤버/버들/들의, same rule as rankTokens/cjkBigramsForText in
//      shared/). Keys stay byte-identical to the raw bigram (no stemming).
//      A single-char run stays as-is (a lone 駅/酒 is meaningful) — which
//      also means a single-char CJK QUERY only matches a lone run, exactly
//      like grid search (documented shared-spec behavior, not a bug).
// Offsets are code-unit based (ragel: astral Han chars are 2 units) and
// always satisfy src.slice(start, end) === raw.
export function dialogueTokens(text: unknown): DialogueToken[] {
	const src = String(text || "");
	const out: DialogueToken[] = [];
	const re = /[A-Za-z0-9\u00c0-\u024f]+/g;
	let m;
	while ((m = re.exec(src)) !== null) {
		const key = dialogueKey(m[0]);
		if (key)
			out.push({ raw: m[0], key, start: m.index, end: m.index + m[0].length });
	}
	// CJK pass: code-point iteration keeps code-unit offsets right for
	// astral characters (for..of walks code points, .length code units).
	CJK_RUN_RE.lastIndex = 0;
	let run;
	while ((run = CJK_RUN_RE.exec(src)) !== null) {
		const chars: Array<{ ch: string; at: number }> = [];
		let at = run.index;
		for (const ch of run[0]) {
			chars.push({ ch, at });
			at += ch.length;
		}
		if (chars.length === 1) {
			// Cast: length === 1 checked.
			const only = chars[0] as { ch: string; at: number };
			out.push({
				raw: only.ch,
				key: only.ch,
				start: only.at,
				end: only.at + only.ch.length,
			});
			continue;
		}
		for (let i = 0; i < chars.length - 1; i++) {
			// Casts: i and i+1 < chars.length by the loop bound.
			const a = chars[i] as { ch: string; at: number };
			const b = chars[i + 1] as { ch: string; at: number };
			out.push({
				raw: a.ch + b.ch,
				key: a.ch + b.ch,
				start: a.at,
				end: b.at + b.ch.length,
			});
		}
	}
	// Latin and CJK rune classes are disjoint, so equal starts cannot
	// happen; the sort is a positional merge for snippetAround's scan.
	out.sort((a, b) => a.start - b.start || a.end - b.end);
	return out;
}

// Compact Porter stemmer (steps 1a–5, deterministic, ASCII a-z only).
// Vendored (~no dep) so index-time and query-time stemming are byte-identical.
export function porterStem(w: string): string {
	if (w.length < 3) return w;
	// Casts: single-char string indexes — the bounds are checked by the
	// callers (or the char class test is the guard).
	const isCons = (s: string, i: number): boolean => {
		const c = s[i] as string;
		if ("aeiou".includes(c)) return false;
		if (c === "y") return i === 0 ? true : !isCons(s, i - 1);
		return true;
	};
	const measure = (s: string) => {
		let m = 0;
		let i = 0;
		while (i < s.length && isCons(s, i)) i++;
		while (i < s.length) {
			while (i < s.length && !isCons(s, i)) i++;
			if (i >= s.length) break;
			m++;
			while (i < s.length && isCons(s, i)) i++;
		}
		return m;
	};
	const hasVowel = (s: string) => [...s].some((_, i) => !isCons(s, i));
	const endsDouble = (s: string) =>
		s.length >= 2 &&
		s[s.length - 1] === s[s.length - 2] &&
		isCons(s, s.length - 1);
	const cvc = (s: string) =>
		s.length >= 3 &&
		isCons(s, s.length - 3) &&
		!isCons(s, s.length - 2) &&
		isCons(s, s.length - 1) &&
		!"wxy".includes(s[s.length - 1] as string);
	let s = w;
	// Step 1a
	if (s.endsWith("sses")) s = s.slice(0, -2);
	else if (s.endsWith("ies")) s = s.slice(0, -2);
	else if (s.endsWith("ss")) {
		/* keep */
	} else if (s.endsWith("s")) s = s.slice(0, -1);
	// Step 1b
	let flag1b = false;
	if (s.endsWith("eed")) {
		if (measure(s.slice(0, -3)) > 0) s = s.slice(0, -1);
	} else if (s.endsWith("ed") && hasVowel(s.slice(0, -2))) {
		s = s.slice(0, -2);
		flag1b = true;
	} else if (s.endsWith("ing") && hasVowel(s.slice(0, -3))) {
		s = s.slice(0, -3);
		flag1b = true;
	}
	if (flag1b) {
		if (s.endsWith("at") || s.endsWith("bl") || s.endsWith("iz")) s += "e";
		else if (endsDouble(s) && !"lsz".includes(s[s.length - 1] as string))
			s = s.slice(0, -1);
		else if (measure(s) === 1 && cvc(s)) s += "e";
	}
	// Step 1c
	if (s.endsWith("y") && hasVowel(s.slice(0, -1))) s = s.slice(0, -1) + "i";
	// Step 2
	const step2: Record<string, string> = {
		ational: "ate",
		tional: "tion",
		enci: "ence",
		anci: "ance",
		izer: "ize",
		bli: "ble",
		alli: "al",
		entli: "ent",
		eli: "e",
		ousli: "ous",
		ization: "ize",
		ation: "ate",
		ator: "ate",
		alism: "al",
		iveness: "ive",
		fulness: "ful",
		ousness: "ous",
		aliti: "al",
		iviti: "ive",
		biliti: "ble",
		logi: "log",
	};
	for (const [suf, rep] of Object.entries(step2)) {
		if (s.endsWith(suf) && measure(s.slice(0, -suf.length)) > 0) {
			s = s.slice(0, -suf.length) + rep;
			break;
		}
	}
	// Step 3
	const step3: Record<string, string> = {
		icate: "ic",
		ative: "",
		alize: "al",
		iciti: "ic",
		ical: "ic",
		ful: "",
		ness: "",
	};
	for (const [suf, rep] of Object.entries(step3)) {
		if (s.endsWith(suf) && measure(s.slice(0, -suf.length)) > 0) {
			s = s.slice(0, -suf.length) + rep;
			break;
		}
	}
	// Step 4
	for (const suf of [
		"al",
		"ance",
		"ence",
		"er",
		"ic",
		"able",
		"ible",
		"ant",
		"ement",
		"ment",
		"ent",
		"ion",
		"ou",
		"ism",
		"ate",
		"iti",
		"ous",
		"ive",
		"ize",
	]) {
		if (!s.endsWith(suf)) continue;
		const base = s.slice(0, -suf.length);
		if (measure(base) <= 1) continue;
		if (suf === "ion" && !"st".includes(base[base.length - 1] as string))
			continue;
		s = base;
		break;
	}
	// Step 5a/5b
	if (s.endsWith("e")) {
		const base = s.slice(0, -1);
		const m = measure(base);
		if (m > 1 || (m === 1 && !cvc(base))) s = base;
	}
	if (endsDouble(s) && s.endsWith("l") && measure(s) > 1) s = s.slice(0, -1);
	return s;
}

// Nearest visual-segment poster for a speech moment (pure view concern —
// ranking unaffected). segVideos: Map(filename → [{t, poster}]).
export function backfillPoster(
	segVideos: unknown,
	filename: unknown,
	t: unknown,
): number {
	if (
		!(segVideos instanceof Map) ||
		typeof filename !== "string" ||
		!Number.isFinite(t)
	)
		return 0;
	const segs = segVideos.get(filename);
	if (!segs || segs.length === 0) return 0;
	// Cast: segs is non-empty here.
	let best = segs[0] as { t: unknown; poster: unknown };
	let bestD = Number.isFinite(best.t)
		? Math.abs((best.t as number) - (t as number))
		: Infinity;
	for (const sg of segs) {
		if (!Number.isFinite(sg.t)) continue;
		const d = Math.abs((sg.t as number) - (t as number));
		if (d < bestD) {
			bestD = d;
			best = sg;
		}
	}
	return Number.isFinite(best.poster) ? Number(best.poster) : 0;
}

export const EXACT_TIER_LABELS: Record<number, string> = {
	1: "Exact line",
	2: "Exact words",
	3: "Words spoken",
};

interface ExactDoc {
	t0: number;
	t1: number;
	text: string;
	toks: DialogueToken[];
	keys: string[];
}

interface ExactHit {
	filename: string;
	tier: number;
	docs: ExactDoc[];
	spanT0: number;
	spanT1: number;
	occ: number;
}

export interface ExactMoment {
	filename: string;
	score: number;
	t: number;
	dur: number;
	poster: number;
	why: string;
	tier: number;
	tierLabel: string | undefined;
	snippet: string;
	matchStart: number;
	matchLen: number;
}

// Exact dialogue search over pre-tokenized docs.
//   query — raw query text (normalized + stemmed here, same keys as docs)
//   docs  — [{filename, t0, t1, text}] (utterance lines preferred; chunks fallback)
//   segVideos — Map for poster backfill (null = poster 0)
//   topK / perVideo — caps (default 24 / 3, perVideo mirrors FUSION_SCENES_PER_VIDEO)
//   preRollSec — seek lands t0 − preRoll (clamped ≥ 0; default 3)
//   proximitySec — bag-of-words window for tier 2 (default 8)
//   snippetRadius — chars around first match (default 60)
// Tiers: 1 = contiguous key-phrase in one doc; 2 = all keys in one doc or a
// ≤proximitySec same-film window; 3 = all keys in one doc wider than the
// window (chunk fallback). 1–2 word queries require full containment (no
// fractional hits). Empty query or zero tiers → []. Throws TypeError when
// docs is not an array (never silent wrong answers).
export function exactDialogueSearch({
	query = "",
	docs = [],
	segVideos = null,
	topK = 24,
	perVideo = 3,
	preRollSec = 3,
	proximitySec = 8,
	snippetRadius = 60,
}: {
	query?: string;
	docs?: any[];
	segVideos?: Map<string, any[]> | null;
	topK?: unknown;
	perVideo?: unknown;
	preRollSec?: unknown;
	proximitySec?: unknown;
	snippetRadius?: unknown;
} = {}): ExactMoment[] {
	if (!Array.isArray(docs)) throw new TypeError("docs must be an array");
	const qKeys = dialogueTokens(query).map((t) => t.key);
	if (qKeys.length === 0) return [];
	const qSet = new Set(qKeys);
	const k = Math.max(1, Math.min(96, Number(topK) || 24));
	const perVid = Math.max(1, Math.min(24, Number(perVideo) || 3));
	const preRoll = Math.max(0, Number(preRollSec) || 0);
	const windowSec = Math.max(1, Number(proximitySec) || 8);
	const radius = Math.max(8, Number(snippetRadius) || 60);
	// Group valid docs per film, time-sorted, pre-tokenized once.
	const byFilm = new Map<string, ExactDoc[]>();
	for (const d of docs) {
		if (!d || typeof d.filename !== "string") continue;
		if (!Number.isFinite(d.t0) || !Number.isFinite(d.t1) || d.t1 <= d.t0)
			continue;
		if (typeof d.text !== "string" || d.text.trim().length === 0) continue;
		const toks = dialogueTokens(d.text);
		if (toks.length === 0) continue;
		let filmDocs = byFilm.get(d.filename);
		if (!filmDocs) {
			filmDocs = [];
			byFilm.set(d.filename, filmDocs);
		}
		filmDocs.push({
			t0: d.t0,
			t1: d.t1,
			text: d.text,
			toks,
			keys: toks.map((t) => t.key),
		});
	}
	for (const list of byFilm.values())
		list.sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
	const containsAll = (keySet: Set<string>) =>
		qKeys.every((qk) => keySet.has(qk));
	const hits: ExactHit[] = [];
	const phraseLen = qKeys.length;
	for (const [filename, list] of byFilm) {
		const keySets = list.map((d) => new Set(d.keys));
		// Tier 1: contiguous key-phrase inside one doc.
		const phraseDocs = new Set<string>();
		for (let i = 0; i < list.length; i++) {
			// Casts: i indexes list inside its bounds check (loop-bound read).
			const keys = (list[i] as ExactDoc).keys;
			let at = -1;
			for (let s = 0; s + phraseLen <= keys.length; s++) {
				let ok = true;
				for (let p = 0; p < phraseLen; p++) {
					if (keys[s + p] !== qKeys[p]) {
						ok = false;
						break;
					}
				}
				if (ok) {
					at = s;
					break;
				}
			}
			if (at < 0) continue;
			// Cast: i indexes list inside its bounds check.
			const doc = list[i] as ExactDoc;
			phraseDocs.add(`${doc.t0}:${doc.t1}`);
			hits.push(
				makeExactHit({
					filename,
					tier: 1,
					docs: [doc],
					spanT0: doc.t0,
					spanT1: doc.t1,
					occ: phraseLen,
				}),
			);
		}
		// Tier 2/3: sliding minimal windows over consecutive docs. A single
		// doc that already scored tier 1 is subsumed (same evidence, better
		// tier) — only cross-doc windows add anything there.
		for (let i = 0; i < list.length; i++) {
			// Casts: i/j index list inside their bounds checks (the loop-bound
			// read pattern).
			const docI = list[i] as ExactDoc;
			const union = new Set<string>();
			for (let j = i; j < list.length; j++) {
				const docJ = list[j] as ExactDoc;
				if (docJ.t0 - docI.t0 > windowSec && j > i) break;
				// Cast: j indexes keySets (built from list) inside its bounds.
				for (const kk of keySets[j] as Set<string>) union.add(kk);
				if (!containsAll(union)) continue;
				if (j === i && phraseDocs.has(`${docI.t0}:${docI.t1}`)) break;
				const span = docJ.t1 - docI.t0;
				const single = j === i;
				const tier = single && span > windowSec ? 3 : 2;
				let occ = 0;
				for (let m = i; m <= j; m++)
					for (const kk of (list[m] as ExactDoc).keys) if (qSet.has(kk)) occ++;
				hits.push(
					makeExactHit({
						filename,
						tier,
						docs: list.slice(i, j + 1),
						spanT0: docI.t0,
						spanT1: docJ.t1,
						occ,
					}),
				);
				break; // minimal window for this start
			}
		}
	}
	if (hits.length === 0) return [];
	// Deterministic order: tier, occurrences desc, span asc, time asc, name asc.
	hits.sort(
		(a, b) =>
			a.tier - b.tier ||
			b.occ - a.occ ||
			a.spanT1 - a.spanT0 - (b.spanT1 - b.spanT0) ||
			a.spanT0 - b.spanT0 ||
			(a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0),
	);
	// Dedupe identical (film, tier, anchor second) — overlapping windows can
	// re-anchor the same line.
	const seen = new Set<string>();
	const out: ExactMoment[] = [];
	const perVideoCount = new Map<string, number>();
	for (const h of hits) {
		const anchorSec = Math.floor(h.spanT0);
		const dkey = `${h.filename}::${h.tier}::${anchorSec}`;
		if (seen.has(dkey)) continue;
		seen.add(dkey);
		const n = perVideoCount.get(h.filename) ?? 0;
		if (n >= perVid) continue;
		perVideoCount.set(h.filename, n + 1);
		// Cast: docs is non-empty by construction (one entry per hit).
		const anchor = h.docs[0] as ExactDoc;
		const t = Math.max(0, anchor.t0 - preRoll);
		const dur = Math.max(0.5, h.spanT1 - h.spanT0);
		const snip = snippetAround(anchor.text, anchor.toks, qSet, radius);
		out.push({
			filename: h.filename,
			score:
				4 -
				h.tier +
				Math.min(h.occ, 8) * 0.01 -
				Math.min(h.spanT1 - h.spanT0, 300) * 0.0005,
			t,
			dur,
			poster: backfillPoster(segVideos, h.filename, (h.spanT0 + h.spanT1) / 2),
			why: "text",
			tier: h.tier,
			tierLabel: EXACT_TIER_LABELS[h.tier],
			snippet: snip.text,
			matchStart: snip.start,
			matchLen: snip.len,
		});
		if (out.length >= k) break;
	}
	out.sort((a, b) => b.score - a.score);
	return out;

	function makeExactHit(h: ExactHit): ExactHit {
		return h;
	}
}

// Snippet around the first query-key occurrence in one doc's text:
// ±radius chars with … ellipsis; matchStart/matchLen locate the hit for UI
// highlight (0/0 when nothing found — never happens for real hits).
function snippetAround(
	text: unknown,
	toks: DialogueToken[],
	qSet: Set<string>,
	radius: number,
): { text: string; start: number; len: number } {
	const src = String(text || "");
	let hit: DialogueToken | null = null;
	for (const t of toks) {
		if (qSet.has(t.key)) {
			hit = t;
			break;
		}
	}
	if (!hit) return { text: src.slice(0, radius * 2), start: 0, len: 0 };
	// Extend the highlight span across adjacent matching tokens so a
	// multi-bigram CJK word ("멤버들의" → 멤버/버들/들의) underlines as one
	// word, not one bigram. CJK bigrams OVERLAP (버들 starts inside 멤버),
	// so continuation means "touches the covered span and pushes it
	// forward"; a gap (punctuation/space) or a non-matching key stops it.
	const at = toks.indexOf(hit);
	const h = hit;
	let lo = h.start;
	let hi = h.end;
	for (let j = at - 1; j >= 0; j--) {
		// Cast: j indexes toks inside its bounds check.
		const p = toks[j] as DialogueToken;
		if (!qSet.has(p.key) || p.end < lo || p.start >= lo) break;
		lo = p.start;
	}
	for (let j = at + 1; j < toks.length; j++) {
		// Cast: j indexes toks inside its bounds check.
		const n = toks[j] as DialogueToken;
		if (!qSet.has(n.key) || n.start > hi || n.end <= hi) break;
		hi = n.end;
	}
	const from = Math.max(0, lo - radius);
	const to = Math.min(src.length, hi + radius);
	let snippet = src.slice(from, to);
	if (from > 0) snippet = "…" + snippet;
	if (to < src.length) snippet = snippet + "…";
	return {
		text: snippet,
		start: lo - from + (from > 0 ? 1 : 0),
		len: hi - lo,
	};
}

// Backfill planner: which library videos need (re)transcription and from
// which slice offset. Pure (main maps filenames to {filename, path, off}):
//   filenames — library videos in order
//   videos    — sidecar Map(filename → chunks[])
//   progress  — sidecar progress map {filename: {done, total, skipped?}}
// Missing entries → off 0. Entries with progress done<total (crash or
// drop mid-film) → resume at done. Complete entries (chunks present, no
// partial progress) → skipped. Previously-stalled slice indexes ride
// `skipped` (present ONLY when non-empty, so the {filename, off} shape for
// clean entries is byte-identical to before). Never throws.
export function transcribeBackfillList(
	filenames: unknown,
	videos: unknown,
	progress: unknown,
): Array<{ filename: string; off: number; skipped?: number[] }> {
	const names = Array.isArray(filenames) ? filenames : [];
	const vids = videos instanceof Map ? videos : new Map();
	const prog =
		progress && typeof progress === "object"
			? (progress as Record<string, any>)
			: {};
	const out: Array<{ filename: string; off: number; skipped?: number[] }> = [];
	for (const name of names) {
		if (typeof name !== "string" || !name) continue;
		if (!vids.has(name)) {
			out.push({ filename: name, off: 0 });
			continue;
		}
		const p = prog[name];
		if (
			p &&
			Number.isFinite(p.done) &&
			Number.isFinite(p.total) &&
			p.done >= 0 &&
			p.done < p.total
		) {
			const entry: { filename: string; off: number; skipped?: number[] } = {
				filename: name,
				off: Math.floor(p.done),
			};
			const skipped: number[] = Array.isArray(p.skipped)
				? [
						...new Set(
							p.skipped.filter(
								(s: unknown) => Number.isInteger(s) && (s as number) >= 0,
							) as number[],
						),
					].sort((a: number, b: number) => a - b)
				: [];
			if (skipped.length > 0) entry.skipped = skipped;
			out.push(entry);
		}
	}
	return out;
}
