// Dialogue ranking: visual/text fusion, the CJK-aware dialogue
// tokenizer + Porter stemmer, and rankDialogueMoments — the pure math
// under Scenes/Dialogue moments. Split out of transcript-store-utils.ts
// (2026-10-25); exact-moment search lives in dialogue-search.ts, which
// imports the tokenizer from here.

import { CJK_RUN_RE, cjkBigramsForText } from "../shared/cjk-tokens.ts";

// Fusion weights / bucketing / caps (mirror main.ts rankers).
// Kept here so the fusion contract is unit-testable without Electron.
export const FUSION_W_VISUAL = 0.4;
export const FUSION_W_TEXT = 0.6;
export const FUSION_SLOT_SECONDS = 5;
export const FUSION_SCENES_PER_VIDEO = 3;
export const FUSION_NOISE_FRACTION = 0.25;
export const FUSION_NOISE_MIN_TOTAL = 20;
// The visual-only fraction gate below is statistically meaningless on a
// tiny corpus — with a handful of segments each one is ~10% and any
// two-shot video trips it, so small libraries get "no scene match" for
// genuine queries. Below this many visual rows the gate stands down (the
// ranking cutoff still applies). The text side keeps its strict gate at
// every size: transcript matching discriminates on small corpora and the
// dialogue honesty tests pin gibberish → [] there. Movie-heavy libraries,
// where the visual gate matters, always clear the minimum.
// Ordering-only literal boost for dialogue (mirrors RANK_OCR_WORD_BOOST):
// a query token literally spoken in the chunk lifts that moment to the
// front AFTER the cutoff — it reorders but can never shrink the set.
// 0.5 dominates the fused spread (~0.2) for full matches.
export const DIALOGUE_LITERAL_BOOST = 0.5;

// Fraction of query tokens literally present in a transcript chunk (0..1).
// Whole-word match, plus inflection-tolerant prefix match in BOTH directions
// ("love" ↔ "loves"/"loving"/"loved") for tokens of length ≥ 3 — short
// tokens stay exact-only ("ai" must not match "air"). Case-insensitive,
// punctuation-stripped, query deduped. CJK rides the shared bigrams
// (spaceless scripts have no words to split): query "멤버들의" meets a
// chunk saying 멤버들의 via [멤버,버들,들의] = 1.0. Pure + unit-tested.
export function literalFraction(query: unknown, text: unknown): number {
	const q = String(query || "");
	const qTokens = [
		...new Set([
			...q
				.toLowerCase()
				.split(/[^a-z0-9]+/)
				.filter((t) => t.length >= 2),
			...cjkBigramsForText(q),
		]),
	];
	if (qTokens.length === 0) return 0;
	const t = String(text || "");
	const words = new Set([
		...t
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((w) => w.length >= 2),
		...cjkBigramsForText(t),
	]);
	if (words.size === 0) return 0;
	let hits = 0;
	for (const tok of qTokens) {
		let found = words.has(tok);
		if (!found && tok.length >= 3) {
			for (const w of words) {
				if (w.length >= 3 && (w.startsWith(tok) || tok.startsWith(w))) {
					found = true;
					break;
				}
			}
		}
		if (found) hits++;
	}
	return hits / qTokens.length;
}

export interface VisualHit {
	filename: string;
	t: number;
	dur: number;
	poster: number;
	score: number;
	[key: string]: unknown;
}

export interface TextHit {
	filename: string;
	t: number;
	dur: number;
	snippet?: string | null;
	score: number;
	literal?: number;
	[key: string]: unknown;
}

export interface FusedMoment {
	filename: string;
	score: number;
	t: number;
	dur: number;
	poster: number;
	why: string;
	snippet: string | null;
}

interface FusionSlot {
	filename: string;
	t: number;
	visual: number;
	text: number;
	literal: number;
	poster: number;
	dur: number;
	snippet: string | null;
}

// Fuse pre-scored visual + transcript hits into ranked moments.
// Pure + deterministic (no embeddings, no fs, no Electron).
//
// visualHits: [{filename, t, dur, poster, score}] (already ≥ minScore)
// textHits:   [{filename, t, dur, snippet, score}] (already ≥ minScore)
// segVideos:  Map(filename → [{t, poster}]) for text-only poster backfill
//             (null/undefined = skip backfill, poster stays 0).
// visualTotal / textTotal: total rows scored per side (for noise gates).
// Returns [{filename, score, t, dur, poster, why, snippet}] sorted desc,
// capped per-video + topK, cut at max(minScore, top*relativeKeep).
// Gibberish floods (both sides hot everywhere) → [].
export function fuseVisualTextMoments({
	visualHits = [],
	textHits = [],
	segVideos = null,
	visualTotal = 0,
	textTotal = 0,
	minScore = 0.04,
	relativeKeep = 0.6,
	topK = 24,
	wVisual = FUSION_W_VISUAL,
	wText = FUSION_W_TEXT,
	slotSeconds = FUSION_SLOT_SECONDS,
	scenesPerVideo = FUSION_SCENES_PER_VIDEO,
	noiseFraction = FUSION_NOISE_FRACTION,
}: {
	visualHits?: any[];
	textHits?: any[];
	segVideos?: Map<string, any[]> | null;
	visualTotal?: unknown;
	textTotal?: unknown;
	minScore?: number;
	relativeKeep?: number;
	topK?: unknown;
	wVisual?: number;
	wText?: number;
	slotSeconds?: unknown;
	scenesPerVideo?: number;
	noiseFraction?: number;
} = {}): FusedMoment[] {
	const k = Math.max(1, Math.min(96, Number(topK) || 24));
	const slot = Math.max(1, Number(slotSeconds) || FUSION_SLOT_SECONDS);
	const vHits = Array.isArray(visualHits) ? visualHits : [];
	const tHits = Array.isArray(textHits) ? textHits : [];
	if (vHits.length === 0 && tHits.length === 0) return [];
	const slots = new Map<string, FusionSlot>();
	const slotKey = (filename: string, t: number) =>
		`${filename}::${Math.floor(t / slot)}`;
	for (const h of vHits) {
		if (
			!h ||
			typeof h.filename !== "string" ||
			!Number.isFinite(h.t) ||
			!Number.isFinite(h.score)
		)
			continue;
		const key = slotKey(h.filename, h.t);
		let s = slots.get(key);
		if (!s) {
			s = {
				filename: h.filename,
				t: h.t,
				visual: 0,
				text: 0,
				literal: 0,
				poster: Number.isFinite(h.poster) ? h.poster : 0,
				dur: Number.isFinite(h.dur) && h.dur > 0 ? h.dur : 0.5,
				snippet: null,
			};
			slots.set(key, s);
		}
		if (h.score > s.visual) {
			s.visual = h.score;
			s.t = h.t;
			s.poster = Number.isFinite(h.poster) ? h.poster : s.poster;
			if (Number.isFinite(h.dur) && h.dur > 0) s.dur = h.dur;
		}
	}
	for (const h of tHits) {
		if (
			!h ||
			typeof h.filename !== "string" ||
			!Number.isFinite(h.t) ||
			!Number.isFinite(h.score)
		)
			continue;
		const key = slotKey(h.filename, h.t);
		let s = slots.get(key);
		if (!s) {
			s = {
				filename: h.filename,
				t: h.t,
				visual: 0,
				text: 0,
				literal: 0,
				poster: 0,
				dur: Number.isFinite(h.dur) && h.dur > 0 ? h.dur : 0.5,
				snippet: null,
			};
			slots.set(key, s);
		}
		const lit =
			Number.isFinite(h.literal) && h.literal > 0 ? Math.min(1, h.literal) : 0;
		if (h.score > s.text) {
			s.text = h.score;
			s.literal = lit;
			if (!s.snippet && typeof h.snippet === "string" && h.snippet.length > 0)
				s.snippet = h.snippet;
			if (s.visual === 0) {
				s.t = h.t;
				if (Number.isFinite(h.dur) && h.dur > 0) s.dur = h.dur;
			}
		} else if (lit > s.literal) {
			s.literal = lit;
			if (
				!s.snippet &&
				typeof h.snippet === "string" &&
				h.snippet.length > 0 &&
				s.text > 0
			)
				s.snippet = h.snippet;
		} else if (
			!s.snippet &&
			typeof h.snippet === "string" &&
			h.snippet.length > 0 &&
			s.text > 0
		) {
			// Keep first snippet when a weaker text hit arrives second.
		}
	}
	// Text-only slots need a poster: nearest visual segment poster in the
	// same video (pure view concern; ranking unaffected). (The pre-conversion
	// `s.poster !== undefined` check is dead — poster is always a number:
	// initialized 0 or set from a finite value.)
	if (segVideos instanceof Map) {
		for (const s of slots.values()) {
			if (s.poster !== 0) continue;
			const segs = segVideos.get(s.filename);
			if (!segs || segs.length === 0) {
				s.poster = 0;
				continue;
			}
			let best = segs[0];
			let bestD = Math.abs(segs[0].t - s.t);
			for (const sg of segs) {
				if (!Number.isFinite(sg.t)) continue;
				const d = Math.abs(sg.t - s.t);
				if (d < bestD) {
					bestD = d;
					best = sg;
				}
			}
			s.poster = Number.isFinite(best.poster) ? best.poster : 0;
		}
	}
	const fused = [...slots.values()].map((s) => ({
		...s,
		score: wVisual * s.visual + wText * s.text,
		why: s.visual > 0 && s.text > 0 ? "both" : s.text > 0 ? "text" : "visual",
	}));
	fused.sort((a, b) => b.score - a.score);
	if (fused.length === 0) return [];
	// Cast: fused is non-empty here.
	const cutoff = Math.max(
		minScore,
		(fused[0] as { score: number }).score * relativeKeep,
	);
	// Literal spoken evidence IS discriminative evidence (the query's words
	// were literally uttered in that moment — same philosophy as the OCR
	// word boost and the scene-evidence gate): when any surviving candidate
	// carries it, the fraction gate stands down. Gibberish (zero literals
	// anywhere) still faces the gate and still returns [].
	const hasLiteralEvidence = fused.some(
		(f) => f.score >= cutoff && f.literal > 0,
	);
	const vTotal = Math.max(0, Number(visualTotal) || 0);
	const tTotal = Math.max(0, Number(textTotal) || 0);
	if (!hasLiteralEvidence) {
		if (vTotal > 0 && tTotal > 0) {
			let vAbove = 0;
			for (const h of vHits)
				if (h && Number.isFinite(h.score) && h.score >= cutoff) vAbove++;
			let tAbove = 0;
			for (const h of tHits)
				if (h && Number.isFinite(h.score) && h.score >= cutoff) tAbove++;
			if (
				vAbove / Math.max(1, vTotal) > noiseFraction &&
				tAbove / Math.max(1, tTotal) > noiseFraction
			) {
				return [];
			}
		} else if (vTotal > 0) {
			let vAbove = 0;
			for (const h of vHits)
				if (h && Number.isFinite(h.score) && h.score >= cutoff) vAbove++;
			if (
				vTotal >= FUSION_NOISE_MIN_TOTAL &&
				vAbove / Math.max(1, vTotal) > noiseFraction
			)
				return [];
		} else if (tTotal > 0) {
			let tAbove = 0;
			for (const h of tHits)
				if (h && Number.isFinite(h.score) && h.score >= cutoff) tAbove++;
			if (tAbove / Math.max(1, tTotal) > noiseFraction) return [];
		}
	}
	const perVideo = new Map<string, number>();
	const hits: FusedMoment[] = [];
	for (const f of fused) {
		if (f.score < cutoff) break;
		const seen = perVideo.get(f.filename) ?? 0;
		if (seen >= scenesPerVideo) continue;
		perVideo.set(f.filename, seen + 1);
		hits.push({
			filename: f.filename,
			// Ordering-only literal boost, applied AFTER the cutoff (same
			// contract as RANK_OCR_WORD_BOOST): a literally-spoken moment
			// leads the grid but the boost can never shrink the set.
			// Zero for visual-only callers (no literal field) — their
			// scores are byte-identical to before.
			score: f.score + DIALOGUE_LITERAL_BOOST * (f.literal > 0 ? f.literal : 0),
			t: f.t,
			dur: f.dur,
			poster: f.poster,
			why: f.why,
			snippet: f.snippet,
		});
		if (hits.length >= k) break;
	}
	hits.sort((a, b) => b.score - a.score);
	return hits;
}

// Attach the centered query vector to a results array WITHOUT changing its
// shape (M-11 single round-trip). Structured clone preserves own props on
// arrays, so `Array.isArray()` stays true for every existing consumer (perf
// battery, search-matrix diagnostics, older renderers) while new callers
// read `.queryVec`. Non-array input → empty array (never throws).
export function attachQueryVec(results: unknown, queryVec: unknown): any[] {
	const out: any = Array.isArray(results) ? results : [];
	out.queryVec = queryVec || null;
	return out;
}

// Apply one transcribed+embedded reply chunk to the sidecar store — the exact
// commit path pumpTranscription runs in production, extracted pure so the

export function cosineVec(a: ArrayLike<number>, b: ArrayLike<number>) {
	let dot = 0;
	let na = 0;
	let nb = 0;
	// Casts: dense parallel vectors (the loop-bound read pattern).
	for (let i = 0; i < a.length; i++) {
		dot += (a[i] as number) * (b[i] as number);
		na += (a[i] as number) * (a[i] as number);
		nb += (b[i] as number) * (b[i] as number);
	}
	return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Rank dialogue moments from pre-embedded items — the exact scoring
// main.ts rankTranscriptMoments runs, extracted pure so the full ranking
// (cosine → literal → fuse → boost → gate → caps) is unit-testable with
// REAL tower vectors and no Electron:
//   qVec  — centered query vector (Float32Array)
//   items — [{filename, t0, t1, text, vec}] (vecs centered, same dim)
//   query — raw query text (for literalFraction)
// Returns fuseVisualTextMoments hits (text-only). Throws TypeError on bad
// shapes (never silent wrong answers).
export function rankDialogueMoments({
	qVec,
	items = [],
	segVideos = null,
	minScore = 0.04,
	relativeKeep = 0.6,
	topK = 24,
	query = "",
}: {
	qVec?: ArrayLike<number> | null;
	items?: any[];
	segVideos?: Map<string, any[]> | null;
	minScore?: number;
	relativeKeep?: number;
	topK?: unknown;
	query?: string;
} = {}): FusedMoment[] {
	if (!qVec || typeof qVec.length !== "number" || qVec.length === 0) {
		throw new TypeError("qVec must be a non-empty vector");
	}
	if (!Array.isArray(items)) throw new TypeError("items must be an array");
	const k = Math.max(1, Math.min(96, Number(topK) || 24));
	const textHits: TextHit[] = [];
	for (const it of items) {
		if (
			!it ||
			typeof it.filename !== "string" ||
			!(it.vec && it.vec.length === qVec.length)
		)
			continue;
		if (!Number.isFinite(it.t0) || !Number.isFinite(it.t1) || it.t1 <= it.t0)
			continue;
		if (typeof it.text !== "string" || it.text.trim().length === 0) continue;
		const sc = cosineVec(qVec, it.vec);
		if (sc >= minScore) {
			const mid = (it.t0 + it.t1) / 2;
			textHits.push({
				filename: it.filename,
				t: mid,
				dur: Math.max(0.5, it.t1 - it.t0),
				snippet: it.text.slice(0, 80) || null,
				literal: literalFraction(query, it.text),
				score: sc,
			});
		}
	}
	textHits.sort((a, b) => b.score - a.score);
	if (textHits.length > k * 8) textHits.length = k * 8;
	if (textHits.length === 0) return [];
	return fuseVisualTextMoments({
		visualHits: [],
		textHits,
		segVideos,
		visualTotal: 0,
		textTotal: items.length,
		minScore,
		relativeKeep,
		topK: k,
		wVisual: FUSION_W_VISUAL,
		wText: FUSION_W_TEXT,
		slotSeconds: FUSION_SLOT_SECONDS,
		scenesPerVideo: FUSION_SCENES_PER_VIDEO,
		noiseFraction: FUSION_NOISE_FRACTION,
	});
}

// ---------------------------------------------------------------------------
// Exact dialogue search (v3): literal spoken-word retrieval — no vectors, no
// thresholds, no model. The query's normalized+stemmed tokens must actually
// occur in the transcript; tiers rank phrase > proximity > scattered-AND.
// CJK text tokenizes to overlapping bigrams (shared spec), so the same tier
// logic serves Korean/Japanese/Chinese dialogue. Pure + deterministic;
// main.ts rankTranscriptMoments calls it with utterance lines when present
// (precise seek) else chunk rows (coarse seek).
// ---------------------------------------------------------------------------

// Comparison key for one raw token: NFKD fold → lowercase → stem → trailing-e
// fold (len≥4). The e-fold merges inflection pairs Porter splits
// ("love"/"loving" → "lov") while keeping distinct roots apart
// ("car" vs "carpet" never merge — neither gains/loses a trailing e to meet).
// Returns "" for noise (len<2 after cleaning).
export function dialogueKey(raw: unknown): string {
	const clean = String(raw || "")
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");
	if (clean.length < 2) return "";
	let stem = /^[a-z]+$/.test(clean) ? porterStem(clean) : clean;
	// Porter wart fix: "flies"→"fli" but "flying"/"fly"→"fly", so inflections
	// of the same word land on different keys. Folding a trailing i→y
	// (len≥3) reunites them (fli→fly) and also city/cities, ski/sky.
	if (stem.length >= 3 && stem.endsWith("i")) stem = stem.slice(0, -1) + "y";
	if (stem.length >= 4 && stem.endsWith("e")) return stem.slice(0, -1);
	return stem;
}

export interface DialogueToken {
	raw: string;
	key: string;
	start: number;
	end: number;
}

// Tokenize text into [{raw, key, start, end}] in order (raw offsets into the
// original string for snippet highlighting). Punctuation/diacritics folded by
// dialogueKey; noise tokens dropped.
//
// Two passes, merged by position:
//   1. Latin words via the original regex (dialogueKey normalization).
//   2. CJK runs (Han/Hiragana/Katakana/Hangul) via the shared rune class —
//      spaceless scripts cannot ride word splitting ("멤버들의" is one
//      whitespace token but searchable units are the overlapping bigrams
//      멤버/버들/들의, same rule as rankTokens/cjkBigramsForText in
//      shared/). Keys stay byte-identical to the raw bigram (no stemming).
//      A single-char run stays as-is (a lone 駅/酒 is meaningful) — which
//      also means a single-char CJK QUERY only matches a lone run, exactly
//      like grid search (documented shared-spec behavior, not a bug).
// Offsets are code-unit based (ragel: astral Han chars are 2 units) and
// always satisfy src.slice(start, end) === raw.
export function dialogueTokens(text: unknown): DialogueToken[] {
	const src = String(text || "");
	const out: DialogueToken[] = [];
	const re = /[A-Za-z0-9\u00c0-\u024f]+/g;
	let m;
	while ((m = re.exec(src)) !== null) {
		const key = dialogueKey(m[0]);
		if (key)
			out.push({ raw: m[0], key, start: m.index, end: m.index + m[0].length });
	}
	// CJK pass: code-point iteration keeps code-unit offsets right for
	// astral characters (for..of walks code points, .length code units).
	CJK_RUN_RE.lastIndex = 0;
	let run;
	while ((run = CJK_RUN_RE.exec(src)) !== null) {
		const chars: Array<{ ch: string; at: number }> = [];
		let at = run.index;
		for (const ch of run[0]) {
			chars.push({ ch, at });
			at += ch.length;
		}
		if (chars.length === 1) {
			// Cast: length === 1 checked.
			const only = chars[0] as { ch: string; at: number };
			out.push({
				raw: only.ch,
				key: only.ch,
				start: only.at,
				end: only.at + only.ch.length,
			});
			continue;
		}
		for (let i = 0; i < chars.length - 1; i++) {
			// Casts: i and i+1 < chars.length by the loop bound.
			const a = chars[i] as { ch: string; at: number };
			const b = chars[i + 1] as { ch: string; at: number };
			out.push({
				raw: a.ch + b.ch,
				key: a.ch + b.ch,
				start: a.at,
				end: b.at + b.ch.length,
			});
		}
	}
	// Latin and CJK rune classes are disjoint, so equal starts cannot
	// happen; the sort is a positional merge for snippetAround's scan.
	out.sort((a, b) => a.start - b.start || a.end - b.end);
	return out;
}

// Compact Porter stemmer (steps 1a–5, deterministic, ASCII a-z only).
// Vendored (~no dep) so index-time and query-time stemming are byte-identical.
export function porterStem(w: string): string {
	if (w.length < 3) return w;
	// Casts: single-char string indexes — the bounds are checked by the
	// callers (or the char class test is the guard).
	const isCons = (s: string, i: number): boolean => {
		const c = s[i] as string;
		if ("aeiou".includes(c)) return false;
		if (c === "y") return i === 0 ? true : !isCons(s, i - 1);
		return true;
	};
	const measure = (s: string) => {
		let m = 0;
		let i = 0;
		while (i < s.length && isCons(s, i)) i++;
		while (i < s.length) {
			while (i < s.length && !isCons(s, i)) i++;
			if (i >= s.length) break;
			m++;
			while (i < s.length && isCons(s, i)) i++;
		}
		return m;
	};
	const hasVowel = (s: string) => [...s].some((_, i) => !isCons(s, i));
	const endsDouble = (s: string) =>
		s.length >= 2 &&
		s[s.length - 1] === s[s.length - 2] &&
		isCons(s, s.length - 1);
	const cvc = (s: string) =>
		s.length >= 3 &&
		isCons(s, s.length - 3) &&
		!isCons(s, s.length - 2) &&
		isCons(s, s.length - 1) &&
		!"wxy".includes(s[s.length - 1] as string);
	let s = w;
	// Step 1a
	if (s.endsWith("sses")) s = s.slice(0, -2);
	else if (s.endsWith("ies")) s = s.slice(0, -2);
	else if (s.endsWith("ss")) {
		/* keep */
	} else if (s.endsWith("s")) s = s.slice(0, -1);
	// Step 1b
	let flag1b = false;
	if (s.endsWith("eed")) {
		if (measure(s.slice(0, -3)) > 0) s = s.slice(0, -1);
	} else if (s.endsWith("ed") && hasVowel(s.slice(0, -2))) {
		s = s.slice(0, -2);
		flag1b = true;
	} else if (s.endsWith("ing") && hasVowel(s.slice(0, -3))) {
		s = s.slice(0, -3);
		flag1b = true;
	}
	if (flag1b) {
		if (s.endsWith("at") || s.endsWith("bl") || s.endsWith("iz")) s += "e";
		else if (endsDouble(s) && !"lsz".includes(s[s.length - 1] as string))
			s = s.slice(0, -1);
		else if (measure(s) === 1 && cvc(s)) s += "e";
	}
	// Step 1c
	if (s.endsWith("y") && hasVowel(s.slice(0, -1))) s = s.slice(0, -1) + "i";
	// Step 2
	const step2: Record<string, string> = {
		ational: "ate",
		tional: "tion",
		enci: "ence",
		anci: "ance",
		izer: "ize",
		bli: "ble",
		alli: "al",
		entli: "ent",
		eli: "e",
		ousli: "ous",
		ization: "ize",
		ation: "ate",
		ator: "ate",
		alism: "al",
		iveness: "ive",
		fulness: "ful",
		ousness: "ous",
		aliti: "al",
		iviti: "ive",
		biliti: "ble",
		logi: "log",
	};
	for (const [suf, rep] of Object.entries(step2)) {
		if (s.endsWith(suf) && measure(s.slice(0, -suf.length)) > 0) {
			s = s.slice(0, -suf.length) + rep;
			break;
		}
	}
	// Step 3
	const step3: Record<string, string> = {
		icate: "ic",
		ative: "",
		alize: "al",
		iciti: "ic",
		ical: "ic",
		ful: "",
		ness: "",
	};
	for (const [suf, rep] of Object.entries(step3)) {
		if (s.endsWith(suf) && measure(s.slice(0, -suf.length)) > 0) {
			s = s.slice(0, -suf.length) + rep;
			break;
		}
	}
	// Step 4
	for (const suf of [
		"al",
		"ance",
		"ence",
		"er",
		"ic",
		"able",
		"ible",
		"ant",
		"ement",
		"ment",
		"ent",
		"ion",
		"ou",
		"ism",
		"ate",
		"iti",
		"ous",
		"ive",
		"ize",
	]) {
		if (!s.endsWith(suf)) continue;
		const base = s.slice(0, -suf.length);
		if (measure(base) <= 1) continue;
		if (suf === "ion" && !"st".includes(base[base.length - 1] as string))
			continue;
		s = base;
		break;
	}
	// Step 5a/5b
	if (s.endsWith("e")) {
		const base = s.slice(0, -1);
		const m = measure(base);
		if (m > 1 || (m === 1 && !cvc(base))) s = base;
	}
	if (endsDouble(s) && s.endsWith("l") && measure(s) > 1) s = s.slice(0, -1);
	return s;
}

// Snippet around the first query-key occurrence in one doc's text:
// ±radius chars with … ellipsis; matchStart/matchLen locate the hit for UI
// highlight (0/0 when nothing found — never happens for real hits).
export function snippetAround(
	text: unknown,
	toks: DialogueToken[],
	qSet: Set<string>,
	radius: number,
): { text: string; start: number; len: number } {
	const src = String(text || "");
	let hit: DialogueToken | null = null;
	for (const t of toks) {
		if (qSet.has(t.key)) {
			hit = t;
			break;
		}
	}
	if (!hit) return { text: src.slice(0, radius * 2), start: 0, len: 0 };
	// Extend the highlight span across adjacent matching tokens so a
	// multi-bigram CJK word ("멤버들의" → 멤버/버들/들의) underlines as one
	// word, not one bigram. CJK bigrams OVERLAP (버들 starts inside 멤버),
	// so continuation means "touches the covered span and pushes it
	// forward"; a gap (punctuation/space) or a non-matching key stops it.
	const at = toks.indexOf(hit);
	const h = hit;
	let lo = h.start;
	let hi = h.end;
	for (let j = at - 1; j >= 0; j--) {
		// Cast: j indexes toks inside its bounds check.
		const p = toks[j] as DialogueToken;
		if (!qSet.has(p.key) || p.end < lo || p.start >= lo) break;
		lo = p.start;
	}
	for (let j = at + 1; j < toks.length; j++) {
		// Cast: j indexes toks inside its bounds check.
		const n = toks[j] as DialogueToken;
		if (!qSet.has(n.key) || n.start > hi || n.end <= hi) break;
		hi = n.end;
	}
	const from = Math.max(0, lo - radius);
	const to = Math.min(src.length, hi + radius);
	let snippet = src.slice(from, to);
	if (from > 0) snippet = "…" + snippet;
	if (to < src.length) snippet = snippet + "…";
	return {
		text: snippet,
		start: lo - from + (from > 0 ? 1 : 0),
		len: hi - lo,
	};
}
