// Phase 2 (store/sidecars): pure move from main-lib/library-store.js —
// segment + transcript sidecars (load/save/drop/compact/remove/repair).
// Paths + index reads ride the index-core namespace; bin rows ride bins;
// persistence rides persist; model tables ride the registries directly.
// All sibling access is call-time only (cycle-safe).

import fs from "node:fs";
import path from "node:path";
import * as indexCore from "./index-core.ts";
import * as bins from "./bins.ts";
import * as persist from "./persist.ts";
import { MODELS } from "../../indexer/models.ts";
import {
	parseWhisperModel,
	DEFAULT_WHISPER_MODEL,
} from "../../indexer/whisper-models.js";
import {
	repairCandidates,
	compactTranscriptStore,
} from "../../indexer/transcript-chunks.js";

export interface SegmentCache {
	modelId: string | null;
	dim: number;
	loaded: boolean;
	videos: Map<string, any[]>;
	rows: Float32Array[];
}

let segmentCache: SegmentCache = {
	modelId: null,
	dim: 0,
	loaded: false,
	videos: new Map(),
	rows: [],
};

export function loadSegments(modelId: string): SegmentCache {
	if (segmentCache.modelId === modelId && segmentCache.loaded)
		return segmentCache;
	const fresh: SegmentCache = {
		modelId,
		dim: 0,
		loaded: false,
		videos: new Map(),
		rows: [],
	};
	try {
		const parsed = JSON.parse(
			fs.readFileSync(indexCore.segmentsMetaFileFor(modelId), "utf8"),
		);
		const bin = fs.readFileSync(indexCore.segmentsBinFileFor(modelId));
		const header = new Int32Array(bin.buffer, bin.byteOffset, 2);
		// Bounds-proven reads: the 2-int construction throws on a short
		// buffer, so both slots are always present.
		const hCount = header[0] as number;
		const hDim = header[1] as number;
		// The bin header is the ground truth: sidecars written before the
		// dim was persisted (a Phase-1 bug) carry meta.dim = 0 — adopt the
		// bin's declared dim so old data loads instead of being orphaned.
		const dim = Number(parsed.dim) || hDim || 0;
		if (dim > 0 && hCount === (parsed.total || 0) && hDim === dim) {
			fresh.dim = dim;
			for (const v of parsed.videos || []) {
				// A corrupt/partial sidecar must not serve out-of-bounds rows:
				// drop segments whose offsets don't land inside the bin.
				const segments = (v.segments || []).filter(
					(s: any) =>
						Number.isFinite(s.off) &&
						s.off >= 0 &&
						s.off < hCount &&
						Number.isFinite(s.t),
				);
				fresh.videos.set(v.filename, segments);
			}
			fresh.rows = bins.readBin(
				indexCore.segmentsBinFileFor(modelId),
				hCount,
				dim,
			);
			fresh.loaded = true;
		}
	} catch {
		/* no segments for this model yet */
	}
	segmentCache = fresh;
	return segmentCache;
}

export function saveSegments(): Promise<void> | undefined {
	const c = segmentCache;
	if (!c.loaded) return;
	const meta = {
		version: 1,
		modelId: c.modelId,
		dim: c.dim,
		total: c.rows.length,
		videos: [...c.videos.entries()].map(([filename, segments]) => ({
			filename,
			segments,
		})),
	};
	fs.mkdirSync(indexCore.DATA_DIR, { recursive: true });
	// Bounds-proven casts: !c.loaded returned above, and a loaded cache
	// always carries the modelId it was loaded for.
	const binFile = indexCore.segmentsBinFileFor(c.modelId as string);
	const metaFile = indexCore.segmentsMetaFileFor(c.modelId as string);
	const binBuf = bins.encodeBin(c.rows, c.dim);
	// The row space changed under this key — drop the memoized payload so
	// the next fetch re-encodes the fresh rows.
	segmentsBinCache = { key: null, buf: null };
	// Atomic + off the main thread, like the library bins (M-04). Bin
	// first, meta last so a crash can't leave a meta pointing at a
	// half-written bin.
	return persist.enqueuePersist(async () => {
		await persist.writeFileAtomic(binFile, binBuf);
		await persist.writeFileAtomic(metaFile, JSON.stringify(meta));
	});
}

// Compact the row space after a library row is deleted so the meta totals
// stay 1:1 with the bin. Segment data is small (KB–MB), so a rebuild is cheap.
// Resolves the ACTIVE model's cache first: the cache may be unloaded (delete
// without any prior scene access) or hold a different model than the library
// (a switch since the last access) — either way the on-disk sidecar for the

function compactSegmentCache(c: SegmentCache, filename: string): void {
	c.videos.delete(filename);
	const keep: Float32Array[] = [];
	for (const segs of c.videos.values()) {
		for (const seg of segs) keep.push(c.rows[seg.off] as Float32Array);
	}
	c.rows = keep;
	let off = 0;
	for (const segs of c.videos.values()) {
		for (const seg of segs) {
			seg.off = off++;
		}
	}
}

export function removeSegmentsFor(filename: string): void {
	const c = loadSegments(indexCore.loadLibrary().modelId);
	if (!c.loaded || !c.videos.has(filename)) return;
	compactSegmentCache(c, filename);
	saveSegments();
}

// Delete/purge must clean EVERY model's sidecar: a film enriched under
// model A then deleted after a switch to B would otherwise leave dead
// rows in A's sidecar forever (pruneOrphanSidecars only fires for
// rowless names, which never triggers for valid-row purges). The cache
// holds one model at a time, so the ACTIVE model's live object is held
// across the loop: re-loading it from disk afterwards could resurrect
// just-deleted entries when the compaction save hasn't drained yet
// (saves persist asynchronously), and evicting it first would compact a
// stale disk copy. Object identity keeps live truth either way; the
// global is pointed back at it at the end so later callers see the model

export function removeSegmentsForAllModels(filename: string): void {
	const live = loadSegments(indexCore.loadLibrary().modelId);
	const liveHad = live.loaded && live.videos.has(filename);
	if (liveHad) compactSegmentCache(live, filename);
	for (const modelId of Object.keys(MODELS)) {
		if (modelId === live.modelId) continue;
		const c = loadSegments(modelId);
		if (!c.loaded || !c.videos.has(filename)) continue;
		compactSegmentCache(c, filename);
		saveSegments();
	}
	segmentCache = live;
	if (liveHad) saveSegments();
}

let segmentsBinCache: { key: string | null; buf: Buffer | null } = {
	key: null,
	buf: null,
};

export function cachedSegmentsBin(): {
	key: string | null;
	buf: Buffer | null;
} {
	const c = loadSegments(indexCore.loadLibrary().modelId);
	const key = `${c.modelId}|${c.rows.length}|${c.dim}`;
	if (segmentsBinCache.key !== key) {
		segmentsBinCache = {
			key,
			buf: c.loaded ? bins.encodeBin(c.rows, c.dim) : null,
		};
	}
	return segmentsBinCache;
}

let transcriptsBinCache: { key: string | null; buf: Buffer | null } = {
	key: null,
	buf: null,
};

export function cachedTranscriptsBin(): {
	key: string | null;
	buf: Buffer | null;
} {
	const c = loadTranscripts(indexCore.loadLibrary().modelId);
	const key = `${c.modelId}|${c.rows.length}|${c.dim}`;
	if (transcriptsBinCache.key !== key) {
		transcriptsBinCache = {
			key,
			buf: c.loaded ? bins.encodeBin(c.rows, c.dim) : null,
		};
	}
	return transcriptsBinCache;
}

// Writes one model's bin pair (the active model for saveLibrary; a target
// model mid-migration via writeBins). Null rows persist as zero vectors so
// the 1:1 alignment with filenames never drifts. opts.filenames (required
// for non-active targets) snapshots the row identity the vectors align to;
// opts.incomplete marks a partial fill so a crash resumes instead of
// serving zeros as final. The meta rides the same persist step as the bins

export interface TranscriptCache {
	modelId: string | null;
	dim: number;
	loaded: boolean;
	videos: Map<string, any[]>;
	rows: Float32Array[];
	version: number;
	progress: Record<string, any>;
	whisperModel: string;
	utterances: Map<string, any[]>;
}

let transcriptCache: TranscriptCache = {
	modelId: null,
	dim: 0,
	loaded: false,
	videos: new Map(),
	rows: [],
	version: 1,
	progress: {},
	whisperModel: DEFAULT_WHISPER_MODEL,
	utterances: new Map(),
};

export function loadTranscripts(modelId: string): TranscriptCache {
	if (transcriptCache.modelId === modelId && transcriptCache.loaded)
		return transcriptCache;
	const fresh: TranscriptCache = {
		modelId,
		dim: 0,
		loaded: false,
		videos: new Map(),
		rows: [],
		version: 1,
		progress: {},
		whisperModel: DEFAULT_WHISPER_MODEL,
		utterances: new Map(),
	};
	try {
		const parsed = JSON.parse(
			fs.readFileSync(indexCore.transcriptsMetaFileFor(modelId), "utf8"),
		);
		const bin = fs.readFileSync(indexCore.transcriptsBinFileFor(modelId));
		const header = new Int32Array(bin.buffer, bin.byteOffset, 2);
		// Bounds-proven reads: the 2-int construction throws on a short
		// buffer, so both slots are always present.
		const hCount = header[0] as number;
		const hDim = header[1] as number;
		const dim = Number(parsed.dim) || hDim || 0;
		if (dim > 0 && hCount === (parsed.total || 0) && hDim === dim) {
			fresh.dim = dim;
			fresh.version = Number(parsed.version) || 1;
			// Pre-stamp sidecars were all tiny.en (the only engine shipped).
			fresh.whisperModel = parseWhisperModel(parsed.whisperModel || "tiny.en");
			for (const v of parsed.videos || []) {
				const chunks = (v.chunks || []).filter(
					(c: any) =>
						Number.isFinite(c.off) &&
						c.off >= 0 &&
						c.off < hCount &&
						Number.isFinite(c.t0) &&
						Number.isFinite(c.t1) &&
						c.t1 > c.t0,
				);
				fresh.videos.set(v.filename, chunks);
				// Utterance-level full-text rows (exact-search index, v3+).
				// Validated like chunks minus offsets (no bin rows behind them).
				const lines = Array.isArray(v.utterances)
					? v.utterances
							.filter(
								(u: any) =>
									u &&
									Number.isFinite(u.t0) &&
									Number.isFinite(u.t1) &&
									u.t1 > u.t0 &&
									typeof u.text === "string" &&
									u.text.trim().length > 0,
							)
							.map((u: any) => ({ t0: u.t0, t1: u.t1, text: String(u.text) }))
					: [];
				if (lines.length > 0) fresh.utterances.set(v.filename, lines);
			}
			fresh.rows = bins.readBin(
				indexCore.transcriptsBinFileFor(modelId),
				hCount,
				dim,
			);
			fresh.progress =
				parsed.progress && typeof parsed.progress === "object"
					? parsed.progress
					: {};
			fresh.loaded = true;
		}
	} catch {
		/* no transcripts for this model yet */
	}
	transcriptCache = fresh;
	if (fresh.loaded) {
		// Self-heal pre-fix orphan rows / gapped offsets (compact + restamp,
		// persist once). Records stay untouched — only unreachable rows go.
		const compacted = compactTranscriptStore(fresh.videos, fresh.rows);
		if (compacted.dropped !== 0) {
			console.warn(
				`[memories] transcript sidecar inconsistent (${compacted.dropped} orphan rows) — compacted`,
			);
			fresh.videos = compacted.videos as typeof fresh.videos;
			fresh.rows = compacted.rows as typeof fresh.rows;
			saveTranscripts();
		}
	}
	return transcriptCache;
}

export function saveTranscripts(): Promise<void> | undefined {
	const c = transcriptCache;
	if (!c.loaded) return;
	if (!c.version || c.version < 2) c.version = 2;
	if (!c.progress || typeof c.progress !== "object") c.progress = {};
	if (!(c.utterances instanceof Map)) c.utterances = new Map();
	const meta = {
		version: c.version,
		modelId: c.modelId,
		whisperModel: parseWhisperModel(c.whisperModel),
		dim: c.dim,
		total: c.rows.length,
		videos: [...c.videos.entries()].map(([filename, chunks]) => ({
			filename,
			chunks,
			...(c.utterances.get(filename)?.length
				? { utterances: c.utterances.get(filename) }
				: {}),
		})),
		progress: c.progress,
	};
	fs.mkdirSync(indexCore.DATA_DIR, { recursive: true });
	// Bounds-proven casts: !c.loaded returned above, and a loaded cache
	// always carries the modelId it was loaded for.
	const binFile = indexCore.transcriptsBinFileFor(c.modelId as string);
	const metaFile = indexCore.transcriptsMetaFileFor(c.modelId as string);
	const binBuf = bins.encodeBin(c.rows, c.dim);
	transcriptsBinCache = { key: null, buf: null };
	return persist.enqueuePersist(async () => {
		await persist.writeFileAtomic(binFile, binBuf);
		await persist.writeFileAtomic(metaFile, JSON.stringify(meta));
	});
}

// Drop a film's whole speech index (chunks + utterance lines + progress).
// Used on library removal AND on whisper-model switch (per-film reset would

function dropTranscriptEntries(c: TranscriptCache, filename: string): void {
	c.videos.delete(filename);
	if (c.utterances instanceof Map) c.utterances.delete(filename);
	if (c.progress && typeof c.progress === "object") delete c.progress[filename];
}

export function resetTranscriptsFor(filename: string): void {
	const c = loadTranscripts(indexCore.loadLibrary().modelId);
	if (!c.loaded) return;
	dropTranscriptEntries(c, filename);
}

function compactTranscriptCache(c: TranscriptCache, filename: string): void {
	dropTranscriptEntries(c, filename);
	const keep: Float32Array[] = [];
	for (const chunks of c.videos.values()) {
		for (const ch of chunks) keep.push(c.rows[ch.off] as Float32Array);
	}
	c.rows = keep;
	let off = 0;
	for (const chunks of c.videos.values()) {
		for (const ch of chunks) {
			ch.off = off++;
		}
	}
}

export function removeTranscriptsFor(filename: string): void {
	const c = loadTranscripts(indexCore.loadLibrary().modelId);
	if (!c.loaded || !c.videos.has(filename)) return;
	compactTranscriptCache(c, filename);
	saveTranscripts();
}

// All-models twin of removeSegmentsForAllModels (same leak, same fix —

export function removeTranscriptsForAllModels(filename: string): void {
	const live = loadTranscripts(indexCore.loadLibrary().modelId);
	const liveHad = live.loaded && live.videos.has(filename);
	if (liveHad) compactTranscriptCache(live, filename);
	for (const modelId of Object.keys(MODELS)) {
		if (modelId === live.modelId) continue;
		const c = loadTranscripts(modelId);
		if (!c.loaded || !c.videos.has(filename)) continue;
		compactTranscriptCache(c, filename);
		saveTranscripts();
	}
	transcriptCache = live;
	if (liveHad) saveTranscripts();
}

// One-time repair for stub-era poisoning: before the whisper engine existed,
// every video was recorded with ZERO chunks — indistinguishable from a truly
// silent film, so the launch backfill skips them forever ("covered"). Empty
// is only legitimate without an audio stream, so probe each empty entry and
// drop the ones WITH audio; the backfill then re-queues them for real
// transcription. Silent films keep their empty (never retried). Runs once

export async function repairUntranscribedWithAudio(): Promise<number> {
	const l = indexCore.loadLibrary();
	if (!l || !Array.isArray(l.filenames)) return 0;
	const c = loadTranscripts(l.modelId);
	if (!c.loaded || (c.version || 1) >= 2) return 0;
	const candidates = repairCandidates(c.videos);
	let ffmpeg;
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberately-lazy (cycle break: ffmpeg-process reads the store via main)
		ffmpeg = require("../../indexer/ffmpeg-process.js").resolveFfmpeg();
	} catch {
		ffmpeg = null;
	}
	let repaired = 0;
	if (ffmpeg && candidates.length > 0) {
		// eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberately-lazy (cycle break: ffmpeg-process reads the store via main)
		const { probeHasAudio } = require("../../indexer/ffmpeg-process.js");
		for (const name of candidates) {
			let hasAudio;
			try {
				hasAudio = await probeHasAudio(
					ffmpeg,
					path.join(indexCore.PHOTOS_DIR, name),
				);
			} catch {
				hasAudio = false;
			}
			if (hasAudio) {
				c.videos.delete(name);
				repaired++;
			}
		}
	}
	c.version = 2;
	saveTranscripts();
	if (repaired > 0) {
		console.log(
			`[memories] transcript repair: ${repaired} video(s) with audio re-queued for transcription`,
		);
	}
	return repaired;
}

// Reset both sidecar caches (called by index-core's resetLibraryCaches;
// same initializers as the verbatim block it replaces).
export function resetSidecarCaches(): void {
	segmentsBinCache = { key: null, buf: null };
	transcriptsBinCache = { key: null, buf: null };
	segmentCache = {
		modelId: null,
		dim: 0,
		loaded: false,
		videos: new Map(),
		rows: [],
	};
	transcriptCache = {
		modelId: null,
		dim: 0,
		loaded: false,
		videos: new Map(),
		rows: [],
		version: 1,
		progress: {},
		whisperModel: DEFAULT_WHISPER_MODEL,
		utterances: new Map(),
	};
}
