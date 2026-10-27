"use client";

import {
	BUILT_IN_TABS,
	BUILT_IN_TAB_INFO,
	TOGGLEABLE_TABS,
} from "@/lib/builtInTabs";
import { IDLE_ROW, SELECTED_ROW } from "@/lib/rowTokens";
import { CARD } from "./card";

type NotifyTone = "default" | "success" | "warning" | "error";

interface SmartTabsSectionProps {
	enabledTabs: Set<string>;
	onTabToggle: (id: string, on: boolean) => void;
	onNotify: (message: string, tone: NotifyTone) => void;
}

// Smart Tabs section, extracted from SettingsSheet verbatim: the
// optional views (switches) plus the always-on list.
export default function SmartTabsSection({
	enabledTabs,
	onTabToggle,
	onNotify,
}: SmartTabsSectionProps) {
	return (
		<div className="mx-auto max-w-[600px] space-y-4">
			<p className="text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
				Smart tabs are optional browse views on the tab bar. Turn off the ones
				you don&apos;t use — the photos stay in your library under All.
			</p>
			<div role="group" aria-label="Smart tabs" className="space-y-2">
				{TOGGLEABLE_TABS.map((id) => {
					const info = BUILT_IN_TAB_INFO[id];
					const on = enabledTabs.has(id);
					return (
						<button
							key={id}
							type="button"
							role="switch"
							aria-checked={on}
							aria-label={`${info.label} tab — ${info.blurb}`}
							title={info.blurb}
							onClick={() => {
								onTabToggle(id, !on);
								onNotify(
									on
										? `${info.label} tab hidden — turn it back on here any time.`
										: `${info.label} tab shown on the tab bar.`,
									"default",
								);
							}}
							className={`flex w-full items-center gap-3.5 rounded-2xl border px-4 py-3.5 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${on ? SELECTED_ROW : IDLE_ROW}`}
						>
							<span
								className={`flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors ${
									on
										? "justify-end bg-sky-500"
										: "justify-start bg-zinc-400/60 dark:bg-zinc-600"
								}`}
								aria-hidden="true"
							>
								<span className="h-5 w-5 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.3)]" />
							</span>
							<span className="min-w-0 flex-1">
								<span className="block text-sm font-semibold text-zinc-800 dark:text-zinc-100">
									{info.label}
								</span>
								<span className="mt-0.5 block text-[13px] leading-snug text-zinc-500 dark:text-zinc-400">
									{info.blurb}
								</span>
							</span>
						</button>
					);
				})}
			</div>
			<div className={CARD}>
				<h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
					Always on
				</h3>
				<p className="mt-1 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
					These tabs are part of the core browse experience and can&apos;t be
					hidden.
				</p>
				<div className="mt-3 flex flex-wrap gap-2">
					{BUILT_IN_TABS.filter((id) => BUILT_IN_TAB_INFO[id].alwaysOn).map(
						(id) => (
							<span
								key={id}
								className="rounded-full border border-slate-500/25 bg-white/40 px-3 py-1 text-[13px] font-medium text-zinc-600 dark:border-slate-600/40 dark:bg-black/20 dark:text-zinc-300"
							>
								{BUILT_IN_TAB_INFO[id].label} · Always on
							</span>
						),
					)}
				</div>
			</div>
		</div>
	);
}
