// Rank/query tokenization spec — single source for grid search, Ask mode,
// OCR rows, and the build-time indexer. Built on shared/cjk-tokens.ts.
//
// Four DELIBERATE variants (documented divergences — do not "unify" without
// deciding behavior first):
//
//   rankTokens        whitespace-split Latin (len ≥ 2) + CJK bigrams.
//                     Grid search + the renderer's runtime queryTokens
//                     (src/lib/memoryRank.ts) — these two MUST match.
//   askTokens         non-alphanumeric Latin split (len ≥ 2) + CJK bigrams.
//                     Ask-mode-only recall fix: "Gurley?" meets "gurley"
//                     and "follow-up" meets "follow"+"up". Grid search
//                     intentionally still whitespace-splits (Ask-side-only
//                     fix, kept from the original Ask plan).
//   wordTokens        non-alphanumeric split, ANY length (≥ 1) + CJK
//                     bigrams — OCR row tokens: punctuation-stripped on
//                     both sides, so "ai," matches "AI" but a bare "a"
//                     inside a word never matches the word "a". Shared by
//                     rank-search's OCR boost and Ask's OCR evidence.
//   whitespaceTokens  build-time indexer only
//                     (indexer/memory-embedding-utils.ts): Latin-only by
//                     design — the persisted phrase embeddings score
//                     candidate labels, which are English-derived; adding
//                     CJK bigrams here would change build outputs.
//
// test/token-parity.test.ts runs a corpus through every consumer and fails
// on any drift from these functions.

import { CJK_RUN_RE, cjkBigramsForText } from "./cjk-tokens.ts";

export const MIN_TOKEN_LENGTH = 2;

/**
 * Canonical rank/query tokens: lowercase, whitespace-split Latin words
 * (>= MIN_TOKEN_LENGTH chars, CJK runs removed first so "東京Tokyo" still
 * yields "tokyo") plus CJK bigrams. Deduplicated, insertion-ordered.
 */
export function rankTokens(text: string): string[] {
	const lower = (text || "").toLowerCase();
	const seen = new Set<string>();
	CJK_RUN_RE.lastIndex = 0;
	const latinPart = lower.replace(CJK_RUN_RE, " ");
	for (const t of latinPart.split(/\s+/)) {
		if (t.length >= MIN_TOKEN_LENGTH) seen.add(t);
	}
	for (const bigram of cjkBigramsForText(lower)) seen.add(bigram);
	return [...seen];
}

/**
 * Ask-mode tokens (documented divergence): same CJK side as rankTokens,
 * but the Latin side splits on non-alphanumerics so punctuation-bearing
 * queries ("Gurley?", "follow-up") meet their stripped OCR forms.
 */
export function askTokens(text: string): string[] {
	const lower = (text || "").toLowerCase();
	const seen = new Set<string>();
	CJK_RUN_RE.lastIndex = 0;
	const latinPart = lower.replace(CJK_RUN_RE, " ");
	for (const t of latinPart.split(/[^\p{L}\p{N}]+/u)) {
		if (t.length >= MIN_TOKEN_LENGTH) seen.add(t);
	}
	for (const bigram of cjkBigramsForText(lower)) seen.add(bigram);
	return [...seen];
}

/**
 * OCR-row tokens: Unicode word split keeping every non-empty fragment
 * (word-boundary matching — see the OCR boost comment in rank-search.ts),
 * plus CJK bigrams. Deduplicated, insertion-ordered.
 */
export function wordTokens(text: string): string[] {
	const lower = String(text || "").toLowerCase();
	const seen = new Set<string>();
	for (const t of lower.split(/[^\p{L}\p{N}]+/u)) {
		if (t) seen.add(t);
	}
	for (const bigram of cjkBigramsForText(lower)) seen.add(bigram);
	return [...seen];
}

/**
 * Latin-only whitespace tokens (build-time indexer; see the header).
 */
export function whitespaceTokens(
	text: string,
	minLength: number = MIN_TOKEN_LENGTH,
): string[] {
	const seen = new Set<string>();
	for (const t of String(text || "")
		.toLowerCase()
		.split(/\s+/)) {
		if (t.length >= minLength) seen.add(t);
	}
	return [...seen];
}
