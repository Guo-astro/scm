"use strict";

// Packaging guard: every first-party module the packaged app can require at
// startup must be shipped inside the asar — and since ts-migration Stage A
// the shipped tree is dist-main/ (the tsc mirror of main.js, preload.js,
// screenshot-probe.js, main/, main-lib/, indexer/, shared/, plus the asset
// copy from scripts/copy-main-assets.js). Historical regression this test
// exists for: the "Cannot find module './main-lib/settings.ts'" crash —
// main.js was split into main-lib/ but build.files was never updated, so
// `electron .` worked from source while the installed DMG crashed on launch.
//
// What it checks:
//   1. All relative require() AND import/export specifiers in the prod source
//      set resolve to an existing source file — since Stage B a ".js"
//      specifier may resolve to its ".ts" sibling (tsc still emits the .js
//      into dist-main/, so the shipped path stays the specifier's).
//   2. Every target maps to its shipped dist-main/ path: .js/.mjs files must
//      sit under a tsconfig.main.json include root (tsc emits them 1:1),
//      copied assets must sit under a scripts/copy-main-assets.js ASSETS
//      dir — and the shipped path must be covered by build.files globs.
//   3. package.json "main" points at the shipped entry (dist-main/main.js),
//      and build.files ships dist-main/** while the source trees stay out.
//   4. No literal require() in prod sources may point into scripts/ or
//      test/ (neither is packaged): main.js dispatches its e2e helpers via
//      requireE2E() (app.getAppPath()-resolved, env-gated) — pinned here.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { ASSETS } = require("../scripts/copy-main-assets.js");

const ROOT = path.join(__dirname, "..");
const pkg = JSON.parse(
	fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
);
const globs = pkg.build.files;
assert.ok(
	Array.isArray(globs) && globs.length > 0,
	"package.json build.files must exist",
);

assert.equal(
	pkg.main,
	"dist-main/main.js",
	'package.json "main" must point into the shipped dist-main/ tree',
);
assert.ok(
	globs.includes("dist-main/**"),
	'build.files must ship "dist-main/**"',
);
for (const stale of ["main.js", "main/**", "main-lib/**", "indexer/**"]) {
	assert.ok(
		!globs.includes(stale),
		`build.files must not ship the source entry "${stale}" anymore (dist-main/ is the shipped tree)`,
	);
}

// tsconfig.main.json (JSONC): full-line comments only — enough to parse it.
function readJsonc(file) {
	const raw = fs.readFileSync(path.join(ROOT, file), "utf8");
	const stripped = raw
		.split("\n")
		.filter((line) => !/^\s*\/\//.test(line))
		.join("\n");
	return JSON.parse(stripped);
}
const mainTsconfig = readJsonc("tsconfig.main.json");
const includeRoots = mainTsconfig.include;
assert.ok(
	Array.isArray(includeRoots) && includeRoots.includes("main"),
	"tsconfig.main.json include roots missing",
);

// A source-relative posix path is emitted by tsc iff it is one of the
// include entries (root files) or lives under one of the include dirs.
function emittedByTsc(relPosix) {
	const head = relPosix.split("/")[0];
	return includeRoots.includes(relPosix) || includeRoots.includes(head);
}

// A source-relative posix path is copied by scripts/copy-main-assets.js iff
// it lives under one of its ASSETS dirs.
function copiedAsset(relPosix) {
	return ASSETS.some(
		(asset) => relPosix === asset || relPosix.startsWith(`${asset}/`),
	);
}

function listModuleFiles(dir) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listModuleFiles(full));
		else if (entry.isFile() && /\.(js|mjs|cjs|ts)$/.test(entry.name))
			out.push(full);
	}
	return out;
}

const SOURCES = [
	path.join(ROOT, "main.ts"),
	path.join(ROOT, "preload.js"),
	path.join(ROOT, "screenshot-probe.ts"),
	...listModuleFiles(path.join(ROOT, "main")),
	...listModuleFiles(path.join(ROOT, "main-lib")),
	...listModuleFiles(path.join(ROOT, "indexer")),
	...listModuleFiles(path.join(ROOT, "shared")),
];
for (const src of SOURCES) {
	assert.ok(fs.existsSync(src), `prod source missing: ${src}`);
}

// Minimal matcher for the glob shapes used in build.files: "dir/**" prefix
// globs and exact file entries (plus "!" excludes).
function coveredByGlobs(relPosix) {
	let covered = false;
	for (const entry of globs) {
		if (entry.startsWith("!")) continue;
		if (entry.endsWith("/**")) {
			const prefix = entry.slice(0, -3);
			if (relPosix === prefix || relPosix.startsWith(`${prefix}/`)) {
				covered = true;
			}
		} else if (entry === relPosix) {
			covered = true;
		}
	}
	if (!covered) return false;
	for (const entry of globs) {
		if (!entry.startsWith("!")) continue;
		const excl = entry.slice(1);
		if (excl.endsWith("/**")) {
			const prefix = excl.slice(0, -3);
			if (relPosix === prefix || relPosix.startsWith(`${prefix}/`)) {
				return false;
			}
		} else if (excl === relPosix) {
			return false;
		}
	}
	return true;
}

// Stage B: converted modules use import/export specifiers (multiline import
// lists included), so the walk scans the whole text for every relative
// specifier shape and reports line numbers.
const SPECIFIER_RE =
	/(?:require\(\s*["']|import\s+["']|from\s+["'])(\.[^"']+)["']/g;

function specifiersWithLines(text) {
	const found = [];
	SPECIFIER_RE.lastIndex = 0;
	for (
		let m = SPECIFIER_RE.exec(text);
		m !== null;
		m = SPECIFIER_RE.exec(text)
	) {
		found.push({
			target: m[1],
			line: text.slice(0, m.index).split("\n").length,
		});
	}
	return found;
}

const failures = [];
let prodCount = 0;

for (const src of SOURCES) {
	const text = fs.readFileSync(src, "utf8");
	for (const { target, line } of specifiersWithLines(text)) {
		let resolved = path.normalize(path.join(path.dirname(src), target));
		const KNOWN_EXTS = [".js", ".mjs", ".cjs", ".json", ".ts"];
		if (!KNOWN_EXTS.some((ext) => resolved.endsWith(ext))) {
			resolved += ".js";
		}
		// Stage B source twins: a ".js" specifier may point at a converted
		// ".ts" sibling (the .js is gone from source but tsc still emits it
		// into dist-main/, so the SHIPPED path stays the specifier's), and a
		// ".ts" specifier is rewritten to .js by tsc
		// (rewriteRelativeImportExtensions) — check the source twin, map
		// relPosix to the emitted .js.
		let sourceFile = resolved;
		if (sourceFile.endsWith(".ts")) {
			resolved = `${resolved.slice(0, -3)}.js`;
		} else if (sourceFile.endsWith(".js") && !fs.existsSync(sourceFile)) {
			const ts = `${sourceFile.slice(0, -3)}.ts`;
			if (fs.existsSync(ts)) sourceFile = ts;
		}
		const rel = path.relative(ROOT, resolved);
		const relPosix = rel.split(path.sep).join("/");
		assert.ok(
			!rel.startsWith("..") && !path.isAbsolute(rel),
			`${path.relative(ROOT, src)}:${line} escapes the repo: ${target}`,
		);
		assert.ok(
			fs.existsSync(sourceFile),
			`${path.relative(ROOT, src)}:${line} requires missing file: ${target}`,
		);

		const where = `${path.relative(ROOT, src)}:${line}`;
		if (relPosix.startsWith("scripts/") || relPosix.startsWith("test/")) {
			assert.fail(
				`${where} literal-requires ${relPosix}, which is never packaged. ` +
					"Smoke helpers must go through requireDev() in main.js " +
					"(app.getAppPath()-resolved, env-gated) — see the " +
					"Stage A dispatch note there.",
			);
		}

		prodCount++;
		const shippedRel = `dist-main/${relPosix}`;
		const emitted = relPosix.endsWith(".json")
			? copiedAsset(relPosix)
			: emittedByTsc(relPosix) || copiedAsset(relPosix);
		if (!emitted) {
			failures.push(
				`${where} requires ${relPosix}, which neither tsconfig.main.json ` +
					"emits nor scripts/copy-main-assets.js copies — it cannot " +
					"ship in dist-main/",
			);
			continue;
		}
		if (!coveredByGlobs(shippedRel)) {
			failures.push(
				`${where} requires ${relPosix} → ${shippedRel}, which no build.files entry ships`,
			);
		}
	}
}

assert.deepEqual(
	failures,
	[],
	`${failures.length} prod require(s) missing from the packaged tree:\n${failures.join("\n")}`,
);

// The dev-helper dispatch must stay computed (no literal require into
// scripts/ or test/): pin the helper in place so a future edit cannot
// quietly re-add one.
const mainText = fs.readFileSync(path.join(ROOT, "main.ts"), "utf8");
assert.ok(
	mainText.includes("function requireDev(") &&
		mainText.includes("app.getAppPath()"),
	"main.ts must keep the requireDev() smoke dispatcher (app.getAppPath()-based)",
);
const devDispatches = (mainText.match(/requireDev\(/g) || []).length - 1; // minus the definition

// Copied assets: build:main must run the copy step, and the text-mean read
// site (build-memory-embeddings-core.js reads __dirname/text-mean/*.json —
// an fs read, invisible to the require walk above) must stay paired with
// the ASSETS list.
assert.ok(
	pkg.scripts["build:main"].includes("copy-main-assets"),
	"build:main must run scripts/copy-main-assets.js after tsc",
);
assert.ok(
	ASSETS.includes("indexer/text-mean"),
	'ASSETS must keep covering the runtime-read "indexer/text-mean" dir',
);
for (const asset of ASSETS) {
	assert.ok(
		fs.existsSync(path.join(ROOT, asset)),
		`ASSETS entry does not exist in the source tree: ${asset}`,
	);
}

console.log(
	`[packaged-files] OK — ${prodCount} prod require(s) → dist-main/ shipped paths, ` +
		`${devDispatches} dev smoke dispatch(es) via requireDev(), ` +
		`${ASSETS.length} copied asset dir(s)`,
);
