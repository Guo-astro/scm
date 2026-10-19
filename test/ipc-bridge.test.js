"use strict";

// IPC bridge drift test (ts-migration plan, Tier 2). Fails on any of:
//
//   1. committed preload.js / docs/ipc-contract.md ≠ generator output
//      (edit scripts/bridge-table.mjs, run `node scripts/gen-bridge.js`)
//   2. a table channel not registered at main-process load, registered by
//      a different module than the table claims, or registered extra
//      (evidence: the main-load harness dump, not greps)
//   3. an ipcMain.on channel differing from the table's send entries
//   4. a push channel that no main-side source ever names
//   5. MemoriesBridge members ≠ table methods, either direction
//      (parsed with the typescript compiler API)
//
// The preload↔MemoriesBridge *signatures* are already enforced by tsc
// (`@ts-check` + `@type {MemoriesBridge}` in the generated preload), so this
// test only owns routing/registration/topology.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const ROOT = path.join(__dirname, "..");

/** Every file that may send a push channel or register a handler. */
function mainSideSources() {
	const files = [path.join(ROOT, "main.ts")];
	for (const dir of ["main", "main-lib", "indexer"]) {
		const walk = (d) => {
			for (const e of fs.readdirSync(d, { withFileTypes: true })) {
				const p = path.join(d, e.name);
				if (e.isDirectory()) walk(p);
				else if (/\.(js|ts)$/.test(e.name)) files.push(p);
			}
		};
		walk(path.join(ROOT, dir));
	}
	return files;
}

async function main() {
	const { BRIDGE } = await import(path.join(ROOT, "scripts/bridge-table.mjs"));
	const { generatePreload, generateDoc } = require("../scripts/gen-bridge.js");

	// -- table self-consistency ------------------------------------------
	const channels = BRIDGE.filter((e) => e.channel).map((e) => e.channel);
	assert.equal(
		new Set(channels).size,
		channels.length,
		"duplicate channel in bridge table",
	);
	const methods = BRIDGE.map((e) => e.method);
	assert.equal(
		new Set(methods).size,
		methods.length,
		"duplicate method in bridge table",
	);

	// -- generated files are current -------------------------------------
	const preloadPath = path.join(ROOT, "preload.js");
	assert.equal(
		fs.readFileSync(preloadPath, "utf8"),
		await generatePreload(),
		"preload.js is stale — run `node scripts/gen-bridge.js`",
	);
	const docPath = path.join(ROOT, "docs/ipc-contract.md");
	assert.equal(
		fs.readFileSync(docPath, "utf8"),
		await generateDoc(),
		"docs/ipc-contract.md is stale — run `node scripts/gen-bridge.js`",
	);

	// -- registration reality (main-load harness dump) --------------------
	const dump = spawnSync(
		"node",
		[path.join(__dirname, "main-load-harness.js")],
		{
			encoding: "utf8",
			env: { ...process.env, MAIN_LOAD_DUMP: "1" },
		},
	);
	assert.equal(
		dump.status,
		0,
		`main-load harness failed (exit ${dump.status}):\n${dump.stderr}`,
	);
	const marker = "__MAIN_LOAD_DUMP__";
	const line = dump.stdout.split("\n").find((l) => l.startsWith(marker));
	assert.ok(line, "main-load harness dump marker not found");
	const registered = JSON.parse(line.slice(marker.length));

	const expectedHandles = Object.fromEntries(
		BRIDGE.filter((e) => e.kind === "invoke").map((e) => [
			e.channel,
			e.handler,
		]),
	);
	for (const [channel, handler] of Object.entries(expectedHandles)) {
		assert.ok(
			channel in registered.handles,
			`table channel ${channel} is not registered at load`,
		);
		assert.equal(
			registered.handles[channel],
			handler,
			`${channel} is registered by "${registered.handles[channel]}" but the table says "${handler}" — update scripts/bridge-table.mjs`,
		);
	}
	for (const channel of Object.keys(registered.handles)) {
		assert.ok(
			channel in expectedHandles,
			`${channel} is registered at load but missing from the bridge table`,
		);
	}

	const expectedOns = BRIDGE.filter((e) => e.kind === "send")
		.map((e) => e.channel)
		.sort();
	const actualOns = Object.keys(registered.ons).sort();
	assert.deepEqual(
		actualOns,
		expectedOns,
		"ipcMain.on channels differ from the table's send entries",
	);

	// -- push channels are named somewhere main-side ----------------------
	const sources = mainSideSources();
	for (const entry of BRIDGE.filter((e) => e.kind === "push")) {
		const found = sources.some((f) =>
			fs.readFileSync(f, "utf8").includes(`"${entry.channel}"`),
		);
		assert.ok(
			found,
			`push channel ${entry.channel} is never sent by main-side sources`,
		);
	}

	// -- MemoriesBridge members === table methods -------------------------
	const typesPath = path.join(ROOT, "src/types.d.ts");
	const sf = ts.createSourceFile(
		typesPath,
		fs.readFileSync(typesPath, "utf8"),
		ts.ScriptTarget.Latest,
		true,
	);
	/** @type {string[] | null} */
	let members = null;
	/** @type {Map<string, string>} method name → return type text */
	const returnTypes = new Map();
	/** @type {Map<string, string>} alias/interface name → member names */
	const aliasMembers = new Map();
	const visit = (node) => {
		if (
			ts.isInterfaceDeclaration(node) &&
			node.name.text === "MemoriesBridge"
		) {
			members = node.members.map((m) => m.name.getText(sf));
			for (const m of node.members) {
				if (!m.name) continue;
				returnTypes.set(
					m.name.getText(sf),
					(m.type ? m.type.getText(sf) : "").replace(/\s+/g, " "),
				);
			}
		}
		// Named result shapes (ImportResult, AskResult, …) so a declared
		// failure can be checked against the members the renderer receives.
		if (ts.isInterfaceDeclaration(node) && node.name) {
			aliasMembers.set(
				node.name.text,
				node.members.map((m) => m.name.getText(sf)).join(" "),
			);
		}
		if (ts.isTypeAliasDeclaration(node) && node.name) {
			aliasMembers.set(
				node.name.text,
				node.type.getText(sf).replace(/\s+/g, " "),
			);
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	assert.ok(members, "MemoriesBridge interface not found in src/types.d.ts");
	assert.deepEqual(
		[...members].sort(),
		[...methods].sort(),
		"MemoriesBridge members differ from the bridge table methods",
	);

	// -- failure contract: the table's shape vs the renderer-visible type --
	// Every invoke channel declares how a failure surfaces to the renderer.
	// The catalogue is what the uniform-envelope migration (ipc-wrapper.ts
	// V2) works from, so it has to be complete AND agree with the type the
	// renderer actually receives — otherwise it is a comment, not a contract.
	const FAILURE_SHAPES = new Set([
		"none",
		"envelope",
		"reason",
		"bare-ok",
		"mixed",
		"empty",
		"null",
		"result-errors",
		"throws",
	]);
	const invokes = BRIDGE.filter((e) => e.kind === "invoke");
	for (const e of invokes) {
		assert.ok(
			e.failure && FAILURE_SHAPES.has(e.failure),
			`${e.method} (${e.channel}) declares no known failure shape (got ${JSON.stringify(e.failure)})`,
		);
	}
	/** Resolve a return type to the shape the renderer sees. */
	const visibleShape = (method) => {
		const ret = returnTypes.get(method);
		if (!ret) return { text: "", known: false };
		if (/\bany\b/.test(ret)) return { text: ret, known: false };
		const inner = ret
			.replace(/^Promise</, "")
			.replace(/>$/, "")
			.trim();
		const alias = /^[A-Z][A-Za-z0-9]*$/.exec(inner);
		const text = alias ? aliasMembers.get(alias[0]) || inner : inner;
		return { text, known: true };
	};
	let unverifiable = 0;
	for (const e of invokes) {
		const { text, known } = visibleShape(e.method);
		if (!known) {
			unverifiable++;
			continue;
		}
		const hasOk = /\bok\b/.test(text);
		const hasError = /error/.test(text);
		const isArray = /\[\]/.test(text);
		const isNull = /\bnull\b/.test(text);
		/** @type {string[]} */
		const problems = [];
		if (e.failure === "empty" && !isArray) {
			problems.push("declared `empty` but the return type is not an array");
		}
		if (e.failure === "null" && !isNull) {
			problems.push("declared `null` but the return type is not nullable");
		}
		if (
			(e.failure === "envelope" ||
				e.failure === "reason" ||
				e.failure === "bare-ok") &&
			!hasOk
		) {
			problems.push(
				`declared \`${e.failure}\` but the return type has no \`ok\` member`,
			);
		}
		if (e.failure === "result-errors" && !hasError) {
			problems.push(
				"declared `result-errors` but the return type has no `error` member",
			);
		}
		assert.deepEqual(
			problems,
			[],
			`${e.method} (${e.channel}): ${problems.join("; ")} — return type ${text}`,
		);
	}

	// -- the declared shape vs what the handler actually does --------------
	// The type check above cannot see a handler that THROWS: the type still
	// says what it says while the runtime flattens the failure into
	// "Error invoking remote method …" (architecture audit 2026-10-19, §3.3
	// — `memories:set-model` was exactly that). A channel that declares a
	// readable shape must not throw out of its handler.
	const handlerSource = new Map();
	for (const file of mainSideSources()) {
		handlerSource.set(file, fs.readFileSync(file, "utf8"));
	}
	/** The body of a `handle("channel", …)` registration. */
	const handlerBody = (entry) => {
		const file = path.join(ROOT, `${entry.handler}.ts`);
		const src = handlerSource.get(file);
		if (src === undefined) {
			assert.fail(`handler source not found for ${entry.channel}: ${file}`);
		}
		const at = src.search(new RegExp(`handle\\(\\s*"${entry.channel}"`));
		if (at < 0) {
			assert.fail(`no handle() registration for ${entry.channel} in ${file}`);
		}
		const open = src.indexOf("(", at);
		let depth = 1;
		let i = open + 1;
		while (i < src.length && depth > 0) {
			if (src[i] === "(") depth++;
			else if (src[i] === ")") depth--;
			i++;
		}
		return src.slice(open + 1, i - 1);
	};
	for (const e of invokes) {
		if (e.failure === "throws") continue;
		const body = handlerBody(e);
		assert.ok(
			!/\bthrow\b/.test(body),
			`${e.method} (${e.channel}) declares the readable failure shape \`${e.failure}\` but its handler throws — a throw reaches the renderer as "Error invoking remote method …", which no caller can read`,
		);
	}

	console.log(
		`[ipc-bridge] OK — ${BRIDGE.length} methods (${expectedHandles ? Object.keys(expectedHandles).length : 0} handle + ${expectedOns.length} on + ${BRIDGE.filter((e) => e.kind === "push").length} push) verified against preload, doc, load-time registration, and MemoriesBridge`,
	);
	console.log(
		`[ipc-bridge] failure contract: ${invokes.length} invoke channels catalogued (${unverifiable} with an unverifiable return type)`,
	);
}

main().catch((err) => {
	console.error("[ipc-bridge] FAIL");
	console.error(err && err.stack ? err.stack : err);
	process.exit(1);
});
