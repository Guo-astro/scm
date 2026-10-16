// @ts-check
"use strict";

// GENERATED FILE — do not edit by hand. Edit scripts/bridge-table.mjs, then
// run `node scripts/gen-bridge.js`. test/ipc-bridge.test.js fails when this
// file drifts from the table.
//
// Single-file CommonJS by design: this preload runs with `sandbox: true`
// (see main/ipc/protocol.js), so it cannot require() any project module —
// "electron" is the only allowed require. Type drift is caught instead by
// the `@type {MemoriesBridge}` annotation below: MemoriesBridge
// (src/types.d.ts) owns every signature, so a param/return change there
// fails `tsc` here, and a missing/extra method fails `tsc` too.

/** @typedef {import("./src/types").MemoriesBridge} MemoriesBridge */

const { contextBridge, ipcRenderer, webUtils } = require("electron");

/** @type {MemoriesBridge} */
const memories = {
	embedQuery: (text) => ipcRenderer.invoke("memories:embed-query", text),
	rankSearch: (query, topK) => ipcRenderer.invoke("memories:rank", query, topK),
	rankScenes: (query, topK) =>
		ipcRenderer.invoke("memories:rank-scenes", query, topK),
	rankDialogue: (query, topK) =>
		ipcRenderer.invoke("memories:rank-dialogue", query, topK),
	getTranscribeState: () => ipcRenderer.invoke("memories:transcribe-state"),
	importPaths: (paths) => ipcRenderer.invoke("memories:import-paths", paths),
	pickPhotos: () => ipcRenderer.invoke("memories:pick"),
	getWatchedFolders: () => ipcRenderer.invoke("memories:get-watched-folders"),
	getVersion: () => ipcRenderer.invoke("memories:get-version"),
	breadcrumb: (text) => ipcRenderer.send("memories:breadcrumb", { text }),
	revealWatchedFolder: (folder) =>
		ipcRenderer.invoke("memories:reveal-watched-folder", folder),
	removeWatchedFolder: (folder) =>
		ipcRenderer.invoke("memories:remove-watched-folder", folder),
	revealInFinder: (filename) =>
		ipcRenderer.invoke("memories:reveal-file", filename),
	openExternal: (filename) =>
		ipcRenderer.invoke("memories:open-external", filename),
	deleteMemory: (filename) => ipcRenderer.invoke("memories:delete", filename),
	setCategoryOverride: (filename, category) =>
		ipcRenderer.invoke("memories:set-category-override", filename, category),
	getIndexerStatus: () => ipcRenderer.invoke("memories:indexer-status"),
	getEnrichState: () => ipcRenderer.invoke("memories:enrich-state"),
	getOcrState: () => ipcRenderer.invoke("memories:ocr-state"),
	setModel: (modelId) => ipcRenderer.invoke("memories:set-model", modelId),
	preloadModel: (modelId) =>
		ipcRenderer.invoke("memories:preload-model", modelId),
	preloadAllModels: () => ipcRenderer.invoke("memories:preload-all"),
	getPathForFile: (file) => webUtils.getPathForFile(file),
	getShortcut: () => ipcRenderer.invoke("memories:get-shortcut"),
	setShortcut: (accelerator) =>
		ipcRenderer.invoke("memories:set-shortcut", accelerator),
	getMenuBarOnly: () => ipcRenderer.invoke("memories:get-menu-bar-only"),
	setMenuBarOnly: (enabled) =>
		ipcRenderer.invoke("memories:set-menu-bar-only", enabled),
	getOnboardingSeen: () => ipcRenderer.invoke("memories:get-onboarding-seen"),
	setOnboardingSeen: (seen) =>
		ipcRenderer.invoke("memories:set-onboarding-seen", seen),
	getTraySettings: () => ipcRenderer.invoke("memories:get-tray-settings"),
	setTraySettings: (patch) =>
		ipcRenderer.invoke("memories:set-tray-settings", patch),
	getVideoQuality: () => ipcRenderer.invoke("memories:get-video-quality"),
	setVideoQuality: (quality) =>
		ipcRenderer.invoke("memories:set-video-quality", quality),
	getWhisperModel: () => ipcRenderer.invoke("memories:get-whisper-model"),
	setWhisperModel: (model) =>
		ipcRenderer.invoke("memories:set-whisper-model", model),
	getOcrLangs: () => ipcRenderer.invoke("memories:get-ocr-langs"),
	setOcrLangs: (langs) => ipcRenderer.invoke("memories:set-ocr-langs", langs),
	reocrPhotos: () => ipcRenderer.invoke("memories:reocr-photos"),
	getAppIcon: () => ipcRenderer.invoke("memories:get-app-icon"),
	setAppIcon: (id) => ipcRenderer.invoke("memories:set-app-icon", id),
	getAppIconDebug: () => ipcRenderer.invoke("memories:get-app-icon-debug"),
	reanalyzeVideos: () => ipcRenderer.invoke("memories:reanalyze-videos"),
	videosCostEstimate: () => ipcRenderer.invoke("memories:videos-cost-estimate"),
	suspectedTruncatedVideos: () =>
		ipcRenderer.invoke("memories:suspected-truncated"),
	getEmbeddingVersions: () => ipcRenderer.invoke("memories:versions-list"),
	createEmbeddingVersion: (name) =>
		ipcRenderer.invoke("memories:versions-create", name),
	renameEmbeddingVersion: (slug, name) =>
		ipcRenderer.invoke("memories:versions-rename", slug, name),
	deleteEmbeddingVersion: (slug) =>
		ipcRenderer.invoke("memories:versions-delete", slug),
	restoreEmbeddingVersion: (slug) =>
		ipcRenderer.invoke("memories:versions-restore", slug),
	resetLibrary: () => ipcRenderer.invoke("memories:library-reset"),
	setBackgroundPaused: (paused) =>
		ipcRenderer.invoke("memories:set-background-paused", paused),
	purgeBackground: () => ipcRenderer.invoke("memories:purge-background"),
	getAiInsights: (filename) =>
		ipcRenderer.invoke("memories:get-ai-insights", filename),
	getLlmStatus: () => ipcRenderer.invoke("memories:llm-status"),
	setLlmConfig: (patch) => ipcRenderer.invoke("memories:llm-set-config", patch),
	downloadLlm: (target) => ipcRenderer.invoke("memories:llm-download", target),
	askScm: (payload) => ipcRenderer.invoke("memories:ask", payload),
	stopAsk: (reqId) => ipcRenderer.send("memories:ask-stop", { reqId }),
	getYoutubeStatus: () => ipcRenderer.invoke("memories:youtube-status"),
	ensureYoutubeBinary: () =>
		ipcRenderer.invoke("memories:youtube-ensure-binary"),
	addYoutubeChannel: (payload) =>
		ipcRenderer.invoke("memories:youtube-add", payload),
	removeYoutubeChannel: (url) =>
		ipcRenderer.invoke("memories:youtube-remove", url),
	downloadYoutube: (payload) =>
		ipcRenderer.invoke("memories:youtube-download", payload),
	setYoutubeConfig: (patch) =>
		ipcRenderer.invoke("memories:youtube-set-config", patch),
	getYoutubeFiles: () => ipcRenderer.invoke("memories:youtube-files"),
	onAskEvidence: (callback) => {
		/**
		 * @param {import("electron").IpcRendererEvent} _event
		 * @param {import("./src/types").AskEvidenceEvent & { stats?: import("./src/types").AskStats }} payload
		 */
		const listener = (_event, payload) => callback(payload);
		ipcRenderer.on("memories:ask-evidence", listener);
		return () => ipcRenderer.removeListener("memories:ask-evidence", listener);
	},
	onAskToken: (callback) => {
		/**
		 * @param {import("electron").IpcRendererEvent} _event
		 * @param {import("./src/types").AskTokenEvent} payload
		 */
		const listener = (_event, payload) => callback(payload);
		ipcRenderer.on("memories:ask-token", listener);
		return () => ipcRenderer.removeListener("memories:ask-token", listener);
	},
	onAskPhase: (callback) => {
		/**
		 * @param {import("electron").IpcRendererEvent} _event
		 * @param {import("./src/types").AskPhaseEvent} payload
		 */
		const listener = (_event, payload) => callback(payload);
		ipcRenderer.on("memories:ask-phase", listener);
		return () => ipcRenderer.removeListener("memories:ask-phase", listener);
	},
	onStatus: (callback) => {
		/**
		 * @param {import("electron").IpcRendererEvent} _event
		 * @param {import("./src/types").StatusPayload} payload
		 */
		const listener = (_event, payload) => callback(payload);
		ipcRenderer.on("memories:status", listener);
		return () => ipcRenderer.removeListener("memories:status", listener);
	},
};

contextBridge.exposeInMainWorld("memories", memories);
