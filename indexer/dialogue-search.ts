// Exact dialogue-moment search: tiered literal matching over the
// transcript store, snippet/tier labeling for the UI, the poster
// backfill for a speech moment, and the (re)transcription backfill
// planner. Split out of transcript-store-utils.ts (2026-10-25); the
// tokenizer + fusion weights it reads live in dialogue-rank.ts.

import {
	DialogueToken,
	dialogueTokens,
	snippetAround,
} from "./dialogue-rank.ts";

// Nearest visual-segment poster for a speech moment (pure view concern —
// ranking unaffected). segVideos: Map(filename → [{t, poster}]).
export function backfillPoster(
	segVideos: unknown,
	filename: unknown,
	t: unknown,
): number {
	if (
		!(segVideos instanceof Map) ||
		typeof filename !== "string" ||
		!Number.isFinite(t)
	)
		return 0;
	const segs = segVideos.get(filename);
	if (!segs || segs.length === 0) return 0;
	// Cast: segs is non-empty here.
	let best = segs[0] as { t: unknown; poster: unknown };
	let bestD = Number.isFinite(best.t)
		? Math.abs((best.t as number) - (t as number))
		: Infinity;
	for (const sg of segs) {
		if (!Number.isFinite(sg.t)) continue;
		const d = Math.abs((sg.t as number) - (t as number));
		if (d < bestD) {
			bestD = d;
			best = sg;
		}
	}
	return Number.isFinite(best.poster) ? Number(best.poster) : 0;
}

export const EXACT_TIER_LABELS: Record<number, string> = {
	1: "Exact line",
	2: "Exact words",
	3: "Words spoken",
};

interface ExactDoc {
	t0: number;
	t1: number;
	text: string;
	toks: DialogueToken[];
	keys: string[];
}

interface ExactHit {
	filename: string;
	tier: number;
	docs: ExactDoc[];
	spanT0: number;
	spanT1: number;
	occ: number;
}

export interface ExactMoment {
	filename: string;
	score: number;
	t: number;
	dur: number;
	poster: number;
	why: string;
	tier: number;
	tierLabel: string | undefined;
	snippet: string;
	matchStart: number;
	matchLen: number;
}

// Exact dialogue search over pre-tokenized docs.
//   query — raw query text (normalized + stemmed here, same keys as docs)
//   docs  — [{filename, t0, t1, text}] (utterance lines preferred; chunks fallback)
//   segVideos — Map for poster backfill (null = poster 0)
//   topK / perVideo — caps (default 24 / 3, perVideo mirrors FUSION_SCENES_PER_VIDEO)
//   preRollSec — seek lands t0 − preRoll (clamped ≥ 0; default 3)
//   proximitySec — bag-of-words window for tier 2 (default 8)
//   snippetRadius — chars around first match (default 60)
// Tiers: 1 = contiguous key-phrase in one doc; 2 = all keys in one doc or a
// ≤proximitySec same-film window; 3 = all keys in one doc wider than the
// window (chunk fallback). 1–2 word queries require full containment (no
// fractional hits). Empty query or zero tiers → []. Throws TypeError when
// docs is not an array (never silent wrong answers).
export function exactDialogueSearch({
	query = "",
	docs = [],
	segVideos = null,
	topK = 24,
	perVideo = 3,
	preRollSec = 3,
	proximitySec = 8,
	snippetRadius = 60,
}: {
	query?: string;
	docs?: any[];
	segVideos?: Map<string, any[]> | null;
	topK?: unknown;
	perVideo?: unknown;
	preRollSec?: unknown;
	proximitySec?: unknown;
	snippetRadius?: unknown;
} = {}): ExactMoment[] {
	if (!Array.isArray(docs)) throw new TypeError("docs must be an array");
	const qKeys = dialogueTokens(query).map((t) => t.key);
	if (qKeys.length === 0) return [];
	const qSet = new Set(qKeys);
	const k = Math.max(1, Math.min(96, Number(topK) || 24));
	const perVid = Math.max(1, Math.min(24, Number(perVideo) || 3));
	const preRoll = Math.max(0, Number(preRollSec) || 0);
	const windowSec = Math.max(1, Number(proximitySec) || 8);
	const radius = Math.max(8, Number(snippetRadius) || 60);
	// Group valid docs per film, time-sorted, pre-tokenized once.
	const byFilm = new Map<string, ExactDoc[]>();
	for (const d of docs) {
		if (!d || typeof d.filename !== "string") continue;
		if (!Number.isFinite(d.t0) || !Number.isFinite(d.t1) || d.t1 <= d.t0)
			continue;
		if (typeof d.text !== "string" || d.text.trim().length === 0) continue;
		const toks = dialogueTokens(d.text);
		if (toks.length === 0) continue;
		let filmDocs = byFilm.get(d.filename);
		if (!filmDocs) {
			filmDocs = [];
			byFilm.set(d.filename, filmDocs);
		}
		filmDocs.push({
			t0: d.t0,
			t1: d.t1,
			text: d.text,
			toks,
			keys: toks.map((t) => t.key),
		});
	}
	for (const list of byFilm.values())
		list.sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
	const containsAll = (keySet: Set<string>) =>
		qKeys.every((qk) => keySet.has(qk));
	const hits: ExactHit[] = [];
	const phraseLen = qKeys.length;
	for (const [filename, list] of byFilm) {
		const keySets = list.map((d) => new Set(d.keys));
		// Tier 1: contiguous key-phrase inside one doc.
		const phraseDocs = new Set<string>();
		for (let i = 0; i < list.length; i++) {
			// Casts: i indexes list inside its bounds check (loop-bound read).
			const keys = (list[i] as ExactDoc).keys;
			let at = -1;
			for (let s = 0; s + phraseLen <= keys.length; s++) {
				let ok = true;
				for (let p = 0; p < phraseLen; p++) {
					if (keys[s + p] !== qKeys[p]) {
						ok = false;
						break;
					}
				}
				if (ok) {
					at = s;
					break;
				}
			}
			if (at < 0) continue;
			// Cast: i indexes list inside its bounds check.
			const doc = list[i] as ExactDoc;
			phraseDocs.add(`${doc.t0}:${doc.t1}`);
			hits.push(
				makeExactHit({
					filename,
					tier: 1,
					docs: [doc],
					spanT0: doc.t0,
					spanT1: doc.t1,
					occ: phraseLen,
				}),
			);
		}
		// Tier 2/3: sliding minimal windows over consecutive docs. A single
		// doc that already scored tier 1 is subsumed (same evidence, better
		// tier) — only cross-doc windows add anything there.
		for (let i = 0; i < list.length; i++) {
			// Casts: i/j index list inside their bounds checks (the loop-bound
			// read pattern).
			const docI = list[i] as ExactDoc;
			const union = new Set<string>();
			for (let j = i; j < list.length; j++) {
				const docJ = list[j] as ExactDoc;
				if (docJ.t0 - docI.t0 > windowSec && j > i) break;
				// Cast: j indexes keySets (built from list) inside its bounds.
				for (const kk of keySets[j] as Set<string>) union.add(kk);
				if (!containsAll(union)) continue;
				if (j === i && phraseDocs.has(`${docI.t0}:${docI.t1}`)) break;
				const span = docJ.t1 - docI.t0;
				const single = j === i;
				const tier = single && span > windowSec ? 3 : 2;
				let occ = 0;
				for (let m = i; m <= j; m++)
					for (const kk of (list[m] as ExactDoc).keys) if (qSet.has(kk)) occ++;
				hits.push(
					makeExactHit({
						filename,
						tier,
						docs: list.slice(i, j + 1),
						spanT0: docI.t0,
						spanT1: docJ.t1,
						occ,
					}),
				);
				break; // minimal window for this start
			}
		}
	}
	if (hits.length === 0) return [];
	// Deterministic order: tier, occurrences desc, span asc, time asc, name asc.
	hits.sort(
		(a, b) =>
			a.tier - b.tier ||
			b.occ - a.occ ||
			a.spanT1 - a.spanT0 - (b.spanT1 - b.spanT0) ||
			a.spanT0 - b.spanT0 ||
			(a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0),
	);
	// Dedupe identical (film, tier, anchor second) — overlapping windows can
	// re-anchor the same line.
	const seen = new Set<string>();
	const out: ExactMoment[] = [];
	const perVideoCount = new Map<string, number>();
	for (const h of hits) {
		const anchorSec = Math.floor(h.spanT0);
		const dkey = `${h.filename}::${h.tier}::${anchorSec}`;
		if (seen.has(dkey)) continue;
		seen.add(dkey);
		const n = perVideoCount.get(h.filename) ?? 0;
		if (n >= perVid) continue;
		perVideoCount.set(h.filename, n + 1);
		// Cast: docs is non-empty by construction (one entry per hit).
		const anchor = h.docs[0] as ExactDoc;
		const t = Math.max(0, anchor.t0 - preRoll);
		const dur = Math.max(0.5, h.spanT1 - h.spanT0);
		const snip = snippetAround(anchor.text, anchor.toks, qSet, radius);
		out.push({
			filename: h.filename,
			score:
				4 -
				h.tier +
				Math.min(h.occ, 8) * 0.01 -
				Math.min(h.spanT1 - h.spanT0, 300) * 0.0005,
			t,
			dur,
			poster: backfillPoster(segVideos, h.filename, (h.spanT0 + h.spanT1) / 2),
			why: "text",
			tier: h.tier,
			tierLabel: EXACT_TIER_LABELS[h.tier],
			snippet: snip.text,
			matchStart: snip.start,
			matchLen: snip.len,
		});
		if (out.length >= k) break;
	}
	out.sort((a, b) => b.score - a.score);
	return out;

	function makeExactHit(h: ExactHit): ExactHit {
		return h;
	}
}

// Backfill planner: which library videos need (re)transcription and from
// which slice offset. Pure (main maps filenames to {filename, path, off}):
//   filenames — library videos in order
//   videos    — sidecar Map(filename → chunks[])
//   progress  — sidecar progress map {filename: {done, total, skipped?}}
// Missing entries → off 0. Entries with progress done<total (crash or
// drop mid-film) → resume at done. Complete entries (chunks present, no
// partial progress) → skipped. Previously-stalled slice indexes ride
// `skipped` (present ONLY when non-empty, so the {filename, off} shape for
// clean entries is byte-identical to before). Never throws.
export function transcribeBackfillList(
	filenames: unknown,
	videos: unknown,
	progress: unknown,
): Array<{ filename: string; off: number; skipped?: number[] }> {
	const names = Array.isArray(filenames) ? filenames : [];
	const vids = videos instanceof Map ? videos : new Map();
	const prog =
		progress && typeof progress === "object"
			? (progress as Record<string, any>)
			: {};
	const out: Array<{ filename: string; off: number; skipped?: number[] }> = [];
	for (const name of names) {
		if (typeof name !== "string" || !name) continue;
		if (!vids.has(name)) {
			out.push({ filename: name, off: 0 });
			continue;
		}
		const p = prog[name];
		if (
			p &&
			Number.isFinite(p.done) &&
			Number.isFinite(p.total) &&
			p.done >= 0 &&
			p.done < p.total
		) {
			const entry: { filename: string; off: number; skipped?: number[] } = {
				filename: name,
				off: Math.floor(p.done),
			};
			const skipped: number[] = Array.isArray(p.skipped)
				? [
						...new Set(
							p.skipped.filter(
								(s: unknown) => Number.isInteger(s) && (s as number) >= 0,
							) as number[],
						),
					].sort((a: number, b: number) => a - b)
				: [];
			if (skipped.length > 0) entry.skipped = skipped;
			out.push(entry);
		}
	}
	return out;
}
