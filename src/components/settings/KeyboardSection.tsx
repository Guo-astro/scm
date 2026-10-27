"use client";

import { useEffect, useState } from "react";
import { IconX } from "@tabler/icons-react";
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
	type ShortcutMap,
} from "@/lib/inAppShortcuts";
import { ASK_MODE_VISIBLE } from "../../../shared/feature-flags.ts";
import { CARD } from "./card";

type NotifyTone = "default" | "success" | "warning" | "error";

/** Library views the Keyboard editor lists; a parked mode stays in the
 *  ViewId union + stored shortcut blobs so re-enabling needs no migration. */
const VISIBLE_VIEW_IDS = ASK_MODE_VISIBLE
	? VIEW_IDS
	: VIEW_IDS.filter((id) => id !== "all-llms");

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

interface KeyboardSectionProps {
	shortcuts: ShortcutMap;
	onShortcutChange: (id: ShortcutId, accel: string) => void;
	onResetShortcuts: (ids?: readonly ShortcutId[]) => void;
	onNotify: (message: string, tone: NotifyTone) => void;
}

// Keyboard section, extracted from SettingsSheet verbatim: the three
// recordable groups, the recorder (capture-phase key listener, reserved /
// duplicate refusal), and the reference table for what the recorder does
// NOT own. State is local and dies with the section — the sheet unmounts
// its body on close, so a reopen never inherits a half-recorded row.
export default function KeyboardSection({
	shortcuts,
	onShortcutChange,
	onResetShortcuts,
	onNotify,
}: KeyboardSectionProps) {
	// Which action/view is listening for its new combo, plus the last
	// record-time refusal (reserved combo or duplicate within the same
	// scope). Capture-phase + stopPropagation so the grid and lightbox
	// dispatchers and the Esc-closes-window handler never see the keys.
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

	return (
		<div className="mx-auto max-w-[600px] space-y-4">
			<p className="text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
				Record, remap, or clear any combo below — a bare key (←, →, Esc) comes
				back with Reset. Combos owned by the OS, the menu, or another shortcut
				in the same group are refused with a message naming the owner.
			</p>
			{/* Three recordable groups. Library views and the app-wide actions
			    share one conflict scope (both handlers are always live); the
			    lightbox actions are scoped to the open viewer, so a lightbox
			    combo may overlap an app one — ⌘I is the built-in example (AI
			    Insights inside, Import outside). The grid/lightbox dispatchers
			    consume their own combos first, so only one meaning can ever
			    fire per keypress. */}
			{(
				[
					{
						title: "Library views",
						ids: VISIBLE_VIEW_IDS,
						// A parked view is not listed, so "⌘1–6" would name a
						// combo nobody can see (its ⌘5 slot is still stored —
						// reset restores it too).
						resetLabel: ASK_MODE_VISIBLE
							? "Reset to ⌘1–6"
							: "Reset to defaults",
						onReset: () => {
							onResetShortcuts(VIEW_IDS);
							setRecordingId(null);
							setRecordError(null);
							onNotify("Library view shortcuts reset to defaults", "default");
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
							onNotify("Lightbox shortcuts reset to ← → Esc ⌘I", "default");
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
					{/* Refusals surface in the group being recorded — the only
					    place the message can act on. */}
					{recordError && group.ids.some((id) => id === recordingId) && (
						<div className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 dark:border-amber-500/30 dark:bg-amber-500/10">
							<p className="text-[13px] font-medium text-amber-700 dark:text-amber-300">
								{recordError}
							</p>
						</div>
					)}
				</div>
			))}
			{/* Reference table — what the recorder deliberately does NOT own:
			    menu items, OS window chrome, the Edit roles, and the positional
			    saved-tab fallback. The digit line reads the live map so it
			    tracks remaps and clears. */}
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
	);
}
