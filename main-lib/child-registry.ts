// Tracked main-process children (architecture audit 2026-10-19).
//
// Why this exists: the app already owns an orphan-proof registry for the
// worker ffmpeg children (indexer/video-utils.ts: activeFfmpegChildren +
// killAllFfmpeg), and the 2026-09-28 incident taught the lesson — killing
// the Node worker alone reparents ffmpeg to PID 1, where it keeps burning
// CPU with no timers left. The MAIN process has the same hazard, and three
// of its spawns were raw (bypassing that registry):
//
//   main/ipc/youtube.ts:358   ffmpeg merge    (raw spawn)
//   main/ipc/youtube.ts:833   yt-dlp download (raw spawn)
//   main-lib/llm/server.ts:693 llama-server   (raw spawn, + a startup hole)
//
// runWillQuitCleanup (main.ts) sweeps this registry on quit, so a quit
// mid-download can no longer leave a child behind. The house rule
// ("nunca raw spawn", main/ipc/previews.ts) now has a mechanism behind it.
//
// Plain node, no electron import — unit testable like the rest of main-lib.

import type { ChildProcess } from "node:child_process";

interface TrackedChild {
	readonly child: ChildProcess;
	readonly label: string;
}

const children = new Map<number, TrackedChild>();
let nextId = 1;

/**
 * Register a spawned child so the quit sweep can kill it.
 *
 * Returns the tracking id, or null when the child is already gone (a spawn
 * that failed, or one that raced the registration) — there is nothing left
 * to track in that case, and registering it would leak the entry.
 */
export function trackChild(child: ChildProcess, label: string): number | null {
	if (child.exitCode !== null || child.signalCode !== null) {
		return null;
	}
	const id = nextId++;
	children.set(id, { child, label });
	// "close" always fires (unlike "exit", which Node skips when the spawn
	// itself failed); the map delete is idempotent, so both are safe.
	child.once("exit", () => untrackChild(id));
	child.once("close", () => untrackChild(id));
	return id;
}

/** Drop a child from the registry (it exited, or was killed deliberately). */
export function untrackChild(id: number): void {
	children.delete(id);
}

/**
 * Kill one tracked child and drop it from the registry.
 *
 * Returns false when the id is unknown (already exited, or never tracked).
 */
export function killTrackedChild(id: number | null): boolean {
	if (id === null) return false;
	const entry = children.get(id);
	if (!entry) return false;
	children.delete(id);
	try {
		entry.child.kill("SIGKILL");
	} catch {
		/* already gone */
	}
	return true;
}

/** SIGKILL every tracked child. Never throws. Returns the kill count. */
export function killTrackedChildren(reason: string): number {
	let killed = 0;
	for (const [id, entry] of [...children.entries()]) {
		children.delete(id);
		try {
			entry.child.kill("SIGKILL");
			killed++;
		} catch {
			/* already gone */
		}
	}
	if (killed > 0) {
		console.warn(
			`[memories] killed ${killed} tracked main-process child(ren) (${
				reason || "unknown"
			})`,
		);
	}
	return killed;
}

/** Live count — the leak assertion in test/child-registry.test.js. */
export function trackedChildCount(): number {
	return children.size;
}

/** Labels of the live tracked children (diagnostics only). */
export function trackedChildLabels(): string[] {
	return [...children.values()].map((entry) => entry.label);
}
