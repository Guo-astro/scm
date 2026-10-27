"use client";

import { useCallback, useState } from "react";
import { formatTimecode, posterFor, previewFor } from "@/lib/media";

// Lightbox body for searchable-only videos (mkv/hevc/...): Chromium cannot
// demux these containers, so instead of a dead <video> the lightbox shows a
// 30 s in-app preview transcoded around the matched scene timestamp (see
// main.ts /images/preview/ + media.ts previewFor) with a poster fallback
// while the transcode lands or if it fails, plus an "Open in system player"
// button for full-file playback. The parent remounts it per (file, sceneT)
// via key, so fresh state arrives with each navigation automatically.
export default function UnplayableVideo({
	filename,
	sceneT,
	indexLabel,
}: {
	filename: string;
	sceneT: number;
	indexLabel: string;
}) {
	const [previewFailed, setPreviewFailed] = useState(false);
	const [opening, setOpening] = useState(false);
	const [openFailed, setOpenFailed] = useState(false);

	const openExternal = useCallback(() => {
		setOpening(true);
		setOpenFailed(false);
		void window.memories
			?.openExternal?.(filename)
			.then((res) => {
				if (!res?.ok) setOpenFailed(true);
			})
			.catch(() => setOpenFailed(true))
			.finally(() => setOpening(false));
	}, [filename]);

	return (
		<div className="relative">
			{previewFailed ? (
				<img
					src={posterFor(filename)}
					alt={indexLabel}
					width={1400}
					height={1000}
					className="h-auto max-h-[80vh] w-auto max-w-[85vw] rounded object-contain"
				/>
			) : (
				<video
					key={`${filename}@${sceneT}`}
					src={previewFor(filename, sceneT)}
					controls
					autoPlay
					playsInline
					preload="metadata"
					poster={posterFor(filename)}
					onError={() => setPreviewFailed(true)}
					className="h-auto max-h-[80vh] w-auto max-w-[85vw] rounded object-contain"
				/>
			)}
			<div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
				<span className="rounded-full border border-white/20 bg-black/60 px-4 py-1.5 text-xs text-white/90 backdrop-blur">
					{sceneT > 0
						? `Preview around ${formatTimecode(sceneT)} — full file needs a system player`
						: "Preview — full file needs a system player"}
				</span>
			</div>
			<div className="mt-2 flex items-center justify-center gap-2">
				<button
					onClick={(e) => {
						e.stopPropagation();
						openExternal();
					}}
					disabled={opening}
					className="rounded-full border border-white/20 bg-black/60 px-4 py-1.5 text-xs text-white/90 backdrop-blur transition hover:bg-black/80 disabled:opacity-60"
					title="Open the full file in the OS default video player"
				>
					{opening ? "Opening…" : "Open in system player"}
				</button>
				{openFailed && (
					<span className="text-xs text-red-300">
						Couldn&apos;t open — try Show in Finder
					</span>
				)}
			</div>
		</div>
	);
}
