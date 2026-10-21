import { expect, test } from "bun:test";
import {
	DEFAULT_VIEW_SHORTCUTS,
	LEGACY_DEFAULT_VIEW_SHORTCUTS,
	VIEW_IDS,
	displayShortcut,
	eventToAccelerator,
	isAcceleratorShape,
	matchAccelerator,
} from "../src/lib/viewShortcuts";

function key(
	over: Partial<{
		repeat: boolean;
		metaKey: boolean;
		ctrlKey: boolean;
		altKey: boolean;
		shiftKey: boolean;
		key: string;
		isComposing: boolean;
		target: { tagName?: string; isContentEditable?: boolean } | null;
	}> = {},
) {
	return {
		repeat: false,
		metaKey: false,
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		key: "1",
		...over,
	};
}

test("defaults are the six views with Email on ⌘3", () => {
	expect(DEFAULT_VIEW_SHORTCUTS).toEqual({
		"all-files": "CommandOrControl+1",
		"videos-scenes": "CommandOrControl+2",
		"email-ocr": "CommandOrControl+3",
		"screenshots-ocr": "CommandOrControl+4",
		"all-llms": "CommandOrControl+5",
		"videos-dialogue": "CommandOrControl+6",
	});
	expect(VIEW_IDS).toHaveLength(6);
	// The legacy snapshot still describes the pre-Email layout the storage
	// migration compares against.
	expect(LEGACY_DEFAULT_VIEW_SHORTCUTS["screenshots-ocr"]).toBe(
		"CommandOrControl+3",
	);
});

test("eventToAccelerator builds canonical combos and rejects incomplete ones", () => {
	expect(eventToAccelerator(key({ metaKey: true }))).toBe("CommandOrControl+1");
	expect(
		eventToAccelerator(key({ metaKey: true, shiftKey: true, key: "3" })),
	).toBe("CommandOrControl+Shift+3");
	expect(eventToAccelerator(key({ metaKey: true, key: " " }))).toBe(
		"CommandOrControl+Space",
	);
	expect(eventToAccelerator(key({ metaKey: true, key: "a" }))).toBe(
		"CommandOrControl+A",
	);
	// No modifier, bare modifier, and repeats are incomplete.
	expect(eventToAccelerator(key())).toBeNull();
	expect(eventToAccelerator(key({ metaKey: true, key: "Meta" }))).toBeNull();
	expect(eventToAccelerator(key({ metaKey: true, repeat: true }))).toBeNull();
});

test("matchAccelerator uses the same normalization as the recorder", () => {
	expect(
		matchAccelerator(key({ metaKey: true, key: "3" }), "CommandOrControl+3"),
	).toBe(true);
	expect(
		matchAccelerator(key({ metaKey: true, key: "3" }), "CommandOrControl+4"),
	).toBe(false);
	// Caps Lock delivers "I" — the canonical token still matches ⌘I.
	expect(
		matchAccelerator(key({ metaKey: true, key: "I" }), "CommandOrControl+I"),
	).toBe(true);
	// Shift combos never equal their plain-digit cousins (no double-fire).
	expect(
		matchAccelerator(
			key({ metaKey: true, shiftKey: true, key: "3" }),
			"CommandOrControl+3",
		),
	).toBe(false);
	expect(
		matchAccelerator(
			key({ metaKey: true, shiftKey: true, key: "3" }),
			"CommandOrControl+Shift+3",
		),
	).toBe(true);
});

test("matchAccelerator handles bare lightbox tokens", () => {
	// Bare tokens match the key alone, DOM name normalization included.
	expect(matchAccelerator(key({ key: "ArrowRight" }), "Right")).toBe(true);
	expect(matchAccelerator(key({ key: "ArrowLeft" }), "Left")).toBe(true);
	expect(matchAccelerator(key({ key: "Escape" }), "Escape")).toBe(true);
	// The same key with a modifier is a different combo.
	expect(
		matchAccelerator(key({ key: "Escape", metaKey: true }), "Escape"),
	).toBe(false);
	expect(
		matchAccelerator(key({ key: "ArrowRight", shiftKey: true }), "Right"),
	).toBe(false);
	// Bare keys are ignored while a text field owns the keyboard…
	expect(
		matchAccelerator(
			key({ key: "ArrowRight", target: { tagName: "INPUT" } }),
			"Right",
		),
	).toBe(false);
	expect(
		matchAccelerator(
			key({ key: "Escape", target: { tagName: "TEXTAREA" } }),
			"Escape",
		),
	).toBe(false);
	// …and while an IME composition is in flight.
	expect(
		matchAccelerator(key({ key: "Escape", isComposing: true }), "Escape"),
	).toBe(false);
	expect(
		matchAccelerator(
			key({ key: "1", isComposing: true, metaKey: true }),
			"CommandOrControl+1",
		),
	).toBe(false);
});

test("displayShortcut renders accelerators mac-style", () => {
	expect(displayShortcut("CommandOrControl+Shift+3")).toBe("⌘ ⇧ 3");
	expect(displayShortcut("CommandOrControl+,")).toBe("⌘ ,");
	expect(displayShortcut("Right")).toBe("→");
	expect(displayShortcut("Left")).toBe("←");
	expect(displayShortcut("Escape")).toBe("Esc");
	expect(displayShortcut("CommandOrControl+Left")).toBe("⌘ ←");
	// Named keys keep their names — only the bare arrow tokens become glyphs.
	expect(displayShortcut("CommandOrControl+PageUp")).toBe("⌘ PageUp");
});

test("isAcceleratorShape accepts modifier combos and canonical bare tokens", () => {
	expect(isAcceleratorShape("CommandOrControl+1")).toBe(true);
	expect(isAcceleratorShape("Alt+CommandOrControl+9")).toBe(true);
	expect(isAcceleratorShape("Right")).toBe(true);
	expect(isAcceleratorShape("Escape")).toBe(true);
	expect(isAcceleratorShape("F5")).toBe(true);
	// Bare characters and unknown words are never a valid shortcut — a
	// hand edit must not turn typing into a dispatch.
	expect(isAcceleratorShape("")).toBe(false);
	expect(isAcceleratorShape("A")).toBe(false);
	expect(isAcceleratorShape("1")).toBe(false);
	expect(isAcceleratorShape("nope")).toBe(false);
	expect(isAcceleratorShape("arrowleft")).toBe(false);
	expect(isAcceleratorShape("CommandOrControl")).toBe(false);
	expect(isAcceleratorShape("CommandOrControl+")).toBe(false);
	expect(isAcceleratorShape("BadModifier+1")).toBe(false);
});
