// Phase 1 (pumps/transcribe): pure move from main.js (2026-10-10) — speech
// transcription queue (worker, gates, pump, backfill, progress, utterances).
// No behavior change: same pacing, retries, load-vs-decode attribution.
// Shared refs still owned by main.js arrive via main/context.js and are read
// AT CALL TIME: isBackgroundPaused / getPurgeEpoch / isImportInFlight /
// getMigrationState / isVideo / photosDir (existing slots), isOcrPendingQuery
// (thunk over main.js `let`), updateTrayState / libraryHasRow / spawnIndexer
// / askPrimaryIndexer / indexerEnv (hoisted fns), trackFfmpegSpawn /
// untrackFfmpegExit (pool helpers) + transcribeFfmpegPids (stable Map).
// Tombstones ride the enrich module's isJobDead (same process, direct
// require — transcribe never re-queues, it only consumes). Own state is
// exported below for the stayers (import/migration/tray/purge/drop/
// whisper-switch/will-quit). This module never requires main.js (no cycle).
import fs from "node:fs";
import path from "node:path";
import { utilityProcess, BrowserWindow } from "electron";
import { handle } from "../../ipc-wrapper.ts";
import ctx from "../../context.ts";
import { isJobDead } from "./enrich.ts";
import {
	loadLibrary,
	loadTranscripts,
	saveTranscripts,
} from "../../../main-lib/library-store.ts";
import { readWhisperModel } from "../../../main-lib/settings.ts";
import {
	TRANSCRIPT_ROW_PER,
	partitionTranscriptReply,
	applyTranscriptReply,
	transcribeBackfillList,
	parseWhisperModel,
	transcribeTimeoutsFor,
	addSkippedSlice,
	TRANSCRIBE_CHUNK_TIMEOUT_MS,
	TRANSCRIBE_MAX_RETRIES,
	TRANSCRIBE_LOAD_MAX_RETRIES,
	transcribeExitLabel,
	transcribeFailureLabel,
	isLoadPhaseCrash,
} from "../../../indexer/transcript-store-utils.js";
import type {
	TranscribeInbound,
	TranscribeOutbound,
} from "../../../shared/worker-messages.ts";

// ---------------------------------------------------------------------------
// Speech transcription queue (transcript sidecar for scene search).
//
// New videos are transcribed in the BACKGROUND after visual enrichment —
// never on the import critical path, never in parallel with it on 8 GB M1
// (enrich first for posters/grid, transcribe second). Dispatch is paced and
// gated like enrichment + OCR: nothing runs while an import/migration is in
// flight or a query IPC is pending. Each job uses a DEDICATED
// transcribe-worker utilityProcess (whisper.cpp, CPU-heavy, unrelated to
// onnxruntime), then embeds chunk texts through the PRIMARY indexer worker
// (same text tower + centering as queries). Results land in the per-model
// transcript sidecar; empty chunk lists are valid (silent film) and never
// retried. Transcription failure never touches imports or search.
// ---------------------------------------------------------------------------

const TRANSCRIBE_GAP_MS = 250;
const TRANSCRIBE_RETRY_DELAY_MS = 2000;

// One queued video: `off` is the worker's read cursor (fromIndex),
// `skipSlices` are known poison slices to gap instead of re-wedging.
interface TranscribeJob {
	filename: string;
	path: string;
	off: number;
	retries?: number;
	lastError?: string | null;
	hadProgress?: boolean;
	purgeEpoch?: number;
	skipSlices?: number[];
}
// Worker `transcribe-progress` payload (loose — the fields are validated
// where they are consumed).
interface TranscribeProgress {
	filename?: string;
	phase?: string;
	model?: string;
	slice?: number;
	done?: number;
	total?: number;
	heartbeat?: boolean;
}
// The reply shape the pump consumes (the worker tags extras onto the
// `transcribe-done` variant).
interface TranscribeReply {
	ok?: boolean;
	done?: boolean;
	fromIndex?: number;
	total?: number;
	model?: string;
	error?: string;
	chunks?: Array<{ text: string }>;
	utterances?: Array<{ t0: number; t1: number; text?: unknown }>;
}
// Errors thrown WITH attribution props (code/labels ride the rejection).
type TranscribeError = Error & {
	code?: string;
	timeoutMs?: number;
	stalledSlice?: number | null;
	exitCode?: number | null;
	signal?: string | null;
};
// The dedicated whisper worker: `process` is the UtilityProcess, `dead` is
// set by the exit handler before the pump respawns.
interface TranscribeWorkerHandle {
	process: Electron.UtilityProcess | null;
	dead: boolean;
}
// One in-flight askTranscribe request; `timer`/`watchdog` are read through
// getters so `done()` always sees the live handles.
interface TranscribePendingRequest {
	resolve: (v: unknown) => void;
	reject: (e: unknown) => void;
	timer: NodeJS.Timeout | null;
	watchdog: NodeJS.Timeout | null;
}

const transcribeQueue: TranscribeJob[] = [];
let transcribeInFlight = false;
let transcribePendingQuery = false;
let transcribeTimer: NodeJS.Timeout | null = null;
let lastTranscribeStart = 0;
let lastTranscribeProgress: TranscribeProgress | null = null;
let lastTranscribeHeartbeatAt = 0;
let lastTranscribeModel: string | null = null;
let transcribeWorker: TranscribeWorkerHandle | null = null;
let transcribeWorkerDead = false;
let transcribePending = new Map<string, TranscribePendingRequest>();
let transcribeRequestId = 0;
// Newest absolute slice index reported by the worker (per-slice ticks and
// interval heartbeats both carry `slice`). Used to name the poison slice on
// a stall kill. Reset per job; heartbeat-only ticks must not mark decode
// progress (see the handler below).
let lastTranscribeSlice: number | null = null;

function broadcastTranscribeEvent(extra: {
	phase: string;
	filename?: string | null;
	pending?: number;
	done?: number;
	total?: number;
	active?: boolean;
}) {
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send("memories:status", { type: "transcribe", ...extra });
	}
	ctx.updateTrayState();
}

function transcribeSnapshot() {
	const job = transcribeInFlight ? transcribeQueue[0] : null;
	const raw = lastTranscribeProgress;
	const prog = job && raw && raw.filename === job.filename ? raw : null;
	return {
		type: "transcribe",
		paused: ctx.isBackgroundPaused(),
		phase: job ? "transcribe" : transcribeQueue.length > 0 ? "queued" : "idle",
		filename: job ? job.filename : null,
		done: job && prog ? (prog.done ?? 0) : 0,
		total: job && prog ? (prog.total ?? 0) : 0,
		pending: transcribeQueue.length - (job ? 1 : 0),
		active: Boolean(job),
	};
}

function clearTranscribeProgressFor(filename: string) {
	if (lastTranscribeProgress && lastTranscribeProgress.filename === filename) {
		lastTranscribeProgress = null;
		lastTranscribeHeartbeatAt = 0;
	}
}

function backfillTranscription() {
	const l = loadLibrary();
	if (!l || !Array.isArray(l.filenames)) return;
	let videos;
	let progress: Record<string, unknown> = {};
	try {
		const c = loadTranscripts(l.modelId);
		videos = c.videos;
		progress = c.progress || {};
	} catch {
		videos = null;
	}
	// Prune progress for rows no longer in the library (deleted videos).
	let pruned = false;
	for (const name of Object.keys(progress)) {
		if (!l.filenames.includes(name)) {
			delete progress[name];
			pruned = true;
		}
	}
	// Missing entries start at 0; entries with partial progress (crash or
	// drop mid-film) resume where they stalled. Complete entries skip.
	const videosOnly = l.filenames.filter((name) => ctx.isVideo(name));
	const jobs = transcribeBackfillList(videosOnly, videos, progress).map(
		(j: { filename: string; off: number; skipped?: number[] }) => ({
			filename: j.filename,
			path: path.join(ctx.photosDir, j.filename),
			off: j.off,
			// Relaunch inherits previously-stalled slices as gaps instead
			// of re-wedging on the same poison slice.
			skipSlices: Array.isArray(j.skipped) ? j.skipped.slice() : [],
		}),
	);
	if (pruned) saveTranscripts();
	if (jobs.length > 0) {
		const resumed = jobs.filter((j) => j.off > 0).length;
		console.log(
			`[memories] backfill: ${jobs.length} video(s) missing transcript data` +
				(resumed > 0 ? ` (${resumed} resuming mid-film)` : ""),
		);
		enqueueTranscription(jobs);
	}
}

function enqueueTranscription(
	files: Array<{
		filename: string;
		path: string;
		off?: number;
		skipSlices?: unknown;
		skipped?: unknown;
	}>,
) {
	if (!Array.isArray(files)) return;
	let added = 0;
	for (const f of files) {
		if (
			f &&
			f.filename &&
			f.path &&
			!transcribeQueue.some((q) => q.filename === f.filename)
		) {
			// off carries resume offsets (crash mid-film); fresh jobs start 0.
			// skipSlices carries previously-stalled slice indexes (gaps).
			const off =
				typeof f.off === "number" && Number.isInteger(f.off) && f.off > 0
					? f.off
					: 0;
			const skipSlices = (
				Array.isArray(f.skipSlices)
					? f.skipSlices
					: Array.isArray(f.skipped)
						? f.skipped
						: []
			).filter((s) => Number.isInteger(s) && s >= 0);
			transcribeQueue.push({
				filename: f.filename,
				path: f.path,
				off,
				skipSlices,
			});
			added++;
		}
	}
	if (added > 0) {
		broadcastTranscribeEvent({
			phase: "queued",
			pending: transcribeQueue.length,
		});
	}
	scheduleTranscription();
}

function scheduleTranscription() {
	if (transcribeTimer) return;
	transcribeTimer = setTimeout(() => {
		transcribeTimer = null;
		void pumpTranscription();
	}, TRANSCRIBE_GAP_MS);
}

function transcribeAllowed() {
	return (
		!ctx.isBackgroundPaused() &&
		!transcribeInFlight &&
		!ctx.isImportInFlight() &&
		!ctx.getMigrationState() &&
		!transcribePendingQuery &&
		!ctx.isEnrichPendingQuery() &&
		!ctx.isOcrPendingQuery() &&
		// Serialize with visual enrichment on 8 GB M1: posters/grid first.
		!ctx.isEnrichInFlight() &&
		ctx.getEnrichQueue().length === 0 &&
		transcribeQueue.length > 0 &&
		Date.now() - lastTranscribeStart >= TRANSCRIBE_GAP_MS
	);
}

function ensureTranscribeWorker() {
	if (transcribeWorker && !transcribeWorkerDead) return transcribeWorker;
	transcribeWorkerDead = false;
	const worker: TranscribeWorkerHandle = { process: null, dead: false };
	worker.process = utilityProcess.fork(
		path.join(__dirname, "..", "..", "..", "indexer", "transcribe-worker.js"),
		[],
		{
			// Shared model cache + ffmpeg resolution, exactly like the
			// indexer pool (whisper weights land beside the CLIP weights in
			// ~/Library/Application Support/scm/models, never in the asar).
			env: ctx.indexerEnv(),
			serviceName: "transcribe-worker",
		},
	);
	worker.process.on("message", (event) => {
		const msg = (
			event && event.data !== undefined ? event.data : event
		) as TranscribeOutbound;
		if (!msg) return;
		if (msg.type === "ffmpeg-spawn") {
			ctx.trackFfmpegSpawn(ctx.transcribeFfmpegPids, msg.pid, msg.label);
			return;
		}
		if (msg.type === "ffmpeg-exit") {
			ctx.untrackFfmpegExit(ctx.transcribeFfmpegPids, msg.pid);
			return;
		}
		if (msg.type === "ffmpeg-killed") return;
		if (msg.type === "transcribe-progress") {
			lastTranscribeProgress = msg as TranscribeProgress;
			lastTranscribeHeartbeatAt = Date.now();
			if (typeof msg.model === "string" && msg.model)
				lastTranscribeModel = msg.model;
			const slice = Number(msg.slice);
			if (Number.isInteger(slice) && slice >= 0) lastTranscribeSlice = slice;
			// Mark load-vs-decode attribution for the active job: a
			// transcribe-phase tick proves decode started; model-phase ticks
			// (or silence) mean a later exit was a load-phase crash.
			// Heartbeat-only ticks (interval keepalives during one long
			// decode) prove aliveness, not decode progress.
			if (
				msg.phase === "transcribe" &&
				!msg.heartbeat &&
				transcribeQueue.length > 0 &&
				msg.filename === transcribeQueue[0]?.filename
			) {
				(transcribeQueue[0] as TranscribeJob).hadProgress = true;
			}
			return;
		}
		if (!msg.id) return;
		const req = transcribePending.get(msg.id);
		if (!req) return;
		transcribePending.delete(msg.id);
		if (req.timer) clearTimeout(req.timer);
		if (req.watchdog) clearInterval(req.watchdog);
		if (msg.ok) req.resolve(msg);
		else {
			const err = new Error(
				msg.error || "Transcribe failed",
			) as TranscribeError;
			const stalled = (msg as { stalledSlice?: number | null }).stalledSlice;
			if (Number.isInteger(stalled)) err.stalledSlice = stalled;
			req.reject(err);
		}
	});
	worker.process.on("exit", (code, signal?: string | null) => {
		worker.dead = true;
		transcribeWorkerDead = true;
		transcribeWorker = null;
		// Diagnose, don't mask: the old handler discarded code/signal, so
		// every OOM kill and every clean crash read identically as
		// "Transcribe worker exited". The exit label (with a SIGKILL→OOM
		// hint) rides both the log line and the rejection, so the pump's
		// retry/drop lines can attribute load-vs-decode.
		const label = transcribeExitLabel(code, signal);
		const active = transcribeQueue.length > 0 ? transcribeQueue[0] : null;
		const hbAge =
			lastTranscribeHeartbeatAt > 0
				? Date.now() - lastTranscribeHeartbeatAt
				: null;
		console.warn(
			`[memories] transcribe worker ${label}` +
				(active
					? ` (job ${active.filename} off ${active.off || 0})`
					: " (idle)") +
				(lastTranscribeModel ? ` model ${lastTranscribeModel}` : "") +
				(hbAge !== null
					? `, last heartbeat ${Math.round(hbAge / 1000)}s ago`
					: ", no heartbeat yet"),
		);
		for (const [, req] of transcribePending) {
			if (req.timer) clearTimeout(req.timer);
			if (req.watchdog) clearInterval(req.watchdog);
			const err = new Error(`Transcribe worker ${label}`) as TranscribeError;
			err.code = "TRANSCRIBE_EXIT";
			err.exitCode = code;
			err.signal = signal;
			req.reject(err);
		}
		transcribePending = new Map();
	});
	transcribeWorker = worker;
	return worker;
}

// SIGKILL the transcribe worker so a wedged native decode dies with it
// (the whisper pipeline is not reentrant — an orphaned decode overlapping
// the next attempt risks tensor corruption). The exit handler above rejects
// any surviving pending requests; the next ensureTranscribeWorker() call
// respawns fresh. Best-effort: never throws.
function killTranscribeWorker(reason: string) {
	const worker = transcribeWorker;
	if (!worker || transcribeWorkerDead) return 0;
	try {
		if (worker.process && typeof worker.process.kill === "function") {
			// UtilityProcess.kill() takes no signal argument — it terminates
			// on POSIX with SIGTERM + reap (the old "SIGKILL" string was
			// inert at runtime; dropping it keeps behavior identical).
			worker.process.kill();
		}
	} catch {
		/* kill is best-effort; the stall rejection below still fires */
	}
	transcribeWorkerDead = true;
	transcribeWorker = null;
	// Belt-and-braces: SIGKILL tracked ffmpeg grandchildren by PID (the
	// worker's death orphans them to PID 1 otherwise — same sweep as
	// killTrackedFfmpegPids, inlined to avoid a pool↔pump require cycle).
	try {
		const map = ctx.transcribeFfmpegPids;
		if (map) {
			for (const pid of [...map.keys()]) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					/* ESRCH = already gone — fine */
				}
				try {
					map.delete(pid);
				} catch {
					/* best-effort */
				}
			}
		}
	} catch {
		/* ffmpeg cleanup is best-effort */
	}
	console.warn(
		`[memories] transcribe worker killed (${reason || "stall watchdog"})`,
	);
	return 1;
}

function askTranscribe(
	message: TranscribeInbound,
	timeoutMs: number = TRANSCRIBE_CHUNK_TIMEOUT_MS,
	stallTimeoutMs: number | null = null,
): Promise<unknown> {
	const worker = ensureTranscribeWorker();
	return new Promise((resolve, reject) => {
		const id = `t${++transcribeRequestId}`;
		let settled = false;
		let timer: NodeJS.Timeout | null = null;
		let watchdog: NodeJS.Timeout | null = null;
		const done = (fn: (v: unknown) => void, v: unknown) => {
			if (settled) return;
			settled = true;
			transcribePending.delete(id);
			if (timer) clearTimeout(timer);
			if (watchdog) clearInterval(watchdog);
			fn(v);
		};
		timer = setTimeout(() => {
			const err = new Error("Transcribe request timed out") as TranscribeError;
			err.code = "TRANSCRIBE_TIMEOUT";
			err.timeoutMs = timeoutMs;
			if (
				Number.isInteger(lastTranscribeSlice) &&
				lastTranscribeSlice !== null &&
				lastTranscribeSlice >= 0
			)
				err.stalledSlice = lastTranscribeSlice;
			done(reject, err);
		}, timeoutMs);
		// Stall watchdog: the chunk ceiling is the outer backstop, but a
		// single wedged slice would otherwise burn the whole budget in
		// silence. Silence past the stall interval kills the worker early
		// and rejects with the last-reported slice so the retry can skip it.
		// Previously stallTimeoutMs was computed but never consumed — a
		// 16-minute wedge could only surface as a 20-minute chunk timeout.
		const stallMs = Number(stallTimeoutMs);
		if (Number.isFinite(stallMs) && stallMs > 0) {
			watchdog = setInterval(() => {
				if (settled) return;
				const silentMs =
					lastTranscribeHeartbeatAt > 0
						? Date.now() - lastTranscribeHeartbeatAt
						: Date.now() - lastTranscribeStart;
				if (silentMs > stallMs) {
					const err = new Error(
						`Transcribe stalled (no heartbeat for ${Math.round(silentMs / 1000)}s)`,
					) as TranscribeError;
					err.code = "TRANSCRIBE_STALL";
					if (
						Number.isInteger(lastTranscribeSlice) &&
						lastTranscribeSlice !== null &&
						lastTranscribeSlice >= 0
					)
						err.stalledSlice = lastTranscribeSlice;
					killTranscribeWorker("stall watchdog");
					done(reject, err);
				}
			}, 15000);
			if (watchdog && typeof watchdog.unref === "function") watchdog.unref();
		}
		transcribePending.set(id, {
			resolve: (v) => done(resolve, v),
			reject: (e) => done(reject, e),
			get timer() {
				return timer;
			},
			get watchdog() {
				return watchdog;
			},
		});
		worker.process?.postMessage({ ...message, id });
	});
}

async function pumpTranscription() {
	if (!transcribeAllowed()) {
		if (transcribeQueue.length > 0 && !ctx.isBackgroundPaused())
			scheduleTranscription();
		return;
	}
	// Bounds-proven: transcribeAllowed() above requires a non-empty queue.
	const job = transcribeQueue[0] as TranscribeJob;
	// Row deleted while queued — drop without work, retry, or tray noise.
	if (job && !ctx.libraryHasRow(job.filename)) {
		console.log(
			`[memories] transcribed ${job.filename}: row deleted while queued — dropping job`,
		);
		transcribeQueue.shift();
		clearTranscribeProgressFor(job.filename);
		broadcastTranscribeEvent({
			phase: transcribeQueue.length === 0 ? "idle" : "done",
			filename: job.filename,
			pending: transcribeQueue.length,
		});
		scheduleTranscription();
		return;
	}
	if (typeof job.retries !== "number") job.retries = 0;
	if (!Array.isArray(job.skipSlices)) job.skipSlices = [];
	job.purgeEpoch = ctx.getPurgeEpoch();
	transcribeInFlight = true;
	lastTranscribeStart = Date.now();
	lastTranscribeHeartbeatAt = Date.now();
	lastTranscribeSlice = null;
	// Announce the active job immediately so the tray pill appears even
	// before the worker's first per-slice progress tick (model load can take
	// a while on first run).
	broadcastTranscribeEvent({
		phase: "transcribe",
		filename: job.filename,
		done: 0,
		total: 0,
		pending: transcribeQueue.length - 1,
		active: true,
	});
	try {
		const modelId = loadLibrary().modelId;
		const whisperModel = readWhisperModel();
		const timeouts = transcribeTimeoutsFor(whisperModel);
		const reply = (await askTranscribe(
			{
				type: "transcribe-video",
				path: job.path,
				filename: job.filename,
				fromIndex: job.off || 0,
				modelId: whisperModel,
				// Per-model window so the call fits its chunk ceiling
				// (base.en: 8 slices, not 16) + per-slice decode ceiling +
				// poison slices to gap instead of re-wedging.
				slicesPerChunk: timeouts.slicesPerChunk,
				sliceDecodeTimeoutMs: timeouts.sliceDecodeTimeoutMs,
				skipSlices: job.skipSlices,
			},
			timeouts.chunkTimeoutMs,
			timeouts.stallTimeoutMs,
		)) as TranscribeReply;
		const replyModel = parseWhisperModel(reply.model || whisperModel);
		// Cancelled (deleted/purged) outranks stale-model: re-running a
		// dead job under the new model would burn a chunk on a file that
		// is gone. isJobDead runs FIRST because it consumes the tombstone
		// — short-circuiting on a row/epoch hit first would leak the entry
		// (a later re-import of the same filename would then discard one
		// live chunk).
		if (
			isJobDead(job.filename) ||
			!ctx.libraryHasRow(job.filename) ||
			job.purgeEpoch !== ctx.getPurgeEpoch()
		) {
			console.log(
				`[memories] transcribed ${job.filename}: row deleted or purged mid-flight (stale-model reply) — discarding chunk`,
			);
			transcribeQueue.shift();
			clearTranscribeProgressFor(job.filename);
			broadcastTranscribeEvent({
				phase: transcribeQueue.length === 0 ? "idle" : "done",
				filename: job.filename,
				pending: transcribeQueue.length,
			});
			scheduleTranscription();
			return;
		}
		if (replyModel !== whisperModel) {
			// Settings switched mid-flight: drop this stale-model reply
			// (no commit, no progress write) and re-run the same offset
			// under the new model. The early return keeps job[0] queued.
			console.log(
				`[memories] speech model changed mid-flight (${whisperModel} → ${replyModel}) — re-running ${job.filename} from offset ${job.off || 0}`,
			);
			scheduleTranscription();
			return;
		}
		const c = loadTranscripts(modelId);
		// Row deleted — or purged — while this chunk ran: committing would
		// resurrect sidecar entries or land partial fragments the backfill
		// skips as "covered". Discard the reply and drop the job (finally
		// still clears the in-flight flag).
		// isJobDead FIRST: it consumes the tombstone, and short-circuiting
		// on a row/epoch hit first would leak the entry (a later re-import
		// of the same filename would then discard one live chunk).
		if (
			isJobDead(job.filename) ||
			!ctx.libraryHasRow(job.filename) ||
			job.purgeEpoch !== ctx.getPurgeEpoch()
		) {
			console.log(
				`[memories] transcribed ${job.filename}: row deleted or purged mid-flight — discarding chunk`,
			);
			transcribeQueue.shift();
			clearTranscribeProgressFor(job.filename);
			broadcastTranscribeEvent({
				phase: transcribeQueue.length === 0 ? "idle" : "done",
				filename: job.filename,
				pending: transcribeQueue.length,
			});
			scheduleTranscription();
			return;
		}
		if (c.dim === 0) {
			c.dim = loadLibrary().dim || 0;
		}
		// Stamp the engine that produced these rows (a Settings switch
		// invalidates; pre-stamp sidecars read back as tiny.en).
		c.whisperModel = replyModel;
		if (reply.ok && reply.chunks && reply.chunks.length > 0) {
			// Embed chunk texts through the primary indexer (same text tower
			// + centering as queries) before committing rows.
			let vecs = [];
			try {
				ctx.spawnIndexer();
				await ctx.getIndexerReady();
				const emb = (await ctx.askPrimaryIndexer(
					{ type: "embed-texts", texts: reply.chunks.map((ch) => ch.text) },
					180000,
				)) as { vecs?: unknown[] };
				vecs = emb.vecs || [];
			} catch (embErr) {
				const e = embErr as { message?: string };
				console.warn(
					`[memories] transcript embed failed for ${job.filename}: ${e.message} — retrying`,
				);
				throw embErr;
			}
			// Accumulate utterance-level full-text rows (exact-search index)
			// alongside the embedded chunks — same accumulation contract,
			// validated lines only, persisted by saveTranscripts.
			if (Array.isArray(reply.utterances) && reply.utterances.length > 0) {
				if (!(c.utterances instanceof Map)) c.utterances = new Map();
				const prev = c.utterances.get(job.filename) || [];
				const seen = new Set(
					prev.map((u) => `${u.t0.toFixed(2)}:${u.t1.toFixed(2)}:${u.text}`),
				);
				for (const u of reply.utterances) {
					if (
						!u ||
						!Number.isFinite(u.t0) ||
						!Number.isFinite(u.t1) ||
						u.t1 <= u.t0
					)
						continue;
					if (typeof u.text !== "string" || u.text.trim().length === 0)
						continue;
					const line = { t0: u.t0, t1: u.t1, text: String(u.text) };
					const key = `${line.t0.toFixed(2)}:${line.t1.toFixed(2)}:${line.text}`;
					if (seen.has(key)) continue;
					seen.add(key);
					prev.push(line);
				}
				prev.sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
				c.utterances.set(job.filename, prev);
			}
			const { okChunks, okVecs, skipped } = partitionTranscriptReply(
				reply.chunks,
				vecs,
			);
			if (c.dim === 0 && okVecs.length > 0) {
				// Cast: vecs are number arrays (the worker's embedding rows).
				const firstVec = okVecs[0] as ArrayLike<number>;
				c.dim = (firstVec ? firstVec.length : 0) || loadLibrary().dim || 0;
			}
			if (okVecs.length > 0) {
				// Production commit path, extracted pure as
				// applyTranscriptReply (unit-tested in
				// test/transcript-fusion.test.js): accumulate + stamp
				// offsets at rows.length BEFORE pushing.
				const applied = applyTranscriptReply(
					c.videos,
					c.rows,
					job.filename,
					okChunks,
					okVecs,
					TRANSCRIPT_ROW_PER,
				);
				c.videos = applied.videos;
				c.rows = applied.rows;
				c.loaded = true;
				saveTranscripts();
				job.retries = 0;
				console.log(
					`[memories] transcribed ${job.filename}: ${reply.fromIndex}/${reply.total} chunks` +
						(skipped > 0 ? ` (${skipped} skipped)` : ""),
				);
			} else if (skipped > 0) {
				job.retries = 0;
				console.warn(
					`[memories] transcribed ${job.filename}: ${reply.fromIndex}/${reply.total} chunks (all ${skipped} skipped in this chunk, continuing)`,
				);
			}
		} else if (
			reply.ok &&
			(reply.total === 0 || (reply.chunks || []).length === 0)
		) {
			// Silent / no-audio / no-engine: valid empty entry, never retried.
			c.videos.set(job.filename, []);
			if (c.utterances instanceof Map) c.utterances.delete(job.filename);
			if (c.progress && typeof c.progress === "object")
				delete c.progress[job.filename];
			c.loaded = true;
			saveTranscripts();
			console.log(
				`[memories] transcribed ${job.filename}: 0 chunks (silent or no engine)`,
			);
		} else {
			console.warn(
				`[memories] transcription returned no chunks for ${job.filename}: ${reply.error || "unknown"}`,
			);
		}
		if (reply.ok && !reply.done) {
			job.off = reply.fromIndex || 0;
			// Persist the resume point: a crash/exit mid-film re-queues
			// from here instead of abandoning the partial sidecar forever.
			if (!c.progress || typeof c.progress !== "object") c.progress = {};
			c.progress[job.filename] = {
				done: reply.fromIndex || 0,
				total: reply.total || 0,
			};
			saveTranscripts();
			scheduleTranscription();
			return;
		}
		if (reply.ok && reply.done) {
			// Film complete: clear any resume point (silent films cleared it
			// above; transcribed films clear it here).
			if (c.progress && typeof c.progress === "object")
				delete c.progress[job.filename];
			saveTranscripts();
		}
	} catch (err) {
		const e = err as {
			message?: string;
			code?: string;
			stalledSlice?: number | null;
			exitCode?: number | null;
			signal?: string | null;
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
				`[memories] transcription chunk for ${job.filename} failed after the row was deleted or purged — dropping job`,
			);
			transcribeQueue.shift();
			clearTranscribeProgressFor(job.filename);
			broadcastTranscribeEvent({
				phase: transcribeQueue.length === 0 ? "idle" : "done",
				filename: job.filename,
				pending: transcribeQueue.length,
			});
			scheduleTranscription();
			return;
		}
		job.retries = (job.retries || 0) + 1;
		job.lastError = e.message;
		// Poison-slice advance: a stall names its slice (worker SLICE_STALL
		// report, pump watchdog kill, or chunk-timeout fallback). Record it
		// so the retry gaps it instead of replaying the identical wedge —
		// without this, attempts 2/3 and 3/3 re-run the same poison slice
		// and every relaunch resumes into the same wall. Persisted into the
		// sidecar progress so a relaunch inherits the skips via backfill.
		let stalledSlice = Number.isInteger(e.stalledSlice) ? e.stalledSlice : null;
		if (
			stalledSlice === null &&
			(e.code === "TRANSCRIBE_STALL" || e.code === "TRANSCRIBE_TIMEOUT") &&
			Number.isInteger(lastTranscribeSlice) &&
			lastTranscribeSlice !== null &&
			lastTranscribeSlice >= (job.off || 0)
		) {
			stalledSlice = lastTranscribeSlice;
		}
		if (stalledSlice !== null) {
			if (!Array.isArray(job.skipSlices)) job.skipSlices = [];
			job.skipSlices = addSkippedSlice(job.skipSlices, stalledSlice);
			try {
				const pm = loadLibrary().modelId;
				const c = loadTranscripts(pm);
				if (!c.progress || typeof c.progress !== "object") c.progress = {};
				const prev = c.progress[job.filename] || {};
				c.progress[job.filename] = {
					done: Number.isFinite(prev.done) ? prev.done : job.off || 0,
					total: Number.isFinite(prev.total) ? prev.total : 0,
					skipped: job.skipSlices.slice(),
				};
				saveTranscripts();
			} catch {
				/* skip persistence is best-effort; the in-memory list still applies */
			}
		}
		// Attribute the failure: model (last tick's stamp, else current
		// setting), load-vs-decode phase (any transcribe-phase tick for this
		// job proves decode started), exit cause, and heartbeat silence.
		// The old line logged only err.message, so four identical
		// "Transcribe worker exited" retries were indistinguishable from
		// four different transient slices.
		const matchingProg =
			lastTranscribeProgress && lastTranscribeProgress.filename === job.filename
				? lastTranscribeProgress
				: null;
		const modelForLabel =
			(matchingProg && matchingProg.model) ||
			lastTranscribeModel ||
			readWhisperModel();
		const phaseForLabel = job.hadProgress
			? "transcribe"
			: matchingProg
				? matchingProg.phase || null
				: null;
		const loadPhase = isLoadPhaseCrash({
			hadProgress: job.hadProgress,
			phase: phaseForLabel,
		});
		const hbAge =
			lastTranscribeHeartbeatAt > 0
				? Date.now() - lastTranscribeHeartbeatAt
				: null;
		let sizeLabel: string | null = null;
		try {
			const st = fs.statSync(job.path);
			if (st && Number.isFinite(st.size))
				sizeLabel = `${(st.size / 1048576).toFixed(1)}MB`;
		} catch {
			sizeLabel = "size unknown";
		}
		const detail = transcribeFailureLabel({
			model: modelForLabel,
			phase: loadPhase ? "load" : "decode",
			code: e.exitCode,
			signal: e.signal,
			heartbeatAgeMs: hbAge,
		});
		// Load-phase crashes are systematic (same weights, same death): one
		// retry, not three full model reloads. Decode-phase keeps the budget.
		const maxForJob = loadPhase
			? TRANSCRIBE_LOAD_MAX_RETRIES
			: TRANSCRIBE_MAX_RETRIES;
		// Too many poison slices means the film (or the machine right now)
		// is systematically undecodable — stop burning the retry budget and
		// drop for this session like an exhausted retry count would.
		const tooManySkips =
			Array.isArray(job.skipSlices) && job.skipSlices.length > 32;
		if (job.retries <= maxForJob && !tooManySkips) {
			console.warn(
				`[memories] transcription chunk ${job.off || 0} for ${job.filename} failed ` +
					`(attempt ${job.retries}/${maxForJob}${loadPhase ? ", load-phase" : ""}) [${detail}]` +
					(sizeLabel ? ` [${sizeLabel}]` : "") +
					(stalledSlice !== null
						? ` [stalled slice ${stalledSlice} — gap on retry]`
						: "") +
					`: ${e.message} — retrying`,
			);
			transcribeInFlight = false;
			if (transcribeTimer) clearTimeout(transcribeTimer);
			transcribeTimer = setTimeout(() => {
				transcribeTimer = null;
				void pumpTranscription();
			}, TRANSCRIBE_RETRY_DELAY_MS * job.retries);
			return;
		}
		console.warn(
			`[memories] transcription failed for ${job.filename} after ${job.retries} attempts [${detail}]` +
				(sizeLabel ? ` [${sizeLabel}]` : "") +
				(job.skipSlices && job.skipSlices.length > 0
					? ` [skipped slices ${job.skipSlices.join(",")}]`
					: "") +
				`: ${e.message} (dropping for this session; backfill retries next launch)`,
		);
		clearTranscribeProgressFor(job.filename);
	} finally {
		transcribeInFlight = false;
	}
	const finished = transcribeQueue.shift();
	if (finished) clearTranscribeProgressFor(finished.filename);
	broadcastTranscribeEvent({
		phase: transcribeQueue.length === 0 ? "idle" : "done",
		filename: job.filename,
		pending: transcribeQueue.length,
	});
	scheduleTranscription();
}

// Live accessors over module state for the stayers (purge, drop, will-quit,
// tray replays). In-place reads/writes only — identities never change.
const isTranscribeInFlight = () => transcribeInFlight;
const setTranscribeInFlight = (v: boolean) => {
	transcribeInFlight = v;
};
const isTranscribePendingQuery = () => transcribePendingQuery;
const setTranscribePendingQuery = (v: boolean) => {
	transcribePendingQuery = v;
};
const getTranscribeTimer = () => transcribeTimer;
const setTranscribeTimer = (v: NodeJS.Timeout | null) => {
	transcribeTimer = v;
};
const getTranscribeWorker = () => transcribeWorker;
const setTranscribeWorkerDead = (v: boolean) => {
	transcribeWorkerDead = v;
};

export {
	transcribeQueue,
	isTranscribeInFlight,
	setTranscribeInFlight,
	isTranscribePendingQuery,
	setTranscribePendingQuery,
	getTranscribeTimer,
	setTranscribeTimer,
	getTranscribeWorker,
	setTranscribeWorkerDead,
	clearTranscribeProgressFor,
	transcribeSnapshot,
	broadcastTranscribeEvent,
	scheduleTranscription,
	enqueueTranscription,
	backfillTranscription,
};

// Phase 1 (pump states): the tray-state IPC lives with its pump (moved
// from main.js — same one-line snapshot serve, no behavior change).
handle("memories:transcribe-state", () => transcribeSnapshot());
