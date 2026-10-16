// Phase 1 (chrome-settings): pure move from main.js (2026-10-10) — shortcut
// state + get/set-shortcut handlers, menu-bar-only / onboarding /
// tray-settings handlers. No behavior change: same channels, same validation.
// Shared helpers still owned by main.js (showAndFocusMain, liveMainWindow,
// applyMenuBarMode — all hoisted function declarations) arrive via
// main/context.js and are read AT CALL TIME (ctx.*). Window refs, tray core,
// menu-bar-mode state, and app-icon/media settings stay in main.js for later
// slices. This module never requires main.js (no cycle).
import { globalShortcut, app } from "electron";
import { handle } from "../ipc-wrapper.ts";
import ctx from "../context.ts";
import {
	readSettings,
	writeSettings,
	readMenuBarOnly,
	readOnboardingSeen,
	readStartHidden,
	readNotifyOnDone,
} from "../../main-lib/settings.ts";

let registeredShortcut: string | null = null;

// Unregister the previously registered global shortcut (best-effort).
function unregisterCurrentShortcut() {
	if (!registeredShortcut) return;
	try {
		globalShortcut.unregister(registeredShortcut);
	} catch {
		/* already gone */
	}
	registeredShortcut = null;
}

// Try to register a global shortcut. Returns { ok, error? }.
// On success the accelerator is persisted to settings.
function tryRegisterShortcut(accelerator: string | null) {
	// Always clear the previous shortcut first.
	unregisterCurrentShortcut();
	if (!accelerator) {
		// Cleared — persist the empty state.
		writeSettings({ globalShortcut: null });
		console.log("[shortcut] cleared");
		return { ok: true };
	}
	try {
		const ok = globalShortcut.register(accelerator, ctx.showAndFocusMain);
		if (ok) {
			registeredShortcut = accelerator;
			writeSettings({ globalShortcut: accelerator });
			console.log(`[shortcut] registered: ${accelerator}`);
			return { ok: true };
		}
		// Registration failed — the shortcut is taken by the OS or another app.
		console.warn(
			`[shortcut] registration failed for "${accelerator}" — already in use by another app`,
		);
		return {
			ok: false,
			error: `"${accelerator}" is already in use by another app`,
		};
	} catch (err) {
		console.error(`[shortcut] registration threw for "${accelerator}":`, err);
		const e = err as { message?: string } | null | undefined;
		return {
			ok: false,
			error: (e && e.message) || "Failed to register shortcut",
		};
	}
}

handle("memories:get-shortcut", () => {
	const settings = readSettings();
	return settings.globalShortcut || null;
});

handle(
	"memories:set-shortcut",
	(_event: unknown, accelerator: string | null) => {
		if (accelerator && typeof accelerator !== "string")
			return { ok: false, error: "Invalid shortcut" };
		// Validate the accelerator string (must contain at least one modifier + a key).
		if (accelerator) {
			const parts = accelerator.split("+");
			if (parts.length < 2)
				return {
					ok: false,
					error: "Shortcut needs a modifier (Ctrl/Alt/Cmd) and a key",
				};
		}
		return tryRegisterShortcut(accelerator || null);
	},
);

handle("memories:get-menu-bar-only", () => readMenuBarOnly());

// First-run CRT tour marker (settings.json `onboardingSeen`). The
// install-level "has the tour shown" flag — unlike the renderer's
// localStorage copy it survives profile/storage resets, so the intro
// shows exactly once per install. Only `true` counts as seen.
handle("memories:get-onboarding-seen", () => readOnboardingSeen());

handle("memories:set-onboarding-seen", (_event: unknown, seen: unknown) => {
	if (typeof seen !== "boolean")
		return { ok: false, error: "Expected true or false" };
	writeSettings({ onboardingSeen: seen });
	return { ok: true, onboardingSeen: seen };
});

handle("memories:set-menu-bar-only", (_event: unknown, enabled: unknown) => {
	if (typeof enabled !== "boolean")
		return { ok: false, error: "Expected true or false" };
	writeSettings({ menuBarOnly: enabled });
	const applied = ctx.applyMenuBarMode(enabled);
	if (applied && process.platform === "darwin") {
		// Hiding the Dock can drop activation to Finder, leaving our window
		// greyed-out behind the mode switch — reclaim it immediately.
		try {
			app.focus({ steal: true });
		} catch {
			try {
				app.focus();
			} catch {
				/* best effort */
			}
		}
		const win = ctx.liveMainWindow();
		if (win) {
			try {
				if (win.isVisible()) win.focus();
			} catch {
				/* best effort */
			}
		}
	}
	return { ok: true, enabled: applied };
});

// ---------------------------------------------------------------------------
// Tray companion settings: launch at login, start hidden, completion
// notifications. `openAtLogin` lives in the OS login items (applied
// immediately); `startHidden`/`notifyOnDone` persist in settings.json.
// ---------------------------------------------------------------------------

function readTraySettings() {
	let openAtLogin = false;
	try {
		openAtLogin = app.getLoginItemSettings().openAtLogin === true;
	} catch {
		/* unsupported platform — report false */
	}
	return {
		openAtLogin,
		startHidden: readStartHidden(),
		notifyOnDone: readNotifyOnDone(),
	};
}

handle("memories:get-tray-settings", () => readTraySettings());

handle(
	"memories:set-tray-settings",
	(_event: unknown, patch: Record<string, unknown> | null | undefined) => {
		if (!patch || typeof patch !== "object")
			return { ok: false, error: "Expected an object" };
		if (typeof patch.openAtLogin === "boolean") {
			try {
				app.setLoginItemSettings({
					openAtLogin: patch.openAtLogin,
					openAsHidden: true,
				});
			} catch (err) {
				const e = err as { message?: string } | null | undefined;
				return {
					ok: false,
					error: (e && e.message) || "Could not change login item",
				};
			}
		}
		const settingsPatch: { startHidden?: boolean; notifyOnDone?: boolean } = {};
		if (typeof patch.startHidden === "boolean")
			settingsPatch.startHidden = patch.startHidden;
		if (typeof patch.notifyOnDone === "boolean")
			settingsPatch.notifyOnDone = patch.notifyOnDone;
		if (Object.keys(settingsPatch).length > 0) writeSettings(settingsPatch);
		return { ok: true, settings: readTraySettings() };
	},
);

// Re-exported for main.js: boot restores the saved shortcut, will-quit
// unregisters it. Everything else in this module is handler-local.
export { tryRegisterShortcut, unregisterCurrentShortcut };
