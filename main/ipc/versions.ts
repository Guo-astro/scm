// Phase 1 (versions): pure move from main.js (2026-10-10) — embedding
// versions (CRUD handlers), purge-background + library-reset (shared
// purgeBackgroundWork core, pruneOrphanSidecars). No behavior change: same
// guards, snapshots, broadcasts. Shared refs still owned by main.js arrive
// via main/context.js and are read AT CALL TIME: isImportInFlight /
// getMigrationState (existing slots), bumpPurgeEpoch (increments main.js's
// purge generation — assigned at the enrich stub beside the lets). Sibling
// domains are required directly (no cycles — none require versions back):
// store sidecars, embedding-versions registry, library-reset sweeper,
// watched rows, all three pumps, pool worker/ffmpeg killers, rank stopper,
// migration worker pin. drainPersistQueue is exported below for quitSmoke /
// will-quit. This module never requires main.js.
import { BrowserWindow, app } from "electron";
import { handle } from "../ipc-wrapper.ts";
import ctx from "../context.ts";
import {
	loadLibrary,
	saveLibrary,
	saveSegments,
	saveTranscripts,
	enqueuePersist,
	libraryIndex,
	resetLibraryCaches,
	resetModelStateCache,
	removeSegmentsForAllModels,
	removeTranscriptsForAllModels,
	loadSegments,
	loadTranscripts,
} from "../../main-lib/library-store.ts";
import { MODELS } from "../../indexer/models.ts";
import {
	listVersions,
	createVersion,
	renameVersion,
	deleteVersion,
	restoreVersion,
} from "../../main-lib/embedding-versions.ts";
import { resetLibraryFiles } from "../../main-lib/library-reset.ts";
import {
	readVideoQuality,
	readWhisperModel,
	readOcrLangs,
} from "../../main-lib/settings.ts";
import { clearCategoryOverrides } from "../../main-lib/category-overrides.ts";
import { clearFailedImports } from "../../main-lib/failed-imports.ts";
import { watchedFolders, removeWatchedFolder } from "./watched.ts";
import {
	enrichQueue,
	isEnrichInFlight,
	getEnrichTimer,
	setEnrichTimer,
	setEnrichInFlight,
	setEnrichNotifyCount,
	deadJobs,
	clearEnrichProgressFor,
	enrichSnapshot,
	broadcastEnrichEvent,
} from "./pumps/enrich.ts";
import {
	transcribeQueue,
	isTranscribeInFlight,
	getTranscribeTimer,
	setTranscribeTimer,
	setTranscribeInFlight,
	clearTranscribeProgressFor,
	getTranscribeWorker,
	setTranscribeWorkerDead,
	transcribeSnapshot,
	broadcastTranscribeEvent,
} from "./pumps/transcribe.ts";
import {
	ocrQueue,
	isOcrInFlight,
	getOcrTimer,
	setOcrTimer,
	setOcrInFlight,
	setOcrTotalCount,
	setOcrDoneCount,
	getLastOcrFile,
	setLastOcrFile,
	killOcrWorker,
	ocrSnapshot,
	broadcastOcrEvent,
} from "./pumps/ocr.ts";
import {
	requestWorkerKillFfmpeg,
	killTrackedFfmpegPids,
	transcribeFfmpegPids,
	restartPrimaryIndexer,
	stopIndexerPool,
} from "./pool.ts";
import { getWorkerModelId, setWorkerModelId } from "./migration.ts";
import { stopRankWorker } from "./rank-moments.ts";

function versionsBusy() {
	if (ctx.isImportInFlight())
		return "An import is in progress — try again when it finishes.";
	if (ctx.getMigrationState())
		return "A model migration is running — try again when it finishes.";
	// A chunk already running must land before snapshotting/restoring
	// (it writes the very sidecars involved) — but only the chunk: queued
	// work behind a user pause is inert and safe to proceed past. A chunk
	// that never lands is what Settings → Video search → "Stop background
	// work" is for. (Library delete purges first and never hits this.)
	if (isEnrichInFlight())
		return "Scene analysis is finishing its current video — try again in a bit, or Stop background work in Settings → Video search to kill it now.";
	if (isTranscribeInFlight())
		return "Transcription is finishing its current video — try again in a bit, or Stop background work in Settings → Video search to kill it now.";
	if (isOcrInFlight())
		return "Text extraction is finishing its current photo — try again in a bit, or Stop background work in Settings → Video search to kill it now.";
	if (!ctx.isBackgroundPaused()) {
		if (enrichQueue.length > 0)
			return "Scene analysis is running — pause it from its tray, or try again when the tray is idle.";
		if (transcribeQueue.length > 0)
			return "Transcription is running — pause it from its tray, or try again when the tray is idle.";
		if (ocrQueue.length > 0)
			return "Text extraction is running — pause it from its tray, or try again when the tray is idle.";
	}
	return null;
}
// Flush every pending persist so a create snapshots coherent on-disk
// state (the pumps write through the same FIFO queue).
async function versionsFlush() {
	await saveLibrary();
	await saveSegments();
	await saveTranscripts();
	await enqueuePersist(() => {});
}

// Drain every save queued so far (same FIFO). Awaiting the returned
// promise guarantees all saves enqueued BEFORE the call have landed;
// the cap keeps a stuck fsync from hanging quit/CI forever.
async function drainPersistQueue(timeoutMs: number) {
	await Promise.race([
		(async () => {
			await saveLibrary();
			await saveSegments();
			await saveTranscripts();
			await enqueuePersist(() => {});
		})(),
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error("persist drain timeout")), timeoutMs),
		),
	]);
}

function versionsSettingsSummary() {
	let videoQuality = null;
	let whisperModel = null;
	let ocrLangs = null;
	try {
		videoQuality = readVideoQuality();
	} catch {
		/* display-only — omit on failure */
	}
	try {
		whisperModel = readWhisperModel();
	} catch {
		/* display-only — omit on failure */
	}
	try {
		ocrLangs = readOcrLangs();
	} catch {
		/* display-only — omit on failure */
	}
	return { videoQuality, whisperModel, ocrLangs };
}

handle("memories:versions-list", () => ({
	ok: true,
	versions: listVersions(),
}));

handle("memories:versions-create", async (_event: unknown, name: unknown) => {
	const busy = versionsBusy();
	if (busy) return { ok: false, error: busy };
	await versionsFlush();
	return createVersion({
		name,
		appVersion: app.getVersion(),
		settings: versionsSettingsSummary(),
		index: libraryIndex(),
	});
});

handle(
	"memories:versions-rename",
	(_event: unknown, slug: unknown, name: unknown) => {
		if (typeof slug !== "string" || !slug) return { ok: false };
		return renameVersion(slug, name);
	},
);

handle("memories:versions-delete", (_event: unknown, slug: unknown) => {
	if (typeof slug !== "string" || !slug) return { ok: false };
	return deleteVersion(slug);
});

handle("memories:versions-restore", async (_event: unknown, slug: unknown) => {
	if (typeof slug !== "string" || !slug) return { ok: false };
	const busy = versionsBusy();
	if (busy) return { ok: false, error: busy };
	// Auto-backup first: restoring overwrites live state, so the current
	// state is snapshotted under a timestamped name — nothing is ever lost.
	// A same-second collision retries with a counter suffix.
	const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
	let backup: {
		ok: boolean;
		error?: string;
		slug?: string;
	} | null = null;
	for (let attempt = 0; attempt < 5; attempt++) {
		const name =
			attempt === 0
				? `auto-backup-${stamp}`
				: `auto-backup-${stamp}-${attempt + 1}`;
		await versionsFlush();
		backup = createVersion({
			name,
			appVersion: app.getVersion(),
			settings: versionsSettingsSummary(),
			index: libraryIndex(),
		});
		if (backup.ok) break;
	}
	if (!backup || !backup.ok) {
		return {
			ok: false,
			error: backup?.error || "Could not back up the current state.",
		};
	}
	const restored = restoreVersion(slug, ctx.photosDir);
	if (!restored.ok) return restored;
	// Reload everything from the restored files: drop all in-memory caches
	// (index, bins, norms, sidecars, threshold calibrations) so the next
	// access rebuilds from disk. If the restored index names a different
	// active model, park the worker pool instead of respawning it here —
	// the next import/query re-forks for the actual model (the same shape
	// the migration-failure path uses).
	resetLibraryCaches();
	resetModelStateCache();
	const l = loadLibrary();
	if (l.modelId !== getWorkerModelId()) {
		stopIndexerPool();
		setWorkerModelId(null);
	}
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send("memories:status", { type: "library-updated" });
	}
	return {
		ok: true,
		backupSlug: backup.slug,
		restored: restored.manifest?.name || slug,
		missing: restored.missing || [],
	};
});
// ---------------------------------------------------------------------------
// Fresh start (Settings → Library → danger zone): delete the entire photo
// index and every derived artifact — rows, bins, scene/speech sidecars,
// app-managed copies, posters, thumbnails, overrides, failure history —
// and stop all watched folders so nothing re-imports on its own. Original
// files are untouched (only the app's copies go); settings, model weights,
// thresholds, saved searches, and embedding versions are kept.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Purge background work (Settings → Video search → maintenance, and the
// tray pills' Pause): one lick clean. Drops every queued pump unit,
// clears tray progress, prunes sidecar entries for rows that no longer
// exist (all models), drops partial sidecars of purged films so the next
// launch backfills them fresh, and restarts the indexer pool + kills the
// OCR/transcribe workers to drop zombie ffmpeg/tesseract work. Queued work
// for VALID rows is safe to drop: the launch backfills re-queue anything
// missing scene/speech/text data. Refused only during import/migration
// (they own the pipeline) — busy pumps are the point, not a blocker.
// In-flight chunks land or fail on their own; the row-gone guards keep
// them from resurrecting anything.
function pruneOrphanSidecars() {
	const rows = new Set(loadLibrary().filenames || []);
	const activeId = loadLibrary().modelId;
	let pruned = 0;
	for (const modelId of Object.keys(MODELS)) {
		const sc = loadSegments(modelId);
		if (sc.loaded) {
			let dropped = false;
			for (const name of [...sc.videos.keys()]) {
				if (!rows.has(name)) {
					sc.videos.delete(name);
					dropped = true;
					pruned++;
				}
			}
			if (dropped) {
				const keep: Float32Array[] = [];
				for (const segs of sc.videos.values()) {
					for (const seg of segs) keep.push(sc.rows[seg.off] as Float32Array);
				}
				sc.rows = keep;
				let off = 0;
				for (const segs of sc.videos.values()) {
					for (const seg of segs) seg.off = off++;
				}
				void saveSegments();
			}
		}
		const tc = loadTranscripts(modelId);
		if (tc.loaded) {
			let dropped = false;
			for (const name of [...tc.videos.keys()]) {
				if (!rows.has(name)) {
					tc.videos.delete(name);
					if (tc.utterances instanceof Map) tc.utterances.delete(name);
					if (tc.progress && typeof tc.progress === "object")
						delete tc.progress[name];
					dropped = true;
					pruned++;
				}
			}
			if (dropped) {
				const keep: Float32Array[] = [];
				for (const chunks of tc.videos.values()) {
					for (const ch of chunks) keep.push(tc.rows[ch.off] as Float32Array);
				}
				tc.rows = keep;
				let off = 0;
				for (const chunks of tc.videos.values()) {
					for (const ch of chunks) ch.off = off++;
				}
				void saveTranscripts();
			}
		}
	}
	// The loop leaves the caches parked on the last model — restore the
	// active pair so ranking serves the right vectors.
	loadSegments(activeId);
	loadTranscripts(activeId);
	return pruned;
}

// Shared core for memories:purge-background and memories:library-reset:
// stop every pump cold and leave the trays idle. Returns { queued, orphans }.
async function purgeBackgroundWork() {
	// Collect first: purged films lose their partial sidecars below so the
	// next launch backfills them fresh instead of stalling on fragments.
	const purged = new Set<string>();
	for (const q of [enrichQueue, transcribeQueue]) {
		for (const job of q) if (job && job.filename) purged.add(job.filename);
	}
	for (const name of ocrQueue) if (typeof name === "string") purged.add(name);
	// Head reads hoist to locals: tsc does not carry `arr[0]?.x` narrowing
	// into the following statement (the guards stay identical).
	const enrichHead = enrichQueue[0];
	if (isEnrichInFlight() && enrichHead?.filename)
		purged.add(enrichHead.filename);
	const transcribeHead = transcribeQueue[0];
	if (isTranscribeInFlight() && transcribeHead?.filename)
		purged.add(transcribeHead.filename);
	if (isOcrInFlight() && typeof ocrQueue[0] === "string")
		purged.add(ocrQueue[0]);
	const queued = purged.size;
	// Invalidate in-flight chunks first: their late replies discard
	// instead of committing (see the purgeEpoch checks in the pumps).
	ctx.bumpPurgeEpoch();
	enrichQueue.length = 0;
	transcribeQueue.length = 0;
	ocrQueue.length = 0;
	for (const t of [getEnrichTimer(), getTranscribeTimer(), getOcrTimer()]) {
		if (t) clearTimeout(t);
	}
	setEnrichTimer(null);
	setTranscribeTimer(null);
	setOcrTimer(null);
	for (const name of purged) {
		clearEnrichProgressFor(name);
		clearTranscribeProgressFor(name);
		removeSegmentsForAllModels(name);
		removeTranscriptsForAllModels(name);
	}
	const lastOcr = getLastOcrFile();
	if (lastOcr && purged.has(lastOcr)) setLastOcrFile(null);
	const orphans = pruneOrphanSidecars();
	// Drop zombie worker/ffmpeg work with the queues: the next pump (or
	// query) re-forks what it needs on demand. Orphan fix: ffmpeg children
	// are SIGKILLed before their Node workers (killing the worker alone
	// orphans ffmpeg to PID 1).
	restartPrimaryIndexer("user purge");
	killOcrWorker();
	stopRankWorker();
	// Worker handle hoists to a local: the getter is a plain reference read
	// (same object across this synchronous block), and tsc does not narrow
	// a fresh call's result from an earlier guard.
	const transcribeWorker = getTranscribeWorker();
	try {
		if (transcribeWorker) {
			requestWorkerKillFfmpeg(
				transcribeWorker,
				transcribeFfmpegPids,
				"user purge",
			);
			try {
				if (transcribeWorker.process) transcribeWorker.process.kill();
			} catch {
				/* already gone */
			}
		} else {
			killTrackedFfmpegPids(transcribeFfmpegPids, "user purge-no-worker");
		}
	} catch {
		/* never forked */
	}
	setTranscribeWorkerDead(true);
	// The killed chunks' promises settle (or time out) on their own — clear
	// the in-flight flags NOW so gates open immediately instead of waiting
	// out a wedged ffmpeg. Late replies discard via purgeEpoch + row
	// checks, and the drained queues can't double-pump, so this is safe.
	setEnrichInFlight(false);
	setTranscribeInFlight(false);
	setOcrInFlight(false);
	// The epoch bump above guards every orphan, so the tombstone set starts
	// fresh: stale entries would otherwise discard legitimate re-queued
	// work for the same filenames after the purge.
	deadJobs.clear();
	// Zero the tray counters with the queues — the pills report these
	// alongside queue length, and pre-purge totals against an empty queue
	// read as stuck work. (The next backfill recounts from zero.)
	setEnrichNotifyCount(0);
	setOcrTotalCount(0);
	setOcrDoneCount(0);
	setLastOcrFile(null);
	broadcastEnrichEvent(enrichSnapshot());
	broadcastTranscribeEvent(transcribeSnapshot());
	broadcastOcrEvent(ocrSnapshot());
	console.log(
		`[memories] background purged: ${queued} queued unit(s), ${orphans} orphan sidecar entr(ies) pruned`,
	);
	return { queued, orphans };
}

handle("memories:purge-background", async () => {
	if (ctx.isImportInFlight())
		return {
			ok: false,
			error: "An import is in progress — try again when it finishes.",
		};
	if (ctx.getMigrationState())
		return {
			ok: false,
			error: "A model migration is running — try again when it finishes.",
		};
	const { queued, orphans } = await purgeBackgroundWork();
	return { ok: true, queued, orphans };
});

handle("memories:library-reset", async () => {
	// Only import/migration block a wipe (they own the pipeline) — pump
	// activity, however wedged, is purged first instead of refusing: a
	// stuck chunk must never veto deleting the library.
	if (ctx.isImportInFlight())
		return {
			ok: false,
			error: "An import is in progress — try again when it finishes.",
		};
	if (ctx.getMigrationState())
		return {
			ok: false,
			error: "A model migration is running — try again when it finishes.",
		};
	// Stop every pump cold first (queues, in-flight flags, zombie workers,
	// orphan sidecars, tray counters) — even on an empty library: wedged
	// flags must not survive a fresh start that reports success. Queued
	// work is meaningless against an empty library, and the purge's epoch
	// guards the late replies.
	await purgeBackgroundWork();
	const rows = loadLibrary().filenames.length;
	if (rows === 0) return { ok: true, rows: 0, unwatched: 0, files: 0 };
	// Stop every watched folder (with proper watcher teardown) so the
	// empty library isn't re-imported behind the user's back.
	let unwatched = 0;
	for (const folder of [...watchedFolders]) {
		if (removeWatchedFolder(folder)) unwatched++;
	}
	// Delete library-state files + app-managed copies, posters, thumbs
	// (memory + disk for the failure/override histories are cleared just
	// below). Settings, weights, thresholds, and versions/ are untouched.
	const { files } = resetLibraryFiles();
	// Forget overrides + failure history (memory and disk).
	clearCategoryOverrides();
	clearFailedImports();
	// Rebuild empty in memory and persist the clean index, then tell the
	// renderer to refetch (grid lands on its empty state). Push idle tray
	// snapshots too — the queues were just drained, and with no further
	// pump ticks coming the pills would otherwise render stale jobs forever.
	resetLibraryCaches();
	await saveLibrary();
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send("memories:status", { type: "library-updated" });
	}
	broadcastEnrichEvent(enrichSnapshot());
	broadcastTranscribeEvent(transcribeSnapshot());
	broadcastOcrEvent(ocrSnapshot());
	return { ok: true, rows, unwatched, files };
});

export { drainPersistQueue };
