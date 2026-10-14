"use strict";
// Phase 1 (previews): pure move from main.js (2026-10-10) — video poster
// extraction + in-app preview proxies (transcode, cache, prune). No behavior
// change: same concurrency, timeouts, pruning. Shared refs still owned by
// main.js arrive via main/context.js and are read AT CALL TIME: postersDir
// (stable const). Own fns needed by stayers (generatePoster for import,
// ensurePreview for protocol) backfill the shared slots below. This module
// never requires main.js (no cycle).
const fs = require("fs");
const path = require("path");
const ctx = require("../context.js");

// In-app preview proxies for searchable-only videos (mkv/hevc/...): short
// mp4/h264 clips transcoded on demand around the matched scene timestamp so
// Chromium can play them. Cached on disk, pruned by age/size (see below).
// Resolved lazily: ctx.dataDir is assigned by the watched stub, which
// runs after this module loads — a top-level read would race it.
function previewsDir() {
	return path.join(ctx.dataDir, "previews");
}
const PREVIEW_SECONDS = 30;
const PREVIEW_LEAD_SECONDS = 5;
const PREVIEW_TIMEOUT_MS = 120000;
const PREVIEW_MAX_BYTES = 500 * 1024 * 1024;
const PREVIEW_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const previewPending = new Map(); // preview filename → Promise<path>
async function generatePoster(videoPath) {
	const videoUtils = require("../../indexer/video-utils.js");
	const ffmpeg = videoUtils.resolveFfmpeg();
	fs.mkdirSync(ctx.postersDir, { recursive: true });
	const poster = ctx.posterFor(path.basename(videoPath));
	await videoUtils.extractPoster(ffmpeg, videoPath, poster, 480);
	return poster;
}

// ---------------------------------------------------------------------------
// In-app preview proxies for searchable-only videos (mkv/hevc/...).
//
// Chromium cannot demux MKV (and Electron 43 cannot reliably decode HEVC
// 10-bit), so the lightbox shows a poster + "Playback not supported" notice
// for those files. A preview is a short mp4/h264 clip transcoded on demand
// around the matched scene timestamp — playable in Chromium, seekable,
// cheap (30 s at 720p, cached on disk under a deterministic name so repeat
// views never re-transcode).
//
// The transcode runs in the MAIN process through the tracked video-utils
// spawner (same orphan-proof registry as the workers — nunca raw spawn, so
// the ffmpeg-CPU fix covers previews too) with its own timeout. Failures
// resolve to an error (the lightbox falls back to the poster); they never
// throw into the protocol handler.
// ---------------------------------------------------------------------------

function previewFileFor(filename, t) {
	const stem = path.basename(filename, path.extname(filename));
	const at = Math.max(0, Math.round(Number(t) || 0));
	return `${stem}-t${at}-30s.mp4`;
}

// Best-effort LRU prune: drop previews older than a week, then oldest-first
// past the size cap. Never throws; a full disk must not break playback of
// the originals.
function prunePreviews() {
	try {
		if (!fs.existsSync(previewsDir())) return;
		const now = Date.now();
		const entries = [];
		for (const name of fs.readdirSync(previewsDir())) {
			if (!name.endsWith(".mp4")) continue;
			const full = path.join(previewsDir(), name);
			try {
				const st = fs.statSync(full);
				if (now - st.mtimeMs > PREVIEW_MAX_AGE_MS) {
					try {
						fs.unlinkSync(full);
					} catch {
						/* best-effort */
					}
					continue;
				}
				entries.push({ full, size: st.size, mtimeMs: st.mtimeMs });
			} catch {
				/* vanished mid-prune */
			}
		}
		let total = entries.reduce((a, e) => a + e.size, 0);
		if (total <= PREVIEW_MAX_BYTES) return;
		entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
		for (const e of entries) {
			if (total <= PREVIEW_MAX_BYTES) break;
			try {
				fs.unlinkSync(e.full);
				total -= e.size;
			} catch {
				/* best-effort */
			}
		}
	} catch {
		/* pruning must never break playback */
	}
}

function ensurePreview(filename, t) {
	const previewName = previewFileFor(filename, t);
	const cached = previewPending.get(previewName);
	if (cached) return cached;
	const job = (async () => {
		const videoUtils = require("../../indexer/video-utils.js");
		if (!ctx.libraryHasRow(filename)) {
			return { ok: false, error: "unknown file" };
		}
		const src = path.join(ctx.photosDir, path.basename(filename));
		if (!fs.existsSync(src)) {
			return { ok: false, error: "file missing" };
		}
		fs.mkdirSync(previewsDir(), { recursive: true });
		const dest = path.join(previewsDir(), previewName);
		try {
			const st = fs.statSync(dest);
			if (st.size > 0) {
				prunePreviews();
				return { ok: true, path: dest };
			}
		} catch {
			/* not cached — transcode below */
		}
		let ffmpeg;
		try {
			ffmpeg = videoUtils.resolveFfmpeg();
		} catch (err) {
			return { ok: false, error: err.message };
		}
		const start = Math.max(0, (Number(t) || 0) - PREVIEW_LEAD_SECONDS);
		const args = [
			"-y",
			"-ss",
			String(start),
			"-i",
			src,
			"-t",
			String(PREVIEW_SECONDS),
			"-vf",
			"scale=-2:720",
			"-c:v",
			"libx264",
			"-preset",
			"veryfast",
			"-crf",
			"23",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			"-b:a",
			"128k",
			"-movflags",
			"+faststart",
			dest,
		];
		try {
			await new Promise((resolve, reject) => {
				const child = videoUtils.spawnFfmpeg(ffmpeg, args, {
					stdio: ["ignore", "pipe", "pipe"],
				});
				let stderr = "";
				child.stderr.on("data", (d) => {
					stderr += d.toString();
				});
				const timer = setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {
						/* best-effort */
					}
					reject(
						new Error(`preview transcode timed out: ${stderr.slice(-300)}`),
					);
				}, PREVIEW_TIMEOUT_MS);
				child.on("error", (err) => {
					clearTimeout(timer);
					reject(err);
				});
				child.on("close", (code) => {
					clearTimeout(timer);
					if (code === 0) resolve();
					else
						reject(
							new Error(
								`preview transcode exited ${code}: ${stderr.slice(-300)}`,
							),
						);
				});
			});
		} catch (err) {
			try {
				fs.unlinkSync(dest);
			} catch {
				/* partial output must not poison the cache */
			}
			console.warn(
				`[memories] preview failed for ${filename} at ${start}s: ${err.message}`,
			);
			return { ok: false, error: err.message };
		}
		try {
			const st = fs.statSync(dest);
			if (!st.size) {
				try {
					fs.unlinkSync(dest);
				} catch {
					/* best-effort */
				}
				return { ok: false, error: "empty preview" };
			}
		} catch {
			return { ok: false, error: "preview missing" };
		}
		prunePreviews();
		console.log(
			`[memories] preview ready for ${filename} at ${start}s (${previewName})`,
		);
		return { ok: true, path: dest };
	})();
	previewPending.set(previewName, job);
	job.finally(() => {
		previewPending.delete(previewName);
	});
	return job;
}

// Shared slots (import + protocol read these at call time; the older import
// and protocol stub assignments are deleted with this move).
ctx.generatePoster = generatePoster;
ctx.ensurePreview = ensurePreview;

module.exports = {
	generatePoster,
	ensurePreview,
};
