// The LLM sidecar's shared runtime state: the init/overrides singleton,
// the status broadcast, and the fetch resolver. Extracted from
// server.ts (2026-10-25) so the download layer (binaries.ts) and the
// lifecycle/chat core (server.ts) share one state without a require
// cycle. A const OBJECT with mutable fields on purpose: initLlmServer
// assigns fields (never rebinds), and property reads stay live across
// the CJS module boundary — an exported `let` would not.

// One answer's generation ceiling — also the natural upper bound on how
// long a stalled HTTP body stays open. A 1.7B on 4 threads answers well
// inside this; the cap exists so a wedged server can never hang Ask.
export const CHAT_TIMEOUT_MS = 300_000;
// Model load on first spawn (mmap + warmup) is seconds, but a cold 3B on a
// busy 8GB machine may page — the health poll deadline stays generous.
export const HEALTH_TIMEOUT_MS = 180_000;
// Kill the sidecar after this long with no chat (Ask is a burst feature).
export const IDLE_STOP_MS = 5 * 60_000;

export interface LlmState {
	init: boolean;
	userDataDir: string | null;
	broadcast: ((payload: unknown) => void) | null;
	overrides: {
		binaryPath: string | null;
		modelPath: string | null;
		fetchImpl: typeof fetch | null;
	};
}

export const state: LlmState = {
	init: false,
	userDataDir: null,
	broadcast: null,
	// Test overrides (see initLlmServer).
	overrides: { binaryPath: null, modelPath: null, fetchImpl: null },
};

export function broadcastLlm(payload: unknown): void {
	if (typeof state.broadcast === "function") {
		try {
			state.broadcast(payload);
		} catch {
			/* status must never break the pipeline */
		}
	}
}

export function llmStatusEvent(
	phase: string,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return { type: "llm", phase, ...extra };
}

export function fetchImpl(): typeof fetch {
	if (state.overrides.fetchImpl) return state.overrides.fetchImpl;
	// Node 18+ / Electron main both carry global fetch.
	return fetch;
}
