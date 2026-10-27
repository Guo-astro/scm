// App settings + appearance-icon helpers (C-01 Wave 2, slice S1).
// Owns settings.json IO and the validated-fallback accessors the main
// process and renderer share. Storage root arrives via initSettings() —
// main.js calls it right after the MEMORIES_DATA_DIR override, so smoke
// launches keep pointing at their scratch dir. No electron dependency:
// plain-node unit tests init with a tmpdir.
//
// Stage B (ts-migration): converted .js → .ts, import/export syntax, and
// tsc-checked (dist-main still emits CJS). The bare require() calls in the
// video-quality accessors below are deliberate: indexer/video-budget.js
// requires this module at load, so a static import would be a require
// cycle. They stay require() until the Stage C ESM flip (dynamic-require
// audit) — see the matching pre-arming note in eslint.config.js.

import fs from "node:fs";
import path from "node:path";
import {
	parseWhisperModel,
	DEFAULT_WHISPER_MODEL,
} from "../indexer/whisper-models.js";
import { OCR_LANG_IDS, DEFAULT_OCR_LANGS } from "../indexer/ocr-lang-list.ts";

export { OCR_LANG_IDS, DEFAULT_OCR_LANGS };

let USER_DATA_DIR: string | null = null;

export function initSettings({ userDataDir }: { userDataDir: string }): void {
	USER_DATA_DIR = userDataDir;
	// A fresh storage root invalidates the cache (unit tests re-init with a
	// new tmpdir; the main process inits once before any read).
	settingsCache = null;
}

// Bounds-proven cast: initSettings() runs before any accessor (module
// contract — main.js inits right after the data-dir override); the cast
// keeps path.join's null behavior instead of adding a dead branch.
const settingsFile = (): string =>
	path.join(USER_DATA_DIR as string, "settings.json");

// P3 (CTO review 2026-09-14): readSettings() used to readFileSync +
// JSON.parse on EVERY accessor call (whisper model read per pump tick, app
// icon reads, tray rebuilds, menu reads) — dozens of parses per minute for
// a file that changes a few times per session, with a real correctness flap:
// a read racing an atomic rename could observe a missing/partial file and
// fall back to defaults mid-session. The cache below is write-through (every
// writeSettings drops it) and stat-validated (mtimeMs + size) on every read,
// so external edits to settings.json (hand edits, a second app instance)
// are still picked up — at one statSync per read instead of a full parse.

// App icon ids (Dock + BrowserWindow). Persisted as settings.json `appIcon`
// (validated; defaults to scm-vhs).
export const APP_ICON_IDS: string[] = [
	"scm-vhs",
	"scm-vhs-player",
	"scm-kodak",
	"scm-bot",
	"vh1",
	"vh2",
];
export const DEFAULT_APP_ICON = "scm-vhs"; // VHS — Retro tape (default for new installs)

export function parseAppIcon(value: unknown): string {
	if (typeof value === "string" && APP_ICON_IDS.includes(value)) return value;
	return DEFAULT_APP_ICON;
}

export function appIconFileFor(id: unknown): string {
	return `${parseAppIcon(id)}.png`;
}

export function readAppIcon(): string {
	try {
		const raw = JSON.parse(fs.readFileSync(settingsFile(), "utf-8")).appIcon;
		return parseAppIcon(raw);
	} catch {
		return DEFAULT_APP_ICON;
	}
}

// ---------------------------------------------------------------------------
// Settings (persisted shortcut, etc.)
// ---------------------------------------------------------------------------

// { stat: { mtimeMs, size }, data } — see P3 note above.
let settingsCache: {
	stat: { mtimeMs: number; size: number };
	data: Record<string, any>;
} | null = null;

export function readSettings(): Record<string, any> {
	const file = settingsFile();
	try {
		const stat = fs.statSync(file);
		if (
			settingsCache &&
			settingsCache.stat.mtimeMs === stat.mtimeMs &&
			settingsCache.stat.size === stat.size
		) {
			return settingsCache.data;
		}
		const data = JSON.parse(fs.readFileSync(file, "utf-8"));
		settingsCache = { stat: { mtimeMs: stat.mtimeMs, size: stat.size }, data };
		return data;
	} catch {
		// Missing or corrupt file: {} like before. Deliberately NOT cached —
		// the file may appear (first write) or be repaired (external edit)
		// between calls, and there is no stat to validate a cache against.
		return {};
	}
}

export function writeSettings(patch: Record<string, any>): Record<string, any> {
	const prev = readSettings();
	const next = { ...prev, ...patch };
	// Write-through: drop the cache so the next read revalidates against the
	// file we just wrote (rename + fallback paths both change the inode).
	settingsCache = null;
	fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
	// Atomic write so a crash mid-write never leaves truncated JSON that
	// would make readAppIcon()/readMenuBarOnly() fall back to defaults.
	// This is the user-visible "didn't stick" case when the file is
	// half-written while the Dock is hidden.
	const tmp = `${settingsFile()}.tmp-${process.pid}-${Date.now()}`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
		try {
			const fd = fs.openSync(tmp, "r");
			try {
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			/* fsync is best-effort */
		}
		fs.renameSync(tmp, settingsFile());
		// Also fsync the directory so the rename is durable on APFS.
		try {
			const dirFd = fs.openSync(path.dirname(settingsFile()), "r");
			try {
				fs.fsyncSync(dirFd);
			} finally {
				fs.closeSync(dirFd);
			}
		} catch {
			/* directory fsync is best-effort */
		}
	} catch (err) {
		const e = err as { message?: string } | null;
		console.warn(`[settings] atomic write failed: ${e && e.message}`);
		// Fallback to direct write so the setting is not lost even if tmp/rename fails
		try {
			fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
		} catch (fallbackErr) {
			const e2 = fallbackErr as { message?: string } | null;
			console.warn(
				`[settings] fallback write also failed: ${e2 && e2.message}`,
			);
		}
		// Clean up tmp if it exists
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* ignore */
		}
	}
	return next;
}

// ---------------------------------------------------------------------------
// Video search quality (Settings → Video search): the scene-segment density
// preset for background enrichment. Stored in settings.json so the main
// process (which queues enrichment) and the renderer (which displays it)
// share one source of truth; the worker receives the resolved (target, min,
// max) triple per enrich-video message. Only affects enrichment planned
// AFTER the change — existing sidecars keep their old density until the
// user runs "Re-analyze videos".
// ---------------------------------------------------------------------------

export function readVideoQuality(): string {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberately-lazy (cycle break: video-budget reads settings via main)
		return require("../indexer/video-budget.js").parseVideoQuality(
			readSettings().videoQuality,
		);
	} catch {
		// eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberately-lazy (cycle break: video-budget reads settings via main)
		return require("../indexer/video-budget.js").DEFAULT_VIDEO_QUALITY;
	}
}

// The resolved (targetSeconds, minSegments, maxSegments) triple for the
// user's current preset — what actually rides the enrich-video message.
// Return type is the unchecked video-budget module's own shape (any).
export function videoBudgetForCurrentQuality(): any {
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberately-lazy (cycle break: video-budget reads settings via main)
	const vu = require("../indexer/video-budget.js");
	return vu.budgetForQuality(readVideoQuality());
}

// ---------------------------------------------------------------------------
// Speech model (Settings → Video search → Speech model): the whisper engine
// for background transcription. Stored in settings.json (same validated-
// fallback pattern as video quality); the resolved id rides each
// transcribe-video message and the sidecar is stamped with it — a switch
// invalidates the sidecar (transcripts are model-quality-dependent) and
// re-queues every video. Default tiny.en = today's behavior.
// ---------------------------------------------------------------------------

export function readWhisperModel(): string {
	try {
		return parseWhisperModel(readSettings().whisperModel);
	} catch {
		return DEFAULT_WHISPER_MODEL;
	}
}

// Delete the orphaned small.en weight cache (~1GB) left by the removed rung.
// Checks both the current transformers.js layout (<cache>/Xenova/
// whisper-small.en) and the legacy v1 layout (<cache>/models--Xenova--
// whisper-small.en). Missing paths are normal (never downloaded). Never
// throws — cleanup must not block boot.
export function cleanupRemovedWhisperWeights(): void {
	try {
		const cacheRoot = path.join(USER_DATA_DIR as string, "models");
		const targets = [
			path.join(cacheRoot, "Xenova", "whisper-small.en"),
			path.join(cacheRoot, "models--Xenova--whisper-small.en"),
		];
		for (const target of targets) {
			try {
				if (!fs.existsSync(target)) continue;
				const stat = fs.statSync(target);
				if (stat.isDirectory()) {
					fs.rmSync(target, { recursive: true, force: true });
				} else {
					fs.unlinkSync(target);
				}
				console.log(
					`[memories] removed orphaned whisper-small.en weights: ${target}`,
				);
			} catch (err) {
				const e = err as { message?: string } | null;
				console.warn(
					`[memories] could not remove orphaned weights ${target}: ${e && e.message}`,
				);
			}
		}
	} catch (err) {
		const e = err as { message?: string } | null;
		console.warn(
			`[memories] whisper weights cleanup skipped: ${e && e.message}`,
		);
	}
}

// ---------------------------------------------------------------------------
// OCR text languages (Settings → Photo Search → Text languages): which
// tesseract traineddata files the OCR worker loads. English is always on
// (locked); each table entry is a toggle stored as settings.json `ocrLangs`
// (array of ids). Same validated-fallback pattern as video quality / whisper.
// Default = the CJK set (fresh-install behavior since the CJK rollout);
// everything else is opt-in (each extra model slows background recognition).
// Ids, order and defaults come from indexer/ocr-lang-list.js — the single
// source of truth shared with the worker and main.js.
// ---------------------------------------------------------------------------

export function parseOcrLangs(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [...DEFAULT_OCR_LANGS];
	const out: string[] = [];
	for (const entry of raw) {
		if (OCR_LANG_IDS.includes(entry) && !out.includes(entry)) {
			out.push(entry);
		}
	}
	return out;
}

export function readOcrLangs(): string[] {
	try {
		return parseOcrLangs(readSettings().ocrLangs);
	} catch {
		return [...DEFAULT_OCR_LANGS];
	}
}

// The tesseract language string the worker loads: eng always first, then the
// enabled CJK models in canonical order (e.g. "eng+chi_sim+chi_tra+jpn+kor").
export function resolveOcrLangString(enabled?: unknown): string {
	const list = Array.isArray(enabled) ? enabled : readOcrLangs();
	const ordered = OCR_LANG_IDS.filter((id) => list.includes(id));
	return ["eng", ...ordered].join("+");
}

// One-time upgrade marker for the CJK rollout (Settings → Photo Search):
// pre-multilang OCR rows were all recognized eng-only (no shipped version
// ever produced CJK rows), so the first launch that sees photo rows without
// this marker force-re-queues the whole library once under the current
// language set. The marker is written ONLY when a full OCR drain completes
// with zero failures (see pumpOcr in main.js) — failed rows keep their prior
// text and retry on the next launch instead of being stamped as migrated.
export function readOcrLangsMigrated(): boolean {
	try {
		return readSettings().ocrLangsMigrated === true;
	} catch {
		return false;
	}
}

// Pure migration decision for backfillOcr (unit-tested): migrate when the
// marker is absent and at least one photo row exists to re-process. The
// library stamp is deliberately NOT consulted — libraries stamped by the
// pre-migration builds may still hold eng-only rows, and only a completed
// drain proves otherwise.
export function shouldMigrateOcrLangs({
	photoCount,
	migrated,
}: {
	photoCount: unknown;
	migrated: unknown;
}): boolean {
	return migrated !== true && Number(photoCount) > 0;
}

export function readMenuBarOnly(): boolean {
	try {
		return readSettings().menuBarOnly === true;
	} catch {
		return false;
	}
}

// Completion notifications for background work, gated two ways: the user
// opted in (settings.json `notifyOnDone`, default true) AND the window is
// currently hidden — while the app is in use the in-app UI already says it.
export function readNotifyOnDone(): boolean {
	try {
		const v = readSettings().notifyOnDone;
		return v === undefined ? true : v === true;
	} catch {
		return true;
	}
}

export function readStartHidden(): boolean {
	try {
		return readSettings().startHidden === true;
	} catch {
		return false;
	}
}

// First-run CRT tour marker (settings.json `onboardingSeen`, default
// false). This is the install-level "has the tour shown" flag: unlike the
// renderer's localStorage copy it survives profile/storage resets, so the
// intro shows exactly once per install. Only `true` counts — anything else
// (missing, corrupt, hand-edited) means "not seen yet".
export function readOnboardingSeen(): boolean {
	try {
		return readSettings().onboardingSeen === true;
	} catch {
		return false;
	}
}
