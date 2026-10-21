// Recordable app-wide actions (Settings → Keyboard): everything outside
// the six library views that answers its own key combo.
//
// Scopes mirror WHEN a handler is live:
//   - "app": Settings toggle + Import — active whenever the window has
//     focus (the two combos that used to be hard-coded in App.tsx).
//   - "lightbox": navigation + AI Insights — live only while the viewer
//     is open. The lightbox dispatcher consumes its combos (preventDefault
//     + stopPropagation) before the window-level dispatchers see them, so
//     a lightbox action MAY share a combo with an app-scope shortcut:
//     that is exactly how ⌘I means "AI Insights" inside the viewer and
//     "Import photos" everywhere else.
//
// Bare-key defaults ("Left"/"Right"/"Escape") are canonical tokens from
// viewShortcuts' normalizer: the matcher compares them without modifiers
// and ignores them while a text field or IME has focus. Recording only
// ever produces modifier combos, so a bare key is always restorable via
// that group's Reset.

export type AppActionId =
	| "toggle-settings"
	| "import-photos"
	| "lightbox-next"
	| "lightbox-prev"
	| "lightbox-close"
	| "lightbox-insights";

export type ShortcutScope = "app" | "lightbox";

export interface AppActionInfo {
	readonly id: AppActionId;
	readonly label: string;
	/** One-line description for the Keyboard editor rows. */
	readonly description: string;
	readonly scope: ShortcutScope;
	readonly default: string;
}

export const APP_ACTIONS: readonly AppActionInfo[] = [
	{
		id: "toggle-settings",
		label: "Settings",
		description: "Open or close this preferences window",
		scope: "app",
		default: "CommandOrControl+,",
	},
	{
		id: "import-photos",
		label: "Import photos",
		description: "Import photos or folders into the library",
		scope: "app",
		default: "CommandOrControl+I",
	},
	{
		id: "lightbox-next",
		label: "Next item",
		description: "Step forward through the viewer (photos and videos)",
		scope: "lightbox",
		default: "Right",
	},
	{
		id: "lightbox-prev",
		label: "Previous item",
		description: "Step backward through the viewer",
		scope: "lightbox",
		default: "Left",
	},
	{
		id: "lightbox-close",
		label: "Close viewer",
		description: "Close the lightbox",
		scope: "lightbox",
		default: "Escape",
	},
	{
		id: "lightbox-insights",
		label: "AI Insights",
		description: "Toggle the AI insights panel inside the viewer",
		scope: "lightbox",
		default: "CommandOrControl+I",
	},
];

export const APP_ACTION_IDS: readonly AppActionId[] = APP_ACTIONS.map(
	(a) => a.id,
);

/** The lightbox-only subset, in dispatch order. */
export const LIGHTBOX_ACTION_IDS: readonly AppActionId[] = APP_ACTIONS.filter(
	(a) => a.scope === "lightbox",
).map((a) => a.id);

/** The window-level subset (Settings toggle, Import). */
export const GLOBAL_ACTION_IDS: readonly AppActionId[] = APP_ACTIONS.filter(
	(a) => a.scope === "app",
).map((a) => a.id);

export type ActionShortcuts = Record<AppActionId, string>;

export const DEFAULT_ACTION_SHORTCUTS: ActionShortcuts = Object.fromEntries(
	APP_ACTIONS.map((a) => [a.id, a.default]),
) as ActionShortcuts;

export function isAppActionId(id: string): id is AppActionId {
	return (APP_ACTION_IDS as readonly string[]).includes(id);
}
