// Scene segmentation (Phase 1 of scene search, see DESIGN-SCENE-SEARCH.md):
// the detect pipeline (config knobs, ffmpeg filter/args assembly, stderr
// parsing, HW-accel probing) plus its execution — detectScenes, boundary
// refinement and segment-plan building. Split out of video-utils.ts
// (2026-10-25); the ffmpeg process layer lives in ffmpeg-process.ts, the
// budget math in video-budget.ts.

import path from "node:path";
import * as detectCache from "./detect-cache.ts";
import { spawnFfmpeg, probeDuration } from "./ffmpeg-process.ts";
import {
	type BudgetOpts,
	segmentBudgetFor,
	sampleShotsEvenly,
	buildIntervalPlan,
	clampPlan,
} from "./video-budget.ts";

// ---------------------------------------------------------------------------
// Scene segmentation (Phase 1 of scene search, see DESIGN-SCENE-SEARCH.md).
// ---------------------------------------------------------------------------

// Scene-change threshold for the ffmpeg `scene` filter (0–1; higher = fewer
// detections). The ffmpeg-docs default for hard cuts; a knob for real-footage
// tuning (SCENE_THRESHOLD).
export const SCENE_THRESHOLD = 0.3;

// Phase 1 detect configuration (Inference-MLX-Speed-Master-Plan-A §Phase 1).
// Defaults preserve the historical software 360p / full-rate / 0.3 contract
// so existing plans stay comparable; each knob is opt-in via opts or env.
//
//   SCM_DETECT_HWACCEL     auto | videotoolbox | software   (default software)
//   SCM_DETECT_HEIGHT      360 | 180 | …                    (default 360)
//   SCM_DETECT_FPS         0 (off) | 10 | …                 (default 0)
//   SCM_DETECT_THRESHOLD   0..1                             (default 0.3)
//   SCM_DETECT_KEYFRAME    0 | 1  — I-frame coarse + refine (default 0)
//   SCM_DETECT_CACHE       0 | 1  — per-file plan cache     (default 1 when cacheDir set)
//
// 2026-09-25 measurement (MDs/bench-detect/detect-2026-09-25.json):
// VideoToolbox + select=scene is ~5x SLOWER than software on the reference
// M1 (plain -hwaccel downloads after decode; -hwaccel_output_format +
// hwdownload fails to convert for this filter graph). Phase 1.1 is therefore
// NOT the default — software stays on. The wins that did measure:
//   height=180 + fps=10  ≈ 1.24x
//   per-file detect cache  ≈ 900x on re-import (hot)
const DEFAULT_DETECT_HEIGHT = 360;
const DEFAULT_DETECT_FPS = 0;
const DEFAULT_DETECT_HWACCEL = "software";
// Coarse keyframe pass + local refine (Phase 1.3).
const KEYFRAME_REFINE_WINDOW_S = 2.0;
const DETECT_HWACCEL_MODES = new Set([
	"auto",
	"videotoolbox",
	"software",
	"off",
	"none",
]);

function envInt(name: string, fallback: number) {
	const raw = process.env[name];
	if (raw == null || raw === "") return fallback;
	const n = Number(raw);
	return Number.isFinite(n) ? n : fallback;
}

function envFlag(name: string, fallback: boolean) {
	const raw = process.env[name];
	if (raw == null || raw === "") return fallback;
	if (
		raw === "1" ||
		raw.toLowerCase() === "true" ||
		raw.toLowerCase() === "yes"
	)
		return true;
	if (
		raw === "0" ||
		raw.toLowerCase() === "false" ||
		raw.toLowerCase() === "no"
	)
		return false;
	return fallback;
}

interface DetectOpts {
	hwaccel?: unknown;
	height?: unknown;
	fps?: unknown;
	threshold?: unknown;
	keyframe?: unknown;
	cache?: unknown;
	cacheDir?: string | null;
	hwaccelOutputFormat?: unknown;
}

export interface DetectOptions {
	hwaccel: string;
	height: number;
	fps: number;
	threshold: number;
	keyframe: boolean;
	cache: boolean;
	cacheDir: string | null;
	hwaccelOutputFormat: boolean;
}

// Normalize detect options from callers + environment. Pure; unit-tested.
export function resolveDetectOptions(opts: DetectOpts = {}): DetectOptions {
	const hwRaw = String(
		opts.hwaccel ?? process.env.SCM_DETECT_HWACCEL ?? DEFAULT_DETECT_HWACCEL,
	).toLowerCase();
	const hwaccel = DETECT_HWACCEL_MODES.has(hwRaw) ? hwRaw : "auto";
	const height = Math.max(
		32,
		Math.min(
			2160,
			Number(opts.height ?? envInt("SCM_DETECT_HEIGHT", DEFAULT_DETECT_HEIGHT)),
		),
	);
	const fps = Math.max(
		0,
		Math.min(
			120,
			Number(opts.fps ?? envInt("SCM_DETECT_FPS", DEFAULT_DETECT_FPS)),
		),
	);
	const threshold =
		Number.isFinite(opts.threshold) &&
		(opts.threshold as number) > 0 &&
		(opts.threshold as number) <= 1
			? Number(opts.threshold)
			: Number.isFinite(Number(process.env.SCM_DETECT_THRESHOLD)) &&
				  Number(process.env.SCM_DETECT_THRESHOLD) > 0 &&
				  Number(process.env.SCM_DETECT_THRESHOLD) <= 1
				? Number(process.env.SCM_DETECT_THRESHOLD)
				: SCENE_THRESHOLD;
	const keyframe = Boolean(
		opts.keyframe ?? envFlag("SCM_DETECT_KEYFRAME", false),
	);
	const useCache = Boolean(opts.cache ?? envFlag("SCM_DETECT_CACHE", true));
	const cacheDir = opts.cacheDir || process.env.SCM_DETECT_CACHE_DIR || null;
	// Keep hw frames on the GPU and hwdownload inside the filter (Phase 1.1
	// risk check). Default false: plain -hwaccel videotoolbox downloads after
	// decode and is the safer first try for select=scene.
	const hwOutputFormat = Boolean(
		opts.hwaccelOutputFormat ?? envFlag("SCM_DETECT_HW_OUTPUT_FORMAT", false),
	);
	return {
		hwaccel,
		height,
		fps,
		threshold,
		keyframe,
		cache: useCache && Boolean(cacheDir),
		cacheDir,
		hwaccelOutputFormat: hwOutputFormat,
	};
}

// Config fingerprint stored in the detect cache key. Any field that changes
// the shot boundaries must change this string.
export function detectConfigKey(o: DetectOptions) {
	return [
		`h=${o.height}`,
		`fps=${o.fps}`,
		`thr=${o.threshold}`,
		`kf=${o.keyframe ? 1 : 0}`,
		`hw=${o.hwaccel}`,
		`hwo=${o.hwaccelOutputFormat ? 1 : 0}`,
	].join("|");
}

// The select/scale chain. MUST stay in the quoted comma-chain form —
// `select=gt(scene,0.3):showinfo` silently emits ZERO frames (exit 1) on
// this ffmpeg build (measured).
export function buildDetectFilter(
	o: DetectOptions,
	{ forHwDownload = false }: { forHwDownload?: boolean } = {},
) {
	const pre: string[] = [];
	if (forHwDownload) {
		pre.push("hwdownload", "format=nv12");
	}
	pre.push(`scale=-2:${o.height}`);
	if (o.fps > 0) pre.push(`fps=${o.fps}`);
	const head = pre.join(",");
	return (
		`[0:v]${head},split=2[a][b];` +
		`[a]select='gt(scene,${o.threshold})',showinfo[sa];` +
		`[b]null[sb]`
	);
}

// Full argv for one detect pass. `-skip_frame nokey` is an INPUT option
// (before -i) and only used for the keyframe coarse pass.
export function buildDetectArgs(
	filePath: string,
	o: DetectOptions,
	{ keyframeOnly = false }: { keyframeOnly?: boolean } = {},
) {
	const args: string[] = [];
	if (keyframeOnly) {
		args.push("-skip_frame", "nokey");
	}
	const useHw = o.hwaccel === "videotoolbox" || o.hwaccel === "auto";
	if (
		useHw &&
		o.hwaccel !== "software" &&
		o.hwaccel !== "off" &&
		o.hwaccel !== "none"
	) {
		args.push("-hwaccel", "videotoolbox");
		if (o.hwaccelOutputFormat) {
			args.push("-hwaccel_output_format", "videotoolbox");
		}
	}
	args.push("-i", filePath);
	args.push(
		"-filter_complex",
		buildDetectFilter(o, {
			forHwDownload: Boolean(o.hwaccelOutputFormat && useHw),
		}),
		"-map",
		"[sa]",
		"-map",
		"[sb]",
		"-f",
		"null",
		"-",
	);
	return args;
}

// Parse showinfo pts_time hits + the last time= decode tick out of a
// detect-pass stderr blob. Pure; shared by live parse and tests.
export function parseDetectStderr(stderr: unknown) {
	const pts = [...String(stderr).matchAll(/pts_time:([0-9.]+)/g)].map((m) =>
		parseFloat(m[1] as string),
	);
	let lastTime: number | null = null;
	for (const m of String(stderr).matchAll(
		/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g,
	)) {
		lastTime = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
	}
	return {
		boundaries: [...new Set(pts)].sort((a, b) => a - b),
		duration: lastTime,
	};
}

// Cheap hardware-availability probe: `ffmpeg -hwaccels` lists
// `videotoolbox` on every Apple Silicon / modern macOS ffmpeg build that
// has the decoder. Once per process so "auto" skips the failed-spawn path
// on Linux CI or a build without VT.
let vtProbeCache: boolean | null = null;
async function videoToolboxAvailable(ffmpeg: string) {
	if (vtProbeCache !== null) return vtProbeCache;
	vtProbeCache = await new Promise<boolean>((resolve) => {
		const child = spawnFfmpeg(ffmpeg, ["-hide_banner", "-hwaccels"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let settled = false;
		const done = (v: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(v);
		};
		// The old probe had NO timeout: a hung ffmpeg here wedged the whole
		// detect path forever. 10 s is generous for a flag listing.
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				/* best-effort */
			}
			done(false);
		}, 10000);
		child.stdout?.on("data", (d) => {
			out += d.toString();
		});
		child.stderr?.on("data", (d) => {
			out += d.toString();
		});
		child.on("error", () => done(false));
		child.on("close", () => {
			done(/\bvideotoolbox\b/i.test(out));
		});
	});
	return vtProbeCache;
}

// Scene-pass watchdog (Phase 4, long-movie coverage — see detectScenes).
// STALL: no stderr output for this long → the decode is hung, kill it.
// ABSOLUTE: ceiling for pathological files. A pass that is still making
// decode progress is NEVER killed by the clock alone — the old flat 120 s
// cap silently discarded all shot boundaries for a 2–3 hour film (the pass
// decodes every frame at 360p), degrading it to interval sampling.
export const DETECT_SCENES_STALL_TIMEOUT_MS = 30000;
export const DETECT_SCENES_ABSOLUTE_TIMEOUT_MS = 10 * 60 * 1000;
// Duration-aware detect ceiling (2026-09-28 orphan fix): a full-rate 360p
// software decode of a 2 h HEVC 10-bit film cannot finish inside the 10 min
// enrich chunk timeout, so the CHUNK timed out (main killed the worker and
// orphaned ffmpeg) instead of the DETECT timing out (which falls back to
// interval sampling inside the same chunk). Large films get a SHORTER detect
// budget so the fallback + 16 embeds still fit inside the chunk timeout and
// the timed-out detect result is cached instead of re-run forever.
export function detectAbsoluteTimeoutMs(durationSeconds: number | null) {
	// Runtime note: null fails the > 0 probe exactly like 0/negative did
	// pre-conversion; the null check just lets tsc narrow the comparisons.
	if (durationSeconds === null || !(durationSeconds > 0)) {
		return DETECT_SCENES_ABSOLUTE_TIMEOUT_MS;
	}
	if (durationSeconds >= 3600) return 5 * 60 * 1000;
	if (durationSeconds >= 1800) return 6 * 60 * 1000;
	return DETECT_SCENES_ABSOLUTE_TIMEOUT_MS;
}
export const REFINE_WINDOW_TIMEOUT_MS = 60000;

interface DetectPassResult {
	boundaries: number[];
	duration: number | null;
	failed?: boolean;
	spawnError?: boolean;
	hwFail?: boolean;
	timedOut?: boolean;
	code?: number | null;
	stderr?: string;
	stderrTail?: string;
}

// Shot boundaries at absolute seconds via an ffmpeg scene-detection pass.
// IMPORTANT: the filter MUST be the quoted comma-chain form
// `scale=-2:360,select='gt(scene,0.3)',showinfo`. The unquoted/colon form
// (`select=gt(scene,0.3):showinfo`) silently emits ZERO frames (exit 1) on
// this ffmpeg build — measured, not folklore. The 360p scale is Phase 4:
// cut detection needs luma deltas, not 4K pixels, and the downscale is the
// single biggest lever for keeping the pass fast on long or high-resolution
// films. The select chain is split with a parallel `null` tap so every frame
// ALSO reaches the muxer — without it ffmpeg's stats only tick at cut
// points and the last time= is the final CUT, not the end of the film.
//
// Phase 1 (2026-09-25): optional VideoToolbox decode, lower height/fps,
// keyframe coarse + refine, and a caller-supplied detect cache. Defaults
// preserve the historical software 360p full-rate 0.3 contract.
//
// Watchdog timeouts instead of a flat cap: the old hard 120 s ceiling
// silently discarded ALL boundaries for a 2–3 hour film (the pass decodes
// every frame at 360p), degrading it to interval sampling. As long as
// ffmpeg keeps emitting stderr (decode progress), a long film is allowed to
// run; only a stall (no output for DETECT_SCENES_STALL_TIMEOUT_MS) or the
// absolute ceiling (a genuinely hung pass) kills it.
//
// Resolves { boundaries, duration, engine, wallMs, cached }: boundaries is
// [] when no cuts were detected (single continuous take) or the pass
// failed/was killed — callers fall back to interval sampling. duration is
// the decode position of the LAST stats tick (≈ the film's real length at
// EOF, thanks to the null tap), which buildSegmentPlan uses when the
// container has no probeable duration (some .mkv/.ts/raw captures report
// Duration: N/A); may be null when the pass never ticked (an undecodable
// file).
//
// `onProgress({ pct })` receives a 0..1 decode fraction (from ffmpeg's
// time= stderr ticks, when a duration is known) so the UI can show a long
// film is still being analyzed instead of sitting silent.
export async function detectScenes(
	ffmpeg: string,
	filePath: string,
	onProgress: ((p: { pct: number }) => void) | null = null,
	duration: number | null = null,
	opts: DetectOpts | null = null,
): Promise<{
	boundaries: number[];
	duration: number | null;
	// The cached-hit spread can carry a null engine (a falsy label coerced
	// in getCachedDetect); the live pass always writes a string label.
	engine: string | null;
	wallMs: number;
	cached: boolean;
}> {
	const o = resolveDetectOptions(opts || {});
	const started = Date.now();

	// Phase 1.4 cache hit — never spawn ffmpeg.
	if (o.cache && filePath) {
		try {
			const ident = detectCache.fileIdentity(filePath);
			const hit = detectCache.getCachedDetect(o.cacheDir, {
				filePath: path.resolve(filePath),
				...ident,
				configKey: detectConfigKey(o),
			});
			if (hit) {
				if (onProgress && duration !== null && duration > 0) {
					onProgress({ pct: 1 });
				}
				return {
					...hit,
					wallMs: Date.now() - started,
					cached: true,
				};
			}
		} catch {
			/* unreadable file identity → run the live pass */
		}
	}

	const engines: Array<{ hwaccel: string; hwaccelOutputFormat: boolean }> = [];
	// "auto" = software first, videotoolbox only as an explicit opt-in
	// alternative after a failed software spawn (never preferred: measured
	// slower for select=scene). "videotoolbox" forces the VT attempt first.
	if (o.hwaccel === "videotoolbox") {
		const canVt = await videoToolboxAvailable(ffmpeg);
		if (canVt) {
			engines.push({
				hwaccel: "videotoolbox",
				hwaccelOutputFormat: o.hwaccelOutputFormat,
			});
		}
	}
	// Software is always the terminal fallback.
	engines.push({ hwaccel: "software", hwaccelOutputFormat: false });

	const runOnce = (
		engineOpts: { hwaccel: string; hwaccelOutputFormat: boolean },
		{ keyframeOnly = false }: { keyframeOnly?: boolean } = {},
	) =>
		new Promise<DetectPassResult>((resolve) => {
			const args = buildDetectArgs(
				filePath,
				{ ...o, ...engineOpts },
				{ keyframeOnly },
			);
			const child = spawnFfmpeg(ffmpeg, args, {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stderr = "";
			let lastPct = -1;
			let lastTime: number | null = null;
			let timedOut = false;
			let failedPass = false;
			let spawnError = false;
			let stallTimer: NodeJS.Timeout | null = null;
			let absoluteTimer: NodeJS.Timeout | null = null;
			// Duration-aware absolute ceiling: the old flat 10 min left no
			// room for the 16 embeds inside the 10 min chunk timeout, so a
			// 2 h HEVC file timed out the CHUNK (main killed the worker,
			// orphaning ffmpeg to PID 1) instead of timing out the DETECT
			// (which would have fallen back to interval sampling inside the
			// same chunk). Large films get a shorter detect budget so the
			// fallback + embeds still fit inside the chunk timeout.
			const absoluteMs = detectAbsoluteTimeoutMs(duration);
			const stopWatchdogs = () => {
				if (stallTimer) clearTimeout(stallTimer);
				if (absoluteTimer) clearTimeout(absoluteTimer);
			};
			const armStall = () => {
				if (stallTimer) clearTimeout(stallTimer);
				stallTimer = setTimeout(() => {
					timedOut = true;
					child.kill("SIGKILL");
				}, DETECT_SCENES_STALL_TIMEOUT_MS);
			};
			child.stderr?.on("data", (d) => {
				const chunk = d.toString();
				stderr += chunk;
				armStall();
				const m = chunk.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
				if (m) {
					lastTime = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
					if (onProgress && duration !== null && duration > 0) {
						const pct = Math.min(1, lastTime / duration);
						if (pct > lastPct) {
							lastPct = pct;
							onProgress({ pct });
						}
					}
				}
			});
			armStall();
			absoluteTimer = setTimeout(() => {
				timedOut = true;
				try {
					child.kill("SIGKILL");
				} catch {
					/* best-effort */
				}
			}, absoluteMs);
			child.on("error", () => {
				spawnError = true;
				failedPass = true;
				stopWatchdogs();
				resolve({
					boundaries: [],
					duration: null,
					failed: true,
					spawnError: true,
					stderr,
				});
			});
			child.on("close", (code) => {
				stopWatchdogs();
				if (
					onProgress &&
					duration !== null &&
					duration > 0 &&
					!timedOut &&
					!failedPass &&
					lastPct < 1
				) {
					onProgress({ pct: 1 });
				}
				const parsed = parseDetectStderr(stderr);
				const lower = stderr.toLowerCase();
				// Only a clear hwaccel failure forces the next engine. A
				// generic exit 1 with no hwaccel error is a real pass failure
				// (keep the historic empty/partial result), not a signal to
				// silently switch engines.
				const hwErrorMessage =
					lower.includes("hwaccel") ||
					lower.includes("videotoolbox") ||
					lower.includes("hardware accelerator") ||
					lower.includes("impossible to convert between the formats");
				const hwFail =
					code !== 0 &&
					code !== null &&
					engineOpts.hwaccel !== "software" &&
					hwErrorMessage;
				resolve({
					boundaries: parsed.boundaries,
					duration: parsed.duration ?? lastTime,
					failed: failedPass || timedOut,
					spawnError,
					hwFail: Boolean(hwFail),
					timedOut,
					code,
					stderrTail: stderr.slice(-400),
				});
			});
		});

	let chosen: DetectPassResult | null = null;
	let engineLabel = "software";
	for (const engineOpts of engines) {
		const res = await runOnce(engineOpts, { keyframeOnly: false });
		const label =
			engineOpts.hwaccel === "software"
				? "software"
				: engineOpts.hwaccelOutputFormat
					? "videotoolbox+hwdownload"
					: "videotoolbox";
		if (!res.spawnError && !res.hwFail && !res.failed) {
			chosen = res;
			engineLabel = label;
			break;
		}
		// hwaccel failed hard → try the next engine. A clean empty plan is
		// success, not failure.
		if (res.spawnError || res.hwFail) continue;
		// timedOut / other failure on software: keep it (same as historic).
		chosen = res;
		engineLabel = label;
		break;
	}
	if (!chosen) {
		// Absolute last resort: historic empty result.
		return {
			boundaries: [],
			duration: null,
			engine: "failed",
			wallMs: Date.now() - started,
			cached: false,
		};
	}

	let boundaries = chosen.boundaries;
	// Phase 1.3 keyframe coarse + local refine.
	if (o.keyframe) {
		const coarse = await runOnce(
			{
				...o,
				hwaccel: engineLabel.startsWith("videotoolbox")
					? "videotoolbox"
					: "software",
			},
			{ keyframeOnly: true },
		);
		// Prefer coarse I-frame hits when the full pass is much larger (the
		// full pass at 360p is the expensive one we are replacing); refine
		// each coarse hit in a ±window and keep the refined cut.
		if (!coarse.failed && !coarse.spawnError && coarse.boundaries.length > 0) {
			const refined = await refineBoundaries(
				ffmpeg,
				filePath,
				o,
				coarse.boundaries,
				KEYFRAME_REFINE_WINDOW_S,
			);
			boundaries = refined.length > 0 ? refined : coarse.boundaries;
			engineLabel += "+keyframe";
		}
	}

	const result = {
		boundaries,
		duration: chosen.duration,
		engine: engineLabel,
		wallMs: Date.now() - started,
		cached: false,
	};

	if (o.cache && filePath) {
		try {
			const ident = detectCache.fileIdentity(filePath);
			detectCache.setCachedDetect(
				o.cacheDir,
				{
					filePath: path.resolve(filePath),
					...ident,
					configKey: detectConfigKey(o),
				},
				result,
			);
		} catch {
			/* cache write is best-effort */
		}
	}
	return result;
}

// Local full-rate refine around each coarse keyframe hit (Phase 1.3).
// Each window is a short ffmpeg pass with -ss/-t; the refined cut is the
// boundary nearest the coarse timestamp inside the window.
async function refineBoundaries(
	ffmpeg: string,
	filePath: string,
	o: DetectOptions,
	coarseHits: number[],
	windowS: number,
): Promise<number[]> {
	const out: number[] = [];
	for (const t of coarseHits) {
		const ss = Math.max(0, t - windowS);
		const dur = windowS * 2 + 0.25;
		const res = await new Promise<{ boundaries: number[] }>((resolve) => {
			const args: string[] = [];
			const useHw =
				o.hwaccel !== "software" && o.hwaccel !== "off" && o.hwaccel !== "none";
			if (useHw) {
				args.push("-hwaccel", "videotoolbox");
				if (o.hwaccelOutputFormat)
					args.push("-hwaccel_output_format", "videotoolbox");
			}
			args.push(
				"-ss",
				String(ss),
				"-t",
				String(dur),
				"-i",
				filePath,
				"-filter_complex",
				buildDetectFilter(o, {
					forHwDownload: Boolean(o.hwaccelOutputFormat && useHw),
				}),
				"-map",
				"[sa]",
				"-map",
				"[sb]",
				"-f",
				"null",
				"-",
			);
			const child = spawnFfmpeg(ffmpeg, args, {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stderr = "";
			let settled = false;
			const done = (v: { boundaries: number[] }) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(v);
			};
			// The old refine pass had NO timeout: one hung window wedged the
			// whole enrichment forever (and orphaned on worker kill). 60 s
			// covers a 4.25 s window many times over; on timeout keep the
			// coarse hit so the film still gets coverage.
			const timer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					/* best-effort */
				}
				done({ boundaries: [] });
			}, REFINE_WINDOW_TIMEOUT_MS);
			child.stderr?.on("data", (d) => {
				stderr += d.toString();
			});
			child.on("error", () => done({ boundaries: [] }));
			child.on("close", () => {
				const parsed = parseDetectStderr(stderr);
				done({
					boundaries: parsed.boundaries.map((x) => x + ss),
				});
			});
		});
		if (res.boundaries.length === 0) {
			out.push(t);
			continue;
		}
		// Cast: length > 0 checked above.
		let best = res.boundaries[0] as number;
		let bestDist = Math.abs(best - t);
		for (const b of res.boundaries) {
			const d = Math.abs(b - t);
			if (d < bestDist) {
				bestDist = d;
				best = b;
			}
		}
		out.push(best);
	}
	return [...new Set(out)].sort((a, b) => a - b);
}

// The segment plan for a video: [{ t, dur }] where `t` is the MIDPOINT frame
// to embed (the most representative frame of a shot) and `dur` is the shot's
// span. Shot-based when boundaries exist; interval fallback otherwise. A
// failed probe (no duration) falls back to the scene pass's own decode
// measurement, so only a fully undecodable file yields an empty plan — the
// caller records "no segments" rather than retrying forever. The plan is
// bounded by segmentBudgetFor(duration, budgetOpts) (≤ the preset's max),
// and `onProgress` (when given) is forwarded to the shot-detection pass so
// the UI sees decode progress. `budgetOpts` is a VIDEO_QUALITY_PRESETS entry
// (or null for the balanced default). `detectOpts` (Phase 1) selects
// hwaccel / height / fps / keyframe / cache — see resolveDetectOptions.
export async function buildSegmentPlan(
	ffmpeg: string,
	filePath: string,
	onProgress: ((progress: Record<string, unknown>) => void) | null = null,
	budgetOpts: BudgetOpts | null = null,
	detectOpts: { cacheDir?: string | null } | null = null,
): Promise<Array<{ t: number; dur: number }>> {
	let duration: number | null = null;
	try {
		duration = await probeDuration(ffmpeg, filePath);
	} catch {
		/* fall through to the scene-pass measurement below */
	}
	// The scene pass measures duration from its decode ticks (the parallel
	// null tap), so a container with no probeable duration (some .mkv/.ts/
	// raw captures report Duration: N/A) still gets a plan — previously it
	// was recorded as permanently "no segments". The probe is authoritative
	// when both exist; the pass measurement is ± a frame at EOF.
	const { boundaries, duration: measuredDuration } = await detectScenes(
		ffmpeg,
		filePath,
		onProgress,
		duration,
		detectOpts,
	);
	if (duration === null && measuredDuration !== null && measuredDuration > 0) {
		duration = measuredDuration;
	}
	// Runtime note: a null duration fails the > 0 probe → the floor, exactly
	// as pre-conversion.
	const budget = segmentBudgetFor(duration, budgetOpts);
	let plan: Array<{ t: number; dur: number }> = [];
	if (duration !== null && duration > 0) {
		if (boundaries.length > 0) {
			// Cast: duration is non-null inside this branch (checked above).
			const dur = duration as number;
			const starts = [0, ...boundaries];
			// Casts: starts/ends are dense equal-length arrays (the
			// established loop-bound read pattern).
			const ends = [...boundaries, dur];
			const shots = starts.map((s: string | number, i: number) => ({
				t: ((s as number) + (ends[i] as number)) / 2,
				dur: (ends[i] as number) - (s as number),
			}));
			// Uniform TIME coverage (Phase 5): a shot-heavy film keeps one
			// shot per (duration / budget) slice instead of the old
			// front-biased first-32, so the final act stays searchable.
			plan =
				shots.length <= budget
					? shots
					: sampleShotsEvenly(shots, duration, budget);
		} else {
			plan = buildIntervalPlan(duration, budget);
		}
	}
	return clampPlan(plan, duration);
}
