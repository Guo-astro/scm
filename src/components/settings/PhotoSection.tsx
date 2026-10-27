"use client";

import { IconCheck } from "@tabler/icons-react";
import {
	OCR_LANG_BLURBS,
	OCR_LANG_GROUPS,
	OCR_LANG_LABELS,
	type OcrLangId,
} from "@/lib/ocrLangs";
import { IDLE_ROW, SELECTED_ROW } from "@/lib/rowTokens";

type NotifyTone = "default" | "success" | "warning" | "error";

interface PhotoSectionProps {
	ocrLangs: OcrLangId[];
	onOcrLangsChange: (next: OcrLangId[]) => Promise<number | null>;
	onReocrPhotos: () => Promise<number | null>;
	onNotify: (message: string, tone: NotifyTone) => void;
}

// Photo Search section, extracted from SettingsSheet verbatim: the OCR
// language checkboxes (English pinned on), the over-6-language warning,
// and the re-read action.
export default function PhotoSection({
	ocrLangs,
	onOcrLangsChange,
	onReocrPhotos,
	onNotify,
}: PhotoSectionProps) {
	return (
		<div className="mx-auto max-w-[600px] space-y-5">
			<div>
				<h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
					Text languages
				</h3>
				<p className="mt-1 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
					Which languages photo text search reads. English is always on; each
					extra language downloads once (~4MB) and slows background text
					extraction.
				</p>
				{ocrLangs.length > 6 && (
					<div
						role="note"
						className="mt-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-[13px] leading-relaxed text-amber-800 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-200"
					>
						{ocrLangs.length} languages enabled — each model adds recognition
						time, so background text extraction runs markedly slower than the
						5-language default. Keep only the languages your photos actually
						contain.
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
													onNotify(`Text languages updated.`, "default");
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
					Switching re-reads every photo in the background — old text stays
					searchable until its re-read lands. The OCR tray shows progress and
					pauses while you search.
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
	);
}
