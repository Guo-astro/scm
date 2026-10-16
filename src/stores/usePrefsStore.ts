"use client";

import { create } from "zustand";
import { CRT_EFFECT_KEY, readStoredCrtEffect } from "@/lib/crtEffect";
import {
	GRID_COLUMNS_KEY,
	readStoredGridColumns,
	type GridColumnsSetting,
} from "@/lib/gridColumns";
import {
	DEFAULT_VIDEO_QUALITY,
	parseVideoQuality,
	type VideoCostFacts,
	type VideoQualitySetting,
} from "@/lib/videoQuality";
import {
	DEFAULT_WHISPER_MODEL,
	parseWhisperModel,
	type WhisperModelSetting,
} from "@/lib/whisperModel";
import {
	DEFAULT_OCR_LANGS,
	parseOcrLangs,
	type OcrLangId,
} from "@/lib/ocrLangs";
import { DEFAULT_APP_ICON, parseAppIcon, type AppIconId } from "@/lib/appIcons";
import {
	DEFAULT_VIEW_SHORTCUTS,
	readStoredViewShortcuts,
	writeStoredViewShortcuts,
	type ViewId,
	type ViewShortcuts,
} from "@/lib/viewShortcuts";
import {
	isAlwaysOn,
	readStoredEnabledTabs,
	writeStoredEnabledTabs,
} from "@/lib/builtInTabs";
import { THEME_STORAGE_KEY, applyTheme, readStoredTheme } from "@/lib/theme";
import type { ThemeSetting } from "@/lib/theme";

export type { ThemeSetting };
export type { VideoCostFacts } from "@/lib/videoQuality";

interface PrefsState {
	theme: ThemeSetting;
	crtEffect: boolean;
	gridColumns: GridColumnsSetting;
	videoQuality: VideoQualitySetting;
	suspectedTruncated: number;
	suspectedTruncatedFiles: string[];
	costFacts: VideoCostFacts | null;
	whisperModel: WhisperModelSetting;
	ocrLangs: OcrLangId[];
	appIcon: AppIconId;
	viewShortcuts: ViewShortcuts;
	enabledTabs: Set<string>;
	setTheme: (next: ThemeSetting) => void;
	setCrtEffect: (next: boolean) => void;
	setGridColumns: (next: GridColumnsSetting) => void;
	setVideoQuality: (next: VideoQualitySetting) => Promise<void>;
	reanalyzeVideos: () => Promise<number | null>;
	refreshSuspectedTruncated: () => Promise<void>;
	refreshCostFacts: () => Promise<void>;
	setWhisperModel: (next: WhisperModelSetting) => Promise<number | null>;
	setOcrLangs: (next: OcrLangId[]) => Promise<number | null>;
	toggleOcrLang: (id: OcrLangId) => Promise<number | null>;
	reocrPhotos: () => Promise<number | null>;
	setAppIcon: (
		next: AppIconId,
	) => Promise<{ ok: boolean; appIcon?: string; error?: string } | undefined>;
	setViewShortcut: (id: ViewId, accel: string) => void;
	resetViewShortcuts: () => void;
	setTabEnabled: (id: string, on: boolean) => void;
	/** One-shot session bootstrap (bridge reads + OS-preference listener).
	 *  Idempotent — safe under double-mount. Replaces the nine mount
	 *  effects the App-owned hooks used to run. */
	initializePrefs: () => void;
}

let prefsInitialized = false;

function persist(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// Persisting is best-effort; the session still applies the choice.
	}
}

export const usePrefsStore = create<PrefsState>()((set, get) => ({
	theme: readStoredTheme(),
	crtEffect: readStoredCrtEffect(),
	gridColumns: readStoredGridColumns(),
	videoQuality: DEFAULT_VIDEO_QUALITY,
	suspectedTruncated: 0,
	suspectedTruncatedFiles: [],
	costFacts: null,
	whisperModel: DEFAULT_WHISPER_MODEL,
	ocrLangs: DEFAULT_OCR_LANGS,
	appIcon: DEFAULT_APP_ICON,
	viewShortcuts: readStoredViewShortcuts(),
	enabledTabs: readStoredEnabledTabs(),

	setTheme: (next) => {
		set({ theme: next });
		applyTheme(next);
		persist(THEME_STORAGE_KEY, next);
	},

	setCrtEffect: (next) => {
		set({ crtEffect: next });
		persist(CRT_EFFECT_KEY, next ? "true" : "false");
	},

	setGridColumns: (next) => {
		set({ gridColumns: next });
		persist(GRID_COLUMNS_KEY, String(next));
	},

	setVideoQuality: async (next) => {
		set({ videoQuality: next });
		try {
			const res = await window.memories.setVideoQuality(next);
			if (res?.ok && res.quality)
				set({ videoQuality: parseVideoQuality(res.quality) });
		} catch {
			// Persisting failed; the session still shows the choice, and the
			// next mount re-reads the stored value.
		}
	},

	reanalyzeVideos: async (): Promise<number | null> => {
		try {
			const res = await window.memories.reanalyzeVideos();
			return res?.ok ? (res.queued ?? 0) : null;
		} catch {
			return null;
		}
	},

	refreshSuspectedTruncated: async () => {
		try {
			const res = await window.memories.suspectedTruncatedVideos();
			if (res?.ok && typeof res.count === "number") {
				set({
					suspectedTruncated: res.count,
					suspectedTruncatedFiles: Array.isArray(res.videos)
						? res.videos
								.map((v) => v?.filename)
								.filter((f): f is string => typeof f === "string")
						: [],
				});
			}
		} catch {
			/* bridge is optional — keep the last known count */
		}
	},

	refreshCostFacts: async () => {
		try {
			const res = await window.memories.videosCostEstimate?.();
			if (
				res?.ok &&
				typeof res.videoCount === "number" &&
				Array.isArray(res.durations)
			) {
				set({
					costFacts: {
						videoCount: res.videoCount,
						knownSeconds: res.knownSeconds ?? 0,
						unknownCount: res.unknownCount ?? 0,
						durations: res.durations,
					},
				});
			}
		} catch {
			/* bridge is optional — keep the last known facts */
		}
	},

	setWhisperModel: async (next) => {
		set({ whisperModel: next });
		try {
			const res = await window.memories.setWhisperModel(next);
			if (res?.ok && res.model) {
				set({ whisperModel: parseWhisperModel(res.model) });
				return res.queued ?? 0;
			}
			return null;
		} catch {
			// Persisting failed; the session still shows the choice, and the
			// next mount re-reads the stored value.
			return null;
		}
	},

	setOcrLangs: async (next) => {
		set({ ocrLangs: parseOcrLangs(next) });
		try {
			const res = await window.memories.setOcrLangs(next);
			if (res?.ok && res.langs) {
				set({ ocrLangs: parseOcrLangs(res.langs) });
				return res.queued ?? 0;
			}
			return null;
		} catch {
			return null;
		}
	},

	toggleOcrLang: (id) => {
		const langs = get().ocrLangs;
		const has = langs.includes(id);
		const next = has ? langs.filter((l) => l !== id) : [...langs, id];
		return get().setOcrLangs(next);
	},

	reocrPhotos: async () => {
		try {
			const res = await window.memories.reocrPhotos();
			if (res?.ok) return res.queued ?? 0;
			return null;
		} catch {
			return null;
		}
	},

	setAppIcon: async (next) => {
		const parsed = parseAppIcon(next);
		try {
			const res = await window.memories.setAppIcon(parsed);
			if (!res?.ok) {
				// Keep current selection and surface the error; truth is still the persisted value
				const current = await window.memories
					.getAppIcon()
					.catch(() => DEFAULT_APP_ICON);
				set({ appIcon: parseAppIcon(current) });
				return res;
			}
			set({ appIcon: parsed });
			return res;
		} catch (err: unknown) {
			const current = await window.memories
				.getAppIcon()
				.catch(() => DEFAULT_APP_ICON);
			set({ appIcon: parseAppIcon(current) });
			const message =
				err instanceof Error
					? err.message
					: typeof err === "object" && err !== null && "message" in err
						? String((err as { message: unknown }).message)
						: String(err);
			return { ok: false, error: message } as const;
		}
	},

	setViewShortcut: (id, accel) => {
		set((prev) => {
			const next = { ...prev.viewShortcuts, [id]: accel };
			writeStoredViewShortcuts(next);
			return { viewShortcuts: next };
		});
	},

	resetViewShortcuts: () => {
		const next = { ...DEFAULT_VIEW_SHORTCUTS };
		set({ viewShortcuts: next });
		writeStoredViewShortcuts(next);
	},

	setTabEnabled: (id, on) => {
		// The locked tabs are not toggleable — ignore instead of writing a
		// state the registry would force back on at the next parse.
		if (isAlwaysOn(id)) return;
		set((prev) => {
			if (prev.enabledTabs.has(id) === on) return prev;
			const next = new Set(prev.enabledTabs);
			if (on) next.add(id);
			else next.delete(id);
			writeStoredEnabledTabs(next);
			return { enabledTabs: next };
		});
	},

	initializePrefs: () => {
		if (prefsInitialized) return;
		prefsInitialized = true;
		// OS-preference tracking while following the system (previously a
		// mount effect in useTheme; the store lives for the session).
		try {
			const media = window.matchMedia("(prefers-color-scheme: dark)");
			const onChange = () => {
				if (usePrefsStore.getState().theme === "system") applyTheme("system");
			};
			media.addEventListener("change", onChange);
		} catch {
			/* matchMedia unavailable — static theme stands */
		}
		applyTheme(get().theme);
		const load = async (
			call: () => Promise<unknown>,
			apply: (v: unknown) => void,
		) => {
			try {
				const v = await call();
				apply(v);
			} catch {
				/* bridge is optional — keep the default */
			}
		};
		void load(
			() => window.memories.getAppIcon(),
			(v) => set({ appIcon: parseAppIcon(v) }),
		);
		void load(
			() => window.memories?.getVideoQuality?.(),
			(q) => set({ videoQuality: parseVideoQuality(q) }),
		);
		void load(
			() => window.memories?.getWhisperModel?.(),
			(m) => set({ whisperModel: parseWhisperModel(m) }),
		);
		void load(
			() => window.memories?.getOcrLangs?.(),
			(l) => set({ ocrLangs: parseOcrLangs(l) }),
		);
	},
}));
