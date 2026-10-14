// Phase 0 (N-04) lint floor: machine-checked from here on, so every later
// diff (god-file splits, virtualization) is verified, not eyeballed.
// Deliberately lean: no stylistic rules (prettier owns style), no react
// plugin (JSX style churn out of scope) — correctness rules only.

const js = require("@eslint/js");
const tseslint = require("typescript-eslint");
const reactHooks = require("eslint-plugin-react-hooks");

module.exports = [
	{
		ignores: ["node_modules/", "dist/", "dist-app/", "indexer/__pycache__/"],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ["**/*.ts", "**/*.tsx"],
		plugins: { "react-hooks": reactHooks },
		rules: {
			...reactHooks.configs.flat.recommended.rules,
			// `any` is the codebase's IPC-boundary convention
			// (catch (e: any), bridge payloads) — typed later, not here.
			// (Overridden to error for src/stores/** + grid/** below.)
			"@typescript-eslint/no-explicit-any": "off",
			// 10 mount-time fetch/subscribe sites (App library load, grid
			// trays, search index) intentionally mirror external state into
			// useState — the blessed effect use-case. Revisit during the
			// M-12 grid split; until then a warning, not a gate.
			"react-hooks/set-state-in-effect": "warn",
		},
	},
	{
		files: ["src/stores/**/*.ts", "src/components/grid/**/*.tsx"],
		rules: {
			// Phase 5 (lint ramp): the post-decompose renderer code is
			// `any`-free — new stores/grid code stays that way. This block
			// runs after the general TS block so it wins for these paths.
			"@typescript-eslint/no-explicit-any": "error",
		},
	},
	{
		files: ["**/*.js"],
		languageOptions: {
			sourceType: "commonjs",
			globals: {
				...require("globals").node,
			},
		},
		rules: {
			// CJS is this repo's module system (main.js, main/, indexer/,
			// scripts/, node harness). ESM-only deps use dynamic import().
			// Stays off until the main TS/ESM migration lands (Phase 3
			// remainder) — flipping it now would flag every main-process
			// module by design.
			"@typescript-eslint/no-require-imports": "off",
		},
	},
	{
		// Injected into the page, not node: needs window/document.
		files: ["public/**/*.js"],
		languageOptions: {
			sourceType: "script",
			globals: {
				...require("globals").browser,
			},
		},
	},
];
