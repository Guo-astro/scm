// Phase 1: central IPC registration helper (decompose-monoliths plan).
//
// V1 is a deliberate passthrough: it preserves each handler's existing
// return/error contract byte-for-byte (rank returns [], embed-query returns
// null, import returns {ok:false,...}). A uniform try/catch -> {ok:false}
// shape comes AFTER all domains move, once the contract doc records each
// channel's failure shape. Today this helper buys one thing: a single
// require site for ipcMain so moves are `git mv` + rewiring.

import { ipcMain } from "electron";

// `any[]` params: ipcMain invokes handlers with (event, ...args) — the
// passthrough must accept the domains' contracts verbatim.
export function handle(channel: string, fn: (...args: any[]) => unknown) {
	ipcMain.handle(channel, fn);
}

// The single `on` channel (memories:ask-stop) rides the same passthrough:
// fire-and-forget today, same as before.
export function on(channel: string, fn: (...args: any[]) => void) {
	ipcMain.on(channel, fn);
}
