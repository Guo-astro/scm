// Named embedding versions (Settings → Library): point-in-time snapshots of
// everything that defines the searchable state — the index, every model's
// embedding/phrase bins, scene + transcript sidecars, threshold
// calibrations, and category overrides — restorable with one action. The
// photos themselves are NOT copied: rows are validated against PHOTOS_DIR
// on restore and missing files are reported, never silently dropped.
//
// Layout: <DATA_DIR>/versions/<slug>/{manifest.json + snapshot files}.
// main.js owns the idle gate (no import/migration/pump activity), the
// pre-create persist drain, and the post-restore cache reload + pool
// handling; this module owns file enumeration, copying, validation, and
// the manifest. Storage root arrives via initEmbeddingVersions() — same
// pattern as initLibraryStore/initSettings. No electron dependency:
// plain-bun unit tests init with a tmpdir.

import fs from "node:fs";
import path from "node:path";
// Explicit import: global `crypto` is absent on older Electron/node.
import crypto from "node:crypto";
import { MODELS } from "../indexer/models.ts";

let DATA_DIR: string | null = null;
let VERSIONS_DIR: string | null = null;

export function initEmbeddingVersions({
	userDataDir,
}: {
	userDataDir: string;
}): void {
	DATA_DIR = path.join(userDataDir, "library");
	VERSIONS_DIR = path.join(DATA_DIR, "versions");
}

// Cap: oldest versions are never auto-deleted (a silent prune of named
// user data would be the C-05 story all over again) — create refuses past
// the cap and names the remedy instead.
export const MAX_VERSIONS = 10;
const MAX_NAME_LENGTH = 80;

// Bounds-proven casts: initEmbeddingVersions() runs before any accessor
// (module contract — main.js inits right after the data-dir override).
function versionDirFor(slug: string): string {
	return path.join(VERSIONS_DIR as string, slug);
}

function manifestPathFor(slug: string): string {
	return path.join(versionDirFor(slug), "manifest.json");
}

// URL/filename-safe slug: lowercase, runs of anything else become one dash,
// capped so a pasted sentence can't make an absurd directory name.
export function slugifyName(name: unknown): string {
	const slug = String(name || "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	return slug;
}

// Snapshot file inventory for the CURRENT library state: the index, the
// threshold state, the overrides, plus every per-model bin/sidecar that
// exists on disk. Models never built contribute nothing (their absence
// restores as absence — restore never deletes live files it doesn't hold).
export function snapshotFiles(): string[] {
	const files = [
		"memories-index.json",
		"memory-models.json",
		"category-overrides.json",
	];
	for (const modelId of Object.keys(MODELS)) {
		for (const name of [
			`memory-embeddings-${modelId}.bin`,
			`memory-phrase-embeddings-${modelId}.bin`,
			`memory-segments-${modelId}.json`,
			`memory-segment-embeddings-${modelId}.bin`,
			`memory-transcripts-${modelId}.json`,
			`memory-transcript-embeddings-${modelId}.bin`,
		]) {
			try {
				if (fs.statSync(path.join(DATA_DIR as string, name)).isFile())
					files.push(name);
			} catch {
				/* model never built — contributes nothing */
			}
		}
	}
	return files;
}

export function rowHash(filenames: unknown): string {
	return crypto
		.createHash("sha256")
		.update(JSON.stringify(filenames || []))
		.digest("hex");
}

function dirBytes(dir: string): number {
	let total = 0;
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		try {
			if (entry.isDirectory()) total += dirBytes(full);
			else total += fs.statSync(full).size;
		} catch {
			/* raced deletion — count what survived */
		}
	}
	return total;
}

// Parsed manifest.json (shape pinned by the readManifest validation below;
// listVersions still re-checks the arrays so a hand-edited manifest can
// never throw).
export interface VersionManifest {
	version: number;
	name: string;
	slug: string;
	createdAt: string;
	appVersion: string | null;
	activeModelId: string | null;
	modelIds: string[];
	rowCount: number;
	rowHash: string;
	filenames: string[];
	settings: unknown;
}

function readManifest(slug: string): VersionManifest | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(manifestPathFor(slug), "utf8"));
		if (!parsed || parsed.version !== 1 || typeof parsed.name !== "string") {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

export interface VersionListItem {
	slug: string;
	name: string;
	createdAt: string;
	appVersion: string | null;
	activeModelId: string | null;
	modelIds: string[];
	rowCount: number;
	totalBytes: number;
	settings: unknown;
}

export function listVersions(): VersionListItem[] {
	let slugs: string[];
	try {
		slugs = fs
			.readdirSync(VERSIONS_DIR as string, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
	} catch {
		return [];
	}
	const out: VersionListItem[] = [];
	for (const slug of slugs) {
		const manifest = readManifest(slug);
		if (!manifest) continue;
		out.push({
			slug,
			name: manifest.name,
			createdAt: manifest.createdAt,
			appVersion: manifest.appVersion || null,
			activeModelId: manifest.activeModelId || null,
			modelIds: Array.isArray(manifest.modelIds) ? manifest.modelIds : [],
			rowCount: manifest.rowCount ?? 0,
			totalBytes: dirBytes(versionDirFor(slug)),
			settings: manifest.settings || null,
		});
	}
	out.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
	return out;
}

// Copy the live library state into a new named version. Callers flush
// pending persists BEFORE this so the snapshot is coherent; files are
// copied with copyFileSync (each write is independent — a crash mid-copy
// leaves a version WITHOUT a manifest, which listVersions skips, and the
// manifest lands last as the commit marker). opts: { appVersion, settings,
// index } — index is the parsed live memories-index.json (rows + modelId),
// so this module never parses the 35 MB file twice.
export function createVersion({
	name,
	appVersion,
	settings,
	index,
}: {
	name: unknown;
	appVersion?: string;
	settings?: unknown;
	index?: { images?: unknown; modelId?: string } | null;
}): { ok: boolean; error?: string; slug?: string; totalBytes?: number } {
	const trimmed = String(name || "").trim();
	if (!trimmed) return { ok: false, error: "Name the version first." };
	if (trimmed.length > MAX_NAME_LENGTH) {
		return {
			ok: false,
			error: `Keep the name under ${MAX_NAME_LENGTH} characters.`,
		};
	}
	const slug = slugifyName(trimmed);
	if (!slug) {
		return { ok: false, error: "Use letters or numbers in the name." };
	}
	try {
		if (fs.statSync(versionDirFor(slug)).isDirectory()) {
			return {
				ok: false,
				error: `A version named “${trimmed}” already exists — pick another name.`,
			};
		}
	} catch {
		/* free — proceed */
	}
	if (listVersions().length >= MAX_VERSIONS) {
		return {
			ok: false,
			error: `Version limit reached (${MAX_VERSIONS}) — delete one first.`,
		};
	}
	const images = index?.images;
	const filenames = Array.isArray(images) ? images : [];
	const modelIds = Object.keys(MODELS).filter((modelId) => {
		try {
			return fs
				.statSync(
					path.join(DATA_DIR as string, `memory-embeddings-${modelId}.bin`),
				)
				.isFile();
		} catch {
			return false;
		}
	});
	const dir = versionDirFor(slug);
	try {
		fs.mkdirSync(dir, { recursive: true });
		for (const name of snapshotFiles()) {
			try {
				fs.copyFileSync(
					path.join(DATA_DIR as string, name),
					path.join(dir, name),
				);
			} catch {
				/* absent on disk — contributes nothing */
			}
		}
		const manifest = {
			version: 1,
			name: trimmed,
			slug,
			createdAt: new Date().toISOString(),
			appVersion: appVersion || null,
			activeModelId: index?.modelId || null,
			modelIds,
			rowCount: filenames.length,
			rowHash: rowHash(filenames),
			filenames,
			settings: settings || null,
		};
		fs.writeFileSync(manifestPathFor(slug), JSON.stringify(manifest, null, 2));
	} catch (err) {
		const e = err as { message?: string } | null;
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best-effort cleanup */
		}
		return {
			ok: false,
			error: `Could not save the version: ${e && e.message}`,
		};
	}
	return { ok: true, slug, totalBytes: dirBytes(dir) };
}

export function renameVersion(
	slug: string,
	name: unknown,
): { ok: boolean; error?: string } {
	const manifest = readManifest(slug);
	if (!manifest) return { ok: false, error: "That version no longer exists." };
	const trimmed = String(name || "").trim();
	if (!trimmed) return { ok: false, error: "Name the version first." };
	if (trimmed.length > MAX_NAME_LENGTH) {
		return {
			ok: false,
			error: `Keep the name under ${MAX_NAME_LENGTH} characters.`,
		};
	}
	// Renaming keeps the slug (the directory identity) — only the display
	// name changes, so a rename can never orphan or collide on disk. A name
	// taken by ANOTHER version is still refused to keep the list readable.
	if (listVersions().some((v) => v.slug !== slug && v.name === trimmed)) {
		return {
			ok: false,
			error: `Another version is already named “${trimmed}”.`,
		};
	}
	try {
		manifest.name = trimmed;
		fs.writeFileSync(manifestPathFor(slug), JSON.stringify(manifest, null, 2));
	} catch (err) {
		const e = err as { message?: string } | null;
		return { ok: false, error: `Could not rename: ${e && e.message}` };
	}
	return { ok: true };
}

export function deleteVersion(slug: string): { ok: boolean; error?: string } {
	if (!readManifest(slug))
		return { ok: false, error: "That version no longer exists." };
	try {
		fs.rmSync(versionDirFor(slug), { recursive: true, force: true });
	} catch (err) {
		const e = err as { message?: string } | null;
		return { ok: false, error: `Could not delete: ${e && e.message}` };
	}
	return { ok: true };
}

// Copy a version's files back over the live library. Returns the manifest
// plus the filenames whose app copy is missing on disk (rows that would
// restore as ghosts — reported, never silently dropped). Live files the
// version doesn't hold (e.g. a model built AFTER the snapshot) are left
// alone: restore adds knowledge, never destroys what it doesn't know.
// Callers reload in-memory caches and respawn the worker pool afterwards.
export function restoreVersion(
	slug: string,
	photosDir: string,
): {
	ok: boolean;
	error?: string;
	manifest?: VersionManifest;
	missing?: string[];
} {
	const manifest = readManifest(slug);
	if (!manifest) return { ok: false, error: "That version no longer exists." };
	const dir = versionDirFor(slug);
	try {
		for (const entry of fs.readdirSync(dir)) {
			if (entry === "manifest.json") continue;
			const src = path.join(dir, entry);
			try {
				if (!fs.statSync(src).isFile()) continue;
			} catch {
				continue;
			}
			fs.copyFileSync(src, path.join(DATA_DIR as string, entry));
		}
	} catch (err) {
		const e = err as { message?: string } | null;
		return { ok: false, error: `Could not restore: ${e && e.message}` };
	}
	const missing: string[] = [];
	for (const filename of manifest.filenames || []) {
		if (typeof filename !== "string" || !filename) continue;
		try {
			if (!fs.existsSync(path.join(photosDir, filename)))
				missing.push(filename);
		} catch {
			/* existence check failed — don't claim it missing */
		}
	}
	return { ok: true, manifest, missing };
}
