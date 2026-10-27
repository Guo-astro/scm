import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as embeddingUtils from "../indexer/memory-embedding-utils.js";
import { phraseTokens as rendererPhraseTokens } from "../src/lib/memoryRank";
import { MAX_PHRASE_TOKENS, phraseTokens } from "../shared/phrase-tokens.ts";

// The phrase gate is split across processes: the indexer decides which tokens
// get embedded into the persisted phrase vectors, the renderer decides whether
// a query overlaps them. A drift is silent — the boost just fires on the wrong
// filenames — so the corpus below runs through BOTH entry points.

const CORPUS = [
	"scr-2024-2048-game.jpg",
	"IMG_1234.HEIC",
	"Screenshot 2026-08-10 at 10.32.44.png",
	"photo-of-a-dog-on-the-beach-at-sunset.jpg",
	"my.photo.new.image.untitled.pic.dsc.jpeg",
	"no-extension",
	"UPPER_CASE_name.MP4",
	"東京-2024.png",
	"a-b-c-d-e-f-g-h-i-j-k-l.png",
	"",
	".gitignore",
	"trailing.dots..png",
	"  spaced  out  .jpg",
];

test("renderer and indexer phrase tokenization agree on the corpus", () => {
	for (const filename of CORPUS) {
		expect(rendererPhraseTokens(filename)).toEqual(phraseTokens(filename));
		expect(embeddingUtils.phraseTokens(filename)).toEqual(
			phraseTokens(filename),
		);
		expect(embeddingUtils.buildFilenamePhrase(filename)).toBe(
			phraseTokens(filename).join(" "),
		);
	}
});

test("phrase rules are pinned (changing them requires a reindex)", () => {
	expect(phraseTokens("scr-2024-2048-game.jpg")).toEqual([
		"screenshot",
		"2024",
		"2048",
		"game",
	]);
	// Generic filename words add no signal and are dropped — including when
	// they arrive in a different case.
	expect(phraseTokens("IMG_1234.HEIC")).toEqual(["1234"]);
	// Separators are ".", "_", "-", whitespace only; other punctuation stays
	// inside the token (the phrase embedding was built the same way).
	expect(phraseTokens("it's-a-test.jpg")).toEqual(["it's", "a", "test"]);
	// No extension → no trailing empty token, and no token is invented.
	expect(phraseTokens("no-extension")).toEqual(["no", "extension"]);
});

test("the token cap bounds the embedded phrase", () => {
	const tokens = phraseTokens("a-b-c-d-e-f-g-h-i-j-k-l.png");
	expect(tokens).toHaveLength(MAX_PHRASE_TOKENS);
	expect(MAX_PHRASE_TOKENS).toBe(8);
});

test("no consumer re-inlines the phrase split (edit shared/ instead)", () => {
	// Behavioral parity would keep passing with two copies; this is the guard
	// against reintroducing one (same shape as the rune-class guard in
	// test/token-parity.test.ts).
	for (const rel of [
		"../src/lib/memoryRank.ts",
		"../indexer/memory-embedding-utils.ts",
	]) {
		const text = readFileSync(new URL(rel, import.meta.url), "utf8");
		expect(text.includes("[._\\-\\s]")).toBe(false);
	}
	const shared = readFileSync(
		new URL("../shared/phrase-tokens.ts", import.meta.url),
		"utf8",
	);
	expect(shared.includes("[._\\-\\s]")).toBe(true);
});
