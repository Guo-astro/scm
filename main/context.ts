// Phase 1: shared context for main-process extraction (decompose-monoliths plan).
//
// One mutable holder so extracted `main/ipc/*` domains can read refs that
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
//
// TYPED SURFACE (ts-migration Tier 4): MainContext below is the single
// declaration of every slot — the Tier-4 JSDoc typedef, now a real
// interface. Assignments from the owning module must match the slot
// signature, reads get the slot's value type. Fields are declared
// non-nullable on purpose: the load-then-read-at-call-time contract means
// every read happens after assignment; a null check at every read site
// would be noise. Load-order violations are caught by the boot smokes and
// the main-load harness, not by nullness.

import type {
	IndexerInbound,
	IndexerOutbound,
} from "../shared/worker-messages.ts";

export interface MainContext {
	/** import pipeline entry (owned by main/ipc/import; read by youtube). */
	importPaths: (
		files: string[],
		opts?: { fromWatch?: boolean },
	) => Promise<unknown>;
	/** absolute library photos dir. */
	photosDir: string;
	/** video-extension check (used across import/rank/protocol; read by llm-ask). */
	isVideo: (filename: string) => boolean;
	/** the live main window, if any (owned by chrome). */
	liveMainWindow: () => Electron.BrowserWindow | null;
	/** show + focus + steal the main window (owned by chrome). */
	showAndFocusMain: () => void;
	/** apply menu-bar-only mode live (owned by chrome). */
	applyMenuBarMode: (enabled: boolean) => boolean;
	/** absolute library dir — assigned at TOP (watched reads it in a top-level initializer). */
	dataDir: string;
	/** import-pipeline busy flag (thunk over import's state). */
	isImportInFlight: () => boolean;
	/** migration state (truthy while a model migration owns the pipeline). */
	getMigrationState: () => object | null;
	/** ensure the indexer pool exists (owned by pool). */
	spawnIndexer: () => unknown;
	/** primary worker's ready promise (thunk; may be null pre-spawn). */
	getIndexerReady: () => Promise<unknown> | null;
	/** round-robin embed request across live workers. */
	askIndexer: (message: IndexerInbound) => Promise<IndexerOutbound>;
	/** worker env (model cache dirs etc.). */
	indexerEnv: () => Record<string, string>;
	/** enrich-pinned request; chunk timeouts override the 180 s default. */
	askPrimaryIndexer: (
		message: IndexerInbound,
		timeoutMs?: number,
	) => Promise<IndexerOutbound>;
	/** restart a wedged primary worker (ffmpeg kill first). */
	restartPrimaryIndexer: (reason: string) => void;
	/** model-switch teardown (kills tracked ffmpeg PIDs, then workers). */
	stopIndexerPool: () => void;
	/** is the model's cache dir populated (any version layout). */
	modelDownloaded: (modelId: string) => boolean;
	/** which model the next worker fork should load. */
	poolModelId: () => string;
	/** migration-owned model pin (assigned by migration at module top; null when no migration pool is pinned). */
	getWorkerModelId: () => string | null;
	/** version-threshold calibration (stays in main.js, read by migration). */
	calibrateThresholds: (modelId: string) => Promise<unknown>;
	/** init-failure flag (thunk over the pool's state). */
	getIndexerInitFailed: () => Error | null;
	/** pool size const (copied once) for import-batch concurrency. */
	indexerPoolSize: number;
	/** enrich queue read for the embed-query lane. */
	getEnrichQueue: () => unknown[];
	/** enrich-in-flight (reassigned let; thunk-only). */
	isEnrichInFlight: () => boolean;
	/** query-priority flag flip. */
	setEnrichPendingQuery: (v: boolean) => void;
	/** query-priority flag flip. */
	setOcrPendingQuery: (v: boolean) => void;
	/** query-priority flag flip. */
	setTranscribePendingQuery: (v: boolean) => void;
	/** enrich gate read (serves the transcribe gate). */
	isEnrichPendingQuery: () => boolean;
	/** enrich status fan-out (owned by the enrich pump; payloads are
	 * pump-shaped pass-throughs — `any` keeps the fan-out callers free). */
	broadcastEnrichEvent: (extra: any) => void;
	/** transcribe gate read (serves the enrich gate). */
	isTranscribePendingQuery: () => boolean;
	/** session-wide pump gate. */
	isBackgroundPaused: () => boolean;
	/** bump-per-purge counter (thunks the lifecycle let). */
	getPurgeEpoch: () => number;
	/** versions bumps the epoch on purge. */
	bumpPurgeEpoch: () => void;
	/** tray icon/bucket refresh (owned by chrome). */
	updateTrayState: () => void;
	/** notification gate (owned by chrome). */
	maybeNotify: (title: string, body: string) => void;
	/** row exists (incl. tombstones excluded) — import. */
	libraryHasRow: (filename: string) => boolean;
	/** absolute posters dir. */
	postersDir: string;
	/** OCR query-priority gate (serves the transcribe gate). */
	isOcrPendingQuery: () => boolean;
	/** the mainWindowRef let. */
	getMainWindowRef: () => Electron.BrowserWindow | null;
	/** mainWindowRef write + push bookkeeping. */
	setMainWindowRef: (win: Electron.BrowserWindow | null) => void;
	/** quit flag write. */
	setIsQuitting: (v: boolean) => void;
	/** menu-bar-only mode read. */
	isMenuBarOnlyEnabled: () => boolean;
	/** menu-bar-only mode write. */
	setMenuBarOnlyEnabled: (v: boolean) => void;
	/** active app icon image. */
	getAppIconImage: () => Electron.NativeImage | null;
	/** active app icon image write. */
	setAppIconImage: (img: Electron.NativeImage | null) => void;
	/** chosen icon id. */
	getCurrentAppIconId: () => string | null;
	/** chosen icon id write. */
	setCurrentAppIconId: (id: string | null) => void;
	/** icon staged while the Dock is hidden. */
	getPendingDockIcon: () => Electron.NativeImage | null;
	/** pending dock icon write. */
	setPendingDockIcon: (img: Electron.NativeImage | null) => void;
	/** pending icon id. */
	getPendingDockIconId: () => string | null;
	/** pending icon id write. */
	setPendingDockIconId: (id: string | null) => void;
	/** icon-id → NativeImage (sync read; null on miss). */
	loadAppIconImage: (id: string) => Electron.NativeImage | null;
	/** absolute settings.json path. */
	settingsFile: string;
	/** main.js's __dirname — dist-main/ in compiled runs (preload.js is emitted beside it), the repo root in source runs (tests/harness; preload.js lives there). */
	appDirname: string;
	/** ffmpeg-child PID tracker (pool). */
	trackFfmpegSpawn: (
		pids: Map<number, any>,
		pid: number,
		label: unknown,
	) => void;
	/** ffmpeg-child PID remover (pool). */
	untrackFfmpegExit: (pids: Map<number, any>, pid: number) => void;
	/** stable transcribe PID map (mutated in place, never replaced). */
	transcribeFfmpegPids: Map<number, any>;
	/** SHA-256 hex of a file's bytes (import; stall-bounded). */
	hashFile: (file: string) => Promise<string>;
	/** built renderer dir (dist/). */
	rendererDir: string;
	/** absolute thumbs dir. */
	thumbsDir: string;
	/** preview transcode + cache (previews). */
	ensurePreview: (
		filename: string,
		t: number,
	) => Promise<{ ok: true; path: string } | { ok: false; error?: string }>;
	/** byte-sniffed mime resolution (indexer/mime-sniff — sniffed wins, an image/* extMime lie downgrades to octet-stream). */
	imageContentType: (args: {
		sniffed: string | null;
		extMime?: string | null;
	}) => string;
	/** quit flag read (thunk over the lifecycle let). */
	isQuitting: () => boolean;
	/** importable extensions (images + videos; stable, never mutated). */
	importExtensions: Set<string>;
	/** video extensions (stable, never mutated). */
	videoExtensions: Set<string>;
	/** image extensions (stable, never mutated). */
	imageExtensions: Set<string>;
	/** video → poster path extractor (previews). */
	generatePoster: (videoPath: string) => Promise<string>;
	/** filename → poster path helper. */
	posterFor: (filename: string) => string;
}

// The initializer is a deliberate placeholder: every field is a null until
// main.js (or its owning module) assigns it during load — before any handler
// can run. The cast is the one sanctioned lie in this file; writes and reads
// elsewhere are checked against MainContext.
const ctx = {
	importPaths: null,
	photosDir: null,
	isVideo: null,
	liveMainWindow: null,
	showAndFocusMain: null,
	applyMenuBarMode: null,
	dataDir: null,
	isImportInFlight: null,
	getMigrationState: null,
	spawnIndexer: null,
	getIndexerReady: null,
	askIndexer: null,
	indexerEnv: null,
	askPrimaryIndexer: null,
	restartPrimaryIndexer: null,
	stopIndexerPool: null,
	modelDownloaded: null,
	poolModelId: null,
	getWorkerModelId: null,
	calibrateThresholds: null,
	getIndexerInitFailed: null,
	indexerPoolSize: null,
	getEnrichQueue: null,
	isEnrichInFlight: null,
	setEnrichPendingQuery: null,
	setOcrPendingQuery: null,
	setTranscribePendingQuery: null,
	broadcastEnrichEvent: null,
	isTranscribePendingQuery: null,
	isBackgroundPaused: null,
	getPurgeEpoch: null,
	bumpPurgeEpoch: null,
	updateTrayState: null,
	maybeNotify: null,
	libraryHasRow: null,
	postersDir: null,
	isOcrPendingQuery: null,
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
	trackFfmpegSpawn: null,
	untrackFfmpegExit: null,
	transcribeFfmpegPids: null,
	hashFile: null,
	rendererDir: null,
	thumbsDir: null,
	ensurePreview: null,
	imageContentType: null,
	isQuitting: null,
	importExtensions: null,
	videoExtensions: null,
	imageExtensions: null,
	generatePoster: null,
	posterFor: null,
} as unknown as MainContext;

export default ctx;
