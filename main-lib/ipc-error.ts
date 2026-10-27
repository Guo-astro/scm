// IPC failure normalization: the seam every invoke failure crosses on its
// way out of main. Two jobs:
//
//   1. errorDetail — the one-line detail format shared by main.ts's global
//      rejection/exception handlers and the ipc-wrapper (previously
//      duplicated in main.ts; one spec, one implementation).
//   2. normalizeIpcError — a thrown non-Error (string, object, undefined)
//      crossing the context bridge reaches the renderer as "[object
//      Object]" or an empty message, which no caller can read. Every
//      rejection leaving a handler is an Error instance with a message.
//
// Pure node — no electron import (main-lib rule), so the formatting and
// normalization are unit-testable without a stub.

/** One-line human-readable detail for an unknown-thrown value. */
export function errorDetail(err: unknown): string {
	try {
		if (err instanceof Error) {
			return err.stack || `${err.name}: ${err.message}`;
		}
		return typeof err === "string" ? err : JSON.stringify(err);
	} catch {
		return "(unserializable error)";
	}
}

/**
 * Coerce a handler's thrown value into an Error for the bridge. The main
 * log already carries the full detail (the wrapper logs before calling
 * this); the renderer's rejection message keeps the original message so
 * toasts like "Import failed: …" keep working verbatim.
 */
export function normalizeIpcError(err: unknown): Error {
	if (err instanceof Error) return err;
	return new Error(errorDetail(err));
}
