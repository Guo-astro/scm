"use strict";

// Headless main-process load harness runner (ts-migration plan, Tier 0.2).
//
// Spawns test/main-load-harness.js under real node: the harness patches
// Module._load, which must be node's implementation regardless of which
// runner collected this file (`bun test test/` runs it too). Works under
// `node test/main-load.test.js` and `bun test test/` alike.
//
// What it protects (see harness header): require-time TDZ/load-order crashes
// and silent undefined imports — the two classes that historically only
// surfaced in Electron smokes.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const harness = path.join(__dirname, "main-load-harness.js");
const res = spawnSync("node", [harness], { encoding: "utf8" });

if (res.error) {
	assert.fail(
		`could not spawn node for the main-load harness (${res.error.message}) — ` +
			"the harness needs real node's Module._load hook",
	);
}
if (res.stdout) process.stdout.write(res.stdout);
if (res.stderr) process.stderr.write(res.stderr);
assert.equal(res.status, 0, `main-load harness failed (exit ${res.status})`);

console.log("[main-load] OK — main.js loads headless (stubbed electron)");
