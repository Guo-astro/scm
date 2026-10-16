"use strict";

// Headless main-process load harness (ts-migration plan, Tier 0.2).
//
// Runs main.js under plain node with a stubbed `electron`, and fails on the
// two failure classes that historically slipped past every unit test and
// were only found by real Electron smokes:
//
//   1. Require-time crashes — TDZ (`Cannot access 'X' before
//      initialization`), load-order races, throwing top-level code.
//   2. Silent undefined imports — `const { missing } = require("./m.js")`
//      where ./m.js never exported `missing`. The destructure yields
//      undefined and the crash surfaces much later, or never. Every
//      RELATIVE require's exports object is wrapped in a Proxy whose `get`
//      trap reports reads of keys that do not exist.
//
// Also enforces Electron's real duplicate-handler behavior: `ipcMain.handle`
// on a channel twice throws (a faithful stub keeps the second registration
// from silently shadowing the first). `utilityProcess.fork` must not run at
// load time (workers spawn at boot); any fork here is reported as a failure.
//
// The renderer (dist/), preload, and boot flow (app.whenReady) are NOT
// exercised — whenReady never settles, so only module evaluation runs. The
// Electron smokes own everything past load.
//
// Run directly (`node test/main-load-harness.js`) or via the spawner test.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scm-main-load-"));
process.env.MEMORIES_DATA_DIR = tmp;

// ---------------------------------------------------------------------------
// Deep stub: callable, constructable, and property-accessible forever.
// ---------------------------------------------------------------------------

function deepStub(label) {
	const fn = function stub() {
		return undefined;
	};
	return new Proxy(fn, {
		get(target, key) {
			if (key === Symbol.toPrimitive) return () => "";
			if (key === "then") return undefined; // never a thenable
			if (key === "name") return label;
			if (key === "toString") return () => `[stub ${label}]`;
			if (typeof key !== "string") return undefined;
			if (!(key in target)) target[key] = deepStub(`${label}.${key}`);
			return target[key];
		},
		apply() {
			return undefined;
		},
		construct() {
			return deepStub(`${label}#instance`);
		},
	});
}

// ---------------------------------------------------------------------------
// Electron stub surface (union of every destructure in main.js + main/**).
// ---------------------------------------------------------------------------

const userDataPaths = new Map();
const handles = new Map(); // channel -> { fn, file } at load
const ons = new Map(); // channel -> { count, file } at load
const forks = [];

// First stack frame inside the repo that is not this harness — i.e. the
// module that called ipcMain.handle/on. Reported extensionless so the
// bridge table survives the Stage B .js → .ts renames.
function callerFile() {
	const stack = (new Error().stack ?? "").split("\n").slice(1);
	for (const line of stack) {
		const m = line.match(/^\s*at\s+(.*)$/);
		if (!m) continue;
		let loc = m[1];
		const paren = loc.match(/\((.*)\)$/);
		if (paren) loc = paren[1];
		const pm = loc.match(/^(.*):\d+:\d+$/);
		if (!pm) continue;
		let file = pm[1];
		// Converted .ts files load as ESM (node type stripping), whose stack
		// frames report file:// URLs — normalize before the path checks.
		if (file.startsWith("file://")) {
			try {
				file = fileURLToPath(file);
			} catch {
				continue;
			}
		}
		if (!path.isAbsolute(file)) continue;
		if (!file.startsWith(ROOT)) continue;
		// Frames that are helpers, not owners: this harness itself and the
		// ipc-wrapper registration helper (skip to the calling module).
		if (file.includes("main-load-harness.js")) continue;
		if (file.includes("ipc-wrapper")) continue;
		// The compiled tree loads from dist-main/ — attribute handlers to the
		// source-tree module name the bridge table records.
		return path
			.relative(ROOT, file)
			.replace(/^dist-main\//, "")
			.replace(/\.(js|ts|mjs|cjs)$/, "");
	}
	return null;
}

function ipcMainStub() {
	const api = {
		// Electron throws on a second handle() for the same channel — mirror
		// that so double-registration fails here instead of in a real boot.
		handle(channel, fn) {
			if (handles.has(channel)) {
				throw new Error(
					`ipcMain.handle("${channel}") registered twice at load`,
				);
			}
			handles.set(channel, {
				fn: typeof fn === "function" ? fn : null,
				file: callerFile(),
			});
		},
		on(channel) {
			const prev = ons.get(channel);
			if (prev) prev.count += 1;
			else ons.set(channel, { count: 1, file: callerFile() });
		},
		removeHandler() {},
		removeAllListeners() {},
	};
	return api;
}

class StubBrowserWindow {
	constructor() {
		this.webContents = deepStub("webContents");
	}
	loadFile() {
		return Promise.resolve();
	}
	loadURL() {
		return Promise.resolve();
	}
	on() {
		return this;
	}
	once() {
		return this;
	}
	show() {}
	hide() {}
	focus() {}
	isDestroyed() {
		return false;
	}
	destroy() {}
	static getAllWindows() {
		return [];
	}
	static fromWebContents() {
		return null;
	}
}

function electronStub() {
	const app = deepStub("app");
	app.setPath = (name, value) => userDataPaths.set(name, value);
	app.getPath = (name) =>
		userDataPaths.get(name) ?? path.join(tmp, "electron", name);
	app.getAppPath = () => ROOT;
	app.getVersion = () => "0.0.0-harness";
	app.getName = () => "scm";
	app.isPackaged = false;
	app.commandLine = deepStub("app.commandLine");
	app.dock = deepStub("app.dock");
	app.requestSingleInstanceLock = () => true;
	app.releaseSingleInstanceLock = () => {};
	// Never settle: boot flow stays unexecuted, only module evaluation runs.
	app.whenReady = () => new Promise(() => {});

	const protocol = deepStub("protocol");
	protocol.registerSchemesAsPrivileged = () => {};
	protocol.handle = () => {};
	protocol.unhandle = () => {};

	const nativeImage = deepStub("nativeImage");
	nativeImage.createFromBuffer = () => ({ isEmpty: () => true });
	nativeImage.createFromPath = () => ({ isEmpty: () => true });

	const utilityProcess = deepStub("utilityProcess");
	utilityProcess.fork = (modulePath, args, opts) => {
		forks.push({ modulePath, serviceName: opts && opts.serviceName });
		return deepStub("utilityProcess.process");
	};

	const dialog = deepStub("dialog");
	dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
	dialog.showSaveDialog = async () => ({ canceled: true, filePath: null });
	dialog.showMessageBox = async () => ({ response: 0 });

	const globalShortcut = deepStub("globalShortcut");
	globalShortcut.register = () => true;
	globalShortcut.unregister = () => {};
	globalShortcut.unregisterAll = () => {};
	globalShortcut.isRegistered = () => false;

	return {
		app,
		BrowserWindow: StubBrowserWindow,
		shell: deepStub("shell"),
		protocol,
		ipcMain: ipcMainStub(),
		crashReporter: deepStub("crashReporter"),
		nativeImage,
		Menu: deepStub("Menu"),
		Tray: deepStub("Tray"),
		Notification: deepStub("Notification"),
		globalShortcut,
		dialog,
		utilityProcess,
		// Renderer-only exports, present so any stray destructure is harmless.
		contextBridge: deepStub("contextBridge"),
		ipcRenderer: deepStub("ipcRenderer"),
		webUtils: deepStub("webUtils"),
	};
}

const ELECTRON = electronStub();

// ---------------------------------------------------------------------------
// ESM electron shim: converted .ts files load as ESM (node type stripping),
// and their `import { shell } from "electron"` bypasses the Module._load
// stub below — node's ESM resolver would load the real npm package (whose
// module.exports is a path string) instead. In-process resolve/load hooks
// map the bare specifier to a generated module that re-exports the SAME
// stub object, so named imports behave exactly like the CJS require path.
// (require("electron") still short-circuits in Module._load below.)
// ---------------------------------------------------------------------------

globalThis.__SCM_ELECTRON_STUB__ = ELECTRON;
Module.registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "electron") {
			return { url: "scm-electron-stub:", shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
	load(url, context, nextLoad) {
		if (url === "scm-electron-stub:") {
			const keys = Object.keys(ELECTRON).filter((k) =>
				/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k),
			);
			const source =
				"const s = globalThis.__SCM_ELECTRON_STUB__;\n" +
				keys.map((k) => `export const ${k} = s.${k};`).join("\n") +
				"\nexport default s;\n";
			return { format: "module", source, shortCircuit: true };
		}
		return nextLoad(url, context);
	},
});

// ---------------------------------------------------------------------------
// Module._load hook: stub electron, wrap relative exports, record reads of
// missing keys.
// ---------------------------------------------------------------------------

const missing = [];
const NOISE_KEYS = new Set(["default", "__esModule", "then"]);

const origLoad = Module._load;
Module._load = function (request, parent) {
	if (request === "electron") return ELECTRON;
	// Stage B (ts-migration): main-process leaves are converting to .ts.
	// Real node never resolves a .js specifier to the .ts sibling (bun does
	// natively; the packaged app runs the emitted dist-main/, all .js), so
	// remap here — this harness is the remaining node-source consumer.
	let effective = request;
	if (request.startsWith(".") && request.endsWith(".js") && parent) {
		const abs = path.resolve(path.dirname(parent.filename), request);
		const ts = `${abs.slice(0, -3)}.ts`;
		if (!fs.existsSync(abs) && fs.existsSync(ts)) effective = ts;
	}
	const exportsValue = origLoad.apply(this, [effective, parent, arguments[2]]);
	const isRelative = request.startsWith(".");
	if (
		isRelative &&
		exportsValue &&
		(typeof exportsValue === "object" || typeof exportsValue === "function")
	) {
		const from = parent ? path.relative(ROOT, parent.filename) : "(root)";
		return new Proxy(exportsValue, {
			get(target, prop, receiver) {
				if (
					typeof prop === "string" &&
					!NOISE_KEYS.has(prop) &&
					!(prop in target)
				) {
					missing.push(`${from} → ${request}: missing "${prop}"`);
				}
				return Reflect.get(target, prop, receiver);
			},
		});
	}
	return exportsValue;
};

// ---------------------------------------------------------------------------
// Load and report.
// ---------------------------------------------------------------------------

let loadError = null;
let moduleCount = 0;
try {
	// The converted main.ts is never executed as source — the harness runs
	// the compiled dist-main/main.js (CJS, native positional requires), which
	// is also what dev/packaged Electron loads via package.json "main".
	require(path.join(ROOT, "dist-main", "main.js"));
	moduleCount = Object.keys(require.cache).length;
} catch (err) {
	loadError = err;
}

const handleCount = handles.size;
const onCount = [...ons.values()].reduce((a, b) => a + b.count, 0);

console.log(`[main-load] modules loaded: ${moduleCount}`);
console.log(`[main-load] ipc channels: ${handleCount} handle + ${onCount} on`);
console.log(`[main-load] load-time forks: ${forks.length}`);
if (forks.length) {
	for (const f of forks) console.log(`[main-load]   fork: ${f.serviceName}`);
}
if (missing.length) {
	console.log(`[main-load] MISSING EXPORTS (${missing.length}):`);
	for (const m of missing) console.log(`[main-load]   ${m}`);
} else {
	console.log("[main-load] missing exports: none");
}

let failed = false;
if (loadError) {
	console.error("[main-load] FAIL — require threw:", loadError);
	failed = true;
}
if (missing.length) {
	console.error("[main-load] FAIL — reads of missing exports above");
	failed = true;
}
if (forks.length) {
	console.error(
		"[main-load] FAIL — utilityProcess.fork ran at load (must be lazy, boot-time)",
	);
	failed = true;
}
if (!loadError && handleCount < 55) {
	console.error(
		`[main-load] FAIL — only ${handleCount} ipc channels registered at load (expected 60+)`,
	);
	failed = true;
}
if (!loadError && !handles.has("memories:rank")) {
	console.error("[main-load] FAIL — spot-check channel memories:rank missing");
	failed = true;
}

// Machine-readable channel dump for the IPC bridge drift test
// (test/ipc-bridge.test.js): channel → registering file (extensionless).
if (process.env.MAIN_LOAD_DUMP) {
	/** @type {Record<string, string | null>} */
	const handleFiles = {};
	for (const [channel, info] of handles) handleFiles[channel] = info.file;
	/** @type {Record<string, { count: number, file: string | null }>} */
	const onInfo = {};
	for (const [channel, info] of ons) onInfo[channel] = info;
	console.log(
		`__MAIN_LOAD_DUMP__${JSON.stringify({ handles: handleFiles, ons: onInfo })}`,
	);
}

process.exit(failed ? 1 : 0);
