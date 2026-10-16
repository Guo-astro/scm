"use strict";

// Regression test: bin writes are total — an encode failure (e.g. the
// RangeError Buffer.concat threw under memory pressure on huge libraries in
// the grid smoke) must degrade to a warning, never throw or reject. Covers
// the UnhandledPromiseRejectionWarning from fire-and-forget migration
// checkpoints (`void writeBins` in main/ipc/migration.ts).
// Plain node, no Electron: initLibraryStore() points the module at a tmpdir.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const store = require("../main-lib/library-store.ts");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scm-bin-total-"));
store.initLibraryStore({ userDataDir: dir });

(async () => {
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
})().catch((err) => {
	console.error(`bin-write-total FAILED: ${err.stack || err.message}`);
	process.exitCode = 1;
});
