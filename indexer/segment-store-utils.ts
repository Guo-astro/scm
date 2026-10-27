// Pure helpers for the scene-segment sidecar store (the enrichment pump).
// The worker (indexer/indexer.js) embeds at most SEGMENTS_PER_CHUNK segments
// per enrich-video call and returns only the slice it embedded THIS call, so
// a multi-chunk video (> SEGMENTS_PER_CHUNK segments — any video longer than
// ~8 min at the Balanced preset) is committed across several calls.
//
// These functions are deliberately free of fs/Electron so the accumulation
// contract can be pinned by a seconds-fast unit test (test/pump-enrichment.test.js)
// instead of a multi-minute electron smoke.

// Each segment is one {t, dur, off, n} row — n is always 1 (one embedding
// per shot midpoint). Kept here so main and the unit test share it.
export const SEGMENT_ROW_PER = 1;

// Each enrich-video call embeds at most this many segments (indexer.js); a
// video with more spans multiple calls. Centralized here so main, the
// worker, and the unit tests share one value (drift between copies of this
// constant would silently change where chunks break).
export const SEGMENTS_PER_CHUNK = 16;

// Never-stall timeouts (long-film fix, shared by the enrichment pump).
// A 16-segment chunk of a 2–3 h film does 16 ffmpeg seeks + 16 CLIP embeds:
// the old flat 180 s IPC timeout fired on a HEALTHY but slow chunk (one
// slow-seek segment alone can take 150 s+), while the worker kept grinding
// the orphaned chunk — the tray froze at e.g. 16/1024 with no further
// progress. The chunk ceiling covers a worst-case-but-alive chunk; the stall
// interval is the longest silence (no enrich-progress heartbeat) tolerated
// before the primary worker is considered wedged and restarted.
export const ENRICH_CHUNK_TIMEOUT_MS = 10 * 60 * 1000;
export const ENRICH_HEARTBEAT_INTERVAL_MS = 15000;
export const ENRICH_STALL_TIMEOUT_MS = 3 * 60 * 1000;
export const ENRICH_MAX_RETRIES = 3;

import { segmentBudgetFor } from "./video-budget.js";
import { ok, err, type Result } from "./result.ts";

// Heuristic detection of sidecars truncated by the pre-fix pumpEnrichment
// (which REPLACED a file's segment list with the last chunk — a long film
// became searchable only in its final minutes). A video is suspected when:
//   - its plan under `budgetOpts` spans multiple chunks (planned > chunkSize),
//     so the replace bug could have applied, AND
//   - fewer segments survived than planned, AND
//   - the survivors cluster in the tail (span < half the estimated duration)
//     — the truncation signature. A legitimately shot-sparse film keeps its
//     segments spread across the whole duration, so it is NOT flagged.
// Pure + deterministic; unit-tested in test/pump-enrichment.test.js and
// exercised end-to-end in the phase-4 smoke. Returns
// [{ filename, planned, actual, duration }].
export function suspectedTruncated(
	videos: Map<string, any[]>,
	budgetOpts: {
		targetSeconds?: number;
		minSegments?: number;
		maxSegments?: number;
	} | null,
	chunkSize = SEGMENTS_PER_CHUNK,
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
	for (const [filename, segments] of videos) {
		if (!Array.isArray(segments) || segments.length === 0) continue;
		let first = segments[0];
		let last = segments[0];
		for (const seg of segments) {
			if (seg.t < first.t) first = seg;
			if (seg.t > last.t) last = seg;
		}
		// Duration estimate from the sidecar alone (no ffmpeg probe needed
		// at startup): the final segment's midpoint + half its span ≈ EOF.
		const duration = last.t + last.dur / 2;
		if (!(duration > 0)) continue;
		const planned = segmentBudgetFor(duration, budgetOpts);
		if (planned <= chunkSize) continue; // single chunk — the bug cannot apply
		if (segments.length >= planned) continue; // full coverage
		if (last.t - first.t < duration * 0.5) {
			flagged.push({ filename, planned, actual: segments.length, duration });
		}
	}
	return flagged;
}

// Turn one reply chunk into sidecar rows stamped with the bin offsets where
// their embedding rows were (or will be) appended, then append them to the
// file's accumulated segment list.
//
//   existing       — the file's segments so far ([] on first chunk)
//   chunkSegments  — reply.segments for THIS call only
//   base           — c.rows.length BEFORE this chunk's rows are pushed
//                    (offsets must land inside the bin)
//   rowPer         — SEGMENT_ROW_PER
//
// Returns a NEW array; the caller owns replacing the file's entry. The
// critical contract this pins: it ACCUMULATES. Replacing the entry with only
// the current chunk used to leave just the last chunk's segments in the
// sidecar, making a long film searchable only in its final minutes.
export function mergeChunkSegments(
	existing: unknown[],
	chunkSegments: unknown[],
	base: number,
	rowPer: number,
): unknown[] {
	const r = mergeChunkSegmentsResult(existing, chunkSegments, base, rowPer);
	if (!r.ok) throw new TypeError(r.error);
	return r.value as unknown[];
}

// Total Result variant (L1 FP): same accumulation, never throws.
// Invalid input -> {ok:false,error} so queue code can drop/log without try/catch.
export function mergeChunkSegmentsResult(
	existing: unknown,
	chunkSegments: unknown,
	base: unknown,
	rowPer: unknown,
): Result<unknown[]> {
	if (!Array.isArray(existing)) {
		return err("existing must be an array");
	}
	if (!Array.isArray(chunkSegments)) {
		return err("chunkSegments must be an array");
	}
	if (!Number.isInteger(base) || (base as number) < 0) {
		return err(
			"base must be a non-negative integer (row count before this chunk)",
		);
	}
	if (!Number.isInteger(rowPer) || (rowPer as number) < 1) {
		return err("rowPer must be a positive integer");
	}

	const records = (chunkSegments as any[]).map((seg: any, i: number) => ({
		t: seg.t,
		dur: seg.dur,
		// Cast: validated as a non-negative integer above.
		off: (base as number) + i,
		n: rowPer,
		poster: seg.poster,
	}));
	return ok([...(existing as unknown[]), ...records]);
}

// Poison-pill parking (2026-09-26 "Embedding scenes" loop fix): a video whose
// every segment skips (undecodable frames, ffmpeg/parse failures) never earns
// a `videos` entry — the all-skipped path advances `off` but commits nothing —
// so backfillEnrichment re-queues it on EVERY launch and EVERY model switch
// and the tray never goes idle. Park it: record an empty entry (same shape as
// the empty-plan path) so backfill treats it covered. Pure predicate so the
// unit test can pin it without Electron: park only on the FINAL chunk
// (`done`) of an `ok` reply that produced zero rows across the whole job
// despite real per-segment attempts (`skippedTotal > 0`), and never clobber
// an existing entry (a re-queued file with prior coverage keeps it).
export function shouldParkEnrichment({
	done,
	ok: okFlag,
	okTotal,
	skippedTotal,
	alreadyCovered,
}: {
	done?: unknown;
	ok?: unknown;
	okTotal?: unknown;
	skippedTotal?: unknown;
	alreadyCovered?: unknown;
}) {
	return (
		Boolean(done) &&
		Boolean(okFlag) &&
		((okTotal as number) || 0) === 0 &&
		((skippedTotal as number) || 0) > 0 &&
		!alreadyCovered
	);
}

// Split one enrich-video reply chunk into its successful rows vs its
// skipped segments. The worker returns parallel arrays (segments[i] ↔
// vecs[i], with vecs[i] === null for a skipped segment) so `fromIndex`
// still advances past failures — one corrupt GOP must not kill a 1024-seg
// film. Returns { okSegments, okVecs, skipped } where skipped counts the
// null-vec / skipped-flag entries. Pure + unit-tested.
export function partitionChunkReply(segments: unknown, vecs: unknown) {
	const segs = Array.isArray(segments) ? segments : [];
	const vs = Array.isArray(vecs) ? vecs : [];
	const okSegments: any[] = [];
	const okVecs: unknown[] = [];
	let skipped = 0;
	for (let i = 0; i < segs.length; i++) {
		const seg = segs[i];
		const vec = i < vs.length ? vs[i] : null;
		if (seg && seg.skipped) {
			skipped++;
			continue;
		}
		if (!Array.isArray(vec) || vec.length === 0) {
			skipped++;
			continue;
		}
		okSegments.push(seg);
		okVecs.push(vec);
	}
	return { okSegments, okVecs, skipped };
}
