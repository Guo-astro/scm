"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TouchEvent as ReactTouchEvent } from "react";
import { matchAccelerator } from "@/lib/viewShortcuts";
import { LIGHTBOX_ACTION_IDS, type ShortcutMap } from "@/lib/inAppShortcuts";

// Lightbox mechanics, extracted from MasonryGrid verbatim: open/close,
// index navigation (wrapping), swipe gestures, the keyboard map (Settings →
// Keyboard, Lightbox group), and the side effects that belong to "a viewer
// is open" — breadcrumbs for crash forensics, AI-insights teardown, and the
// body-scroll lock.
//
// Items are passed in rather than owned: the lightbox always navigates the
// current display list (browse grid or ranked search results), which the
// component rebuilds from state. Only the structural fields this hook needs
// are required, so `DisplayItem` is passed without importing the component.
export interface LightboxItem {
	id: string;
	filename: string;
	scene?: { t: number } | null;
}

export function useLightbox(items: LightboxItem[], shortcuts: ShortcutMap) {
	const [lightboxOpen, setLightboxOpen] = useState(false);
	const [currentIndex, setCurrentIndex] = useState(0);
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const [aiInsightsOpen, setAiInsightsOpen] = useState(false);

	// Touch state for swipe gestures
	const [touchStart, setTouchStart] = useState({ x: 0, y: 0 });
	const [touchEnd, setTouchEnd] = useState({ x: 0, y: 0 });
	const minSwipeDistance = 50;

	const openLightbox = useCallback((index: number) => {
		setCurrentIndex(index);
		setLightboxOpen(true);
	}, []);

	const closeLightbox = useCallback(() => {
		window.memories?.breadcrumb?.("lightbox closed");
		setLightboxOpen(false);
	}, []);

	// Crash forensics: every lightbox transition hands a breadcrumb to the
	// main process (durable log line — see main.ts logBreadcrumb) so the next
	// native crash arrives with the user's last steps on record. The scene
	// timestamp is included on purpose: video switching is the app's riskiest
	// native surface (the 0.2.4 SIGTRAP fired mid scene-switch).
	useEffect(() => {
		if (!lightboxOpen) return;
		const item = items[currentIndex];
		if (!item) return;
		const scene = item.scene ? ` @${item.scene.t}s` : "";
		window.memories?.breadcrumb?.(
			`lightbox ${currentIndex + 1}/${items.length}: ${item.filename}${scene}`,
		);
	}, [lightboxOpen, currentIndex, items]);

	const goToNext = useCallback(() => {
		setCurrentIndex((prev) => (prev + 1) % items.length);
	}, [items.length]);

	const goToPrev = useCallback(() => {
		setCurrentIndex((prev) => (prev - 1 + items.length) % items.length);
	}, [items.length]);

	// Touch event handlers for swipe gestures
	const onTouchStart = useCallback((e: ReactTouchEvent) => {
		setTouchEnd({ x: 0, y: 0 });
		setTouchStart({
			x: e.targetTouches[0]?.clientX ?? 0,
			y: e.targetTouches[0]?.clientY ?? 0,
		});
	}, []);

	const onTouchMove = useCallback((e: ReactTouchEvent) => {
		setTouchEnd({
			x: e.targetTouches[0]?.clientX ?? 0,
			y: e.targetTouches[0]?.clientY ?? 0,
		});
	}, []);

	const onTouchEnd = useCallback(() => {
		if (!touchStart.x || !touchEnd.x) return;

		const distanceX = touchStart.x - touchEnd.x;
		const distanceY = touchStart.y - touchEnd.y;

		if (
			Math.abs(distanceX) > Math.abs(distanceY) &&
			Math.abs(distanceX) > minSwipeDistance
		) {
			if (distanceX > 0) {
				goToNext();
			} else {
				goToPrev();
			}
		}
	}, [touchStart, touchEnd, goToNext, goToPrev]);

	// Keyboard navigation (Settings → Keyboard, Lightbox group): the four
	// recordable lightbox actions, matched through the shared matcher so a
	// remap cannot drift from the editor. Handled combos stop propagation
	// before the window-level dispatchers (view shortcuts, Settings/Import)
	// see them — while the viewer is open ⌘I means AI Insights only; with
	// it closed, ⌘I imports. Bare-key defaults (←/→/Esc) are ignored while
	// a text field or IME composition owns the keyboard, and holding a
	// nav key repeats (matchAccelerator lets bare-key repeats through).
	useEffect(() => {
		if (!lightboxOpen) return;
		const onKeyDown = (e: KeyboardEvent) => {
			const run = (
				id: (typeof LIGHTBOX_ACTION_IDS)[number],
				action: () => void,
			) => {
				const accel = shortcuts[id];
				if (!accel || !matchAccelerator(e, accel)) return false;
				e.preventDefault();
				e.stopPropagation();
				action();
				return true;
			};
			if (run("lightbox-next", goToNext)) return;
			if (run("lightbox-prev", goToPrev)) return;
			if (run("lightbox-close", closeLightbox)) return;
			run("lightbox-insights", () => setAiInsightsOpen((o) => !o));
		};

		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [lightboxOpen, shortcuts, closeLightbox, goToNext, goToPrev]);

	// Close AI insights when the lightbox closes.
	useEffect(() => {
		if (!lightboxOpen) setAiInsightsOpen(false);
	}, [lightboxOpen]);

	// Prevent body scroll when lightbox is open
	useEffect(() => {
		if (lightboxOpen) {
			document.body.style.overflow = "hidden";
		} else {
			document.body.style.overflow = "unset";
		}
		return () => {
			document.body.style.overflow = "unset";
		};
	}, [lightboxOpen]);

	return {
		lightboxOpen,
		currentIndex,
		videoRef,
		aiInsightsOpen,
		setAiInsightsOpen,
		openLightbox,
		closeLightbox,
		goToNext,
		goToPrev,
		onTouchStart,
		onTouchMove,
		onTouchEnd,
	};
}
