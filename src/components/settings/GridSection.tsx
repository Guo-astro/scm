"use client";

import {
	GRID_COLUMN_OPTIONS,
	type GridColumnsSetting,
} from "@/lib/gridColumns";
import { CARD } from "./card";

interface GridSectionProps {
	gridColumns: GridColumnsSetting;
	onGridColumnsChange: (next: GridColumnsSetting) => void;
}

// Grid section, extracted from SettingsSheet verbatim: the five density
// choices with their bar glyphs and the live caption.
export default function GridSection({
	gridColumns,
	onGridColumnsChange,
}: GridSectionProps) {
	return (
		<div className="mx-auto max-w-[600px] space-y-4">
			<p className="text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
				How many photos sit side by side. Auto adapts to the window size; 2–5
				lock the density.
			</p>
			<div className={CARD}>
				<div
					role="radiogroup"
					aria-label="Photos per row"
					className="grid grid-cols-5 gap-2"
				>
					{GRID_COLUMN_OPTIONS.map((value) => {
						const selected = gridColumns === value;
						const label = value === "auto" ? "Auto" : `${value} photos per row`;
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
	);
}
