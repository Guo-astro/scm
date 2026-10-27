"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

// Horizontal tab-bar mechanics, extracted from MasonryGrid verbatim:
// overflow detection, arrow scrolling and click-drag panning. The component
// keeps only the markup and the tab list.
//
// Overflow is measured, not inferred from the tab count: the shell hugs its
// content up to a cap, so the fades/arrows must appear only when the track
// actually scrolls. ResizeObserver + MutationObserver + scroll + window
// resize all feed the same state, because saved-search tabs can be added,
// relabelled or removed at runtime.
export function useTabStrip() {
	const tabTrackRef = useRef<HTMLDivElement>(null);
	const [canScrollLeft, setCanScrollLeft] = useState(false);
	const [canScrollRight, setCanScrollRight] = useState(false);
	const isOverflowing = canScrollLeft || canScrollRight;

	const updateTabScrollState = useCallback(() => {
		const el = tabTrackRef.current;
		if (!el) return;
		const left = el.scrollLeft > 4;
		const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
		setCanScrollLeft(left);
		setCanScrollRight(right);
	}, []);

	useLayoutEffect(() => {
		const el = tabTrackRef.current;
		if (!el) return;
		updateTabScrollState();
		const ro = new ResizeObserver(updateTabScrollState);
		ro.observe(el);
		const mo = new MutationObserver(updateTabScrollState);
		mo.observe(el, { childList: true, subtree: true, attributes: true });
		el.addEventListener("scroll", updateTabScrollState, { passive: true });
		window.addEventListener("resize", updateTabScrollState);
		return () => {
			ro.disconnect();
			mo.disconnect();
			el.removeEventListener("scroll", updateTabScrollState);
			window.removeEventListener("resize", updateTabScrollState);
		};
	}, [updateTabScrollState]);

	// Re-check after mount; tab count changes are caught by the
	// MutationObserver above, so no tab-list dep is needed here.
	useLayoutEffect(() => {
		updateTabScrollState();
	}, [updateTabScrollState]);

	const scrollTabs = useCallback((dir: -1 | 1) => {
		tabTrackRef.current?.scrollBy({
			left: dir * 240,
			behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
				? "auto"
				: "smooth",
		});
	}, []);

	const dragState = useRef({
		active: false,
		startX: 0,
		startLeft: 0,
	});

	const onTabTrackPointerDown = useCallback(
		(e: ReactPointerEvent) => {
			if (e.button !== 0) return;
			if ((e.target as HTMLElement).closest("button")) return;
			const el = tabTrackRef.current;
			if (!el || !isOverflowing) return;
			dragState.current = {
				active: true,
				startX: e.clientX,
				startLeft: el.scrollLeft,
			};
			(el as unknown as HTMLElement).setPointerCapture(e.pointerId);
		},
		[isOverflowing],
	);

	const onTabTrackPointerMove = useCallback((e: ReactPointerEvent) => {
		if (!dragState.current.active) return;
		const el = tabTrackRef.current;
		if (!el) return;
		const dx = e.clientX - dragState.current.startX;
		el.scrollLeft = dragState.current.startLeft - dx;
	}, []);

	const endDrag = useCallback((e: ReactPointerEvent) => {
		dragState.current.active = false;
		try {
			(tabTrackRef.current as unknown as HTMLElement)?.releasePointerCapture(
				e.pointerId,
			);
		} catch {
			/* releasePointerCapture is best-effort (mouse drags never capture) */
		}
	}, []);

	return {
		tabTrackRef,
		updateTabScrollState,
		canScrollLeft,
		canScrollRight,
		isOverflowing,
		scrollTabs,
		onTabTrackPointerDown,
		onTabTrackPointerMove,
		endDrag,
	};
}
