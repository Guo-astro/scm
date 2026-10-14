"use strict";
// Phase 1 (reveal): pure move from main.js (2026-10-10) — category override,
// Finder reveal, external-player open. No behavior change: same guards (an
// arbitrary string can never open a path of the renderer's choosing).
// Shared refs still owned by main.js arrive via main/context.js and are read
// AT CALL TIME: photosDir (existing slot). Everything else is required
// directly — this module never requires main.js (no cycle). resolveRevealTarget
// is re-exported below for the headless reveal smoke ctx.
const fs = require("fs");
const path = require("path");
const { BrowserWindow, shell } = require("electron");
const { handle } = require("../ipc-wrapper.js");
const ctx = require("../context.js");
const { loadLibrary } = require("../../main-lib/library-store.js");
const {
	CATEGORY_OVERRIDE_VALUES,
	loadCategoryOverrides,
	saveCategoryOverrides,
} = require("../../main-lib/category-overrides.js");

handle(
	"memories:set-category-override",
	(_event, filename, category) => {
		if (typeof filename !== "string" || !filename) {
			return { ok: false, error: "Invalid filename" };
		}
		if (category !== null && !CATEGORY_OVERRIDE_VALUES.has(category)) {
			return { ok: false, error: "Invalid category" };
		}
		const l = loadLibrary();
		const idx = l.filenames.indexOf(filename);
		if (idx === -1) return { ok: false, error: "Unknown file" };
		const hash = l.hashes && l.hashes[idx];
		if (!hash) {
			return {
				ok: false,
				error: "File has no content hash yet — try again shortly",
			};
		}
		const overrides = loadCategoryOverrides();
		if (category === null) delete overrides[hash];
		else overrides[hash] = category;
		saveCategoryOverrides();
		// The grid re-derives categories from the index on this broadcast.
		for (const win of BrowserWindow.getAllWindows()) {
			win.webContents.send("memories:status", { type: "library-updated" });
		}
		return { ok: true };
	},
);
// Resolve the on-disk file that "Show in Finder" should reveal for a library
// filename: the recorded import source when it still exists, otherwise the
// app-managed copy in PHOTOS_DIR. Returns null when the filename is unknown
// or no file is on disk. Kept separate from the IPC handler so the headless
// smoke test can exercise the resolution logic without opening Finder.
function resolveRevealTarget(filename) {
	if (typeof filename !== "string" || !filename) return null;
	const l = loadLibrary();
	const idx = l.filenames.indexOf(filename);
	if (idx === -1) return null;
	const source = l.sources && l.sources[idx];
	const target =
		source && fs.existsSync(source) ? source : path.join(ctx.photosDir, filename);
	return fs.existsSync(target) ? target : null;
}

// Reveal a library item in the OS file manager (Finder on macOS). The
// renderer only supplies a filename from its own grid; the real on-disk path
// is resolved via resolveRevealTarget from the recorded import sources, so an
// arbitrary string can never open a location of the renderer's choosing.
handle("memories:reveal-file", async (_event, filename) => {
	const target = resolveRevealTarget(filename);
	if (!target) return { ok: false };
	shell.showItemInFolder(target);
	return { ok: true };
});

// Open a library video in the OS default player (IINA/VLC/QuickTime). For
// searchable-only containers (mkv/hevc/...) Chromium cannot play them
// in-app, so the lightbox offers this as the full-file path alongside the
// 30 s in-app preview. Resolves the same guarded target as reveal-file —
// an arbitrary string can never open a path of the renderer's choosing —
// and returns { ok:false } when nothing is on disk.
handle("memories:open-external", async (_event, filename) => {
	const target = resolveRevealTarget(filename);
	if (!target) return { ok: false };
	try {
		const err = await shell.openPath(target);
		if (err) {
			console.warn(`[memories] open-external failed for ${filename}: ${err}`);
			return { ok: false, error: err };
		}
		return { ok: true };
	} catch (err) {
		console.warn(
			`[memories] open-external failed for ${filename}: ${err.message}`,
		);
		return { ok: false };
	}
});

// Re-exported for main.js: the reveal smoke driver exercises the guarded
// resolution logic headlessly (no Finder).
module.exports = {
	resolveRevealTarget,
};
