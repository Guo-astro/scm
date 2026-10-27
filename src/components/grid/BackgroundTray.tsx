"use client";

import FilmGate from "../FilmGate";

// One background-work pill (scene analysis, speech transcription, OCR).
// Extracted from MasonryGrid where the three blocks were near-identical
// copies of the same shell: the caller decides *what* the tray says (title,
// filename, counter, whether a film gate belongs) and the tray owns the
// markup. Every visible string and class comes from the original blocks
// unchanged.
interface BackgroundTrayProps {
	/** Rendered as a bare boolean attribute, e.g. data-enrich-tray. */
	dataAttr: string;
	paused: boolean;
	title: string;
	filename?: string | null;
	/** Indeterminate gate when true and gatePct is null. */
	showGate?: boolean;
	gatePct?: number | null;
	/** Right-aligned counter: "3/12", "45%", "2 waiting" or "". */
	countLabel: string;
	onTogglePause: () => void;
}

export default function BackgroundTray({
	dataAttr,
	paused,
	title,
	filename,
	showGate = false,
	gatePct = null,
	countLabel,
	onTogglePause,
}: BackgroundTrayProps) {
	return (
		<div
			{...{ [dataAttr]: true }}
			className="flex w-full max-w-[56rem] items-center gap-3 rounded-2xl border border-white/10 bg-gradient-to-b from-[#0b1812]/90 to-[#040a06]/90 px-4 py-2.5 shadow-[inset_0_0_16px_rgba(84,255,138,0.06),inset_0_1px_0_rgba(255,255,255,0.06),0_4px_14px_rgba(0,0,0,0.5)]"
			aria-live="polite"
		>
			<span
				className={`h-2.5 w-2.5 shrink-0 rounded-full ${
					paused
						? "bg-zinc-500 shadow-[0_0_4px_rgba(148,163,184,0.5)]"
						: "animate-pulse bg-[var(--ai-busy)] shadow-[0_0_6px_rgba(var(--ai-busy-rgb),0.9)]"
				}`}
			/>
			<div className="min-w-0 flex-1">
				<p className="phosphor-text text-[10px] font-semibold uppercase tracking-[0.14em]">
					{title}
				</p>
				{filename && (
					<p className="phosphor-dim truncate text-xs" title={filename}>
						{filename}
					</p>
				)}
			</div>
			{showGate && (
				<FilmGate
					pct={gatePct}
					cells={12}
					className="h-1.5 w-28 shrink-0 sm:w-36"
				/>
			)}
			<span className="phosphor-dim shrink-0 font-mono text-[11px] tabular-nums">
				{countLabel}
			</span>
			<button
				type="button"
				onClick={onTogglePause}
				title={
					paused
						? "Resume background work"
						: "Pause background work (scene analysis, transcription, text reading)"
				}
				className="phosphor-dim shrink-0 rounded-full border border-white/15 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] transition-colors hover:bg-white/10"
			>
				{paused ? "Resume" : "Pause"}
			</button>
		</div>
	);
}
