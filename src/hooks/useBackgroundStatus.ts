"use client";

import { useCallback, useEffect, useState } from "react";
import type { StatusPayload } from "@/types";

type EnrichStatus = Extract<StatusPayload, { type: "enrich" }>;
type TranscribeStatus = Extract<StatusPayload, { type: "transcribe" }>;
type OcrStatus = Extract<StatusPayload, { type: "ocr" }>;

// The three background trays (scene enrichment, speech transcription, OCR)
// share one protocol: pull a snapshot on mount, then follow the status
// stream; a "library-updated" event (new import / category change) means the
// queue changed, so pull again.
//
// This used to be three near-identical effects in MasonryGrid, each opening
// its own subscription. One subscription now feeds all three, which also
// removes a real bug shape: an event arriving between the three separate
// initial pulls could leave one tray stale.
export function useBackgroundStatus() {
	const [enrich, setEnrich] = useState<EnrichStatus | null>(null);
	const [transcribe, setTranscribe] = useState<TranscribeStatus | null>(null);
	const [ocr, setOcr] = useState<OcrStatus | null>(null);

	useEffect(() => {
		let mounted = true;

		// One snapshot pull per tray. The optional chain short-circuits the
		// whole promise chain when a bridge method is absent (tests).
		const pull = () => {
			const bridge = window.memories;
			bridge
				?.getEnrichState?.()
				.then((s) => {
					if (mounted && s?.type === "enrich") setEnrich(s);
				})
				.catch(() => {});
			bridge
				?.getTranscribeState?.()
				.then((s) => {
					if (mounted && s?.type === "transcribe") setTranscribe(s);
				})
				.catch(() => {});
			bridge
				?.getOcrState?.()
				.then((s) => {
					if (mounted && s?.type === "ocr") setOcr(s);
				})
				.catch(() => {});
		};

		pull();
		const off = window.memories?.onStatus?.((payload) => {
			if (payload.type === "enrich") setEnrich(payload);
			else if (payload.type === "transcribe") setTranscribe(payload);
			else if (payload.type === "ocr") setOcr(payload);
			else if (payload.type === "library-updated") pull();
		});

		return () => {
			mounted = false;
			off?.();
		};
	}, []);

	// User pause for ALL background pumps (scene analysis, transcription,
	// text extraction): one flag in main, toggled from any tray pill. New
	// states arrive on the same status channel, so every pill flips together.
	const toggleBackgroundPaused = useCallback((paused: boolean) => {
		void window.memories?.setBackgroundPaused?.(paused).catch(() => {
			/* bridge is optional — the pill keeps its last state */
		});
	}, []);

	return { enrich, transcribe, ocr, toggleBackgroundPaused };
}
