// Import-failure cache (C-01 Wave 2, slice S2).
// Remembers files that failed to import (keyed by source path + size/mtime)
// so watched-folder events and polls skip them until they CHANGE. Storage
// root arrives via initFailedImports() — main.js calls it after the
// MEMORIES_DATA_DIR override. No electron dependency (plain-bun tested).

import fs from "node:fs";
import path from "node:path";

let DATA_DIR: string | null = null;

export function initFailedImports({ dataDir }: { dataDir: string }): void {
	DATA_DIR = dataDir;
}

// Bounds-proven cast: initFailedImports() runs before any accessor (module
// contract — main.js inits right after the data-dir override).
export const failedImportsFile = (): string =>
	path.join(DATA_DIR as string, "failed-imports.json");

// ---------------------------------------------------------------------------
// Import-failure cache.
//
// A file in a watched folder that can never embed (corrupt/truncated media,
// an unsupported codec, an embed that always times out) would otherwise be
// re-copied and re-attempted on every fs event and every 60s poll forever,
// monopolizing the single-writer pipeline and pausing enrichment/OCR. Each
// failure is remembered here keyed by source path + size/mtime; after
// MAX_IMPORT_FAILURES identical attempts the file is skipped until it CHANGES
// (a file that was mid-write gets its size/mtime bumped, invalidating the
// entry and retrying — so this never permanently strands a recoverable file).
// ---------------------------------------------------------------------------

export const MAX_IMPORT_FAILURES = 3;

export interface ImportFailureRecord {
	count: number;
	size: number;
	mtimeMs: number;
}

let failedImports: Record<string, ImportFailureRecord> | null = null;
let failedImportsDirty = false;

export function loadFailedImports(): Record<string, ImportFailureRecord> {
	if (failedImports) return failedImports;
	// Local first: strict TS keeps try/catch assignments conservative, and
	// the empty-object fallback must not leak out of the catch.
	let loaded: Record<string, ImportFailureRecord>;
	try {
		const parsed = JSON.parse(fs.readFileSync(failedImportsFile(), "utf8"));
		loaded =
			parsed && parsed.failed && typeof parsed.failed === "object"
				? parsed.failed
				: {};
	} catch {
		loaded = {};
	}
	failedImports = loaded;
	// Prune entries whose source no longer exists (the file was deleted or
	// the folder unwatched) so the cache can't grow without bound.
	for (const p of Object.keys(loaded)) {
		if (!fs.existsSync(p)) delete loaded[p];
	}
	return loaded;
}

// Fresh-start wipe: forget every remembered failure (memory + disk) so a
// re-imported file gets a clean evaluation instead of a cached skip.
export function clearFailedImports(): void {
	failedImports = {};
	failedImportsDirty = true;
	saveFailedImports();
}

export function saveFailedImports(): void {
	if (!failedImportsDirty) return;
	failedImportsDirty = false;
	try {
		fs.mkdirSync(DATA_DIR as string, { recursive: true });
		fs.writeFileSync(
			failedImportsFile(),
			JSON.stringify({ version: 1, failed: failedImports }, null, "\t"),
		);
	} catch (err) {
		const e = err as { message?: string } | null;
		console.warn(`[memories] failed-imports save failed: ${e && e.message}`);
	}
}

// System-wide indexer failures (worker crashed, pool gone, model down) are
// transient and hit EVERY file in a batch — caching them would poison the
// whole library until each file changed. Only file-level failures (corrupt
// media, embed timeouts, copy stalls) are remembered.
export function isSystemIndexerError(err: unknown): boolean {
	const e = err as { message?: string } | null;
	const msg = e && e.message ? e.message : "";
	return (
		msg.startsWith("Indexer not running") ||
		msg.startsWith("Indexer exited") ||
		msg.startsWith("AI indexing unavailable")
	);
}

// Record a file that failed to import (stamped with its current size/mtime so
// a later change invalidates the entry and allows a retry).
export function rememberImportFailure(filePath: string): void {
	try {
		const st = fs.statSync(filePath);
		const rec = loadFailedImports()[filePath];
		loadFailedImports()[filePath] = {
			// Count consecutive failures of the UNCHANGED file; a changed file
			// (or a missing entry) restarts at 1.
			count:
				rec && rec.size === st.size && rec.mtimeMs === st.mtimeMs
					? (rec.count || 0) + 1
					: 1,
			size: st.size,
			mtimeMs: st.mtimeMs,
		};
		failedImportsDirty = true;
		saveFailedImports();
	} catch {
		/* unreadable — nothing to remember */
	}
}

// True when the file has failed MAX_IMPORT_FAILURES times UNCHANGED — skip it
// without copying. A changed file clears its entry (the retry may run).
export function isKnownImportFailure(filePath: string): boolean {
	const rec = loadFailedImports()[filePath];
	if (!rec) return false;
	try {
		const st = fs.statSync(filePath);
		if (st.size === rec.size && st.mtimeMs === rec.mtimeMs) {
			return (rec.count || 0) >= MAX_IMPORT_FAILURES;
		}
	} catch {
		/* file vanished — fall through to clearing */
	}
	delete loadFailedImports()[filePath];
	failedImportsDirty = true;
	saveFailedImports();
	return false;
}

// A successful import retires any failure-cache entry for the file
// (it was transient after all — the cache is only for poison files).
export function retireImportFailure(filePath: string): void {
	const cache = loadFailedImports();
	if (cache && cache[filePath]) {
		delete cache[filePath];
		failedImportsDirty = true;
		saveFailedImports();
	}
}
