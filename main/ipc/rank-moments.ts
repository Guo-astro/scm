// Phase 1 (rank-moments): pure move from main.js (2026-10-10) — rank worker,
// rank/scenes/dialogue/embed-query handlers. No behavior change: same
// scoring, same worker fallback, same query priority flags. Shared refs
// still owned by main.js arrive via main/context.js and are read AT CALL
// TIME: pool (spawnIndexer, getIndexerReady thunk, askIndexer, indexerEnv),
// migration (getMigrationState — shared slot), pump gates (getEnrichQueue /
// isEnrichInFlight thunks, set*PendingQuery setters, broadcastEnrichEvent).
// Everything else is required directly — this module never requires main.js
// (no cycle). will-quit's stopRankWorker is re-exported below.
import { utilityProcess, app } from "electron";
import path from "node:path";
import { handle } from "../ipc-wrapper.ts";
import { errorDetail } from "../../main-lib/ipc-error.ts";
import ctx from "../context.ts";
import {
	loadLibrary,
	libraryNorms,
	thresholdsFor,
	loadSegments,
	loadTranscripts,
	libraryGenerationNumber,
} from "../../main-lib/library-store.ts";
import {
	cosineSim,
	RANK_MIN_SCORE,
	RANK_RELATIVE_KEEP,
	scoreLibrary,
} from "../../main-lib/rank-search.ts";
// NOTE: the FUSION_* constants / fuseVisualTextMoments originally arrived via
// a mid-file require (kept verbatim through the Phase 1 move); the conversion
// folds that require into this top block — dialogue-rank is a pure utils
// leaf, so the earlier load order has no observable effect.
import {
	FUSION_SLOT_SECONDS,
	FUSION_SCENES_PER_VIDEO,
	FUSION_NOISE_FRACTION,
	fuseVisualTextMoments,
	attachQueryVec,
} from "../../indexer/dialogue-rank.js";
import { exactDialogueSearch } from "../../indexer/dialogue-search.js";
import type {
	RankInbound,
	RankOutbound,
} from "../../shared/worker-messages.ts";

// ---------------------------------------------------------------------------
// Search ranking — O(N × dim) cosine scan. Pure scoring lives in
// main-lib/rank-search.js (shared with the rank utilityProcess). The
// renderer's main thread is never blocked by search math: production IPC
// (`memories:rank`) scores in a dedicated utilityProcess; this in-process
// path remains for tests, internal callers, and worker-failure fallback.
// ---------------------------------------------------------------------------

// Rank utilityProcess — owns its own library-store copy (disk-backed,
// generation-synced). Forked on first production rank; CTO/tests keep the
// injected in-process rankSearch and never touch this.
interface RankWorkerHandle {
	process: Electron.UtilityProcess | null;
	dead: boolean;
}
interface RankPendingRequest {
	resolve: (v: unknown[]) => void;
	reject: (e: unknown) => void;
	timer: NodeJS.Timeout;
}

let rankWorker: RankWorkerHandle | null = null;
let rankWorkerDead = false;
const rankPending = new Map<string, RankPendingRequest>();
let rankRequestId = 0;
const RANK_TIMEOUT_MS = 15000;

function ensureRankWorker() {
	if (rankWorker && !rankWorkerDead) return rankWorker;
	rankWorkerDead = false;
	const worker: RankWorkerHandle = { process: null, dead: false };
	worker.process = utilityProcess.fork(
		path.join(__dirname, "..", "..", "main-lib", "rank-worker.js"),
		[],
		{
			env: {
				...ctx.indexerEnv(),
				SCM_USER_DATA_DIR: app.getPath("userData"),
			},
			serviceName: "rank-worker",
		},
	);
	worker.process.on("message", (event) => {
		const msg = (
			event && event.data !== undefined ? event.data : event
		) as RankOutbound;
		if (!msg) return;
		if (msg.type === "rank-ready") return;
		if (!msg.id) return;
		const req = rankPending.get(msg.id);
		if (!req) return;
		rankPending.delete(msg.id);
		clearTimeout(req.timer);
		if (msg.ok) req.resolve(msg.results);
		else req.reject(new Error(msg.error || "Rank failed"));
	});
	// Electron passes `code` only (utilityProcess); the signal branch is kept
	// so the label expression matches the pre-conversion behavior exactly.
	worker.process.on(
		"exit",
		(code: number | null | undefined, signal?: string | null) => {
			worker.dead = true;
			rankWorkerDead = true;
			rankWorker = null;
			const label =
				code !== null && code !== undefined
					? `exit ${code}`
					: signal
						? `signal ${signal}`
						: "exit";
			for (const [, req] of rankPending) {
				clearTimeout(req.timer);
				const err = new Error(`Rank worker ${label}`) as Error & {
					code?: string;
				};
				err.code = "RANK_EXIT";
				req.reject(err);
			}
			rankPending.clear();
		},
	);
	rankWorker = worker;
	return worker;
}

function askRankWorker(message: RankInbound) {
	const worker = ensureRankWorker();
	return new Promise<unknown[]>((resolve, reject) => {
		const id = `k${++rankRequestId}`;
		const timer = setTimeout(() => {
			rankPending.delete(id);
			const err = new Error("Rank request timed out") as Error & {
				code?: string;
			};
			err.code = "RANK_TIMEOUT";
			reject(err);
		}, RANK_TIMEOUT_MS);
		rankPending.set(id, { resolve, reject, timer });
		worker.process?.postMessage({
			...message,
			id,
			gen: libraryGenerationNumber(),
		});
	});
}

function stopRankWorker() {
	if (rankWorker && rankWorker.process) {
		try {
			rankWorker.process.postMessage({ type: "shutdown" });
		} catch {
			/* already gone */
		}
		try {
			rankWorker.process.kill();
		} catch {
			/* already gone */
		}
	}
	rankWorker = null;
	rankWorkerDead = false;
	for (const [, req] of rankPending) {
		clearTimeout(req.timer);
		req.reject(new Error("Rank worker stopped"));
	}
	rankPending.clear();
}

// Embed the query through the indexer (unless a caller supplied qVec).
// Returns Float32Array or null (model down / migration / embed failure).
async function embedRankQuery(trimmed: string, dim: number) {
	try {
		ctx.spawnIndexer();
		await ctx.getIndexerReady();
	} catch {
		return null;
	}
	if (ctx.getMigrationState()) return null;
	try {
		const reply = (await ctx.askIndexer({
			type: "embed-query",
			text: trimmed,
		})) as { vec?: ArrayLike<number> | null };
		if (reply.vec && reply.vec.length === dim) {
			return new Float32Array(reply.vec);
		}
	} catch {
		return null;
	}
	return null;
}

// Score against the in-process library (tests / fallback). qVecOverride
// skips the worker embed so ranking can be exercised without a model.
async function rankSearch(
	queryText: string,
	topK: number,
	qVecOverride?: Float32Array | null,
) {
	const trimmed = (queryText || "").trim();
	if (!trimmed) return [];
	const l = loadLibrary();
	if (!l.filenames.length || !l.embeddings.length) return [];
	if (l.embeddings.length !== l.filenames.length) return [];

	let qVec = qVecOverride || null;
	if (!qVec) {
		qVec = await embedRankQuery(trimmed, l.dim);
		if (!qVec) return [];
	}
	if (!qVec || qVec.length !== l.dim) return [];

	const thresholds = thresholdsFor(l.modelId) || {};
	// Cast: the empty-library guards above make a null norm set unreachable
	// (libraryNorms only returns null for an empty embedding table) —
	// scoreLibrary indexes norms densely, as rank-worker.js does unchecked.
	const norms = libraryNorms();
	return scoreLibrary(
		l,
		trimmed,
		qVec,
		topK,
		thresholds,
		norms as ArrayLike<number>,
	);
}

// Single-round-trip variant (M-11): the centered query vector rides ALONGSIDE
// the results so scene/transcript fusion never re-embeds. The return is
// ALWAYS an array (backward compatible with every existing consumer: perf
// battery, search-matrix diagnostics, older renderers) with an extra
// `queryVec` property attached (a JSON-safe Array, or null when ranking fell
// back / model down). Structured clone preserves own props on arrays, so
// `Array.isArray()` stays true everywhere while new callers read `.queryVec`.
// Production scoring runs in the rank utilityProcess (Phase 0.4); on worker
// failure this falls back to the in-process rankSearch path.
async function rankSearchWithVec(
	queryText: string,
	topK: number,
	qVecOverride?: Float32Array | null,
) {
	const withVec = (results: unknown[], queryVec: number[] | null) =>
		attachQueryVec(results, queryVec);
	const trimmed = (queryText || "").trim();
	if (!trimmed) return withVec([], null);
	const l = loadLibrary();
	if (!l.filenames.length || !l.embeddings.length) return withVec([], null);
	if (l.embeddings.length !== l.filenames.length) return withVec([], null);
	let qVec = qVecOverride || null;
	if (!qVec) {
		qVec = await embedRankQuery(trimmed, l.dim);
		if (!qVec) return withVec([], null);
	}
	if (!qVec || qVec.length !== l.dim) return withVec([], null);

	let results: unknown[];
	try {
		// Off-main O(N×dim) scan: structured-clone the query vector into the
		// rank utilityProcess (embeddings stay put — gen tracks disk reloads).
		results = await askRankWorker({
			type: "rank",
			query: trimmed,
			topK: topK || 96,
			qVec,
		});
	} catch {
		// Worker down / timeout / crash — score in-process so search still works.
		try {
			results = await rankSearch(trimmed, topK || 96, qVec);
		} catch {
			results = [];
		}
	}
	return withVec(results || [], Array.from(qVec));
}

handle(
	"memories:rank",
	async (_event: unknown, query: string, topK?: unknown) => {
		try {
			return await rankSearchWithVec(query, (topK as number) || 96);
		} catch (err) {
			// [] is the deliberate failure shape (an empty grid beats an error
			// modal mid-typing) — but it must not be silent: a corrupt bin and
			// a genuine no-match are indistinguishable in the UI.
			console.error(`[rank] rank failed: ${errorDetail(err)}`);
			return [];
		}
	},
);

// ---------------------------------------------------------------------------
// Moment ranking: Scenes (pure visual) and Dialogue (pure transcript) are
// SEPARATE surfaces sharing one timeline math helper — never fused. Both
// run on main (N-01: off the renderer) against ONE centered query vector
// and return [{filename, score, t, dur, poster, why, snippet}].
//
// Scenes is legacy-exact visual ranking (weight 1.0, no hit caps): the same
// cosine/cutoff/gate/cap-3/topK the renderer used before, so previous
// results are preserved bit-for-bit. Dialogue ranks transcript rows only
// (weight recorded as text evidence, snippet always attached).
// ---------------------------------------------------------------------------

// One centered query embed shared by both moment rankers (null on model
// down / migration / empty query — callers return [] then).
async function embedMomentQuery(
	queryText: string,
	qVecOverride?: Float32Array | null,
) {
	const trimmed = (queryText || "").trim();
	const l = loadLibrary();
	if (!trimmed || !l.filenames.length) return null;
	let qVec = qVecOverride || null;
	if (!qVec) {
		try {
			ctx.spawnIndexer();
			await ctx.getIndexerReady();
		} catch {
			return null;
		}
		if (ctx.getMigrationState()) return null;
		try {
			const reply = (await ctx.askIndexer({
				type: "embed-query",
				text: trimmed,
			})) as { vec?: ArrayLike<number> | null };
			if (reply.vec && reply.vec.length === l.dim)
				qVec = new Float32Array(reply.vec);
		} catch {
			return null;
		}
	}
	if (!qVec || qVec.length !== l.dim) return null;
	return qVec;
}

function momentThresholds() {
	const l = loadLibrary();
	const thresholds = thresholdsFor(l.modelId) || {};
	return {
		minScore: thresholds.minSemanticScore ?? RANK_MIN_SCORE,
		relativeKeep: thresholds.relativeKeep ?? RANK_RELATIVE_KEEP,
	};
}

// Sidecar shapes are structural: the store's SegmentCache/TranscriptCache use
// any[] rows internally (segments are written by the indexer worker), so the
// maps stay any[] here too — consumers below already guard every read.
interface MomentSidecars {
	segVideos: Map<string, any[]>;
	segRows: Float32Array[];
	segDim: number;
	traVideos: Map<string, any[]>;
	traRows: Float32Array[];
	traDim: number;
	traUtterances: Map<string, any[]>;
}

function loadMomentSidecars(): MomentSidecars {
	const l = loadLibrary();
	let seg: ReturnType<typeof loadSegments> | null = null;
	let tra: ReturnType<typeof loadTranscripts> | null = null;
	// Belt-and-braces: both loaders swallow their own IO errors internally;
	// on a throw here the locals simply stay null (the initial value).
	try {
		seg = loadSegments(l.modelId);
	} catch {
		/* keep null */
	}
	try {
		tra = loadTranscripts(l.modelId);
	} catch {
		/* keep null */
	}
	return {
		segVideos: seg && seg.loaded ? seg.videos : new Map<string, any[]>(),
		segRows: seg && seg.loaded ? seg.rows : [],
		segDim: seg && seg.loaded ? seg.dim : 0,
		traVideos: tra && tra.loaded ? tra.videos : new Map<string, any[]>(),
		traRows: tra && tra.loaded ? tra.rows : [],
		traDim: tra && tra.loaded ? tra.dim : 0,
		traUtterances:
			tra && tra.loaded && tra.utterances instanceof Map
				? tra.utterances
				: new Map<string, any[]>(),
	};
}

// Pure-visual scene moments, legacy-exact: raw segment cosines, NO hit caps
// (the old renderer path scored every row), weight 1.0 so cutoff and noise
// gate run in raw cosine space exactly as before.
async function rankVisualScenes(
	queryText: string,
	topK: unknown,
	qVecOverride?: Float32Array | null,
) {
	const k = Math.max(1, Math.min(96, Number(topK) || 24));
	const qVec = await embedMomentQuery(queryText, qVecOverride);
	if (!qVec) return [];
	const { minScore, relativeKeep } = momentThresholds();
	const { segVideos, segRows, segDim } = loadMomentSidecars();
	if (segVideos.size === 0 || segDim !== qVec.length) return [];
	const visualHits: Array<{
		filename: string;
		t: any;
		dur: any;
		poster: any;
		score: number;
	}> = []; // {filename, t, dur, poster, score}
	let visualTotal = 0;
	for (const [filename, segments] of segVideos) {
		for (const s of segments) {
			const row = segRows[s.off as number];
			if (!row || row.length !== segDim) continue;
			visualTotal++;
			const sc = cosineSim(qVec, row);
			if (sc >= minScore) {
				visualHits.push({
					filename,
					t: s.t,
					dur: s.dur,
					poster: s.poster,
					score: sc,
				});
			}
		}
	}
	visualHits.sort((a, b) => b.score - a.score);
	if (visualHits.length === 0) return [];
	return fuseVisualTextMoments({
		visualHits,
		textHits: [],
		segVideos,
		visualTotal,
		textTotal: 0,
		minScore,
		relativeKeep,
		topK: k,
		wVisual: 1,
		wText: 0,
		slotSeconds: FUSION_SLOT_SECONDS,
		scenesPerVideo: FUSION_SCENES_PER_VIDEO,
		noiseFraction: FUSION_NOISE_FRACTION,
	});
}

// Exact dialogue moments (v3): literal spoken-word retrieval — no vectors,
// no thresholds, no model (works with CLIP down or mid-migration). Utterance
// lines when present (precise seek), else chunk rows (coarse seek). The old
// cosine + literal-boost path (rankDialogueMoments) is retired for dialogue —
// text-text cosine cannot separate "said it" from "about it". Scenes path
// untouched.
async function rankTranscriptMoments(queryText: string, topK: unknown) {
	const trimmed = (queryText || "").trim();
	if (!trimmed) return [];
	const k = Math.max(1, Math.min(96, Number(topK) || 24));
	const { segVideos, traVideos, traUtterances } = loadMomentSidecars();
	const docs: Array<{
		filename: string;
		t0: any;
		t1: any;
		text: any;
	}> = [];
	const hasUtterances =
		traUtterances instanceof Map &&
		[...traUtterances.values()].some((l) => l.length > 0);
	if (hasUtterances) {
		for (const [filename, lines] of traUtterances) {
			for (const u of lines || []) {
				docs.push({ filename, t0: u.t0, t1: u.t1, text: u.text });
			}
		}
	} else {
		for (const [filename, chunks] of traVideos) {
			for (const c of chunks || []) {
				docs.push({ filename, t0: c.t0, t1: c.t1, text: c.text });
			}
		}
	}
	if (docs.length === 0) return [];
	return exactDialogueSearch({ query: trimmed, docs, segVideos, topK: k });
}

handle(
	"memories:rank-scenes",
	async (_event: unknown, query: string, topK?: unknown) => {
		try {
			return await rankVisualScenes(query, (topK as number) || 24);
		} catch (err) {
			console.error(`[rank] rank-scenes failed: ${errorDetail(err)}`);
			return [];
		}
	},
);

handle(
	"memories:rank-dialogue",
	async (_event: unknown, query: string, topK?: unknown) => {
		try {
			return await rankTranscriptMoments(query, (topK as number) || 24);
		} catch (err) {
			console.error(`[rank] rank-dialogue failed: ${errorDetail(err)}`);
			return [];
		}
	},
);

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

handle("memories:embed-query", async (_event: unknown, text: unknown) => {
	if (typeof text !== "string" || !text.trim()) return null;
	// The pool runs the TARGET model during a migration; ranking the
	// still-old library against it would produce garbage scores. Search
	// falls back to keyword matching until the flip lands.
	if (ctx.getMigrationState()) return null;
	// A query in flight blocks a new enrichment chunk AND a new OCR job
	// from starting (the worker's priority lane handles a query that lands
	// mid-chunk; OCR paces itself between photos).
	ctx.setEnrichPendingQuery(true);
	ctx.setOcrPendingQuery(true);
	ctx.setTranscribePendingQuery(true);
	// Tell the tray why its progress bar stalled (Phase 4) — only when
	// there's actually something to pause, so idle searches don't spam the
	// status channel.
	if (ctx.getEnrichQueue().length > 0 || ctx.isEnrichInFlight()) {
		ctx.broadcastEnrichEvent({
			phase: "paused",
			active: ctx.isEnrichInFlight(),
			pending: Math.max(
				0,
				ctx.getEnrichQueue().length - (ctx.isEnrichInFlight() ? 1 : 0),
			),
		});
	}
	try {
		ctx.spawnIndexer();
		await ctx.getIndexerReady();
		const reply = (await ctx.askIndexer({ type: "embed-query", text })) as {
			vec?: number[] | null;
		};
		return reply.vec ?? null;
	} catch (err) {
		// null is the deliberate "no vector" shape — the warm-up/migration
		// guards above return it without throwing, so this catch is a real
		// failure (worker death, embed error) and must reach the log even
		// though the renderer only sees null.
		console.error(`[rank] embed-query failed: ${errorDetail(err)}`);
		return null;
	} finally {
		ctx.setEnrichPendingQuery(false);
		ctx.setOcrPendingQuery(false);
		ctx.setTranscribePendingQuery(false);
	}
});

// Re-exported for main.js: will-quit stops the rank worker (graceful
// shutdown posts first, then kill) alongside every other worker; the CTO
// smoke ctx injects the in-process rankSearch into its driver.
export { stopRankWorker, rankSearch };
