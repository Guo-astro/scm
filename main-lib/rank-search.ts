// Pure hybrid search ranking (Phase 0.4): O(N × dim) cosine + keyword/OCR
// boosts, extracted from main.js so the same scorer runs in-process (tests,
// fallback) and inside a dedicated utilityProcess (production IPC path).
// No electron dependency — plain-node tested.
//
// Tokenization delegates to the shared spec (shared/rank-tokens.ts); the
// constants that remain local are ranking weights, not token rules.

import { containsCjk } from "../shared/cjk-tokens.ts";
import {
	rankTokens as sharedRankTokens,
	wordTokens,
} from "../shared/rank-tokens.ts";

export function cosineSim(a: ArrayLike<number>, b: ArrayLike<number>): number {
	let dot = 0,
		na = 0,
		nb = 0;
	// Bounds-proven reads (i < a.length): cast keeps the old behavior for
	// dense arrays instead of dead undefined checks in the hot loop.
	for (let i = 0; i < a.length; i++) {
		const av = a[i] as number;
		const bv = b[i] as number;
		dot += av * bv;
		na += av * av;
		nb += bv * bv;
	}
	return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Cosine with the query norm and a precomputed row norm (C-03 fast path).
export function cosineSimPre(
	qVec: ArrayLike<number>,
	vec: ArrayLike<number>,
	qNorm: number,
	vecNorm: number,
): number {
	if (qNorm === 0 || vecNorm === 0) return 0;
	let dot = 0;
	// Bounds-proven reads (k < qVec.length): see cosineSim.
	for (let k = 0; k < qVec.length; k++) {
		dot += (qVec[k] as number) * (vec[k] as number);
	}
	return dot / (qNorm * vecNorm);
}

const RANK_NOISE_TOKENS = new Set([
	"img",
	"image",
	"photo",
	"pic",
	"picture",
	"dsc",
	"dscn",
	"untitled",
	"new",
]);

export function rankTokens(text: string): string[] {
	// Shared spec (shared/rank-tokens.ts): Latin whitespace split (len>=2)
	// plus Han/Hiragana/Katakana/Hangul runs expanded to overlapping bigrams
	// (single char stays as-is). The wrapper keeps internal call sites and
	// the module export unchanged.
	return sharedRankTokens(text);
}

export function rankFilenameMatch(
	queryTokens: string[],
	filename: string,
): number {
	const lower = filename.toLowerCase();
	let hits = 0;
	for (const t of queryTokens) {
		if (lower.includes(t)) hits++;
	}
	return hits / (queryTokens.length || 1);
}

// Per-row memo of the WORD tokens of each OCR word (the same normalization
// the renderer's highlight matcher applies: Unicode word split + CJK
// bigrams). Keyed on the row's array object, which is stable for the life of
// the in-memory library — a splice replaces the array, so a removed row's
// cache entry dies with it.
const ocrWordTokenCache = new WeakMap<object, Set<string>>();

export function ocrWordTokenSet(
	ocrWords: Array<{ text?: unknown } | null | undefined> | null | undefined,
): Set<string> {
	// Cast: callers pass truthy rows (rankOcrWordMatch guards falsy up
	// front); the cast preserves the exact runtime behavior including the
	// throw on a corrupt null key, with no behavior change.
	let set = ocrWordTokenCache.get(ocrWords as object);
	if (!set) {
		set = new Set();
		for (const w of ocrWords || []) {
			if (!w || !w.text) continue;
			// Unicode word split + CJK bigrams, shared with Ask's OCR rows
			// (shared/rank-tokens.ts wordTokens). The CJK side matters:
			// tesseract returns CJK as whole lines, so a 車站 query must
			// still hit the 台北車站 line.
			for (const t of wordTokens(String(w.text))) set.add(t);
		}
		ocrWordTokenCache.set(ocrWords as object, set);
	}
	return set;
}

// Fraction of query tokens that appear as an EXACT word in the photo's OCR
// text — punctuation-stripped on both sides, so "ai," matches "AI" and
// "ai-powered" matches both "AI" and "powered", but "ai" still never matches
// the "ai" inside "painting". CJK tokens (bigrams / single Han chars) match
// by containment instead: spaceless scripts have no word boundaries, so a
// 車站 query must hit the 台北車站 line.
export function rankOcrWordMatch(
	queryTokens: string[],
	ocrWords: Array<{ text?: unknown } | null | undefined> | null | undefined,
): number {
	if (!ocrWords || ocrWords.length === 0 || queryTokens.length === 0) return 0;
	const set = ocrWordTokenSet(ocrWords);
	if (set.size === 0) return 0;
	let hits = 0;
	for (const raw of queryTokens) {
		if (containsCjk(raw)) {
			if (set.has(raw.toLowerCase())) {
				hits++;
			}
			continue;
		}
		for (const t of raw.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
			if (t && set.has(t)) {
				hits++;
				break;
			}
		}
	}
	return hits / (queryTokens.length || 1);
}

export function rankPhraseOverlap(
	queryTokens: string[],
	filename: string,
): number {
	const base = filename.replace(/\.[^.]+$/, "");
	const phrase = base
		.toLowerCase()
		.split(/[._\-\s]+/)
		.filter(Boolean)
		.map((t) => (t === "scr" ? "screenshot" : t))
		.filter((t) => !RANK_NOISE_TOKENS.has(t))
		.slice(0, 8);
	if (phrase.length === 0 || queryTokens.length === 0) return 0;
	let hits = 0;
	for (const t of queryTokens) {
		if (phrase.includes(t)) hits++;
	}
	return hits / queryTokens.length;
}

// Hybrid-ranking constants — must match src/lib/memoryRank.ts.
export const RANK_FILENAME_BOOST = 0.2;
export const RANK_PHRASE_BOOST = 0.6;
// Word-EXACT OCR hits, applied ONLY after the natural cutoff (ordering
// boost, never a scoring boost): the query literally written on the photo
// is the evidence the highlight boxes draw, so those photos lead the grid —
// but because the boost lands after the floor/cutoff math, it can never
// inflate the band and squeeze purely-visual matches out of the results
// (the regression that made Files mode read as OCR-only).
export const RANK_OCR_WORD_BOOST = 0.5;
export const RANK_MIN_SCORE = 0.04;
export const RANK_RELATIVE_KEEP = 0.6;
export const RANK_DIVERSITY_THRESHOLD = 0.92;

export interface RankLibrary {
	filenames: string[];
	embeddings: Array<Float32Array | null>;
	dim: number;
	phrases: Array<Float32Array | null>;
	ocrWords?: Array<Array<{ text?: unknown } | null> | null>;
	modelId?: string;
}

export interface RankThresholds {
	minSemanticScore?: number;
	relativeKeep?: number;
}

interface ScoredRow {
	idx: number;
	filename: string;
	score: number;
	_baseCosine: number;
	_phraseContrib: number;
	_filenameContrib: number;
	dominant?: string;
	breakdown?: {
		semantic: number;
		phrase: number;
		filename: number;
		ocr: number;
	};
}

export interface RankResult {
	filename: string;
	score: number;
	dominant?: string;
	breakdown?: {
		semantic: number;
		phrase: number;
		filename: number;
		ocr: number;
	};
}

// Score an already-loaded library against an embedded query vector.
// Pure: no fs, no electron, no model. `thresholds` is thresholdsFor(modelId)
// (or {}); `norms` is libraryNorms(). Returns JSON-safe result rows.
export function scoreLibrary(
	l: RankLibrary,
	trimmed: string,
	qVec: ArrayLike<number>,
	topK: number,
	thresholds: RankThresholds,
	norms: ArrayLike<number>,
): RankResult[] {
	if (!l || !l.filenames.length || !l.embeddings.length) return [];
	if (l.embeddings.length !== l.filenames.length) return [];
	if (!qVec || qVec.length !== l.dim) return [];
	if (!Number.isFinite(topK) || topK < 1) return [];
	const trimmedQuery = (trimmed || "").trim();
	if (!trimmedQuery) return [];

	const minScore = thresholds?.minSemanticScore ?? RANK_MIN_SCORE;
	const relativeKeep = thresholds?.relativeKeep ?? RANK_RELATIVE_KEEP;
	const qt = rankTokens(trimmedQuery);

	// Query norm (once per query) + precomputed per-row norms: the inner
	// loop does cosine as dot/(qNorm·rowNorm) instead of recomputing two
	// norms per row (C-03).
	let qNormSq = 0;
	for (let k = 0; k < qVec.length; k++) {
		qNormSq += (qVec[k] as number) * (qVec[k] as number);
	}
	const qNorm = qNormSq > 0 ? Math.sqrt(qNormSq) : 0;

	let scored: ScoredRow[] = [];
	// Parallel-array reads (filenames/embeddings/norms/phrases share the
	// row index; the embeddings cast below is the established pattern) —
	// the row-count invariant is the loader's, not the ranker's.
	for (let i = 0; i < l.filenames.length; i++) {
		// Casts: parallel embedding rows are dense in a loaded library; a
		// corrupt null row throws today, and the cast preserves that
		// behavior exactly (no silent skip).
		const baseCosine = cosineSimPre(
			qVec,
			l.embeddings[i] as ArrayLike<number>,
			qNorm,
			norms[i] as number,
		);
		let score = baseCosine;
		// Phrase boost (gated on literal token overlap)
		let phraseContrib = 0;
		if (l.phrases.length === l.filenames.length && qt.length > 0) {
			if (rankPhraseOverlap(qt, l.filenames[i] as string) > 0) {
				const ps = cosineSim(qVec, l.phrases[i] as ArrayLike<number>);
				if (ps > score) phraseContrib = RANK_PHRASE_BOOST * (ps - score);
			}
			score += phraseContrib;
		}
		// Filename token match. Deliberately NO OCR signal here: Files mode
		// is semantic + filename evidence only — the OCR tab owns text
		// matching, and an OCR-driven score inflates the relative cutoff
		// until purely-visual matches are filtered out of the grid.
		let filenameContrib = 0;
		if (qt.length > 0) {
			filenameContrib =
				RANK_FILENAME_BOOST * rankFilenameMatch(qt, l.filenames[i] as string);
		}
		score += filenameContrib;
		scored.push({
			idx: i,
			filename: l.filenames[i] as string,
			score,
			// Capture components for the dominant-signal classification
			// and the hover breakdown tooltip. These are lightweight
			// (one float each) and die with the scored array.
			_baseCosine: baseCosine,
			_phraseContrib: phraseContrib,
			_filenameContrib: filenameContrib,
		});
	}
	scored.sort((a, b) => b.score - a.score);

	// Absolute floor: top match below minScore → nothing relevant
	const topScored = scored[0];
	if (topScored && topScored.score < minScore) return [];

	// Rows with an exact OCR word hit, resolved once for the cutoff below
	// and reused by the ordering boost (same alignment guard as the boost).
	const ocrRows =
		qt.length > 0 && l.ocrWords && l.ocrWords.length === l.filenames.length
			? l.ocrWords
			: null;

	// Adaptive cutoff: keep the top 60% of scored results. The old 5th-best
	// reference was fragile with outlier distributions — one strong match
	// defined the band and erased hundreds of honest tail results. The
	// percentile approach preserves the full distribution shape: a tight
	// cluster stays dense, a spread-out tail stays visible.
	if (scored.length > 0) {
		const cutoffRank = Math.floor(scored.length * (1 - relativeKeep));
		const cutoffScore = (
			scored[Math.min(cutoffRank, scored.length - 1)] as ScoredRow
		).score;
		const cutoff = Math.max(minScore, cutoffScore);
		// Exact OCR word matches survive the percentile cutoff: literal
		// visible text is high-precision evidence, not noise-tail filler,
		// and the ordering-only boost below can only lift rows that are
		// still present. The absolute floor still applies.
		scored = scored.filter(
			(s) =>
				s.score >= cutoff ||
				(ocrRows &&
					s.score >= minScore &&
					rankOcrWordMatch(qt, ocrRows[s.idx]) > 0),
		);
	}

	// Ordering-only word boost, AFTER the floor/cutoff: a query token that
	// appears as an exact word in a surviving row's OCR text lifts that row
	// to the front of the grid (the highlighted "it's written on the photo"
	// results the user is looking for), while the cutoff — computed on
	// natural scores — has already guaranteed the full semantic result set
	// below. Applied here, the boost reorders but can never shrink.
	if (ocrRows) {
		for (const s of scored) {
			s.score += RANK_OCR_WORD_BOOST * rankOcrWordMatch(qt, ocrRows[s.idx]);
		}
		scored.sort((a, b) => b.score - a.score);
	}

	// Classify the dominant signal for each surviving result. The dominant
	// signal is the largest contributor to the final score — this drives
	// the one-line "why it matched" badge on each card.
	for (const s of scored) {
		const ocrContrib =
			qt.length > 0
				? RANK_OCR_WORD_BOOST * rankOcrWordMatch(qt, l.ocrWords?.[s.idx])
				: 0;
		// Cast: the inner literals widen to (string|number)[] without it;
		// the cast preserves exact runtime values, only the types.
		const parts = (
			[
				["semantic", s._baseCosine],
				["phrase", s._phraseContrib],
				["filename", s._filenameContrib],
				["ocr", ocrContrib],
			] as Array<[string, number]>
		)
			.filter(([, v]) => v > 0)
			.sort((a, b) => b[1] - a[1]);
		// If the top boost is substantial relative to the base, it
		// dominated. Otherwise semantic is the honest answer.
		const topPart = parts[0];
		if (topPart && topPart[1] >= s._baseCosine * 0.5) {
			s.dominant = topPart[0];
		} else {
			s.dominant = "semantic";
		}
		s.breakdown = {
			semantic: s._baseCosine,
			phrase: s._phraseContrib,
			filename: s._filenameContrib,
			ocr: ocrContrib,
		};
	}

	// Diversity filter: drop near-duplicate photos so one scene can't
	// dominate the topK. Cap candidates at 500 so the O(cands·selected·dim)
	// scan can't blow up on a large library — anything past the top 500 is
	// already below the relative cutoff and irrelevant (C-03).
	if (scored.length > topK) {
		const selected: ScoredRow[] = [];
		const candidates = scored.length > 500 ? scored.slice(0, 500) : scored;
		for (const c of candidates) {
			if (selected.length >= topK) break;
			let tooSimilar = false;
			for (const s of selected) {
				if (
					cosineSim(
						l.embeddings[c.idx] as ArrayLike<number>,
						l.embeddings[s.idx] as ArrayLike<number>,
					) > RANK_DIVERSITY_THRESHOLD
				) {
					tooSimilar = true;
					break;
				}
			}
			if (!tooSimilar) selected.push(c);
		}
		if (selected.length >= 3) scored = selected;
	}

	return scored
		.slice(0, topK)
		.map(({ filename, score, dominant, breakdown }) => ({
			filename,
			score,
			dominant,
			breakdown,
		}));
}
