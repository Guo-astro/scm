"use strict";
// Phase 1 (rank-moments): pure move from main.js (2026-10-10) — rank worker,
// rank/scenes/dialogue/embed-query handlers. No behavior change: same
// scoring, same worker fallback, same query priority flags. Shared refs
// still owned by main.js arrive via main/context.js and are read AT CALL
// TIME: pool (spawnIndexer, getIndexerReady thunk, askIndexer, indexerEnv),
// migration (getMigrationState — shared slot), pump gates (getEnrichQueue /
// isEnrichInFlight thunks, set*PendingQuery setters, broadcastEnrichEvent).
// Everything else is required directly — this module never requires main.js
// (no cycle). will-quit's stopRankWorker is re-exported below.
const { utilityProcess, app } = require("electron");
const path = require("path");
const { handle } = require("../ipc-wrapper.js");
const ctx = require("../context.js");
const {
	loadLibrary,
	libraryNorms,
	thresholdsFor,
	loadSegments,
	loadTranscripts,
	libraryGenerationNumber,
} = require("../../main-lib/library-store.js");
const {
	cosineSim,
	RANK_MIN_SCORE,
	RANK_RELATIVE_KEEP,
	scoreLibrary,
} = require("../../main-lib/rank-search.js");
const {
	attachQueryVec,
	exactDialogueSearch,
} = require("../../indexer/transcript-store-utils.js");
// NOTE: FUSION_SLOT_SECONDS / FUSION_SCENES_PER_VIDEO / FUSION_NOISE_FRACTION
// / fuseVisualTextMoments arrive via the moved mid-file require below (kept
// verbatim); they are deliberately NOT destructured here.

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
let rankWorker = null;
let rankWorkerDead = false;
const rankPending = new Map();
let rankRequestId = 0;
const RANK_TIMEOUT_MS = 15000;

function ensureRankWorker() {
	if (rankWorker && !rankWorkerDead) return rankWorker;
	rankWorkerDead = false;
	const worker = { process: null, dead: false };
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
		const msg = event && event.data !== undefined ? event.data : event;
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
	worker.process.on("exit", (code, signal) => {
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
			const err = new Error(`Rank worker ${label}`);
			err.code = "RANK_EXIT";
			req.reject(err);
		}
		rankPending.clear();
	});
	rankWorker = worker;
	return worker;
}

function askRankWorker(message) {
	const worker = ensureRankWorker();
	return new Promise((resolve, reject) => {
		const id = `k${++rankRequestId}`;
		const timer = setTimeout(() => {
			rankPending.delete(id);
			const err = new Error("Rank request timed out");
			err.code = "RANK_TIMEOUT";
			reject(err);
		}, RANK_TIMEOUT_MS);
		rankPending.set(id, { resolve, reject, timer });
		worker.process.postMessage({
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
async function embedRankQuery(trimmed, dim) {
	try {
		ctx.spawnIndexer();
		await ctx.getIndexerReady();
	} catch {
		return null;
	}
	if (ctx.getMigrationState()) return null;
	try {
		const reply = await ctx.askIndexer({ type: "embed-query", text: trimmed });
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
async function rankSearch(queryText, topK, qVecOverride) {
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
	const norms = libraryNorms();
	return scoreLibrary(l, trimmed, qVec, topK, thresholds, norms);
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
async function rankSearchWithVec(queryText, topK, qVecOverride) {
	const withVec = (results, queryVec) => attachQueryVec(results, queryVec);
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

	let results;
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

handle("memories:rank", async (_event, query, topK) => {
	try {
		return await rankSearchWithVec(query, topK || 96);
	} catch {
		return [];
	}
});

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

const {
	FUSION_SLOT_SECONDS,
	FUSION_SCENES_PER_VIDEO,
	FUSION_NOISE_FRACTION,
	fuseVisualTextMoments,
} = require("../../indexer/transcript-store-utils.js");

// One centered query embed shared by both moment rankers (null on model
// down / migration / empty query — callers return [] then).
async function embedMomentQuery(queryText, qVecOverride) {
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
			const reply = await ctx.askIndexer({ type: "embed-query", text: trimmed });
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

function loadMomentSidecars() {
	const l = loadLibrary();
	let seg;
	let tra;
	try {
		seg = loadSegments(l.modelId);
	} catch {
		seg = null;
	}
	try {
		tra = loadTranscripts(l.modelId);
	} catch {
		tra = null;
	}
	return {
		segVideos: seg && seg.loaded ? seg.videos : new Map(),
		segRows: seg && seg.loaded ? seg.rows : [],
		segDim: seg && seg.loaded ? seg.dim : 0,
		traVideos: tra && tra.loaded ? tra.videos : new Map(),
		traRows: tra && tra.loaded ? tra.rows : [],
		traDim: tra && tra.loaded ? tra.dim : 0,
		traUtterances:
			tra && tra.loaded && tra.utterances instanceof Map
				? tra.utterances
				: new Map(),
	};
}

// Pure-visual scene moments, legacy-exact: raw segment cosines, NO hit caps
// (the old renderer path scored every row), weight 1.0 so cutoff and noise
// gate run in raw cosine space exactly as before.
async function rankVisualScenes(queryText, topK, qVecOverride) {
	const k = Math.max(1, Math.min(96, Number(topK) || 24));
	const qVec = await embedMomentQuery(queryText, qVecOverride);
	if (!qVec) return [];
	const { minScore, relativeKeep } = momentThresholds();
	const { segVideos, segRows, segDim } = loadMomentSidecars();
	if (segVideos.size === 0 || segDim !== qVec.length) return [];
	const visualHits = []; // {filename, t, dur, poster, score}
	let visualTotal = 0;
	for (const [filename, segments] of segVideos) {
		for (const s of segments) {
			const row = segRows[s.off];
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
async function rankTranscriptMoments(queryText, topK) {
	const trimmed = (queryText || "").trim();
	if (!trimmed) return [];
	const k = Math.max(1, Math.min(96, Number(topK) || 24));
	const { segVideos, traVideos, traUtterances } = loadMomentSidecars();
	const docs = [];
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

handle("memories:rank-scenes", async (_event, query, topK) => {
	try {
		return await rankVisualScenes(query, topK || 24);
	} catch {
		return [];
	}
});

handle("memories:rank-dialogue", async (_event, query, topK) => {
	try {
		return await rankTranscriptMoments(query, topK || 24);
	} catch {
		return [];
	}
});

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

handle("memories:embed-query", async (_event, text) => {
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
			pending: Math.max(0, ctx.getEnrichQueue().length - (ctx.isEnrichInFlight() ? 1 : 0)),
		});
	}
	try {
		ctx.spawnIndexer();
		await ctx.getIndexerReady();
		const reply = await ctx.askIndexer({ type: "embed-query", text });
		return reply.vec ?? null;
	} catch {
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
module.exports = { stopRankWorker, rankSearch };
