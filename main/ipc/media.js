"use strict";
// Phase 1 (media): pure move from main.js (2026-10-10) — Video-search
// quality, Whisper engine switch, OCR language switch, manual re-OCR,
// video re-analysis, truncated-sidecar repair scan. No behavior change:
// same validation, sidecar invalidation, re-queues. Shared refs still owned
// by main.js arrive via main/context.js and are read AT CALL TIME: isVideo /
// photosDir (existing slots). Sibling domains are required directly (no
// cycles — none require media back): store sidecars, settings accessors,
// video/whisper/ocr-lang helpers, transcript + OCR pumps (re-queues). This
// module never requires main.js.
const fs = require("fs");
const path = require("path");
const { handle } = require("../ipc-wrapper.js");
const ctx = require("../context.js");
const {
	loadLibrary,
	saveLibrary,
	loadSegments,
	saveSegments,
	loadTranscripts,
	saveTranscripts,
	transcriptsMetaFileFor,
} = require("../../main-lib/library-store.js");
const {
	readVideoQuality,
	readSettings,
	writeSettings,
	readWhisperModel,
	readOcrLangs,
	resolveOcrLangString,
	videoBudgetForCurrentQuality,
	cleanupRemovedWhisperWeights,
} = require("../../main-lib/settings.js");
const { parseWhisperModel } = require("../../indexer/transcript-store-utils.js");
const {
	VIDEO_QUALITY_IDS,
} = require("../../indexer/video-utils.js");
const {
	suspectedTruncated,
} = require("../../indexer/segment-store-utils.js");
const { enqueueEnrichment, enrichQueue } = require("./pumps/enrich.js");
const { enqueueTranscription, transcribeQueue } = require("./pumps/transcribe.js");
const { requeueAllPhotosForOcr } = require("./pumps/ocr.js");

// ---------------------------------------------------------------------------
// Video search quality IPC + re-analysis (Settings → Video search)
// ---------------------------------------------------------------------------

handle("memories:get-video-quality", () => readVideoQuality());

handle("memories:set-video-quality", (_event, quality) => {
	if (typeof quality !== "string" || !VIDEO_QUALITY_IDS.includes(quality)) {
		return {
			ok: false,
			error:
				"Unknown video quality (expected eco, balanced, detailed, ultra, or ultraPro)",
		};
	}
	writeSettings({ videoQuality: quality });
	return { ok: true, quality };
});

// Per-video scene-coverage durations for the Settings → Video search cost
// line (MDs/Ultra-Pro-Plan.md §4.3): the renderer needs the user's own
// library footprint (footage hours, per-video lengths) to state the real
// time/disk bill before they commit to an expensive preset. Measured from
// each video's segment sidecar — the last row's coverage end
// (t + dur/2, same math as the bin header) approximates the duration at
// every preset density, since segment plans span the film end to end.
// Videos without scene data have no measured length yet: counted in
// unknownCount, excluded from `durations` (their bill lands at first
// analysis). Pure sidecar metadata — no ffmpeg spawns, safe whenever the
// Settings sheet opens.
handle("memories:videos-cost-estimate", () => {
	try {
		const l = loadLibrary();
		const videos = l.filenames.filter((name) => ctx.isVideo(name));
		const c = loadSegments(l.modelId);
		const durations = [];
		for (const name of videos) {
			const segs = c.videos.get(name);
			const last = segs && segs.length > 0 ? segs[segs.length - 1] : null;
			const end = last ? last.t + last.dur / 2 : null;
			if (Number.isFinite(end) && end > 0) durations.push(end);
		}
		return {
			ok: true,
			videoCount: videos.length,
			knownSeconds: durations.reduce((sum, s) => sum + s, 0),
			unknownCount: videos.length - durations.length,
			durations,
		};
	} catch (err) {
		return { ok: false, error: err && err.message ? err.message : String(err) };
	}
});

// ---------------------------------------------------------------------------
// Speech model IPC (Settings → Video search → Speech model)
// ---------------------------------------------------------------------------

handle("memories:get-whisper-model", () => readWhisperModel());

// Switch the whisper engine: transcripts are model-quality-dependent, so the
// whole speech sidecar (chunks + utterance lines + progress + bin rows) is
// invalidated and every library video re-queues from 0. In-flight replies
// from the old model are dropped by the pump's race check. Returns the
// re-queued count so the renderer can notify.
handle("memories:set-whisper-model", (_event, model) => {
	let requested = typeof model === "string" ? model : "";
	// Legacy alias: small.en was removed (OOM on 8GB) — treat a stale
	// selection as base.en so old renderers/clients migrate forward.
	if (requested === "small.en") {
		console.log(
			"[memories] speech model small.en removed — migrating request to base.en",
		);
		requested = "base.en";
	}
	const parsed = parseWhisperModel(requested);
	if (typeof model !== "string" || parsed !== requested) {
		return {
			ok: false,
			error: "Unknown speech model (expected tiny.en or base.en)",
		};
	}
	const prev = readWhisperModel();
	writeSettings({ whisperModel: parsed });
	if (parsed === prev) return { ok: true, model: parsed, queued: 0 };
	const l = loadLibrary();
	const c = loadTranscripts(l.modelId);
	c.videos = new Map();
	c.rows = [];
	c.utterances = new Map();
	c.progress = {};
	c.whisperModel = parsed;
	c.loaded = true;
	saveTranscripts();
	const videos = l.filenames.filter((name) => ctx.isVideo(name));
	if (videos.length > 0) {
		enqueueTranscription(
			videos.map((name) => ({
				filename: name,
				path: path.join(ctx.photosDir, name),
				off: 0,
			})),
		);
	}
	console.log(
		`[memories] speech model ${prev} → ${parsed}: sidecar invalidated, ${videos.length} video(s) re-queued`,
	);
	return { ok: true, model: parsed, queued: videos.length };
});

// ---------------------------------------------------------------------------
// OCR text languages IPC (Settings → Photo Search → Text languages)
// ---------------------------------------------------------------------------

handle("memories:get-ocr-langs", () => readOcrLangs());

// Switch the OCR language set: stored OCR text is language-dependent, so
// every library photo re-queues from 0 under the new traineddata set (old
// text stays visible until each row's re-OCR lands). The worker is restarted
// so the next job loads the new models. Returns the re-queued count so the
// renderer can notify. eng is always on — only the four CJK toggles are set.
handle("memories:set-ocr-langs", (_event, langs) => {
	const { parseOcrLangs: parseLangs } = require("../../main-lib/settings.js");
	const parsed = parseLangs(langs);
	if (!Array.isArray(langs)) {
		return {
			ok: false,
			error: "Unknown OCR languages (expected an array of language ids)",
		};
	}
	// Reject unknown ids (but accept any subset, including [] = eng-only).
	// The allowlist is the shared table (indexer/ocr-lang-list.js), not a
	// hardcoded copy — new languages become settable without touching IPC.
	const {
		OCR_LANG_IDS: OCR_IPC_LANG_IDS,
	} = require("../../indexer/ocr-lang-list.js");
	const allowed = new Set(OCR_IPC_LANG_IDS);
	for (const entry of langs) {
		if (!allowed.has(entry)) {
			return {
				ok: false,
				error: "Unknown OCR languages (expected an array of language ids)",
			};
		}
	}
	const prev = readOcrLangs();
	const prevStr = resolveOcrLangString(prev);
	const nextStr = resolveOcrLangString(parsed);
	writeSettings({ ocrLangs: parsed });
	const l = loadLibrary();
	l.ocrLangs = nextStr;
	if (prevStr === nextStr) {
		void saveLibrary();
		return { ok: true, langs: parsed, queued: 0 };
	}
	void saveLibrary();
	const queued = requeueAllPhotosForOcr(`langs ${prevStr} → ${nextStr}`);
	console.log(
		`[memories] OCR langs ${prevStr} → ${nextStr}: ${queued} photo(s) re-queued`,
	);
	return { ok: true, langs: parsed, queued };
});

// Re-read every library photo under the CURRENT language set
// (Settings → Photo Search → "Re-read all photos"). Manual counterpart to
// the one-time upgrade migration: re-queues with force:true (healthy rows
// included — their text may predate the current langs or a failed drain).
// Old text stays visible until each row's re-OCR lands. Returns the queued
// count so the renderer can notify; per-row failures surface in the drain
// summary log and retry on the next launch.
handle("memories:reocr-photos", () => {
	try {
		const queued = requeueAllPhotosForOcr("manual");
		return { ok: true, queued };
	} catch (err) {
		return { ok: false, error: err && err.message ? err.message : String(err) };
	}
});

// Re-analyze every library video under the CURRENT quality preset: drop each
// video's scene-segment sidecar (segment rows + scene posters) and re-queue
// it for background enrichment. New imports are unaffected (they already use
// the current preset); photos are untouched. Progress streams through the
// existing enrich tray; the launch backfill will also pick up anything left
// unprocessed.
async function reanalyzeVideos() {
	const l = loadLibrary();
	const videos = l.filenames.filter((name) => ctx.isVideo(name));
	if (videos.length === 0) return { ok: true, queued: 0 };
	const c = loadSegments(l.modelId);
	// Drop every library video's segment entry, then compact the row space
	// once (same rebuild as removeSegmentsFor, but bulk).
	for (const name of videos) c.videos.delete(name);
	const keep = [];
	for (const segs of c.videos.values()) {
		for (const seg of segs) keep.push(c.rows[seg.off]);
	}
	c.rows = keep;
	let off = 0;
	for (const segs of c.videos.values()) {
		for (const seg of segs) seg.off = off++;
	}
	c.loaded = true;
	saveSegments();
	// Sweep scene posters (<stem>-scene-<i>.jpg) for library videos so no
	// best-scene thumbnail outlives its re-analysis (same sweep as
	// removeLibraryRow, but bulk).
	try {
		const stems = new Set(videos.map((n) => path.basename(n, path.extname(n))));
		for (const entry of fs.readdirSync(ctx.postersDir)) {
			if (!entry.endsWith(".jpg")) continue;
			for (const stem of stems) {
				if (entry.startsWith(`${stem}-scene-`)) {
					try {
						fs.unlinkSync(path.join(ctx.postersDir, entry));
					} catch {
						/* already gone */
					}
					break;
				}
			}
		}
	} catch {
		/* no posters dir yet */
	}
	// Restart queued jobs from segment 0 so the worker rebuilds each plan
	// under the new budget (its cached plan is keyed on path + budget).
	for (const q of enrichQueue) q.off = 0;
	enqueueEnrichment(
		videos.map((name) => ({
			filename: name,
			path: path.join(ctx.photosDir, name),
		})),
	);
	// Transcripts: drop + re-queue both sidecars together so visual and
	// speech coverage stay in sync after a preset/model change.
	try {
		const tc = loadTranscripts(l.modelId);
		for (const name of videos) tc.videos.delete(name);
		const tkeep = [];
		for (const chunks of tc.videos.values()) {
			for (const ch of chunks) tkeep.push(tc.rows[ch.off]);
		}
		tc.rows = tkeep;
		let toff = 0;
		for (const chunks of tc.videos.values()) {
			for (const ch of chunks) ch.off = toff++;
		}
		// Fresh re-analysis restarts every film from slice 0: drop stale
		// resume points so nothing resumes mid-film under a new plan.
		if (tc.progress && typeof tc.progress === "object") {
			for (const name of videos) delete tc.progress[name];
		}
		tc.loaded = true;
		saveTranscripts();
	} catch {
		/* transcript sidecar optional */
	}
	try {
		for (const q of transcribeQueue) q.off = 0;
		enqueueTranscription(
			videos.map((name) => ({
				filename: name,
				path: path.join(ctx.photosDir, name),
			})),
		);
	} catch {
		/* transcribe queue initializes below */
	}
	return { ok: true, queued: videos.length };
}

handle("memories:reanalyze-videos", async () => reanalyzeVideos());

// Sidecars built before the chunk-accumulation fix (pumpEnrichment used to
// REPLACE a file's segment list with the last chunk) are truncated to the
// film's final minutes. Detect them from the current model's sidecar alone —
// no ffmpeg, no disk probing: the signature is a multi-chunk plan (planned >
// SEGMENTS_PER_CHUNK under the current preset) whose surviving segments
// cluster in the tail (span < half the estimated duration). The renderer
// surfaces the count in Settings → Video search and points at the existing
// "Re-analyze existing videos" repair.
handle("memories:suspected-truncated", () =>
	suspectedTruncatedVideos(),
);

function suspectedTruncatedVideos() {
	const l = loadLibrary();
	const c = loadSegments(l.modelId);
	if (!c.loaded || c.videos.size === 0)
		return { ok: true, count: 0, videos: [] };
	const flagged = suspectedTruncated(c.videos, videoBudgetForCurrentQuality());
	// Skip rows whose app copy is gone from disk (hand-deleted outside the
	// app between boot-prunes): they are ghosts, not repair candidates —
	// the boot prune owns removing them, and counting them keeps a stale
	// banner alive for videos the user already deleted.
	const live = flagged.filter((f) => {
		try {
			return fs.existsSync(path.join(ctx.photosDir, f.filename));
		} catch {
			return true;
		}
	});
	return {
		ok: true,
		count: live.length,
		videos: live.map((f) => ({
			filename: f.filename,
			planned: f.planned,
			actual: f.actual,
		})),
	};
}

// Re-exported for main.js: the phase4 smoke ctx injects the repair scan.
module.exports = {
	suspectedTruncatedVideos,
	migrateRemovedWhisperModel,
};

// Whisper small.en removal migration (relocated from protocol.js —
// it rode along inside the moved range; its home is this module).
function migrateRemovedWhisperModel() {
	let migratedSettings = false;
	try {
		const raw = readSettings().whisperModel;
		if (raw === "small.en") {
			writeSettings({ whisperModel: "base.en" });
			migratedSettings = true;
			console.log(
				"[memories] speech model small.en removed — settings migrated to base.en",
			);
		}
	} catch (err) {
		console.warn(
			`[memories] whisper migration settings check skipped: ${err.message}`,
		);
	}
	// Sidecar stamp check (raw JSON, before parseWhisperModel aliases it).
	try {
		const l = loadLibrary();
		const metaFile = transcriptsMetaFileFor(l.modelId);
		const rawStamp = JSON.parse(fs.readFileSync(metaFile, "utf8")).whisperModel;
		if (rawStamp === "small.en") {
			const c = loadTranscripts(l.modelId);
			c.videos = new Map();
			c.rows = [];
			c.utterances = new Map();
			c.progress = {};
			c.whisperModel = "base.en";
			c.loaded = true;
			saveTranscripts();
			console.log(
				"[memories] speech sidecar stamped small.en — invalidated for base.en re-transcription",
			);
		} else if (migratedSettings) {
			// Settings named small.en but the sidecar stamp does not (fresh
			// install mid-download, deleted sidecar): still force a clean
			// base.en stamp so the next commit is unambiguous.
			try {
				const c = loadTranscripts(l.modelId);
				if (c.loaded) {
					c.whisperModel = "base.en";
					saveTranscripts();
				}
			} catch {
				/* sidecar optional — backfill covers it */
			}
		}
	} catch {
		/* no sidecar yet — nothing to invalidate */
	}
	cleanupRemovedWhisperWeights();
}
