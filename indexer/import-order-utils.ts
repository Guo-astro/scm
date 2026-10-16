// Establish one deterministic chronological order for a media batch before
// it enters the concurrent importer. `fs.readdir` deliberately makes no
// recency guarantee, but the importer's ordered flush preserves this list's
// order in the persisted library.
//
// `statSync` is injected so this stays a small, filesystem-free unit that can
// be tested without Electron. Entries that cannot be stat'ed sort first:
// they will produce a normal per-file import error and must not block valid
// media from retaining chronological order. V8's Array#sort is stable, and
// the explicit original index keeps that property clear and portable.
import { ok, err, type Result } from "./result.ts";

export function sortPathsByMtime(
	paths: string[],
	statSync: (p: string) => { mtimeMs: number },
): string[] {
	const r = sortPathsByMtimeResult(paths, statSync);
	if (!r.ok) throw new TypeError(r.error);
	return r.value as string[];
}

// Total Result variant (L1 FP): same ordering, never throws.
// Invalid input -> {ok:false,error}; per-file stat failures still sort
// first (caller's import path reports the readable error later).
export function sortPathsByMtimeResult(
	paths: unknown,
	statSync: unknown,
): Result<string[]> {
	if (!Array.isArray(paths)) {
		return err("paths must be an array");
	}
	if (typeof statSync !== "function") {
		return err("statSync must be a function");
	}
	const stat = statSync as (p: string) => { mtimeMs: number };
	const ordered = (paths as string[])
		.map((filePath, index) => {
			let mtimeMs = Number.NEGATIVE_INFINITY;
			try {
				const value = Number(stat(filePath).mtimeMs);
				if (Number.isFinite(value)) mtimeMs = value;
			} catch {
				// The import path reports a readable error for this row later.
			}
			return { filePath, index, mtimeMs };
		})
		.sort((a, b) => a.mtimeMs - b.mtimeMs || a.index - b.index)
		.map(({ filePath }) => filePath);
	return ok(ordered);
}
