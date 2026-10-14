"use strict";
// Phase 2 (store): facade over main-lib/store/*.js — the public surface is
// byte-identical to the old monolith (same 49 exports, same behavior).
// test/library-store.test.js requires this path unchanged.
const indexCore = require("./store/index-core.js");
const bins = require("./store/bins.js");
const sidecars = require("./store/sidecars.js");
const persist = require("./store/persist.js");
const modelState = require("./store/model-state.js");

module.exports = {
	initLibraryStore: indexCore.initLibraryStore,
	resetLibraryCaches: indexCore.resetLibraryCaches,
	libraryGenerationNumber: indexCore.libraryGenerationNumber,
	embedFileFor: indexCore.embedFileFor,
	phraseFileFor: indexCore.phraseFileFor,
	segmentsMetaFileFor: indexCore.segmentsMetaFileFor,
	segmentsBinFileFor: indexCore.segmentsBinFileFor,
	transcriptsMetaFileFor: indexCore.transcriptsMetaFileFor,
	transcriptsBinFileFor: indexCore.transcriptsBinFileFor,
	thumbFor: indexCore.thumbFor,
	loadSampleQueries: indexCore.loadSampleQueries,
	readLibraryBins: bins.readLibraryBins,
	loadLibrary: indexCore.loadLibrary,
	readBin: bins.readBin,
	readBinPartial: bins.readBinPartial,
	encodeBin: bins.encodeBin,
	EMBED_CODE_VERSION: modelState.EMBED_CODE_VERSION,
	embedMetaFileFor: modelState.embedMetaFileFor,
	readEmbedMeta: modelState.readEmbedMeta,
	setEmbedIncomplete: modelState.setEmbedIncomplete,
	isZeroVector: modelState.isZeroVector,
	planDeltaReuse: modelState.planDeltaReuse,
	libraryIndex: indexCore.libraryIndex,
	libraryNorms: bins.libraryNorms,
	enqueuePersist: persist.enqueuePersist,
	writeFileAtomic: persist.writeFileAtomic,
	cachedLibraryBins: bins.cachedLibraryBins,
	cachedSegmentsBin: sidecars.cachedSegmentsBin,
	cachedTranscriptsBin: sidecars.cachedTranscriptsBin,
	writeBins: bins.writeBins,
	saveLibrary: persist.saveLibrary,
	fileMtimeMs: indexCore.fileMtimeMs,
	backfillSourceMtimes: indexCore.backfillSourceMtimes,
	loadSegments: sidecars.loadSegments,
	saveSegments: sidecars.saveSegments,
	removeSegmentsFor: sidecars.removeSegmentsFor,
	removeSegmentsForAllModels: sidecars.removeSegmentsForAllModels,
	loadTranscripts: sidecars.loadTranscripts,
	saveTranscripts: sidecars.saveTranscripts,
	resetTranscriptsFor: sidecars.resetTranscriptsFor,
	removeTranscriptsFor: sidecars.removeTranscriptsFor,
	removeTranscriptsForAllModels: sidecars.removeTranscriptsForAllModels,
	repairUntranscribedWithAudio: sidecars.repairUntranscribedWithAudio,
	loadModelState: modelState.loadModelState,
	resetModelStateCache: modelState.resetModelStateCache,
	saveModelState: modelState.saveModelState,
	thresholdsFor: modelState.thresholdsFor,
	binInfo: modelState.binInfo,
	cosine: bins.cosine,
};
