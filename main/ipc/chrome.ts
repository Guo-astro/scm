// Phase 1 (chrome): pure move from main.js (2026-10-10) — window helpers,
// tray core (icons, menu, busy state, menu-bar mode), app-icon handlers. No
// behavior change: same menus, icons, mode switches. Shared refs still owned
// by main.js arrive via main/context.js and are read AT CALL TIME: window
// ref, quit flag, menu-bar/dock/icon state, icon loader, settings path, app
// dir (all assigned at the stub beside the lets). Sibling domains are
// required directly (no cycles — none require chrome back): store, settings,
// pool status, pump snapshots, import picker. Own fns needed by stayers
// (showAndFocusMain for second-instance/activate, applyMenuBarMode for boot)
// are exported below; updateTrayState/maybeNotify ride the shared slots the
// module assigns itself. This module never requires main.js.
import fs from "node:fs";
import path from "node:path";
import {
	app,
	BrowserWindow,
	Menu,
	Tray,
	Notification,
	nativeImage,
} from "electron";
import { handle } from "../ipc-wrapper.ts";
import ctx from "../context.ts";
import { loadLibrary } from "../../main-lib/library-store.ts";
import {
	writeSettings,
	readNotifyOnDone,
	readAppIcon,
	parseAppIcon,
	APP_ICON_IDS,
} from "../../main-lib/settings.ts";
import { getModelStatus } from "./pool.ts";
import { enrichSnapshot } from "./pumps/enrich.ts";
import { ocrSnapshot } from "./pumps/ocr.ts";
import { pickAndImport, isImportInFlight } from "./import.ts";

// ---------------------------------------------------------------------------
// Global shortcut to bring SCM to focus
// ---------------------------------------------------------------------------

function showAndFocusMain() {
	const win = liveMainWindow();
	if (!win) return;
	if (win.isMinimized()) win.restore();
	if (process.platform === "darwin") {
		// Dock-hidden apps need extra help to become key: parking the window
		// on all workspaces for a moment keeps show() from landing it
		// behind other apps' windows (or on another Space).
		try {
			win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
		} catch {
			try {
				win.setVisibleOnAllWorkspaces(true);
			} catch {
				/* older Electron — show() alone will do */
			}
		}
	}
	// show() also unhides a window hidden to the menu bar (close-to-tray).
	win.show();
	try {
		if (win.isFullScreen()) win.setFullScreen(false);
	} catch {
		/* leaving fullscreen is best-effort */
	}
	win.focus();
	if (process.platform === "darwin") {
		try {
			win.moveTop();
		} catch {
			/* best effort */
		}
		try {
			win.setVisibleOnAllWorkspaces(false);
		} catch {
			/* best effort */
		}
		// Steal is legitimate here: this only ever runs from a user gesture
		// (tray click, global shortcut, second launch, Dock activate).
		try {
			app.focus({ steal: true });
		} catch {
			try {
				app.focus();
			} catch {
				/* best effort */
			}
		}
	}
}

// The main window if it still exists (mainWindowRef goes stale when the
// window is destroyed in normal quit-on-close mode).
function liveMainWindow() {
	const ref = ctx.getMainWindowRef();
	if (ref && !ref.isDestroyed()) return ref;
	ctx.setMainWindowRef(null);
	return BrowserWindow.getAllWindows()[0] || null;
}

// Menu-bar click behavior: toggle the window. Focused → hide back to the
// tray; anything else (hidden, minimized, behind) → bring forward.
function toggleMainWindow() {
	const win = liveMainWindow();
	if (!win) return;
	let hidden: boolean;
	let minimized: boolean;
	try {
		hidden = !win.isVisible();
	} catch {
		hidden = true;
	}
	try {
		minimized = win.isMinimized();
	} catch {
		minimized = false;
	}
	if (hidden || minimized) {
		showAndFocusMain();
		return;
	}
	let focused: boolean;
	try {
		focused = win.isFocused();
	} catch {
		focused = false;
	}
	if (focused) {
		try {
			win.hide();
		} catch {
			/* best effort */
		}
	} else {
		showAndFocusMain();
	}
}

// ---------------------------------------------------------------------------
// Menu-bar-only mode: hide the Dock icon and run from the macOS menu bar.
// Opt-in via Settings (settings.json `menuBarOnly`, default false). While
// enabled the app stays resident when the window closes (close hides to the
// menu bar; Quit happens from the tray menu), so background indexing,
// watched-folder syncs, and the global shortcut keep working with no Dock
// presence. The Dock concept is macOS-only, so dock hide/show is darwin-
// guarded; the tray itself is created wherever the mode is enabled.
// ---------------------------------------------------------------------------

let tray: Tray | null = null;
// True once a real quit is underway (tray Quit item, Cmd+Q, app-menu Quit):
// the window "close" handler hides instead of closing, so it must stand
// down while quitting or the app could never exit.
// Note: menuBarOnlyEnabled / pendingDockIcon / pendingDockIconId /
// currentAppIconId are defined near the top (before APP_ICON) to avoid TDZ
// with module-load APP_ICON init. trayIconBucket is the
// tray idle/busy bucket.
let trayIconBucket = "idle";

// C-01 Wave 2 (S1): readMenuBarOnly live in main-lib/settings.ts (imported above).

// C-01 Wave 2 (S1): readNotifyOnDone live in main-lib/settings.ts (imported above).

// C-01 Wave 2 (S1): readStartHidden live in main-lib/settings.ts (imported above).

// Whether the main window is currently on screen (any window counts —
// exactly the condition where a notification would be redundant noise).
function mainWindowVisible() {
	try {
		return BrowserWindow.getAllWindows().some((w) => {
			try {
				return w.isVisible();
			} catch {
				return false;
			}
		});
	} catch {
		return true;
	}
}

function maybeNotify(title: string, body: string) {
	if (!readNotifyOnDone()) return;
	if (mainWindowVisible()) return;
	try {
		new Notification({ title, body }).show();
	} catch (err) {
		console.warn(
			`[menubar] notification failed: ${(err as { message?: string }).message}`,
		);
	}
}

// Asar-safe tray icon: fs.readFileSync works inside app.asar while
// nativeImage.createFromPath does not (same reason APP_ICON loads through
// fs). 1x + 2x representations keep the icon crisp on Retina. Candidates
// cover the packaged layout (vite copies public/* into dist/) and the dev
// checkout (public/ directly).
function trayIconImage(variant: string) {
	const name = variant === "tray-busy" ? "tray-busy" : "tray";
	const empty = nativeImage.createEmpty();
	// App-root-relative (ts-migration Stage A): app.getAppPath() is the
	// repo root in dev and the asar root packaged — dist/ and public/ live
	// there, not beside the compiled code in dist-main/.
	const root = app.getAppPath();
	const candidates = [
		path.join(root, "dist", "images", "tray"),
		path.join(root, "public", "images", "tray"),
	];
	for (const dir of candidates) {
		try {
			const oneX = fs.readFileSync(path.join(dir, `${name}.png`));
			let twoX: Buffer | null = null;
			try {
				twoX = fs.readFileSync(path.join(dir, `${name}@2x.png`));
			} catch {
				/* 1x alone is usable */
			}
			const img = nativeImage.createEmpty();
			img.addRepresentation({ scaleFactor: 1, buffer: oneX });
			if (twoX) img.addRepresentation({ scaleFactor: 2, buffer: twoX });
			if (!img.isEmpty()) return img;
		} catch {
			/* try the next candidate dir */
		}
	}
	return empty;
}

function setTrayIconBucket(bucket: string) {
	trayIconBucket = bucket;
	if (!tray) return;
	const icon = trayIconImage(bucket === "busy" ? "tray-busy" : "tray");
	if (icon.isEmpty()) return;
	try {
		tray.setImage(icon);
	} catch {
		/* best effort */
	}
}

// One-line status summaries for the dynamic tray menu, all from in-memory
// state the main process already holds (no disk, no worker round trip).
function trayStatusLines() {
	const lines: string[] = [];
	try {
		const count = loadLibrary().filenames.length;
		lines.push(`${count} photo${count === 1 ? "" : "s"} in library`);
	} catch {
		/* library not loaded yet */
	}
	const poolStatus = getModelStatus();
	if (poolStatus && poolStatus.type === "model") {
		if (poolStatus.phase === "loading") {
			lines.push(
				typeof poolStatus.progress === "number"
					? `AI engine loading — ${Math.round(poolStatus.progress)}%`
					: "AI engine loading…",
			);
		} else if (poolStatus.phase === "error") {
			lines.push("AI engine error");
		} else {
			lines.push("AI engine ready");
		}
	}
	try {
		const snap = enrichSnapshot();
		if (snap && (snap.active || snap.pending > 0)) {
			lines.push(
				snap.total > 0
					? `Analyzing scenes — ${snap.done}/${snap.total}`
					: `Analyzing scenes (${snap.pending} waiting)`,
			);
		}
	} catch {
		/* enrichment state not ready */
	}
	try {
		const snap = ocrSnapshot();
		if (snap && (snap.active || snap.pending > 0)) {
			lines.push(`Reading text (${snap.pending} waiting)`);
		}
	} catch {
		/* OCR state not ready */
	}
	return lines;
}

function buildTrayMenu() {
	const template: Electron.MenuItemConstructorOptions[] = [
		{
			label: "Open SCM",
			click: () => showAndFocusMain(),
		},
		{
			label: "Import Photos…",
			click: () => {
				// Surface the window first: a file dialog parented to a
				// hidden window would open invisibly.
				showAndFocusMain();
				pickAndImport();
			},
		},
		{
			label: "Open Settings…",
			click: () => {
				showAndFocusMain();
				for (const win of BrowserWindow.getAllWindows()) {
					win.webContents.send("memories:status", { type: "open-settings" });
				}
			},
		},
		{ type: "separator" },
	];
	const statusLines = trayStatusLines();
	for (const line of statusLines) {
		template.push({ label: line, enabled: false });
	}
	if (statusLines.length > 0) template.push({ type: "separator" });
	template.push({
		label: "Quit SCM",
		click: () => {
			ctx.setIsQuitting(true);
			app.quit();
		},
	});
	return Menu.buildFromTemplate(template);
}

function createTray() {
	if (tray) return;
	const icon = trayIconImage(trayIconBucket === "busy" ? "tray-busy" : "tray");
	if (icon.isEmpty()) {
		console.warn("[menubar] no tray icon found; skipping tray creation");
		return;
	}
	// Local ref for the listeners: tsc cannot narrow the module let inside
	// the click closures, and the captured instance is the same object the
	// module let holds at registration time.
	const created = new Tray(icon);
	tray = created;
	created.setToolTip("SCM");
	// Deliberately NO setContextMenu: on macOS an attached menu hijacks
	// left-click. Left-click toggles the window; right-click pops a menu
	// built fresh at open time so the status lines are never stale.
	created.on("click", () => toggleMainWindow());
	created.on("right-click", () => {
		try {
			created.popUpContextMenu(buildTrayMenu());
		} catch {
			/* best effort */
		}
	});
}

function destroyTray() {
	if (!tray) return;
	try {
		tray.destroy();
	} catch {
		/* already gone */
	}
	tray = null;
}

// Busy while the AI engine loads (or errored — needs attention), an import
// runs, or scene/OCR background work is queued or active.
function trayIsBusy() {
	if (isImportInFlight()) return true;
	const poolStatus = getModelStatus();
	if (
		poolStatus &&
		poolStatus.type === "model" &&
		poolStatus.phase !== "ready"
	) {
		return true;
	}
	try {
		const snap = enrichSnapshot();
		if (snap && (snap.active || snap.pending > 0)) return true;
	} catch {
		/* not ready */
	}
	try {
		const snap = ocrSnapshot();
		if (snap && (snap.active || snap.pending > 0)) return true;
	} catch {
		/* not ready */
	}
	return false;
}

// Re-evaluate the tray icon after any status change. Cheap and guarded:
// no tray (mode off) means no work at all.
function updateTrayState() {
	if (!tray) return;
	const bucket = trayIsBusy() ? "busy" : "idle";
	if (bucket !== trayIconBucket) setTrayIconBucket(bucket);
}

// Apply the mode live: hide/show the Dock icon and create/destroy the tray.
// Called once at startup and on every Settings toggle (no restart needed).
function applyMenuBarMode(enabled: unknown) {
	const nextEnabled = enabled === true;
	if (process.platform === "darwin") {
		if (nextEnabled) {
			// Stage the correct Dock icon BEFORE hiding. macOS drops any
			// setIcon made while the Dock is hidden, so an icon chosen while
			// hidden would otherwise revert to the bundled SCM.icns on the
			// next show(). Setting before hide ensures the hidden state starts
			// with the right image. pendingDockIcon (icon chosen while hidden)
			// wins over APP_ICON so a change made while hidden is not lost.
			try {
				const toStage =
					ctx.getPendingDockIcon() ||
					ctx.getAppIconImage() ||
					ctx.loadAppIconImage(readAppIcon());
				if (toStage && !toStage.isEmpty() && app.dock)
					app.dock.setIcon(toStage);
				if (toStage && !toStage.isEmpty()) ctx.setAppIconImage(toStage);
				if (ctx.getPendingDockIconId())
					ctx.setCurrentAppIconId(ctx.getPendingDockIconId());
				ctx.setPendingDockIcon(null);
				ctx.setPendingDockIconId(null);
			} catch {
				/* staging is best-effort */
			}
			ctx.setMenuBarOnlyEnabled(true);
			createTray();
			// Only hide the Dock when the tray actually exists — a missing
			// icon must never leave the app with no visible presence.
			if (tray) app.dock?.hide();
			else ctx.setMenuBarOnlyEnabled(false);
		} else {
			ctx.setMenuBarOnlyEnabled(false);
			destroyTray();
			app.dock?.show();
			// macOS can drop a custom dock icon set while hidden. Re-apply the
			// user's chosen icon so toggling menu-bar mode doesn't revert to the
			// bundled SCM.icns — the "switch didn't stick" report. pendingDockIcon
			// (icon chosen while hidden) wins over disk so a just-picked icon
			// appears immediately without waiting for a relaunch.
			try {
				const toApply =
					ctx.getPendingDockIcon() || ctx.loadAppIconImage(readAppIcon());
				const toApplyId = ctx.getPendingDockIconId() || readAppIcon();
				if (toApply && !toApply.isEmpty() && app.dock)
					app.dock.setIcon(toApply);
				if (toApply && !toApply.isEmpty()) {
					ctx.setAppIconImage(toApply);
					ctx.setCurrentAppIconId(parseAppIcon(toApplyId));
					for (const win of BrowserWindow.getAllWindows()) {
						try {
							win.setIcon(toApply);
						} catch {
							/* window icon set is best-effort */
						}
					}
				}
				ctx.setPendingDockIcon(null);
				ctx.setPendingDockIconId(null);
			} catch {
				/* re-apply is best-effort */
			}
		}
	} else if (nextEnabled) {
		ctx.setMenuBarOnlyEnabled(true);
		createTray();
	} else {
		ctx.setMenuBarOnlyEnabled(false);
		destroyTray();
	}
	console.log(
		`[menubar] menu-bar-only ${ctx.isMenuBarOnlyEnabled() ? "enabled" : "disabled"}`,
	);
	return ctx.isMenuBarOnlyEnabled();
}

// ---------------------------------------------------------------------------
// App icon (Settings → Appearance → App Icon): Dock + window icon picked
// from public/images/app-icons/*.png (1024×1024). Stored as settings.json
// `appIcon`, validated via parseAppIcon. Applies live via app.dock.setIcon
// + win.setIcon and persists for next launch via APP_ICON.
// ---------------------------------------------------------------------------

handle("memories:get-app-icon", () => {
	try {
		const raw = JSON.parse(fs.readFileSync(ctx.settingsFile, "utf-8")).appIcon;
		if (typeof raw === "string" && APP_ICON_IDS.includes(raw)) return raw;
	} catch {
		/* fall through to pending/current fallback */
	}
	// File missing, corrupted, or no appIcon key — don't snap back to
	// scm-vhs while the Dock is hidden. The in-memory staged choice
	// (pending while hidden, otherwise last applied) is the truth.
	// Reads hoist to locals: the getters are plain reference reads (same
	// value across the guard), and tsc does not narrow a fresh call's
	// result from an earlier guard.
	const pendingId = ctx.getPendingDockIconId();
	if (pendingId && APP_ICON_IDS.includes(pendingId)) return pendingId;
	const currentId = ctx.getCurrentAppIconId();
	if (currentId && APP_ICON_IDS.includes(currentId)) return currentId;
	return readAppIcon();
});

handle("memories:get-app-icon-debug", () => {
	try {
		const rawFile = fs.readFileSync(ctx.settingsFile, "utf-8");
		let parsed: unknown = null;
		let fileAppIcon: unknown = null;
		try {
			parsed = JSON.parse(rawFile);
			fileAppIcon = (parsed as { appIcon?: unknown }).appIcon;
		} catch (e) {
			parsed = { _parseError: (e as { message?: string }).message };
		}
		const iconImage = ctx.getAppIconImage();
		return {
			ok: true,
			settingsFile: ctx.settingsFile,
			userData: app.getPath("userData"),
			dirname: ctx.appDirname,
			fileExists: true,
			fileRawSnippet: rawFile.slice(0, 500),
			fileAppIcon,
			parsedAppIcon: parseAppIcon(fileAppIcon),
			currentAppIconId: ctx.getCurrentAppIconId(),
			pendingDockIconId: ctx.getPendingDockIconId(),
			menuBarOnlyEnabled: ctx.isMenuBarOnlyEnabled(),
			readAppIcon: readAppIcon(),
			appIconIsEmpty: iconImage ? iconImage.isEmpty() : null,
		};
	} catch (err) {
		return {
			ok: false,
			settingsFile: ctx.settingsFile,
			userData: (() => {
				try {
					return app.getPath("userData");
				} catch (e) {
					return `getPath failed: ${(e as { message?: string }).message}`;
				}
			})(),
			error: (err as { message?: string }).message,
			currentAppIconId: ctx.getCurrentAppIconId(),
			pendingDockIconId: ctx.getPendingDockIconId(),
			menuBarOnlyEnabled: ctx.isMenuBarOnlyEnabled(),
		};
	}
});

handle("memories:set-app-icon", (_event: unknown, id: unknown) => {
	if (typeof id !== "string" || !APP_ICON_IDS.includes(id)) {
		return {
			ok: false,
			error: `Unknown app icon (expected ${APP_ICON_IDS.join(", ")})`,
		};
	}
	// Validate the image exists before persisting: a missing file (stale
	// DMG, bad build) previously wrote settings but left the Dock unchanged
	// with a silent {ok:true} — the "didn't change" bug.
	const img = ctx.loadAppIconImage(id);
	if (!img || img.isEmpty()) {
		console.warn(`[app-icon] missing image for ${id} — refusing to persist`);
		return {
			ok: false,
			error: `Icon image not found for "${id}" (rebuild or reinstall)`,
		};
	}
	writeSettings({ appIcon: id });
	// Keep APP_ICON/currentAppIconId and window icons in sync immediately so
	// newly created windows and any visible window chrome pick up the change
	// even while the Dock is hidden. The Dock itself is handled below. This
	// also ensures getAppIcon fallback (pending/current) stays truthful even
	// if the settings file is momentarily unreadable.
	ctx.setAppIconImage(img);
	ctx.setCurrentAppIconId(id);
	for (const win of BrowserWindow.getAllWindows()) {
		try {
			win.setIcon(img);
		} catch {
			/* window icon set is best-effort */
		}
	}
	if (process.platform === "darwin" && app.dock) {
		if (ctx.isMenuBarOnlyEnabled()) {
			// Dock is hidden in menu-bar-only mode: macOS drops setIcon()
			// calls made while hidden ("didn't change" while hidden). Don't
			// call setIcon while hidden — it is silently ignored. Stage the
			// image for the next show(). The next applyMenuBarMode(false)
			// (user disables the mode) and the next launch (icon-before-hide)
			// will apply it, so the change is never lost without flashing the
			// Dock with a show/set/hide cycle.
			ctx.setPendingDockIcon(img);
			ctx.setPendingDockIconId(id);
			console.log(
				`[app-icon] ${id} staged while Dock hidden (menu-bar-only) — will re-apply on Dock show`,
			);
			// Immediate menu-bar feedback: the Dock is invisible, so update
			// the tray icon to a tiny version of the chosen app icon. This
			// gives the user something visibly new in the menu bar without
			// waiting to disable the mode. The next tray bucket update
			// (busy/idle) or mode toggle will restore the normal tray image,
			// but the Dock icon remains correctly staged via pendingDockIcon.
			try {
				if (tray && img && !img.isEmpty()) {
					const small = img.resize({ width: 18, height: 18 });
					tray.setImage(small);
				}
			} catch {
				/* tray update is best-effort immediate feedback */
			}
		} else {
			try {
				app.dock.setIcon(img);
				ctx.setPendingDockIcon(null);
				ctx.setPendingDockIconId(null);
			} catch {
				/* dock not available */
			}
		}
	}
	// Notify renderers so the Settings UI can show a toast or refresh the
	// tray tooltip if it cares. The menu-bar hint already explains the
	// hidden-Dock case, but this event lets the UI be explicit.
	try {
		for (const win of BrowserWindow.getAllWindows()) {
			win.webContents.send("memories:status", {
				type: "app-icon-changed",
				appIcon: id,
			});
		}
	} catch {
		/* best effort */
	}
	return { ok: true, appIcon: id };
});

// Own bindings backfill the shared slots sibling modules read at call time
// (overwriting the chrome-settings stub's older three for the window/mode
// helpers and the enrich stub's older two for tray updates).
ctx.showAndFocusMain = showAndFocusMain;
ctx.liveMainWindow = liveMainWindow;
ctx.applyMenuBarMode = applyMenuBarMode;
ctx.updateTrayState = updateTrayState;
ctx.maybeNotify = maybeNotify;

// Re-exported for main.js: second-instance + Dock-activate surface the
// window; boot applies the persisted menu-bar mode.
export { showAndFocusMain, applyMenuBarMode };
