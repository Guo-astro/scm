// Shortcut vocabulary for the recordable in-app combos (Settings →
// Keyboard): key normalization, the six semantic library views behind
// remappable accelerators (⌘1–6 by default — each pairing a category tab
// with a search mode), and the shared matcher every dispatcher uses.
//
// Pure helpers live here so storage parsing, key normalization, and
// matching are unit-testable without a DOM. The action registry (lightbox
// / app-wide) lives in appActions.ts and the storage + migration layer in
// inAppShortcuts.ts; both build on the two accelerator shapes defined
// here:
//
//   - Modifier combos ("CommandOrControl+Shift+3") — the Electron
//     accelerator format. The recorder only ever produces these.
//   - Bare key tokens ("Left", "Right", "Escape") — the lightbox's
//     navigation defaults. Matched without modifiers, and ignored while
//     a text field or an IME composition owns the keyboard.
//
// matchAccelerator is the SINGLE matcher both the Settings recorder's
// consumers and every dispatcher share, so the two can never drift apart.

export type ViewId =
	| "all-files"
	| "videos-scenes"
	| "email-ocr"
	| "screenshots-ocr"
	| "all-llms"
	| "videos-dialogue";

/** Ids that exist in the pre-Email layout (storage generation v1). */
export type LegacyViewId = Exclude<ViewId, "email-ocr">;

export const VIEW_IDS: ViewId[] = [
	"all-files",
	"videos-scenes",
	"email-ocr",
	"screenshots-ocr",
	"all-llms",
	"videos-dialogue",
];

/** Display label per view (the combined tab + mode it activates). */
export const VIEW_LABELS: Record<ViewId, string> = {
	"all-files": "All tab + Files search",
	"videos-scenes": "Videos tab + Scenes search",
	"email-ocr": "Email tab + OCR search",
	"screenshots-ocr": "Screenshots tab + OCR search",
	"all-llms": "All tab + LLMs chat",
	"videos-dialogue": "Videos tab + Dialogue search",
};

/** One-line description for the Keyboard editor rows. */
export const VIEW_DESCRIPTIONS: Record<ViewId, string> = {
	"all-files": "Home — full library, whole-file ranking",
	"videos-scenes": "Exact moments inside videos, by sight",
	"email-ocr": "Contact addresses read from photos' visible text",
	"screenshots-ocr": "Visible text on screenshots and posters",
	"all-llms": "Answered from library text and speech",
	"videos-dialogue": "Exact moments by what is said",
};

export type ViewShortcuts = Record<ViewId, string>;

export const DEFAULT_VIEW_SHORTCUTS: ViewShortcuts = {
	"all-files": "CommandOrControl+1",
	"videos-scenes": "CommandOrControl+2",
	"email-ocr": "CommandOrControl+3",
	"screenshots-ocr": "CommandOrControl+4",
	"all-llms": "CommandOrControl+5",
	"videos-dialogue": "CommandOrControl+6",
};

// The pre-Email defaults (five views, screenshots on ⌘3). Kept so the
// storage migration can tell "untouched entry" from "user-chosen combo":
// an entry still equal to its legacy default adopts the new mapping.
export const LEGACY_DEFAULT_VIEW_SHORTCUTS: Record<LegacyViewId, string> = {
	"all-files": "CommandOrControl+1",
	"videos-scenes": "CommandOrControl+2",
	"screenshots-ocr": "CommandOrControl+3",
	"all-llms": "CommandOrControl+4",
	"videos-dialogue": "CommandOrControl+5",
};

/** The legal modifier tokens (order matters in eventToAccelerator). */
const MODIFIERS = ["CommandOrControl", "Command", "Control", "Alt", "Shift"];

// Bare-key vocabulary: the named keys whose DOM `key` value is already
// canonical (plus F1–F24). Deliberately excludes bare characters — a
// hand edit cannot turn "A" or "1" into a shortcut that hijacks typing.
const NAMED_KEY_TOKENS = new Set([
	"Space",
	"Up",
	"Down",
	"Left",
	"Right",
	"Escape",
	"Enter",
	"Backspace",
	"Delete",
	"Tab",
	"Home",
	"End",
	"PageUp",
	"PageDown",
	"Insert",
]);

function isBareKeyToken(token: string): boolean {
	return NAMED_KEY_TOKENS.has(token) || /^F([1-9]|1[0-9]|2[0-4])$/.test(token);
}

/** Structural shape of the key fields the recorder and matcher read. */
export interface KeyEventLike {
	repeat: boolean;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
	key: string;
	/** IME composition in progress (real KeyboardEvents only). */
	isComposing?: boolean;
	/** Event target (real KeyboardEvents only) — bare keys are ignored
	 *  while a text field has focus. `unknown` here because DOM event
	 *  targets arrive as EventTarget; the matcher narrows at runtime. */
	target?: unknown;
}

/** Canonical key token for an accelerator: mirrors the recorder below. */
function canonicalKeyToken(key: string): string {
	let k = key;
	if (k === " ") k = "Space";
	else if (k === "ArrowUp") k = "Up";
	else if (k === "ArrowDown") k = "Down";
	else if (k === "ArrowLeft") k = "Left";
	else if (k === "ArrowRight") k = "Right";
	else if (k === "Escape") k = "Escape";
	else if (k === "Enter") k = "Enter";
	else if (k === "Backspace") k = "Backspace";
	else if (k === "Delete") k = "Delete";
	else if (k === "Tab") k = "Tab";
	if (k.length === 1) k = k.toUpperCase();
	return k;
}

/** True while a text field or content-editable owns the keyboard. */
function isTypingTarget(target: unknown): boolean {
	if (!target || typeof target !== "object") return false;
	const el = target as {
		tagName?: unknown;
		isContentEditable?: unknown;
		closest?: unknown;
	};
	if (el.isContentEditable === true) return true;
	const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
	if (typeof el.closest === "function") {
		const closest = el.closest as (selectors: string) => unknown;
		return Boolean(
			closest.call(
				target,
				'[contenteditable="true"], [contenteditable="plaintext-only"]',
			),
		);
	}
	return false;
}

/**
 * Build an Electron accelerator string from a keydown event — the SINGLE
 * normalization both the Settings recorder and every matcher use, so the
 * two can never drift apart. Returns null when the combo is incomplete
 * (no modifier held), a bare modifier press, or a repeat. Recording thus
 * only ever produces modifier combos; bare tokens come from defaults.
 */
export function eventToAccelerator(e: KeyEventLike): string | null {
	if (e.repeat) return null;
	// Must have at least one modifier.
	if (!e.metaKey && !e.ctrlKey && !e.altKey) return null;
	// Ignore bare modifier presses.
	if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return null;
	const parts: string[] = [];
	if (e.metaKey) parts.push("CommandOrControl");
	if (e.ctrlKey) parts.push("Control");
	if (e.altKey) parts.push("Alt");
	if (e.shiftKey) parts.push("Shift");
	parts.push(canonicalKeyToken(e.key));
	return parts.join("+");
}

/**
 * Convert an accelerator string into a human-friendly display
 * (e.g. "CommandOrControl+Shift+Space" → "⌘⇧ Space", "Right" → "→").
 */
export function displayShortcut(accel: string): string {
	return accel
		.replace(/CommandOrControl/gi, "⌘")
		.replace(/Command/gi, "⌘")
		.replace(/Control/gi, "Ctrl")
		.replace(/Alt/gi, "⌥")
		.replace(/Shift/gi, "⇧")
		.replace(/\bEscape\b/gi, "Esc")
		.replace(/\bLeft\b/gi, "←")
		.replace(/\bRight\b/gi, "→")
		.replace(/\bUp\b/gi, "↑")
		.replace(/\bDown\b/gi, "↓")
		.replace(/\+/g, " ");
}

/**
 * Structural check: a modifier combo (at least one modifier + a key
 * token) or a bare canonical key token ("Left", "Escape"). The empty
 * string is NOT a shape — it is the deliberate "unset" sentinel and
 * callers validate it separately. Non-canonical spellings ("esc",
 * "arrowleft") are refused, so a hand edit cannot silently bind a key
 * nobody intended.
 */
export function isAcceleratorShape(accel: string): boolean {
	if (accel.length === 0) return false;
	if (!accel.includes("+")) {
		return isBareKeyToken(accel) && canonicalKeyToken(accel) === accel;
	}
	const parts = accel.split("+");
	if (parts.length < 2) return false;
	const mods = parts.slice(0, -1);
	const key = parts[parts.length - 1] ?? "";
	if (key.length === 0) return false;
	return mods.every((m) => MODIFIERS.includes(m));
}

/**
 * Does this keydown event equal the stored accelerator? One matcher for
 * both shapes:
 *  - modifier combos use the shared normalization (repeat-guarded);
 *  - bare tokens match the key alone, ignoring IME composition entirely
 *    and text-field focus (so ←/→/Esc defaults never fight a text box),
 *    while letting held keys repeat (holding → keeps stepping the
 *    viewer, matching the pre-remap behavior).
 */
export function matchAccelerator(e: KeyEventLike, accel: string): boolean {
	// A live IME composition owns the keyboard — never steal its keys.
	if (e.isComposing) return false;
	if (accel.includes("+")) {
		const built = eventToAccelerator(e);
		return built !== null && built === accel;
	}
	if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
	if (isTypingTarget(e.target)) return false;
	return canonicalKeyToken(e.key) === accel;
}
