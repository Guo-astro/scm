import { describe, expect, test } from "bun:test";

// The uniform IPC failure contract (ipc-wrapper V2, layer 0): every
// rejection crossing the bridge is an Error with a readable message, and
// the main-side log line is the one errorDetail format everywhere. These
// helpers are pure node (main-lib rule), so the contract is pinned here
// without stubbing electron.

import { errorDetail, normalizeIpcError } from "../main-lib/ipc-error.ts";

describe("errorDetail", () => {
	test("Error with a stack keeps the stack (forensics want the frames)", () => {
		const err = new Error("bin corrupt");
		expect(errorDetail(err)).toBe(err.stack);
	});

	test("Error without a stack falls back to name: message", () => {
		const bare = { name: "RangeError", message: "bad dim" };
		const err = Object.assign(new Error("bad dim"), { stack: undefined });
		// A hand-rolled object is NOT an Error — covered below; this one
		// strips the stack off a real Error.
		expect((err as { stack?: string }).stack).toBeUndefined();
		expect(errorDetail(err)).toBe(`${err.name}: ${err.message}`);
		expect(bare.name).toBe("RangeError");
	});

	test("plain strings pass through verbatim", () => {
		expect(errorDetail("disk full")).toBe("disk full");
	});

	test("objects JSON-stringify, never '[object Object]'", () => {
		expect(errorDetail({ code: 5, path: "/x" })).toBe('{"code":5,"path":"/x"}');
	});

	test("undefined/null stringify (JSON.stringify semantics)", () => {
		expect(errorDetail(undefined)).toBeUndefined();
		expect(errorDetail(null)).toBe("null");
	});

	test("never throws, even on circular structures", () => {
		const a: Record<string, unknown> = {};
		a.self = a;
		expect(errorDetail(a)).toBe("(unserializable error)");
	});
});

describe("normalizeIpcError", () => {
	test("real Errors pass through unchanged (same identity)", () => {
		const err = new Error("model not ready");
		expect(normalizeIpcError(err)).toBe(err);
	});

	test("thrown strings become Errors carrying the message", () => {
		const err = normalizeIpcError("disk full");
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toBe("disk full");
	});

	test("thrown objects become Errors with JSON detail, not '[object Object]'", () => {
		const err = normalizeIpcError({ code: "ENOENT", path: "/a/b" });
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toBe('{"code":"ENOENT","path":"/a/b"}');
	});

	test("undefined throws become Errors with a readable (empty-ish) message", () => {
		const err = normalizeIpcError(undefined);
		expect(err).toBeInstanceOf(Error);
		// JSON.stringify(undefined) is undefined → message "" — still an
		// Error the renderer can reject on and log, never "[object Object]".
		expect(err.message).toBe("");
	});
});
