// Pure helpers for the memory-embedding build. The .mjs build script imports
// these via default-imported CJS emit; unit tests exercise them directly.

// Hybrid-scoring constants used by the build-time memory-queries.json
// generation. Keep in sync with src/lib/memoryRank.ts (runtime ranking).
const FILENAME_BOOST = 0.2;
const PHRASE_BOOST = 0.6;
// Post-centering CLIP text-image cosines live in a tight band (roughly
// 0.02–0.29 on this index). An absolute 0.10 gate cut real matches ("food"
// tops out ~0.055); 0.04 separates honest matches from the near-zero noise
// floor while keeping the "no matches" honesty for unrelated queries.
const MIN_SEMANTIC_SCORE = 0.04;
// Below this fraction of the TOP score a candidate is noise. See the
// runtime copy in src/lib/memoryRank.ts (RELATIVE_KEEP).
const RELATIVE_KEEP = 0.6;

// Single-char tokens ("a", "i") substring-match nearly every filename and
// add only noise; repeated tokens double-count the same evidence.
const MIN_TOKEN_LENGTH = 2;

// The sample queries double as the suggested-search chips on /memories and
// as the memories:check diagnostics. Kept here so build + check share them.
export const SAMPLE_QUERIES = [
	"a laptop computer on a desk",
	"computer hacker",
	"a dog",
	"a beach or ocean scene",
	"a design mockup or poster",
	"devices",
];

// Phrase tokenization is shared with the renderer's gate; see
// shared/phrase-tokens.ts. buildFilenamePhrase is the same token list joined
// with spaces, so the persisted phrase vectors and the runtime gate cannot
// disagree.
import { phraseTokens } from "../shared/phrase-tokens.ts";

export { phraseTokens };

// Token-level filename → CLIP text phrase. e.g. "scr-2024-2048-game.jpg" →
// "screenshot 2024 2048 game". Deterministic, used by build + runtime docs.
export function buildFilenamePhrase(filename: string) {
	return phraseTokens(filename).join(" ");
}

// Deterministic, topic-diverse prompt list used to estimate the shared
// (anisotropic) direction of CLIP text embeddings. The average of these
// embeddings approximates the cone axis; projecting it out of query and
// phrase vectors restores the discriminative text-image signal that raw
// CLIP text embeddings lack (unrelated texts score 0.8+ cosine by default).
// The SAMPLE_QUERIES are appended so the estimate covers the site's actual
// suggested-search chips too (derived, not re-typed, so the two can't drift).
const TEXT_MEAN_BASE = [
	"a photo of a dog",
	"a picture of a cat",
	"an image of a car",
	"a laptop on a desk",
	"the sky is blue",
	"a rocket launching into space",
	"a beach at sunset",
	"a plate of food",
	"a city street",
	"a portrait of a person",
	"a mountain landscape",
	"a computer screen",
	"a smartphone in hand",
	"a book on a table",
	"a coffee cup",
	"a bird in flight",
	"a flower in bloom",
	"an office meeting",
	"a video game screenshot",
	"a music album cover",
	"a house exterior",
	"a pair of shoes",
	"a shopping cart",
	"a hospital building",
	"a train station",
	"an airplane window",
	"a forest path",
	"a river between mountains",
	"a desert scene",
	"an astronaut in space",
];
export const TEXT_MEAN_SAMPLE = [...TEXT_MEAN_BASE, ...SAMPLE_QUERIES];

// Projects `vec` (unit-length) onto the shared text direction and returns
// the residual, renormalized. CLIP text embeddings are strongly anisotropic
// (all texts share a dominant direction), so raw text-image cosine lands in
// a narrow noise band; removing the shared component restores ranking
// signal. Returns the input unchanged when no direction is provided, and
// null when the residual is degenerate (vector IS the shared direction).
// KEEP IN SYNC with centerQuery in app/hooks/useMemorySearch.ts (the runtime
// mirror of this math — same epsilon, same behavior).
export function centerText(
	vec: ArrayLike<number>,
	textMean: ArrayLike<number> | null | undefined,
): ArrayLike<number> | null {
	if (!textMean || textMean.length !== vec.length) return vec;
	const proj = dotProduct(vec, textMean);
	const out = new Float32Array(vec.length);
	for (let i = 0; i < vec.length; i++) {
		// Casts: dense equal-length vectors (the loop-bound read pattern).
		out[i] = (vec[i] as number) - proj * (textMean[i] as number);
	}
	// A zero-norm residual (vec IS the shared direction) can never be a
	// meaningful ranking direction; float noise leaves ~1e-7 here, so use
	// the same 1e-6 epsilon as the runtime hook rather than `norm <= 0`.
	let norm = 0;
	for (let i = 0; i < vec.length; i++)
		norm += (out[i] as number) * (out[i] as number);
	norm = Math.sqrt(norm);
	if (norm <= 1e-6) return null;
	for (let i = 0; i < vec.length; i++) out[i] = (out[i] as number) / norm;
	return out;
}

// Query text → deduplicated tokens, dropping single-char noise. Delegates to
// the shared spec's build-time variant (shared/rank-tokens.ts
// whitespaceTokens): Latin-only by design — the runtime (memoryRank
// queryTokens) adds CJK bigrams, but persisted phrase embeddings score
// English-derived labels, so adding them here would change build outputs.
import { whitespaceTokens } from "../shared/rank-tokens.ts";

export function queryTokens(query: string) {
	return whitespaceTokens(query, MIN_TOKEN_LENGTH);
}

// Fraction of query tokens found verbatim in the filename (0..1).
export function filenameTokenMatch(query: string, filename: string) {
	const tokens = queryTokens(query);
	if (tokens.length === 0) return 0;
	const lower = filename.toLowerCase();
	let hits = 0;
	for (const token of tokens) {
		if (lower.includes(token)) hits++;
	}
	return hits / tokens.length;
}

// Whether any query token appears in the filename's derived phrase (0..1).
// The phrase boost must only fire on LITERAL overlap: centered CLIP
// text-text cosine is ~0.2–0.4 for every pair, so an ungated phrase boost
// turns every query (even "zzzz-nothing") into a wall of ~0.3 scores.
export function phraseTokenOverlap(query: string, filename: string) {
	const tokens = queryTokens(query);
	if (tokens.length === 0) return 0;
	const phrase = phraseTokens(filename);
	if (phrase.length === 0) return 0;
	let hits = 0;
	for (const token of tokens) {
		if (phrase.includes(token)) hits++;
	}
	return hits / tokens.length;
}

export function dotProduct(a: ArrayLike<number>, b: ArrayLike<number>) {
	const n = Math.min(a.length, b.length);
	let sum = 0;
	// Casts: dense parallel vectors (the loop-bound read pattern).
	for (let i = 0; i < n; i++) sum += (a[i] as number) * (b[i] as number);
	return sum;
}

// Same composition as src/lib/memoryRank.ts rankMemoriesHybrid:
// image cosine + gated phrase-excess boost + filename-token boost. The
// phrase boost only fires when the query literally names something in the
// filename's phrase (phraseTokenOverlap), mirroring the runtime gate.
export function hybridScore(
	qVec: ArrayLike<number>,
	imageVec: ArrayLike<number>,
	phraseVec: ArrayLike<number> | null | undefined,
	query: string,
	filename: string,
) {
	let score = dotProduct(qVec, imageVec);
	if (phraseVec && phraseTokenOverlap(query, filename) > 0) {
		const phraseSim = dotProduct(qVec, phraseVec);
		if (phraseSim > score) score += PHRASE_BOOST * (phraseSim - score);
	}
	score += FILENAME_BOOST * filenameTokenMatch(query, filename);
	return score;
}

// Throws if the vector is not usable as an embedding row.
export function validateEmbedding(
	vec: ArrayLike<number> | null | undefined,
	expectedDim: number,
): boolean {
	if (!vec || typeof vec.length !== "number" || vec.length === 0) {
		throw new Error("Embedding output is empty");
	}
	if (expectedDim > 0 && vec.length !== expectedDim) {
		throw new Error(
			`Embedding dimension mismatch: expected ${expectedDim}, got ${vec.length}`,
		);
	}
	for (let i = 0; i < vec.length; i++) {
		const v = vec[i];
		if (typeof v !== "number" || Number.isNaN(v)) {
			throw new Error(`Embedding contains NaN at index ${i}`);
		}
		if (!Number.isFinite(v)) {
			throw new Error(`Embedding contains non-finite value at index ${i}`);
		}
	}
	return true;
}

// L2-normalizes in place; returns the norm for diagnostics.
export function normalizeInPlace(vec: number[] | Float32Array): number {
	let norm = 0;
	for (let i = 0; i < vec.length; i++) {
		norm += (vec[i] as number) * (vec[i] as number);
	}
	norm = Math.sqrt(norm);
	if (norm <= 0) {
		throw new Error("Embedding has zero norm (cannot normalize)");
	}
	for (let i = 0; i < vec.length; i++) {
		vec[i] = (vec[i] as number) / norm;
	}
	return norm;
}

// Classifies a batch of per-image error messages.
// Returns { systemic, dominantMessage, count } where systemic means every
// failure shares one message AND either enough failures to rule out a handful
// of corrupt files (minSystemicCount) or 100% of images failed (a
// pipeline/config regression, e.g. text-only feature-extraction).
export function classifyFailures(
	errors: string[],
	{
		minSystemicCount = 5,
		total = null,
	}: { minSystemicCount?: number; total?: number | null } = {},
) {
	if (!errors || errors.length === 0) {
		return { systemic: false, dominantMessage: null, count: 0 };
	}
	const counts = new Map<string, number>();
	for (const message of errors) {
		counts.set(message, (counts.get(message) || 0) + 1);
	}
	// Cast: errors is non-empty, so the sorted list always has a head.
	const [dominantMessage, count] = [...counts.entries()].sort(
		(a, b) => b[1] - a[1],
	)[0] as [string, number];
	const allSame = count === errors.length;
	const allFailed = total !== null && errors.length === total && total > 0;
	const systemic = allSame && (errors.length >= minSystemicCount || allFailed);
	return { systemic, dominantMessage, count };
}

// Groups failure messages with counts for a human-readable summary.
export function summarizeFailures(errors: string[]) {
	const counts = new Map<string, number>();
	for (const message of errors) {
		counts.set(message, (counts.get(message) || 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([message, n]) => `  - ${n}x ${message}`);
}

export { FILENAME_BOOST, PHRASE_BOOST, MIN_SEMANTIC_SCORE, RELATIVE_KEEP };
