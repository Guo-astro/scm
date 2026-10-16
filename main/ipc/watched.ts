// Phase 1 (watched): pure move from main.js (2026-10-10) — watched-folders
// core (persist, watchers, poll, sync) + get/reveal/remove handlers. No
// behavior change except one structural fix noted below. Shared refs still
// owned by main.js arrive via main/context.js and are read AT CALL TIME:
// ctx.dataDir (stable const), ctx.importPaths (assigned by main.js),
// ctx.isImportInFlight / ctx.getMigrationState (thunks over main.js `let`
// bindings — same convention as the watched smoke ctx). Everything else is
// required directly — this module never requires main.js (no cycle).
//
// NOTE (stable identity): `watchedFolders` is mutated in place and never
// reassigned, so main.js and scripts/e2e/watched.js keep holding it by
// reference across reloads. Contents are identical to the old assignment.
import fs from "node:fs";
import path from "node:path";
import { shell } from "electron";
import { handle } from "../ipc-wrapper.ts";
import ctx from "../context.ts";

// ---------------------------------------------------------------------------
// Watched folders ("Import Photos" auto-watch).
//
// Importing a FOLDER (native picker or drag & drop) adds it to a persisted
// watch list — individual files are imported once and never watched. The
// library then stays in sync with each watched folder on its own:
//   • every launch re-scans each folder and imports anything new,
//   • while running, fs events (debounced) and a periodic safety-net poll
//     do the same for files that land mid-session.
// Re-scanning is cheap by construction: importPaths dedupes by recorded
// source path, so already-imported files short-circuit before any copy or
// AI work and only genuinely new files are embedded.
// ---------------------------------------------------------------------------

const WATCHED_FOLDERS_FILE = path.join(ctx.dataDir, "watched-folders.json");

// Watched directory paths, in import order (persisted across launches).
const watchedFolders: string[] = [];
// Live fs.watch handles keyed by folder, for teardown and re-arm.
const folderWatchers = new Map<string, fs.FSWatcher>();
// Debounce per folder: a burst of fs events (a copy tool writing several
// files at once) collapses into a single re-scan.
const watchDebounceTimers = new Map<string, NodeJS.Timeout>();
// Folders whose fs.watch could not be armed at all (permissions, exotic
// volumes). Sync re-arm attempts skip these so the poll doesn't retry a
// known failure every cycle (and spam the log); a fresh user import of the
// folder tries again from scratch.
const watchFailedFolders = new Set<string>();
let watchPollTimer: NodeJS.Timeout | null = null;

function loadWatchedFolders() {
	try {
		const parsed = JSON.parse(fs.readFileSync(WATCHED_FOLDERS_FILE, "utf8"));
		if (Array.isArray(parsed.folders)) {
			// In-place (never reassigned): main.js and the watched smoke
			// driver hold this array by reference, so the identity must stay
			// live across reloads. Contents are identical either way.
			watchedFolders.length = 0;
			watchedFolders.push(
				...parsed.folders.filter((p: unknown) => typeof p === "string"),
			);
		}
	} catch {
		/* no watch list yet */
	}
}

function saveWatchedFolders() {
	fs.mkdirSync(ctx.dataDir, { recursive: true });
	fs.writeFileSync(
		WATCHED_FOLDERS_FILE,
		JSON.stringify({ version: 1, folders: watchedFolders }, null, "\t"),
	);
}

// Add a folder to the watch list (idempotent) and arm its live watcher.
// Returns true when the folder is newly watched. Paths are canonicalized
// (path.resolve strips trailing slashes and resolves relative paths), so
// "/Photos" and "/Photos/" are the same watched folder.
function addWatchedFolder(dir: unknown): boolean {
	if (typeof dir !== "string") return false;
	if (!dir) return false;
	const resolved = path.resolve(dir);
	if (watchedFolders.includes(resolved)) return false;
	watchedFolders.push(resolved);
	saveWatchedFolders();
	watchFolder(resolved);
	return true;
}

// Window after a folder change before re-syncing it (see the debounce note
// above).
const WATCH_DEBOUNCE_MS = 3000;
// fs events can be missed entirely on network/synced volumes (iCloud
// placeholders materialize quietly); the poll re-scans everything on a
// schedule so nothing is stranded until the next launch.
const WATCH_POLL_INTERVAL_MS = 60_000;

// Re-scan ONE folder and import anything new. Skips folders that vanished
// (they stay on the watch list — they may come back). While an import or
// migration owns the pipeline, importPaths would refuse, so retry shortly
// instead of dropping the change. Resolves when the (possibly empty) sync
// import settles.
function syncWatchedFolder(folder: string) {
	// A scheduled retry can outlive the watch itself (the user removed the
	// folder while an import was busy). Never sync — or worse, re-arm and
	// importPaths (which auto-watches folders in the batch) would resurrect
	// the folder the user just unwatched.
	if (!watchedFolders.includes(folder)) return Promise.resolve();
	if (ctx.isImportInFlight() || ctx.getMigrationState()) {
		setTimeout(() => syncWatchedFolder(folder), 5000);
		return Promise.resolve();
	}
	let stat: fs.Stats;
	try {
		stat = fs.statSync(folder);
	} catch {
		return Promise.resolve();
	}
	if (!stat.isDirectory()) return Promise.resolve();
	// Re-arm a watcher that errored out earlier (poll-only coverage) — but
	// not one that could never be armed (the set below gates the retry).
	if (!folderWatchers.has(folder) && !watchFailedFolders.has(folder)) {
		watchFolder(folder);
	}
	return ctx.importPaths([folder], { fromWatch: true }).catch((err) => {
		console.warn(
			`[memories] watched-folder sync failed for ${folder}: ${err.message}`,
		);
	});
}

// Re-scan every watched folder, in order. Runs on launch and on the poll;
// awaiting each import keeps the pipeline single-writer.
async function syncWatchedFolders() {
	for (const folder of watchedFolders.slice()) {
		await syncWatchedFolder(folder);
	}
}

// Arm one folder's fs.watch. Recursive on macOS/Windows (catches files
// landing in subfolders); elsewhere it falls back to a top-level watch, and
// the poll covers whatever the platform watch can't see.
function watchFolder(folder: string) {
	if (folderWatchers.has(folder)) return;
	const onChange = () => {
		clearTimeout(watchDebounceTimers.get(folder));
		watchDebounceTimers.set(
			folder,
			setTimeout(() => {
				watchDebounceTimers.delete(folder);
				syncWatchedFolder(folder);
			}, WATCH_DEBOUNCE_MS),
		);
	};
	let watcher: fs.FSWatcher;
	try {
		watcher = fs.watch(folder, { recursive: true }, onChange);
	} catch {
		try {
			watcher = fs.watch(folder, onChange);
		} catch (err) {
			console.warn(
				`[memories] cannot watch ${folder}: ${(err as { message?: string }).message}`,
			);
			watchFailedFolders.add(folder);
			return;
		}
	}
	watchFailedFolders.delete(folder);
	watcher.on("error", () => {
		// The watch died (folder unmounted / permissions). Drop it — the
		// poll still syncs, and the next sync re-arms it.
		folderWatchers.delete(folder);
	});
	folderWatchers.set(folder, watcher);
}

// Load the persisted list, arm every watcher, and start the safety-net poll.
function startWatchedFolderWatchers() {
	loadWatchedFolders();
	for (const folder of watchedFolders) watchFolder(folder);
	watchPollTimer = setInterval(
		() => void syncWatchedFolders(),
		WATCH_POLL_INTERVAL_MS,
	);
}

function stopWatchedFolderWatchers() {
	if (watchPollTimer) {
		clearInterval(watchPollTimer);
		watchPollTimer = null;
	}
	for (const timer of watchDebounceTimers.values()) clearTimeout(timer);
	watchDebounceTimers.clear();
	for (const watcher of folderWatchers.values()) {
		try {
			watcher.close();
		} catch {
			/* already closed */
		}
	}
	folderWatchers.clear();
}

// The watched folders the renderer's panel lists. `exists` tells the UI a
// folder has vanished (unmounted/renamed) so it can say so instead of
// implying it is still being scanned.
function watchedFolderList() {
	return watchedFolders.map((p) => ({ path: p, exists: fs.existsSync(p) }));
}

// The on-disk path "Reveal in Finder" should reveal for a watched folder:
// only folders on the watch list that still exist. The renderer supplies
// the path; this guard keeps an arbitrary string from opening a location of
// the renderer's choosing (same contract as resolveRevealTarget for tiles).
function watchedFolderRevealTarget(folder: unknown): string | null {
	if (typeof folder !== "string" || !folder) return null;
	if (!watchedFolders.includes(folder) || !fs.existsSync(folder)) return null;
	return folder;
}

// Stop watching a folder: drop it from the list, close its watcher, cancel
// any pending debounce, and persist. Photos already imported stay in the
// library — only future auto-imports stop. Returns false when the folder
// wasn't watched.
function removeWatchedFolder(dir: string): boolean {
	const i = watchedFolders.indexOf(dir);
	if (i === -1) return false;
	watchedFolders.splice(i, 1);
	saveWatchedFolders();
	const watcher = folderWatchers.get(dir);
	if (watcher) {
		try {
			watcher.close();
		} catch {
			/* already closed */
		}
		folderWatchers.delete(dir);
	}
	const timer = watchDebounceTimers.get(dir);
	if (timer) {
		clearTimeout(timer);
		watchDebounceTimers.delete(dir);
	}
	watchFailedFolders.delete(dir);
	return true;
}

handle("memories:get-watched-folders", () => watchedFolderList());
handle("memories:reveal-watched-folder", (_event: unknown, folder: unknown) => {
	const target = watchedFolderRevealTarget(folder);
	if (!target) return { ok: false };
	shell.showItemInFolder(target);
	return { ok: true };
});
handle("memories:remove-watched-folder", (_event: unknown, folder: unknown) => {
	if (typeof folder !== "string" || !folder) return { ok: false };
	return { ok: removeWatchedFolder(folder) };
});

export {
	WATCHED_FOLDERS_FILE,
	watchedFolders,
	folderWatchers,
	watchFailedFolders,
	addWatchedFolder,
	syncWatchedFolder,
	syncWatchedFolders,
	startWatchedFolderWatchers,
	stopWatchedFolderWatchers,
	watchedFolderList,
	watchedFolderRevealTarget,
	removeWatchedFolder,
};
