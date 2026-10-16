// Renderer facade for the shared CJK tokenization spec. The implementation
// (and its documentation) lives in shared/cjk-tokens.ts, which the main
// process and indexer workers require() directly — this module only
// re-exports it so renderer imports keep the stable "@/lib/cjkTokens" path
// and Vite resolves the .mjs through its normal pipeline.
//
// Never copy the rune class: edit shared/cjk-tokens.ts and run
// test/token-parity.test.ts (it fails if any consumer re-inlines the spec).
export {
	CJK_EXTRA,
	CJK_RUNE_SOURCE,
	CJK_RUN_RE,
	CJK_CHAR_RE,
	isCjkChar,
	containsCjk,
	extractCjkRuns,
	cjkBigramsForRun,
	cjkBigramsForText,
	glueCjkSpaces,
} from "../../shared/cjk-tokens.ts";
