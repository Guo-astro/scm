"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ImageItem } from "@/types";

// YouTube library view state, extracted from MasonryGrid: the set of
// YouTube-backed filenames, the channel each belongs to, the active channel
// filter, and the counted channel list the filter chips render.
//
// Kept in one hook because the four pieces are only meaningful together:
// `matchesTabWithYt` is the tab predicate the grid's filter/search path
// calls, and `ytChannels` is derived from the other two states. Refresh is
// event-driven (main broadcasts "library-updated"/"youtube"), never polled.
export function useYoutubeLibrary(
	matchesTab: (img: ImageItem, tabId: string) => boolean,
) {
	const [ytFilenames, setYtFilenames] = useState<Set<string>>(new Set());
	const [ytChannelByFile, setYtChannelByFile] = useState<Map<string, string>>(
		new Map(),
	);
	const [ytChannel, setYtChannel] = useState<string>("All");

	const refreshYoutubeFiles = useCallback(async () => {
		try {
			const res = await window.memories?.getYoutubeFiles?.();
			if (res?.ok) {
				setYtFilenames(new Set(res.files ?? []));
				const map = new Map<string, string>();
				for (const entry of Object.values(res.meta ?? {})) {
					if (
						entry &&
						typeof entry.filename === "string" &&
						typeof entry.channel === "string" &&
						entry.channel
					) {
						map.set(entry.filename, entry.channel);
					}
				}
				// Fallback: files without meta channel still count as YouTube.
				for (const f of res.files ?? []) {
					if (!map.has(f)) map.set(f, "Unknown channel");
				}
				setYtChannelByFile(map);
				return;
			}
		} catch {
			/* bridge unavailable (tests) — keep empty set */
		}
		setYtFilenames(new Set());
		setYtChannelByFile(new Map());
	}, []);

	useEffect(() => {
		// Async pull: state lands after the await, not as a synchronous
		// cascading render — the rule cannot see through the promise.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		void refreshYoutubeFiles();
		const off = window.memories?.onStatus?.((payload) => {
			const t = (payload as { type?: string }).type;
			if (t === "library-updated" || t === "youtube")
				void refreshYoutubeFiles();
		});
		return () => {
			try {
				off?.();
			} catch {
				/* ignore */
			}
		};
	}, [refreshYoutubeFiles]);

	const matchesTabWithYt = useCallback(
		(img: ImageItem, tabId: string): boolean => {
			if (tabId === "YouTube") {
				if (!ytFilenames.has(img.filename)) return false;
				if (ytChannel !== "All") {
					return (ytChannelByFile.get(img.filename) ?? "") === ytChannel;
				}
				return true;
			}
			return matchesTab(img, tabId);
		},
		[matchesTab, ytFilenames, ytChannelByFile, ytChannel],
	);

	const ytChannels = useMemo(() => {
		const counts = new Map<string, number>();
		for (const filename of ytFilenames) {
			const ch = ytChannelByFile.get(filename) ?? "Unknown channel";
			counts.set(ch, (counts.get(ch) ?? 0) + 1);
		}
		return [...counts.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.map(([name, count]) => ({ name, count }));
	}, [ytFilenames, ytChannelByFile]);

	return {
		ytFilenames,
		ytChannelByFile,
		ytChannel,
		setYtChannel,
		ytChannels,
		matchesTabWithYt,
		refreshYoutubeFiles,
	};
}
