"use strict";
// Phase 1 (migration): pure move from main.js (2026-10-10) — model switching
// (re-embed, flip, delta fill, settle, pending-resume, manifest). No behavior
// change: same checkpoints, calibration, broadcasts. Shared refs still owned
// by main.js arrive via main/context.js and are read AT CALL TIME:
// stopIndexerPool / spawnIndexer / askIndexer / modelDownloaded (pool fns,
// assigned here), indexerPoolSize (pool const, assigned here — read at module
// top for MIGRATE_CONCURRENCY), photosDir / isVideo (existing slots).
// Sibling backfills ride the pump modules directly (no cycle). Own state
// (migrationState, fill generation, workerModelId) is exported below for the
// stayers (pool gate, versions restore, set-model/preload handlers, boot,
// e2e ctxs) — same live bindings. This module never requires main.js.
const fs = require("fs");
const path = require("path");
const { utilityProcess, BrowserWindow } = require("electron");
const ctx = require("../context.js");
const {
	loadLibrary,
	saveLibrary,
	thresholdsFor,
	binInfo,
	planDeltaReuse,
	setEmbedIncomplete,
	isZeroVector,
	readBin,
	embedFileFor,
	phraseFileFor,
	writeBins,
	readEmbedMeta,
} = require("../../main-lib/library-store.js");
const {
	getModel,
	MODELS,
} = require("../../indexer/models.js");
const { backfillEnrichment } = require("./pumps/enrich.js");
const { backfillTranscription } = require("./pumps/transcribe.js");

// ---------------------------------------------------------------------------
// Model switching: re-embed the whole library in another model.
//
// The worker pool is respawned with INDEXER_MODEL pinned to the target; each
// row is re-embedded from its ORIGINAL source file (falling back to the
// app-managed library copy) through the same embed-photo path imports use,
// so GIF middle-frame averaging and phrase centering match exactly. The new
// pair is written to the target model's own bin files as the pump advances
// (checkpointed, but the index still names the OLD model — a crash mid-run
// leaves a consistent old-model library; the partial new bins are simply
// overwritten on retry). At the end the library flips: modelId, dim, and
// textMean come from the worker's own outputs, saveLibrary persists the new
// index + bins, and the model is calibrated against its real score band.
// The old model's bins stay on disk (memory-embeddings-<old>.bin), so
// switching back is a re-embed, never a loss.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Model preload ("Download all models"): download a model's weights WITHOUT
// switching the library to it. The user can fetch every model ahead of time
// so switching later is instant (no download wait). Each preload forks a
// THROWAWAY indexer worker pinned to the target model (INDEXER_MODEL) whose
// normal init downloads + warms that model; its download progress relays to
// the renderer as { type: "model-preload", modelId, phase, progress }, and
// the worker is killed once init lands. The library is untouched — the
// weights land in the shared cache, nothing else changes.
// ---------------------------------------------------------------------------

let modelPreloads = new Map(); // modelId → { process, progress }

// Fork one worker, feed it INDEXER_MODEL=modelId so its init downloads the
// target's weights, relay progress, then kill it on init-done. Resolves
// { modelId, downloaded } when the model is on disk (or was already).
function preloadModelWeights(modelId) {
	const config = getModel(modelId);
	if (!config) return Promise.reject(new Error(`Unknown model: ${modelId}`));
	if (ctx.modelDownloaded(modelId)) {
		// Already cached — nothing to do (the UI calls this for every model
		// in "download all"; skipped ones resolve immediately).
		return Promise.resolve({ modelId, downloaded: true, skipped: true });
	}
	// The pool owns the ACTIVE model's download on first run, and a migration
	// pool owns its TARGET's download. Two processes writing the same cache
	// files would race (FileCache.put is a plain write in transformers.js v2
	// and v3 alike — no atomic temp+rename), so never preload those. This
	// guard lives HERE (not just in preloadAllModels) so the single-model IPC
	// can't bypass it.
	if (modelId === ctx.poolModelId()) {
		return Promise.resolve({
			modelId,
			skipped: true,
			note: "active model — the engine is downloading it",
		});
	}
	if (migrationState && migrationState.targetId === modelId) {
		return Promise.resolve({
			modelId,
			skipped: true,
			note: "already downloading — the model switch owns it",
		});
	}
	if (modelPreloads.has(modelId)) return modelPreloads.get(modelId).promise;

	const entry = {
		process: null,
		progress: null,
		promise: null,
	};
	entry.promise = new Promise((resolve, reject) => {
		entry.process = utilityProcess.fork(
			path.join(__dirname, "..", "..", "indexer", "indexer.js"),
			[],
			{
				env: { ...ctx.indexerEnv(), INDEXER_MODEL: modelId },
				serviceName: `clip-preload-${modelId}`,
			},
		);
		entry.process.on("message", (event) => {
			const msg = event && event.data !== undefined ? event.data : event;
			if (!msg) return;
			if (msg.type === "model") {
				entry.progress = msg.progress ?? null;
				for (const win of BrowserWindow.getAllWindows()) {
					win.webContents.send("memories:status", {
						type: "model-preload",
						modelId,
						phase: msg.phase,
						progress: entry.progress,
					});
				}
				// The worker posts phase "error" BEFORE the ok:false reply that
				// carries the real message; don't reject on the bare event or
				// the detailed error is lost.
				return;
			}
			if (msg.ok === false) {
				// Download/load failed — drop the worker and report the real error.
				entry.process.kill();
				modelPreloads.delete(modelId);
				reject(new Error(msg.error || `Preload of ${modelId} failed`));
				return;
			}
			if (msg.type === "init-done" && msg.ok) {
				entry.process.kill();
				modelPreloads.delete(modelId);
				resolve({
					modelId,
					downloaded: ctx.modelDownloaded(modelId),
					skipped: false,
				});
			}
		});
		entry.process.on("exit", () => {
			// Only fatal if the promise is still pending (the normal kill
			// after init-done already resolved it).
			if (modelPreloads.has(modelId)) {
				modelPreloads.delete(modelId);
				reject(new Error(`Preload worker for ${modelId} exited unexpectedly`));
			}
		});
		entry.process.postMessage({ type: "init" });
	});
	modelPreloads.set(modelId, entry);
	return entry.promise;
}

// Fetch every model the app knows about that isn't already on disk. Runs
// sequentially so a slow link doesn't saturate bandwidth across models, and
// each already-downloaded model resolves instantly. The ACTIVE model is
// skipped when its weights are missing — the primary pool owns that download
// on first run, and a parallel writer to the same cache files would race it.
// Resolves to an array of per-model results ({ modelId, downloaded, skipped? }).
async function preloadAllModels() {
	// preloadModelWeights itself skips the active/migration-owned models, so
	// this loop is a plain sequential fan-out over the registry.
	const results = [];
	for (const modelId of Object.keys(MODELS)) {
		try {
			results.push(await preloadModelWeights(modelId));
		} catch (err) {
			results.push({ modelId, error: err.message });
		}
	}
	return results;
}

// A migration is in flight; further switches are refused until it settles.
// A background delta tail (kind "fill") is the exception: a new switch
// cancels it (generation bump — its checkpoints stay on disk and the next
// delta resumes them) and proceeds.
let migrationState = null;
let migrationFillGeneration = 0;

// How often (rows) a running migration writes the target's bins to disk.
const MIGRATE_CHECKPOINT = 25;

// The file a row's embedding was computed from at import. The recorded
// source may have moved away; the app-managed copy is the fallback.
function rowSourcePath(i) {
	const l = loadLibrary();
	const source = l.sources && l.sources[i];
	if (source && fs.existsSync(source)) return source;
	return path.join(ctx.photosDir, l.filenames[i]);
}

// Re-embed every row of the library into `targetId`'s model. Resolves to
// { modelId, reembedded, failures } or throws on a blocking error. Progress
// is broadcast as { type: "migrate", phase, done, total, modelId }.
// Bounded-concurrency pump, sized like the import pipeline (pool×2).
// Read at call time (never at module top): the pool stub assigns this slot
// while the module graph is still loading, so a top-level read would race it.
function migrateConcurrency() {
	return Math.max(2, ctx.indexerPoolSize * 2);
}
async function reembedToModel(targetId) {
	const target = getModel(targetId);
	if (!target) throw new Error(`Unknown model: ${targetId}`);
	// An in-flight import embeds rows through the pool, which a migration
	// pins to the TARGET model — those rows would land as target-model
	// vectors in a library that still names the old one. Refuse to start
	// until the batch settles.
	if (ctx.isImportInFlight()) {
		throw new Error(
			"An import is in progress — switch models after it finishes.",
		);
	}
	const l = loadLibrary();
	const pendingRetirement = l.pendingModelMigration;
	if (pendingRetirement && pendingRetirement.targetId !== targetId) {
		throw new Error(
			`The retired ${pendingRetirement.fromId} index must finish migrating to ${pendingRetirement.targetId} first.`,
		);
	}
	if (l.modelId === targetId && !pendingRetirement)
		return { modelId: targetId, reembedded: 0, failures: [] };
	if (migrationState) {
		if (migrationState.kind === "fill") {
			migrationFillGeneration++;
			migrationState = null;
		} else {
			throw new Error("A model migration is already running");
		}
	}
	if (l.filenames.length === 0) {
		// No rows to re-embed — the switch is just a metadata flip.
		l.modelId = targetId;
		l.dim = getModel(targetId).dim || l.dim;
		l.textMean = null;
		l.pendingModelMigration = null;
		await saveLibrary();
		console.log(`[memories] switched empty library to ${targetId}`);
		for (const win of BrowserWindow.getAllWindows()) {
			win.webContents.send("memories:status", { type: "library-updated" });
		}
		return { modelId: targetId, reembedded: 0, failures: [] };
	}

	const total = l.filenames.length;
	migrationState = { targetId, done: 0, total };
	const broadcast = (phase, extra = {}) => {
		for (const win of BrowserWindow.getAllWindows()) {
			win.webContents.send("memories:status", {
				type: "migrate",
				phase,
				modelId: targetId,
				done: migrationState.done,
				total,
				...extra,
			});
		}
	};
	broadcast("embedding", { done: 0 });

	// Respawn the pool for the target model and wait for its model (a first
	// use downloads the weights here — the status LED shows that progress).
	ctx.stopIndexerPool();
	workerModelId = targetId;
	ctx.spawnIndexer();
	let initMsg;
	try {
		initMsg = await ctx.getIndexerReady();
	} catch (err) {
		// The respawned pool runs (or failed to run) the TARGET model. Put it
		// down so the next import/query re-forks for the library's actual
		// model — a live target-model pool here would embed later rows in the
		// wrong model.
		ctx.stopIndexerPool();
		workerModelId = null;
		migrationState = null;
		throw new Error(`Failed to load model ${targetId}: ${err.message}`, {
			cause: err,
		});
	}
	const dim = Number(initMsg.dim) > 0 ? initMsg.dim : l.dim;

	// Fast path — the target model's bins already exist and match this
	// library's row count and dim (a previous switch, or a pre-v4 legacy
	// pair). Flip to them instead of re-embedding every row, so switching is
	// truly instant (the picker advertises exactly this). The pool is already
	// running the target model (respawned above), so textMean and dim come
	// from its live output; the target's own phrase bin is used when present
	// (otherwise the renderer degrades to image-only ranking, same as the
	// heal path). The old model's pair is untouched — switching back and
	// forth never re-does work or loses data.
	const existing = binInfo(targetId);
	if (
		existing &&
		existing.rows === l.filenames.length &&
		existing.dim === dim
	) {
		const embeddings = readBin(embedFileFor(targetId), l.filenames.length, dim);
		const phrases = readBin(phraseFileFor(targetId), l.filenames.length, dim);
		// The phrase bin must ALSO match: the slow migration always writes both
		// pairs, so a target with matching embed rows but a missing/mismatched
		// phrase bin is a partial/corrupt state — flipping to it would silently
		// degrade ranking to image-only. Fall through to the re-embed (which
		// rebuilds and heals) instead.
		if (
			embeddings.length === l.filenames.length &&
			phrases.length === l.filenames.length
		) {
			let textMean = null;
			try {
				const tm = await ctx.askIndexer({ type: "get-text-mean" });
				if (tm.ok && Array.isArray(tm.textMean)) {
					textMean = new Float32Array(tm.textMean);
				}
			} catch (err) {
				console.warn(
					`[memories] textMean fetch failed (${err.message}); uncentered queries`,
				);
			}
			l.embeddings = embeddings;
			l.phrases = phrases;
			l.dim = dim;
			l.textMean = textMean;
			l.modelId = targetId;
			l.pendingModelMigration = null;
			workerModelId = null;
			await saveLibrary();
			console.log(
				`[memories] switched ${l.filenames.length} rows to ${targetId} from existing bins ` +
					"(instant, no re-embed)",
			);
			migrationState = null;
			for (const win of BrowserWindow.getAllWindows()) {
				win.webContents.send("memories:status", { type: "library-updated" });
			}
			try {
				await ctx.calibrateThresholds(targetId);
			} catch (err) {
				console.warn(`[memories] threshold calibration failed: ${err.message}`);
			}
			try {
				backfillEnrichment();
				backfillTranscription();
			} catch (err) {
				console.warn(
					`[memories] post-migration scene backfill skipped: ${err.message}`,
				);
			}
			return { modelId: targetId, reembedded: 0, failures: [], instant: true };
		}
	}

	// Delta path — the target's bins exist with a row-identity snapshot from
	// a previous switch (same pipeline version): flip to the reused rows NOW
	// and embed only the missing tail in the background, so a switch after N
	// new imports costs N embeds instead of the whole library. Falls through
	// to the foreground slow path when there is nothing reusable (first
	// switch, pipeline change, or unreadable bins).
	const delta = planDeltaReuse(targetId, dim, [...l.filenames]);
	if (delta.usable && delta.reused > 0) {
		return flipWithBackgroundFill(targetId, dim, delta, broadcast, total);
	}

	// Snapshot the row set: if an import lands mid-migration the flip below
	// aborts rather than misaligning (the old model's library stays intact).
	// The snapshot ALSO pairs every checkpoint's bins with the row identity
	// they align to (delta resumes from them), and the flip verifies identity
	// — not just length — so a same-length delete+import can't silently
	// misalign vectors.
	const rowCount = l.filenames.length;
	const rowFilenames = [...l.filenames];
	// Dense from the start: checkpointed writeBins mid-migration must never
	// see sparse holes (.map skips holes, so Buffer.concat would throw on
	// the unwritten tail). Unwritten rows read as zero vectors until their
	// reply lands — same contract as failed rows below.
	const newEmbeddings = new Array(rowCount).fill(null);
	const newPhrases = new Array(rowCount).fill(null);
	const failures = [];
	let next = 0;
	let inFlight = 0;
	// Checkpoints below carry partial target-model vectors: stamp them
	// incomplete so a crash resumes the tail (delta) instead of serving
	// zeros as final. Cleared before the final save at the flip.
	setEmbedIncomplete(targetId, true);

	await new Promise((resolveBatch) => {
		const pump = () => {
			while (inFlight < migrateConcurrency() && next < rowCount) {
				const i = next++;
				inFlight++;
				(async () => {
					try {
						const filename = l.filenames[i];
						// Videos go through the video path (ffmpeg frame
						// extraction); sharp cannot decode a video file, so
						// embedding one as a photo always fails and zeroes
						// the row. Photos use the same embed path imports do
						// (GIF middle-frame averaging included).
						const reply = await ctx.askIndexer({
							type: ctx.isVideo(filename) ? "embed-video" : "embed-photo",
							path: rowSourcePath(i),
							filename,
						});
						// Failed rows persist as explicit zero vectors (not
						// undefined) so every row keeps a real, aligned array
						// and encodeBin has nothing to guess about.
						if (reply.vec && reply.vec.length === dim) {
							newEmbeddings[i] = new Float32Array(reply.vec);
						} else {
							failures.push(`${filename}: empty or wrong-dim vector`);
							newEmbeddings[i] = new Float32Array(dim);
						}
						if (reply.phrase && reply.phrase.length === dim) {
							newPhrases[i] = new Float32Array(reply.phrase);
						} else {
							if (reply.phrase) {
								failures.push(`${filename}: wrong-dim phrase`);
							}
							newPhrases[i] = new Float32Array(dim);
						}
					} catch (err) {
						failures.push(`${l.filenames[i]}: ${err.message}`);
					} finally {
						inFlight--;
						migrationState.done++;
						if (migrationState.done % MIGRATE_CHECKPOINT === 0) {
							void writeBins(targetId, newEmbeddings, newPhrases, dim, dim, {
								filenames: rowFilenames,
								incomplete: true,
							});
						}
						broadcast("embedding");
						pump();
						if (migrationState.done >= rowCount && inFlight === 0) {
							resolveBatch();
						}
					}
				})();
			}
		};
		pump();
	});

	if (failures.length === rowCount) {
		// Same as the model-load failure: never leave a pool forked for the
		// target model behind a library that still names the old one.
		ctx.stopIndexerPool();
		workerModelId = null;
		migrationState = null;
		throw new Error(
			`Migration to ${targetId} failed for every row: ${failures[0]}`,
		);
	}

	// Flip. If the library changed while we worked, refuse the flip — the
	// new rows have no vectors in the target model yet (the old model stays).
	// Identity, not just length: a delete+import of equal length would pass a
	// length check with misaligned vectors.
	if (
		l.filenames.length !== rowCount ||
		rowFilenames.some((f, i) => f !== l.filenames[i])
	) {
		// Same as the model-load failure: never leave a pool forked for the
		// target model behind a library that still names the old one.
		// (The checkpoints already on disk stay resumable via delta.)
		ctx.stopIndexerPool();
		workerModelId = null;
		migrationState = null;
		throw new Error(
			`Library changed during migration (${rowCount} → ${l.filenames.length}); ` +
				"run the model switch again",
		);
	}

	// The worker computed the target model's shared text direction at load.
	let textMean = null;
	try {
		const tm = await ctx.askIndexer({ type: "get-text-mean" });
		if (tm.ok && Array.isArray(tm.textMean)) {
			textMean = new Float32Array(tm.textMean);
		}
	} catch (err) {
		console.warn(
			`[memories] textMean fetch failed (${err.message}); uncentered queries`,
		);
	}

	l.embeddings = newEmbeddings;
	l.phrases = newPhrases;
	l.dim = dim;
	l.textMean = textMean;
	l.modelId = targetId;
	l.pendingModelMigration = null;
	workerModelId = null;
	// All rows landed: the final save stamps the meta complete.
	setEmbedIncomplete(targetId, false);
	await saveLibrary();

	console.log(
		`[memories] migrated ${rowCount - failures.length}/${rowCount} rows to ${targetId} ` +
			`(dim ${dim}, failures ${failures.length})`,
	);
	// The final "indexing" event reads migrationState.done (== total), so it
	// must fire BEFORE the state is cleared.
	broadcast("indexing");
	migrationState = null;
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send("memories:status", { type: "library-updated" });
	}

	// Calibrate the target's thresholds against its real score band (no-op
	// when the library is too small to measure).
	try {
		await ctx.calibrateThresholds(targetId);
	} catch (err) {
		console.warn(`[memories] threshold calibration failed: ${err.message}`);
	}

	// Phase 5: segment sidecars are per-model, so the target's is empty
	// after a migration — re-run the launch backfill so videos regain scene
	// coverage without waiting for the next app launch. Enrichment is gated
	// on !migrationState, so it queues safely behind nothing here.
	try {
		backfillEnrichment();
		backfillTranscription();
	} catch (err) {
		console.warn(
			`[memories] post-migration scene backfill skipped: ${err.message}`,
		);
	}

	return {
		modelId: targetId,
		reembedded: rowCount - failures.length,
		failures,
	};
}

// Delta switch (Option A): flip the library to the target model using cached
// rows NOW, then embed only the missing tail in the background. The switch
// promise resolves at the flip — search works immediately across reused rows
// (missing rows read as zero vectors until their tail lands, the same
// contract as failed rows) — while migrate-phase "embedding" events keep the
// tray informed until the tail completes with "indexing" + library-updated.
// Resolves to { modelId, reembedded: 0, reused, pending, failures: [],
// delta: true }; callers that need the settled state await
// migrationSettled().
async function flipWithBackgroundFill(targetId, dim, delta, broadcast, total) {
	const l = loadLibrary();
	const missing = [...delta.missing];
	// Dense flip: reused rows keep their cached vectors; missing rows are
	// explicit zero vectors until the background tail lands.
	l.embeddings = delta.reusedEmbeddings.map((v) => v || new Float32Array(dim));
	l.phrases = delta.reusedPhrases.map((v) => v || new Float32Array(dim));
	let textMean = null;
	try {
		const tm = await ctx.askIndexer({ type: "get-text-mean" });
		if (tm.ok && Array.isArray(tm.textMean)) {
			textMean = new Float32Array(tm.textMean);
		}
	} catch (err) {
		console.warn(
			`[memories] textMean fetch failed (${err.message}); uncentered queries`,
		);
	}
	l.dim = dim;
	l.textMean = textMean;
	l.modelId = targetId;
	l.pendingModelMigration = null;
	workerModelId = null;
	// Stamp incomplete BEFORE the save so the on-disk meta says resumable
	// even if the app quits mid-tail.
	setEmbedIncomplete(targetId, true);
	await saveLibrary();
	console.log(
		`[memories] switched ${l.filenames.length} rows to ${targetId} ` +
			`(delta: ${delta.reused} reused, ${missing.length} filling in background)`,
	);
	const gen = ++migrationFillGeneration;
	migrationState = {
		targetId,
		done: delta.reused,
		total,
		kind: "fill",
		gen,
	};
	broadcast("embedding");
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send("memories:status", { type: "library-updated" });
	}
	// Detached: the switch is done at the flip; the tail reports through the
	// same migrate events and settles migrationState when it lands.
	void runDeltaFill(targetId, dim, missing, gen, broadcast);
	return {
		modelId: targetId,
		reembedded: 0,
		reused: delta.reused,
		pending: missing.length,
		failures: [],
		delta: true,
	};
}

// Background tail of a delta switch: embed the missing filenames through the
// target-model pool (already running — the switch respawned it), resolving
// each row's index LIVE by filename so imports/deletes/reorders mid-fill
// can't misalign vectors. Rows that gained real vectors meanwhile (an import
// embedding through the active pool) are skipped, never clobbered.
async function runDeltaFill(targetId, dim, missing, gen, broadcast) {
	const failures = [];
	let next = 0;
	let inFlight = 0;
	let done = 0;
	const alive = () => gen === migrationFillGeneration;
	await new Promise((resolveFill) => {
		const pump = () => {
			if (!alive()) return resolveFill();
			if (missing.length === 0) return resolveFill();
			while (inFlight < migrateConcurrency() && next < missing.length) {
				const filename = missing[next++];
				inFlight++;
				(async () => {
					try {
						if (!alive()) return;
						const cur = loadLibrary();
						const idx = cur.filenames.indexOf(filename);
						if (idx === -1) return; // deleted mid-fill
						const existing = cur.embeddings[idx];
						// An import embedded this row through the active
						// (target-model) pool while we queued — keep it.
						if (existing && !isZeroVector(existing)) return;
						const reply = await ctx.askIndexer({
							type: ctx.isVideo(filename) ? "embed-video" : "embed-photo",
							path: rowSourcePathAt(cur, idx),
							filename,
						});
						if (!alive()) return;
						const after = loadLibrary();
						const at = after.filenames.indexOf(filename);
						if (at === -1) return; // deleted while embedding
						if (reply.vec && reply.vec.length === dim) {
							after.embeddings[at] = new Float32Array(reply.vec);
						} else {
							failures.push(`${filename}: empty or wrong-dim vector`);
							after.embeddings[at] = new Float32Array(dim);
						}
						if (reply.phrase && reply.phrase.length === dim) {
							after.phrases[at] = new Float32Array(reply.phrase);
						} else {
							if (reply.phrase) {
								failures.push(`${filename}: wrong-dim phrase`);
							}
							after.phrases[at] = new Float32Array(dim);
						}
					} catch (err) {
						if (alive()) failures.push(`${filename}: ${err.message}`);
					} finally {
						inFlight--;
					}
					if (!alive()) {
						if (inFlight === 0) resolveFill();
					} else {
						done++;
						if (migrationState) migrationState.done++;
						if (done % MIGRATE_CHECKPOINT === 0) {
							const snap = loadLibrary();
							void writeBins(
								targetId,
								snap.embeddings,
								snap.phrases,
								dim,
								dim,
								{
									filenames: [...snap.filenames],
									incomplete: true,
								},
							);
						}
						broadcast("embedding");
						pump();
						if (done >= missing.length && inFlight === 0) resolveFill();
					}
				})();
			}
		};
		pump();
	});
	// Superseded by a newer switch — it owns the state now; our checkpoints
	// stay on disk for the next delta to resume.
	if (!alive()) return;
	if (loadLibrary().modelId !== targetId) return;
	const filled = missing.length - failures.length;
	setEmbedIncomplete(targetId, false);
	await saveLibrary();
	console.log(
		`[memories] delta fill for ${targetId} complete: ${filled}/${missing.length} rows ` +
			`(failures ${failures.length})`,
	);
	// The final "indexing" event reads migrationState.done, so it must fire
	// BEFORE the state is cleared (same contract as the slow path).
	broadcast("indexing");
	migrationState = null;
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send("memories:status", { type: "library-updated" });
	}
	// Calibrate against the now-complete vectors (skipped at the flip: zeros
	// would have skewed the score band).
	try {
		await ctx.calibrateThresholds(targetId);
	} catch (err) {
		console.warn(`[memories] threshold calibration failed: ${err.message}`);
	}
	// Scene/transcript sidecars are per-model: re-queue coverage for the
	// target now that its vectors are final (same as the slow path).
	try {
		backfillEnrichment();
		backfillTranscription();
	} catch (err) {
		console.warn(
			`[memories] post-migration scene backfill skipped: ${err.message}`,
		);
	}
}

// Scripts/tests: resolve once no migration or delta fill is in flight (the
// delta switch promise resolves at the flip; this waits for the tail).
function migrationSettled() {
	if (!migrationState) return Promise.resolve();
	return new Promise((resolve) => {
		const t = setInterval(() => {
			if (!migrationState) {
				clearInterval(t);
				resolve();
			}
		}, 250);
	});
}

// rowSourcePath for a live library snapshot + resolved index (the delta fill
// re-resolves indices by filename, so it can't use the index-based helper).
function rowSourcePathAt(lib, idx) {
	const source = lib.sources && lib.sources[idx];
	if (source && fs.existsSync(source)) return source;
	return path.join(ctx.photosDir, lib.filenames[idx]);
}

// Launch resume: a previous run quit (or crashed) mid-fill, leaving
// incomplete:true in the active model's meta. Resume the tail instead of
// serving zeros as final. Called after the pool is warm, beside the scene
// backfills.
async function maybeResumeDeltaFill() {
	if (migrationState) return;
	let l;
	try {
		l = loadLibrary();
	} catch {
		return;
	}
	if (l.pendingModelMigration) return;
	if (l.filenames.length === 0 || !(l.dim > 0)) return;
	let meta;
	try {
		meta = readEmbedMeta(l.modelId);
	} catch {
		return;
	}
	if (!meta || meta.incomplete !== true) return;
	const delta = planDeltaReuse(l.modelId, l.dim, [...l.filenames]);
	if (!delta.usable || delta.missing.length === 0) {
		// Nothing to resume. When the vectors are complete (missing==0) the
		// stale flag is wrong — clear it and persist complete. When unusable
		// (no meta match), leave the flag: the next switch falls back to the
		// foreground path, which repairs everything.
		if (delta.usable) {
			setEmbedIncomplete(l.modelId, false);
			try {
				await saveLibrary();
			} catch {
				/* best-effort flag repair */
			}
		}
		return;
	}
	if (delta.reused === 0) return; // degenerate: leave it to a real switch
	const gen = ++migrationFillGeneration;
	setEmbedIncomplete(l.modelId, true);
	migrationState = {
		targetId: l.modelId,
		done: delta.reused,
		total: l.filenames.length,
		kind: "fill",
		gen,
	};
	console.log(
		`[memories] resuming interrupted fill for ${l.modelId}: ` +
			`${delta.reused} rows ok, ${delta.missing.length} to embed`,
	);
	const resumeModelId = l.modelId;
	const resumeDim = l.dim;
	const broadcast = (phase, extra = {}) => {
		for (const win of BrowserWindow.getAllWindows()) {
			win.webContents.send("memories:status", {
				type: "migrate",
				phase,
				modelId: resumeModelId,
				done: migrationState ? migrationState.done : l.filenames.length,
				total: l.filenames.length,
				...extra,
			});
		}
	};
	void runDeltaFill(
		resumeModelId,
		resumeDim,
		[...delta.missing],
		gen,
		broadcast,
	);
}

// Retired/unknown model ids are detected by loadLibrary without changing the
// persisted index. Once the replacement worker is ready, run the normal
// checkpointed migration. A failed download or re-embed leaves that original
// disk state untouched, so the next launch can retry safely.
async function migratePendingModel() {
	const pending = loadLibrary().pendingModelMigration;
	if (!pending) return null;
	console.log(
		`[memories] migrating retired ${pending.fromId} library to ${pending.targetId}`,
	);
	return reembedToModel(pending.targetId);
}

// The manifest the renderer fetches from /memories-models.json: registry
// info + per-model state, enough to render the model picker and rank with
// the active model's thresholds.
function modelsManifest() {
	const l = loadLibrary();
	return {
		version: 1,
		activeModelId: l.modelId,
		models: Object.entries(MODELS).map(([id, config]) => {
			const bin = binInfo(id);
			return {
				id,
				label: config.label,
				description: config.description,
				dim: config.dim,
				inputSize: config.inputSize,
				license: config.license,
				speed: config.speed,
				quality: config.quality,
				thresholds: thresholdsFor(id),
				binCount: bin ? bin.rows : 0,
				calibrated: Boolean(thresholdsFor(id)),
				// True when the model's weights are on disk (drives the picker's
				// per-model Download chip + the "download all" affordance).
				downloaded: ctx.modelDownloaded(id),
			};
		}),
	};
}

// Live accessors over module state for the stayers (pool gate, versions
// restore, set-model handler). In-place reads/writes only. workerModelId
// moved here with the module (poolModelId + restore read it via getters).
let workerModelId = null;
const getMigrationState = () => migrationState;
// Shared slot (pumps + rank + import read it at call time via ctx).
ctx.getMigrationState = getMigrationState;
const getWorkerModelId = () => workerModelId;
const setWorkerModelId = (v) => {
	workerModelId = v;
};

module.exports = {
	reembedToModel,
	preloadModelWeights,
	preloadAllModels,
	modelPreloads,
	migrationSettled,
	migratePendingModel,
	maybeResumeDeltaFill,
	modelsManifest,
	getMigrationState,
	getWorkerModelId,
	setWorkerModelId,
};

// Shared slot, assigned after the accessors above (poolModelId reads it at
// call time via ctx; assigning earlier would hit the const TDZ).
ctx.getWorkerModelId = getWorkerModelId;
