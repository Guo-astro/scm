"use client";

import type {
	Dispatch,
	PointerEvent as ReactPointerEvent,
	RefObject,
	SetStateAction,
} from "react";
import {
	IconX,
	IconPencil,
	IconChevronLeft,
	IconChevronRight,
} from "@tabler/icons-react";
import type { SavedTabMode } from "@/lib/savedSearches";

// A tab in the tab bar: a built-in category or a saved-search tab (which
// carries the search mode it was saved in, plus the YouTube watch flag).
export type Tab =
	| { id: string; label: string; isSaved: false }
	| {
			id: string;
			label: string;
			mode: SavedTabMode;
			isSaved: true;
			watch?: boolean;
	  };

// The category tab strip + the YouTube channel filter chips. Extracted from
// MasonryGrid verbatim: the component owns the markup only — tab data,
// selection, editing/removal and the overflow mechanics stay in the grid
// (useTabStrip), so the two never disagree about which tab is active.
interface TabBarProps {
	tabs: Tab[];
	activeFilter: string;
	selectTab: (tab: Tab) => void;
	openEditTab: (id: string) => void;
	handleRemoveTab: (id: string) => void;
	tabTrackRef: RefObject<HTMLDivElement | null>;
	updateTabScrollState: () => void;
	onTabTrackPointerDown: (e: ReactPointerEvent) => void;
	onTabTrackPointerMove: (e: ReactPointerEvent) => void;
	endDrag: (e: ReactPointerEvent) => void;
	scrollTabs: (dir: -1 | 1) => void;
	canScrollLeft: boolean;
	canScrollRight: boolean;
	isOverflowing: boolean;
	ytChannels: { name: string; count: number }[];
	ytChannel: string;
	setYtChannel: Dispatch<SetStateAction<string>>;
}

export default function TabBar({
	tabs,
	activeFilter,
	selectTab,
	openEditTab,
	handleRemoveTab,
	tabTrackRef,
	updateTabScrollState,
	onTabTrackPointerDown,
	onTabTrackPointerMove,
	endDrag,
	scrollTabs,
	canScrollLeft,
	canScrollRight,
	isOverflowing,
	ytChannels,
	ytChannel,
	setYtChannel,
}: TabBarProps) {
	return (
		<>
			{/* Filter tabs — fit-content shell, max 56rem; inner track scrolls past the cap */}
			<div className="mx-auto w-fit max-w-[56rem] px-4 sm:px-0">
				<div className="group/tabs relative rounded-2xl border border-slate-500/45 bg-gradient-to-b from-[#f4f7fb] via-[#d7dee7] to-[#a7b3c0] p-1.5 shadow-[0_12px_28px_rgba(15,23,42,0.22),inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-6px_12px_rgba(71,85,105,0.25)] dark:border-slate-500/70 dark:from-[#3b4450] dark:via-[#2a313b] dark:to-[#1a1f27] dark:shadow-[0_16px_32px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.1),inset_0_-6px_14px_rgba(0,0,0,0.5)] sm:rounded-[1.4rem] sm:p-1.5 overflow-hidden">
					{/* Plastic grain */}
					<div className="plastic-grain pointer-events-none absolute inset-0 rounded-2xl sm:rounded-[1.4rem]" />
					{/* Shell highlight */}
					<div className="pointer-events-none absolute inset-x-4 top-1 h-4 rounded-full bg-white/50 blur-md dark:bg-white/10" />
					<div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 rounded-b-2xl bg-gradient-to-t from-black/15 to-transparent sm:rounded-b-[1.4rem]" />

					{/* Inner bezel — holds scrollable track + fade/arrow overlays */}
					<div className="relative flex items-center rounded-xl border border-slate-500/45 bg-gradient-to-b from-[#e8edf3] to-[#b9c4d1] p-1 shadow-[inset_0_2px_2px_rgba(255,255,255,0.65),inset_0_-3px_6px_rgba(15,23,42,0.22)] dark:border-slate-600/70 dark:from-[#202833] dark:to-[#141b24] dark:shadow-[inset_0_1px_2px_rgba(255,255,255,0.08),inset_0_-4px_9px_rgba(0,0,0,0.65)] sm:rounded-2xl sm:p-1">
						{/* Left fade + arrow — hover/focus only when canScrollLeft */}
						<div
							aria-hidden="true"
							className={`pointer-events-none absolute inset-y-1 left-1 z-10 w-8 rounded-l-xl bg-gradient-to-r from-[#e8edf3] via-[#e8edf3]/80 to-transparent dark:from-[#202833] dark:via-[#202833]/80 transition-opacity duration-200 ${canScrollLeft ? "opacity-100 group-hover/tabs:opacity-100" : "opacity-0"}`}
						/>
						<button
							type="button"
							aria-label="Scroll tabs left"
							onClick={() => scrollTabs(-1)}
							className={`absolute left-1.5 top-1/2 z-20 -translate-y-1/2 rounded-full border border-slate-400/40 bg-white/90 p-1 shadow-[0_1px_4px_rgba(15,23,42,0.18)] backdrop-blur transition-all duration-200 hover:bg-white dark:border-slate-500/50 dark:bg-zinc-700/90 dark:hover:bg-zinc-600 ${canScrollLeft ? "opacity-0 pointer-events-none group-hover/tabs:opacity-100 group-hover/tabs:pointer-events-auto group-focus-within/tabs:opacity-100 group-focus-within/tabs:pointer-events-auto" : "opacity-0 pointer-events-none"}`}
						>
							<IconChevronLeft
								size={14}
								className="text-zinc-600 dark:text-zinc-200"
								aria-hidden="true"
							/>
						</button>

						{/* Scrollable track — only element that scrolls */}
						<div
							ref={tabTrackRef}
							role="tablist"
							aria-label="Memory categories"
							onScroll={updateTabScrollState}
							onPointerDown={onTabTrackPointerDown}
							onPointerMove={onTabTrackPointerMove}
							onPointerUp={endDrag}
							onPointerCancel={endDrag}
							onWheel={(e) => {
								if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && isOverflowing) {
									e.preventDefault();
									tabTrackRef.current!.scrollLeft += e.deltaY;
								}
							}}
							className={`scrollbar-hide flex flex-nowrap items-center gap-0 overflow-x-auto scroll-smooth overscroll-x-contain snap-x snap-mandatory min-w-0 flex-1 ${isOverflowing ? "justify-start" : "justify-center sm:justify-center"}`}
							style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
						>
							{tabs.map((tab) => {
								const isSelected = activeFilter === tab.id;
								return (
									// role="tab" (not <button>) so nested rename/remove
									// controls can receive real focus — focusable children
									// of a <button> are not tabbable in Chromium.
									<div
										key={tab.isSaved ? `saved:${tab.id}` : tab.id}
										data-tab-id={tab.id}
										role="tab"
										aria-selected={isSelected}
										// Roving tabindex: only the selected tab is in the
										// tab order; Arrow keys move + activate.
										tabIndex={isSelected ? 0 : -1}
										onClick={() => selectTab(tab)}
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												selectTab(tab);
												return;
											}
											if (e.key === "F2" && tab.isSaved) {
												e.preventDefault();
												openEditTab(tab.id);
												return;
											}
											if (
												(e.key === "Delete" || e.key === "Backspace") &&
												tab.isSaved
											) {
												e.preventDefault();
												handleRemoveTab(tab.id);
												return;
											}
											const focusTabs = Array.from(
												tabTrackRef.current?.querySelectorAll<HTMLElement>(
													'[role="tab"]',
												) ?? [],
											);
											const current = e.currentTarget as HTMLElement;
											const idx = focusTabs.indexOf(current);
											if (idx < 0) return;
											let next: number;
											if (e.key === "ArrowRight") {
												next = (idx + 1) % focusTabs.length;
											} else if (e.key === "ArrowLeft") {
												next = (idx - 1 + focusTabs.length) % focusTabs.length;
											} else if (e.key === "Home") {
												next = 0;
											} else if (e.key === "End") {
												next = focusTabs.length - 1;
											} else {
												return;
											}
											e.preventDefault();
											focusTabs[next]?.focus();
											const nextId =
												focusTabs[next]?.getAttribute("data-tab-id");
											const nextTab = tabs.find((t) => t.id === nextId);
											if (nextTab) selectTab(nextTab);
										}}
										title={tab.isSaved ? tab.id : undefined}
										className={`group relative flex min-w-fit cursor-pointer items-center rounded-xl px-2 py-1.5 text-xs font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 sm:px-4 sm:py-1.5 sm:text-[13px] ${
											isSelected
												? "bg-gradient-to-b from-white to-zinc-200 text-zinc-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_4px_rgba(15,23,42,0.2)] dark:from-zinc-600 dark:to-zinc-700 dark:text-white dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),0_2px_6px_rgba(0,0,0,0.4)]"
												: "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
										}`}
									>
										{tab.isSaved ? (
											<span className="flex items-center gap-0 transition-all duration-200 group-hover:gap-0.5 group-focus-within:gap-0.5">
												{tab.watch && (
													<span
														aria-label="Watched YouTube interest"
														title="Watched YouTube interest"
														className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-emerald-500"
													/>
												)}
												{tab.label}
												<button
													type="button"
													tabIndex={isSelected ? 0 : -1}
													aria-label={`Rename tab ${tab.label}`}
													title="Rename tab"
													onClick={(e) => {
														e.stopPropagation();
														openEditTab(tab.id);
													}}
													onKeyDown={(e) => {
														if (e.key === "Enter" || e.key === " ") {
															e.preventDefault();
															e.stopPropagation();
															openEditTab(tab.id);
														}
													}}
													className="flex h-4 w-4 max-w-0 min-w-0 shrink-0 items-center justify-center overflow-hidden rounded-full text-current opacity-0 transition-all duration-200 hover:!opacity-100 group-hover:max-w-4 group-hover:opacity-50 group-focus-within:max-w-4 group-focus-within:opacity-100 group-focus-visible:max-w-4 group-focus-visible:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:hover:bg-black/30 hover:bg-zinc-400/30 active:scale-90"
												>
													<IconPencil size={11} aria-hidden="true" />
												</button>
												<button
													type="button"
													tabIndex={isSelected ? 0 : -1}
													aria-label={`Remove tab ${tab.label}`}
													title="Remove tab"
													onClick={(e) => {
														e.stopPropagation();
														handleRemoveTab(tab.id);
													}}
													onKeyDown={(e) => {
														if (e.key === "Enter" || e.key === " ") {
															e.preventDefault();
															e.stopPropagation();
															handleRemoveTab(tab.id);
														}
													}}
													className="flex h-4 w-4 max-w-0 min-w-0 shrink-0 items-center justify-center overflow-hidden rounded-full text-current opacity-0 transition-all duration-200 hover:!opacity-100 group-hover:max-w-4 group-hover:opacity-50 group-focus-within:max-w-4 group-focus-within:opacity-100 group-focus-visible:max-w-4 group-focus-visible:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:hover:bg-black/30 hover:bg-zinc-400/30 active:scale-90"
												>
													<IconX size={11} aria-hidden="true" />
												</button>
											</span>
										) : (
											tab.label
										)}
									</div>
								);
							})}
						</div>

						{/* Right fade + arrow */}
						<div
							aria-hidden="true"
							className={`pointer-events-none absolute inset-y-1 right-1 z-10 w-8 rounded-r-xl bg-gradient-to-l from-[#e8edf3] via-[#e8edf3]/80 to-transparent dark:from-[#202833] dark:via-[#202833]/80 transition-opacity duration-200 ${canScrollRight ? "opacity-100 group-hover/tabs:opacity-100" : "opacity-0"}`}
						/>
						<button
							type="button"
							aria-label="Scroll tabs right"
							onClick={() => scrollTabs(1)}
							className={`absolute right-1.5 top-1/2 z-20 -translate-y-1/2 rounded-full border border-slate-400/40 bg-white/90 p-1 shadow-[0_1px_4px_rgba(15,23,42,0.18)] backdrop-blur transition-all duration-200 hover:bg-white dark:border-slate-500/50 dark:bg-zinc-700/90 dark:hover:bg-zinc-600 ${canScrollRight ? "opacity-0 pointer-events-none group-hover/tabs:opacity-100 group-hover/tabs:pointer-events-auto group-focus-within/tabs:opacity-100 group-focus-within/tabs:pointer-events-auto" : "opacity-0 pointer-events-none"}`}
						>
							<IconChevronRight
								size={14}
								className="text-zinc-600 dark:text-zinc-200"
								aria-hidden="true"
							/>
						</button>
					</div>
				</div>
			</div>

			{/* YouTube channel filter: All + per-channel chips, ranked by
				    download count. Rendered only under the YouTube tab; the
				    choice scopes both browse and search (matchesTabWithYt). */}
			{activeFilter === "YouTube" && ytChannels.length > 0 && (
				<div
					className="mt-3 flex max-w-[56rem] flex-wrap items-center justify-center gap-1.5"
					role="group"
					aria-label="Filter by channel"
				>
					<button
						type="button"
						aria-pressed={ytChannel === "All"}
						onClick={() => setYtChannel("All")}
						className={`rounded-full px-3 py-1 text-[11px] font-semibold transition-all duration-200 ${
							ytChannel === "All"
								? "bg-gradient-to-b from-white to-zinc-200 text-zinc-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_3px_rgba(15,23,42,0.2)] dark:from-zinc-600 dark:to-zinc-700 dark:text-white"
								: "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
						}`}
					>
						All channels
					</button>
					{ytChannels.map((c) => (
						<button
							key={c.name}
							type="button"
							aria-pressed={ytChannel === c.name}
							title={`${c.count} video${c.count === 1 ? "" : "s"}`}
							onClick={() =>
								setYtChannel((cur) => (cur === c.name ? "All" : c.name))
							}
							className={`max-w-[12rem] truncate rounded-full px-3 py-1 text-[11px] font-semibold transition-all duration-200 ${
								ytChannel === c.name
									? "bg-gradient-to-b from-white to-zinc-200 text-zinc-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_3px_rgba(15,23,42,0.2)] dark:from-zinc-600 dark:to-zinc-700 dark:text-white"
									: "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
							}`}
						>
							{c.name} · {c.count}
						</button>
					))}
				</div>
			)}
		</>
	);
}
