// Manual category overrides (C-01 Wave 2, slice S3).
// The user's explicit Add to / Remove from Screenshots decisions, keyed by
// CONTENT HASH so they survive renames and re-imports. Storage root arrives
// via initCategoryOverrides() — main.js calls it after the
// MEMORIES_DATA_DIR override. No electron dependency (plain-bun tested).

import fs from "node:fs";
import path from "node:path";

let DATA_DIR: string | null = null;

export function initCategoryOverrides({ dataDir }: { dataDir: string }): void {
	DATA_DIR = dataDir;
}

// Bounds-proven cast: initCategoryOverrides() runs before any accessor
// (module contract — main.js inits right after the data-dir override).
const categoryOverridesFile = (): string =>
	path.join(DATA_DIR as string, "category-overrides.json");

// ---------------------------------------------------------------------------
// Manual category overrides (Screenshots tab): the user's explicit Add to /
// Remove from Screenshots decisions, keyed by CONTENT HASH so they survive
// renames and re-imports — any future row with the same bytes lands in the
// same bucket. A null decision removes the override, falling back to
// the automatic signals. Display-only metadata: no embedding row changes.
// ---------------------------------------------------------------------------

export const CATEGORY_OVERRIDE_VALUES = new Set(["Screenshots", "Projects"]);
let categoryOverrides: Record<string, string> | null = null;

export function loadCategoryOverrides(): Record<string, string> {
	if (categoryOverrides) return categoryOverrides;
	// Local first: strict TS keeps try/catch assignments conservative, and
	// the empty-object fallback must not leak out of the catch.
	let loaded: Record<string, string>;
	try {
		const parsed = JSON.parse(fs.readFileSync(categoryOverridesFile(), "utf8"));
		loaded =
			parsed && parsed.overrides && typeof parsed.overrides === "object"
				? parsed.overrides
				: {};
		// Drop anything that isn't a known bucket so a hand-edited file can
		// never inject a phantom category.
		for (const [hash, value] of Object.entries(loaded)) {
			if (!CATEGORY_OVERRIDE_VALUES.has(value)) delete loaded[hash];
		}
	} catch {
		loaded = {};
	}
	categoryOverrides = loaded;
	return categoryOverrides;
}

export function saveCategoryOverrides(): void {
	try {
		fs.mkdirSync(DATA_DIR as string, { recursive: true });
		fs.writeFileSync(
			categoryOverridesFile(),
			JSON.stringify({ version: 1, overrides: categoryOverrides }, null, "\t"),
		);
	} catch (err) {
		const e = err as { message?: string } | null;
		console.warn(
			`[memories] category-overrides save failed: ${e && e.message}`,
		);
	}
}

// Fresh-start wipe: drop every manual decision (memory + disk). Content
// hashes are stable, so keeping them would resurrect old buckets on
// re-import — the opposite of clean.
export function clearCategoryOverrides(): void {
	categoryOverrides = {};
	saveCategoryOverrides();
}
