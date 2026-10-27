"use client";

import { useEffect, useRef, useState } from "react";
import {
	IconColumns,
	IconCommand,
	IconKeyboard,
	IconLanguage,
	IconLayoutNavbar,
	IconMovie,
	IconPhotoPlus,
	IconPuzzle,
	IconSparkles,
	IconSun,
	IconX,
} from "@tabler/icons-react";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { usePrefsStore } from "@/stores/usePrefsStore";
import ShortcutPanel from "./ShortcutPanel";
import EmbeddingVersionsPanel from "./EmbeddingVersionsPanel";
import MenuBarPanel from "./MenuBarPanel";
import LibrarySection from "./LibrarySection";
import AskPanel from "./AskPanel";
import YoutubePanel from "./YoutubePanel";
import AppearanceSection from "./settings/AppearanceSection";
import GridSection from "./settings/GridSection";
import PhotoSection from "./settings/PhotoSection";
import SmartTabsSection from "./settings/SmartTabsSection";
import KeyboardSection from "./settings/KeyboardSection";
import VideoSection from "./settings/VideoSection";
import { ASK_MODE_VISIBLE } from "../../shared/feature-flags.ts";

type NotifyTone = "default" | "success" | "warning" | "error";

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

// Parked sections stay in the table above (the label, icon, and body branch
// remain importable) but never reach the sidebar/picker, so reviving one is
// a flag flip in shared/feature-flags.ts. The full table stays the source of
// truth for the header title and for anything keyed by SectionId.
const VISIBLE_SECTIONS = ASK_MODE_VISIBLE
	? SECTIONS
	: SECTIONS.filter((s) => s.id !== "ai");

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
	// N-06: app version for the status bar (package.json via get-version).
	const [appVersion, setAppVersion] = useState<string | null>(null);

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

	if (!open) return null;

	const active =
		VISIBLE_SECTIONS.find((s) => s.id === activeSection) ?? SECTIONS[0];
	// SECTIONS is a static non-empty table; the check narrows for the flag.
	if (!active) return null;

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
						{VISIBLE_SECTIONS.map(({ id, label, icon: Icon, tile }) => {
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
						{VISIBLE_SECTIONS.map(({ id, label }) => (
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
							<AppearanceSection
								theme={theme}
								onThemeChange={onThemeChange}
								crtEffect={crtEffect}
								onCrtEffectChange={onCrtEffectChange}
								appIcon={appIcon}
								onAppIconChange={onAppIconChange}
								onReplayTour={onReplayTour}
								onClose={onClose}
								onNotify={onNotify}
							/>
						)}

						{activeSection === "grid" && (
							<GridSection
								gridColumns={gridColumns}
								onGridColumnsChange={onGridColumnsChange}
							/>
						)}

						{activeSection === "smart-tabs" && (
							<SmartTabsSection
								enabledTabs={enabledTabs}
								onTabToggle={onTabToggle}
								onNotify={onNotify}
							/>
						)}

						{activeSection === "photo" && (
							<PhotoSection
								ocrLangs={ocrLangs}
								onOcrLangsChange={onOcrLangsChange}
								onReocrPhotos={onReocrPhotos}
								onNotify={onNotify}
							/>
						)}

						{activeSection === "video" && (
							<VideoSection
								videoQuality={videoQuality}
								onVideoQualityChange={onVideoQualityChange}
								videoCostFacts={videoCostFacts}
								onRefreshVideoCostFacts={onRefreshVideoCostFacts}
								whisperModel={whisperModel}
								onWhisperModelChange={onWhisperModelChange}
								suspectedTruncated={suspectedTruncated}
								suspectedTruncatedFiles={suspectedTruncatedFiles}
								onRefreshSuspectedTruncated={onRefreshSuspectedTruncated}
								onReanalyzeVideos={onReanalyzeVideos}
								onNotify={onNotify}
							/>
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

						{/* Parked (ASK_MODE_VISIBLE): the section is filtered out of
						    VISIBLE_SECTIONS above, and this branch stays as the future
						    re-entry point — AskPanel is kept imported on purpose. */}
						{ASK_MODE_VISIBLE && activeSection === "ai" && (
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
							<KeyboardSection
								shortcuts={shortcuts}
								onShortcutChange={onShortcutChange}
								onResetShortcuts={onResetShortcuts}
								onNotify={onNotify}
							/>
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
