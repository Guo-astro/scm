"use strict";

// Import-alias guard (Phase 1 fallout): destructured requires must name
// real exports. Regression test for the llm-ask slice shipping
// `llmModelDownloaded` (undefined — the pre-move code aliased
// `modelDownloaded: llmModelDownloaded`), which made every model row read
// "not downloaded" while the engine row (separate snapshot path) looked
// fine. Invisible to node --check (syntax), eslint no-undef (binding
// exists), tsc (main/ unchecked), packaged-files (target exists), and unit
// tests (never load main-process modules) — only an Electron boot or this
// test sees it.
//
// What it checks, for every relative require() in main.js, main/ipc/**,
// and main-lib/store/**: each destructured name (left of any `:` alias)
// exists in the target's exports (additive `exports.X =`, `module.exports
// = {...}` keys, and defineProperty getters). Smoke-only requires into
// scripts/ and test/ are skipped (packaged-files owns them).

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

function exportsOf(file) {
	const src = fs.readFileSync(file, "utf8");
	const names = new Set();
	for (const m of src.matchAll(/^exports\.([A-Za-z_][A-Za-z0-9_]*) =/gm)) {
		names.add(m[1]);
	}
	for (const m of src.matchAll(
		/defineProperty\(exports,\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
	)) {
		names.add(m[1]);
	}
	const mod = src.match(/module\.exports = \{(.*?)\};/s);
	if (mod) {
		const body = mod[1].replace(/\/\/.*/g, "");
		for (const part of body.split(",")) {
			const p = part.trim();
			if (!p) continue;
			if (p.includes(":")) names.add(p.split(":")[0].trim());
			else {
				const mm = p.match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
				if (mm) names.add(mm[1]);
			}
		}
	}
	return names;
}

const REQUIRE_RE = /const \{([^{}]*?)\} = require\(["'](\.[^"']+)["']\)/g;
const failures = [];

function checkConsumer(srcPath) {
	const src = fs.readFileSync(srcPath, "utf8");
	for (const m of src.matchAll(REQUIRE_RE)) {
		const target = m[2];
		if (!target.startsWith(".")) continue;
		let resolved = path.normalize(path.join(path.dirname(srcPath), target));
		if (!resolved.endsWith(".js")) resolved += ".js";
		if (!fs.existsSync(resolved)) continue; // packaged-files owns existence
		const rel = path.relative(ROOT, resolved);
		if (rel.startsWith("scripts/") || rel.startsWith("test/")) continue;
		const exported = exportsOf(resolved);
	 for (const line of m[1].split("\n")) {
			const name = line.trim().replace(/,$/, "");
			if (!name || name.startsWith("//")) continue;
			// `orig: local` alias form — the ORIGINAL must exist in target.
			const orig = name.includes(":") ? name.split(":")[0].trim() : name;
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(orig)) continue;
			if (!exported.has(orig)) {
				failures.push(
					`${path.relative(ROOT, srcPath)} imports '${orig}' from ${rel}, which exports no such name`,
				);
			}
		}
	}
}

checkConsumer(path.join(ROOT, "main.js"));
for (const dir of ["main", "main-lib"]) {
	for (const src of listJsFiles(path.join(ROOT, dir))) {
		checkConsumer(src);
	}
}

assert.deepEqual(
	failures,
	[],
	`${failures.length} dangling import(s):\n${failures.join("\n")}`,
);

console.log("[import-aliases] OK — every destructured require names a real export");
