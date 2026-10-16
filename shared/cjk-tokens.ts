// CJK tokenization spec — the single source of truth for BOTH sides:
// the renderer (Vite) and the Node side (main process + indexer workers),
// which load this .ts directly (type stripping) and ship its compiled
// dist-main mirror.
//
// Spaceless scripts (Han / Hiragana / Katakana / Hangul) cannot use
// whitespace tokenization: "台北車站" is one whitespace token but three
// searchable units. The agreed rule (see MDs/OCR-Languages-Support.md):
// extract CJK runs, expand each run to overlapping bigrams, keep single-char
// runs as-is (a lone 駅/酒 is meaningful, unlike English "a"/"i").
//
// Consumers (all thin delegates — never copy the rune class again):
//   - src/lib/cjkTokens.ts            renderer facade (re-export)
//   - src/lib/memoryRank.ts           queryTokens via shared/rank-tokens.ts
//   - main-lib/rank-search.ts         rankTokens / OCR word tokens
//   - main-lib/ask/retrieve.ts        askTokenSet / ocrTokenSet
//   - indexer/ocr-worker.ts           word filter + CJK-aware joining
//   - indexer/memory-embedding-utils.ts  via shared/rank-tokens.ts
//   - indexer/transcript-store-utils.ts  dialogueTokens (exact dialogue search)
//
// test/token-parity.test.ts fails if any consumer re-inlines the rune class
// or drifts behaviorally from these functions.

// Common-script marks Japanese reads as word characters: ー (U+30FC
// prolonged sound mark — スクリーン would otherwise split mid-word),
// ・ (U+30FB katakana middle dot), 々〻 (iteration marks), ゝゞ (hiragana
// iteration), ｰ (halfwidth prolonged sound mark). Without them a
// スクリーンショット query loses its boundary bigrams (リー/ーン).
export const CJK_EXTRA =
	"\u30FC\u30FB\u3005\u303B\u3031\u3032\u3033\u3034\u3035\uFF70";

// Bracket-inner character class source: one CJK code point from Han (zh),
// Hiragana + Katakana (ja), Hangul (ko), plus CJK_EXTRA — no enclosing
// brackets, so consumers can splice it into their own classes
// (`[^${CJK_RUNE_SOURCE}a-zA-Z0-9]` in ocr-worker). Japanese mixed-script
// adjacency (Kanji + Hiragana + Katakana) stays one run so bigrams span the
// script boundary, matching how the text is written.
export const CJK_RUNE_SOURCE =
	"\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}\\u30FC\\u30FB\\u3005\\u303B\\u3031\\u3032\\u3033\\u3034\\u3035\\uFF70";

export const CJK_RUN_RE = new RegExp(`[${CJK_RUNE_SOURCE}]+`, "gu");

export const CJK_CHAR_RE = new RegExp(`[${CJK_RUNE_SOURCE}]`, "u");

/**
 * True when the string's first character is CJK (empty string → false).
 */
export function isCjkChar(ch: string): boolean {
	if (!ch) return false;
	CJK_CHAR_RE.lastIndex = 0;
	return CJK_CHAR_RE.test(ch);
}

export function containsCjk(text: string): boolean {
	if (!text) return false;
	CJK_RUN_RE.lastIndex = 0;
	return CJK_RUN_RE.test(text);
}

/**
 * All CJK runs in the text, in order (e.g. ["東京", "駅"] for "東京 駅").
 */
export function extractCjkRuns(text: string): string[] {
	if (!text) return [];
	CJK_RUN_RE.lastIndex = 0;
	return text.match(CJK_RUN_RE) ?? [];
}

/**
 * Overlapping bigrams for one CJK run: "台北車站" → ["台北","北車","車站"].
 * A single-char run stays as-is (["駅"]) — lone Han/Hangul/Kana chars are
 * searchable units, not noise.
 */
export function cjkBigramsForRun(run: string): string[] {
	if (!run) return [];
	const chars = [...run];
	if (chars.length <= 1) return chars.length === 1 ? [run] : [];
	const out: string[] = [];
	// Bounds-proven reads (i and i+1 < chars.length by the loop bound).
	for (let i = 0; i < chars.length - 1; i++) {
		out.push((chars[i] as string) + (chars[i + 1] as string));
	}
	return out;
}

/**
 * All bigrams for every CJK run in the text, deduplicated, order-stable.
 */
export function cjkBigramsForText(text: string): string[] {
	const seen = new Set<string>();
	for (const run of extractCjkRuns(text)) {
		for (const bigram of cjkBigramsForRun(run)) {
			if (!seen.has(bigram)) seen.add(bigram);
		}
	}
	return [...seen];
}

const CJK_GLUE_RE = new RegExp(
	`([${CJK_RUNE_SOURCE}])\\s+([${CJK_RUNE_SOURCE}])`,
	"gu",
);

/**
 * Glue spaces that sit between two CJK chars: "東 京" → "東京" (Tesseract
 * word boxes often carry such splits; bigram search needs contiguous runs).
 * Latin spacing is untouched.
 */
export function glueCjkSpaces(text: string): string {
	return text.replace(CJK_GLUE_RE, "$1$2");
}
