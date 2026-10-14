# IPC Contract Snapshot (Phase 0 — frozen during moves)

Generated: 2026-10-10 from `main.js` (10107 lines) + `preload.js` (116 lines).
Source of truth while `main.js` is decomposed. Do not rename channels during move phases.

- `ipcMain.handle`: 62
- `ipcMain.on`: 1 (`memories:ask-stop`)
- `preload` bridge: 62x `invoke` + 1x `send` + 4x `on`
- Renderer push channels (`win.webContents.send`): `memories:status` (all trays/library), `memories:ask-evidence`, `memories:ask-token`, `memories:ask-phase`

## Handles (`grep -n "ipcMain.handle\|ipcMain.on" main.js`)

| # | Channel | main.js line | preload method | Notes |
|---|---------|--------------|----------------|-------|
| 1 | `memories:set-category-override` | `main/ipc/reveal.js:21` (moved, Phase 1 — multiline, missed by single-line grep) | `setCategoryOverride(filename, category)` | multiline handle missed by single-line grep |
| 2 | `memories:rank` | `main/ipc/rank-moments.js:230` (moved from `main.js:5757`, Phase 1) | `rankSearch(query, topK)` | rank worker |
| 3 | `memories:rank-scenes` | `main/ipc/rank-moments.js:401` (moved, Phase 1) | `rankScenes(query, topK)` | moments |
| 4 | `memories:rank-dialogue` | `main/ipc/rank-moments.js:409` (moved, Phase 1) | `rankDialogue(query, topK)` | moments |
| 5 | `memories:embed-query` | `main/ipc/rank-moments.js:421` (moved, Phase 1) | `embedQuery(text)` | rank worker |
| 6 | `memories:enrich-state` | `main/ipc/pumps/enrich.js:582` (moved, Phase 1) | `getEnrichState()` | tray snapshot |
| 7 | `memories:transcribe-state` | `main/ipc/pumps/transcribe.js:687` (moved, Phase 1) | `getTranscribeState()` | tray snapshot |
| 8 | `memories:ocr-state` | `main/ipc/pumps/ocr.js:668` (moved, Phase 1) | `getOcrState()` | tray snapshot |
| 9 | `memories:import-paths` | `main/ipc/import.js:794` (moved from `main.js:4011`, Phase 1) | `importPaths(paths)` | import |
| 10 | `memories:pick` | `main/ipc/import.js:801` (moved, Phase 1) | `pickPhotos()` | file picker |
| 11 | `memories:get-watched-folders` | `main/ipc/watched.js:247` (moved from `main.js:6193`, Phase 1) | `getWatchedFolders()` | watched |
| 12 | `memories:get-version` | 6215 | `getVersion()` | |
| 13 | `memories:reveal-watched-folder` | `main/ipc/watched.js:248` (moved, Phase 1) | `revealWatchedFolder(folder)` | watched |
| 14 | `memories:remove-watched-folder` | `main/ipc/watched.js:254` (moved, Phase 1) | `removeWatchedFolder(folder)` | watched |
| 15 | `memories:reveal-file` | `main/ipc/reveal.js:71` (moved, Phase 1) | `revealInFinder(filename)` | |
| 16 | `memories:open-external` | `main/ipc/reveal.js:84` (moved, Phase 1) | `openExternal(filename)` | |
| 17 | `memories:delete` | `main/ipc/import.js:903` (moved from `main.js:4182`, Phase 1) | `deleteMemory(filename)` | touches all pump queues via `dropQueuedJobsFor` |
| 18 | `memories:indexer-status` | `main/ipc/pool.js:640` (moved, Phase 1) | `getIndexerStatus()` | pool |
| 19 | `memories:set-model` | `main/ipc/pool.js:645` (moved, Phase 1) | `setModel(modelId)` | migration |
| 20 | `memories:preload-model` | `main/ipc/pool.js:654` (moved, Phase 1) | `preloadModel(modelId)` | pool |
| 21 | `memories:preload-all` | `main/ipc/pool.js:660` (moved, Phase 1) | `preloadAllModels()` | pool |
| 22 | `memories:get-shortcut` | `main/ipc/chrome-settings.js:68` (moved from `main.js:6553`, Phase 1) | `getShortcut()` | chrome |
| 23 | `memories:set-shortcut` | `main/ipc/chrome-settings.js:73` (moved, Phase 1) | `setShortcut(accelerator)` | chrome |
| 24 | `memories:get-menu-bar-only` | `main/ipc/chrome-settings.js:88` (moved from `main.js:6897`, Phase 1) | `getMenuBarOnly()` | chrome |
| 25 | `memories:get-onboarding-seen` | `main/ipc/chrome-settings.js:94` (moved, Phase 1) | `getOnboardingSeen()` | chrome |
| 26 | `memories:set-onboarding-seen` | `main/ipc/chrome-settings.js:96` (moved, Phase 1) | `setOnboardingSeen(seen)` | chrome |
| 27 | `memories:set-menu-bar-only` | `main/ipc/chrome-settings.js:103` (moved, Phase 1) | `setMenuBarOnly(enabled)` | chrome |
| 28 | `memories:get-tray-settings` | `main/ipc/chrome-settings.js:152` (moved, Phase 1) | `getTraySettings()` | chrome |
| 29 | `memories:set-tray-settings` | `main/ipc/chrome-settings.js:154` (moved, Phase 1) | `setTraySettings(patch)` | chrome |
| 30 | `memories:get-app-icon` | `main/ipc/chrome.js:465` (moved, Phase 1) | `getAppIcon()` | appearance |
| 31 | `memories:get-app-icon-debug` | `main/ipc/chrome.js:482` (moved, Phase 1) | `getAppIconDebug()` | appearance |
| 32 | `memories:set-app-icon` | `main/ipc/chrome.js:527` (moved, Phase 1) | `setAppIcon(id)` | appearance |
| 33 | `memories:get-video-quality` | `main/ipc/media.js:46` (moved, Phase 1) | `getVideoQuality()` | media |
| 34 | `memories:set-video-quality` | `main/ipc/media.js:48` (moved, Phase 1) | `setVideoQuality(quality)` | media |
| 35 | `memories:videos-cost-estimate` | `main/ipc/media.js:71` (moved, Phase 1) | `videosCostEstimate()` | media |
| 36 | `memories:get-whisper-model` | `main/ipc/media.js:99` (moved, Phase 1) | `getWhisperModel()` | media |
| 37 | `memories:set-whisper-model` | `main/ipc/media.js:106` (moved, Phase 1) | `setWhisperModel(model)` | media, re-transcribes |
| 38 | `memories:get-ocr-langs` | `main/ipc/media.js:155` (moved, Phase 1) | `getOcrLangs()` | media |
| 39 | `memories:set-ocr-langs` | `main/ipc/media.js:162` (moved, Phase 1) | `setOcrLangs(langs)` | media, re-OCRs |
| 40 | `memories:reocr-photos` | `main/ipc/media.js:211` (moved, Phase 1) | `reocrPhotos()` | media |
| 41 | `memories:reanalyze-videos` | `main/ipc/media.js:313` (moved, Phase 1) | `reanalyzeVideos()` | media |
| 42 | `memories:suspected-truncated` | `main/ipc/media.js:323` (moved, Phase 1) | `suspectedTruncatedVideos()` | media |
| 43 | `memories:set-background-paused` | 7508 | `setBackgroundPaused(paused)` | pumps gate |
| 44 | `memories:versions-list` | `main/ipc/versions.js:176` (moved, Phase 1) | `getEmbeddingVersions()` | versions |
| 45 | `memories:versions-create` | `main/ipc/versions.js:181` (moved, Phase 1) | `createEmbeddingVersion(name)` | versions |
| 46 | `memories:versions-rename` | `main/ipc/versions.js:193` (moved, Phase 1) | `renameEmbeddingVersion(slug, name)` | versions |
| 47 | `memories:versions-delete` | `main/ipc/versions.js:198` (moved, Phase 1) | `deleteEmbeddingVersion(slug)` | versions |
| 48 | `memories:versions-restore` | `main/ipc/versions.js:203` (moved, Phase 1) | `restoreEmbeddingVersion(slug)` | versions |
| 49 | `memories:purge-background` | `main/ipc/versions.js:429` (moved, Phase 1) | `purgeBackground()` | pumps + versions |
| 50 | `memories:library-reset` | `main/ipc/versions.js:444` (moved, Phase 1) | `resetLibrary()` | versions/reset |
| 51 | `memories:get-ai-insights` | `main/ipc/llm-ask.js:46` (moved from `main.js:7894`, Phase 1) | `getAiInsights(filename)` | llm/ask |
| 52 | `memories:llm-status` | `main/ipc/llm-ask.js:140` (moved, Phase 1) | `getLlmStatus()` | llm/ask |
| 53 | `memories:llm-set-config` | `main/ipc/llm-ask.js:150` (moved, Phase 1) | `setLlmConfig(patch)` | llm/ask |
| 54 | `memories:llm-download` | `main/ipc/llm-ask.js:174` (moved, Phase 1) | `downloadLlm(target)` | llm/ask |
| 55 | `memories:ask-stop` | `main/ipc/llm-ask.js:191` via wrapper `on` (moved from `main.js:8039`, Phase 1) | `stopAsk(reqId)` via `send` | only `on` channel |
| 56 | `memories:ask` | `main/ipc/llm-ask.js:204` (moved from `main.js:8052`, Phase 1) | `askScm(payload)` | llm/ask |
| 57 | `memories:youtube-status` | `main/ipc/youtube.js:901` (moved from `main.js:9131`, Phase 1) | `getYoutubeStatus()` | youtube |
| 58 | `memories:youtube-ensure-binary` | `main/ipc/youtube.js:903` (moved, Phase 1) | `ensureYoutubeBinary()` | youtube |
| 59 | `memories:youtube-add` | `main/ipc/youtube.js:916` (moved, Phase 1) | `addYoutubeChannel(payload)` | youtube |
| 60 | `memories:youtube-remove` | `main/ipc/youtube.js:946` (moved, Phase 1) | `removeYoutubeChannel(url)` | youtube |
| 61 | `memories:youtube-download` | `main/ipc/youtube.js:958` (moved, Phase 1) | `downloadYoutube(payload)` | youtube |
| 62 | `memories:youtube-set-config` | `main/ipc/youtube.js:974` (moved, Phase 1) | `setYoutubeConfig(patch)` | youtube |
| 63 | `memories:youtube-files` | `main/ipc/youtube.js:986` (moved, Phase 1) | `getYoutubeFiles()` | youtube |

## Renderer push (`on*`)

| Channel | preload | Sender |
|---------|---------|--------|
| `memories:status` | `onStatus(cb)` | all trays/library/llm broadcasts via `win.webContents.send` |
| `memories:ask-evidence` | `onAskEvidence(cb)` | ask flow |
| `memories:ask-token` | `onAskToken(cb)` | ask flow |
| `memories:ask-phase` | `onAskPhase(cb)` | ask flow |

## CI rule (Phase 0 gate)

Adding a channel without updating this file fails review. Regenerate with:

```bash
grep -n "ipcMain.handle\|ipcMain.on" main.js
grep -n "invoke\|send\|ipcRenderer.on" preload.js
```

Init order frozen during moves (`main.js:270-288`): `settings → failed-imports → category-overrides → library-store → embedding-versions → library-reset → llm-config → youtube → llm-server`.
