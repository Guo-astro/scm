"use strict";
// Phase 2 (store/persist): pure move from main-lib/library-store.js —
// persist queue, atomic writes, full save. Index reads ride index-core;
// bin encode/write rides bins; embed metadata rides model-state. All
// sibling access is call-time only (cycle-safe).
const fs = require("fs");
const indexCore = require("./index-core.js");
const bins = require("./bins.js");
const modelState = require("./model-state.js");

let persistQueue = Promise.resolve();
let persistSeq = 0;

function enqueuePersist(fn) {
	const run = persistQueue.then(fn);
	persistQueue = run.catch(() => {});
	return run;
}

// Write one file atomically: unique temp name (concurrent writers can't
// collide on a shared temp), fsync for durability, then rename over the
// destination. The fsync makes the bytes durable across power loss BEFORE
// the atomic rename lands (APFS rename is atomic but not durable without a

async function writeFileAtomic(file, data) {
	const tmp = `${file}.tmp-${process.pid}-${++persistSeq}`;
	const fd = await fs.promises.open(tmp, "w");
	let wrote = false;
	try {
		await fd.write(data);
		await fd.sync();
		await fd.close();
		await fs.promises.rename(tmp, file);
		wrote = true;
	} finally {
		if (!wrote) {
			try {
				await fd.close();
			} catch {
				/* already closed */
			}
			// Never litter zero-byte temps on a failed write (fd.write
			// throws first under memory pressure): sweeps and the M-04
			// no-leftovers guard assume a tmp means a write in flight.
			try {
				await fs.promises.unlink(tmp);
			} catch {
				/* already gone */
			}
		}
	}
}

// The encoded bin payloads are served to the renderer on every reload; the
// underlying rows only change when the library is saved, so the encoded
// Buffer is memoized and rebuilt only when (model, row count, dim) moves.
// Keyed on the LIVE in-memory state so the served bytes always match the
// index the renderer just fetched — and migration checkpoints (which write
// partial TARGET-model bins through writeBins) can never pollute it. The
// cache is dropped in saveLibrary: a same-size mutation (a healed phrase

async function saveLibrary() {
	const l = indexCore.loadLibrary();
	// A retired/unknown model's rows are deliberately withheld while main
	// builds a replacement index. Startup maintenance (timestamps, stale-row
	// pruning, OCR, etc.) may call saveLibrary before that async migration
	// begins; letting one of those writes through would replace the only
	// recoverable old index with an empty target-model bin. The migration
	// clears this guard immediately before its final atomic save.
	if (l.pendingModelMigration) return;
	fs.mkdirSync(indexCore.DATA_DIR, { recursive: true });
	const indexJson = JSON.stringify(indexCore.libraryIndex());
	const phraseDim = l.phrases.length === l.filenames.length ? l.dim : 0;
	const embBuf = bins.encodeBin(l.embeddings, l.dim);
	const phrBuf = bins.encodeBin(l.phrases, phraseDim);
	// Row-identity snapshot for the delta-switch planner, captured at the
	// same moment as the bins above so the pair can never diverge (see
	// writeBins). A background fill in progress stamps incomplete:true via
	// setEmbedIncomplete, so a crash resumes the tail on next launch.
	const metaJson = JSON.stringify({
		version: 1,
		codeVersion: modelState.EMBED_CODE_VERSION,
		modelId: l.modelId,
		dim: l.dim,
		count: l.filenames.length,
		incomplete: modelState.embedIncompleteByModel.get(l.modelId) === true,
		filenames: [...l.filenames],
		writtenAt: new Date().toISOString(),
	});
	// Rows changed under this key (e.g. a healed phrase row keeps the same
	// count/dim) — drop the memoized payload so the next fetch re-encodes.
	bins.resetBinCaches();
	try {
		await enqueuePersist(async () => {
			// Bins first, index last: a crash between renames leaves either
			// the old index (consistent with the old bins) or a new index
			// whose bins already landed — never a new index pointing at
			// bins that haven't been written yet. The load-time count check
			// self-heals either way, but this keeps the on-disk pair
			// consistent and avoids a full re-embed.
			await Promise.all([
				writeFileAtomic(indexCore.embedFileFor(l.modelId), embBuf),
				writeFileAtomic(indexCore.phraseFileFor(l.modelId), phrBuf),
				writeFileAtomic(modelState.embedMetaFileFor(l.modelId), metaJson),
			]);
			await writeFileAtomic(indexCore.INDEX_FILE, indexJson);
			indexCore.bumpLibraryGeneration();
		});
	} catch (err) {
		// Persistence failure must not crash the flow that triggered it: the
		// in-memory library (what the renderer reads) is still consistent,
		// and the next save retries the disk write.
		console.warn(`[memories] library save failed: ${err.message}`);
	}
}

// The first release with sourceMtimes must repair libraries that already had
// arbitrary fs.readdir order baked into `images`. Read the source file when
// possible; an app-managed copy's mtime is a useful import-time fallback when
// its original was moved or deleted. This deliberately changes metadata only

exports.enqueuePersist = enqueuePersist;
exports.writeFileAtomic = writeFileAtomic;
exports.saveLibrary = saveLibrary;
