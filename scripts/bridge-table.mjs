// @ts-check
// IPC bridge contract — single source of truth (ts-migration plan, Tier 2).
//
// Every renderer↔main method lives here exactly once. From this table:
//   - scripts/gen-bridge.js emits preload.js and docs/ipc-contract.md
//     (byte-stable; never hand-edit those two files)
//   - test/ipc-bridge.test.js fails on any drift: committed preload/doc vs
//     generator output, table channels vs channels actually registered at
//     load (via the main-load harness dump), table methods vs
//     MemoriesBridge members (via the TS compiler API)
//
// Adding or changing a channel = edit this table + the owning handler,
// then `node scripts/gen-bridge.js` and run `bun run test:ipc-bridge`.
//
// Types are NOT duplicated here: `MemoriesBridge` (src/types.d.ts) owns
// every signature; preload.js is @ts-check'ed against it, so a param or
// return-type change fails `tsc` without touching the table unless the
// routing itself changes.

/**
 * @typedef {"invoke" | "send" | "push" | "local"} BridgeKind
 *
 * @typedef {object} BridgeEntry
 * @property {string | null} channel IPC channel name (null only for "local").
 * @property {string} method Preload bridge method name.
 * @property {BridgeKind} kind invoke = handle/request-response; send =
 *   ipcMain.on fire-and-forget; push = main → renderer event; local =
 *   preload-only helper with no IPC.
 * @property {string[]} params Preload method parameter names, in order.
 * @property {string} handler Main-side owner, extensionless
 *   ("main/ipc/media"; "main" = glue registered in main.js). For "push"
 *   entries this is a note about the canonical sender(s) — asserted only
 *   for invoke/send (registration is observable; sending ownership is
 *   documented, exercised by the smokes).
 * @property {string} [payload] Emitted payload expression (kind "send").
 * @property {string} [payloadType] JSDoc payload type (kind "push").
 * @property {string} [localFn] Emitted electron call (kind "local").
 */

/** @type {readonly BridgeEntry[]} */
export const BRIDGE = [
	// rank / embed --------------------------------------------------------
	{
		channel: "memories:embed-query",
		method: "embedQuery",
		kind: "invoke",
		params: ["text"],
		handler: "main/ipc/rank-moments",
	},
	{
		channel: "memories:rank",
		method: "rankSearch",
		kind: "invoke",
		params: ["query", "topK"],
		handler: "main/ipc/rank-moments",
	},
	{
		channel: "memories:rank-scenes",
		method: "rankScenes",
		kind: "invoke",
		params: ["query", "topK"],
		handler: "main/ipc/rank-moments",
	},
	{
		channel: "memories:rank-dialogue",
		method: "rankDialogue",
		kind: "invoke",
		params: ["query", "topK"],
		handler: "main/ipc/rank-moments",
	},
	// pipeline state + trays ---------------------------------------------
	{
		channel: "memories:transcribe-state",
		method: "getTranscribeState",
		kind: "invoke",
		params: [],
		handler: "main/ipc/pumps/transcribe",
	},
	// import / library ---------------------------------------------------
	{
		channel: "memories:import-paths",
		method: "importPaths",
		kind: "invoke",
		params: ["paths"],
		handler: "main/ipc/import",
	},
	{
		channel: "memories:pick",
		method: "pickPhotos",
		kind: "invoke",
		params: [],
		handler: "main/ipc/import",
	},
	{
		channel: "memories:get-watched-folders",
		method: "getWatchedFolders",
		kind: "invoke",
		params: [],
		handler: "main/ipc/watched",
	},
	// glue registered directly in main.js (decompose: intentional) -------
	{
		channel: "memories:get-version",
		method: "getVersion",
		kind: "invoke",
		params: [],
		handler: "main",
	},
	{
		channel: "memories:breadcrumb",
		method: "breadcrumb",
		kind: "send",
		params: ["text"],
		handler: "main",
		payload: "{ text }",
	},
	{
		channel: "memories:reveal-watched-folder",
		method: "revealWatchedFolder",
		kind: "invoke",
		params: ["folder"],
		handler: "main/ipc/watched",
	},
	{
		channel: "memories:remove-watched-folder",
		method: "removeWatchedFolder",
		kind: "invoke",
		params: ["folder"],
		handler: "main/ipc/watched",
	},
	{
		channel: "memories:reveal-file",
		method: "revealInFinder",
		kind: "invoke",
		params: ["filename"],
		handler: "main/ipc/reveal",
	},
	{
		channel: "memories:open-external",
		method: "openExternal",
		kind: "invoke",
		params: ["filename"],
		handler: "main/ipc/reveal",
	},
	{
		channel: "memories:delete",
		method: "deleteMemory",
		kind: "invoke",
		params: ["filename"],
		handler: "main/ipc/import",
	},
	{
		channel: "memories:set-category-override",
		method: "setCategoryOverride",
		kind: "invoke",
		params: ["filename", "category"],
		handler: "main/ipc/reveal",
	},
	// indexer pool + models ----------------------------------------------
	{
		channel: "memories:indexer-status",
		method: "getIndexerStatus",
		kind: "invoke",
		params: [],
		handler: "main/ipc/pool",
	},
	{
		channel: "memories:enrich-state",
		method: "getEnrichState",
		kind: "invoke",
		params: [],
		handler: "main/ipc/pumps/enrich",
	},
	{
		channel: "memories:ocr-state",
		method: "getOcrState",
		kind: "invoke",
		params: [],
		handler: "main/ipc/pumps/ocr",
	},
	{
		channel: "memories:set-model",
		method: "setModel",
		kind: "invoke",
		params: ["modelId"],
		handler: "main/ipc/pool",
	},
	{
		channel: "memories:preload-model",
		method: "preloadModel",
		kind: "invoke",
		params: ["modelId"],
		handler: "main/ipc/pool",
	},
	{
		channel: "memories:preload-all",
		method: "preloadAllModels",
		kind: "invoke",
		params: [],
		handler: "main/ipc/pool",
	},
	// non-IPC preload helper ---------------------------------------------
	{
		channel: null,
		method: "getPathForFile",
		kind: "local",
		params: ["file"],
		handler: "(preload-local)",
		localFn: "getPathForFile",
	},
	// chrome / shortcuts / tray ------------------------------------------
	{
		channel: "memories:get-shortcut",
		method: "getShortcut",
		kind: "invoke",
		params: [],
		handler: "main/ipc/chrome-settings",
	},
	{
		channel: "memories:set-shortcut",
		method: "setShortcut",
		kind: "invoke",
		params: ["accelerator"],
		handler: "main/ipc/chrome-settings",
	},
	{
		channel: "memories:get-menu-bar-only",
		method: "getMenuBarOnly",
		kind: "invoke",
		params: [],
		handler: "main/ipc/chrome-settings",
	},
	{
		channel: "memories:set-menu-bar-only",
		method: "setMenuBarOnly",
		kind: "invoke",
		params: ["enabled"],
		handler: "main/ipc/chrome-settings",
	},
	{
		channel: "memories:get-onboarding-seen",
		method: "getOnboardingSeen",
		kind: "invoke",
		params: [],
		handler: "main/ipc/chrome-settings",
	},
	{
		channel: "memories:set-onboarding-seen",
		method: "setOnboardingSeen",
		kind: "invoke",
		params: ["seen"],
		handler: "main/ipc/chrome-settings",
	},
	{
		channel: "memories:get-tray-settings",
		method: "getTraySettings",
		kind: "invoke",
		params: [],
		handler: "main/ipc/chrome-settings",
	},
	{
		channel: "memories:set-tray-settings",
		method: "setTraySettings",
		kind: "invoke",
		params: ["patch"],
		handler: "main/ipc/chrome-settings",
	},
	// media settings -----------------------------------------------------
	{
		channel: "memories:get-video-quality",
		method: "getVideoQuality",
		kind: "invoke",
		params: [],
		handler: "main/ipc/media",
	},
	{
		channel: "memories:set-video-quality",
		method: "setVideoQuality",
		kind: "invoke",
		params: ["quality"],
		handler: "main/ipc/media",
	},
	{
		channel: "memories:get-whisper-model",
		method: "getWhisperModel",
		kind: "invoke",
		params: [],
		handler: "main/ipc/media",
	},
	{
		channel: "memories:set-whisper-model",
		method: "setWhisperModel",
		kind: "invoke",
		params: ["model"],
		handler: "main/ipc/media",
	},
	{
		channel: "memories:get-ocr-langs",
		method: "getOcrLangs",
		kind: "invoke",
		params: [],
		handler: "main/ipc/media",
	},
	{
		channel: "memories:set-ocr-langs",
		method: "setOcrLangs",
		kind: "invoke",
		params: ["langs"],
		handler: "main/ipc/media",
	},
	{
		channel: "memories:reocr-photos",
		method: "reocrPhotos",
		kind: "invoke",
		params: [],
		handler: "main/ipc/media",
	},
	// app icon / video re-analysis ---------------------------------------
	{
		channel: "memories:get-app-icon",
		method: "getAppIcon",
		kind: "invoke",
		params: [],
		handler: "main/ipc/chrome",
	},
	{
		channel: "memories:set-app-icon",
		method: "setAppIcon",
		kind: "invoke",
		params: ["id"],
		handler: "main/ipc/chrome",
	},
	{
		channel: "memories:get-app-icon-debug",
		method: "getAppIconDebug",
		kind: "invoke",
		params: [],
		handler: "main/ipc/chrome",
	},
	{
		channel: "memories:reanalyze-videos",
		method: "reanalyzeVideos",
		kind: "invoke",
		params: [],
		handler: "main/ipc/media",
	},
	{
		channel: "memories:videos-cost-estimate",
		method: "videosCostEstimate",
		kind: "invoke",
		params: [],
		handler: "main/ipc/media",
	},
	{
		channel: "memories:suspected-truncated",
		method: "suspectedTruncatedVideos",
		kind: "invoke",
		params: [],
		handler: "main/ipc/media",
	},
	// embedding versions -------------------------------------------------
	{
		channel: "memories:versions-list",
		method: "getEmbeddingVersions",
		kind: "invoke",
		params: [],
		handler: "main/ipc/versions",
	},
	{
		channel: "memories:versions-create",
		method: "createEmbeddingVersion",
		kind: "invoke",
		params: ["name"],
		handler: "main/ipc/versions",
	},
	{
		channel: "memories:versions-rename",
		method: "renameEmbeddingVersion",
		kind: "invoke",
		params: ["slug", "name"],
		handler: "main/ipc/versions",
	},
	{
		channel: "memories:versions-delete",
		method: "deleteEmbeddingVersion",
		kind: "invoke",
		params: ["slug"],
		handler: "main/ipc/versions",
	},
	{
		channel: "memories:versions-restore",
		method: "restoreEmbeddingVersion",
		kind: "invoke",
		params: ["slug"],
		handler: "main/ipc/versions",
	},
	{
		channel: "memories:library-reset",
		method: "resetLibrary",
		kind: "invoke",
		params: [],
		handler: "main/ipc/versions",
	},
	{
		channel: "memories:set-background-paused",
		method: "setBackgroundPaused",
		kind: "invoke",
		params: ["paused"],
		handler: "main",
	},
	{
		channel: "memories:purge-background",
		method: "purgeBackground",
		kind: "invoke",
		params: [],
		handler: "main/ipc/versions",
	},
	// ask / LLM ----------------------------------------------------------
	{
		channel: "memories:get-ai-insights",
		method: "getAiInsights",
		kind: "invoke",
		params: ["filename"],
		handler: "main/ipc/llm-ask",
	},
	{
		channel: "memories:llm-status",
		method: "getLlmStatus",
		kind: "invoke",
		params: [],
		handler: "main/ipc/llm-ask",
	},
	{
		channel: "memories:llm-set-config",
		method: "setLlmConfig",
		kind: "invoke",
		params: ["patch"],
		handler: "main/ipc/llm-ask",
	},
	{
		channel: "memories:llm-download",
		method: "downloadLlm",
		kind: "invoke",
		params: ["target"],
		handler: "main/ipc/llm-ask",
	},
	{
		channel: "memories:ask",
		method: "askScm",
		kind: "invoke",
		params: ["payload"],
		handler: "main/ipc/llm-ask",
	},
	{
		channel: "memories:ask-stop",
		method: "stopAsk",
		kind: "send",
		params: ["reqId"],
		handler: "main/ipc/llm-ask",
		payload: "{ reqId }",
	},
	// youtube ------------------------------------------------------------
	{
		channel: "memories:youtube-status",
		method: "getYoutubeStatus",
		kind: "invoke",
		params: [],
		handler: "main/ipc/youtube",
	},
	{
		channel: "memories:youtube-ensure-binary",
		method: "ensureYoutubeBinary",
		kind: "invoke",
		params: [],
		handler: "main/ipc/youtube",
	},
	{
		channel: "memories:youtube-add",
		method: "addYoutubeChannel",
		kind: "invoke",
		params: ["payload"],
		handler: "main/ipc/youtube",
	},
	{
		channel: "memories:youtube-remove",
		method: "removeYoutubeChannel",
		kind: "invoke",
		params: ["url"],
		handler: "main/ipc/youtube",
	},
	{
		channel: "memories:youtube-download",
		method: "downloadYoutube",
		kind: "invoke",
		params: ["payload"],
		handler: "main/ipc/youtube",
	},
	{
		channel: "memories:youtube-set-config",
		method: "setYoutubeConfig",
		kind: "invoke",
		params: ["patch"],
		handler: "main/ipc/youtube",
	},
	{
		channel: "memories:youtube-files",
		method: "getYoutubeFiles",
		kind: "invoke",
		params: [],
		handler: "main/ipc/youtube",
	},
	// main → renderer pushes ---------------------------------------------
	{
		channel: "memories:ask-evidence",
		method: "onAskEvidence",
		kind: "push",
		params: ["callback"],
		handler: "main/ipc/llm-ask (sendAsk)",
		payloadType:
			'import("./src/types").AskEvidenceEvent & { stats?: import("./src/types").AskStats }',
	},
	{
		channel: "memories:ask-token",
		method: "onAskToken",
		kind: "push",
		params: ["callback"],
		handler: "main/ipc/llm-ask (sendAsk)",
		payloadType: 'import("./src/types").AskTokenEvent',
	},
	{
		channel: "memories:ask-phase",
		method: "onAskPhase",
		kind: "push",
		params: ["callback"],
		handler: "main/ipc/llm-ask (sendAsk)",
		payloadType: 'import("./src/types").AskPhaseEvent',
	},
	{
		channel: "memories:status",
		method: "onStatus",
		kind: "push",
		params: ["callback"],
		handler: "broadcast from tray/pump/library modules",
		payloadType: 'import("./src/types").StatusPayload',
	},
];
