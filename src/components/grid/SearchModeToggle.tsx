"use client";

import type { LlmModelInfo } from "@/types";
import LlmModelBadge from "../LlmModelBadge";

// Search-mode selector (Files / Scenes / Dialogue / OCR / LLMs). Extracted
// from MasonryGrid where the five pills were copies of the same button
// differing only in label and active flag. The active-state classes and the
// ready dot live here; the grid owns the mode state and the snap-back rules
// (a mode that cannot show the active category selects All instead).
export type SearchMode = "files" | "scenes" | "dialogue" | "ocr" | "ask";

const PILL =
	"rounded-full px-3 py-1 text-[11px] font-semibold transition-all duration-200";
const PILL_ACTIVE =
	"bg-gradient-to-b from-white to-zinc-200 text-zinc-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_3px_rgba(15,23,42,0.2)] dark:from-zinc-600 dark:to-zinc-700 dark:text-white dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),0_1px_4px_rgba(0,0,0,0.4)]";
const PILL_IDLE =
	"text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white";
const READY_DOT =
	"mr-1 inline-block h-1.5 w-1.5 rounded-full bg-[var(--ai-ready)] align-middle shadow-[0_0_5px_rgba(var(--ai-ready-rgb),0.8)]";

interface ModePillProps {
	active: boolean;
	ariaLabel: string;
	title: string;
	onClick: () => void;
	children: string;
}

function ModePill({
	active,
	ariaLabel,
	title,
	onClick,
	children,
}: ModePillProps) {
	return (
		<button
			aria-label={ariaLabel}
			title={title}
			onClick={onClick}
			className={`${PILL} ${active ? PILL_ACTIVE : PILL_IDLE} `}
		>
			{active && <span className={READY_DOT} />}
			{children}
		</button>
	);
}

interface SearchModeToggleProps {
	mode: SearchMode;
	/** Scenes and Dialogue only exist when the library has videos. */
	hasVideos: boolean;
	/** LLMs is feature-gated (Settings → Ask). */
	askEnabled: boolean;
	/** Active chat model, shown as a chip in LLMs mode. */
	llmModel: LlmModelInfo | null;
	onSelect: (mode: SearchMode) => void;
}

export default function SearchModeToggle({
	mode,
	hasVideos,
	askEnabled,
	llmModel,
	onSelect,
}: SearchModeToggleProps) {
	return (
		<div className="mr-auto flex items-center rounded-full border border-slate-500/45 bg-gradient-to-b from-[#f4f7fb] via-[#d7dee7] to-[#a7b3c0] p-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_6px_rgba(15,23,42,0.18)] dark:border-slate-500/70 dark:from-[#3b4450] dark:via-[#2a313b] dark:to-[#1a1f27] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_3px_8px_rgba(0,0,0,0.4)]">
			<ModePill
				active={mode === "files"}
				ariaLabel="File search mode"
				title="Rank whole files"
				onClick={() => onSelect("files")}
			>
				Files
			</ModePill>
			{hasVideos && (
				<ModePill
					active={mode === "scenes"}
					ariaLabel="Scenes search mode"
					title="Find exact moments inside every video"
					onClick={() => onSelect("scenes")}
				>
					Scenes
				</ModePill>
			)}
			{hasVideos && (
				<ModePill
					active={mode === "dialogue"}
					ariaLabel="Dialogue search mode"
					title="Find moments by what is said in videos (speech only)"
					onClick={() => onSelect("dialogue")}
				>
					Dialogue
				</ModePill>
			)}
			<ModePill
				active={mode === "ocr"}
				ariaLabel="OCR search mode"
				title="Find images by the text visible on them (posters, screenshots)"
				onClick={() => onSelect("ocr")}
			>
				OCR
			</ModePill>
			{askEnabled && (
				<ModePill
					active={mode === "ask"}
					ariaLabel="LLMs search mode"
					title="Answer a question from the text and speech in your library"
					onClick={() => onSelect("ask")}
				>
					LLMs
				</ModePill>
			)}
			{/* Current-model chip: appears with LLMs mode, naming the engine
			    behind the tab (green = ready, amber = still downloading). */}
			{mode === "ask" && <LlmModelBadge model={llmModel} />}
		</div>
	);
}
