"use strict";

// Require-graph guard (Phase 5, lint ramp): the main-process split must
// stay acyclic, so a moved domain can never deadlock at load time.
//
// What it checks: every relative require() under main/ and main-lib/
// resolves to a file, and the graph has no cycles — EXCEPT inside
// main-lib/store/, whose mutual references are deliberate and documented
// (namespace requires + additive exports + call-time-only access; see the
// store modules' headers). A cycle anywhere else fails here, not as a
// mysterious hang on the next Electron boot.
//
// Style note: this is a source-text guard like packaged-files.test.js —
// plain node, no Electron, no new dependencies.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function listJsFiles(dir) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listJsFiles(full));
		else if (entry.isFile() && entry.name.endsWith(".js")) out.push(full);
	}
	return out;
}

const REQUIRE_RE = /require\(\s*["'](\.[^"']+)["']\s*\)/g;
const graph = new Map(); // rel-posix -> Set<rel-posix>

for (const dir of ["main", "main-lib"]) {
	for (const src of listJsFiles(path.join(ROOT, dir))) {
		const rel = path.relative(ROOT, src).split(path.sep).join("/");
		const text = fs.readFileSync(src, "utf8");
		const deps = new Set();
		let match;
		REQUIRE_RE.lastIndex = 0;
		while ((match = REQUIRE_RE.exec(text)) !== null) {
			let resolved = path.normalize(path.join(path.dirname(src), match[1]));
			if (!resolved.endsWith(".js")) resolved += ".js";
			if (!fs.existsSync(resolved)) continue; // packaged-files owns existence
			deps.add(path.relative(ROOT, resolved).split(path.sep).join("/"));
		}
		graph.set(rel, deps);
	}
}

const inStore = (rel) => rel.startsWith("main-lib/store/");

// Depth-first cycle search; a cycle is reported only when at least one
// member lives outside the documented store/ exception.
const WHITE = 0;
const GRAY = 1;
const BLACK = 2;
const color = new Map([...graph.keys()].map((k) => [k, WHITE]));
const stack = [];
const violations = [];

function dfs(u) {
	color.set(u, GRAY);
	stack.push(u);
	for (const v of graph.get(u) ?? []) {
		if (!graph.has(v)) continue;
		if (color.get(v) === GRAY) {
			const cycle = [...stack.slice(stack.indexOf(v)), v];
			if (cycle.some((m) => !inStore(m))) violations.push(cycle);
		} else if (color.get(v) === WHITE) {
			dfs(v);
		}
	}
	stack.pop();
	color.set(u, BLACK);
}

for (const k of graph.keys()) {
	if (color.get(k) === WHITE) dfs(k);
}

assert.deepEqual(
	violations,
	[],
	`require cycle(s) outside main-lib/store/:\n${violations.map((c) => c.join(" <- ")).join("\n")}`,
);

console.log(
	`[import-cycle] OK — ${graph.size} modules, no cycles outside main-lib/store/`,
);
