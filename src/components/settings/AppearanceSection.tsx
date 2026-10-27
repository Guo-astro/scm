"use client";

import {
	IconCheck,
	IconDeviceDesktop,
	IconMoonStars,
	IconPlayerPlay,
	IconSun,
} from "@tabler/icons-react";
import type { ThemeSetting } from "@/lib/theme";
import { APP_ICONS, type AppIconId } from "@/lib/appIcons";
import { IDLE_ROW, SELECTED_ROW } from "@/lib/rowTokens";

type NotifyTone = "default" | "success" | "warning" | "error";

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

interface AppearanceSectionProps {
	theme: ThemeSetting;
	onThemeChange: (next: ThemeSetting) => void;
	crtEffect: boolean;
	onCrtEffectChange: (next: boolean) => void;
	appIcon: AppIconId;
	onAppIconChange: (
		next: AppIconId,
	) => Promise<{ ok: boolean; appIcon?: string; error?: string } | undefined>;
	/** Optional: older callers simply don't offer the replay row. */
	onReplayTour?: () => void;
	onClose: () => void;
	onNotify: (message: string, tone: NotifyTone) => void;
}

// Appearance section, extracted from SettingsSheet verbatim: theme
// radios, the CRT viewer switch, the Dock/window icon picker, and the
// onboarding-tour replay row (when the caller offers one).
export default function AppearanceSection({
	theme,
	onThemeChange,
	crtEffect,
	onCrtEffectChange,
	appIcon,
	onAppIconChange,
	onReplayTour,
	onClose,
	onNotify,
}: AppearanceSectionProps) {
	return (
		<div className="mx-auto max-w-[600px] space-y-6">
			<div className="space-y-4">
				<p className="text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
					Choose how SCM looks. System follows your Mac&apos;s appearance and
					switches automatically.
				</p>
				<div
					role="radiogroup"
					aria-label="Theme"
					className="grid grid-cols-1 gap-3 sm:grid-cols-3"
				>
					{THEME_OPTIONS.map(({ value, label, blurb, icon: Icon }) => {
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
					})}
				</div>
			</div>

			<div className="border-t border-slate-500/25 dark:border-slate-600/40" />

			<div>
				<h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
					CRT Screen Effect
				</h3>
				<p className="mt-1 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
					Open photos &amp; videos on a retro monitor — bezel, curved glass,
					phosphor glow, and subtle flicker. Off shows a plain full-screen
					viewer.
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
					Pick the Dock and window icon. Applies instantly and sticks after
					restarts.
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
										void Promise.resolve(onAppIconChange(info.id)).then(
											(res) => {
												if (res && res.ok === false) {
													onNotify(
														res.error || "Could not switch icon",
														"warning",
													);
												}
											},
										);
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
											<IconCheck size={12} stroke={3} aria-hidden="true" />
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
					Dock updates live on macOS — while Menu Bar-only hides the Dock you’ll
					see the new icon in the menu bar immediately, and in the Dock after
					you leave that mode. Quit/reopen keeps your pick (Finder still shows
					the bundled icon when the app is closed).
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
							Replay the first-run CRT tour — the three demo channels that
							introduce photo search, OCR, and smart tabs.
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
	);
}
