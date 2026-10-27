// Phase 1: central IPC registration helper (decompose-monoliths plan).
//
// V2 (layer 0, 2026-10-24): a uniform *rejection* contract. Every handler
// is wrapped — a throw is logged to the file log with the channel tag and
// re-crosses the bridge as a real Error (a thrown string/object used to
// reach the renderer as "[object Object]" or an empty message). Success
// shapes are untouched: this layer changes nothing about what a handler
// returns, only what a handler's failure looks like to the caller.
// Per-channel *result* shapes are catalogued in scripts/bridge-table.mjs
// (`failure`) and published in docs/ipc-contract.md; the empty/null
// sentinels there are deliberate (documented, not migrated).
//
// V1 history: a deliberate passthrough so domain moves were `git mv` +
// rewiring with each handler's contract preserved byte-for-byte.

import { ipcMain } from "electron";
import { errorDetail, normalizeIpcError } from "../main-lib/ipc-error.ts";

// `any[]` params: ipcMain invokes handlers with (event, ...args) — the
// wrapper must accept the domains' contracts verbatim.
export function handle(channel: string, fn: (...args: any[]) => unknown) {
	ipcMain.handle(channel, async (...args: any[]) => {
		try {
			return await fn(...args);
		} catch (err) {
			// console.error rides the buffered file stream — the full detail
			// (stack included) lands in the log with the channel tag.
			console.error(`[ipc] ${channel} failed: ${errorDetail(err)}`);
			throw normalizeIpcError(err);
		}
	});
}

// The single `on` channel (memories:ask-stop) rides the same seam. A
// listener failure stays an uncaught exception (the global handler in
// main.ts reports it under the host's original policy) — the wrap only
// names the channel in the log first.
export function on(channel: string, fn: (...args: any[]) => void) {
	ipcMain.on(channel, (...args: any[]) => {
		try {
			fn(...args);
		} catch (err) {
			console.error(`[ipc] ${channel} failed: ${errorDetail(err)}`);
			throw err;
		}
	});
}
