"use strict";
// Phase 1: shared context for main-process extraction (decompose-monoliths plan).
//
// One mutable holder so extracted `main/ipc/*.js` domains can read refs that
// still live in `main.js` (import pipeline, dirs) WITHOUT requiring main.js
// back (which would be a require cycle). Fields are assigned by main.js at
// module load and read by domains AT CALL TIME (never at require time), so
// registration order never matters and handlers only run post-ready.
//
// Rule: add a field here only when the owner cannot move yet. Prefer
// requiring the owning module directly (main-lib/*, indexer/*, electron).
//
// LOAD-ORDER LAW (learned from two boot crashes): fields are assigned by
// main.js during evaluation and read by domains at call time — EXCEPT a
// module-top-level const initializer, which reads at REQUIRE time. A top
// read races stub assignment whenever the module loads early (e.g. via
// another module's require chain). So: NEVER read ctx.* in a top-level
// const/initializer — read inside functions, or make it lazy. The sole
// exception is dataDir, assigned at top beside its const because watched.js
// builds WATCHED_FOLDERS_FILE at require time.

module.exports = {
	// async (files: string[]) => import result. Assigned by main.js after
	// `importPaths` is defined; read lazily by main/ipc/youtube.js.
	importPaths: null,
	// Absolute library photos dir (path.join(DATA_DIR, "photos")).
	// Assigned by main.js; read lazily by main/ipc/youtube.js.
	photosDir: null,
	// (filename) => boolean video-extension check. Owned by main.js
	// (used across import/rank/protocol); read lazily by main/ipc/llm-ask.js.
	isVideo: null,
	// Window + chrome-mode helpers owned by main.js (hoisted function
	// declarations; assigned at the chrome-settings stub site, read at call
	// time by main/ipc/chrome-settings.js):
	// () => BrowserWindow | null — the live main window, if any.
	liveMainWindow: null,
	// () => void — show + focus + steal the main window.
	showAndFocusMain: null,
	// (enabled: boolean) => boolean — apply menu-bar-only mode live.
	applyMenuBarMode: null,
	// Absolute library dir — assigned at TOP beside the const (not at a
	// stub): watched.js reads it in a top-level initializer and loads via
	// import.js's chain before any stub runs.
	dataDir: null,
	// () => boolean — import-pipeline busy flag (thunk over main.js `let`
	// importInFlight; same convention as the watched smoke ctx).
	isImportInFlight: null,
	// () => migration state or null (thunk over main.js `let`
	// migrationState; truthy while a model migration owns the pipeline).
	getMigrationState: null,
	// Pool (indexer worker) refs owned by main.js, read at call time by
	// main/ipc/rank-moments.js (and the pumps). indexerReady is a
	// reassigned `let`, so it rides a thunk; the rest are hoisted function
	// declarations. askPrimaryIndexer / restartPrimaryIndexer serve the
	// enrich pump's chunk round trips and wedged-ffmpeg recovery.
	spawnIndexer: null,
	getIndexerReady: null,
	askIndexer: null,
	indexerEnv: null,
	askPrimaryIndexer: null,
	restartPrimaryIndexer: null,
	// Pool refs (bindings live in main/ipc/pool.js since the pool slice;
	// assigned at the pool stub). stopIndexerPool / modelDownloaded /
	// poolModelId serve the migration module + restore path.
	stopIndexerPool: null,
	modelDownloaded: null,
	poolModelId: null,
	// Migration-owned pin (binding lives in main/ipc/migration.js;
	// assigned at module top; read at call time by poolModelId).
	getWorkerModelId: null,
	// calibrateThresholds stays in main.js (versions area); the migration
	// module reads it via this slot, assigned at the migration stub.
	calibrateThresholds: null,
	// () => Error | null init-failure flag (thunk over the pool's `let`;
	// read by the import batch fail-fast path).
	getIndexerInitFailed: null,
	// Pool size const (copied once) for the import batch concurrency.
	indexerPoolSize: null,
	// Enrich-pump reads + query-priority writes for the embed-query lane.
	// enrichQueue is never reassigned (mutated), but a thunk keeps the read
	// live regardless; enrichInFlight is a reassigned `let`, so thunk-only.
	// The three set*PendingQuery setters flip main.js `let` booleans.
	getEnrichQueue: null,
	isEnrichInFlight: null,
	setEnrichPendingQuery: null,
	setOcrPendingQuery: null,
	setTranscribePendingQuery: null,
	broadcastEnrichEvent: null,
	// Cross-pump gate reads (bindings stay in main.js until their pump
	// moves; thunks keep the reads live). isTranscribePendingQuery serves
	// the enrich gate; the ocr/transcribe gates read the enrich slots.
	isTranscribePendingQuery: null,
	// Session-wide pump gates staying in main.js for now (transfer with
	// the tray/core slice): backgroundPaused + purgeEpoch. The versions
	// module bumps the epoch via bumpPurgeEpoch (assigned beside the lets).
	isBackgroundPaused: null,
	getPurgeEpoch: null,
	bumpPurgeEpoch: null,
	// Tray + row helpers owned by main.js (hoisted fns / stable consts),
	// read at call time by the pumps.
	updateTrayState: null,
	maybeNotify: null,
	libraryHasRow: null,
	postersDir: null,
	// Transcribe pump's pool-adjacent refs (bindings stay in main.js):
	// () => boolean over the OCR `let` for the transcribe gate.
	isOcrPendingQuery: null,
	// Chrome (window/tray/dock/icon) state. The lets stay in main.js (quit
	// flow + top icon init own them); the chrome module reads/writes them
	// here at call time. Assigned at the chrome stub beside the lets.
	getMainWindowRef: null,
	setMainWindowRef: null,
	setIsQuitting: null,
	isMenuBarOnlyEnabled: null,
	setMenuBarOnlyEnabled: null,
	getAppIconImage: null,
	setAppIconImage: null,
	getCurrentAppIconId: null,
	setCurrentAppIconId: null,
	getPendingDockIcon: null,
	setPendingDockIcon: null,
	getPendingDockIconId: null,
	setPendingDockIconId: null,
	loadAppIconImage: null,
	settingsFile: null,
	appDirname: null,
	// (map, pid, label) => void ffmpeg-child trackers (hoisted fns).
	trackFfmpegSpawn: null,
	untrackFfmpegExit: null,
	// Stable pid map owned by the pool section (const Map, never replaced).
	transcribeFfmpegPids: null,
	// Import-pipeline file hasher (hoisted fn) for the OCR hash backfill.
	hashFile: null,
	// Protocol serving (bindings stay in main.js; assigned at the protocol
	// stub): stable path consts (copied once), preview + content-type
	// helpers (hoisted fns), quit flag (thunk over the lifecycle `let`).
	rendererDir: null,
	thumbsDir: null,
	ensurePreview: null,
	imageContentType: null,
	isQuitting: null,
	// Import-owned shared infra (bindings live in main/ipc/import.js):
	// stable extension Sets (copied once, never mutated).
	importExtensions: null,
	videoExtensions: null,
	imageExtensions: null,
	// (destVideoPath) => Promise<posterPath> video-poster extractor
	// (hoisted async fn, shared with the import batch).
	generatePoster: null,
	// (filename) => poster path helper (hoisted fn) for row deletes.
	posterFor: null,
};
