// The transcript row store's pipeline: whisper junk hygiene, ~30 s
// speech-window chunking, worker-reply application, repair-candidate
// planning and store compaction. Pure helpers (no fs/Electron) so the
// contract stays unit-testable without an Electron smoke. Split out of
// transcript-store-utils.ts (2026-10-25); the model registry lives in
// whisper-models.ts, the dialogue rankers in dialogue-rank.ts.

import { TRANSCRIPTS_PER_CHUNK } from "./whisper-models.ts";
import { CJK_RUN_RE } from "../shared/cjk-tokens.ts";

export const TRANSCRIPT_ROW_PER = 1;

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
