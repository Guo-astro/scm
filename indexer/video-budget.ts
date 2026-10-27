// Duration-aware segment budgeting (Phase 4, long-movie coverage) and the
// Settings → Video search quality presets. Pure planning math — no fs, no
// processes — so test/planning splits are seconds-fast unit tests. Split
// out of video-utils.ts (2026-10-25); the ffmpeg layer it plans for lives
// in ffmpeg-process.ts, the detection pipeline in scene-detect.ts.

import { EDGE_MARGIN } from "./ffmpeg-process.ts";

// Duration-aware segment budget (Phase 4, long-movie coverage): one
// searchable point per ~30 s of film, floored at 8 for short clips and
// capped at 128 so worst-case enrichment cost stays bounded even for a
// 3-hour feature. The old flat 32 left the final act of a long film with
// zero coverage (front-biased shot slice) or a ~3-minute search window.
//
// User-adjustable via the Settings → Video search quality preset (see
// VIDEO_QUALITY_PRESETS): the preset only changes the (target, min, max)
// triple below — the planning math is identical. The legacy constants are
// the `balanced` preset's values, kept so existing callers and tests keep
// working unmodified.
export const SEGMENT_TARGET_SECONDS = 30;
export const MIN_SEGMENTS = 8;
export const MAX_SEGMENTS = 128;

export interface BudgetOpts {
	targetSeconds: number;
	minSegments: number;
	maxSegments: number;
}

// Video search quality presets (Settings → Video search). Each preset is a
// (target, min, max) triple for the duration-aware budget: one searchable
// point per `targetSeconds` of film, floored at `minSegments` for short
// clips and capped at `maxSegments` so worst-case enrichment cost
// (ffmpeg passes + CLIP embeds + scene posters + segment-bin rows) stays
// bounded. Cost scales ~linearly with the segment count, which is why the
// UI offers presets instead of a raw slider.
export const VIDEO_QUALITY_PRESETS: Record<string, BudgetOpts> = {
	eco: { targetSeconds: 60, minSegments: 4, maxSegments: 32 },
	balanced: { targetSeconds: 30, minSegments: 8, maxSegments: 128 },
	detailed: { targetSeconds: 15, minSegments: 12, maxSegments: 256 },
	// Maximum recall: one point per 5 s, up to 1024 segments. ~4x the
	// detailed cost at the extreme (a 90-min film caps at 1024: ~4 MB of
	// segment-bin rows plus ~50 MB of scene posters for that one video),
	// so this is opt-in only.
	ultra: { targetSeconds: 5, minSegments: 16, maxSegments: 1024 },
	// Ultra Pro (fifth rung): twice Ultra's density (one point per 2.5 s)
	// with the ceiling doubled to match. Sized for the feature-length case
	// where Ultra thins worst: full 2.5 s density holds to ~85 min, a 90-min
	// film caps at 2048 (~1 pt / 2.6 s), a 2 h film at ~1 pt / 3.5 s. Cost is
	// exactly 2x Ultra at the extreme (2048 segments ≈ ~100 MB of scene
	// posters + ~4 MB of segment-bin rows; MEASURED 2026-09-11 at ~6 min of
	// enrichment per capped film — see MDs/Ultra-Pro-Plan.md §3.1 correction;
	// the old ~1.7–2.8 h here was the LFM-caption misread) — opt-in only, and
	// the Settings sheet shows the per-library bill before committing (cost
	// line + one-time confirm). Design + cost math: MDs/Ultra-Pro-Plan.md.
	ultraPro: { targetSeconds: 2.5, minSegments: 24, maxSegments: 2048 },
};
export const VIDEO_QUALITY_IDS: string[] = Object.keys(VIDEO_QUALITY_PRESETS);
export const DEFAULT_VIDEO_QUALITY = "balanced";

// Parse a stored/raw value into a valid preset id; anything else → the
// default. Mirrors the parse-then-fallback pattern of the renderer's
// preference libs so a hand-edited settings.json can never break planning.
export function parseVideoQuality(raw: unknown): string {
	// Own-property check: a plain record lookup treats inherited keys
	// ("constructor", "__proto__", "toString") as truthy, while the
	// renderer's id whitelist rejects them. Both sides must agree — see
	// test/video-quality.test.ts.
	return typeof raw === "string" &&
		Object.prototype.hasOwnProperty.call(VIDEO_QUALITY_PRESETS, raw)
		? raw
		: DEFAULT_VIDEO_QUALITY;
}

// The (target, min, max) triple for a preset id (unknown → default).
export function budgetForQuality(quality: unknown): BudgetOpts {
	const preset =
		typeof quality === "string" &&
		Object.prototype.hasOwnProperty.call(VIDEO_QUALITY_PRESETS, quality)
			? VIDEO_QUALITY_PRESETS[quality]
			: undefined;
	return (
		preset ||
		// Cast: the default id is always present in the presets record.
		(VIDEO_QUALITY_PRESETS[DEFAULT_VIDEO_QUALITY] as BudgetOpts)
	);
}

// The segment budget for a video of `durationSeconds` (0/unknown → the
// floor). Bounded by min..max; shared by the shot and the
// interval paths so a long film gets end-to-end coverage at a constant
// worst-case cost. `budgetOpts` overrides the balanced triple, e.g. a
// VIDEO_QUALITY_PRESETS entry; omitted → legacy behavior exactly.
export function segmentBudgetFor(
	durationSeconds: number | null,
	budgetOpts: Partial<BudgetOpts> | null = null,
) {
	const target = Number(budgetOpts?.targetSeconds) || SEGMENT_TARGET_SECONDS;
	const min = Number(budgetOpts?.minSegments) || MIN_SEGMENTS;
	const max = Number(budgetOpts?.maxSegments) || MAX_SEGMENTS;
	// Runtime note: null fails the > 0 probe exactly like 0/negative did
	// pre-conversion; the explicit null check narrows for the math below.
	if (durationSeconds === null || !(durationSeconds > 0)) return min;
	return Math.max(min, Math.min(max, Math.ceil(durationSeconds / target)));
}

// Phase 5, uniform TIME coverage: when a film has more shots than the
// segment budget, keep one shot per (duration / budget) slice — the nearest
// shot midpoint to each slice center — so a long film is searchable from
// its first act to its last (the old front-biased slice(0, 32) left the
// final act with zero coverage). Pure + deterministic for unit tests.
export function sampleShotsEvenly(
	shots: Array<{ t: number; dur: number }>,
	duration: number,
	budget: number,
) {
	const slot = duration / budget;
	const used = new Set<number>();
	const plan: Array<{ t: number; dur: number }> = [];
	for (let i = 0; i < budget; i++) {
		const target = slot * i + slot / 2;
		let best = -1;
		let bestDist = Infinity;
		for (let j = 0; j < shots.length; j++) {
			if (used.has(j)) continue;
			// Cast: j indexes shots by construction.
			const d = Math.abs((shots[j] as { t: number }).t - target);
			if (d < bestDist) {
				bestDist = d;
				best = j;
			}
		}
		if (best >= 0) {
			used.add(best);
			// Cast: best indexes shots by construction.
			plan.push(shots[best] as { t: number; dur: number });
		}
	}
	return plan.sort((a, b) => a.t - b.t);
}

// Phase 5 interval fallback: subdivide a boundary-less film into `budget`
// equal slices and embed each slice's midpoint.
export function buildIntervalPlan(duration: number, budget: number) {
	const seg = duration / budget;
	const plan: Array<{ t: number; dur: number }> = [];
	for (let i = 0; i < budget; i++) {
		plan.push({ t: i * seg + seg / 2, dur: seg });
	}
	return plan;
}

// Cap + clamp: a seek past the real end makes ffmpeg fail or emit a black
// frame, and extraction is what actually consumes `t`. Floor shot spans at
// half a second so degenerate zero-length shots stay embeddable.
export function clampPlan(
	plan: Array<{ t: number; dur: number }>,
	duration: number | null,
) {
	const end = Math.max(0, (duration ?? 0) - EDGE_MARGIN);
	for (const seg of plan) {
		seg.t = Math.max(0, Math.min(end > 0 ? end : seg.t, seg.t));
		if (seg.dur < 0.5) seg.dur = 0.5;
	}
	return plan;
}
