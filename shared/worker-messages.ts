// Worker message protocols (ts-migration Tier 4) — discriminated unions for
// every utilityProcess seam. Types only: nothing here runs.
//
//   IndexerInbound / IndexerOutbound        indexer/indexer.ts
//     Consumers: main/ipc/pool.ts (worker pool) and main/ipc/migration.ts
//     (model preloads — migration sends only "init" and reads the "model" +
//     "init-done" subset of the outbound union).
//   OcrInbound / OcrOutbound                indexer/ocr-worker.ts
//     Consumer: main/ipc/pumps/ocr.ts
//   TranscribeInbound / TranscribeOutbound  indexer/transcribe-worker.ts
//     Consumer: main/ipc/pumps/transcribe.ts
//   RankInbound / RankOutbound              main-lib/rank-worker.ts
//     Consumer: main/ipc/rank-moments.ts
//
// Request/reply convention: the main side stamps a string `id` on every
// request; the worker echoes it on the reply (and reuses the REQUEST type
// with ok:false + error for failures — see each worker's catch). Streaming
// progress events carry no id; the main side treats them as broadcasts.
//
// Dispatch sites annotate their message parameter with these unions and end
// the dispatch with assertNever (main-lib/assert-never.ts), so a new variant
// fails type-check at every consumer instead of being silently ignored.
// Payloads shown as `& Record<string, unknown>` are pass-through worker
// output the main side relays or forwards verbatim.

/** Everything the main process may send to an indexer worker. */
export type IndexerInbound =
	| { type: "init" }
	| { type: "embed-photo"; id?: string; path: string; filename: string }
	| { type: "embed-video"; id?: string; path: string; filename: string }
	| {
			type: "enrich-video";
			id?: string;
			path: string;
			filename: string;
			postersDir: string;
			fromIndex?: number;
			budget?: object | null;
	  }
	| { type: "embed-query"; id?: string; text: string }
	| { type: "embed-phrase"; id?: string; filename: string }
	| { type: "embed-texts"; id?: string; texts: string[] }
	| { type: "get-text-mean"; id?: string }
	| { type: "kill-ffmpeg"; id?: string; reason?: string }
	| { type: "shutdown" };

/**
 * Everything an indexer worker may post back. `model` is a broadcast; every
 * request type also appears with ok:false + error on failure.
 */
export type IndexerOutbound =
	| {
			type: "model";
			phase: "loading" | "ready" | "error";
			progress: number | null;
	  }
	| {
			type: "init-done";
			id?: string;
			ok: true;
			modelId: string;
			dim: number;
			textMean: number[] | null;
	  }
	| {
			type: "photo-done";
			id?: string;
			ok: true;
			vec: number[];
			phrase: number[] | null;
	  }
	| {
			type: "video-done";
			id?: string;
			ok: true;
			vec: number[] | null;
			phrase: number[] | null;
	  }
	| ({ type: "enrich-progress"; filename: string } & Record<string, unknown>)
	| ({ type: "enrich-done"; id?: string; ok: true } & Record<string, unknown>)
	| { type: "query-done"; id?: string; ok: boolean; vec: number[] | null }
	| { type: "phrase-done"; id?: string; ok: boolean; vec: number[] | null }
	| { type: "texts-done"; id?: string; ok: true; vecs: Array<number[] | null> }
	| { type: "text-mean-done"; id?: string; ok: true; textMean: number[] | null }
	| { type: "ffmpeg-killed"; id?: string; ok: true; killed: number }
	| { type: "ffmpeg-spawn"; pid: number; label: string }
	| { type: "ffmpeg-exit"; pid: number }
	| ({ type: "status" } & Record<string, unknown>) // legacy broadcast; pool.ts still tolerates it
	| {
			type:
				| "init"
				| "embed-photo"
				| "embed-video"
				| "enrich-video"
				| "embed-query"
				| "embed-phrase"
				| "embed-texts"
				| "get-text-mean"
				| "kill-ffmpeg";
			id?: string;
			ok: false;
			error: string;
	  };

/** Everything the main process may send to the OCR worker. */
export type OcrInbound =
	| { type: "ocr-photo"; id?: string; path: string }
	| {
			type: "shutdown";
	  };

/**
 * Everything the OCR worker may post back. `words` are normalized boxes:
 * text + relative x/y/w/h (see normalizeWords in ocr-worker — confidence
 * is filtered on inside the worker and never crosses the wire).
 */
export type OcrOutbound =
	| {
			type: "ocr-done";
			id?: string;
			ok: true;
			text: string;
			words: Array<{
				text: string;
				x: number;
				y: number;
				w: number;
				h: number;
			}>;
	  }
	| { type: "ocr-done"; id?: string; ok: false; error: string };

/** Everything the main process may send to the transcribe worker. */
export type TranscribeInbound =
	| {
			type: "transcribe-video";
			id?: string;
			path: string;
			filename: string;
			fromIndex?: number;
			modelId?: string;
			slicesPerChunk?: number;
			sliceDecodeTimeoutMs?: number;
			skipSlices?: number[];
	  }
	| { type: "kill-ffmpeg"; id?: string; reason?: string }
	| { type: "shutdown" };

/**
 * Everything the transcribe worker may post back. `stalledSlice` is the
 * SLICE_STALL suicide report (the worker exits right after posting it).
 */
export type TranscribeOutbound =
	| ({ type: "transcribe-done"; id?: string; ok: true } & Record<
			string,
			unknown
	  >)
	| {
			type: "transcribe-done";
			id?: string;
			ok: false;
			error: string;
			stalledSlice?: number | null;
	  }
	| ({
			type: "transcribe-progress";
			filename: string;
	  } & Record<string, unknown>)
	| { type: "ffmpeg-killed"; id?: string; ok: true; killed: number }
	| { type: "ffmpeg-spawn"; pid: number; label: string }
	| { type: "ffmpeg-exit"; pid: number }
	| {
			type: "transcribe-video" | "kill-ffmpeg";
			id?: string;
			ok: false;
			error: string;
	  };

/** Everything the main process may send to the rank worker. */
export type RankInbound =
	| {
			type: "rank";
			id?: string;
			gen?: number;
			query: string;
			qVec: Float32Array | number[];
			topK?: number;
	  }
	| { type: "shutdown" };

/**
 * Everything the rank worker may post back. `results` rows come from
 * rank-search's scoreLibrary (scored library rows with score breakdowns).
 */
export type RankOutbound =
	| { type: "rank-ready"; gen: number }
	| { type: "rank"; id?: string; ok: true; results: unknown[] }
	| { type: "rank"; id?: string; ok: false; error: string };
