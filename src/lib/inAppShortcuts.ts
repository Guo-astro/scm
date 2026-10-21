// In-app shortcut storage (Settings → Keyboard): one versioned record for
// the six library views + the six recordable actions, keyed by shortcut
// id, values are accelerator strings ("" = deliberately unset — dispatch
// skips it, the editor shows "Not set").
//
// Storage generations:
//   v1 (key "scm-view-shortcuts"): flat Record<ViewId, string>, five
//      views, defaults ⌘1–5 with screenshots-ocr on ⌘3.
//   v2 (key "scm-shortcuts"): { v: 2, shortcuts: Record<ShortcutId, string> }.
// Reads fall back v2 → v1 (migrated, written forward) → defaults. The
// legacy key is left frozen, never rewritten, so a downgraded app still
// finds its old map.
//
// Migration (v1 → v2) never overwrites a deliberate choice: entries still
// equal to their OLD default are "untouched" and adopt the NEW mapping
// (email ⌘3, screenshots ⌘4, LLMs ⌘5, dialogue ⌘6); entries the user
// changed are kept verbatim; any id whose preferred combo is taken walks
// the fallback chain, and an id with nothing free lands unset (visible in
// Settings, one click to record).

import {
	DEFAULT_VIEW_SHORTCUTS,
	LEGACY_DEFAULT_VIEW_SHORTCUTS,
	VIEW_DESCRIPTIONS,
	VIEW_IDS,
	VIEW_LABELS,
	isAcceleratorShape,
	type LegacyViewId,
	type ViewId,
} from "./viewShortcuts.ts";
import {
	APP_ACTIONS,
	APP_ACTION_IDS,
	DEFAULT_ACTION_SHORTCUTS,
	GLOBAL_ACTION_IDS,
	LIGHTBOX_ACTION_IDS,
	isAppActionId,
	type AppActionId,
	type ShortcutScope,
} from "./appActions.ts";

export type ShortcutId = ViewId | AppActionId;

/** Flat accelerator map for every recordable in-app shortcut. */
export type ShortcutMap = Record<ShortcutId, string>;

export const SHORTCUTS_KEY = "scm-shortcuts";
export const LEGACY_VIEW_SHORTCUTS_KEY = "scm-view-shortcuts";
export const SHORTCUTS_VERSION = 2;

export const ALL_SHORTCUT_IDS: readonly ShortcutId[] = [
	...VIEW_IDS,
	...APP_ACTION_IDS,
];

export const DEFAULT_SHORTCUTS: ShortcutMap = {
	...DEFAULT_VIEW_SHORTCUTS,
	...DEFAULT_ACTION_SHORTCUTS,
};

// Auto-assignment chain for migrated ids whose preferred combo is taken
// by a kept entry. Deliberately starts at ⌘7: ⌘6 belongs to the
// videos-dialogue default, so consuming it here would cascade into
// dialogue's assignment. Digits 7–9 are also the positional saved-tab
// range — an auto-assigned view claims one, which the Settings reference
// table then reflects (both facts derive from the live map).
export const FALLBACK_CHAIN: readonly string[] = [
	"CommandOrControl+7",
	"CommandOrControl+8",
	"CommandOrControl+9",
	"Alt+CommandOrControl+7",
	"Alt+CommandOrControl+8",
	"Alt+CommandOrControl+9",
];

// In-app combos that already mean something else. The Edit roles matter
// even though they are invisible here: recording ⌘Z/⌘X/⌘C/⌘V/⌘A as a
// view would hijack undo/cut/copy/paste inside the search field the
// moment the combo fires while typing. The menu roles (⌘Q/⌘W/⌘H/⌘M,
// full screen) belong to the window chrome. Recording one of these is
// refused with a message naming the owner; matching never consults this
// list (a hand-edited duplicate still dispatches — deterministically,
// first id wins).
export const RESERVED_SHORTCUTS: Record<string, string> = {
	"CommandOrControl+O": "the Import photos menu item (⌘O)",
	"CommandOrControl+Q": "Quit",
	"CommandOrControl+W": "Close window",
	"CommandOrControl+H": "Hide",
	"CommandOrControl+M": "Minimize",
	"CommandOrControl+Z": "Undo",
	"CommandOrControl+Shift+Z": "Redo",
	"CommandOrControl+X": "Cut",
	"CommandOrControl+C": "Copy",
	"CommandOrControl+V": "Paste",
	"CommandOrControl+A": "Select all",
	"Control+Command+F": "Full screen",
};

/** Which conflict group an id belongs to: handlers in different groups
 *  can never fire on the same keypress TOGETHER (the lightbox dispatcher
 *  consumes and stops propagation while open), so overlapping combos
 *  across groups are legal by design — ⌘I is the built-in example. */
export function shortcutScope(id: ShortcutId): ShortcutScope {
	return isAppActionId(id) ? scopeOfAction(id) : "app";
}

function scopeOfAction(id: AppActionId): ShortcutScope {
	return APP_ACTIONS.find((a) => a.id === id)?.scope ?? "app";
}

export function shortcutLabel(id: ShortcutId): string {
	return isAppActionId(id) ? (labelOfAction(id) ?? id) : VIEW_LABELS[id];
}

export function shortcutDescription(id: ShortcutId): string {
	return isAppActionId(id)
		? (APP_ACTIONS.find((a) => a.id === id)?.description ?? "")
		: VIEW_DESCRIPTIONS[id];
}

function labelOfAction(id: AppActionId): string | undefined {
	return APP_ACTIONS.find((a) => a.id === id)?.label;
}

/**
 * The id already owning this combo within the recording id's conflict
 * group, or null. Used by the recorder to refuse duplicates; groups
 * mirror co-live handlers (views + app-wide actions share "app").
 */
export function findConflictingShortcut(
	id: ShortcutId,
	accel: string,
	map: ShortcutMap,
): ShortcutId | null {
	if (!accel) return null;
	const scope = shortcutScope(id);
	for (const other of ALL_SHORTCUT_IDS) {
		if (other === id) continue;
		if (shortcutScope(other) !== scope) continue;
		if (map[other] === accel) return other;
	}
	return null;
}

/** Digits whose plain ⌘+digit is unclaimed — the positional saved-tab
 *  fallback ("tabs[digit-1]") can only reach those. Powers the live
 *  reference line in Settings. Lightbox-scoped combos are ignored: they
 *  cannot fire while the viewer is closed, so they never shadow a tab. */
export function freePositionalDigits(map: ShortcutMap): number[] {
	const out: number[] = [];
	for (let d = 1; d <= 9; d++) {
		const claimed = ALL_SHORTCUT_IDS.some(
			(id) =>
				shortcutScope(id) !== "lightbox" && map[id] === `CommandOrControl+${d}`,
		);
		if (!claimed) out.push(d);
	}
	return out;
}

/**
 * Parse a v2 entry source into a complete map: any invalid, missing, or
 * non-string entry falls back to its default, and "" is preserved (the
 * deliberate unset). Hand edits and older shapes can never break
 * dispatch; duplicates are left as-is (first id wins, deterministically).
 */
function parseEntries(source: Record<string, unknown>): ShortcutMap {
	const out = { ...DEFAULT_SHORTCUTS };
	for (const id of ALL_SHORTCUT_IDS) {
		const v = source[id];
		if (v === "") {
			out[id] = "";
		} else if (typeof v === "string" && isAcceleratorShape(v)) {
			out[id] = v;
		}
	}
	return out;
}

/** Parse the current storage value (v2 wrapper — or a bare record from a
 *  hand edit; both validate per entry, no renumbering). */
export function parseCurrentShortcuts(raw: unknown): ShortcutMap {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { ...DEFAULT_SHORTCUTS };
	}
	const obj = raw as Record<string, unknown>;
	const source =
		obj.shortcuts &&
		typeof obj.shortcuts === "object" &&
		!Array.isArray(obj.shortcuts)
			? (obj.shortcuts as Record<string, unknown>)
			: obj;
	return parseEntries(source);
}

/**
 * Migrate a v1 flat view map (the pre-Email layout) to the full current
 * map. Untouched entries adopt the new view defaults; deliberate combos
 * are kept; colliding ids walk FALLBACK_CHAIN (else unset). App-wide
 * actions then take their defaults where the assigned views left room —
 * a hand-edited view sitting on ⌘, or ⌘I wins, and the action goes unset.
 */
export function migrateLegacyViewShortcuts(raw: unknown): ShortcutMap {
	const source =
		raw && typeof raw === "object" && !Array.isArray(raw)
			? (raw as Record<string, unknown>)
			: {};
	const assigned: Partial<Record<ViewId, string>> = {};
	const used = new Set<string>();
	const pending: ViewId[] = [];

	for (const id of Object.keys(
		LEGACY_DEFAULT_VIEW_SHORTCUTS,
	) as LegacyViewId[]) {
		const v = source[id];
		const usable = typeof v === "string" && isAcceleratorShape(v);
		if (usable && v !== LEGACY_DEFAULT_VIEW_SHORTCUTS[id]) {
			assigned[id] = v;
			used.add(v);
		} else {
			// Untouched (or absent/garbage) — follows the new mapping.
			pending.push(id);
		}
	}
	pending.push("email-ocr");

	for (const id of VIEW_IDS) {
		if (!pending.includes(id)) continue;
		let value: string = DEFAULT_VIEW_SHORTCUTS[id];
		if (used.has(value)) {
			value = FALLBACK_CHAIN.find((c) => !used.has(c)) ?? "";
		}
		assigned[id] = value;
		if (value) used.add(value);
	}

	const result: ShortcutMap = { ...DEFAULT_SHORTCUTS };
	for (const id of VIEW_IDS) result[id] = assigned[id] ?? "";
	for (const id of GLOBAL_ACTION_IDS) {
		const preferred = DEFAULT_ACTION_SHORTCUTS[id];
		result[id] = used.has(preferred) ? "" : preferred;
	}
	return result;
}

export function readStoredShortcuts(): ShortcutMap {
	try {
		const current = localStorage.getItem(SHORTCUTS_KEY);
		if (current) return parseCurrentShortcuts(JSON.parse(current));
		const legacy = localStorage.getItem(LEGACY_VIEW_SHORTCUTS_KEY);
		if (legacy) {
			const migrated = migrateLegacyViewShortcuts(JSON.parse(legacy));
			// Write forward so the migration renumbering is stable even if
			// the user never opens Settings; the legacy key stays frozen.
			writeStoredShortcuts(migrated);
			return migrated;
		}
	} catch {
		// Storage unavailable or corrupt — defaults still ship a working
		// session, and the next write tries again.
	}
	return { ...DEFAULT_SHORTCUTS };
}

export function writeStoredShortcuts(map: ShortcutMap): void {
	try {
		const record: Record<string, string> = {};
		for (const id of ALL_SHORTCUT_IDS) {
			record[id] = map[id] ?? DEFAULT_SHORTCUTS[id];
		}
		localStorage.setItem(
			SHORTCUTS_KEY,
			JSON.stringify({ v: SHORTCUTS_VERSION, shortcuts: record }),
		);
	} catch {
		// Persisting is best-effort; the session still uses the new map.
	}
}

export { LIGHTBOX_ACTION_IDS, GLOBAL_ACTION_IDS };
