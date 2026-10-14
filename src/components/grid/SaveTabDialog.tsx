"use client";

import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { normalizePrompt, type SavedTabMode } from "@/lib/savedSearches";

// Dialog shown when the user clicks "Save as tab" (create) or a saved
// tab's pencil (edit): the tab's display name defaults to the query (or
// keeps its current name when editing) but can be anything, and the search
// mode can be picked too. Enter or clicking Save confirms; Escape or
// clicking the backdrop cancels.
function SaveTabDialog({
	title,
	query,
	defaultName,
	defaultMode,
	defaultWatch = false,
	onSave,
	onCancel,
}: {
	title: string;
	/** The underlying search query this tab runs — fixed, shown for context. */
	query: string;
	defaultName: string;
	defaultMode: SavedTabMode;
	defaultWatch?: boolean;
	onSave: (label: string, mode: SavedTabMode, watch?: boolean) => void;
	onCancel: () => void;
}) {
	const [name, setName] = useState(defaultName);
	const [mode, setMode] = useState<SavedTabMode>(defaultMode);
	const [watch, setWatch] = useState(defaultWatch);
	const inputRef = useRef<HTMLInputElement>(null);
	const dialogRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		inputRef.current?.focus();
		inputRef.current?.select();
	}, []);
	useFocusTrap(dialogRef, true);

	const trimmed = normalizePrompt(name);
	const submit = () => {
		if (!trimmed) return;
		onSave(trimmed, mode, watch);
	};

	const modeOptions: { id: SavedTabMode; label: string }[] = [
		{ id: "files", label: "Files" },
		{ id: "scenes", label: "Scenes" },
		{ id: "ocr", label: "OCR" },
		{ id: "dialogue", label: "Dialogue" },
	];

	return (
		<div
			className="animate-fade-in fixed inset-0 z-[60] flex items-center justify-center p-4"
			role="presentation"
		>
			{/* Backdrop — click to cancel */}
			<div
				className="absolute inset-0 bg-black/60 backdrop-blur-sm"
				onClick={onCancel}
			/>
			{/* Dialog shell: the plastic projector bezel language of the
			    tab bar and search bar. */}
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-label="Name this tab"
				className="relative w-full max-w-sm animate-scale-in rounded-3xl border border-slate-500/45 bg-gradient-to-b from-[#f4f7fb] via-[#d7dee7] to-[#a7b3c0] p-2 shadow-[0_24px_50px_rgba(15,23,42,0.35),inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-10px_18px_rgba(71,85,105,0.25)] dark:border-slate-500/70 dark:from-[#3b4450] dark:via-[#2a313b] dark:to-[#1a1f27] dark:shadow-[0_24px_50px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.1),inset_0_-10px_18px_rgba(0,0,0,0.5)]"
			>
				<div className="plastic-grain pointer-events-none absolute inset-0 rounded-3xl" />
				<div className="pointer-events-none absolute inset-x-6 top-2 h-6 rounded-full bg-white/50 blur-md dark:bg-white/10" />
				<div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 rounded-b-3xl bg-gradient-to-t from-black/15 to-transparent" />

				{/* Inner bezel */}
				<div className="relative rounded-2xl border border-slate-500/45 bg-gradient-to-b from-[#e8edf3] to-[#b9c4d1] p-4 shadow-[inset_0_2px_2px_rgba(255,255,255,0.65),inset_0_-3px_6px_rgba(15,23,42,0.22)] dark:border-slate-600/70 dark:from-[#202833] dark:to-[#141b24] dark:shadow-[inset_0_1px_2px_rgba(255,255,255,0.08),inset_0_-4px_9px_rgba(0,0,0,0.65)]">
					<p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
						{title}
					</p>
					<p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
						Runs search: “{query}”
					</p>
					<input
						ref={inputRef}
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") submit();
							else if (e.key === "Escape") onCancel();
						}}
						placeholder="Tab name"
						maxLength={60}
						aria-label="Tab name"
						data-autofocus
						className="mt-3 w-full rounded-xl border border-slate-500/45 bg-white/70 px-3 py-2 text-sm text-zinc-800 outline-none placeholder:text-zinc-400 focus:ring-2 focus:ring-zinc-400 dark:border-slate-600/70 dark:bg-black/30 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:ring-zinc-500"
					/>
					{/* Search mode this tab runs when clicked — same three-way
					    Files/Scenes/Dialogue/OCR choice as the search bar. */}
					<div className="mt-3">
						<p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
							Search mode
						</p>
						<div className="mt-1.5 flex w-fit items-center rounded-full border border-slate-500/45 bg-gradient-to-b from-[#f4f7fb] via-[#d7dee7] to-[#a7b3c0] p-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_6px_rgba(15,23,42,0.18)] dark:border-slate-500/70 dark:from-[#3b4450] dark:via-[#2a313b] dark:to-[#1a1f27] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_3px_8px_rgba(0,0,0,0.4)]">
							{modeOptions.map((opt) => (
								<button
									key={opt.id}
									type="button"
									aria-label={`Tab mode: ${opt.label}`}
									aria-pressed={mode === opt.id}
									onClick={() => setMode(opt.id)}
									className={`rounded-full px-3 py-1 text-[11px] font-semibold transition-all duration-200 ${
										mode === opt.id
											? "bg-gradient-to-b from-white to-zinc-200 text-zinc-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_3px_rgba(15,23,42,0.2)] dark:from-zinc-600 dark:to-zinc-700 dark:text-white dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.15),0_1px_4px_rgba(0,0,0,0.4)]"
											: "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
									}`}
								>
									{opt.label}
								</button>
							))}
						</div>
					</div>
					<label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
						<input
							type="checkbox"
							checked={watch}
							onChange={(e) => setWatch(e.target.checked)}
							aria-label="Watch as YouTube interest"
						/>
						<span>Watch as YouTube interest — auto-match new downloads</span>
					</label>
					<div className="mt-4 flex justify-end gap-2">
						<button
							type="button"
							onClick={onCancel}
							className="rounded-full border border-slate-500/45 bg-gradient-to-b from-white/80 to-zinc-200/80 px-4 py-1.5 text-xs font-medium text-zinc-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.85),0_1px_2px_rgba(15,23,42,0.15)] transition-all duration-200 hover:from-white hover:to-zinc-100 hover:text-zinc-900 dark:border-slate-600/70 dark:from-zinc-600/80 dark:to-zinc-700/80 dark:text-zinc-300 dark:hover:from-zinc-500 dark:hover:to-zinc-600 dark:hover:text-white"
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={submit}
							disabled={!trimmed}
							className="rounded-full border border-slate-500/45 bg-gradient-to-b from-white/80 to-zinc-200/80 px-4 py-1.5 text-xs font-medium text-zinc-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.85),0_1px_2px_rgba(15,23,42,0.15)] transition-all duration-200 hover:from-white hover:to-zinc-100 hover:text-zinc-900 active:shadow-[inset_0_2px_4px_rgba(15,23,42,0.25)] disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600/70 dark:from-zinc-600/80 dark:to-zinc-700/80 dark:text-zinc-300 dark:hover:from-zinc-500 dark:hover:to-zinc-600 dark:hover:text-white"
						>
							Save tab
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
export default SaveTabDialog;
