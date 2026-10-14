// @ts-check
"use strict";
// Phase 2 (store/bins): pure move from main-lib/library-store.js — bin
// read/write/encode, bin caches, norms + cosine. Paths, init, and the
// generation counter ride the index-core namespace; persistence + embed
// metadata ride persist/model-state. All sibling access is call-time
// only (cycle-safe).
const fs = require("fs");
const indexCore = require("./index-core.js");
const persist = require("./persist.js");
const modelState = require("./model-state.js");

/**
 * @param {string} modelId
 * @param {number} count
 * @param {number} dim
 * @returns {Float32Array[][]}
 */
function readLibraryBins(modelId, count, dim) {
	const primary = readBin(indexCore.embedFileFor(modelId), count, dim);
	const phrase = readBin(indexCore.phraseFileFor(modelId), count, dim);
	if (primary.length === count && phrase.length === count) {
		return [primary, phrase];
	}
	const legacyEmb = readBin(indexCore.LEGACY_EMBED_FILE, count, dim);
	const legacyPhr = readBin(indexCore.LEGACY_PHRASE_FILE, count, dim);
	if (legacyEmb.length === count) {
		if (primary.length !== count)
			console.warn(
				`[memories] no ${modelId} bin yet; using legacy bin as its pair`,
			);
		return [legacyEmb, legacyPhr.length === count ? legacyPhr : []];
	}
	return [
		primary.length === count ? primary : [],
		phrase.length === count ? phrase : [],
	];
}

/**
 * @param {string} file
 * @param {number} count
 * @param {number} dim
 * @returns {Float32Array[]}
 */
function readBin(file, count, dim) {
	const rows = readBinPartial(file, dim, { quarantine: true, file });
	// Mismatch with the requested count: a normal "this bin is for
	// a different library/model" signal, not corruption.
	if (rows.length !== count) return [];
	return rows;
}

// Length-tolerant bin read: every row the file holds (validated the same
// way as readBin), regardless of the caller's row count. The delta-switch
// planner uses this to reuse cached rows by identity when the library has

/**
 * @typedef {object} BinDecode
 * @property {Float32Array[]} [rows]
 * @property {boolean} [corrupt]
 * @property {number} [bytes]
 * @property {number[]} [header]
 *
 * @param {string} file
 * @param {number} dim
 * @param {{ quarantine?: boolean, file?: string }} [opts]
 * @returns {Float32Array[]}
 */
function readBinPartial(file, dim, opts = {}) {
	try {
		const buf = fs.readFileSync(file);
		const decoded = decodeBinRows(buf, dim);
		if (!decoded) return [];
		if (decoded.corrupt && opts.quarantine) {
			console.warn(
				`[memories] bin corrupt (bytes=${decoded.bytes} header=[${decoded.header}]) — quarantining ${opts.file || file}`,
			);
			try {
				fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				console.warn(`[memories] could not quarantine corrupt bin: ${msg}`);
			}
			return [];
		}
		if (decoded.corrupt) return [];
		return decoded.rows || [];
	} catch {
		return [];
	}
}

// Structural validation + decode shared by readBin/readBinPartial. Returns
// { rows } on success, { corrupt, bytes, header } when the file is
// internally inconsistent (truncated — quarantined by the caller, C-02), or
// null when the bin is merely for a different vector space (dim mismatch —

/**
 * @param {Buffer} buf
 * @param {number} dim
 * @returns {BinDecode | null}
 */
function decodeBinRows(buf, dim) {
	try {
		const header = new Int32Array(buf.buffer, buf.byteOffset, 2);
		const hCount = header[0];
		const hDim = header[1];
		// Structural check: is the FILE internally consistent? A bin that
		// declares more rows than its bytes can hold is truncated/corrupt.
		// A count=0 bin is the app's own "empty" representation (e.g.
		// phrases before the text model loads) — it is NOT corrupt, only
		// the 8-byte header.
		const structurallyValid =
			Number.isInteger(hCount) &&
			hCount >= 0 &&
			hCount < 1_000_000 &&
			(hCount === 0
				? buf.length >= 8
				: Number.isInteger(hDim) &&
					hDim > 0 &&
					hDim < 8192 &&
					buf.length >= 8 + hCount * hDim * 4);
		if (!structurallyValid) {
			return { corrupt: true, bytes: buf.length, header: [hCount, hDim] };
		}
		if (hDim !== dim) return null;
		/** @type {Float32Array[]} */
		const rows = [];
		for (let i = 0; i < hCount; i++) {
			rows.push(
				new Float32Array(buf.buffer, buf.byteOffset + 8 + i * dim * 4, dim),
			);
		}
		return { rows };
	} catch {
		return null;
	}
}

/**
 * @param {Array<Float32Array | null>} vectors
 * @param {number} dim
 * @returns {Buffer}
 */
function encodeBin(vectors, dim) {
	// Defensive: never write nulls (an empty vector keeps 1:1 alignment).
	const body = Buffer.concat(
		vectors.map((v) =>
			Buffer.from(
				v
					? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)
					: new ArrayBuffer(dim * 4),
			),
		),
	);
	const header = Buffer.alloc(8);
	header.writeInt32LE(vectors.length, 0);
	header.writeInt32LE(dim, 4);
	return Buffer.concat([header, body]);
}

/** @type {{ key: string | null, embeddings: Buffer | null, phrases: Buffer | null }} */
let libraryBinCache = { key: null, embeddings: null, phrases: null };

function cachedLibraryBins() {
	const l = indexCore.loadLibrary();
	const phraseDim = l.phrases.length === l.filenames.length ? l.dim : 0;
	const key = `${l.modelId}|${l.filenames.length}|${l.dim}|${phraseDim}`;
	if (libraryBinCache.key !== key) {
		libraryBinCache = {
			key,
			embeddings: encodeBin(l.embeddings, l.dim),
			phrases: encodeBin(l.phrases, phraseDim),
		};
	}
	return libraryBinCache;
}

/**
 * @param {string} modelId
 * @param {Array<Float32Array | null>} embeddings
 * @param {Array<Float32Array | null>} phrases
 * @param {number} dim
 * @param {number} phraseDim
 * @param {{ filenames?: string[], incomplete?: boolean }} [opts]
 * @returns {Promise<void>}
 */
function writeBins(modelId, embeddings, phrases, dim, phraseDim, opts = {}) {
	fs.mkdirSync(indexCore.DATA_DIR, { recursive: true });
	const embBuf = encodeBin(embeddings, dim);
	const phrBuf = encodeBin(phrases, phraseDim);
	const filenames = Array.isArray(opts.filenames) ? [...opts.filenames] : null;
	const metaJson = filenames
		? JSON.stringify({
				version: 1,
				codeVersion: modelState.EMBED_CODE_VERSION,
				modelId,
				dim,
				count: filenames.length,
				incomplete: opts.incomplete === true,
				filenames,
				writtenAt: new Date().toISOString(),
			})
		: null;
	return persist.enqueuePersist(() =>
		Promise.all([
			persist.writeFileAtomic(indexCore.embedFileFor(modelId), embBuf),
			persist.writeFileAtomic(indexCore.phraseFileFor(modelId), phrBuf),
			...(metaJson
				? [persist.writeFileAtomic(modelState.embedMetaFileFor(modelId), metaJson)]
				: []),
		]),
	)
		.then(() => {
			indexCore.bumpLibraryGeneration();
		})
		.catch((err) => {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[memories] bin write failed for ${modelId}: ${msg}`);
		});
}

/** @type {{ key: string | null, norms: Float32Array | null }} */
let libraryNormCache = { key: null, norms: null };

/**
 * @returns {Float32Array | null}
 */
function libraryNorms() {
	const l = indexCore.loadLibrary();
	const key = `${l.embeddings.length}|${l.dim}`;
	if (libraryNormCache.key !== key) {
		const dim = l.dim;
		const norms = new Float32Array(l.embeddings.length);
		for (let i = 0; i < l.embeddings.length; i++) {
			const v = l.embeddings[i];
			let s = 0;
			if (v) for (let k = 0; k < dim; k++) s += v[k] * v[k];
			norms[i] = s > 0 ? Math.sqrt(s) : 0;
		}
		libraryNormCache = { key, norms };
	}
	return libraryNormCache.norms;
}

/**
 * Dot-only helper (callers hold precomputed norms; see rank-search for the
 * normalized form).
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {number}
 */
function cosine(a, b) {
	let dot = 0;
	for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
	return dot;
}

// Reset the bin/norm caches (called by index-core's resetLibraryCaches;
// same initializers, same order as the verbatim block it replaces).
function resetBinCaches() {
	libraryBinCache = { key: null, embeddings: null, phrases: null };
	libraryNormCache = { key: null, norms: null };
}
exports.readLibraryBins = readLibraryBins;
exports.readBin = readBin;
exports.readBinPartial = readBinPartial;
exports.encodeBin = encodeBin;
exports.cachedLibraryBins = cachedLibraryBins;
exports.writeBins = writeBins;
exports.libraryNorms = libraryNorms;
exports.cosine = cosine;
exports.resetBinCaches = resetBinCaches;
