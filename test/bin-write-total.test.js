"use strict";

// Regression test: bin writes are total — an encode failure (e.g. the
// RangeError Buffer.concat threw under memory pressure on huge libraries in
// the grid smoke) must degrade to a warning, never throw or reject. Covers
// the UnhandledPromiseRejectionWarning from fire-and-forget migration
// checkpoints (`void writeBins` in main/ipc/migration.ts).
// A bun:test file, not a plain script: the async checks point the shared
// library-store module at a tmpdir, so they must not interleave with another
// file's store setup.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("bun:test");
const store = require("../main-lib/library-store.ts");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scm-bin-total-"));

test("bin writes are total (encode failure degrades to a warning)", async () => {
	store.initLibraryStore({ userDataDir: dir });

	// Absurd dim with tiny real rows: the body encodes from actual bytes
	// (16 B), then `header.writeInt32LE(dim)` throws RangeError
	// synchronously without allocating — a deterministic stand-in for the
	// OOM encodeBin hit in production.
	const HUGE_DIM = 2 ** 31;
	const tiny = () => new Float32Array([1, 2, 3, 4]);
	assert.equal(
		await store.writeBins(
			"oom-test-model",
			[tiny()],
			[tiny()],
			HUGE_DIM,
			HUGE_DIM,
		),
		undefined,
		"failed encode resolves (never throws)",
	);

	// Fire-and-forget shape, exactly like the migration checkpoints: must
	// neither throw synchronously (executor rejection) nor produce an
	// unhandled rejection.
	await new Promise((resolve, reject) => {
		process.once("unhandledRejection", reject);
		void store.writeBins(
			"oom-test-model",
			[tiny()],
			[tiny()],
			HUGE_DIM,
			HUGE_DIM,
		);
		setImmediate(resolve);
	});

	console.log("bin-write-total: all assertions passed");
}, 30000);
