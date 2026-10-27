"use client";

import { useState } from "react";
import { IconCheck, IconMicrophone } from "@tabler/icons-react";
import {
	estimateEnrichmentCost,
	formatFootage,
	formatTimeRange,
	segmentBudgetFor,
	VIDEO_PRESET_BUDGETS,
	VIDEO_QUALITY_BLURBS,
	VIDEO_QUALITY_IDS,
	type VideoCostFacts,
	type VideoQualitySetting,
} from "@/lib/videoQuality";
import { formatBytes } from "@/lib/format";
import { IDLE_ROW, SELECTED_ROW } from "@/lib/rowTokens";
import {
	WHISPER_MODEL_BLURBS,
	WHISPER_MODEL_IDS,
	WHISPER_MODEL_LABELS,
	type WhisperModelSetting,
} from "@/lib/whisperModel";

type NotifyTone = "default" | "success" | "warning" | "error";

// Display labels for the preset rungs (the id "ultraPro" renders as
// "Ultra Pro", not "Ultrapro").
const VIDEO_QUALITY_LABELS: Record<VideoQualitySetting, string> = {
	eco: "Eco",
	balanced: "Balanced",
	detailed: "Detailed",
	ultra: "Ultra",
	ultraPro: "Ultra Pro",
};

interface VideoSectionProps {
	videoQuality: VideoQualitySetting;
	onVideoQualityChange: (next: VideoQualitySetting) => Promise<void>;
	videoCostFacts: VideoCostFacts | null;
	onRefreshVideoCostFacts: () => void;
	whisperModel: WhisperModelSetting;
	onWhisperModelChange: (next: WhisperModelSetting) => Promise<number | null>;
	suspectedTruncated: number;
	suspectedTruncatedFiles: string[];
	onRefreshSuspectedTruncated: () => void;
	onReanalyzeVideos: () => Promise<number | null>;
	onNotify: (message: string, tone: NotifyTone) => void;
}

// Video search section, extracted from SettingsSheet verbatim: scene
// density (with the hover-to-preview cost line and the Ultra Pro
// accept), the speech model picker, and the maintenance actions
// (re-analyze, delete pre-fix truncated videos, stop background work).
// All confirm/preview state is session-only and dies with the section —
// the sheet unmounts its body on close and only mounts the active
// section, so a reopen never inherits a stale confirm.
export default function VideoSection({
	videoQuality,
	onVideoQualityChange,
	videoCostFacts,
	onRefreshVideoCostFacts,
	whisperModel,
	onWhisperModelChange,
	suspectedTruncated,
	suspectedTruncatedFiles,
	onRefreshSuspectedTruncated,
	onReanalyzeVideos,
	onNotify,
}: VideoSectionProps) {
	// Which rung the cost line previews (null = no preview; the line then
	// follows the selection, and only for Ultra Pro).
	const [costPreview, setCostPreview] = useState<VideoQualitySetting | null>(
		null,
	);
	// One-time inline confirm before committing Ultra Pro — the most
	// expensive preset re-analyzes the whole library at 2× Ultra's cost
	// (MDs/Ultra-Pro-Plan.md §4.4). Session-only: showing it again on a
	// later visit is cheap and honest; a "don't ask" flag is deliberately
	// not persisted.
	const [confirmUltraPro, setConfirmUltraPro] = useState(false);
	// Two-step inline confirm for deleting the pre-fix truncated videos
	// (session-only, like confirmUltraPro). Deleting removes the library
	// copy + AI index + sidecars; the user's original files are untouched,
	// so the videos can be re-imported clean afterwards.
	const [confirmDeleteTruncated, setConfirmDeleteTruncated] = useState(false);
	const [deletingTruncated, setDeletingTruncated] = useState(false);
	// Background-work purge (Video maintenance): two-step inline confirm
	// plus the in-flight flag. Session-only like the other confirms.
	const [confirmPurge, setConfirmPurge] = useState(false);
	const [purging, setPurging] = useState(false);

	// Which preset's bill the cost line shows: the hovered rung while
	// previewing, otherwise the selection — and only Ultra Pro keeps the
	// line up unprompted (it is the one rung whose bill needs to stay
	// visible; MDs/Ultra-Pro-Plan.md §4.3). Hovering any rung previews that
	// rung's cost.
	const costQuality: VideoQualitySetting | null =
		costPreview ?? (videoQuality === "ultraPro" ? "ultraPro" : null);
	// Without measured facts, fall back to the static per-film example —
	// never blank, never a spinner.
	const usingFallback = !videoCostFacts;
	const costDurations = videoCostFacts?.durations ?? [90 * 60];
	const costEstimate = costQuality
		? estimateEnrichmentCost(costDurations, costQuality)
		: null;
	// Cap sentence (Ultra Pro only): when the longest film exceeds what full
	// 2.5 s density covers (2048 × 2.5 s ≈ 85 min), say what density it will
	// actually get — most pro libraries have long films, and pretending
	// 2.5 s density is what they're buying would be the dishonest version.
	const ultraBudget = VIDEO_PRESET_BUDGETS.ultraPro;
	const longestSeconds = videoCostFacts
		? videoCostFacts.durations.reduce((max, s) => (s > max ? s : max), 0)
		: 0;
	let capSentence: string | null = null;
	if (costQuality === "ultraPro" && longestSeconds > 0) {
		const longestBudget = segmentBudgetFor(longestSeconds, ultraBudget);
		const density = longestSeconds / ultraBudget.maxSegments;
		if (
			longestBudget >= ultraBudget.maxSegments &&
			density > ultraBudget.targetSeconds * 1.1
		) {
			capSentence = ` Your longest film (${formatFootage(longestSeconds)}) gets one point every ~${density.toFixed(1)} s (the ${ultraBudget.maxSegments}-point cap), not every ${ultraBudget.targetSeconds} s.`;
		}
	}
	const unknownSentence =
		videoCostFacts && videoCostFacts.unknownCount > 0
			? ` Plus ${videoCostFacts.unknownCount} of unknown length (no scene data yet) not counted above.`
			: null;

	const handleVideoPick = (value: VideoQualitySetting) => {
		if (value === videoQuality) return;
		if (value === "ultraPro") {
			// The one rung expensive enough to require an
			// explicit accept before committing (§4.4).
			setConfirmUltraPro(true);
			return;
		}
		setConfirmUltraPro(false);
		void onVideoQualityChange(value);
		onNotify(
			`Video search: ${VIDEO_QUALITY_LABELS[value]}. New videos use it; re-analyze below to update existing ones.`,
			"default",
		);
	};

	const handleDeleteTruncated = () => {
		const files = suspectedTruncatedFiles;
		if (files.length === 0 || deletingTruncated) return;
		setDeletingTruncated(true);
		void (async () => {
			let removed = 0;
			for (const filename of files) {
				try {
					const res = await window.memories.deleteMemory(filename);
					if (res?.ok) removed++;
				} catch {
					/* per-file failure — counted below, never throws */
				}
			}
			setDeletingTruncated(false);
			setConfirmDeleteTruncated(false);
			onRefreshSuspectedTruncated();
			if (removed === 0) {
				onNotify("Could not delete the flagged videos", "warning");
			} else if (removed < files.length) {
				onNotify(
					`Deleted ${removed} of ${files.length} flagged videos — the rest could not be removed`,
					"warning",
				);
			} else {
				onNotify(
					`Deleted ${removed} flagged video${removed === 1 ? "" : "s"} — re-import the originals to rebuild them clean`,
					"success",
				);
			}
		})();
	};

	const handlePurge = () => {
		if (purging) return;
		// The purge bridge ships with the main process: a window opened
		// before the update has no purgeBackground — say so plainly.
		if (typeof window.memories.purgeBackground !== "function") {
			onNotify(
				"This window is from before the purge update — restart SCM and try again.",
				"warning",
			);
			return;
		}
		setPurging(true);
		void (async () => {
			try {
				const res = await window.memories.purgeBackground();
				if (res?.ok) {
					setConfirmPurge(false);
					const bits = [];
					if (res.queued) bits.push(`${res.queued} queued`);
					if (res.orphans) bits.push(`${res.orphans} leftover`);
					onNotify(
						bits.length > 0
							? `Background work stopped — cleared ${bits.join(" + ")}. Unfinished videos re-queue next launch.`
							: "Background work stopped — queues were already empty.",
						"success",
					);
				} else {
					onNotify(res?.error ?? "Could not stop background work", "warning");
				}
			} catch {
				onNotify("Could not stop background work", "warning");
			} finally {
				setPurging(false);
				onRefreshSuspectedTruncated();
				onRefreshVideoCostFacts();
			}
		})();
	};

	const handleReanalyze = () => {
		void onReanalyzeVideos().then((queued) => {
			if (queued === null) {
				onNotify("Could not re-analyze videos", "warning");
			} else if (queued === 0) {
				onNotify("No videos to re-analyze", "default");
			} else if (videoQuality === "ultraPro") {
				// The most expensive action in the app states its
				// bill in the toast (MDs/Ultra-Pro-Plan.md §4.5).
				const range = formatTimeRange(
					estimateEnrichmentCost(costDurations, "ultraPro").timeMinutes,
				);
				onNotify(
					`Re-analyzing ${queued} video${queued === 1 ? "" : "s"} under Ultra Pro — roughly ${range ?? "hours"} of background time; the tray shows progress and it pauses while you search`,
					"success",
				);
			} else {
				onNotify(
					`Re-analyzing ${queued} video${queued === 1 ? "" : "s"} — watch the scene-analysis tray`,
					"success",
				);
			}
			// Queuing a re-analysis deletes the sidecar entries
			// (they rebuild during enrichment), so the banner
			// count drops immediately.
			onRefreshSuspectedTruncated();
		});
	};

	return (
		<div className="mx-auto max-w-[640px] space-y-5">
			<div>
				<h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
					Scene density
				</h3>
				<p className="mt-1 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
					How closely new videos are analyzed for scene search. Denser finds
					more moments but costs more background time and disk.
				</p>
				<div
					role="radiogroup"
					aria-label="Video search quality"
					onMouseLeave={() => setCostPreview(null)}
					className="mt-3 space-y-2"
				>
					{VIDEO_QUALITY_IDS.map((value) => {
						const selected = videoQuality === value;
						const label = VIDEO_QUALITY_LABELS[value];
						return (
							<button
								key={value}
								type="button"
								role="radio"
								aria-checked={selected}
								aria-label={`${label} — ${VIDEO_QUALITY_BLURBS[value]}`}
								title={VIDEO_QUALITY_BLURBS[value]}
								onMouseEnter={() => setCostPreview(value)}
								onFocus={() => setCostPreview(value)}
								onClick={() => handleVideoPick(value)}
								className={`flex w-full items-center gap-3.5 rounded-2xl border px-4 py-3.5 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${selected ? SELECTED_ROW : IDLE_ROW}`}
							>
								<span
									className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
										selected
											? "border-sky-500 bg-sky-500 text-white"
											: "border-zinc-400 text-transparent dark:border-zinc-500"
									}`}
									aria-hidden="true"
								>
									<IconCheck size={12} stroke={3} />
								</span>
								<span className="min-w-0 flex-1">
									<span className="flex flex-wrap items-center gap-2 text-sm font-semibold text-zinc-800 dark:text-zinc-100">
										{label}
										{value === "balanced" && (
											<span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
												Recommended
											</span>
										)}
										{value === "ultraPro" && (
											<span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
												2× cost
											</span>
										)}
									</span>
									<span className="mt-0.5 block text-[13px] text-zinc-500 dark:text-zinc-400">
										{VIDEO_QUALITY_BLURBS[value]}
									</span>
								</span>
							</button>
						);
					})}
				</div>

				{confirmUltraPro && (
					<div className="mt-3 flex flex-col gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between dark:border-amber-400/30 dark:bg-amber-400/10">
						<p className="text-[13px] leading-relaxed text-amber-800 dark:text-amber-200">
							Ultra Pro doubles scene-analysis time and disk for your library
							(see the cost line below). Use it?
						</p>
						<div className="flex shrink-0 gap-2">
							<button
								type="button"
								onClick={() => {
									setConfirmUltraPro(false);
									void onVideoQualityChange("ultraPro");
									const range = formatTimeRange(
										estimateEnrichmentCost(costDurations, "ultraPro")
											.timeMinutes,
									);
									onNotify(
										range
											? `Video search: Ultra Pro. New videos use it; re-analyze below to update existing ones (roughly ${range} of background time).`
											: "Video search: Ultra Pro. New videos use it; re-analyze below to update existing ones.",
										"default",
									);
								}}
								className="rounded-xl border border-amber-500/40 bg-white/60 px-3.5 py-2 text-[13px] font-semibold text-amber-800 transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-amber-400/40 dark:bg-black/25 dark:text-amber-200 dark:hover:bg-black/40"
							>
								Use Ultra Pro
							</button>
							<button
								type="button"
								onClick={() => setConfirmUltraPro(false)}
								className="rounded-xl border border-slate-500/30 bg-white/40 px-3.5 py-2 text-[13px] font-medium text-zinc-600 transition-colors hover:bg-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-600/50 dark:bg-black/25 dark:text-zinc-300 dark:hover:bg-white/10"
							>
								Keep {VIDEO_QUALITY_LABELS[videoQuality]}
							</button>
						</div>
					</div>
				)}

				{costEstimate && costQuality && (
					<div
						role="note"
						className="mt-3 rounded-2xl border border-slate-500/30 bg-white/40 px-4 py-3.5 text-[13px] leading-relaxed text-zinc-600 dark:border-slate-600/40 dark:bg-black/20 dark:text-zinc-300"
					>
						{usingFallback ? (
							<>
								A 90-min film on {VIDEO_QUALITY_LABELS[costQuality]}: roughly{" "}
								{formatTimeRange(costEstimate.timeMinutes) ?? "under a minute"}{" "}
								of background time and ~{formatBytes(costEstimate.diskBytes)} of
								disk.
							</>
						) : (
							<>
								{VIDEO_QUALITY_LABELS[costQuality]} across your{" "}
								{videoCostFacts!.videoCount} video
								{videoCostFacts!.videoCount === 1 ? "" : "s"} (
								{formatFootage(videoCostFacts!.knownSeconds) ??
									"no measured footage"}
								): roughly{" "}
								{formatTimeRange(costEstimate.timeMinutes) ?? "under a minute"}{" "}
								of background time and ~{formatBytes(costEstimate.diskBytes)} of
								disk.
								{capSentence}
								{unknownSentence} Runs in chunks, pauses while you search, and
								re-analysis is resumable.
							</>
						)}
					</div>
				)}
			</div>

			<div className="border-t border-slate-500/25 dark:border-slate-600/40" />

			<div>
				<h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-800 dark:text-zinc-100">
					<IconMicrophone
						size={15}
						className="text-zinc-500 dark:text-zinc-400"
						aria-hidden="true"
					/>
					Speech model
				</h3>
				<p className="mt-1 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
					The whisper engine for dialogue search. Switching re-transcribes every
					video in the background. Multilingual models auto-detect the spoken
					language per video; the English-only models stay the fastest, most
					accurate pick for English dialogue.
				</p>
				<div
					role="radiogroup"
					aria-label="Speech model"
					className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2"
				>
					{WHISPER_MODEL_IDS.map((value) => {
						const selected = whisperModel === value;
						const label = WHISPER_MODEL_LABELS[value];
						return (
							<button
								key={value}
								type="button"
								role="radio"
								aria-checked={selected}
								aria-label={`${label} — ${WHISPER_MODEL_BLURBS[value]}`}
								title={WHISPER_MODEL_BLURBS[value]}
								onClick={() => {
									if (value !== whisperModel) {
										void onWhisperModelChange(value).then((queued) => {
											if (queued === null) {
												onNotify("Could not switch speech model", "warning");
											} else if (queued === 0) {
												onNotify(`Speech model: ${label}.`, "default");
											} else {
												onNotify(
													`Speech model: ${label} — re-transcribing ${queued} video${queued === 1 ? "" : "s"} in the background`,
													"success",
												);
											}
										});
									}
								}}
								className={`rounded-2xl border p-4 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${selected ? SELECTED_ROW : IDLE_ROW}`}
							>
								<span className="flex items-center gap-1.5 text-sm font-semibold text-zinc-800 dark:text-zinc-100">
									{label}
									{selected && (
										<IconCheck
											size={14}
											className="text-sky-600 dark:text-sky-300"
											aria-hidden="true"
										/>
									)}
								</span>
								<span className="mt-1 block text-[13px] leading-snug text-zinc-500 dark:text-zinc-400">
									{WHISPER_MODEL_BLURBS[value]}
								</span>
							</button>
						);
					})}
				</div>
			</div>

			<div className="border-t border-slate-500/25 dark:border-slate-600/40" />

			<div>
				{suspectedTruncated > 0 && (
					<div
						role="status"
						className="mb-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3.5 text-[13px] leading-relaxed text-amber-800 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-200"
					>
						{suspectedTruncated} video
						{suspectedTruncated === 1 ? "" : "s"} wa
						{suspectedTruncated === 1 ? "s" : "re"} analyzed before the
						scene-search fix — scene search only covers their final minutes.
						Re-analyze below to repair.
						{suspectedTruncatedFiles.length > 0 && !confirmDeleteTruncated && (
							<button
								type="button"
								onClick={() => setConfirmDeleteTruncated(true)}
								className="mt-2 block text-[13px] font-semibold underline decoration-amber-500/50 underline-offset-2 transition-colors hover:text-amber-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:hover:text-amber-100"
							>
								Or delete{" "}
								{suspectedTruncatedFiles.length === 1
									? "this video"
									: `these ${suspectedTruncatedFiles.length} videos`}{" "}
								instead…
							</button>
						)}
						{confirmDeleteTruncated && suspectedTruncatedFiles.length > 0 && (
							<div className="mt-3 border-t border-amber-500/30 pt-3 dark:border-amber-400/20">
								<p className="font-semibold">
									Delete{" "}
									{suspectedTruncatedFiles.length === 1
										? "this video"
										: `these ${suspectedTruncatedFiles.length} videos`}{" "}
									from the library?
								</p>
								<ul className="mt-1.5 max-h-24 space-y-0.5 overflow-y-auto text-[12px]">
									{suspectedTruncatedFiles.map((f) => (
										<li key={f} title={f} className="truncate font-mono">
											{f}
										</li>
									))}
								</ul>
								<p className="mt-1.5 text-[12px] opacity-80">
									Removes the library copy and its AI index — your original
									files stay untouched, so you can re-import them clean
									afterwards.
								</p>
								<div className="mt-2.5 flex gap-2">
									<button
										type="button"
										disabled={deletingTruncated}
										onClick={handleDeleteTruncated}
										className="rounded-xl border border-red-500/40 bg-white/60 px-3.5 py-2 text-[13px] font-semibold text-red-700 transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50 dark:border-red-400/40 dark:bg-black/25 dark:text-red-300 dark:hover:bg-black/40"
									>
										{deletingTruncated
											? "Deleting…"
											: `Delete ${suspectedTruncatedFiles.length === 1 ? "video" : "videos"}`}
									</button>
									<button
										type="button"
										disabled={deletingTruncated}
										onClick={() => setConfirmDeleteTruncated(false)}
										className="rounded-xl border border-slate-500/30 bg-white/40 px-3.5 py-2 text-[13px] font-medium text-zinc-600 transition-colors hover:bg-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:opacity-50 dark:border-slate-600/50 dark:bg-black/25 dark:text-zinc-300 dark:hover:bg-white/10"
									>
										Keep them
									</button>
								</div>
							</div>
						)}
					</div>
				)}
				<p className="text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
					Speech index runs in the background after scene analysis — dialogue
					queries find moments by what was said (CC badge). Silent films stay
					visual-only.
				</p>
				<button
					type="button"
					onClick={handleReanalyze}
					className="mt-3 w-full rounded-xl border border-slate-500/30 bg-white/50 px-4 py-2.5 text-sm font-semibold text-zinc-700 transition-colors hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-600/50 dark:bg-black/25 dark:text-zinc-200 dark:hover:bg-white/10"
				>
					Re-analyze existing videos
				</button>
				{!confirmPurge ? (
					<button
						type="button"
						onClick={() => setConfirmPurge(true)}
						className="mt-2 w-full rounded-xl px-4 py-2 text-[13px] font-medium text-zinc-500 transition-colors hover:bg-white/60 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-red-400"
					>
						Stop background work…
					</button>
				) : (
					<div className="mt-2 rounded-xl border border-red-500/40 bg-red-500/[0.07] px-4 py-3 dark:border-red-400/30">
						<p className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">
							Stop all background work cold?
						</p>
						<p className="mt-1 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
							Drops every queued video and photo, kills stuck workers, and
							prunes leftover data for deleted files. Unfinished videos re-queue
							fresh on the next launch — nothing finished is lost.
						</p>
						<div className="mt-2.5 flex gap-2">
							<button
								type="button"
								disabled={purging}
								onClick={handlePurge}
								className="rounded-xl bg-gradient-to-b from-red-500 to-red-600 px-4 py-2 text-[13px] font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_2px_5px_rgba(239,68,68,0.4)] transition-all hover:from-red-400 hover:to-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:cursor-wait disabled:opacity-60"
							>
								{purging ? "Stopping…" : "Stop everything"}
							</button>
							<button
								type="button"
								disabled={purging}
								onClick={() => setConfirmPurge(false)}
								className="rounded-xl border border-slate-500/30 bg-white/40 px-3.5 py-2 text-[13px] font-medium text-zinc-600 transition-colors hover:bg-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:opacity-50 dark:border-slate-600/50 dark:bg-black/25 dark:text-zinc-300 dark:hover:bg-white/10"
							>
								Keep running
							</button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
