export type ThemeSetting = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "scm-theme";

function systemPrefersDark(): boolean {
	return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Applies a theme setting to <html> as the dark/light class pair the
 *  stylesheets key on. Kept in sync with the no-flash inline script in
 *  index.html — change both together. */
export function applyTheme(setting: ThemeSetting): void {
	const dark = setting === "system" ? systemPrefersDark() : setting === "dark";
	document.documentElement.classList.toggle("dark", dark);
	document.documentElement.classList.toggle("light", !dark);
}

export function readStoredTheme(): ThemeSetting {
	try {
		const stored = localStorage.getItem(THEME_STORAGE_KEY);
		if (stored === "light" || stored === "dark" || stored === "system") {
			return stored;
		}
	} catch {
		// Storage unavailable (private mode etc.) — fall through to system.
	}
	return "system";
}
