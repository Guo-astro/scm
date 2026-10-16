"use client";

import { create } from "zustand";
import { getCategory, type CategoryOverride } from "@/lib/categories";
import { extractEmailMatches } from "@/lib/emailAddress";
import { isVideoFile } from "@/lib/media";
import type { ImageItem } from "@/types";

export type ToastTone = "default" | "success" | "warning" | "error";

export type NotifyFn = (message: string, tone: ToastTone) => void;

// Manual Screenshots-tab decisions arrive keyed by content hash; resolve
// one row's, tolerating missing hashes and hand-edited values.
function overrideFor(
	hash: unknown,
	overrides: Record<string, unknown>,
): CategoryOverride | null {
	if (typeof hash !== "string") return null;
	const value = overrides[hash];
	return value === "Screenshots" || value === "Projects" ? value : null;
}

function asString(v: unknown): string | null {
	return typeof v === "string" ? v : null;
}

interface LibraryState {
	images: ImageItem[];
	libraryLoaded: boolean;
	refreshLibrary: () => Promise<void>;
	setCategoryOverride: (
		filename: string,
		category: CategoryOverride,
		notify: NotifyFn,
	) => Promise<void>;
}

export const useLibraryStore = create<LibraryState>()((set) => ({
	images: [],
	libraryLoaded: false,

	refreshLibrary: async () => {
		try {
			const index = await fetch("/memories-index.json").then((r) => r.json());
			const filenames: string[] = Array.isArray(index.images)
				? index.images
				: [];
			const sourceMtimes: unknown[] = Array.isArray(index.sourceMtimes)
				? index.sourceMtimes
				: [];
			const sources: unknown[] = Array.isArray(index.sources)
				? index.sources
				: [];
			const hints: unknown[] = Array.isArray(index.screenshotHints)
				? index.screenshotHints
				: [];
			// OCR text per row (parallel to images). Email-tab membership is
			// derived from it at refresh time — same fetch, no main-process
			// round trip — so the tab fills in as the OCR tray completes.
			const ocrTexts: unknown[] = Array.isArray(index.ocr) ? index.ocr : [];
			const hashes: unknown[] = Array.isArray(index.hashes) ? index.hashes : [];
			const overrides: Record<string, unknown> =
				index.categoryOverrides && typeof index.categoryOverrides === "object"
					? index.categoryOverrides
					: {};
			const sourcePaths = sources.map(asString);
			const hintFlags = hints.map((h) => h === true);
			const emailMatches = ocrTexts.map((t) =>
				typeof t === "string" ? extractEmailMatches(t) : [],
			);
			set({
				images: filenames.map((filename, i) => ({
					id: filename,
					filename,
					// All videos land in the dedicated Videos tab regardless of
					// the classification; photos resolve through the tiered
					// screenshot signals (override > filename > metadata >
					// source folder). Parallel arrays (filenames ↔ sources ↔
					// hints) — missing entries read as absent.
					category: isVideoFile(filename)
						? "Videos"
						: getCategory({
								filename,
								sourcePath: sourcePaths[i] ?? null,
								screenshotHint: hintFlags[i] ?? false,
								override: overrideFor(hashes[i], overrides),
							}),
					modifiedAt:
						typeof sourceMtimes[i] === "number" &&
						Number.isFinite(sourceMtimes[i])
							? sourceMtimes[i]
							: null,
					sourcePath: sourcePaths[i] ?? null,
					screenshotHint: hintFlags[i] ?? false,
					hasEmail: (emailMatches[i]?.length ?? 0) > 0,
					emailAddresses: (emailMatches[i] ?? []).map((m) => m.address),
					emailMatches: emailMatches[i] ?? [],
				})),
				libraryLoaded: true,
			});
		} catch (err) {
			console.error("Failed to load library:", err);
		}
	},

	// Manual Add to/Remove from Screenshots. Main persists the decision by
	// content hash and broadcasts "library-updated", which re-runs
	// refreshLibrary — the grid re-derives the category from the new index.
	setCategoryOverride: async (filename, category, notify) => {
		try {
			const res = await window.memories.setCategoryOverride(filename, category);
			if (res?.ok) return;
			notify(
				res?.error || "Could not update the Screenshots category",
				"warning",
			);
		} catch {
			notify("Could not update the Screenshots category", "warning");
		}
	},
}));
