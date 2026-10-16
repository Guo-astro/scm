// Phase 2 (store/model-state): pure move from main-lib/library-store.js —
// model registry state, thresholds, bins metadata, delta-reuse planner.
// Layout path rides the index-core namespace. All sibling access is
// call-time only (cycle-safe).

import fs from "node:fs";
import path from "node:path";
import * as indexCore from "./index-core.ts";
import * as bins from "./bins.ts";
import { getModel } from "../../indexer/models.ts";

interface ModelState {
	version: number;
	models: Record<string, any>;
}

let modelStateCache: ModelState | null = null;

// Post-restore invalidation: the thresholds file on disk was just replaced
// from a version — drop the memoized read so the next thresholdsFor()

export function resetModelStateCache(): void {
	modelStateCache = null;
}

export function loadModelState(): ModelState {
	if (modelStateCache) return modelStateCache;
	modelStateCache = { version: 1, models: {} };
	try {
		const parsed = JSON.parse(
			fs.readFileSync(indexCore.MODELS_STATE_FILE, "utf8"),
		);
		if (parsed && typeof parsed.models === "object") {
			modelStateCache.models = parsed.models;
		}
	} catch {
		/* no state yet */
	}
	return modelStateCache;
}

export function saveModelState(): void {
	fs.mkdirSync(indexCore.DATA_DIR, { recursive: true });
	fs.writeFileSync(
		indexCore.MODELS_STATE_FILE,
		JSON.stringify(loadModelState(), null, "\t"),
	);
}

// The effective thresholds for a model: persisted calibration wins, then the

export function thresholdsFor(modelId: string): any {
	const state = loadModelState().models[modelId];
	if (state && state.thresholds) return state.thresholds;
	const config = getModel(modelId);
	return (config && config.thresholds) || null;
}

export function binInfo(modelId: string): {
	rows: number;
	dim: number;
} | null {
	try {
		const buf = fs.readFileSync(indexCore.embedFileFor(modelId));
		const header = new Int32Array(buf.buffer, buf.byteOffset, 2);
		// Bounds-proven reads: the 2-int construction throws on a short
		// buffer, so both slots are always present.
		return { rows: header[0] as number, dim: header[1] as number };
	} catch {
		return null;
	}
}

export const EMBED_CODE_VERSION = 1;

export function embedMetaFileFor(modelId: string): string {
	return path.join(indexCore.DATA_DIR, `memory-embed-meta-${modelId}.json`);
}

export interface EmbedMeta {
	filenames: string[];
	codeVersion: number;
	dim: number;
	count?: number;
	incomplete?: boolean;
	modelId?: string;
	version?: number;
	writtenAt?: string;
	[key: string]: unknown;
}

export function readEmbedMeta(modelId: string): EmbedMeta | null {
	try {
		const meta = JSON.parse(
			fs.readFileSync(embedMetaFileFor(modelId), "utf8"),
		) as EmbedMeta;
		if (!meta || typeof meta !== "object") return null;
		if (!Array.isArray(meta.filenames)) return null;
		if (!Number.isInteger(meta.codeVersion)) return null;
		if (!Number.isInteger(meta.dim) || meta.dim <= 0) return null;
		return meta;
	} catch {
		return null;
	}
}

// Rows whose vectors are still being filled (a background delta tail or an
// interrupted foreground migration). saveLibrary stamps the flag into the
// meta it writes, so a crash mid-fill leaves incomplete:true on disk and the

export const embedIncompleteByModel = new Map<string, boolean>();

export function setEmbedIncomplete(modelId: string, flag: unknown): void {
	if (flag) embedIncompleteByModel.set(modelId, true);
	else embedIncompleteByModel.delete(modelId);
}

export function isZeroVector(v: Float32Array | null | undefined): boolean {
	if (!v) return true;
	for (let i = 0; i < v.length; i++) {
		if (v[i] !== 0) return false;
	}
	return true;
}

// Match the current library against a target model's cached bins BY
// FILENAME (never by index — deletes/reorders shift indices). Returns
// { usable, reason, reusedEmbeddings, reusedPhrases, missing, reused } where
// the reused arrays are dense and aligned to `filenames` (null = missing)
// and `missing` names the files that need embedding. Zero-vector rows count
// as missing (failed rows self-heal on the next switch instead of being

export interface DeltaPlan {
	usable: boolean;
	reason: string;
	reusedEmbeddings: Array<Float32Array | null>;
	reusedPhrases: Array<Float32Array | null>;
	missing: string[];
	reused: number;
}

export function planDeltaReuse(
	modelId: string,
	dim: number,
	filenames: string[],
): DeltaPlan {
	const empty: DeltaPlan = {
		usable: false,
		reason: "no-meta",
		reusedEmbeddings: [],
		reusedPhrases: [],
		missing: [...filenames],
		reused: 0,
	};
	const meta = readEmbedMeta(modelId);
	if (!meta) return empty;
	if (meta.codeVersion !== EMBED_CODE_VERSION) {
		return { ...empty, reason: "code-version" };
	}
	if (meta.dim !== dim) {
		return { ...empty, reason: "dim" };
	}
	const embedRows = bins.readBinPartial(indexCore.embedFileFor(modelId), dim);
	const phraseRows = bins.readBinPartial(indexCore.phraseFileFor(modelId), dim);
	if (
		embedRows.length !== meta.filenames.length ||
		phraseRows.length !== meta.filenames.length
	) {
		return { ...empty, reason: "bin-meta-mismatch" };
	}
	const snapIndex = new Map<string, number>();
	for (let j = 0; j < meta.filenames.length; j++) {
		// Bounds-proven cast: j < meta.filenames.length.
		const filename = meta.filenames[j] as string;
		if (!snapIndex.has(filename)) snapIndex.set(filename, j);
	}
	const reusedEmbeddings: Array<Float32Array | null> = new Array(
		filenames.length,
	).fill(null);
	const reusedPhrases: Array<Float32Array | null> = new Array(
		filenames.length,
	).fill(null);
	const missing: string[] = [];
	let reused = 0;
	for (let i = 0; i < filenames.length; i++) {
		// Bounds-proven cast: i < filenames.length.
		const filename = filenames[i] as string;
		const j = snapIndex.get(filename);
		if (j === undefined) {
			missing.push(filename);
			continue;
		}
		const e = embedRows[j];
		const p = phraseRows[j];
		if (!e || !p || isZeroVector(e) || isZeroVector(p)) {
			missing.push(filename);
			continue;
		}
		reusedEmbeddings[i] = e;
		reusedPhrases[i] = p;
		reused++;
	}
	return {
		usable: true,
		reason: "ok",
		reusedEmbeddings,
		reusedPhrases,
		missing,
		reused,
	};
}

// Precomputed per-row L2 norms for the image embeddings, so the hot rank
// scan does cosine as dot/(qNorm·rowNorm) — one mul + div per row instead
// of recomputing both norms every call. Embeddings are append-mostly
// (import adds rows, delete removes them) so the cache is keyed on
// (length, dim); saveLibrary also clears it so any in-place mutation
