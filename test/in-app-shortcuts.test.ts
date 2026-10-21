import { beforeEach, expect, test } from "bun:test";
import {
	APP_ACTIONS,
	APP_ACTION_IDS,
	DEFAULT_ACTION_SHORTCUTS,
	GLOBAL_ACTION_IDS,
	LIGHTBOX_ACTION_IDS,
} from "../src/lib/appActions";
import {
	ALL_SHORTCUT_IDS,
	DEFAULT_SHORTCUTS,
	FALLBACK_CHAIN,
	LEGACY_VIEW_SHORTCUTS_KEY,
	RESERVED_SHORTCUTS,
	SHORTCUTS_KEY,
	findConflictingShortcut,
	freePositionalDigits,
	parseCurrentShortcuts,
	readStoredShortcuts,
	shortcutLabel,
	shortcutScope,
	writeStoredShortcuts,
	migrateLegacyViewShortcuts,
	type ShortcutMap,
} from "../src/lib/inAppShortcuts";
import { VIEW_IDS } from "../src/lib/viewShortcuts";

// bun:test has no DOM localStorage — minimal in-memory stub (same pattern
// as built-in-tabs.test.ts), installed before any reader runs.
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
	getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
	setItem: (k: string, v: string) => void store.set(k, String(v)),
	removeItem: (k: string) => void store.delete(k),
};

// The storage tests touch that stub; keep them isolated from each other.
beforeEach(() => {
	store.delete(SHORTCUTS_KEY);
	store.delete(LEGACY_VIEW_SHORTCUTS_KEY);
});

function legacy(over: Record<string, string> = {}) {
	return {
		"all-files": "CommandOrControl+1",
		"videos-scenes": "CommandOrControl+2",
		"screenshots-ocr": "CommandOrControl+3",
		"all-llms": "CommandOrControl+4",
		"videos-dialogue": "CommandOrControl+5",
		...over,
	};
}

test("registry covers every id with defaults and labels", () => {
	expect(APP_ACTION_IDS).toHaveLength(6);
	expect(new Set(ALL_SHORTCUT_IDS).size).toBe(ALL_SHORTCUT_IDS.length);
	for (const id of ALL_SHORTCUT_IDS) {
		expect(typeof DEFAULT_SHORTCUTS[id]).toBe("string");
		expect(DEFAULT_SHORTCUTS[id].length).toBeGreaterThan(0);
		expect(shortcutLabel(id).length).toBeGreaterThan(0);
	}
	// Scopes: exactly the lightbox group is viewer-scoped.
	expect(LIGHTBOX_ACTION_IDS).toEqual([
		"lightbox-next",
		"lightbox-prev",
		"lightbox-close",
		"lightbox-insights",
	]);
	expect(GLOBAL_ACTION_IDS).toEqual(["toggle-settings", "import-photos"]);
	for (const id of GLOBAL_ACTION_IDS) expect(shortcutScope(id)).toBe("app");
	for (const id of LIGHTBOX_ACTION_IDS)
		expect(shortcutScope(id)).toBe("lightbox");
	expect(VIEW_IDS.every((id) => shortcutScope(id) === "app")).toBe(true);
});

test("findConflictingShortcut enforces groups: views+app share, lightbox is separate", () => {
	// Import cannot take a view's combo — both handlers are always live.
	expect(
		findConflictingShortcut(
			"import-photos",
			"CommandOrControl+2",
			DEFAULT_SHORTCUTS,
		),
	).toBe("videos-scenes");
	// The lightbox may share an app combo: ⌘I is AI Insights inside the
	// viewer and Import outside it.
	expect(
		findConflictingShortcut(
			"lightbox-insights",
			"CommandOrControl+I",
			DEFAULT_SHORTCUTS,
		),
	).toBeNull();
	// …but lightbox actions still cannot collide with each other.
	expect(
		findConflictingShortcut("lightbox-close", "Right", DEFAULT_SHORTCUTS),
	).toBe("lightbox-next");
	// The unset sentinel never conflicts.
	expect(
		findConflictingShortcut("import-photos", "", DEFAULT_SHORTCUTS),
	).toBeNull();
});

test("freePositionalDigits tracks the live map", () => {
	expect(freePositionalDigits(DEFAULT_SHORTCUTS)).toEqual([7, 8, 9]);
	const moved = {
		...DEFAULT_SHORTCUTS,
		"videos-dialogue": "CommandOrControl+9",
	};
	expect(freePositionalDigits(moved)).toEqual([6, 7, 8]);
	const cleared = { ...DEFAULT_SHORTCUTS, "email-ocr": "" };
	expect(freePositionalDigits(cleared)).toEqual([3, 7, 8, 9]);
	// A lightbox-scoped combo never shadows a positional tab shortcut:
	// it only fires while the viewer is open.
	const lightboxOnly = {
		...DEFAULT_SHORTCUTS,
		"lightbox-next": "CommandOrControl+7",
	};
	expect(freePositionalDigits(lightboxOnly)).toEqual([7, 8, 9]);
});

test("migrateLegacyViewShortcuts renumbers untouched entries and keeps chosen ones", () => {
	// Untouched legacy map → the new defaults across the board.
	const untouched = migrateLegacyViewShortcuts(legacy());
	expect(untouched).toEqual(DEFAULT_SHORTCUTS);

	// A deliberately changed entry stays; everything else renumbers.
	const custom = migrateLegacyViewShortcuts(
		legacy({ "all-files": "Alt+CommandOrControl+1" }),
	);
	expect(custom["all-files"]).toBe("Alt+CommandOrControl+1");
	expect(custom["email-ocr"]).toBe("CommandOrControl+3");
	expect(custom["screenshots-ocr"]).toBe("CommandOrControl+4");
	expect(custom["all-llms"]).toBe("CommandOrControl+5");
	expect(custom["videos-dialogue"]).toBe("CommandOrControl+6");

	// A kept combo that blocks email's ⌘3 pushes email to the fallback
	// chain, and the later untouched entries keep their new defaults.
	const blocked = migrateLegacyViewShortcuts(
		legacy({ "videos-scenes": "CommandOrControl+3" }),
	);
	expect(blocked["videos-scenes"]).toBe("CommandOrControl+3");
	expect(blocked["email-ocr"]).toBe(FALLBACK_CHAIN[0]);
	expect(blocked["screenshots-ocr"]).toBe("CommandOrControl+4");
	expect(blocked["videos-dialogue"]).toBe("CommandOrControl+6");

	// A kept combo deep in the fallback chain makes the cascade walk it.
	const cascade = migrateLegacyViewShortcuts(
		legacy({ "videos-dialogue": "CommandOrControl+6" }),
	);
	expect(cascade["videos-dialogue"]).toBe("CommandOrControl+6");
	expect(cascade["email-ocr"]).toBe("CommandOrControl+3");

	// Garbage / missing / wrong-typed entries fall back like untouched.
	const garbage = migrateLegacyViewShortcuts({
		"all-files": "nope",
		"videos-scenes": 42,
	});
	expect(garbage["all-files"]).toBe("CommandOrControl+1");
	expect(garbage["videos-scenes"]).toBe("CommandOrControl+2");
	expect(migrateLegacyViewShortcuts(null)).toEqual(DEFAULT_SHORTCUTS);
	expect(migrateLegacyViewShortcuts([])).toEqual(DEFAULT_SHORTCUTS);

	// A hand-edited view sitting on ⌘, wins; the app-wide action goes
	// unset (visible in Settings) instead of double-firing.
	const greedy = migrateLegacyViewShortcuts(
		legacy({ "videos-scenes": "CommandOrControl+," }),
	);
	expect(greedy["videos-scenes"]).toBe("CommandOrControl+,");
	expect(greedy["toggle-settings"]).toBe("");
	expect(greedy["import-photos"]).toBe("CommandOrControl+I");
});

test("parseCurrentShortcuts validates per entry and preserves unset", () => {
	expect(parseCurrentShortcuts(null)).toEqual(DEFAULT_SHORTCUTS);
	expect(parseCurrentShortcuts([])).toEqual(DEFAULT_SHORTCUTS);
	expect(
		parseCurrentShortcuts({
			v: 2,
			shortcuts: {
				"all-files": "CommandOrControl+9",
				"email-ocr": "",
				"screenshots-ocr": "nope",
				"all-llms": 42,
			},
		}),
	).toEqual({
		...DEFAULT_SHORTCUTS,
		"all-files": "CommandOrControl+9",
		"email-ocr": "",
	});
	// A bare record on the current key (hand edit) parses without
	// renumbering.
	expect(
		parseCurrentShortcuts({ "screenshots-ocr": "CommandOrControl+3" })[
			"screenshots-ocr"
		],
	).toBe("CommandOrControl+3");
});

test("readStoredShortcuts prefers v2, migrates the legacy key, writes forward", () => {
	// No storage at all — defaults.
	expect(readStoredShortcuts()).toEqual(DEFAULT_SHORTCUTS);

	// v2 wins untouched.
	const current: ShortcutMap = { ...DEFAULT_SHORTCUTS, "email-ocr": "" };
	writeStoredShortcuts(current);
	expect(JSON.parse(localStorage.getItem(SHORTCUTS_KEY) ?? "null")).toEqual({
		v: 2,
		shortcuts: current,
	});
	expect(readStoredShortcuts()).toEqual(current);

	// Legacy-only storage migrates and writes the v2 record forward.
	localStorage.removeItem(SHORTCUTS_KEY);
	localStorage.setItem(
		LEGACY_VIEW_SHORTCUTS_KEY,
		JSON.stringify(legacy({ "all-files": "Alt+CommandOrControl+1" })),
	);
	const migrated = readStoredShortcuts();
	expect(migrated["all-files"]).toBe("Alt+CommandOrControl+1");
	expect(migrated["email-ocr"]).toBe("CommandOrControl+3");
	expect(migrated["videos-dialogue"]).toBe("CommandOrControl+6");
	expect(JSON.parse(localStorage.getItem(SHORTCUTS_KEY) ?? "null")).toEqual({
		v: 2,
		shortcuts: migrated,
	});
});

test("reserved list covers menu, chrome, and the Edit roles", () => {
	for (const accel of [
		"CommandOrControl+O",
		"CommandOrControl+Q",
		"CommandOrControl+W",
		"CommandOrControl+H",
		"CommandOrControl+M",
		"CommandOrControl+Z",
		"CommandOrControl+Shift+Z",
		"CommandOrControl+X",
		"CommandOrControl+C",
		"CommandOrControl+V",
		"CommandOrControl+A",
		"Control+Command+F",
	]) {
		expect(RESERVED_SHORTCUTS[accel]).toBeTruthy();
	}
	// ⌘, and ⌘I are now recordable — they left the reserved list.
	expect(RESERVED_SHORTCUTS["CommandOrControl+,"]).toBeUndefined();
	expect(RESERVED_SHORTCUTS["CommandOrControl+I"]).toBeUndefined();
});

test("APP_ACTIONS defaults match their shipped combos", () => {
	expect(DEFAULT_ACTION_SHORTCUTS).toEqual({
		"toggle-settings": "CommandOrControl+,",
		"import-photos": "CommandOrControl+I",
		"lightbox-next": "Right",
		"lightbox-prev": "Left",
		"lightbox-close": "Escape",
		"lightbox-insights": "CommandOrControl+I",
	});
	for (const action of APP_ACTIONS) {
		expect(action.description.length).toBeGreaterThan(0);
	}
});
