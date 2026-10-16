// CLIP indexer worker. Runs under Electron's utilityProcess (plain Node —
// same environment as the site's build script, which is where this logic
// comes from). Owns the single CLIP model instance and answers:
//   { type: "init" }                      → { type: "init-done", ok, modelId, dim, textMean, error }
//   { type: "embed-photo", path, filename } → { type: "photo-done", id, ok, vec, phrase, error }
//   { type: "embed-video", path, filename } → { type: "video-done", id, ok, vec, phrase, error }
//   { type: "embed-query", text }         → { type: "query-done", id, ok, vec, error }
//   { type: "embed-phrase", filename }    → { type: "phrase-done", id, ok, vec, error }
//   { type: "get-text-mean" }             → { type: "text-mean-done", id, ok, textMean, error }
//   { type: "shutdown" }                  → process.exit(0)
// Model download progress is broadcast as { type: "model", phase: "loading", progress }.
// The model is selected by INDEXER_MODEL (registry id; default clip-vit-l14-336).
// Also usable standalone: `node indexer/indexer.js --smoke` runs a self-test
// with a generated image + real query (no parentPort needed).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { spawnSync } from "node:child_process";
import { assertNever } from "../main-lib/assert-never.ts";
import * as core from "./build-memory-embeddings-core.ts";
import {
	buildFilenamePhrase,
	centerText,
	TEXT_MEAN_SAMPLE,
} from "./memory-embedding-utils.ts";
import * as videoUtils from "./video-utils.ts";
import {
	SEGMENTS_PER_CHUNK,
	ENRICH_HEARTBEAT_INTERVAL_MS,
} from "./segment-store-utils.ts";

// transformers.js model-download progress tick — their ProgressInfo union,
// aliased for readability. loaded/total exist only on the "progress" arm,
// so narrow on status before reading them.
type WeightProgress = import("@huggingface/transformers").ProgressInfo;

// Text-encoder bundle consumed by core.embedText (the transformers.js
// tokenizer + text model + the key the model emits its embedding under).
interface TextPair {
	tokenizer: any;
	textModel: any;
	outputKey: string;
}

// The worker's model bundle (CLIP or EmbeddingGemma flavor). Fields typed
// `any` are the transformers.js objects themselves — the dynamic interop
// seam this worker deliberately keeps loose; everything else is precise.
interface ModelState {
	extractor: any;
	RawImage: any;
	sharp: any;
	tokenizer: any;
	textModel: any;
	textMean: Float32Array | null;
	dim: number;
	outputKey: string;
	isGemma?: boolean;
	processor?: any;
	gemmaModel?: any;
}

// The model this worker serves. INDEXER_MODEL carries the registry id (main
// spawns the pool with the library's active model); unknown ids resolve to
// the default so a stale library can never brick the worker — hence the
// non-null cast (the typed models.ts surface surfaced this implicit
// assumption from the unchecked require).
const MODEL_CONFIG = core.getModelConfig(
	process.env.INDEXER_MODEL || "",
) as ModelConfig;
const MODEL_ID = MODEL_CONFIG.repo;
const MODEL_REGISTRY_ID = core.resolveModelId(process.env.INDEXER_MODEL || "");
import {
	resolveGemmaDtype,
	gemmaQueryPrefix,
	gemmaDocumentPrefix,
	type ModelConfig,
} from "./models.ts";
const IS_GEMMA = Boolean(
	MODEL_CONFIG && MODEL_CONFIG.family === "embeddinggemma",
);

// ONNX Runtime EPs (plan 0.3): comma list in SCM_EXECUTION_PROVIDERS,
// default "cpu" (same as scripts/bench-common.js executionProviders()).
// Set e.g. SCM_EXECUTION_PROVIDERS=coreml,cpu to A/B — never flip default.
function executionProviders() {
	const list = (process.env.SCM_EXECUTION_PROVIDERS || "cpu")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return list.length ? list : ["cpu"];
}

function discardIncompleteWeights() {
	const minimums = MODEL_CONFIG.minimumWeightBytes;
	const cacheRoot = process.env.TRANSFORMERS_CACHE;
	if (!minimums || !cacheRoot) return;
	const modelRoot = path.join(cacheRoot, ...MODEL_ID.split("/"));
	for (const [relativePath, minimumBytes] of Object.entries(
		minimums as Record<string, number>,
	)) {
		const file = path.join(modelRoot, relativePath);
		try {
			if (fs.statSync(file).size < minimumBytes) {
				fs.unlinkSync(file);
				console.warn(
					`[indexer] discarded incomplete model weight: ${relativePath}`,
				);
			}
		} catch {
			// Missing files are normal on a first download.
		}
	}
}

// transformers.js caches remote files directly at their final path. If a
// large Xet-hosted download is interrupted, that partial file can then be
// treated as a cache hit forever. Models that declare expected weight sizes
// use this atomic downloader instead: write to a temporary sibling, verify
// its size, then rename it into the cache only when complete.
async function ensureCompleteWeights(
	progress_callback: (progress: WeightProgress) => void,
): Promise<void> {
	const minimums = MODEL_CONFIG.minimumWeightBytes;
	const cacheRoot = process.env.TRANSFORMERS_CACHE;
	if (!minimums || !cacheRoot) return;
	const modelRoot = path.join(cacheRoot, ...MODEL_ID.split("/"));

	for (const [relativePath, minimumBytes] of Object.entries(
		minimums as Record<string, number>,
	)) {
		const target = path.join(modelRoot, relativePath);
		try {
			if (fs.statSync(target).size >= minimumBytes) continue;
		} catch {
			// Download below.
		}

		const temp = `${target}.partial`;
		fs.mkdirSync(path.dirname(target), { recursive: true });
		try {
			fs.unlinkSync(temp);
		} catch {
			/* temp may not exist — best-effort cleanup */
		}

		const response = await downloadResponse(
			`https://huggingface.co/${MODEL_ID}/resolve/main/${relativePath}`,
		);
		const total = Number(response.headers["content-length"]) || 0;
		const stream = fs.createWriteStream(temp);
		let loaded = 0;
		try {
			for await (const value of response) {
				const flushed = new Promise<void>((resolve, reject) => {
					stream.write(value, (err) => (err ? reject(err) : resolve()));
				});
				await flushed;
				loaded += value.length;
				if (total > 0) {
					// Full ProgressStatusInfo shape (the library's own tick);
					// our callers only read status/loaded/total.
					progress_callback({
						status: "progress",
						name: MODEL_ID,
						file: relativePath,
						progress: (loaded / total) * 100,
						loaded,
						total,
					});
				}
			}
			// end()'s callback takes no arguments (failures surface as
			// 'error' events / write rejections above), so resolve directly.
			const finished = new Promise<void>((resolve) =>
				stream.end(() => resolve()),
			);
			await finished;
			if (loaded < minimumBytes || (total > 0 && loaded !== total)) {
				throw new Error(`Incomplete download for ${relativePath}`);
			}
			fs.renameSync(temp, target);
		} catch (err) {
			stream.destroy();
			try {
				fs.unlinkSync(temp);
			} catch {
				/* temp may already be gone — best-effort cleanup */
			}
			throw err;
		}
	}
}

function downloadResponse(
	url: string,
	redirects = 0,
): Promise<import("node:http").IncomingMessage> {
	if (redirects > 5)
		return Promise.reject(new Error("Too many model download redirects"));
	return new Promise((resolve, reject) => {
		const request = https.get(
			url,
			{ headers: { "User-Agent": "scm-model-downloader" } },
			(response) => {
				const code = response.statusCode ?? 0;
				if (code >= 300 && code < 400 && response.headers.location) {
					response.resume();
					resolve(
						downloadResponse(
							response.headers.location as string,
							redirects + 1,
						),
					);
					return;
				}
				if (code !== 200) {
					response.resume();
					reject(
						new Error(
							`Could not download model weight (HTTP ${response.statusCode})`,
						),
					);
					return;
				}
				resolve(response);
			},
		);
		request.on("error", reject);
	});
}

// Scene enrichment (Phase 1 of scene search) processes segments in bounded
// chunks so a query that preempts the queue waits at most one chunk
// (16 × ~86 ms ≈ 1.4 s worst case, typically 0 because main paces around
// queries — see DESIGN-SCENE-SEARCH.md §7). Shared with main.js and the
// unit tests via segment-store-utils.js (single source of truth).
// Holds the in-flight load PROMISE (memoized so a second caller awaits the
// same load; the catch path resets it to null so a retry can re-load).
let state: Promise<ModelState> | null = null;

// Scratch state for enrich-video chunking: the segment plan of the CURRENT
// file (keyed by path) survives between chunks, so a query that preempts the
// queue doesn't force a redundant ffmpeg scene pass on the next chunk.
let enrichScratch: {
	path: string;
	budgetKey: string;
	plan: Array<{ t: number; dur: number }>;
} | null = null;

function post(
	message:
		| import("../shared/worker-messages.ts").IndexerOutbound
		| { type: string; id?: string; ok: false; error: string },
) {
	if (process.parentPort) {
		process.parentPort.postMessage(message);
	}
}

// Report every ffmpeg spawn/exit to main so it can kill by PID even after
// this worker dies (the orphan fix: main-side PID map survives the worker).
try {
	videoUtils.setFfmpegReporter((event: Record<string, unknown>) => {
		if (!event) return;
		if (event.type === "ffmpeg-spawn" || event.type === "ffmpeg-exit") {
			post({ ...event } as Parameters<typeof post>[0]);
		}
	});
} catch {
	/* reporter wiring is best-effort */
}

// Mirror of buildQueryTemplates in app/hooks/useMemorySearch.ts (the site's
// runtime query embedding: template-average then center). KEEP IN SYNC.
// Gemma family: single task-prefixed query (no photo/screenshot templates —
// the model card prefixes replace them; averaging unprefixed templates would
// dilute the task steering).
function buildQueryTemplates(query: string): string[] {
	const q = query.trim();
	if (IS_GEMMA) return [gemmaQueryPrefix(q)];
	const templates = [q];
	if (q.length >= 4) {
		templates.push(`a photo of ${q}`, `a screenshot of ${q}`);
	}
	return templates;
}

// Gemma-only: filename phrase → document-prefixed corpus text. The filename
// stem doubles as the title when present (improves retrieval per model card;
// "title: none" fallback otherwise).
function gemmaPhraseDocument(filename: string): string {
	const phrase = buildFilenamePhrase(filename);
	const stem = String(filename || "")
		.replace(/\.[^.]+$/, "")
		.trim();
	const title = stem ? stem.slice(0, 80) : "none";
	return gemmaDocumentPrefix(phrase || stem || filename, title);
}

// L2-normalized average of the template embeddings — same math as the
// site's averageEmbeddings in useMemorySearch.ts.
function averageEmbeddings(vecs: Float32Array[]): Float32Array | null {
	if (vecs.length === 0) return null;
	const dim = (vecs[0] as Float32Array).length;
	const sum = new Float32Array(dim);
	for (const e of vecs) {
		if (e.length !== dim) return null;
		// Bounds-proven reads (i < dim = e.length = sum.length): the casts
		// keep dense typed-array behavior instead of dead undefined checks.
		for (let i = 0; i < dim; i++) {
			sum[i] = (sum[i] as number) + (e[i] as number);
		}
	}
	let norm = 0;
	for (let i = 0; i < dim; i++) {
		const v = sum[i] as number;
		norm += v * v;
	}
	norm = Math.sqrt(norm);
	if (norm <= 0) return null;
	for (let i = 0; i < dim; i++) {
		sum[i] = (sum[i] as number) / norm;
	}
	return sum;
}

// Average of two unit vectors, renormalized (animated-GIF middle frame).
function averageVectors(a: Float32Array, b: Float32Array): Float32Array {
	const avg = new Float32Array(a.length);
	// Bounds-proven reads (i < a.length): casts keep dense typed-array
	// behavior instead of dead undefined checks (short `b` still NaNs).
	for (let i = 0; i < a.length; i++) {
		avg[i] = (a[i] as number) + (b[i] as number);
	}
	let norm = 0;
	for (let i = 0; i < a.length; i++) {
		const v = avg[i] as number;
		norm += v * v;
	}
	norm = Math.sqrt(norm);
	if (norm <= 0) return a;
	for (let i = 0; i < a.length; i++) {
		avg[i] = (avg[i] as number) / norm;
	}
	return avg;
}

// The state's text-encoder bundle, shaped for core.embedText: tokenizer +
// text model + the output key the model emits its embedding under
// ("text_embeds" for CLIP, "pooler_output" for SigLIP).
function textPair(s: ModelState): TextPair {
	return {
		tokenizer: s.tokenizer,
		textModel: s.textModel,
		outputKey: s.outputKey,
	};
}

// --- EmbeddingGemma unified path (family "embeddinggemma") ---
// Single AutoModel + AutoProcessor emitting sentence_embedding (L2-
// normalized). Text inputs are task-prefixed; images pass without prefix.
// Throws on fp16 dtypes (silent corruption — see models.js).
function gemmaNormalize(
	vec: number[] | Float32Array,
	expectedDim: number,
): Float32Array {
	const out = new Float32Array(vec);
	if (expectedDim > 0 && out.length !== expectedDim) {
		throw new Error(
			`Embedding dimension mismatch: expected ${expectedDim}, got ${out.length}`,
		);
	}
	let norm = 0;
	for (let i = 0; i < out.length; i++) {
		// Bounds-proven read (i < out.length): the cast keeps dense
		// typed-array behavior; the checks below still guard bad input.
		const v = out[i] as number;
		if (typeof v !== "number" || Number.isNaN(v))
			throw new Error(`Embedding contains NaN at index ${i}`);
		if (!Number.isFinite(v))
			throw new Error(`Embedding contains non-finite value at index ${i}`);
		norm += v * v;
	}
	norm = Math.sqrt(norm);
	if (norm <= 0) throw new Error("Embedding has zero norm (cannot normalize)");
	for (let i = 0; i < out.length; i++) {
		out[i] = (out[i] as number) / norm;
	}
	return out;
}

async function gemmaEmbedText(
	text: string,
	s: ModelState,
	expectedDim: number,
): Promise<Float32Array> {
	const inputs = await s.processor([text]);
	const outputs = await s.gemmaModel(inputs);
	const data = outputs.sentence_embedding;
	// Batched [1, dim] → single row. sentence_embedding may be a Tensor with
	// .data (flat) + .dims, or nested arrays depending on transformers.js v4.
	let row;
	if (data && typeof data.tolist === "function") {
		const listed = await data.tolist();
		row = Array.isArray(listed[0]) ? listed[0] : listed;
	} else if (data && data.data) {
		const dims = data.dims || data.shape;
		const flat = Array.from(data.data);
		row = dims && dims.length === 2 ? flat.slice(0, dims[1]) : flat;
	} else {
		row = Array.from(data);
	}
	return gemmaNormalize(row, expectedDim);
}

async function gemmaEmbedImage(
	raw: { data: Uint8Array; width: number; height: number; channels: number },
	s: ModelState,
	expectedDim: number,
): Promise<Float32Array> {
	const image = new s.RawImage(raw.data, raw.width, raw.height, raw.channels);
	const inputs = await s.processor(null, image);
	const outputs = await s.gemmaModel(inputs);
	const data = outputs.sentence_embedding;
	let row;
	if (data && typeof data.tolist === "function") {
		const listed = await data.tolist();
		row = Array.isArray(listed[0]) ? listed[0] : listed;
	} else if (data && data.data) {
		const dims = data.dims || data.shape;
		const flat = Array.from(data.data);
		row = dims && dims.length === 2 ? flat.slice(0, dims[1]) : flat;
	} else {
		row = Array.from(data);
	}
	return gemmaNormalize(row, expectedDim);
}

async function gemmaComputeTextMean(
	s: ModelState,
	expectedDim: number,
): Promise<Float32Array | null> {
	try {
		const vecs: Float32Array[] = [];
		for (const text of TEXT_MEAN_SAMPLE) {
			vecs.push(await gemmaEmbedText(gemmaQueryPrefix(text), s, expectedDim));
		}
		const mean = new Float32Array(expectedDim);
		// Bounds-proven reads (i < expectedDim = v.length = mean.length):
		// casts keep dense typed-array behavior — no dead undefined checks.
		for (const v of vecs) {
			for (let i = 0; i < expectedDim; i++) {
				mean[i] = (mean[i] as number) + (v[i] as number);
			}
		}
		for (let i = 0; i < expectedDim; i++) {
			mean[i] = (mean[i] as number) / vecs.length;
		}
		let norm = 0;
		for (let i = 0; i < expectedDim; i++) {
			const mv = mean[i] as number;
			norm += mv * mv;
		}
		norm = Math.sqrt(norm);
		if (norm <= 0) return null;
		for (let i = 0; i < expectedDim; i++) {
			mean[i] = (mean[i] as number) / norm;
		}
		return mean;
	} catch (err) {
		const e = err as { message?: string } | null;
		console.warn(
			`[indexer] Gemma text-mean estimation failed (${e && e.message}); using uncentered embeddings`,
		);
		return null;
	}
}

async function loadGemmaModels(
	mod: any, // the dynamic transformers.js import (loose interop seam)
	progress_callback: (progress: WeightProgress) => void,
): Promise<ModelState> {
	const dtype = resolveGemmaDtype(MODEL_REGISTRY_ID);
	console.log(`[indexer] loading EmbeddingGemma (dtype ${dtype})…`);
	console.log("[indexer] loading sharp…");
	const sharp = (await import("sharp")).default;
	const RawImage = mod.RawImage;
	const eps = executionProviders();
	const session_options = { executionProviders: eps };
	console.log(`[indexer] EP ${eps.join(",")}`);
	// Strip the unused audio encoder to save ~340MB q8 (photo+scenes scope).
	// The feature-extraction pipeline would load every encoder — AutoModel
	// with a stripped config is the only path that actually skips it.
	let config = null;
	try {
		config = await mod.AutoConfig.from_pretrained(MODEL_ID);
		if (MODEL_CONFIG.skipAudio) {
			config.audio_config = null;
		}
	} catch (err) {
		const e = err as { message?: string } | null;
		console.warn(
			`[indexer] AutoConfig load failed (${e && e.message}); continuing`,
		);
	}
	const processor = await mod.AutoProcessor.from_pretrained(MODEL_ID);
	try {
		if (
			processor &&
			processor.image_processor &&
			MODEL_CONFIG.visionTokenBudget
		) {
			processor.image_processor.max_soft_tokens =
				MODEL_CONFIG.visionTokenBudget;
		}
	} catch {
		/* budget knob is best-effort across transformers.js versions */
	}
	console.log("[indexer] loading Gemma AutoModel…");
	const gemmaModel = await mod.AutoModel.from_pretrained(MODEL_ID, {
		...(config ? { config } : {}),
		dtype,
		session_options,
		progress_callback,
	});
	console.log("[indexer] Gemma model ready");
	// Dim probe through the real graph (output dim is truth, registry a check).
	let dim = MODEL_CONFIG.dim;
	// Dim probes only exercise the gemma slice (processor/model/RawImage);
	// the remaining ModelState fields are placeholders so the probe can
	// reuse the shared gemma helpers unchanged.
	/** @type {ModelState} */
	const probeState = {
		processor,
		gemmaModel,
		RawImage,
		extractor: null,
		sharp,
		tokenizer: null,
		textModel: null,
		textMean: null,
		dim: 0,
		outputKey: "sentence_embedding",
		isGemma: true,
	};
	try {
		const { data, info } = await sharp({
			create: {
				width: 32,
				height: 32,
				channels: 3,
				background: { r: 64, g: 64, b: 128 },
			},
		})
			.raw()
			.toBuffer({ resolveWithObject: true });
		const probeVec = await gemmaEmbedImage(
			{
				data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
				width: info.width,
				height: info.height,
				channels: info.channels,
			},
			probeState,
			MODEL_CONFIG.dim,
		);
		dim = probeVec.length;
		if (MODEL_CONFIG.dim > 0 && dim !== MODEL_CONFIG.dim) {
			console.warn(
				`[indexer] model outputs ${dim}-dim embeddings ` +
					`(registry declared ${MODEL_CONFIG.dim}); adopting actual dim`,
			);
		}
		// Text tower probe (prefixed) — validates the processor+model text path.
		await gemmaEmbedText(
			gemmaQueryPrefix("a screenshot of a beach"),
			probeState,
			dim,
		);
		console.log(`[indexer] Gemma smoke probe ok (${dim}-dim)`);
	} catch (err) {
		const e = err as { message?: string } | null;
		console.warn(
			`[indexer] Gemma dim probe failed (${e && e.message}); assuming ${dim}`,
		);
	}
	// Text-mean: adopt shipped/cached constant when present, else compute over
	// prefixed samples and cache (same resolveTextMean wrapper, gemma compute).
	// eslint-disable-next-line no-useless-assignment
	let textMean = null;
	try {
		const hit = await core.resolveTextMean({
			registryId: MODEL_REGISTRY_ID,
			dim,
			textPair: null,
			textMaxLength: 0,
			log: console,
		});
		// resolveTextMean without a textPair cannot compute; fall through to
		// gemma compute when no constant was found (null).
		if (hit) {
			textMean = hit;
		} else {
			const computed = await gemmaComputeTextMean(probeState, dim);
			textMean = computed;
			if (computed) {
				try {
					core.saveTextMeanConstant(MODEL_REGISTRY_ID, computed);
				} catch {
					/* cache write is best-effort */
				}
			}
		}
	} catch {
		textMean = await gemmaComputeTextMean(probeState, dim);
	}
	console.log("[indexer] Gemma models ready");
	return {
		extractor: null,
		RawImage,
		sharp,
		tokenizer: null,
		textModel: null,
		textMean,
		dim,
		outputKey: "sentence_embedding",
		isGemma: true,
		processor,
		gemmaModel,
	};
}

async function ensureModel(): Promise<ModelState> {
	if (state) return state;
	if (state === null) {
		state = loadModels();
	}
	return state;
}

async function loadModels(): Promise<ModelState> {
	try {
		console.log(
			`[indexer] loading transformers.js (model ${MODEL_CONFIG.label})…`,
		);
		const mod = await import("@huggingface/transformers");
		if (process.env.TRANSFORMERS_CACHE) {
			mod.env.cacheDir = process.env.TRANSFORMERS_CACHE;
		}
		discardIncompleteWeights();
		const progress_callback = (progress: WeightProgress) => {
			if (progress.status === "progress" && progress.total > 0) {
				post({
					type: "model",
					phase: "loading",
					progress: Math.min(99, (progress.loaded / progress.total) * 100),
				});
			}
		};
		post({ type: "model", phase: "loading", progress: 0 });
		await ensureCompleteWeights(progress_callback);
		// Unified Gemma path branches here (no split vision/text towers).
		if (IS_GEMMA) return loadGemmaModels(mod, progress_callback);
		console.log("[indexer] loading sharp…");
		const sharp = (await import("sharp")).default;
		console.log("[indexer] loading CLIP image pipeline…");
		const RawImage = mod.RawImage;
		const eps = executionProviders();
		const session_options = { executionProviders: eps };
		console.log(`[indexer] EP ${eps.join(",")}`);
		const extractor = await mod.pipeline("image-feature-extraction", MODEL_ID, {
			// transformers.js v3 replaced the v2 `quantized` flag with `dtype`
			// (q8 loads the same *_quantized.onnx files as before).
			dtype: MODEL_CONFIG.visionQuantized ? "q8" : "fp32",
			session_options,
			progress_callback,
			...(MODEL_CONFIG.modelFileName
				? {
						model_file_name: MODEL_CONFIG.modelFileName,
						subfolder: MODEL_CONFIG.subfolder,
					}
				: {}),
		});
		console.log("[indexer] CLIP image pipeline ready");

		// Dim probe: embed one generated image straight through the ONNX
		// graph. The OUTPUT dim is the truth (the registry value is a check),
		// and every later embed is validated against it via state.dim.
		let dim = MODEL_CONFIG.dim;
		try {
			const probe = await core.runSmokeTest(
				extractor,
				RawImage,
				sharp,
				console,
				null,
				MODEL_CONFIG.dim,
				0,
				MODEL_CONFIG.visionPool,
			);
			dim = probe.vec.length;
			if (MODEL_CONFIG.dim > 0 && dim !== MODEL_CONFIG.dim) {
				console.warn(
					`[indexer] model outputs ${dim}-dim embeddings ` +
						`(registry declared ${MODEL_CONFIG.dim}); adopting actual dim`,
				);
			}
		} catch (err) {
			const e = err as { message?: string } | null;
			console.warn(
				`[indexer] dim probe failed (${e && e.message}); assuming ${dim}`,
			);
		}

		let tokenizer = null;
		let textModel = null;
		let textMean = null;
		try {
			console.log("[indexer] loading text model…");
			// The text tower's class is per-model: CLIP exports load as
			// CLIPTextModelWithProjection; SigLIP exports
			// ship a separate text_model graph loaded as SiglipTextModel.
			const TextClass =
				MODEL_CONFIG.textClass === "siglip"
					? mod.SiglipTextModel
					: mod.CLIPTextModelWithProjection;
			[tokenizer, textModel] = await Promise.all([
				mod.AutoTokenizer.from_pretrained(MODEL_ID),
				TextClass.from_pretrained(MODEL_ID, {
					dtype: MODEL_CONFIG.textQuantized === false ? "fp32" : "q8",
					session_options,
					progress_callback,
					...(MODEL_CONFIG.subfolder
						? { subfolder: MODEL_CONFIG.subfolder }
						: {}),
					...(MODEL_CONFIG.textModelFileName
						? { model_file_name: MODEL_CONFIG.textModelFileName }
						: {}),
				}),
			]);
			// textMean is deterministic per (weights, tokenizer, sample, dim).
			// Adopt the shipped/cached constant when present (skips ~830ms
			// TEXT_MEAN_SAMPLE embed on every worker launch / model switch);
			// otherwise compute once and write the writable cache.
			textMean = await core.resolveTextMean({
				registryId: MODEL_REGISTRY_ID,
				dim,
				textPair: {
					tokenizer,
					textModel,
					outputKey: MODEL_CONFIG.textOutputKey,
				},
				textMaxLength: MODEL_CONFIG.textMaxLength,
				log: console,
			});
		} catch (err) {
			const e = err as { message?: string } | null;
			console.warn(
				`[indexer] Text model failed to load (${e && e.message}); image-only ranking`,
			);
		}

		console.log("[indexer] models ready");
		return {
			extractor,
			RawImage,
			sharp,
			tokenizer,
			textModel,
			textMean,
			dim,
			outputKey: MODEL_CONFIG.textOutputKey || "text_embeds",
		};
	} catch (err) {
		state = null;
		throw err;
	}
}

async function embedImageVec(raw: any, s: ModelState): Promise<Float32Array> {
	if (s.isGemma) return gemmaEmbedImage(raw, s, s.dim);
	return core.embedRawImage(
		s.extractor,
		s.RawImage,
		raw,
		s.dim,
		MODEL_CONFIG.visionPool,
	);
}

async function embedPhraseVec(
	filename: string,
	s: ModelState,
): Promise<Float32Array | null> {
	if (s.isGemma) {
		const doc = gemmaPhraseDocument(filename);
		const vec = await gemmaEmbedText(doc, s, s.dim);
		// Cast: centerOrRaw returns the input vec or its centered form —
		// both Float32Array at runtime.
		return core.centerOrRaw(vec, s.textMean) as Float32Array;
	}
	return core.centerOrRaw(
		await core.embedText(
			buildFilenamePhrase(filename),
			textPair(s),
			s.dim,
			MODEL_CONFIG.textMaxLength,
		),
		s.textMean,
	) as Float32Array;
}

function hasTextTower(s: ModelState): boolean {
	if (s.isGemma) return Boolean(s.gemmaModel && s.processor);
	return Boolean(s.tokenizer && s.textModel);
}

async function embedPhoto(filePath: string, filename: string) {
	const s = await ensureModel();
	const first = await core.decodeToRaw(
		filePath,
		s.sharp,
		MODEL_CONFIG.inputSize,
	);
	let vec = await embedImageVec(first, s);

	const midPage = await core.gifMiddlePage(filePath, s.sharp);
	if (midPage !== null) {
		try {
			const mid = await core.decodeFrame(
				filePath,
				s.sharp,
				midPage,
				MODEL_CONFIG.inputSize,
			);
			const midVec = await embedImageVec(mid, s);
			vec = averageVectors(vec, midVec);
		} catch (err) {
			const e = err as { message?: string } | null;
			console.warn(
				`[indexer] Middle-frame embed failed for ${filename} (${e && e.message}); using first frame`,
			);
		}
	}

	let phrase = null;
	if (hasTextTower(s)) {
		phrase = await embedPhraseVec(filename, s);
	}

	return {
		vec: Array.from(vec),
		phrase: phrase ? Array.from(phrase) : null,
	};
}

// Videos cannot be embedded directly: extract N evenly spaced raw frames
// in memory (plan 0.5 — no temp JPEGs), embed each through the same image
// path, and L2-average the vectors (same representative-content approach
// as animated GIFs).
async function embedVideo(filePath: string, filename: string) {
	const s = await ensureModel();
	const ffmpeg = videoUtils.resolveFfmpeg();
	const frames = await videoUtils.extractFrames(ffmpeg, filePath);
	if (frames.length === 0) {
		throw new Error("No frames extracted from video");
	}
	let vec = null;
	for (const frame of frames) {
		const raw = await core.decodeToRaw(frame, s.sharp, MODEL_CONFIG.inputSize);
		const frameVec = await embedImageVec(raw, s);
		vec = vec ? averageVectors(vec, frameVec) : frameVec;
	}

	let phrase = null;
	if (hasTextTower(s)) {
		phrase = await embedPhraseVec(filename, s);
	}

	return {
		vec: vec ? Array.from(vec) : null,
		phrase: phrase ? Array.from(phrase) : null,
	};
}

// Scene-segment enrichment (Phase 1+2 of scene search): build the video's
// segment plan (ffmpeg shot boundaries, interval fallback), then embed each
// segment's midpoint frame through the same CLIP image path as embed-video.
// Chunked (≤ SEGMENTS_PER_CHUNK per call; `fromIndex` picks up where the
// previous chunk stopped) so the priority queue can run queries between
// chunks. The 480px midpoint frame is ALSO persisted as the scene poster
// (<stem>-scene-<gi>.jpg in opts.postersDir, encoded from the in-memory
// frame — plan 0.5) so the renderer can show the best-scene thumbnail
// without another ffmpeg pass.
//
// Decode-ahead (0.2): each segment's CLIP embed overlaps the NEXT segment's
// ffmpeg seek (2-deep pipeline). Measured profile: seek ~22–51 ms vs CLIP
// ~54–104 ms, so the serial composite collapses toward max(seek, CLIP) ≈
// 1.4–1.5× on the segment loop. Frame order, poster names, and the
// SEGMENTS_PER_CHUNK reply contract are unchanged.
//
// Never-stall contract (long-film fix): ONE bad segment must not kill the
// chunk or the film. Each segment is isolated in try/catch — a failed raw
// extraction, poster encode, or CLIP embed records a skipped marker
// ({t,dur,poster:gi,gi,skipped:true,error}) with a null vec slot, posts an
// embed-progress tick ANYWAY (so the tray keeps moving past the gap), and
// the chunk continues. The reply keeps parallel arrays (segments[i] ↔
// vecs[i], null = skipped) so main.js can partition and still advance
// fromIndex past failures. A heartbeat timer posts the CURRENT gi/t/step
// every ENRICH_HEARTBEAT_INTERVAL_MS while the chunk runs, so the main
// process can tell "slow but alive" from "wedged" even when a single ffmpeg
// spawn hangs silently. Returns
// { done, segments, vecs, fromIndex, total, succeeded, skipped }.
async function enrichVideo(
	filePath: string,
	fromIndex = 0,
	opts: {
		filename?: string;
		postersDir?: string | null;
		budget?: object | null;
		onProgress?: ((p: Record<string, unknown>) => void) | null;
	} = {},
) {
	const s = await ensureModel();
	const ffmpeg = videoUtils.resolveFfmpeg();
	// Hoisted so the relay below keeps its narrowing inside closures.
	const onProgress = opts.onProgress || null;
	// `opts.budget` is a VIDEO_QUALITY_PRESETS entry (or null for the
	// balanced default), supplied per-message by the main process from the
	// user's Settings → Video search quality preset.
	const budgetOpts = opts.budget || null;
	const budgetKey = JSON.stringify(budgetOpts);
	// The plan is rebuilt when the file changes, or when a FRESH job
	// (fromIndex 0) arrives under a different budget — e.g. right after a
	// preset switch or a re-analysis. Continuation chunks (fromIndex > 0)
	// deliberately keep the plan they started with: segment offsets are
	// indices into that exact plan, so mid-job budget swaps would misalign
	// the sidecar.
	if (
		!enrichScratch ||
		enrichScratch.path !== filePath ||
		(fromIndex === 0 && enrichScratch.budgetKey !== budgetKey)
	) {
		enrichScratch = {
			path: filePath,
			budgetKey,
			// `opts.onProgress` relays shot-detection decode progress to the
			// UI (the long, silent part for a big movie); the embed phase
			// reports per-chunk done/total below.
			plan: await videoUtils.buildSegmentPlan(
				ffmpeg,
				filePath,
				onProgress ? (p) => onProgress({ phase: "detect", ...p }) : null,
				budgetOpts as import("./video-utils.ts").BudgetOpts | null,
				// Phase 1 detect knobs (VideoToolbox / low-res / keyframe /
				// per-file cache). Defaults keep the historic software 360p
				// contract; cache writes under MEMORIES_DATA_DIR when present.
				{
					cacheDir:
						process.env.SCM_DETECT_CACHE_DIR ||
						process.env.MEMORIES_DATA_DIR ||
						null,
				},
			),
		};
	}
	const plan = enrichScratch.plan;
	const slice = plan.slice(fromIndex, fromIndex + SEGMENTS_PER_CHUNK);
	const first = slice[0];
	if (!first) {
		return {
			done: true,
			segments: [],
			vecs: [],
			fromIndex,
			total: plan.length,
		};
	}
	const posterDir = opts.postersDir || null;
	const posterStem = opts.filename
		? opts.filename.replace(/\.[^.]+$/, "")
		: null;
	if (posterDir) {
		fs.mkdirSync(posterDir, { recursive: true });
	}
	// Heartbeat: while a single ffmpeg spawn hangs with no output, the
	// per-segment progress below cannot fire — post the CURRENT gi/t/step
	// on an interval so main.js can distinguish slow-but-alive from wedged.
	let currentGi = fromIndex;
	let currentT = first.t;
	let currentStep = "ffmpeg";
	let completedInChunk = 0;
	let heartbeatTimer = null;
	// Decode-ahead: in-flight extractFrameRaw for the NEXT segment (started
	// after this frame is in hand, so it runs under the CLIP embed). Declared
	// outside try so finally can drain it. Early .catch avoids
	// unhandledRejection if it fails before the loop awaits it.
	let pendingExtract = null;
	const emitHeartbeat = () => {
		if (onProgress) {
			try {
				onProgress({
					phase: "embed",
					done: fromIndex + completedInChunk,
					total: plan.length,
					gi: currentGi,
					t: currentT,
					step: currentStep,
					heartbeat: true,
					heartbeatAt: Date.now(),
				});
			} catch {
				/* progress relay must never fail the chunk */
			}
		}
	};
	try {
		heartbeatTimer = setInterval(emitHeartbeat, ENRICH_HEARTBEAT_INTERVAL_MS);
		// An interval keeps the event loop alive; don't let a hung chunk
		// hold the worker open on this timer alone.
		if (heartbeatTimer && typeof heartbeatTimer.unref === "function") {
			heartbeatTimer.unref();
		}
		const segments = [];
		const vecs = [];
		let succeeded = 0;
		let skipped = 0;
		const beginExtract = (gi: number, t: number) => {
			const promise = videoUtils.extractFrameRaw(ffmpeg, filePath, t, 480);
			promise.catch(() => {
				/* consumed later inside the per-segment try/catch */
			});
			return promise;
		};
		// Seed segment 0 before the loop so the first seek is already running
		// when we await it (and the rest of the chunk follows the same shape).
		pendingExtract = beginExtract(fromIndex, first.t);
		for (const [j, seg] of slice.entries()) {
			const gi = fromIndex + j; // global segment index (stable across chunks)
			currentGi = gi;
			currentT = seg.t;
			currentStep = "ffmpeg";
			try {
				// Consume this segment's extract (prefetched last iteration).
				// If the previous segment failed before seeding N+1, start now.
				let extracting = pendingExtract;
				pendingExtract = null;
				if (!extracting) {
					extracting = beginExtract(gi, seg.t);
				}
				const frame = await extracting;
				// Start N+1's seek NOW so it overlaps this segment's CLIP work.
				// (Failure of N+1 surfaces on the next iteration's await.)
				if (j + 1 < slice.length) {
					const next = slice[j + 1];
					if (next) pendingExtract = beginExtract(gi + 1, next.t);
				}
				if (posterDir && posterStem) {
					// Scene poster: the segment's midpoint frame, named so the
					// renderer can derive the URL from the segment index alone
					// (/images/posters/<stem>-scene-<gi>.jpg). Encoded from the
					// in-memory frame (plan 0.5). A poster failure must not fail
					// the segment — the embedding is the searchable payload, the
					// poster only cosmetic.
					try {
						await s
							.sharp(frame.data, {
								raw: {
									width: frame.width,
									height: frame.height,
									channels: frame.channels || 3,
								},
								limitInputPixels: false,
							})
							.jpeg({ quality: 82 })
							.toFile(path.join(posterDir, `${posterStem}-scene-${gi}.jpg`));
					} catch (posterErr) {
						const pe = posterErr as { message?: string } | null;
						console.warn(
							`[indexer] poster encode failed for ${opts.filename || filePath} seg ${gi} (${pe && pe.message})`,
						);
					}
				}
				currentStep = s.isGemma ? "gemma" : "clip";
				const raw = await core.decodeToRaw(
					frame,
					s.sharp,
					MODEL_CONFIG.inputSize,
				);
				const vec = await embedImageVec(raw, s);
				segments.push({ t: seg.t, dur: seg.dur, poster: gi, gi });
				vecs.push(Array.from(vec));
				succeeded++;
			} catch (segErr) {
				// Isolate the failure: record a skipped marker with a null
				// vec slot (parallel-array contract), keep the chunk moving.
				// The tray still ticks done+1 so a corrupt GOP reads as a
				// gap, never a 30-minute freeze at e.g. 16/1024.
				const se = segErr as { message?: string } | null;
				console.warn(
					`[indexer] skipping segment ${gi} at ${Number(seg.t).toFixed(1)}s ` +
						`for ${opts.filename || filePath}: ${se && se.message}`,
				);
				segments.push({
					t: seg.t,
					dur: seg.dur,
					poster: gi,
					gi,
					skipped: true,
					error: String((se && se.message) || segErr).slice(0, 300),
				});
				vecs.push(null);
				skipped++;
			} finally {
				completedInChunk++;
				if (onProgress) {
					try {
						onProgress({
							phase: "embed",
							done: fromIndex + completedInChunk,
							total: plan.length,
							gi,
							t: seg.t,
							step: currentStep,
							heartbeatAt: Date.now(),
						});
					} catch {
						/* progress relay must never fail the chunk */
					}
				}
			}
		}
		return {
			done: fromIndex + slice.length >= plan.length,
			segments,
			vecs,
			fromIndex: fromIndex + slice.length,
			total: plan.length,
			succeeded,
			skipped,
		};
	} finally {
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		// Drain any in-flight ahead-of-cursor extract before returning
		// (early return / throw while N+1's seek is still running).
		if (pendingExtract) {
			try {
				await pendingExtract;
			} catch {
				/* already failed or superseded */
			}
		}
	}
}

async function embedQuery(text: string): Promise<number[] | null> {
	const s = await ensureModel();
	if (!hasTextTower(s)) return null;
	const templates = buildQueryTemplates(text);
	/** @type {Float32Array[]} */
	const vecs = [];
	for (const t of templates) {
		if (s.isGemma) {
			vecs.push(await gemmaEmbedText(t, s, s.dim));
		} else {
			vecs.push(
				await core.embedText(t, textPair(s), s.dim, MODEL_CONFIG.textMaxLength),
			);
		}
	}
	const avg = averageEmbeddings(vecs.map((v) => new Float32Array(v)));
	if (!avg) return null;
	const centered = centerText(avg, s.textMean);
	if (!centered) return null;
	return Array.from(centered);
}

// Centered embeddings for raw transcript chunk texts (speech index). Same
// text tower + centering as queries so transcript rows live in the query
// space. Truncates to the model's static sequence length like the query
// path. Returns parallel array (null = skipped/empty input).
// Gemma family: transcript chunks are document-prefixed corpus items.
async function embedTexts(
	texts: Array<string | null | undefined> | null | undefined,
): Promise<Array<number[] | null>> {
	const s = await ensureModel();
	if (!hasTextTower(s)) return (texts || []).map(() => null);
	/** @type {Array<number[] | null>} */
	const out = [];
	for (const raw of texts || []) {
		try {
			const t = String(raw || "").trim();
			if (!t) {
				out.push(null);
				continue;
			}
			let vec;
			if (s.isGemma) {
				vec = await gemmaEmbedText(gemmaDocumentPrefix(t), s, s.dim);
			} else {
				vec = await core.embedText(
					t,
					textPair(s),
					s.dim,
					MODEL_CONFIG.textMaxLength,
				);
			}
			const centered = centerText(vec, s.textMean);
			out.push(centered ? Array.from(centered) : null);
		} catch {
			out.push(null);
		}
	}
	return out;
}

// Centered embedding of a filename's derived phrase. Used by the main
// process to heal corrupted phrase rows in an existing library (rows left
// all-zero by a text-model outage, or a misaligned bin).
// Gemma family: document-prefixed (title = filename stem).
async function embedPhrase(filename: string): Promise<number[] | null> {
	const s = await ensureModel();
	if (!hasTextTower(s)) return null;
	const vec = await embedPhraseVec(filename, s);
	// Cast: the runtime contract is a real vector (or throw) — a null here
	// threw at the length read before the conversion, unchanged.
	const centered = centerText(vec as ArrayLike<number>, s.textMean);
	if (!centered) return null;
	return Array.from(centered);
}

// The shared text direction this worker computed for ITS model — the main
// process needs it when flipping the library to this model after a migration.
async function currentTextMean(): Promise<number[] | null> {
	const s = await ensureModel();
	return s.textMean ? Array.from(s.textMean) : null;
}

// Inbound dispatch (protocol: shared/worker-messages.ts IndexerInbound).
async function handleMessage(
	message: import("../shared/worker-messages.ts").IndexerInbound,
): Promise<void> {
	const type = message.type;
	// init/shutdown carry no request id; every other message echoes one on
	// the failure reply below.
	const id = type === "init" || type === "shutdown" ? undefined : message.id;
	try {
		if (type === "init") {
			try {
				const s = await ensureModel();
				post({
					type: "init-done",
					id,
					ok: true,
					modelId: core.resolveModelId(process.env.INDEXER_MODEL || ""),
					dim: s.dim,
					textMean: s.textMean ? Array.from(s.textMean) : null,
				});
				post({ type: "model", phase: "ready", progress: null });
			} catch (err) {
				post({ type: "model", phase: "error", progress: null });
				throw err;
			}
			return;
		}
		if (type === "embed-photo") {
			const { path: filePath, filename } = message;
			const { vec, phrase } = await embedPhoto(filePath, filename);
			post({ type: "photo-done", id, ok: true, vec, phrase });
			return;
		}
		if (type === "embed-video") {
			const { path: filePath, filename } = message;
			const { vec, phrase } = await embedVideo(filePath, filename);
			post({ type: "video-done", id, ok: true, vec, phrase });
			return;
		}
		if (type === "enrich-video") {
			const {
				path: filePath,
				fromIndex = 0,
				filename,
				postersDir,
				budget,
			} = message;
			const out = await enrichVideo(filePath, fromIndex, {
				filename,
				postersDir,
				budget: budget || null,
				// Live background-progress relay. Deliberately NO request `id`:
				// the main process resolves pending requests on any message
				// carrying that id, so a progress tick must never collide with
				// the enrich-done reply.
				onProgress: (p) => post({ type: "enrich-progress", filename, ...p }),
			});
			post({ type: "enrich-done", id, ok: true, ...out });
			return;
		}
		if (type === "embed-query") {
			const vec = await embedQuery(message.text);
			post({ type: "query-done", id, ok: Boolean(vec), vec });
			return;
		}
		if (type === "embed-phrase") {
			const vec = await embedPhrase(message.filename);
			post({ type: "phrase-done", id, ok: Boolean(vec), vec });
			return;
		}
		if (type === "embed-texts") {
			const vecs = await embedTexts(message.texts);
			post({ type: "texts-done", id, ok: true, vecs });
			return;
		}
		if (type === "get-text-mean") {
			const textMean = await currentTextMean();
			post({ type: "text-mean-done", id, ok: true, textMean });
			return;
		}
		if (type === "kill-ffmpeg") {
			let killed = 0;
			try {
				killed = videoUtils.killAllFfmpeg("ipc kill-ffmpeg");
			} catch {
				/* best-effort */
			}
			post({ type: "ffmpeg-killed", id, ok: true, killed });
			return;
		}
		if (type === "shutdown") {
			try {
				videoUtils.killAllFfmpeg("shutdown");
			} catch {
				/* best-effort */
			}
			process.exit(0);
		}
		// Exhaustiveness (Tier 4): a new IndexerInbound variant must be
		// handled above, never silently dropped.
		assertNever(type);
	} catch (err) {
		const e = err as { message?: string } | null;
		post({ type, ok: false, id, error: (e && e.message) || String(err) });
	}
}

if (process.parentPort) {
	// Requests can arrive faster than one inference completes (the main
	// process pipelines a whole batch across the worker pool), but a
	// transformers.js pipeline is not reentrant — concurrent session.run
	// calls can corrupt tensors or crash. Every message is serialized
	// through one executor. Two FIFO lanes with priority: query/import
	// embeds (high) always run ahead of background scene enrichment (low).
	// A query that arrives mid-enrichment waits only for the current
	// ≤16-segment chunk, then jumps the remaining chunks.
	const highPending: import("../shared/worker-messages.ts").IndexerInbound[] =
		[];
	const lowPending: import("../shared/worker-messages.ts").IndexerInbound[] =
		[];
	let queueBusy = false;
	const pump = () => {
		if (queueBusy) return;
		const message = highPending.shift() || lowPending.shift();
		if (!message) return;
		queueBusy = true;
		Promise.resolve()
			.then(() => handleMessage(message))
			.catch((err) =>
				console.error(`[indexer] message handler error: ${err.message}`),
			)
			.finally(() => {
				queueBusy = false;
				pump();
			});
	};
	process.parentPort.on("message", (event) => {
		/** @type {import("../shared/worker-messages.ts").IndexerInbound} */
		const message = event.data;
		// Lifecycle controls bypass the embed queue: a hung enrich-video
		// holds queueBusy for minutes, and a kill-ffmpeg queued behind it
		// would never run in time to kill the hung ffmpeg.
		if (
			message &&
			(message.type === "kill-ffmpeg" || message.type === "shutdown")
		) {
			void handleMessage(message);
			return;
		}
		(message.type === "enrich-video" ? lowPending : highPending).push(message);
		pump();
	});
}

// Standalone self-test: `node indexer/indexer.js --smoke`
async function runSmoke() {
	const sharp = (await import("sharp")).default;
	const tmp = fs.mkdtempSync(os.tmpdir() + "/memories-smoke-");
	const jpg = path.join(tmp, "test-photo.jpg");
	await sharp({
		create: {
			width: 96,
			height: 96,
			channels: 3,
			background: { r: 70, g: 140, b: 210 },
		},
	})
		.jpeg()
		.toFile(jpg);

	console.log(
		`[smoke] loading model ${MODEL_CONFIG.label} (first run downloads weights)…`,
	);
	const s = await ensureModel();
	const dim = s.dim;

	const photo = await embedPhoto(jpg, "test-photo.jpg");
	if (!photo.vec || photo.vec.length !== dim) {
		throw new Error(
			"photo embed produced wrong dim: " + (photo.vec && photo.vec.length),
		);
	}
	console.log(
		`[smoke] photo embed OK (${photo.vec.length} dim, phrase ${photo.phrase ? "yes" : "no"})`,
	);

	const ffmpeg = (() => {
		try {
			return videoUtils.resolveFfmpeg();
		} catch {
			return null;
		}
	})();
	if (ffmpeg) {
		const video = path.join(tmp, "test-video.mp4");
		const gen = spawnSync(
			ffmpeg,
			[
				"-y",
				"-f",
				"lavfi",
				"-i",
				"color=c=blue:s=320x240:d=2",
				"-pix_fmt",
				"yuv420p",
				video,
			],
			{ encoding: "utf8" },
		);
		if (gen.status === 0 && fs.existsSync(video)) {
			const vid = await embedVideo(video, "test-video.mp4");
			if (!vid.vec || vid.vec.length !== dim) {
				throw new Error("video embed produced wrong dim");
			}
			console.log(
				`[smoke] video embed OK (${vid.vec.length} dim, phrase ${vid.phrase ? "yes" : "no"})`,
			);
		} else {
			console.warn("[smoke] video generation failed; skipping video check");
		}
	} else {
		console.warn("[smoke] no ffmpeg; skipping video check");
	}

	const qBlue = await embedQuery("a blue square");
	const qRed = await embedQuery("a red square");
	if (!qBlue || !qRed) throw new Error("query embed failed");
	// Self-dot (element `v` IS qBlue[i] — no index read needed).
	const dot = qBlue.reduce((acc, v) => acc + v * v, 0);
	console.log(`[smoke] query embed OK (${qBlue.length} dim)`);
	console.log(`[smoke] self-cosine ${dot.toFixed(4)} (expect ~1.0)`);
	console.log(`[smoke] textMean present: ${Boolean(s.textMean)}`);
	console.log(`[smoke] model: ${MODEL_CONFIG.label} (${MODEL_CONFIG.repo})`);
	console.log("[smoke] OK");
	// The smoke's success criterion is reaching this line — pin exit 0 so
	// the native-session teardown cannot flip it (see the drain note below).
	process.exitCode = 0;
	// Exit naturally, NOT process.exit(0): with transformers.js v3's
	// onnxruntime-node loaded, a hard exit can race the native session
	// teardown and SIGABRT ("mutex lock failed") even though the run
	// succeeded — a clean drain exits 0 without the noise.
}

if (require.main === module && process.argv.includes("--smoke")) {
	runSmoke().catch((err) => {
		console.error("[smoke] FAILED:", err);
		process.exit(1);
	});
}

module.exports = {
	embedPhoto,
	embedVideo,
	enrichVideo,
	embedQuery,
	embedPhrase,
	currentTextMean,
	ensureModel,
};
