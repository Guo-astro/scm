// Fresh-start wipe (Settings → Library → danger zone): file-level half of
// deleting the entire photo index. Removes library-state files and empties
// the app-managed content dirs; everything else in DATA_DIR survives
// (settings.json, watched-folders.json, memory-models.json,
// memory-queries.json, versions/, models/, ocr-data/, llm/). Queue
// draining, watcher teardown, in-memory cache resets, and the idle gate
// live in main.js — this module only touches the disk, so plain-bun unit
// tests can drive it against a tmpdir.

import fs from "node:fs";
import path from "node:path";

let DATA_DIR: string | null = null;

export function initLibraryReset({ dataDir }: { dataDir: string }): void {
	DATA_DIR = dataDir;
}

// Library-state filenames in DATA_DIR that a reset removes.
export function resettableFileNames(): string[] {
	const exact = new Set([
		"memories-index.json",
		"failed-imports.json",
		"category-overrides.json",
		"memory-embeddings.bin",
		"memory-phrase-embeddings.bin",
	]);
	const prefixes = [
		"memory-embeddings-",
		"memory-phrase-embeddings-",
		"memory-segments-",
		"memory-segment-embeddings-",
		"memory-transcripts-",
		"memory-transcript-embeddings-",
	];
	const out: string[] = [];
	let entries: string[];
	try {
		entries = fs.readdirSync(DATA_DIR as string);
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (
			exact.has(entry) ||
			prefixes.some((p) => entry.startsWith(p)) ||
			/^memory-.*\.tmp-/.test(entry)
		) {
			out.push(entry);
		}
	}
	return out;
}

// Best-effort unlink; true when something was removed.
function unlinkBestEffort(file: string): boolean {
	try {
		if (!fs.statSync(file).isFile()) return false;
	} catch {
		return false;
	}
	try {
		fs.unlinkSync(file);
		return true;
	} catch {
		return false;
	}
}

// Empty a directory's CONTENTS (files and subdirs), keeping the directory
// itself — producers (loadLibrary, poster/thumb writers) mkdir on use.
function emptyDirContents(dir: string): number {
	let removed = 0;
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return 0;
	}
	for (const entry of entries) {
		try {
			fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
			removed++;
		} catch {
			/* keep going — the result reports the shortfall */
		}
	}
	return removed;
}

// Delete every resettable file + empty the app-managed content dirs.
// Returns { files } — the count actually removed.
export function resetLibraryFiles(): { files: number } {
	let files = 0;
	for (const name of resettableFileNames()) {
		if (unlinkBestEffort(path.join(DATA_DIR as string, name))) files++;
	}
	for (const sub of ["photos", "posters", "thumbs"]) {
		files += emptyDirContents(path.join(DATA_DIR as string, sub));
	}
	return { files };
}
