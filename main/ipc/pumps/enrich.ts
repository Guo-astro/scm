// Phase 1 (pumps/enrich): pure move from main.js (2026-10-10) —
// scene-segment enrichment queue (state, gates, pump, backfill, progress).
// No behavior change: same pacing, retries, parking, tombstones. Shared
// refs still owned by main.js arrive via main/context.js and are read AT
// CALL TIME: isBackgroundPaused / getPurgeEpoch (thunks over main.js lets
// that transfer ownership later), isImportInFlight / getMigrationState /
// isVideo (existing slots), isTranscribePendingQuery (thunk over main.js
// `let`), updateTrayState / maybeNotify / askPrimaryIndexer /
// restartPrimaryIndexer / libraryHasRow (hoisted fns), postersDir (const
// copy). Own state (queue, flags, timer, progress, tombstones, counters)
// is exported below for the stayers (import/migration/tray/purge/drop/
// transcribe/ocr/smoke) — same live references, in-place mutation only.
// This module never requires main.js (no cycle).
import path from "node:path";
import { BrowserWindow } from "electron";
import { handle } from "../../ipc-wrapper.ts";
import ctx from "../../context.ts";
import {
	loadLibrary,
	loadSegments,
	saveSegments,
} from "../../../main-lib/library-store.ts";
import { videoBudgetForCurrentQuality } from "../../../main-lib/settings.ts";
import {
	mergeChunkSegments,
	partitionChunkReply,
	shouldParkEnrichment,
	SEGMENT_ROW_PER,
	ENRICH_CHUNK_TIMEOUT_MS,
	ENRICH_STALL_TIMEOUT_MS,
	ENRICH_MAX_RETRIES,
} from "../../../indexer/segment-store-utils.ts";

// ---------------------------------------------------------------------------
// Scene-segment enrichment queue (Phase 1 of scene search).
//
// New videos are enriched in the BACKGROUND after their import batch ends —
// never on the import critical path. Dispatch is paced and gated: nothing
// runs while an import or migration is in flight or a query IPC is pending,
// so search and import latency are unaffected by construction (see
// DESIGN-SCENE-SEARCH.md §3). Chunks are ≤ SEGMENTS_PER_CHUNK segments, and
// the worker's priority lane lets queries preempt between chunks.
// ---------------------------------------------------------------------------

// Chunk size lives in indexer/segment-store-utils.js (SEGMENTS_PER_CHUNK);
// main.js never chunks directly — the worker's priority lane lets queries
// preempt between chunks.
const ENRICH_GAP_MS = 250;
// Retry delay between chunk attempts for the same video (backoff base).
const ENRICH_RETRY_DELAY_MS = 2000;

// One queued video: `off` is the worker's read cursor (fromIndex), the rest
// accumulate across chunks for the parking heuristics.
interface EnrichJob {
	filename: string;
	path: string;
	off: number;
	retries?: number;
	lastError?: string | null;
	purgeEpoch?: number;
	okTotal?: number;
	skipTotal?: number;
}
// Worker `enrich-progress` payload (loose — the pool forwards it verbatim
// and noteEnrichProgress validates the fields it counts).
interface EnrichProgress {
	phase?: string;
	filename?: string;
	pct?: number;
	done?: number;
	total?: number;
	gi?: number;
	t?: number;
	step?: string | null;
	heartbeat?: boolean;
}

const enrichQueue: EnrichJob[] = [];
let enrichInFlight = false;
let enrichPendingQuery = false;
let enrichTimer: NodeJS.Timeout | null = null;
let lastEnrichStart = 0;
// Per-file tombstones: filenames whose queued/in-flight work was cancelled
// by delete/purge/reset (dropQueuedJobsFor, purgeBackgroundWork). Every
// pump's commit path checks this alongside libraryHasRow/purgeEpoch and,
// on hit, discards the reply, drops the job, and deletes the entry — so
// the set stays bounded: an entry lives only until its orphan settles.
// Purge/reset clear it wholesale after draining (stale entries would
// otherwise discard legitimate re-queued work).
const deadJobs = new Set<string>();
// True when this file's work was cancelled mid-flight (delete/purge).
// Consumes the entry on hit so tombstones never outlive their orphan —
// call it only on the discard path, never speculatively.
function isJobDead(filename: string) {
	if (!deadJobs.has(filename)) return false;
	deadJobs.delete(filename);
	return true;
}

// Phase 4: live progress for the renderer's enrichment tray. The worker's
// `enrich-progress` messages (deliberately id-less, so they can't trip the
// pending-request map) land in lastEnrichProgress; enrichEventsObserved backs
// the E2E's assertion that progress actually flows.
let lastEnrichProgress: EnrichProgress | null = null;
let lastEnrichHeartbeatAt = 0;
let lastEnrichDetail: {
	gi?: number;
	t?: number;
	step?: string | null;
} | null = null; // { gi, t, step } of the current segment
let enrichEventsObserved = 0;
// Videos queued since the last drain, for the hidden-window completion
// notification (incremented in enqueueEnrichment, consumed at the drain).
let enrichNotifyCount = 0;
// Per-phase progress counters + violation flag: backing the Phase-4 deep
// test (detect pct must stay in [0,1]; embed done must be 1..total).
const enrichPhaseCounts = { detect: 0, embed: 0 };
let enrichProgressViolations = 0;

function broadcastEnrichEvent(extra: {
	phase: string;
	filename?: string | null;
	pending?: number;
}) {
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send("memories:status", { type: "enrich", ...extra });
	}
	// Menu-bar tray icon follows background work (no-op when the mode is off).
	ctx.updateTrayState();
}

// Current background-enrichment snapshot (Phase 4 tray). Served by the
// enrich-state IPC and replayed on did-finish-load so the tray is correct
// even when broadcasts raced the renderer's subscription.
//
// Stale-clear (long-film fix): progress is keyed by filename — a leftover
// tick from a finished/dropped video must never render as the NEXT job's
// done/total (the old code showed a stale 16/1024 after a drop). When the
// in-flight job doesn't match the last tick's filename, the snapshot reports
// the job with zeroed progress instead of someone else's numbers.
function enrichSnapshot() {
	const job = enrichInFlight ? enrichQueue[0] : null;
	const raw = lastEnrichProgress;
	const prog = job && raw && raw.filename === job.filename ? raw : null;
	const heartbeatAgeMs =
		job && lastEnrichHeartbeatAt > 0
			? Date.now() - lastEnrichHeartbeatAt
			: null;
	return {
		type: "enrich",
		paused: ctx.isBackgroundPaused(),
		phase: job ? (prog?.phase === "embed" ? "embed" : "detect") : "queued",
		filename: job ? job.filename : null,
		pct: job && prog ? (prog.pct ?? null) : null,
		done: job && prog ? (prog.done ?? 0) : 0,
		total: job && prog ? (prog.total ?? 0) : 0,
		pending: enrichQueue.length - (job ? 1 : 0),
		active: Boolean(job),
		// Liveness detail for the tray/debug: which segment is decoding, in
		// which step (ffmpeg vs clip), and how long since the last heartbeat.
		gi:
			prog && Number.isFinite(prog.gi)
				? prog.gi
				: (lastEnrichDetail?.gi ?? null),
		t: prog && Number.isFinite(prog.t) ? prog.t : (lastEnrichDetail?.t ?? null),
		step: prog?.step ?? lastEnrichDetail?.step ?? null,
		heartbeatAgeMs,
		stalled:
			heartbeatAgeMs !== null && heartbeatAgeMs > ENRICH_STALL_TIMEOUT_MS,
	};
}

// Drop a stale progress tick that belongs to a finished/dropped video so it
// can never render as another job's numbers.
function clearEnrichProgressFor(filename: string) {
	if (lastEnrichProgress && lastEnrichProgress.filename === filename) {
		lastEnrichProgress = null;
		lastEnrichDetail = null;
		lastEnrichHeartbeatAt = 0;
	}
}

// Phase 4 backfill: videos that predate scene enrichment (or whose sidecar
// never landed) are enqueued on launch — one at a time, under the same idle
// gates as import-time enrichment — so a big library catches up without ever
// touching search or import latency. Videos whose plan was empty are
// recorded with an empty segment list, so they are not retried on every
// launch (enqueueEnrichment's dedupe guards this too).
function backfillEnrichment() {
	const l = loadLibrary();
	if (!l || !Array.isArray(l.filenames)) return;
	const covered = loadSegments(l.modelId).videos;
	const missing: Array<{ filename: string; path: string }> = [];
	for (const name of l.filenames) {
		if (!ctx.isVideo(name)) continue;
		if (covered && covered.has(name)) continue;
		missing.push({ filename: name, path: path.join(ctx.photosDir, name) });
	}
	if (missing.length > 0) {
		console.log(
			`[memories] backfill: ${missing.length} video(s) missing scene data`,
		);
		enqueueEnrichment(missing);
	}
}

function enqueueEnrichment(files: Array<{ filename: string; path: string }>) {
	if (!Array.isArray(files)) return;
	let added = 0;
	for (const f of files) {
		if (
			f &&
			f.filename &&
			f.path &&
			!enrichQueue.some((q) => q.filename === f.filename)
		) {
			enrichQueue.push({ filename: f.filename, path: f.path, off: 0 });
			added++;
		}
	}
	if (added > 0) {
		// Counted for the drain notification (reset when it fires below).
		enrichNotifyCount += added;
		// Tray: a fresh batch queued (import or launch backfill).
		broadcastEnrichEvent({ phase: "queued", pending: enrichQueue.length });
	}
	scheduleEnrichment();
}

function scheduleEnrichment() {
	if (enrichTimer) return;
	enrichTimer = setTimeout(() => {
		enrichTimer = null;
		void pumpEnrichment();
	}, ENRICH_GAP_MS);
}

function enrichAllowed() {
	return (
		!ctx.isBackgroundPaused() &&
		!enrichInFlight &&
		!ctx.isImportInFlight() &&
		!ctx.getMigrationState() &&
		!enrichPendingQuery &&
		!ctx.isTranscribePendingQuery() &&
		enrichQueue.length > 0 &&
		Date.now() - lastEnrichStart >= ENRICH_GAP_MS
	);
}

async function pumpEnrichment() {
	if (!enrichAllowed()) {
		// While user-paused nothing will change until resume (which kicks
		// explicitly) — don't spin the gap timer for it.
		if (enrichQueue.length > 0 && !ctx.isBackgroundPaused())
			scheduleEnrichment();
		return;
	}
	// Bounds-proven: enrichAllowed() above requires a non-empty queue.
	const job = enrichQueue[0] as EnrichJob;
	// Row deleted while queued — drop without work, retry, or tray noise.
	if (job && !ctx.libraryHasRow(job.filename)) {
		console.log(
			`[memories] enriched ${job.filename}: row deleted while queued — dropping job`,
		);
		enrichQueue.shift();
		clearEnrichProgressFor(job.filename);
		broadcastEnrichEvent({
			phase: enrichQueue.length === 0 ? "idle" : "done",
			filename: job.filename,
			pending: enrichQueue.length,
		});
		scheduleEnrichment();
		return;
	}
	if (typeof job.retries !== "number") job.retries = 0;
	job.purgeEpoch = ctx.getPurgeEpoch();
	enrichInFlight = true;
	lastEnrichStart = Date.now();
	// Heartbeat baseline for THIS chunk: the worker's per-segment + interval
	// ticks refresh lastEnrichHeartbeatAt; silence past ENRICH_STALL_TIMEOUT_MS
	// means the chunk is wedged, not merely slow.
	lastEnrichHeartbeatAt = Date.now();
	try {
		const modelId = loadLibrary().modelId;
		const reply = (await ctx.askPrimaryIndexer(
			{
				type: "enrich-video",
				path: job.path,
				fromIndex: job.off || 0,
				filename: job.filename,
				// The worker persists each segment's midpoint frame here so the
				// renderer can swap the card thumbnail to the best-scene poster.
				postersDir: ctx.postersDir,
				// Scene density for the user's Settings → Video search preset
				// (resolved per job so a preset switch takes effect without a
				// worker restart; the worker keys its cached plan on it).
				budget: videoBudgetForCurrentQuality(),
			},
			ENRICH_CHUNK_TIMEOUT_MS,
		)) as {
			ok?: boolean;
			done?: boolean;
			total?: number;
			fromIndex?: number;
			segments?: unknown;
			vecs?: unknown;
			error?: string;
		};
		const c = loadSegments(modelId);
		// Row deleted — or purged — while this chunk ran: committing would
		// resurrect sidecar entries (for a row that no longer exists) or
		// land partial fragments the backfill skips as "covered". Discard
		// the reply and drop the job (same finish shape as the tail below;
		// finally still clears the in-flight flag).
		// isJobDead FIRST: it consumes the tombstone, and short-circuiting
		// on a row/epoch hit first would leak the entry (a later re-import
		// of the same filename would then discard one live chunk).
		if (
			isJobDead(job.filename) ||
			!ctx.libraryHasRow(job.filename) ||
			job.purgeEpoch !== ctx.getPurgeEpoch()
		) {
			console.log(
				`[memories] enriched ${job.filename}: row deleted or purged mid-flight — discarding chunk`,
			);
			enrichQueue.shift();
			clearEnrichProgressFor(job.filename);
			broadcastEnrichEvent({
				phase: enrichQueue.length === 0 ? "idle" : "done",
				filename: job.filename,
				pending: enrichQueue.length,
			});
			scheduleEnrichment();
			return;
		}
		// One corrupt GOP must not kill a 1024-seg film: the worker returns
		// parallel arrays (segments[i] ↔ vecs[i], null = skipped) and still
		// advances fromIndex past failures. Partition here and persist only
		// the successful rows; skipped segments simply leave a searchable gap.
		const { okSegments, okVecs, skipped } = partitionChunkReply(
			reply.segments,
			reply.vecs,
		);
		// Segment rows share the index's model dim; persist it so the
		// renderer's header validation (header[1] === meta.dim) passes. The
		// cache starts dim-less (fresh, no prior file) — the index is the
		// authoritative source, the first SUCCESSFUL vector length the backup
		// (a fully-skipped chunk carries no usable dim).
		if (c.dim === 0) {
			const firstVec = okVecs.length > 0 ? (okVecs[0] as number[]) : null;
			c.dim = loadLibrary().dim || (firstVec ? firstVec.length : 0);
		}
		if (reply.ok && okVecs.length > 0) {
			// Append this chunk's rows and stamp the file's segment offsets
			// (poster = the segment's scene-poster index). mergeChunkSegments
			// ACCUMULATES into the file's list because the worker returns
			// only the slice it embedded THIS call — replacing the entry
			// here used to leave only the LAST chunk's segments in the
			// sidecar, making a long film searchable only in its final
			// minutes (pinned by test/pump-enrichment.test.js and the
			// phase-4 multi-chunk check).
			const segments = mergeChunkSegments(
				c.videos.get(job.filename) || [],
				okSegments,
				c.rows.length,
				SEGMENT_ROW_PER,
			);
			c.rows.push(
				...okVecs.map((v) => new Float32Array(v as ArrayLike<number>)),
			);
			c.videos.set(job.filename, segments);
			c.loaded = true;
			saveSegments();
			job.retries = 0;
			job.okTotal = (job.okTotal || 0) + okVecs.length;
			job.skipTotal = (job.skipTotal || 0) + skipped;
			console.log(
				`[memories] enriched ${job.filename}: ${reply.fromIndex}/${reply.total} segments` +
					(skipped > 0 ? ` (${skipped} skipped)` : ""),
			);
		} else if (reply.ok && reply.total === 0) {
			// Nothing detectable (failed probe / too short) — record an empty
			// entry so the file is not retried on every launch.
			c.videos.set(job.filename, []);
			c.loaded = true;
			saveSegments();
			console.log(
				`[memories] enriched ${job.filename}: 0 segments (plan empty)`,
			);
		} else if (reply.ok && skipped > 0 && okVecs.length === 0) {
			// Whole chunk skipped (e.g. a run of corrupt GOPs): still advance
			// past it — dropping the film here would discard the 16 good
			// segments before it and freeze the tray at the chunk boundary.
			job.retries = 0;
			job.skipTotal = (job.skipTotal || 0) + skipped;
			console.warn(
				`[memories] enriched ${job.filename}: ${reply.fromIndex}/${reply.total} segments (all ${skipped} skipped in this chunk, continuing)`,
			);
		} else {
			console.warn(
				`[memories] enrichment returned no segments for ${job.filename}: ${reply.error || "unknown"}`,
			);
		}
		if (reply.ok && !reply.done) {
			job.off = reply.fromIndex || 0;
			scheduleEnrichment();
			return;
		}
		if (
			shouldParkEnrichment({
				done: reply.done,
				ok: reply.ok,
				okTotal: job.okTotal,
				skippedTotal: job.skipTotal,
				alreadyCovered: c.videos.has(job.filename),
			})
		) {
			// Poison pill: every segment skipped across every chunk (undecodable
			// frames, 2026-09-26: parseRawFrameSize missing the SAR-less
			// `WxH, q=` form). Without an entry, backfillEnrichment re-queues
			// this file on every launch and every model switch forever and the
			// tray never goes idle. Park it like the empty-plan path — an empty
			// entry means "no scene data, don't retry". A re-imported copy
			// arrives under removeLibraryRow/dropQueuedJobsFor cleanup, so a
			// genuinely fixed file gets another chance on re-import.
			c.videos.set(job.filename, []);
			c.loaded = true;
			saveSegments();
			console.warn(
				`[memories] enriched ${job.filename}: 0/${reply.total} segments (all ${job.skipTotal} skipped across every chunk — parking, will not retry until re-import)`,
			);
		}
	} catch (err) {
		const e = err as {
			message?: string;
			code?: string;
			timeoutMs?: number;
		};
		// Row deleted — or purged — mid-chunk: the missing file (or the
		// purge) explains the failure — retrying would burn the whole
		// budget on it. Drop instead.
		// isJobDead FIRST: it consumes the tombstone, and short-circuiting
		// on a row/epoch hit first would leak the entry (a later re-import
		// of the same filename would then discard one live chunk).
		if (
			isJobDead(job.filename) ||
			!ctx.libraryHasRow(job.filename) ||
			job.purgeEpoch !== ctx.getPurgeEpoch()
		) {
			console.log(
				`[memories] enrichment chunk for ${job.filename} failed after the row was deleted or purged — dropping job`,
			);
			enrichQueue.shift();
			clearEnrichProgressFor(job.filename);
			broadcastEnrichEvent({
				phase: enrichQueue.length === 0 ? "idle" : "done",
				filename: job.filename,
				pending: enrichQueue.length,
			});
			scheduleEnrichment();
			return;
		}
		// Never-stall retry (long-film fix): a chunk timeout/error keeps the
		// job at its current offset and retries with backoff instead of
		// dropping a 2–3 h film for one slow segment. The timed-out worker
		// may still be grinding the orphaned chunk (its queue stays busy —
		// the 16/1024-forever signature), so restart the primary to drop the
		// zombie ffmpeg work with it. After ENRICH_MAX_RETRIES the video is
		// dropped for this session (backfill retries it); enrichment failure
		// never touches imports or search.
		job.retries = (job.retries || 0) + 1;
		job.lastError = e.message;
		if (job.retries <= ENRICH_MAX_RETRIES) {
			console.warn(
				`[memories] enrichment chunk ${job.off || 0} for ${job.filename} failed ` +
					`(attempt ${job.retries}/${ENRICH_MAX_RETRIES}): ${e.message} — retrying`,
			);
			if (e.code === "INDEXER_TIMEOUT") {
				ctx.restartPrimaryIndexer(`chunk timeout after ${e.timeoutMs}ms`);
			}
			enrichInFlight = false;
			if (enrichTimer) clearTimeout(enrichTimer);
			enrichTimer = setTimeout(() => {
				enrichTimer = null;
				void pumpEnrichment();
			}, ENRICH_RETRY_DELAY_MS * job.retries);
			return;
		}
		console.warn(
			`[memories] enrichment failed for ${job.filename} after ${job.retries} attempts: ${e.message} (dropping for this session)`,
		);
		if (e.code === "INDEXER_TIMEOUT") {
			ctx.restartPrimaryIndexer(`final chunk timeout for ${job.filename}`);
		}
		// Timeout-poison parking (2026-09-28 orphan-loop fix): a film whose
		// chunk 0 never completes (e.g. 2 h HEVC whose full-rate detect alone
		// exceeds the chunk timeout) was dropped "for this session" but
		// backfillEnrichment re-queued it on EVERY launch — leaking a fresh
		// 500%-CPU ffmpeg each time while the tray claimed idle. When the job
		// made zero progress across all retries, park it like the empty-plan
		// path (empty segment list = covered, never retried until re-import).
		try {
			const noProgress = !job.off && !job.okTotal && !job.skipTotal;
			if (noProgress && job.filename) {
				const parkModelId = loadLibrary().modelId;
				const sc = loadSegments(parkModelId);
				if (sc && !sc.videos.has(job.filename)) {
					sc.videos.set(job.filename, []);
					sc.loaded = true;
					saveSegments();
					console.warn(
						`[memories] parked ${job.filename} after ${job.retries} timeouts with zero progress (will not retry until re-import)`,
					);
				}
			}
		} catch {
			/* parking is best-effort — the drop below still applies */
		}
		clearEnrichProgressFor(job.filename);
	} finally {
		enrichInFlight = false;
	}
	const finished = enrichQueue.shift();
	// The finished video's last tick must not leak into the next job's
	// snapshot (stale 16/1024 after a drop) — enrichSnapshot also guards by
	// filename, this clears the stored tick itself.
	if (finished) clearEnrichProgressFor(finished.filename);
	// Tray: this video finished (or failed) — the next job's progress takes
	// over, or the queue drained into "idle".
	broadcastEnrichEvent({
		phase: enrichQueue.length === 0 ? "idle" : "done",
		filename: job.filename,
		pending: enrichQueue.length,
	});
	if (enrichQueue.length === 0 && enrichNotifyCount > 0) {
		const n = enrichNotifyCount;
		enrichNotifyCount = 0;
		ctx.maybeNotify(
			"Scene analysis complete",
			`${n} video${n === 1 ? "" : "s"} analyzed — scene search is up to date.`,
		);
	}
	scheduleEnrichment();
}

// Live accessors over module state for the stayers (transcribe/ocr gates,
// drop/purge, tray, pool, smoke) and the shared context slots. In-place
// reads/writes only — the queue/set identities never change.
const getEnrichQueue = () => enrichQueue;
const isEnrichInFlight = () => enrichInFlight;
const isEnrichPendingQuery = () => enrichPendingQuery;
const setEnrichPendingQuery = (v: boolean) => {
	enrichPendingQuery = v;
};
const getEnrichTimer = () => enrichTimer;
const setEnrichTimer = (v: NodeJS.Timeout | null) => {
	enrichTimer = v;
};
const setEnrichInFlight = (v: boolean) => {
	enrichInFlight = v;
};
const setEnrichNotifyCount = (v: number) => {
	enrichNotifyCount = v;
};
const getEnrichEventsObserved = () => enrichEventsObserved;
const getEnrichProgressViolations = () => enrichProgressViolations;

// Worker progress intake (Phase 1 relocation of the pool message-block
// writes — verbatim). The pool calls this for every `enrich-progress`
// message; the heartbeat clock + phase counters + violation guards behave
// exactly as before, now against module bindings.
function noteEnrichProgress(msg: EnrichProgress) {
	enrichEventsObserved++;
	lastEnrichProgress = msg;
	// Heartbeat clock: every embed tick (including heartbeat-only
	// ticks that repeat the same done count) proves the worker is
	// alive inside a long ffmpeg decode. pumpEnrichment uses the
	// silence duration to tell slow-but-alive from wedged.
	lastEnrichHeartbeatAt = Date.now();
	if (msg.phase === "embed" && Number.isFinite(msg.gi)) {
		lastEnrichDetail = {
			gi: msg.gi,
			t: msg.t,
			step: msg.step || null,
		};
	} else if (msg.phase !== "embed") {
		lastEnrichDetail = null;
	}
	if (msg.phase === "detect") {
		enrichPhaseCounts.detect++;
		const pct = Number(msg.pct);
		if (!(pct >= 0 && pct <= 1)) enrichProgressViolations++;
	} else if (msg.phase === "embed") {
		enrichPhaseCounts.embed++;
		// Heartbeat ticks repeat the previous done count by design
		// (same segment still decoding) — only validate real
		// forward progress, never the liveness pings.
		if (!msg.heartbeat) {
			const total = Number(msg.total);
			const done = Number(msg.done);
			if (!(total > 0 && done >= 1 && done <= total)) {
				enrichProgressViolations++;
			}
		}
	}
}

export {
	enrichQueue,
	deadJobs,
	enrichPhaseCounts,
	isJobDead,
	clearEnrichProgressFor,
	noteEnrichProgress,
	isEnrichInFlight,
	isEnrichPendingQuery,
	getEnrichQueue,
	getEnrichTimer,
	setEnrichTimer,
	setEnrichInFlight,
	setEnrichNotifyCount,
	setEnrichPendingQuery,
	enrichSnapshot,
	broadcastEnrichEvent,
	scheduleEnrichment,
	enqueueEnrichment,
	backfillEnrichment,
	getEnrichEventsObserved,
	getEnrichProgressViolations,
};

// Phase 1 (pump states): the tray-state IPC lives with its pump (moved
// from main.js — same one-line snapshot serve, no behavior change).
handle("memories:enrich-state", () => enrichSnapshot());
