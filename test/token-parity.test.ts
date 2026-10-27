import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Cross-side drift alarm (ts-migration Tier 3): every tokenization consumer
// must agree with the shared spec (shared/cjk-tokens.ts +
// shared/rank-tokens.ts), and no consumer may re-inline the rune class.
// See the shared module headers for the documented deliberate variants
// (askTokens non-alphanumeric split; build-time whitespaceTokens without CJK
// expansion). Runs under `bun test` because it loads the renderer TS modules
// directly alongside the Node-side CommonJS consumers.

import * as sharedCjk from "../shared/cjk-tokens.ts";
import * as sharedRank from "../shared/rank-tokens.ts";
import {
	cjkBigramsForRun,
	cjkBigramsForText,
	containsCjk,
	extractCjkRuns,
} from "../src/lib/cjkTokens";
import { queryTokens } from "../src/lib/memoryRank";
import * as rankSearch from "../main-lib/rank-search.js";
import * as ask from "../main-lib/ask/retrieve.js";
import * as embeddingUtils from "../indexer/memory-embedding-utils.js";
import * as ocrWorker from "../indexer/ocr-worker.ts";
import { dialogueTokens } from "../indexer/dialogue-rank.ts";

// Tricky shapes: spaceless runs, mixed-script adjacency, punctuation,
// lone CJK chars, prolonged-sound marks, non-Latin alphabets, empties.
const CORPUS = [
	"",
	"   ",
	"a",
	"ab",
	"_x_",
	"台北車站",
	"Photo 東京駅 2024",
	"スクリーンショット",
	"スクリーン・ショット",
	"ス クリーン",
	"스크린샷",
	"漢字ひらがなカタカナ",
	"駅",
	"東京Tokyo",
	"東京 Tokyo 大阪",
	"Gurley? follow-up",
	"AI, ai-powered",
	"「東京」",
	"Café Привет",
	"一二三",
];

test("rankTokens parity: rank-search + renderer queryTokens + shared", () => {
	for (const text of CORPUS) {
		const expected = sharedRank.rankTokens(text);
		expect(rankSearch.rankTokens(text)).toEqual(expected);
		expect(queryTokens(text)).toEqual(expected);
	}
});

test("ask variants parity: askTokenSet (non-alnum Latin) + ocrTokenSet (word)", () => {
	for (const text of CORPUS) {
		expect([...ask.askTokenSet(text)]).toEqual(sharedRank.askTokens(text));
		expect([...ask.ocrTokenSet(text)]).toEqual(sharedRank.wordTokens(text));
	}
	// The documented divergence, exercised: "Gurley?" meets "gurley".
	expect([...ask.askTokenSet("Gurley?")]).toContain("gurley");
	expect(sharedRank.rankTokens("Gurley?")).toContain("gurley?");
});

test("build-time indexer variant: whitespace Latin only (no CJK bigrams)", () => {
	for (const text of CORPUS) {
		expect(embeddingUtils.queryTokens(text)).toEqual(
			sharedRank.whitespaceTokens(text, 2),
		);
	}
	// Deliberate: the persisted phrase embeddings score English-derived
	// labels, so build-time keeps "台北車站" whole where runtime expands it.
	expect(embeddingUtils.queryTokens("台北車站")).toEqual(["台北車站"]);
	expect(sharedRank.rankTokens("台北車站")).toEqual(["台北", "北車", "車站"]);
});

test("renderer facade parity + ocr-worker joining/filter", () => {
	for (const text of CORPUS) {
		expect(extractCjkRuns(text)).toEqual(sharedCjk.extractCjkRuns(text));
		expect(cjkBigramsForText(text)).toEqual(sharedCjk.cjkBigramsForText(text));
		expect(containsCjk(text)).toBe(sharedCjk.containsCjk(text));
	}
	expect(cjkBigramsForRun("台北車站")).toEqual(["台北", "北車", "車站"]);
	expect(ocrWorker.joinOcrWords(["ス", "クリーン", "駅"])).toBe("スクリーン駅");
	expect(ocrWorker.joinOcrWords(["Photo", "東京駅", "2024"])).toBe(
		"Photo 東京駅 2024",
	);
	expect(ocrWorker.isRealWord("「東京」")).toBe(true);
	expect(ocrWorker.isRealWord("a")).toBe(false);
	expect(ocrWorker.isRealWord("Привет")).toBe(true);
});

test("dialogue CJK parity: bigram keys match the shared spec, offsets slice to raw", () => {
	for (const text of CORPUS) {
		const toks = dialogueTokens(text);
		for (const t of toks) expect(text.slice(t.start, t.end)).toBe(t.raw);
		const cjkKeys: string[] = [];
		for (const t of toks) {
			if (sharedCjk.containsCjk(t.raw)) cjkKeys.push(t.key);
		}
		// Order-stable dedupe must equal cjkBigramsForText exactly — the
		// exact dialogue search tokenizes like grid/Ask/OCR, never drifts.
		expect([...new Set(cjkKeys)]).toEqual(cjkBigramsForText(text));
	}
});

test("no consumer re-inlines the rune class (edit shared/ instead)", () => {
	const consumers = [
		"../src/lib/cjkTokens.ts",
		"../src/lib/memoryRank.ts",
		"../main-lib/rank-search.ts",
		"../main-lib/ask/retrieve.ts",
		"../indexer/ocr-worker.ts",
		"../indexer/memory-embedding-utils.ts",
		"../indexer/dialogue-rank.ts",
	];
	for (const rel of consumers) {
		const text = readFileSync(new URL(rel, import.meta.url), "utf8");
		expect(text.includes("Script=Han")).toBe(false);
	}
	// Sanity: the shared spec itself is where the rune class lives.
	const shared = readFileSync(
		new URL("../shared/cjk-tokens.ts", import.meta.url),
		"utf8",
	);
	expect(shared.includes("Script=Han")).toBe(true);
});
