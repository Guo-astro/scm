// Rank worker (Phase 0.4): dedicated utilityProcess for the O(N × dim)
// hybrid search scan so the Electron main thread never blocks on search
// math (UI responsiveness A/B). Owns its own library-store instance loaded
// from disk under SCM_USER_DATA_DIR (same DATA_DIR as main). Protocol:
//   → { type: "rank", id, query, topK, qVec: Float32Array|Array, gen }
//   ← { type: "rank", id, ok, results } | { type: "rank", id, ok: false, error }
//   → { type: "shutdown" }
// `gen` is library-store's generation counter (bumped on saveLibrary /
// resetLibraryCaches / writeBins). A mismatch forces a cache reset + reload
// from disk so the worker tracks main's persisted state without shipping
// embeddings over IPC.

import path from "node:path";
import {
	initLibraryStore,
	resetLibraryCaches,
	loadLibrary,
	libraryNorms,
	thresholdsFor,
	libraryGenerationNumber,
} from "./library-store.ts";
import { initCategoryOverrides } from "./category-overrides.ts";
import { scoreLibrary } from "./rank-search.ts";
import { assertNever } from "./assert-never.ts";
import type { RankInbound, RankOutbound } from "../shared/worker-messages.ts";

const userDataDir = process.env.SCM_USER_DATA_DIR;
if (!userDataDir) {
	console.error("[rank-worker] SCM_USER_DATA_DIR missing");
	process.exit(1);
}
initLibraryStore({ userDataDir });
initCategoryOverrides({ dataDir: path.join(userDataDir, "library") });

let cachedGen: number | null = null;
function ensureLibrary(gen: number): void {
	if (cachedGen === gen) return;
	resetLibraryCaches();
	loadLibrary();
	cachedGen = gen;
}

function post(message: RankOutbound): void {
	if (process.parentPort) {
		process.parentPort.postMessage(message);
	}
}

if (process.parentPort) {
	process.parentPort.on("message", (event) => {
		const msg = (
			event && event.data !== undefined ? event.data : event
		) as RankInbound;
		if (!msg || !msg.type) return;
		if (msg.type === "shutdown") {
			process.exit(0);
			return;
		}
		if (msg.type === "rank") {
			const id = msg.id;
			try {
				const gen =
					typeof msg.gen === "number" ? msg.gen : libraryGenerationNumber();
				ensureLibrary(gen);
				const l = loadLibrary();
				const thresholds = thresholdsFor(l.modelId) || {};
				const norms = libraryNorms();
				const qVec =
					msg.qVec instanceof Float32Array
						? msg.qVec
						: Float32Array.from(msg.qVec || []);
				const results = scoreLibrary(
					l,
					msg.query,
					qVec,
					msg.topK || 96,
					thresholds,
					// Cast: both callers (here + rank-moments) pass
					// libraryNorms() directly and scoreLibrary's contract is
					// that the loader guarantees dense norms for a loaded
					// library — a null keeps throwing inside exactly as it
					// does today (no silent skip).
					norms as ArrayLike<number>,
				);
				post({ type: "rank", id, ok: true, results });
			} catch (err) {
				const e = err as { message?: string } | null | undefined;
				post({
					type: "rank",
					id,
					ok: false,
					error: (e && e.message) || String(err),
				});
			}
			return;
		}
		// Exhaustiveness (Tier 4): unknown message types are protocol bugs
		// (RankInbound covers every type main may send). msg narrows to
		// never once "shutdown" and "rank" are handled above.
		assertNever(msg);
	});
	post({ type: "rank-ready", gen: libraryGenerationNumber() });
}
