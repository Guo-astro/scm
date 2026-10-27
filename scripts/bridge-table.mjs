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
 * @typedef {"none" | "envelope" | "reason" | "bare-ok" | "mixed" | "empty" | "null" | "result-errors" | "throws"} BridgeFailure
 *
 * @typedef {object} BridgeEntry
 * @property {string | null} channel IPC channel name (null only for "local").
 * @property {string} method Preload bridge method name.
 * @property {BridgeKind} kind invoke = handle/request-response; send =
 *   ipcMain.on fire-and-forget; push = main → renderer event; local =
 *   preload-only helper with no IPC.
 * @property {BridgeFailure} [failure] How a failed invoke surfaces to the
 *   renderer (kind "invoke" only — the failure contract the renderer has to
 *   read). Enumerated per channel so the uniform-envelope migration
 *   (ipc-wrapper.ts V2) has a catalogue to work from:
 *     none          no failure path — always succeeds, or a plain read
 *     envelope      { ok: false, error }
 *     reason        { ok: false, reason } — a discriminated result
 *     bare-ok       { ok: false } — no detail
 *     mixed         more than one failure shape in the same channel
 *     empty         [] on failure — indistinguishable from "no results"
 *     null          null on failure — indistinguishable from "no result"
 *     result-errors a result object with a per-item errors list
 *     throws        the failure escapes the handler
 *   Asserted against the MemoriesBridge return type by test/ipc-bridge.test.js.
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
		failure: "null",
		params: ["text"],
		handler: "main/ipc/rank-moments",
	},
	{
		channel: "memories:rank",
		method: "rankSearch",
		kind: "invoke",
		failure: "empty",
		params: ["query", "topK"],
		handler: "main/ipc/rank-moments",
	},
	{
		channel: "memories:rank-scenes",
		method: "rankScenes",
		kind: "invoke",
		failure: "empty",
		params: ["query", "topK"],
		handler: "main/ipc/rank-moments",
	},
	{
		channel: "memories:rank-dialogue",
		method: "rankDialogue",
		kind: "invoke",
		failure: "empty",
		params: ["query", "topK"],
		handler: "main/ipc/rank-moments",
	},
	// pipeline state + trays ---------------------------------------------
	{
		channel: "memories:transcribe-state",
		method: "getTranscribeState",
		kind: "invoke",
		failure: "none",
		params: [],
		handler: "main/ipc/pumps/transcribe",
	},
	// import / library ---------------------------------------------------
	{
		channel: "memories:import-paths",
		method: "importPaths",
		kind: "invoke",
		failure: "result-errors",
		params: ["paths"],
		handler: "main/ipc/import",
	},
	{
		// Deliberately `mixed`, and every shape is readable (App.pickPhotos
		// handles all three): null = the user canceled the dialog, the
		// ImportResult carries per-item `errors`, and a dialog-level throw
		// rejects — the renderer's catch toasts it. Do not "normalize" this
		// into an envelope; null-for-cancel is a state, not a failure.
		channel: "memories:pick",
		method: "pickPhotos",
		kind: "invoke",
		failure: "mixed",
		params: [],
		handler: "main/ipc/import",
	},
	{
		channel: "memories:get-watched-folders",
		method: "getWatchedFolders",
		kind: "invoke",
		failure: "none",
		params: [],
		handler: "main/ipc/watched",
	},
	// glue registered directly in main.js (decompose: intentional) -------
	{
		channel: "memories:get-version",
		method: "getVersion",
		kind: "invoke",
		failure: "none",
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
		failure: "envelope",
		params: ["folder"],
		handler: "main/ipc/watched",
	},
	{
		channel: "memories:remove-watched-folder",
		method: "removeWatchedFolder",
		kind: "invoke",
		failure: "envelope",
		params: ["folder"],
		handler: "main/ipc/watched",
	},
	{
		channel: "memories:reveal-file",
		method: "revealInFinder",
		kind: "invoke",
		failure: "envelope",
		params: ["filename"],
		handler: "main/ipc/reveal",
	},
	{
		channel: "memories:open-external",
		method: "openExternal",
		kind: "invoke",
		failure: "envelope",
		params: ["filename"],
		handler: "main/ipc/reveal",
	},
	{
		channel: "memories:delete",
		method: "deleteMemory",
		kind: "invoke",
		failure: "envelope",
		params: ["filename"],
		handler: "main/ipc/import",
	},
	{
		channel: "memories:set-category-override",
		method: "setCategoryOverride",
		kind: "invoke",
		failure: "envelope",
		params: ["filename", "category"],
		handler: "main/ipc/reveal",
	},
	// indexer pool + models ----------------------------------------------
	{
		channel: "memories:indexer-status",
		method: "getIndexerStatus",
		kind: "invoke",
		failure: "none",
		params: [],
		handler: "main/ipc/pool",
	},
	{
		channel: "memories:enrich-state",
		method: "getEnrichState",
		kind: "invoke",
		failure: "none",
		params: [],
		handler: "main/ipc/pumps/enrich",
	},
	{
		channel: "memories:ocr-state",
		method: "getOcrState",
		kind: "invoke",
		failure: "none",
		params: [],
		handler: "main/ipc/pumps/ocr",
	},
	{
		channel: "memories:set-model",
		method: "setModel",
		kind: "invoke",
		failure: "envelope",
		params: ["modelId"],
		handler: "main/ipc/pool",
	},
	{
		channel: "memories:preload-model",
		method: "preloadModel",
		kind: "invoke",
		failure: "result-errors",
		params: ["modelId"],
		handler: "main/ipc/pool",
	},
	{
		channel: "memories:preload-all",
		method: "preloadAllModels",
		kind: "invoke",
		failure: "result-errors",
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
		failure: "none",
		params: [],
		handler: "main/ipc/chrome-settings",
	},
	{
		channel: "memories:set-shortcut",
		method: "setShortcut",
		kind: "invoke",
		failure: "envelope",
		params: ["accelerator"],
		handler: "main/ipc/chrome-settings",
	},
	{
		channel: "memories:get-menu-bar-only",
		method: "getMenuBarOnly",
		kind: "invoke",
		failure: "none",
		params: [],
		handler: "main/ipc/chrome-settings",
	},
	{
		channel: "memories:set-menu-bar-only",
		method: "setMenuBarOnly",
		kind: "invoke",
		failure: "envelope",
		params: ["enabled"],
		handler: "main/ipc/chrome-settings",
	},
	{
		channel: "memories:get-onboarding-seen",
		method: "getOnboardingSeen",
		kind: "invoke",
		failure: "none",
		params: [],
		handler: "main/ipc/chrome-settings",
	},
	{
		channel: "memories:set-onboarding-seen",
		method: "setOnboardingSeen",
		kind: "invoke",
		failure: "envelope",
		params: ["seen"],
		handler: "main/ipc/chrome-settings",
	},
	{
		channel: "memories:get-tray-settings",
		method: "getTraySettings",
		kind: "invoke",
		failure: "none",
		params: [],
		handler: "main/ipc/chrome-settings",
	},
	{
		channel: "memories:set-tray-settings",
		method: "setTraySettings",
		kind: "invoke",
		failure: "envelope",
		params: ["patch"],
		handler: "main/ipc/chrome-settings",
	},
	// media settings -----------------------------------------------------
	{
		channel: "memories:get-video-quality",
		method: "getVideoQuality",
		kind: "invoke",
		failure: "none",
		params: [],
		handler: "main/ipc/media",
	},
	{
		channel: "memories:set-video-quality",
		method: "setVideoQuality",
		kind: "invoke",
		failure: "envelope",
		params: ["quality"],
		handler: "main/ipc/media",
	},
	{
		channel: "memories:get-whisper-model",
		method: "getWhisperModel",
		kind: "invoke",
		failure: "none",
		params: [],
		handler: "main/ipc/media",
	},
	{
		channel: "memories:set-whisper-model",
		method: "setWhisperModel",
		kind: "invoke",
		failure: "envelope",
		params: ["model"],
		handler: "main/ipc/media",
	},
	{
		channel: "memories:get-ocr-langs",
		method: "getOcrLangs",
		kind: "invoke",
		failure: "none",
		params: [],
		handler: "main/ipc/media",
	},
	{
		channel: "memories:set-ocr-langs",
		method: "setOcrLangs",
		kind: "invoke",
		failure: "envelope",
		params: ["langs"],
		handler: "main/ipc/media",
	},
	{
		channel: "memories:reocr-photos",
		method: "reocrPhotos",
		kind: "invoke",
		failure: "envelope",
		params: [],
		handler: "main/ipc/media",
	},
	// app icon / video re-analysis ---------------------------------------
	{
		channel: "memories:get-app-icon",
		method: "getAppIcon",
		kind: "invoke",
		failure: "none",
		params: [],
		handler: "main/ipc/chrome",
	},
	{
		channel: "memories:set-app-icon",
		method: "setAppIcon",
		kind: "invoke",
		failure: "envelope",
		params: ["id"],
		handler: "main/ipc/chrome",
	},
	{
		channel: "memories:get-app-icon-debug",
		method: "getAppIconDebug",
		kind: "invoke",
		failure: "envelope",
		params: [],
		handler: "main/ipc/chrome",
	},
	{
		channel: "memories:reanalyze-videos",
		method: "reanalyzeVideos",
		kind: "invoke",
		failure: "none",
		params: [],
		handler: "main/ipc/media",
	},
	{
		channel: "memories:videos-cost-estimate",
		method: "videosCostEstimate",
		kind: "invoke",
		failure: "envelope",
		params: [],
		handler: "main/ipc/media",
	},
	{
		channel: "memories:suspected-truncated",
		method: "suspectedTruncatedVideos",
		kind: "invoke",
		failure: "none",
		params: [],
		handler: "main/ipc/media",
	},
	// embedding versions -------------------------------------------------
	{
		channel: "memories:versions-list",
		method: "getEmbeddingVersions",
		kind: "invoke",
		failure: "none",
		params: [],
		handler: "main/ipc/versions",
	},
	{
		channel: "memories:versions-create",
		method: "createEmbeddingVersion",
		kind: "invoke",
		failure: "envelope",
		params: ["name"],
		handler: "main/ipc/versions",
	},
	{
		channel: "memories:versions-rename",
		method: "renameEmbeddingVersion",
		kind: "invoke",
		failure: "envelope",
		params: ["slug", "name"],
		handler: "main/ipc/versions",
	},
	{
		channel: "memories:versions-delete",
		method: "deleteEmbeddingVersion",
		kind: "invoke",
		failure: "envelope",
		params: ["slug"],
		handler: "main/ipc/versions",
	},
	{
		channel: "memories:versions-restore",
		method: "restoreEmbeddingVersion",
		kind: "invoke",
		failure: "envelope",
		params: ["slug"],
		handler: "main/ipc/versions",
	},
	{
		channel: "memories:library-reset",
		method: "resetLibrary",
		kind: "invoke",
		failure: "envelope",
		params: [],
		handler: "main/ipc/versions",
	},
	{
		channel: "memories:set-background-paused",
		method: "setBackgroundPaused",
		kind: "invoke",
		failure: "none",
		params: ["paused"],
		handler: "main",
	},
	{
		channel: "memories:purge-background",
		method: "purgeBackground",
		kind: "invoke",
		failure: "envelope",
		params: [],
		handler: "main/ipc/versions",
	},
	// ask / LLM ----------------------------------------------------------
	{
		channel: "memories:get-ai-insights",
		method: "getAiInsights",
		kind: "invoke",
		failure: "null",
		params: ["filename"],
		handler: "main/ipc/llm-ask",
	},
	{
		channel: "memories:llm-status",
		method: "getLlmStatus",
		kind: "invoke",
		failure: "none",
		params: [],
		handler: "main/ipc/llm-ask",
	},
	{
		channel: "memories:llm-set-config",
		method: "setLlmConfig",
		kind: "invoke",
		failure: "envelope",
		params: ["patch"],
		handler: "main/ipc/llm-ask",
	},
	{
		channel: "memories:llm-download",
		method: "downloadLlm",
		kind: "invoke",
		failure: "envelope",
		params: ["target"],
		handler: "main/ipc/llm-ask",
	},
	{
		channel: "memories:ask",
		method: "askScm",
		kind: "invoke",
		failure: "reason",
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
		failure: "none",
		params: [],
		handler: "main/ipc/youtube",
	},
	{
		channel: "memories:youtube-ensure-binary",
		method: "ensureYoutubeBinary",
		kind: "invoke",
		failure: "envelope",
		params: [],
		handler: "main/ipc/youtube",
	},
	{
		channel: "memories:youtube-add",
		method: "addYoutubeChannel",
		kind: "invoke",
		failure: "envelope",
		params: ["payload"],
		handler: "main/ipc/youtube",
	},
	{
		channel: "memories:youtube-remove",
		method: "removeYoutubeChannel",
		kind: "invoke",
		failure: "envelope",
		params: ["url"],
		handler: "main/ipc/youtube",
	},
	{
		channel: "memories:youtube-download",
		method: "downloadYoutube",
		kind: "invoke",
		failure: "envelope",
		params: ["payload"],
		handler: "main/ipc/youtube",
	},
	{
		channel: "memories:youtube-set-config",
		method: "setYoutubeConfig",
		kind: "invoke",
		failure: "none",
		params: ["patch"],
		handler: "main/ipc/youtube",
	},
	{
		channel: "memories:youtube-files",
		method: "getYoutubeFiles",
		kind: "invoke",
		failure: "envelope",
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
