// Curated model registry for photo discovery and long-form video search. The
// active model is chosen per-library (index.modelId), passed to workers via
// INDEXER_MODEL, and its bins are stored per model
// (memory-embeddings-<id>.bin).
//
// Each entry carries the facts the rest of the code needs:
//   repo       — transformers.js repo id (the pipeline + tokenizer/CLIPText
//                classes load from here)
//   dim        — expected embedding dim; >0 validates the ONNX output, and
//                the worker's dim probe still adopts the ACTUAL output dim
//                (the config is a check, the graph is the truth)
//   inputSize  — decode pre-resize target (the processor center-crops to its
//                own size afterwards; decoding at ~the processor's size keeps
//                the upscale loss negligible)
//   textMaxLength — fixed token length the text encoder requires. Some
//                exports have STATIC sequence shapes baked into the ONNX
//                graph, so padding to exactly this length (and truncating
//                longer inputs) makes them run.
//   visionQuantized — whether the image pipeline should run int8.
//   minimumWeightBytes — optional minimum bytes per relative ONNX path. This
//                guards against interrupted downloads being reused as if they
//                were valid model weights.
//   thresholds — ranking thresholds (minSemanticScore / relativeKeep); null
//                means "calibrate on first use" (see calibrateThresholds in
//                main.ts). Per-model calibrations persist in memory-models.json
//                and override these seeds.
//   textClass  — which transformers.js class loads the text tower:
//                "clip" (CLIPTextModelWithProjection, the default) or
//                "siglip" (SiglipTextModel). Different exporters ship
//                different ONNX layouts, so the class must match the repo.
//   textOutputKey — the output key the text model emits its embedding under
//                ("text_embeds" for CLIP, "pooler_output" for SigLIP).
//   visionPool — whether the image pipeline must run with { pool: true }.
//                CLIP exports project to image_embeds by default; SigLIP's
//                vision model only exposes pooler_output (the default
//                last_hidden_state would be raw patch tokens, not a vector).
//   family     — encoder family: undefined (CLIP/SigLIP split dual-tower) or
//                "embeddinggemma" (unified AutoModel + AutoProcessor emitting
//                sentence_embedding; see onnx-community/embeddinggemma-2-ONNX).
//                The gemma family ignores textClass/textOutputKey/visionPool/
//                textMaxLength and instead uses dtype + visionTokenBudget +
//                task prefixes (task: search result | query: / title: | text:).
//   dtype      — ONNX precision for the gemma family ("q8" default; "fp32" or
//                "q4" opt-in). NEVER "fp16"/"q4f16": activations exceed fp16
//                range and degrade silently to NaN/garbage (model card).
//   visionTokenBudget — gemma image_processor max_soft_tokens (70/140/280/
//                560/1120; default 280). Higher = more detail, more latency.
//   skipAudio  — gemma only: strip audio_config before load (photo+scenes
//                scope; saves ~340MB q8). Video frames still embed as images
//                via ffmpeg (transformers.js load_video is browser-only).
// Entries are listed in picker order: the scene-search default first, then
// the alternatives. The picker renders them in this order.

export interface ModelConfig {
	repo: string;
	label: string;
	description: string;
	dim: number;
	inputSize: number;
	visionQuantized?: boolean;
	license: string;
	speed: string;
	quality: string;
	thresholds: null;
	minimumWeightBytes?: Record<string, number>;
	textMaxLength?: number;
	textClass?: "clip" | "siglip";
	textOutputKey?: string;
	visionPool?: boolean;
	family?: "embeddinggemma";
	dtype?: string;
	visionTokenBudget?: number;
	skipAudio?: boolean;
	// Worker-side file-layout knobs (transformers.js from_pretrained).
	modelFileName?: string;
	subfolder?: string;
	textQuantized?: boolean;
	textModelFileName?: string;
}

export const MODELS: Record<string, ModelConfig> = {
	"clip-vit-l14-336": {
		repo: "Xenova/clip-vit-large-patch14-336",
		label: "CLIP ViT-L/14@336",
		description:
			"Default for new libraries. Chosen for the strongest real-world video scene-search results in SCM. ~480–570ms/img CPU, ~435MB download. Use SigLIP-2 for faster bulk import.",
		dim: 768,
		inputSize: 336,
		visionQuantized: true,
		license: "MIT",
		speed: "slowest",
		quality: "best scene search",
		thresholds: null,
		// Guard against truncated downloads being reused as cache hits
		// (same class as the SigLIP-2 44MB-partial poison). Measured
		// 2026-09-24: vision 307,331,740 B, text 124,987,662 B; floors sit
		// ~2-4% below with the same discard + atomic re-download semantics.
		minimumWeightBytes: {
			"onnx/vision_model_quantized.onnx": 300_000_000,
			"onnx/text_model_quantized.onnx": 120_000_000,
		},
	},
	"siglip2-large-patch16-256": {
		repo: "onnx-community/siglip2-large-patch16-256-ONNX",
		label: "SigLIP-2-L/16@256",
		description:
			"High-detail option. Measured 2026-09-26 gates: 13/16 fine-detail Top-1 (MRR 0.875) — level with the 384px model at roughly 2.3x less compute (~200ms/img CPU vs ~480ms). 1024-dim, ~850MB download. Reach for it on small objects, signs, and on-screen text in photos or long videos.",
		dim: 1024,
		inputSize: 256,
		visionQuantized: true,
		textMaxLength: 64,
		textClass: "siglip",
		textOutputKey: "pooler_output",
		visionPool: true,
		license: "Apache-2.0",
		speed: "slower",
		quality: "best detail per second",
		thresholds: null,
		// Measured 2026-09-26: vision 319,618,816 B, text 568,343,664 B;
		// floors sit ~5% below with the same discard + atomic re-download
		// semantics as the other models.
		minimumWeightBytes: {
			"onnx/vision_model_quantized.onnx": 300_000_000,
			"onnx/text_model_quantized.onnx": 540_000_000,
		},
	},
	"embeddinggemma2-text-vision": {
		repo: "onnx-community/embeddinggemma-2-ONNX",
		label: "EmbeddingGemma-2 (text+vision)",
		description:
			"Google unified 768-d multimodal (text+vision q8, ~509MB). Multilingual (100+ langs) + code specialist; opt-in alternative — CLIP stays default. Uses task prefixes; CPU slower than SigLIP; audio encoder skipped.",
		dim: 768,
		// Decode pre-resize target; the AutoProcessor's image_processor
		// (max_soft_tokens) does the final aspect-aware resize. 512 keeps
		// detail for the 280-token budget without blowing RAM.
		inputSize: 512,
		family: "embeddinggemma",
		dtype: "q8",
		visionTokenBudget: 280,
		skipAudio: true,
		license: "Apache-2.0",
		speed: "slower",
		quality: "multilingual + code",
		thresholds: null,
		// Measured 2026-10-11 via HEAD on resolve/main:
		//   onnx/model_quantized.onnx_data 313,724,928 B
		//   onnx/vision_encoder_quantized.onnx_data 195,228,672 B
		// Floors sit ~5% below; the stub .onnx files are <1MB (external
		// _data holds weights) so only _data is guarded. Same discard +
		// atomic re-download semantics as the other models.
		minimumWeightBytes: {
			"onnx/model_quantized.onnx_data": 298_000_000,
			"onnx/vision_encoder_quantized.onnx_data": 185_000_000,
		},
	},
};

// Retired IDs must remain recognizable even though they are deliberately
// absent from MODELS. The library loader uses this table to preserve the old
// on-disk index until main has fully re-embedded it into the replacement — a
// plain resolve-to-default would otherwise pair stale-dim rows (e.g. 512-d
// MobileCLIP) with a 768-d CLIP worker and silently make the library
// unsearchable. All retirements target the default: it is the validated
// scene-search pick, so a migrated library lands on supported ground.
export const RETIRED_MODEL_MIGRATIONS: Readonly<
	Record<string, Readonly<{ targetId: string }>>
> = Object.freeze({
	"mobileclip2-s2": Object.freeze({ targetId: "clip-vit-l14-336" }),
	"siglip2-base-patch16-224": Object.freeze({ targetId: "clip-vit-l14-336" }),
	"siglip-base-patch16-384": Object.freeze({ targetId: "clip-vit-l14-336" }),
});

// Default: CLIP ViT-L/14@336. SCM's hands-on video-scene-search validation
// found it returns the strongest scenes despite its slower import path. Fresh
// libraries use it; existing supported libraries retain their chosen model.
export const DEFAULT_MODEL_ID = "clip-vit-l14-336";

export function getModel(modelId: string | undefined): ModelConfig | null {
	return MODELS[modelId as string] || null;
}

export function getRetiredModelMigration(
	modelId: string | undefined,
): Readonly<{ targetId: string }> | null {
	return RETIRED_MODEL_MIGRATIONS[modelId as string] || null;
}

// Unknown ids resolve to the default — the app must keep working even if a
// library references a model that no longer ships.
export function resolveModelId(modelId: string | undefined) {
	return MODELS[modelId as string] ? (modelId as string) : DEFAULT_MODEL_ID;
}

export function isEmbeddingGemma(modelId: string | undefined) {
	const config = getModel(resolveModelId(modelId));
	return Boolean(config && config.family === "embeddinggemma");
}

// Allowed ONNX precisions for the gemma family. fp16/q4f16 are REFUSED:
// activations exceed fp16 range and degrade silently (NaN or plausible but
// wrong vectors — the one failure validateEmbedding cannot catch).
export const GEMMA_ALLOWED_DTYPES: readonly string[] = Object.freeze([
	"fp32",
	"q8",
	"q4",
]);

export function resolveGemmaDtype(modelId: string | undefined) {
	const config = getModel(resolveModelId(modelId));
	const dtype = (config && config.dtype) || "q8";
	if (!GEMMA_ALLOWED_DTYPES.includes(dtype)) {
		// Cast: config can only be null when dtype fell back to the allowed
		// "q8" — the throw path is unreachable with a null config.
		throw new Error(
			`Refusing dtype "${dtype}" for ${(config as ModelConfig).repo}: fp16 variants ` +
				`silently corrupt EmbeddingGemma embeddings (model card). ` +
				`Use one of ${GEMMA_ALLOWED_DTYPES.join(", ")}.`,
		);
	}
	return dtype;
}

// Task prefixes (model card §1). Queries use the asymmetric search prefix;
// corpus items (filename phrases, transcript chunks) use the document form.
// Already-prefixed inputs are returned unchanged (never double-prefix).
export function gemmaQueryPrefix(text: unknown) {
	const t = String(text || "").trim();
	if (/^(task\s*:|title\s*:)/i.test(t)) return t;
	return `task: search result | query: ${t}`;
}

export function gemmaDocumentPrefix(text: unknown, title: unknown = "none") {
	const t = String(text || "").trim();
	if (/^(task\s*:|title\s*:)/i.test(t)) return t;
	const cleanTitle = String(title || "none").trim() || "none";
	return `title: ${cleanTitle} | text: ${t}`;
}
