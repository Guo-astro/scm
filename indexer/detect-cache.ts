// Per-file scene-detect result cache (Phase 1.4). Keyed by absolute path +
// size + mtime + the detect-config fingerprint, so a re-import or a quality
// / threshold / engine change misses cleanly. Pattern matches
// main-lib/library-store's memory-models.json: one JSON file, atomic write,
// pure helpers unit-tested without ffmpeg.

import fs from "node:fs";
import path from "node:path";
import nodeCrypto from "node:crypto";

export const CACHE_SCHEMA = "scm-detect-cache/v1";
export const CACHE_FILENAME = "detect-cache.json";
// Soft cap so a library of thousands of videos cannot grow the file forever.
const MAX_ENTRIES = 500;

// Raw JSON shapes (parsed from disk — every field re-validated on read).
interface RawEntry {
	boundaries?: unknown;
	duration?: unknown;
	engine?: unknown;
	wallMs?: unknown;
	createdAt?: string;
}

interface RawCache {
	schema: string;
	entries: Record<string, RawEntry>;
}

export function detectCachePath(cacheDir: string | null | undefined) {
	if (!cacheDir) return null;
	return path.join(cacheDir, CACHE_FILENAME);
}

// Fingerprint of everything that must invalidate a cached plan when it
// changes: the file identity and the detect configuration.
export function detectCacheKey({
	filePath,
	size,
	mtimeMs,
	configKey,
}: {
	filePath: string;
	size: unknown;
	mtimeMs: unknown;
	configKey: unknown;
}) {
	const h = nodeCrypto.createHash("sha256");
	h.update(String(filePath));
	h.update("\0");
	h.update(String(size));
	h.update("\0");
	h.update(String(mtimeMs));
	h.update("\0");
	h.update(String(configKey));
	return h.digest("hex");
}

export function fileIdentity(filePath: string) {
	const st = fs.statSync(filePath);
	return { size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
}

function emptyCache(): RawCache {
	return { schema: CACHE_SCHEMA, entries: {} };
}

export function readCache(cachePath: string | null): RawCache {
	if (!cachePath || !fs.existsSync(cachePath)) {
		return emptyCache();
	}
	try {
		const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
		if (
			!raw ||
			raw.schema !== CACHE_SCHEMA ||
			typeof raw.entries !== "object"
		) {
			return emptyCache();
		}
		return raw as RawCache;
	} catch {
		return emptyCache();
	}
}

export function writeCache(cachePath: string | null, cache: RawCache) {
	if (!cachePath) return;
	const dir = path.dirname(cachePath);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = `${cachePath}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, JSON.stringify(cache) + "\n");
	fs.renameSync(tmp, cachePath);
}

export function pruneEntries(entries: Record<string, RawEntry>) {
	const keys = Object.keys(entries);
	if (keys.length <= MAX_ENTRIES) return entries;
	// Drop oldest by createdAt.
	keys.sort((a, b) => {
		const ta = entries[a]?.createdAt || "";
		const tb = entries[b]?.createdAt || "";
		return ta < tb ? -1 : ta > tb ? 1 : 0;
	});
	const out: Record<string, RawEntry> = {};
	for (const k of keys.slice(keys.length - MAX_ENTRIES)) {
		// Cast: the keys came from Object.keys(entries) — dense by origin.
		out[k] = entries[k] as RawEntry;
	}
	return out;
}

export function getCachedDetect(
	cacheDir: string | null | undefined,
	{
		filePath,
		size,
		mtimeMs,
		configKey,
	}: {
		filePath: string;
		size: unknown;
		mtimeMs: unknown;
		configKey: unknown;
	},
) {
	const cachePath = detectCachePath(cacheDir);
	if (!cachePath) return null;
	const key = detectCacheKey({ filePath, size, mtimeMs, configKey });
	const cache = readCache(cachePath);
	const hit = cache.entries[key];
	if (!hit) return null;
	// Defensive: never serve a malformed entry.
	if (!Array.isArray(hit.boundaries)) return null;
	return {
		boundaries: hit.boundaries.map(Number).filter((x) => Number.isFinite(x)),
		duration: hit.duration == null ? null : Number(hit.duration),
		// Casts: the raw fields are JSON-typed unknown; the coercions below
		// are the pre-conversion behavior verbatim.
		engine: (hit.engine as string) || null,
		wallMs: (hit.wallMs as number | null) ?? null,
		cached: true,
	};
}

export function setCachedDetect(
	cacheDir: string | null | undefined,
	{
		filePath,
		size,
		mtimeMs,
		configKey,
	}: {
		filePath: string;
		size: unknown;
		mtimeMs: unknown;
		configKey: unknown;
	},
	result: {
		boundaries?: unknown;
		duration?: unknown;
		engine?: unknown;
		wallMs?: unknown;
	},
) {
	const cachePath = detectCachePath(cacheDir);
	if (!cachePath) return false;
	const key = detectCacheKey({ filePath, size, mtimeMs, configKey });
	const cache = readCache(cachePath);
	cache.entries[key] = {
		boundaries: result.boundaries || [],
		duration: result.duration ?? null,
		engine: result.engine || null,
		wallMs: result.wallMs ?? null,
		createdAt: new Date().toISOString(),
	};
	cache.entries = pruneEntries(cache.entries);
	writeCache(cachePath, cache);
	return true;
}
