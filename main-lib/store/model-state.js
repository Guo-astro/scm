"use strict";
// Phase 2 (store/model-state): pure move from main-lib/library-store.js —
// model registry state, thresholds, bins metadata, delta-reuse planner.
// Layout path rides the index-core namespace. All sibling access is
// call-time only (cycle-safe).
const fs = require("fs");
const path = require("path");
const indexCore = require("./index-core.js");
const bins = require("./bins.js");
const { getModel } = require("../../indexer/models.js");

let modelStateCache = null;

// Post-restore invalidation: the thresholds file on disk was just replaced
// from a version — drop the memoized read so the next thresholdsFor()

function resetModelStateCache() {
	modelStateCache = null;
}

function loadModelState() {
	if (modelStateCache) return modelStateCache;
	modelStateCache = { version: 1, models: {} };
	try {
		const parsed = JSON.parse(fs.readFileSync(indexCore.MODELS_STATE_FILE, "utf8"));
		if (parsed && typeof parsed.models === "object") {
			modelStateCache.models = parsed.models;
		}
	} catch {
		/* no state yet */
	}
	return modelStateCache;
}

function saveModelState() {
	fs.mkdirSync(indexCore.DATA_DIR, { recursive: true });
	fs.writeFileSync(
		indexCore.MODELS_STATE_FILE,
		JSON.stringify(loadModelState(), null, "\t"),
	);
}

// The effective thresholds for a model: persisted calibration wins, then the

function thresholdsFor(modelId) {
	const state = loadModelState().models[modelId];
	if (state && state.thresholds) return state.thresholds;
	const config = getModel(modelId);
	return (config && config.thresholds) || null;
}

function binInfo(modelId) {
	try {
		const buf = fs.readFileSync(indexCore.embedFileFor(modelId));
		const header = new Int32Array(buf.buffer, buf.byteOffset, 2);
		return { rows: header[0], dim: header[1] };
	} catch {
		return null;
	}
}

const EMBED_CODE_VERSION = 1;

function embedMetaFileFor(modelId) {
	return path.join(indexCore.DATA_DIR, `memory-embed-meta-${modelId}.json`);
}

function readEmbedMeta(modelId) {
	try {
		const meta = JSON.parse(fs.readFileSync(embedMetaFileFor(modelId), "utf8"));
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

const embedIncompleteByModel = new Map();

function setEmbedIncomplete(modelId, flag) {
	if (flag) embedIncompleteByModel.set(modelId, true);
	else embedIncompleteByModel.delete(modelId);
}

function isZeroVector(v) {
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

function planDeltaReuse(modelId, dim, filenames) {
	const empty = {
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
	const snapIndex = new Map();
	for (let j = 0; j < meta.filenames.length; j++) {
		if (!snapIndex.has(meta.filenames[j])) snapIndex.set(meta.filenames[j], j);
	}
	const reusedEmbeddings = new Array(filenames.length).fill(null);
	const reusedPhrases = new Array(filenames.length).fill(null);
	const missing = [];
	let reused = 0;
	for (let i = 0; i < filenames.length; i++) {
		const j = snapIndex.get(filenames[i]);
		if (j === undefined) {
			missing.push(filenames[i]);
			continue;
		}
		const e = embedRows[j];
		const p = phraseRows[j];
		if (!e || !p || isZeroVector(e) || isZeroVector(p)) {
			missing.push(filenames[i]);
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

exports.loadModelState = loadModelState;
exports.resetModelStateCache = resetModelStateCache;
exports.saveModelState = saveModelState;
exports.thresholdsFor = thresholdsFor;
exports.binInfo = binInfo;
exports.EMBED_CODE_VERSION = EMBED_CODE_VERSION;
exports.embedIncompleteByModel = embedIncompleteByModel;
exports.embedMetaFileFor = embedMetaFileFor;
exports.readEmbedMeta = readEmbedMeta;
exports.setEmbedIncomplete = setEmbedIncomplete;
exports.isZeroVector = isZeroVector;
exports.planDeltaReuse = planDeltaReuse;
