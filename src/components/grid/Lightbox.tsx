"use client";

import { useRef } from "react";
import { IconChevronLeft, IconChevronRight, IconFolderOpen, IconX } from "@tabler/icons-react";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import AiInsightsPanel from "../AiInsightsPanel";
import { EmailRow } from "../EmailContact";
import { formatEmailEvidence, type EmailMatch } from "@/lib/emailAddress";
import { formatTimecode } from "@/lib/media";
import type { DisplayItem } from "../MasonryGrid";

interface LightboxProps {
	image: DisplayItem;
	media: React.ReactNode;
	total: number;
	onClose: () => void;
	onPrev: () => void;
	onNext: () => void;
	onTouchStart: (e: React.TouchEvent) => void;
	onTouchMove: (e: React.TouchEvent) => void;
	onTouchEnd: () => void;
	crtEffect: boolean;
	onReveal: (filename: string) => void;
	isVideo: boolean;
	videoPlayable: boolean;
	aiInsightsOpen: boolean;
}

export default function Lightbox({
	image,
	media,
	total,
	onClose,
	onPrev,
	onNext,
	onTouchStart,
	onTouchMove,
	onTouchEnd,
	crtEffect,
	onReveal,
	isVideo,
	videoPlayable,
	aiInsightsOpen,
}: LightboxProps) {
	const lightboxRef = useRef<HTMLDivElement>(null);
	useFocusTrap(lightboxRef, true);
	return (

				<div
					ref={lightboxRef}
					role="dialog"
					aria-modal="true"
					aria-label={`Photo: ${image.filename}`}
					className="animate-fade-in fixed inset-0 z-50 flex touch-pan-y items-center justify-center p-4"
					onClick={onClose}
					onTouchStart={onTouchStart}
					onTouchMove={onTouchMove}
					onTouchEnd={onTouchEnd}
				>
					{/* Backdrop with blur */}
					<div className="absolute inset-0 bg-black/80 backdrop-blur-2xl dark:bg-black/90" />

					{/* Close button */}
					<button
						data-autofocus
						type="button"
						onClick={onClose}
						className="absolute right-4 top-4 z-50 flex h-10 w-10 items-center justify-center rounded-full border border-slate-500/45 bg-gradient-to-b from-[#eef3f9] to-[#c3cdda] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_4px_rgba(15,23,42,0.3)] transition-all duration-200 hover:scale-110 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_4px_8px_rgba(15,23,42,0.2)] active:shadow-[inset_0_2px_4px_rgba(15,23,42,0.3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-600/70 dark:from-[#252d38] dark:to-[#151b24] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_3px_8px_rgba(0,0,0,0.5)] sm:right-6 sm:top-6"
						aria-label="Close"
					>
						<IconX size={20} className="text-zinc-700 dark:text-zinc-300" />
					</button>

					{/* Navigation buttons */}
					{total > 1 && (
						<>
							<button
								onClick={(e) => {
									e.stopPropagation();
									onPrev();
								}}
								className="absolute left-4 top-1/2 z-50 hidden h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full border border-slate-500/45 bg-gradient-to-b from-[#eef3f9] to-[#c3cdda] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_4px_rgba(15,23,42,0.3)] transition-all duration-200 hover:scale-110 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_4px_8px_rgba(15,23,42,0.2)] active:shadow-[inset_0_2px_4px_rgba(15,23,42,0.3)] dark:border-slate-600/70 dark:from-[#252d38] dark:to-[#151b24] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_3px_8px_rgba(0,0,0,0.5)] sm:left-8 md:flex"
								aria-label="Previous image"
							>
								<IconChevronLeft
									size={24}
									className="text-zinc-700 dark:text-zinc-300"
								/>
							</button>
							<button
								onClick={(e) => {
									e.stopPropagation();
									onNext();
								}}
								className="absolute right-4 top-1/2 z-50 hidden h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full border border-slate-500/45 bg-gradient-to-b from-[#eef3f9] to-[#c3cdda] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_4px_rgba(15,23,42,0.3)] transition-all duration-200 hover:scale-110 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_4px_8px_rgba(15,23,42,0.2)] active:shadow-[inset_0_2px_4px_rgba(15,23,42,0.3)] dark:border-slate-600/70 dark:from-[#252d38] dark:to-[#151b24] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_3px_8px_rgba(0,0,0,0.5)] sm:right-8 md:flex"
								aria-label="Next image"
							>
								<IconChevronRight
									size={24}
									className="text-zinc-700 dark:text-zinc-300"
								/>
							</button>
						</>
					)}

					{/* Show in Finder — reveals the real on-disk file in the OS
					    file manager (source path if still present, else the app's
					    library copy). */}
					<button
						onClick={(e) => {
							e.stopPropagation();
							onReveal(image.filename);
						}}
						className="absolute bottom-6 left-6 z-50 flex items-center gap-2 rounded-full border border-slate-500/45 bg-gradient-to-b from-[#eef3f9] to-[#c3cdda] px-4 py-2 text-xs font-medium text-zinc-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_4px_rgba(15,23,42,0.3)] transition-all duration-200 hover:scale-105 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_4px_8px_rgba(15,23,42,0.2)] active:shadow-[inset_0_2px_4px_rgba(15,23,42,0.3)] dark:border-slate-600/70 dark:from-[#252d38] dark:to-[#151b24] dark:text-zinc-300 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_3px_8px_rgba(0,0,0,0.5)]"
						title="Reveal this file in Finder"
					>
						<IconFolderOpen
							size={15}
							className="text-zinc-600 dark:text-zinc-400"
							aria-hidden="true"
						/>
						Show in Finder
					</button>

					{/* Main image container */}
					<div
						className="animate-scale-in relative z-10 max-h-[90vh] max-w-[95vw]"
						onClick={(e) => e.stopPropagation()}
					>
						{crtEffect ? (
							<>
								{/* Outer shell */}
								<div className="relative rounded-2xl border border-slate-500/45 bg-gradient-to-b from-[#f4f7fb] via-[#d7dee7] to-[#a7b3c0] p-2 shadow-[0_24px_50px_rgba(15,23,42,0.18),inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-10px_18px_rgba(71,85,105,0.25)] dark:border-slate-500/70 dark:from-[#3b4450] dark:via-[#2a313b] dark:to-[#1a1f27] dark:shadow-[0_24px_50px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.1),inset_0_-10px_18px_rgba(0,0,0,0.5)] sm:rounded-[1.6rem] sm:p-3">
									{/* Plastic grain */}
									<div className="plastic-grain pointer-events-none absolute inset-0 rounded-2xl sm:rounded-[1.6rem]" />
									{/* Shell highlight */}
									<div className="pointer-events-none absolute inset-x-4 top-0.5 h-3 rounded-full bg-white/50 blur-md dark:bg-white/8" />
									{/* Bottom lip */}
									<div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 rounded-b-2xl bg-gradient-to-t from-black/15 to-transparent sm:rounded-b-[1.6rem]" />

									{/* Inner bezel */}
									<div className="relative rounded-xl border border-slate-500/45 bg-[#edf2f8] p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.65),inset_0_-2px_4px_rgba(15,23,42,0.15)] dark:border-slate-600/70 dark:bg-[#0a0a0a] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),inset_0_-2px_6px_rgba(0,0,0,0.5)] sm:rounded-2xl sm:p-1.5">
										{/* CRT screen */}
										<div className="relative overflow-hidden rounded-lg border border-white/15 bg-[#060606] shadow-[inset_0_0_1px_rgba(255,255,255,0.16),inset_0_0_90px_rgba(0,0,0,0.9)] sm:rounded-xl">
											{/* Screen curvature */}
											<div className="pointer-events-none absolute inset-0 z-10 rounded-lg shadow-[inset_0_0_110px_rgba(0,0,0,0.7),inset_0_0_40px_rgba(58,58,58,0.2)]" />
											<div className="pointer-events-none absolute inset-x-10 top-2 z-10 h-8 rounded-full bg-white/5 blur-md" />

											{/* Screen glow — phosphor family, matching the CRT themes */}
											<div className="pointer-events-none absolute inset-0 z-10 bg-gradient-to-br from-emerald-400/[0.05] via-transparent to-cyan-300/[0.05]" />
											<div className="crt-flicker pointer-events-none absolute inset-0 z-10" />

											{/* Scene chip: explains why a search-opened video
											    started mid-way through. */}
											{isVideo && videoPlayable && image.scene && (
												<div className="pointer-events-none absolute left-1/2 top-6 z-20 -translate-x-1/2">
													<span className="phosphor-text rounded-full border border-[rgba(144,255,169,0.25)] bg-black/70 px-3 py-1 text-[11px] font-semibold shadow-[0_2px_10px_rgba(0,0,0,0.5)]">
														Jumped to scene{" "}
														{formatTimecode(image.scene.t)}
													</span>
												</div>
											)}

											{/* Image */}
											<div className="relative z-[5] flex items-center justify-center p-2 sm:p-4">
												{media}
											</div>
										</div>
									</div>
								</div>
							</>
						) : (
							/* Plain mode: no bezel, no CRT screen, no overlays —
							   just the media on the lightbox backdrop. */
							<div className="relative flex items-center justify-center">
								{isVideo && videoPlayable && image.scene && (
									<div className="pointer-events-none absolute left-1/2 top-6 z-20 -translate-x-1/2">
										<span className="phosphor-text rounded-full border border-[rgba(144,255,169,0.25)] bg-black/70 px-3 py-1 text-[11px] font-semibold shadow-[0_2px_10px_rgba(0,0,0,0.5)]">
											Jumped to scene {formatTimecode(image.scene.t)}
										</span>
									</div>
								)}
								{media}
							</div>
						)}
						{/* Addresses read off the photo — full list with copy,
						    so the lightbox answers "which email?" without
						    squinting at the pixels. Shown whenever the photo
						    carries addresses, whatever tab opened it. */}
						{image.emailAddresses &&
							image.emailAddresses.length > 0 && (
								<LightboxEmailBar
									addresses={image.emailAddresses}
									matches={image.emailMatches ?? []}
								/>
							)}
					</div>

					{/* AI Insights panel (⌘I to toggle) */}
					<AiInsightsPanel
						filename={image.filename}
						open={aiInsightsOpen}
					/>

					{/* Navigation hints */}
					<div className="absolute bottom-6 right-6 z-50 hidden rounded-full border border-slate-500/30 bg-gradient-to-b from-[#eef3f9]/90 to-[#c3cdda]/90 px-4 py-2 text-xs text-zinc-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_2px_4px_rgba(15,23,42,0.2)] dark:border-slate-600/50 dark:from-[#252d38]/90 dark:to-[#151b24]/90 dark:text-zinc-400 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_3px_6px_rgba(0,0,0,0.4)] sm:block">
						Use &larr; &rarr; to navigate, ESC to close
					</div>

					{/* Mobile swipe hint */}
					<div className="absolute bottom-6 right-6 z-50 block rounded-full border border-slate-500/30 bg-gradient-to-b from-[#eef3f9]/90 to-[#c3cdda]/90 px-4 py-2 text-xs text-zinc-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_2px_4px_rgba(15,23,42,0.2)] dark:border-slate-600/50 dark:from-[#252d38]/90 dark:to-[#151b24]/90 dark:text-zinc-400 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_3px_6px_rgba(0,0,0,0.4)] sm:hidden">
						&larr; Swipe to navigate &rarr;
					</div>
				</div>
			
	);
}

// Contact sheet under the lightbox media — the full address list at large
// size (copy + compose per row), so the lightbox answers
// "which email?" without squinting at pixels. Shown whenever the opened
// photo carries addresses, whatever tab opened it.
function LightboxEmailBar({
	addresses,
	matches = [],
}: {
	addresses: string[];
	matches?: EmailMatch[];
}) {
	const evidence = new Map(matches.map((m) => [m.address, m]));
	return (
		<div className="mt-3 flex justify-center">
			<div className="w-fit max-w-full rounded-2xl border border-white/15 bg-black/70 px-3 py-2.5 shadow-[0_8px_24px_rgba(0,0,0,0.5)] backdrop-blur-md">
				<p className="mb-1.5 px-0.5 text-[9px] font-bold uppercase tracking-[0.16em] text-sky-200/70">
					Email{addresses.length > 1 ? "s" : ""} on this photo
				</p>
				<div className="flex max-w-[min(78vw,26rem)] flex-col gap-1.5">
					{addresses.map((email) => {
						const match = evidence.get(email);
						return (
							<EmailRow
								key={email}
								email={email}
								evidenceTitle={match ? formatEmailEvidence(match) : undefined}
							/>
						);
					})}
				</div>
			</div>
		</div>
	);
}
