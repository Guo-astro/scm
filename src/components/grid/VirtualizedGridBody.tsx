"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import MemoryCard from "../MemoryCard";
import { ROW_GAP, virtualGridLayout } from "@/lib/virtualGrid";
import type { DisplayItem } from "../MasonryGrid";
import type { ImageItem } from "@/types";

interface VirtualizedGridBodyProps {
	items: DisplayItem[];
	/** Rendered column count (resolved from the setting + measured width). */
	columns: number;
	/** Measured width of the grid wrapper (clientWidth). */
	width: number;
	onOpen: (index: number) => void;
	onContextMenu: (e: React.MouseEvent, image: ImageItem) => void;
	/** True on the Email tab — cards overlay the extracted address. */
	showEmails?: boolean;
}

const VirtualizedGridBody = memo(function VirtualizedGridBody({
	items,
	columns,
	width,
	onOpen,
	onContextMenu,
	showEmails = false,
}: VirtualizedGridBodyProps) {
	// The scroll window lives HERE, not in MasonryGrid, so a scroll frame
	// re-renders only the tiles (rAF-throttled; the page scrolls on
	// <html>/<body>, so the window is window.scrollY..+innerHeight).
	const [scrollTop, setScrollTop] = useState(0);
	const [viewportH, setViewportH] = useState(() => window.innerHeight);
	useEffect(() => {
		let raf = 0;
		const update = () => {
			raf = 0;
			setScrollTop(window.scrollY);
			setViewportH((prev) =>
				prev === window.innerHeight ? prev : window.innerHeight,
			);
		};
		const onScroll = () => {
			if (raf) return;
			raf = requestAnimationFrame(update);
		};
		window.addEventListener("scroll", onScroll, { passive: true });
		window.addEventListener("resize", update);
		update();
		return () => {
			window.removeEventListener("scroll", onScroll);
			window.removeEventListener("resize", update);
			if (raf) cancelAnimationFrame(raf);
		};
	}, []);

	// The true row height is read off the first rendered card (the estimate
	// is exact by construction, so this only ever corrects sub-pixel drift).
	const [measuredRowH, setMeasuredRowH] = useState<number | null>(null);
	const firstCardElRef = useRef<HTMLDivElement | null>(null);
	const firstCardRef = useCallback((el: HTMLDivElement | null) => {
		firstCardElRef.current = el;
		if (!el) return;
		const h = el.offsetHeight;
		if (h > 0) setMeasuredRowH((prev) => (prev === h ? prev : h));
	}, []);

	// Visible window ± one full viewport of overscan (computed inside
	// virtualGridLayout), so fast scrolling never flashes empty space while
	// the mounted-card count stays bounded no matter how large the library
	// gets (pure math — see virtualGrid.ts).
	const { colWidth, stride, totalHeight, sliceStart, sliceEnd } =
		virtualGridLayout({
			itemCount: items.length,
			columns,
			width,
			scrollTop,
			viewportH,
			measuredRowH,
		});

	// A column-count/width change resizes every card: re-read the first
	// rendered card's height instead of trusting the stale measurement. The
	// first-card ref fires BEFORE this effect on mount, so guard against
	// clobbering a just-landed measurement with null.
	const prevColWidthRef = useRef<number | null>(null);
	useEffect(() => {
		if (
			prevColWidthRef.current !== null &&
			prevColWidthRef.current !== colWidth
		) {
			const h = firstCardElRef.current?.offsetHeight;
			setMeasuredRowH(h && h > 0 ? h : null);
		}
		prevColWidthRef.current = colWidth;
	}, [colWidth]);

	// Filenames whose image resolved at least once this session: remounted
	// cards render opaque immediately instead of replaying the load fade.
	const loadedFilenamesRef = useRef<Set<string>>(new Set());

	if (colWidth <= 0 || items.length === 0) {
		return <div className="w-full" />;
	}

	return (
		<div className="relative w-full" style={{ height: totalHeight }}>
			{/* Render-phase read of a session Set; remounts must not replay
			    the fade. Revisit in M-12. */}
			{items.slice(sliceStart, sliceEnd).map((image, i) => {
				const globalIndex = sliceStart + i;
				const row = Math.floor(globalIndex / columns);
				const col = globalIndex % columns;
				return (
					<div
						key={image.id}
						ref={i === 0 ? firstCardRef : undefined}
						className="absolute"
						style={{
							top: row * stride,
							left: col * (colWidth + ROW_GAP),
							width: colWidth,
						}}
					>
						<MemoryCard
							image={image.filename}
							priority={i < 6}
							forceVisible={loadedFilenamesRef.current.has(image.filename)}
							onLoaded={(filename) => {
								loadedFilenamesRef.current.add(filename);
							}}
							bestScene={image.scene ?? null}
							highlightedWords={image.ocrHighlights ?? []}
							matchReason={image.matchReason}
							dominant={image.dominant}
							matchBreakdown={image.matchBreakdown}
							emailAddresses={image.emailAddresses ?? []}
							emailMatches={image.emailMatches ?? []}
							showEmailOverlay={showEmails}
							onClick={(e) => {
								// Right-click / ctrl+click is reserved for the
								// context menu; only plain left-clicks open.
								if (e.button !== 0 || e.ctrlKey) return;
								onOpen(globalIndex);
							}}
							onContextMenu={(e) => onContextMenu(e, image)}
						/>
					</div>
				);
			})}
		</div>
	);
});
export default VirtualizedGridBody;
