"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { IconAlertTriangle, IconRefresh } from "@tabler/icons-react";

interface ErrorBoundaryProps {
	children: ReactNode;
}

interface ErrorBoundaryState {
	error: Error | null;
}

/**
 * Root render-error boundary: a throw anywhere below turns a silent white
 * screen into a recoverable screen plus a durable log line.
 *
 * Error boundaries must be class components (React has no hook equivalent),
 * so this is deliberately the one class in the renderer.
 *
 * Forensics: componentDidCatch forwards a capped summary through
 * window.memories.breadcrumb, which main.ts appends synchronously to
 * main-YYYYMMDD.log — the same trail the lightbox writes. Nothing in here
 * may throw: a broken bridge or clipboard must not break the fallback UI.
 */
export default class ErrorBoundary extends Component<
	ErrorBoundaryProps,
	ErrorBoundaryState
> {
	state: ErrorBoundaryState = { error: null };

	static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
		return {
			error: error instanceof Error ? error : new Error(String(error)),
		};
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		try {
			const component = (info.componentStack ?? "").replace(/\s+/g, " ").trim();
			window.memories?.breadcrumb?.(
				`render-error: ${error.name}: ${error.message} @ ${component}`.slice(
					0,
					280,
				),
			);
		} catch {
			/* forensics must never throw */
		}
		try {
			console.error("[render-error]", error, info.componentStack);
		} catch {
			/* logging must never throw */
		}
	}

	private details(): string {
		const error = this.state.error;
		if (!error) return "";
		return `${error.name}: ${error.message}\n${error.stack ?? ""}`;
	}

	private readonly reload = () => {
		window.location.reload();
	};

	private readonly copyDetails = () => {
		try {
			void navigator.clipboard?.writeText(this.details());
		} catch {
			/* clipboard can be unavailable (permissions); ignore */
		}
	};

	render() {
		if (!this.state.error) return this.props.children;

		return (
			<div className="fixed inset-0 z-[70] flex items-center justify-center bg-[#eef2f7] p-6 dark:bg-[#0a0a0a]">
				<div
					role="alert"
					className="w-full max-w-lg rounded-2xl border border-slate-500/40 bg-white/95 p-6 shadow-[0_24px_60px_rgba(15,23,42,0.18)] dark:border-slate-600/70 dark:bg-[#141922]/95 dark:shadow-[0_24px_60px_rgba(0,0,0,0.6)]"
				>
					<div className="flex items-start gap-3">
						<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-amber-500/40 bg-amber-500/10">
							<IconAlertTriangle
								size={20}
								className="text-amber-600 dark:text-amber-400"
							/>
						</div>
						<div className="min-w-0">
							<h1 className="text-base font-semibold text-zinc-800 dark:text-zinc-100">
								Something went wrong while drawing this view
							</h1>
							<p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
								Your library is safe. Reload to continue — the error was written
								to the app log.
							</p>
						</div>
					</div>

					<details className="mt-4 rounded-lg border border-slate-400/30 bg-slate-500/5 p-3">
						<summary className="cursor-pointer select-none text-xs font-medium text-zinc-600 dark:text-zinc-400">
							Technical details
						</summary>
						<pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-400">
							{this.details()}
						</pre>
					</details>

					<div className="mt-5 flex items-center gap-2">
						<button
							type="button"
							onClick={this.reload}
							autoFocus
							className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/50 bg-gradient-to-b from-sky-500 to-sky-600 px-3 py-1.5 text-sm font-medium text-white shadow-[0_1px_3px_rgba(14,165,233,0.4)] transition hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70"
						>
							<IconRefresh size={16} />
							Reload
						</button>
						<button
							type="button"
							onClick={this.copyDetails}
							className="rounded-lg border border-slate-500/30 bg-white/60 px-3 py-1.5 text-sm font-medium text-zinc-700 transition hover:bg-white/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/60 dark:border-slate-600/60 dark:bg-black/20 dark:text-zinc-300 dark:hover:bg-white/[0.07]"
						>
							Copy details
						</button>
					</div>
				</div>
			</div>
		);
	}
}
