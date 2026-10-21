"use client";

import { useEffect, useRef, useState } from "react";
import {
	IconCheck,
	IconColumns,
	IconCommand,
	IconDeviceDesktop,
	IconKeyboard,
	IconLanguage,
	IconLayoutNavbar,
	IconMicrophone,
	IconMoonStars,
	IconMovie,
	IconPhotoPlus,
	IconPlayerPlay,
	IconPuzzle,
	IconSparkles,
	IconSun,
	IconX,
} from "@tabler/icons-react";
import type { ThemeSetting } from "@/lib/theme";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { usePrefsStore } from "@/stores/usePrefsStore";
import { GRID_COLUMN_OPTIONS } from "@/lib/gridColumns";
import {
	estimateEnrichmentCost,
	formatFootage,
	formatTimeRange,
	segmentBudgetFor,
	VIDEO_PRESET_BUDGETS,
	VIDEO_QUALITY_BLURBS,
	VIDEO_QUALITY_IDS,
	type VideoQualitySetting,
} from "@/lib/videoQuality";
import { formatBytes } from "@/lib/format";
import { IDLE_ROW, SELECTED_ROW } from "@/lib/rowTokens";
import {
	WHISPER_MODEL_BLURBS,
	WHISPER_MODEL_IDS,
	WHISPER_MODEL_LABELS,
} from "@/lib/whisperModel";
import {
	OCR_LANG_BLURBS,
	OCR_LANG_GROUPS,
	OCR_LANG_LABELS,
} from "@/lib/ocrLangs";
import { APP_ICONS } from "@/lib/appIcons";
import {
	VIEW_IDS,
	displayShortcut,
	eventToAccelerator,
} from "@/lib/viewShortcuts";
import {
	GLOBAL_ACTION_IDS,
	LIGHTBOX_ACTION_IDS,
	RESERVED_SHORTCUTS,
	findConflictingShortcut,
	freePositionalDigits,
	shortcutDescription,
	shortcutLabel,
	type ShortcutId,
} from "@/lib/inAppShortcuts";
import ShortcutPanel from "./ShortcutPanel";
import EmbeddingVersionsPanel from "./EmbeddingVersionsPanel";
import MenuBarPanel from "./MenuBarPanel";
import LibrarySection from "./LibrarySection";
import AskPanel from "./AskPanel";
import YoutubePanel from "./YoutubePanel";
import {
	BUILT_IN_TABS,
	BUILT_IN_TAB_INFO,
	TOGGLEABLE_TABS,
} from "@/lib/builtInTabs";

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

interface SettingsSheetProps {
	open: boolean;
	onClose: () => void;
	/** Toast for run outcomes (or a bridge failure). */
	onNotify: (message: string, tone: NotifyTone) => void;
	/** Replay the first-run CRT tour (App's useOnboarding reset). Optional
	 *  — older callers simply don't offer the row. */
	onReplayTour?: () => void;
	/** Run the OS file-picker import (App's pickPhotos). The Library
	 *  section's primary button calls this, then refreshes its list. */
	onImport: () => Promise<void>;
	/** Jump to a YouTube interest: close Settings and run the saved search. */
	onOpenYoutubeInterest?: (prompt: string, mode: string) => void;
}

// Appearance, grid, video, whisper, OCR, icon, shortcuts, and tabs state
// lives in the prefs store (Phase 4a); the sheet reads it via selectors
// below instead of 32 drilled props.

// Appearance options in display order. The machine metaphor: daylight
// plastic, night phosphor, or whatever the room is doing.
const THEME_OPTIONS: {
	value: ThemeSetting;
	label: string;
	blurb: string;
	icon: typeof IconSun;
}[] = [
	{
		value: "light",
		label: "Light",
		blurb: "Bright, high contrast",
		icon: IconSun,
	},
	{
		value: "system",
		label: "System",
		blurb: "Follows macOS",
		icon: IconDeviceDesktop,
	},
	{
		value: "dark",
		label: "Dark",
		blurb: "Easy on the eyes at night",
		icon: IconMoonStars,
	},
];

type SectionId =
	| "library"
	| "appearance"
	| "grid"
	| "smart-tabs"
	| "photo"
	| "video"
	| "youtube"
	| "ai"
	| "shortcut"
	| "keyboard"
	| "menubar";

const SECTIONS: {
	id: SectionId;
	label: string;
	description: string;
	icon: typeof IconSun;
	/** macOS-style tinted tile behind the sidebar icon. */
	tile: string;
}[] = [
	{
		id: "library",
		label: "Library",
		description: "Photos, folders & auto-import",
		icon: IconPhotoPlus,
		tile: "from-sky-400 to-blue-600",
	},
	{
		id: "appearance",
		label: "Appearance",
		description: "Theme, app icon & CRT effect",
		icon: IconSun,
		tile: "from-amber-400 to-orange-500",
	},
	{
		id: "grid",
		label: "Grid",
		description: "Photos per row",
		icon: IconColumns,
		tile: "from-indigo-400 to-violet-600",
	},
	{
		id: "smart-tabs",
		label: "Smart Tabs",
		description: "Optional smart views on the tab bar",
		icon: IconPuzzle,
		tile: "from-teal-400 to-cyan-600",
	},
	{
		id: "photo",
		label: "Photo Search",
		description: "Text languages for OCR",
		icon: IconLanguage,
		tile: "from-cyan-400 to-sky-600",
	},
	{
		id: "video",
		label: "Video Search",
		description: "Scene density & speech",
		icon: IconMovie,
		tile: "from-violet-500 to-purple-700",
	},
	{
		id: "youtube",
		label: "YouTube",
		description: "Subscriptions & interests",
		icon: IconMovie,
		tile: "from-rose-400 to-red-600",
	},
	{
		id: "ai",
		label: "LLMs Chat",
		description: "Ask about your library",
		icon: IconSparkles,
		tile: "from-fuchsia-400 to-pink-600",
	},
	{
		id: "shortcut",
		label: "Global Shortcut",
		description: "Focus SCM from anywhere",
		icon: IconCommand,
		tile: "from-emerald-400 to-teal-600",
	},
	{
		id: "keyboard",
		label: "Keyboard",
		description: "Views, lightbox & app shortcuts",
		icon: IconKeyboard,
		tile: "from-zinc-400 to-zinc-600",
	},
	{
		id: "menubar",
		label: "Menu Bar",
		description: "Dock, login & notifications",
		icon: IconLayoutNavbar,
		tile: "from-slate-400 to-slate-600",
	},
];

const CARD =
	"rounded-2xl border border-slate-500/45 bg-gradient-to-b from-[#eef2f7] to-[#bcc7d4] p-5 shadow-[inset_0_2px_2px_rgba(255,255,255,0.65),inset_0_-3px_6px_rgba(15,23,42,0.18)] dark:border-slate-600/70 dark:from-[#232c38] dark:to-[#151c26] dark:shadow-[inset_0_1px_2px_rgba(255,255,255,0.08),inset_0_-4px_9px_rgba(0,0,0,0.65)]";

// One recordable shortcut row (Keyboard section). Shared by the three
// groups (Library views / Lightbox / App-wide) so every row renders and
// behaves identically: kbd chip, Set/Change, Clear (→ "Not set"), the
// recording state, and Esc-cancels.
function ShortcutEditorRow({
	label,
	description,
	accel,
	recording,
	onStart,
	onCancel,
	onClear,
}: {
	label: string;
	description: string;
	accel: string;
	recording: boolean;
	onStart: () => void;
	onCancel: () => void;
	onClear: () => void;
}) {
	return (
		<div className="flex items-center gap-3 rounded-xl border border-slate-500/25 bg-white/40 px-3 py-2 dark:border-slate-600/40 dark:bg-black/20">
			<span className="min-w-0 flex-1">
				<span className="block text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">
					{label}
				</span>
				<span className="block truncate text-[12px] text-zinc-500 dark:text-zinc-400">
					{description}
				</span>
			</span>
			{recording ? (
				<span className="flex shrink-0 items-center gap-2">
					<span className="animate-pulse text-[12px] font-medium text-sky-600 dark:text-sky-300">
						Press shortcut… (Esc cancels)
					</span>
					<button
						type="button"
						onClick={onCancel}
						className="shrink-0 rounded-full px-2.5 py-1 text-[12px] font-medium text-zinc-500 transition-colors hover:bg-white/70 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-200"
					>
						Cancel
					</button>
				</span>
			) : (
				<span className="flex shrink-0 items-center gap-2">
					<kbd
						className={`inline-block whitespace-nowrap rounded-lg border border-slate-500/40 bg-white/60 px-2 py-1 font-mono text-xs font-medium shadow-[inset_0_1px_0_rgba(255,255,255,0.6)] dark:border-slate-600/60 dark:bg-white/10 dark:shadow-none ${
							accel
								? "text-zinc-700 dark:text-zinc-200"
								: "text-amber-700 dark:text-amber-300"
						}`}
					>
						{accel ? displayShortcut(accel) : "Not set"}
					</kbd>
					<button
						type="button"
						onClick={onStart}
						className="shrink-0 rounded-full border border-slate-500/30 bg-white/50 px-2.5 py-1 text-[12px] font-semibold text-zinc-600 transition-colors hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-600/50 dark:bg-black/25 dark:text-zinc-200 dark:hover:bg-white/10"
					>
						{accel ? "Change" : "Set"}
					</button>
					{accel && (
						<button
							type="button"
							onClick={onClear}
							aria-label={`Clear ${label}`}
							title="Clear shortcut"
							className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-red-500/10 hover:text-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-zinc-500 dark:hover:bg-red-500/15 dark:hover:text-red-400"
						>
							<IconX size={13} aria-hidden="true" />
						</button>
					)}
				</span>
			)}
		</div>
	);
}

/** "7 – 9" when contiguous, "6, 8" otherwise (digit lists in the
 *  reference table). */
function formatDigitList(digits: number[]): string {
	if (digits.length === 0) return "";
	const contiguous = digits.every((d, i) => {
		if (i === 0) return true;
		const prev = digits[i - 1];
		return prev !== undefined && d === prev + 1;
	});
	return contiguous
		? `${digits[0]} – ${digits[digits.length - 1]}`
		: digits.join(", ");
}

interface ShortcutGroupConfig {
	title: string;
	ids: readonly ShortcutId[];
	resetLabel: string;
	onReset: () => void;
}

// The Settings window: a centered macOS-style preferences window with a
// sidebar (one concern per page) and a large, readable detail pane. Base
// type is 13–14 px — never the 10 px microcopy of the old bottom sheet.
export default function SettingsSheet({
	open,
	onClose,
	onNotify,
	onReplayTour,
	onImport,
	onOpenYoutubeInterest,
}: SettingsSheetProps) {
	const theme = usePrefsStore((s) => s.theme);
	const onThemeChange = usePrefsStore((s) => s.setTheme);
	const crtEffect = usePrefsStore((s) => s.crtEffect);
	const onCrtEffectChange = usePrefsStore((s) => s.setCrtEffect);
	const appIcon = usePrefsStore((s) => s.appIcon);
	const onAppIconChange = usePrefsStore((s) => s.setAppIcon);
	const gridColumns = usePrefsStore((s) => s.gridColumns);
	const onGridColumnsChange = usePrefsStore((s) => s.setGridColumns);
	const videoQuality = usePrefsStore((s) => s.videoQuality);
	const onVideoQualityChange = usePrefsStore((s) => s.setVideoQuality);
	const videoCostFacts = usePrefsStore((s) => s.costFacts);
	const onRefreshVideoCostFacts = usePrefsStore((s) => s.refreshCostFacts);
	const whisperModel = usePrefsStore((s) => s.whisperModel);
	const onWhisperModelChange = usePrefsStore((s) => s.setWhisperModel);
	const ocrLangs = usePrefsStore((s) => s.ocrLangs);
	const onOcrLangsChange = usePrefsStore((s) => s.setOcrLangs);
	const onReocrPhotos = usePrefsStore((s) => s.reocrPhotos);
	const onReanalyzeVideos = usePrefsStore((s) => s.reanalyzeVideos);
	const suspectedTruncated = usePrefsStore((s) => s.suspectedTruncated);
	const suspectedTruncatedFiles = usePrefsStore(
		(s) => s.suspectedTruncatedFiles,
	);
	const onRefreshSuspectedTruncated = usePrefsStore(
		(s) => s.refreshSuspectedTruncated,
	);
	const shortcuts = usePrefsStore((s) => s.shortcuts);
	const onShortcutChange = usePrefsStore((s) => s.setShortcut);
	const onResetShortcuts = usePrefsStore((s) => s.resetShortcuts);
	const enabledTabs = usePrefsStore((s) => s.enabledTabs);
	const onTabToggle = usePrefsStore((s) => s.setTabEnabled);
	const settingsDialogRef = useRef<HTMLDivElement>(null);
	useFocusTrap(settingsDialogRef, open);
	const [activeSection, setActiveSection] = useState<SectionId>("library");
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
	// N-06: app version for the status bar (package.json via get-version).
	const [appVersion, setAppVersion] = useState<string | null>(null);
	// Shortcut recording (Keyboard section): which action/view is listening
	// for its new combo, plus the last record-time refusal (reserved combo
	// or duplicate within the same scope). Capture-phase + stopPropagation
	// so the grid and lightbox dispatchers and the Esc-closes-window
	// handler never see the keys.
	const [recordingId, setRecordingId] = useState<ShortcutId | null>(null);
	const [recordError, setRecordError] = useState<string | null>(null);
	// Plain ⌘+digit combos no shortcut claims — the positional saved-tab
	// fallback the reference table documents. Reads the live map, so it
	// tracks remaps and clears automatically.
	const freeDigits = freePositionalDigits(shortcuts);
	useEffect(() => {
		if (!recordingId) return;
		const onKey = (e: KeyboardEvent) => {
			e.preventDefault();
			e.stopPropagation();
			// Bare Escape cancels recording (and must not close Settings);
			// a modified Escape (⌥⌘Esc …) is a legitimate combo and records.
			if (
				e.key === "Escape" &&
				!e.metaKey &&
				!e.ctrlKey &&
				!e.altKey &&
				!e.shiftKey
			) {
				setRecordingId(null);
				setRecordError(null);
				return;
			}
			// A live IME composition owns the keyboard — don't record its
			// intermediate keys.
			if (e.isComposing) return;
			const accel = eventToAccelerator(e);
			if (!accel) return;
			const owner = RESERVED_SHORTCUTS[accel];
			if (owner) {
				setRecordError(
					`${displayShortcut(accel)} is already ${owner} — pick another combo.`,
				);
				return;
			}
			const clash = findConflictingShortcut(recordingId, accel, shortcuts);
			if (clash) {
				setRecordError(
					`${displayShortcut(accel)} is already ${shortcutLabel(clash)} — pick another combo.`,
				);
				return;
			}
			onShortcutChange(recordingId, accel);
			setRecordingId(null);
			setRecordError(null);
			onNotify(
				`${shortcutLabel(recordingId)}: ${displayShortcut(accel)}`,
				"success",
			);
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [recordingId, shortcuts, onShortcutChange, onNotify]);

	// Escape closes the window, like any dialog.
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, onClose]);

	// The truncation scan + cost facts are cheap (sidecar metadata only) —
	// refresh both every time the window opens so the repair banner and the
	// cost line track reality (e.g. the banner clears once a re-analysis
	// has drained).
	useEffect(() => {
		if (!open) return;
		onRefreshSuspectedTruncated();
		onRefreshVideoCostFacts();
		void window.memories
			.getVersion()
			.then(setAppVersion)
			.catch(() => setAppVersion(null));
		// Stale confirm/preview state must not survive a reopen.
		setConfirmUltraPro(false);
		setCostPreview(null);
		setRecordingId(null);
		setRecordError(null);
		setConfirmDeleteTruncated(false);
		setDeletingTruncated(false);
		setConfirmPurge(false);
		setPurging(false);
		setActiveSection("library");
	}, [open, onRefreshSuspectedTruncated, onRefreshVideoCostFacts]);

	// Stay live while open: a grid-tile delete (or any other library
	// mutation outside Settings) broadcasts "library-updated" — re-run the
	// truncation scan so the repair banner tracks reality without closing
	// and reopening the sheet (same pattern as LibrarySection).
	useEffect(() => {
		if (!open) return;
		return window.memories?.onStatus?.((payload) => {
			if (payload.type === "library-updated") onRefreshSuspectedTruncated();
		});
	}, [open, onRefreshSuspectedTruncated]);

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

	if (!open) return null;

	const active = SECTIONS.find((s) => s.id === activeSection) ?? SECTIONS[0];
	// SECTIONS is a static non-empty table; the check narrows for the flag.
	if (!active) return null;

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
		<div
			className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8 [font-family:-apple-system,BlinkMacSystemFont,'SF_Pro_Text','SF_Pro_Display','Helvetica_Neue',Helvetica,Arial,sans-serif]"
			role="presentation"
		>
			{/* Dimmed backdrop — clicking it closes the window */}
			<button
				type="button"
				tabIndex={-1}
				aria-hidden="true"
				onClick={onClose}
				className="animate-fade-in absolute inset-0 cursor-default bg-black/45 backdrop-blur-[3px]"
			/>

			{/* Window: centered preferences window, not a bottom sheet.
			     Fixed to the Appearance tab's ideal height (theme + CRT + app
			     icon) so switching tabs never resizes the chrome — shorter
			     pages get whitespace, longer pages scroll internally. */}
			<div
				ref={settingsDialogRef}
				role="dialog"
				aria-modal="true"
				aria-label="Settings"
				className="animate-scale-in relative flex h-[750px] max-h-[86vh] w-full max-w-[900px] overflow-hidden rounded-2xl border border-slate-500/45 bg-gradient-to-b from-[#f4f7fb] via-[#d9e0e9] to-[#aeb9c6] shadow-[0_24px_80px_rgba(15,23,42,0.45),inset_0_1px_0_rgba(255,255,255,0.9)] dark:border-slate-500/70 dark:from-[#3b4450] dark:via-[#2a313b] dark:to-[#1a1f27] dark:shadow-[0_24px_80px_rgba(0,0,0,0.7),inset_0_1px_0_rgba(255,255,255,0.1)]"
			>
				{/* Plastic grain + shell highlight */}
				<div className="plastic-grain pointer-events-none absolute inset-0" />
				<div className="pointer-events-none absolute inset-x-10 top-0.5 h-4 rounded-full bg-white/50 blur-md dark:bg-white/10" />

				{/* ── Sidebar ─────────────────────────────────── */}
				<aside className="relative hidden w-[248px] shrink-0 flex-col border-r border-slate-500/30 bg-white/30 dark:border-slate-600/40 dark:bg-black/20 sm:flex">
					<div className="px-5 pb-3 pt-5">
						<p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500 dark:text-zinc-400">
							Settings
						</p>
						<p className="mt-1 text-[20px] font-semibold leading-tight tracking-tight text-zinc-900 dark:text-zinc-50">
							SCM
						</p>
					</div>
					<nav
						aria-label="Settings sections"
						className="flex-1 space-y-1 overflow-y-auto overflow-x-hidden px-3 pb-3 [scrollbar-gutter:stable] min-h-0"
					>
						{SECTIONS.map(({ id, label, icon: Icon, tile }) => {
							const selected = activeSection === id;
							const showDot = id === "video" && suspectedTruncated > 0;
							return (
								<button
									key={id}
									type="button"
									onClick={() => setActiveSection(id)}
									aria-current={selected ? "page" : undefined}
									className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
										selected
											? "bg-slate-900/[0.07] font-semibold text-zinc-900 dark:bg-white/[0.12] dark:text-white"
											: "font-medium text-zinc-600 hover:bg-slate-900/[0.04] dark:text-zinc-300 dark:hover:bg-white/[0.06]"
									}`}
								>
									<span
										className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-b text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_1px_2px_rgba(15,23,42,0.25)] ${tile}`}
									>
										<Icon size={17} aria-hidden="true" />
									</span>
									<span className="min-w-0 flex-1 truncate">{label}</span>
									{showDot && (
										<span
											className="h-2 w-2 shrink-0 rounded-full bg-amber-500"
											title={`${suspectedTruncated} videos need repair`}
										/>
									)}
								</button>
							);
						})}
					</nav>
					<div className="border-t border-slate-500/25 px-5 py-3.5 dark:border-slate-600/40">
						<p className="text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
							Changes save automatically.
						</p>
					</div>
				</aside>

				{/* ── Detail pane ─────────────────────────────── */}
				<div className="relative flex min-w-0 flex-1 flex-col min-h-0">
					{/* Title bar */}
					<div className="flex items-start justify-between gap-4 border-b border-slate-500/30 px-6 pb-4 pt-5 dark:border-slate-600/40">
						<div className="min-w-0">
							<p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500 dark:text-zinc-400 sm:hidden">
								Settings
							</p>
							<h2 className="truncate text-[20px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
								{active.label}
							</h2>
							<p className="mt-0.5 truncate text-[13px] text-zinc-500 dark:text-zinc-400">
								{active.description}
							</p>
						</div>
						<button
							type="button"
							onClick={onClose}
							aria-label="Close settings"
							className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-slate-500/30 bg-white/40 text-zinc-500 transition-colors hover:bg-white/80 hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-600/50 dark:bg-black/25 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-200"
						>
							<IconX size={16} aria-hidden="true" />
						</button>
					</div>

					{/* Mobile section picker (sidebar is sm+) */}
					<div className="flex gap-2 overflow-x-auto border-b border-slate-500/25 px-4 py-2.5 scrollbar-hide dark:border-slate-600/40 sm:hidden">
						{SECTIONS.map(({ id, label }) => (
							<button
								key={id}
								type="button"
								onClick={() => setActiveSection(id)}
								className={`shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
									activeSection === id
										? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900"
										: "bg-white/50 text-zinc-600 dark:bg-black/25 dark:text-zinc-300"
								}`}
							>
								{label}
							</button>
						))}
					</div>

					{/* Body — fixed chrome: only this scrolls, so tab switches never resize the window */}
					<div className="relative flex-1 overflow-y-auto overflow-x-hidden px-6 py-6 [scrollbar-gutter:stable] min-h-0">
						{activeSection === "library" && (
							<div className="mx-auto max-w-[600px] space-y-6">
								<LibrarySection
									onImport={onImport}
									onNotify={onNotify}
									hideHeader
								/>
								<EmbeddingVersionsPanel onNotify={onNotify} hideHeader />
							</div>
						)}

						{activeSection === "appearance" && (
							<div className="mx-auto max-w-[600px] space-y-6">
								<div className="space-y-4">
									<p className="text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
										Choose how SCM looks. System follows your Mac&apos;s
										appearance and switches automatically.
									</p>
									<div
										role="radiogroup"
										aria-label="Theme"
										className="grid grid-cols-1 gap-3 sm:grid-cols-3"
									>
										{THEME_OPTIONS.map(
											({ value, label, blurb, icon: Icon }) => {
												const selected = theme === value;
												return (
													<button
														key={value}
														type="button"
														role="radio"
														aria-checked={selected}
														onClick={() => onThemeChange(value)}
														className={`flex items-start gap-3 rounded-2xl border p-4 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${selected ? SELECTED_ROW : IDLE_ROW}`}
													>
														<span
															className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${
																selected
																	? "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-300"
																	: "border-slate-500/25 bg-white/50 text-zinc-500 dark:border-slate-600/50 dark:bg-black/20 dark:text-zinc-400"
															}`}
														>
															<Icon size={18} aria-hidden="true" />
														</span>
														<span className="min-w-0">
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
															<span className="mt-0.5 block text-[13px] leading-snug text-zinc-500 dark:text-zinc-400">
																{blurb}
															</span>
														</span>
													</button>
												);
											},
										)}
									</div>
								</div>

								<div className="border-t border-slate-500/25 dark:border-slate-600/40" />

								<div>
									<h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
										CRT Screen Effect
									</h3>
									<p className="mt-1 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
										Open photos &amp; videos on a retro monitor — bezel, curved
										glass, phosphor glow, and subtle flicker. Off shows a plain
										full-screen viewer.
									</p>
									<button
										type="button"
										role="switch"
										aria-checked={crtEffect}
										aria-label={`CRT screen effect — ${crtEffect ? "on" : "off"}`}
										title="Toggle the retro CRT frame in the photo/video viewer"
										onClick={() => onCrtEffectChange(!crtEffect)}
										className={`mt-3 flex w-full items-center gap-3.5 rounded-2xl border px-4 py-3.5 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${crtEffect ? SELECTED_ROW : IDLE_ROW}`}
									>
										<span
											className={`flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors ${
												crtEffect
													? "justify-end bg-sky-500"
													: "justify-start bg-zinc-400/60 dark:bg-zinc-600"
											}`}
											aria-hidden="true"
										>
											<span className="h-5 w-5 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.3)]" />
										</span>
										<span className="min-w-0 flex-1">
											<span className="block text-sm font-semibold text-zinc-800 dark:text-zinc-100">
												CRT screen effect
											</span>
											<span className="mt-0.5 block text-[13px] leading-snug text-zinc-500 dark:text-zinc-400">
												{crtEffect
													? "Viewer uses the retro monitor frame."
													: "Viewer is plain — no bezel, flicker, or glow."}
											</span>
										</span>
									</button>
								</div>

								<div className="border-t border-slate-500/25 dark:border-slate-600/40" />

								<div>
									<h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
										App Icon
									</h3>
									<p className="mt-1 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
										Pick the Dock and window icon. Applies instantly and sticks
										after restarts.
									</p>
									<div
										role="radiogroup"
										aria-label="App Icon"
										className="mt-3 grid grid-cols-3 gap-3"
									>
										{APP_ICONS.map((info) => {
											const selected = appIcon === info.id;
											return (
												<button
													key={info.id}
													type="button"
													role="radio"
													aria-checked={selected}
													aria-label={`${info.label} — ${info.blurb}`}
													title={`${info.label} — ${info.blurb}`}
													onClick={() => {
														if (info.id !== appIcon)
															void Promise.resolve(
																onAppIconChange(info.id),
															).then((res: any) => {
																if (res && res.ok === false) {
																	onNotify(
																		res.error || "Could not switch icon",
																		"warning",
																	);
																}
															});
													}}
													className={`group flex flex-col items-center gap-2 rounded-2xl border p-3 text-center transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${selected ? SELECTED_ROW : IDLE_ROW}`}
												>
													<span className="relative flex h-[64px] w-[64px] shrink-0 items-center justify-center">
														<img
															src={`/images/app-icons/${info.file}.png`}
															alt=""
															aria-hidden="true"
															className="h-full w-full object-contain drop-shadow-[0_2px_6px_rgba(15,23,42,0.18)]"
															draggable={false}
															loading="lazy"
														/>
														{selected && (
															<span className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-sky-500 text-white shadow-[0_1px_3px_rgba(0,0,0,0.3)]">
																<IconCheck
																	size={12}
																	stroke={3}
																	aria-hidden="true"
																/>
															</span>
														)}
													</span>
													<span className="flex flex-col items-center">
														<span className="text-[13px] font-semibold leading-tight text-zinc-800 dark:text-zinc-100">
															{info.label}
														</span>
														<span className="text-[11px] leading-tight text-zinc-500 dark:text-zinc-400">
															{info.blurb}
														</span>
													</span>
												</button>
											);
										})}
									</div>
									<p className="mt-2 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
										Dock updates live on macOS — while Menu Bar-only hides the
										Dock you’ll see the new icon in the menu bar immediately,
										and in the Dock after you leave that mode. Quit/reopen keeps
										your pick (Finder still shows the bundled icon when the app
										is closed).
									</p>
								</div>

								{onReplayTour && (
									<>
										<div className="border-t border-slate-500/25 dark:border-slate-600/40" />

										<div>
											<h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
												Onboarding Tour
											</h3>
											<p className="mt-1 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
												Replay the first-run CRT tour — the three demo channels
												that introduce photo search, OCR, and smart tabs.
											</p>
											<button
												type="button"
												onClick={() => {
													onClose();
													onReplayTour();
												}}
												className={`mt-3 flex w-full items-center gap-3.5 rounded-2xl border px-4 py-3.5 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${IDLE_ROW}`}
											>
												<span
													className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-500/25 bg-white/50 text-zinc-500 dark:border-slate-600/50 dark:bg-black/20 dark:text-zinc-400"
													aria-hidden="true"
												>
													<IconPlayerPlay size={18} />
												</span>
												<span className="min-w-0 flex-1">
													<span className="block text-sm font-semibold text-zinc-800 dark:text-zinc-100">
														Replay tour
													</span>
													<span className="mt-0.5 block text-[13px] leading-snug text-zinc-500 dark:text-zinc-400">
														Show the intro overlay again.
													</span>
												</span>
											</button>
										</div>
									</>
								)}
							</div>
						)}

						{activeSection === "grid" && (
							<div className="mx-auto max-w-[600px] space-y-4">
								<p className="text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
									How many photos sit side by side. Auto adapts to the window
									size; 2–5 lock the density.
								</p>
								<div className={CARD}>
									<div
										role="radiogroup"
										aria-label="Photos per row"
										className="grid grid-cols-5 gap-2"
									>
										{GRID_COLUMN_OPTIONS.map((value) => {
											const selected = gridColumns === value;
											const label =
												value === "auto" ? "Auto" : `${value} photos per row`;
											const bars = value === "auto" ? 4 : (value as number);
											return (
												<button
													key={String(value)}
													type="button"
													role="radio"
													aria-checked={selected}
													aria-label={label}
													title={label}
													onClick={() => onGridColumnsChange(value)}
													className={`flex flex-col items-center justify-center gap-1.5 rounded-xl border px-2 py-3 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
														selected
															? "border-sky-500/60 bg-gradient-to-b from-white to-[#dce6f2] text-zinc-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_1px_4px_rgba(14,165,233,0.25)] dark:border-sky-400/50 dark:from-[#2b3646] dark:to-[#1d2531] dark:text-white"
															: "border-transparent text-zinc-500 hover:bg-white/60 dark:text-zinc-400 dark:hover:bg-black/20"
													}`}
												>
													<span
														className="flex h-4 items-end gap-[3px]"
														aria-hidden="true"
													>
														{Array.from({ length: bars }).map((_, i) => (
															<span
																key={i}
																className={`w-[3px] rounded-full ${selected ? "bg-sky-500" : "bg-current opacity-50"}`}
																style={{ height: `${8 + ((i * 5) % 8)}px` }}
															/>
														))}
													</span>
													<span className="text-[13px] font-semibold">
														{value === "auto" ? "Auto" : value}
													</span>
												</button>
											);
										})}
									</div>
									<p className="mt-3 border-t border-slate-500/20 pt-3 text-[13px] leading-relaxed text-zinc-500 dark:border-slate-600/30 dark:text-zinc-400">
										{gridColumns === "auto"
											? "Auto keeps tiles at a comfortable size no matter how you resize the window."
											: `Locked to ${gridColumns} across — the window never squeezes tiles below a readable size.`}
									</p>
								</div>
							</div>
						)}

						{activeSection === "smart-tabs" && (
							<div className="mx-auto max-w-[600px] space-y-4">
								<p className="text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
									Smart tabs are optional browse views on the tab bar. Turn off
									the ones you don&apos;t use — the photos stay in your library
									under All.
								</p>
								<div role="group" aria-label="Smart tabs" className="space-y-2">
									{TOGGLEABLE_TABS.map((id) => {
										const info = BUILT_IN_TAB_INFO[id];
										const on = enabledTabs.has(id);
										return (
											<button
												key={id}
												type="button"
												role="switch"
												aria-checked={on}
												aria-label={`${info.label} tab — ${info.blurb}`}
												title={info.blurb}
												onClick={() => {
													onTabToggle(id, !on);
													onNotify(
														on
															? `${info.label} tab hidden — turn it back on here any time.`
															: `${info.label} tab shown on the tab bar.`,
														"default",
													);
												}}
												className={`flex w-full items-center gap-3.5 rounded-2xl border px-4 py-3.5 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${on ? SELECTED_ROW : IDLE_ROW}`}
											>
												<span
													className={`flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors ${
														on
															? "justify-end bg-sky-500"
															: "justify-start bg-zinc-400/60 dark:bg-zinc-600"
													}`}
													aria-hidden="true"
												>
													<span className="h-5 w-5 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.3)]" />
												</span>
												<span className="min-w-0 flex-1">
													<span className="block text-sm font-semibold text-zinc-800 dark:text-zinc-100">
														{info.label}
													</span>
													<span className="mt-0.5 block text-[13px] leading-snug text-zinc-500 dark:text-zinc-400">
														{info.blurb}
													</span>
												</span>
											</button>
										);
									})}
								</div>
								<div className={CARD}>
									<h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
										Always on
									</h3>
									<p className="mt-1 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
										These tabs are part of the core browse experience and
										can&apos;t be hidden.
									</p>
									<div className="mt-3 flex flex-wrap gap-2">
										{BUILT_IN_TABS.filter(
											(id) => BUILT_IN_TAB_INFO[id].alwaysOn,
										).map((id) => (
											<span
												key={id}
												className="rounded-full border border-slate-500/25 bg-white/40 px-3 py-1 text-[13px] font-medium text-zinc-600 dark:border-slate-600/40 dark:bg-black/20 dark:text-zinc-300"
											>
												{BUILT_IN_TAB_INFO[id].label} · Always on
											</span>
										))}
									</div>
								</div>
							</div>
						)}

						{activeSection === "photo" && (
							<div className="mx-auto max-w-[600px] space-y-5">
								<div>
									<h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
										Text languages
									</h3>
									<p className="mt-1 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
										Which languages photo text search reads. English is always
										on; each extra language downloads once (~4MB) and slows
										background text extraction.
									</p>
									{ocrLangs.length > 6 && (
										<div
											role="note"
											className="mt-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-[13px] leading-relaxed text-amber-800 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-200"
										>
											{ocrLangs.length} languages enabled — each model adds
											recognition time, so background text extraction runs
											markedly slower than the 5-language default. Keep only the
											languages your photos actually contain.
										</div>
									)}
									<div
										role="group"
										aria-label="OCR text languages"
										className="mt-3 space-y-5"
									>
										<div className="flex w-full items-center gap-3.5 rounded-2xl border border-slate-500/25 bg-white/40 px-4 py-3.5 dark:border-slate-600/40 dark:bg-black/20">
											<span
												className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 border-sky-500 bg-sky-500 text-white"
												aria-hidden="true"
											>
												<IconCheck size={12} stroke={3} />
											</span>
											<span className="min-w-0 flex-1">
												<span className="block text-sm font-semibold text-zinc-800 dark:text-zinc-100">
													English
												</span>
												<span className="mt-0.5 block text-[13px] text-zinc-500 dark:text-zinc-400">
													Always on · ~5MB
												</span>
											</span>
										</div>
										{OCR_LANG_GROUPS.map((group) => (
											<fieldset key={group.id} className="space-y-2">
												<legend className="px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500 dark:text-zinc-400">
													{group.label}
												</legend>
												{group.langs.map(({ id: value }) => {
													const selected = ocrLangs.includes(value);
													return (
														<button
															key={value}
															type="button"
															role="checkbox"
															aria-checked={selected}
															aria-label={`${OCR_LANG_LABELS[value]} — ${OCR_LANG_BLURBS[value]}`}
															title={OCR_LANG_BLURBS[value]}
															onClick={() => {
																const next = selected
																	? ocrLangs.filter((l) => l !== value)
																	: [...ocrLangs, value];
																void onOcrLangsChange(next).then((queued) => {
																	if (queued === null) {
																		onNotify(
																			"Could not switch text languages",
																			"warning",
																		);
																	} else if (queued === 0) {
																		onNotify(
																			`Text languages updated.`,
																			"default",
																		);
																	} else {
																		onNotify(
																			`Text languages updated — re-reading ${queued} photo${queued === 1 ? "" : "s"} in the background`,
																			"success",
																		);
																	}
																});
															}}
															className={`flex w-full items-center gap-3.5 rounded-2xl border px-4 py-3 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${selected ? SELECTED_ROW : IDLE_ROW}`}
														>
															<span
																className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition-colors ${
																	selected
																		? "border-sky-500 bg-sky-500 text-white"
																		: "border-zinc-400 text-transparent dark:border-zinc-500"
																}`}
																aria-hidden="true"
															>
																<IconCheck size={12} stroke={3} />
															</span>
															<span className="min-w-0 flex-1">
																<span className="block text-sm font-semibold text-zinc-800 dark:text-zinc-100">
																	{OCR_LANG_LABELS[value]}
																</span>
																<span className="mt-0.5 block text-[13px] text-zinc-500 dark:text-zinc-400">
																	{OCR_LANG_BLURBS[value]}
																</span>
															</span>
														</button>
													);
												})}
											</fieldset>
										))}
									</div>
									<p className="mt-3 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
										Switching re-reads every photo in the background — old text
										stays searchable until its re-read lands. The OCR tray shows
										progress and pauses while you search.
									</p>
									<button
										type="button"
										onClick={() => {
											void onReocrPhotos().then((queued) => {
												if (queued === null) {
													onNotify("Could not re-read photos", "warning");
												} else if (queued === 0) {
													onNotify("No photos to re-read", "default");
												} else {
													onNotify(
														`Re-reading ${queued} photo${queued === 1 ? "" : "s"} under the current text languages — watch the OCR tray`,
														"success",
													);
												}
											});
										}}
										className="mt-3 w-full rounded-xl border border-slate-500/30 bg-white/50 px-4 py-2.5 text-sm font-semibold text-zinc-700 transition-colors hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-600/50 dark:bg-black/25 dark:text-zinc-200 dark:hover:bg-white/10"
									>
										Re-read all photos
									</button>
								</div>
							</div>
						)}

						{activeSection === "video" && (
							<div className="mx-auto max-w-[640px] space-y-5">
								<div>
									<h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
										Scene density
									</h3>
									<p className="mt-1 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
										How closely new videos are analyzed for scene search. Denser
										finds more moments but costs more background time and disk.
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
												Ultra Pro doubles scene-analysis time and disk for your
												library (see the cost line below). Use it?
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
													A 90-min film on {VIDEO_QUALITY_LABELS[costQuality]}:
													roughly{" "}
													{formatTimeRange(costEstimate.timeMinutes) ??
														"under a minute"}{" "}
													of background time and ~
													{formatBytes(costEstimate.diskBytes)} of disk.
												</>
											) : (
												<>
													{VIDEO_QUALITY_LABELS[costQuality]} across your{" "}
													{videoCostFacts!.videoCount} video
													{videoCostFacts!.videoCount === 1 ? "" : "s"} (
													{formatFootage(videoCostFacts!.knownSeconds) ??
														"no measured footage"}
													): roughly{" "}
													{formatTimeRange(costEstimate.timeMinutes) ??
														"under a minute"}{" "}
													of background time and ~
													{formatBytes(costEstimate.diskBytes)} of disk.
													{capSentence}
													{unknownSentence} Runs in chunks, pauses while you
													search, and re-analysis is resumable.
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
										The whisper engine for dialogue search. Switching
										re-transcribes every video in the background. Multilingual
										models auto-detect the spoken language per video; the
										English-only models stay the fastest, most accurate pick for
										English dialogue.
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
															void onWhisperModelChange(value).then(
																(queued) => {
																	if (queued === null) {
																		onNotify(
																			"Could not switch speech model",
																			"warning",
																		);
																	} else if (queued === 0) {
																		onNotify(
																			`Speech model: ${label}.`,
																			"default",
																		);
																	} else {
																		onNotify(
																			`Speech model: ${label} — re-transcribing ${queued} video${queued === 1 ? "" : "s"} in the background`,
																			"success",
																		);
																	}
																},
															);
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
											{suspectedTruncated === 1 ? "s" : "re"} analyzed before
											the scene-search fix — scene search only covers their
											final minutes. Re-analyze below to repair.
											{suspectedTruncatedFiles.length > 0 &&
												!confirmDeleteTruncated && (
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
											{confirmDeleteTruncated &&
												suspectedTruncatedFiles.length > 0 && (
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
																<li
																	key={f}
																	title={f}
																	className="truncate font-mono"
																>
																	{f}
																</li>
															))}
														</ul>
														<p className="mt-1.5 text-[12px] opacity-80">
															Removes the library copy and its AI index — your
															original files stay untouched, so you can
															re-import them clean afterwards.
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
										Speech index runs in the background after scene analysis —
										dialogue queries find moments by what was said (CC badge).
										Silent films stay visual-only.
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
												Drops every queued video and photo, kills stuck workers,
												and prunes leftover data for deleted files. Unfinished
												videos re-queue fresh on the next launch — nothing
												finished is lost.
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
						)}

						{activeSection === "youtube" && (
							<div className="mx-auto max-w-[600px]">
								<YoutubePanel
									onNotify={(message) => onNotify(message, "default")}
									onOpenInterest={(prompt, mode) => {
										if (onOpenYoutubeInterest) {
											onOpenYoutubeInterest(prompt, mode);
										} else {
											onClose();
										}
									}}
								/>
							</div>
						)}

						{activeSection === "ai" && (
							<div className="mx-auto max-w-[600px]">
								<AskPanel onNotify={onNotify} />
							</div>
						)}

						{activeSection === "shortcut" && (
							<div className="mx-auto max-w-[600px]">
								<ShortcutPanel onNotify={onNotify} hideHeader />
							</div>
						)}

						{activeSection === "menubar" && (
							<div className="mx-auto max-w-[600px]">
								<MenuBarPanel onNotify={onNotify} hideHeader />
							</div>
						)}

						{activeSection === "keyboard" && (
							<div className="mx-auto max-w-[600px] space-y-4">
								<p className="text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
									Record, remap, or clear any combo below — a bare key (←, →,
									Esc) comes back with Reset. Combos owned by the OS, the menu,
									or another shortcut in the same group are refused with a
									message naming the owner.
								</p>
								{/* Three recordable groups. Library views and the
								    app-wide actions share one conflict scope (both
								    handlers are always live); the lightbox actions
								    are scoped to the open viewer, so a lightbox
								    combo may overlap an app one — ⌘I is the
								    built-in example (AI Insights inside, Import
								    outside). The grid/lightbox dispatchers consume
								    their own combos first, so only one meaning can
								    ever fire per keypress. */}
								{(
									[
										{
											title: "Library views",
											ids: VIEW_IDS,
											resetLabel: "Reset to ⌘1–6",
											onReset: () => {
												onResetShortcuts(VIEW_IDS);
												setRecordingId(null);
												setRecordError(null);
												onNotify(
													"Library view shortcuts reset to defaults",
													"default",
												);
											},
										},
										{
											title: "Lightbox",
											ids: LIGHTBOX_ACTION_IDS,
											resetLabel: "Reset",
											onReset: () => {
												onResetShortcuts(LIGHTBOX_ACTION_IDS);
												setRecordingId(null);
												setRecordError(null);
												onNotify(
													"Lightbox shortcuts reset to ← → Esc ⌘I",
													"default",
												);
											},
										},
										{
											title: "App-wide",
											ids: GLOBAL_ACTION_IDS,
											resetLabel: "Reset",
											onReset: () => {
												onResetShortcuts(GLOBAL_ACTION_IDS);
												setRecordingId(null);
												setRecordError(null);
												onNotify("App shortcuts reset to ⌘, and ⌘I", "default");
											},
										},
									] as ShortcutGroupConfig[]
								).map((group) => (
									<div className={CARD} key={group.title}>
										<div className="flex items-center justify-between gap-3">
											<h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
												{group.title}
											</h3>
											<button
												type="button"
												onClick={group.onReset}
												className="shrink-0 rounded-full px-3 py-1 text-[12px] font-medium text-zinc-500 transition-colors hover:bg-white/70 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-200"
											>
												{group.resetLabel}
											</button>
										</div>
										<div className="mt-3 space-y-2">
											{group.ids.map((id) => (
												<ShortcutEditorRow
													key={id}
													label={shortcutLabel(id)}
													description={shortcutDescription(id)}
													accel={shortcuts[id]}
													recording={recordingId === id}
													onStart={() => {
														setRecordError(null);
														setRecordingId(id);
													}}
													onCancel={() => {
														setRecordingId(null);
														setRecordError(null);
													}}
													onClear={() => {
														onShortcutChange(id, "");
														setRecordError(null);
														if (recordingId === id) setRecordingId(null);
														onNotify(`${shortcutLabel(id)} cleared`, "default");
													}}
												/>
											))}
										</div>
										{/* Refusals surface in the group being
										    recorded — the only place the message
										    can act on. */}
										{recordError &&
											group.ids.some((id) => id === recordingId) && (
												<div className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 dark:border-amber-500/30 dark:bg-amber-500/10">
													<p className="text-[13px] font-medium text-amber-700 dark:text-amber-300">
														{recordError}
													</p>
												</div>
											)}
									</div>
								))}
								{/* Reference table — what the recorder deliberately
								    does NOT own: menu items, OS window chrome, the
								    Edit roles, and the positional saved-tab
								    fallback. The digit line reads the live map so
								    it tracks remaps and clears. */}
								<div className={CARD}>
									<table className="w-full text-sm">
										<tbody>
											{[
												["⌘ O", "Import photos (menu)"],
												...(freeDigits.length > 0
													? [
															[
																`⌘ ${formatDigitList(freeDigits)}`,
																"Switch to saved tabs (positional)",
															],
														]
													: []),
												["⌘ Q / ⌘ W", "Quit / close window"],
												["⌘ Z X C V A", "Undo, cut, copy, paste, select all"],
												["Ctrl ⌘ F", "Full screen"],
												["Esc", "Close a dialog or menu"],
											].map(([key, desc]) => (
												<tr
													key={desc}
													className="border-b border-slate-500/20 last:border-0 dark:border-slate-600/30"
												>
													<td className="py-2.5 pr-4 align-middle">
														<kbd className="inline-block whitespace-nowrap rounded-lg border border-slate-500/40 bg-white/60 px-2 py-1 font-mono text-xs font-medium text-zinc-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.6)] dark:border-slate-600/60 dark:bg-white/10 dark:text-zinc-200 dark:shadow-none">
															{key}
														</kbd>
													</td>
													<td className="py-2.5 text-[13px] text-zinc-600 dark:text-zinc-300">
														{desc}
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							</div>
						)}
					</div>

					{/* Status bar */}
					<div className="flex items-center justify-between gap-3 border-t border-slate-500/30 px-6 py-3 dark:border-slate-600/40">
						<p className="truncate text-[12px] text-zinc-500 dark:text-zinc-400">
							Press{" "}
							<kbd className="rounded border border-slate-500/40 bg-white/50 px-1 font-mono text-[11px] dark:border-slate-600/60 dark:bg-black/25">
								⌘ ,
							</kbd>{" "}
							or{" "}
							<kbd className="rounded border border-slate-500/40 bg-white/50 px-1 font-mono text-[11px] dark:border-slate-600/60 dark:bg-black/25">
								Esc
							</kbd>{" "}
							to close
						</p>
						<p className="hidden shrink-0 text-[12px] text-zinc-400 sm:block dark:text-zinc-500">
							{videoCostFacts
								? `${videoCostFacts.videoCount} videos indexed`
								: "SCM Settings"}
							{appVersion ? ` · v${appVersion}` : ""}
						</p>
					</div>
				</div>
			</div>
		</div>
	);
}
