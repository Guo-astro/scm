"use strict";

// Promotion gates for EmbeddingGemma-2 as SCM default (eval/embeddinggemma-2-default).
//
// Single-model run (avoids double-resident OOM — Gemma 440M + CLIP side by
// side kills 8GB Macs alongside Whisper/ffmpeg):
//   node scripts/bench-embeddinggemma-gates.js --model <registryId> [--out <json>]
//
// Compare two runs and print the promotion verdict:
//   node scripts/bench-embeddinggemma-gates.js --compare baseline.json candidate.json
//
// Gates (same bar CLIP/SigLIP cleared in indexer/models.ts):
//   1. fine-detail 16 — 16 solid hues, hue-named queries, Top-1 + MRR.
//      Bar: >= 9/16 Top-1 (SigLIP-2-B floor), stretch 13/16 (SigLIP-2-L).
//   2. multilingual — EN/ZH/JA/ES queries for one hue, Top-3 stability.
//      Bar: >= 3/4 in Top-3 (Gemma's claimed edge; CLIP is EN-centric).
//   3. phrase — filename-phrase retrieval ("beach sunset photo" -> file).
//      Bar: Top-1 (commit df46648 smoke: phrase-query 0.56 vs cat-car 0.05).
//   4. speed — vision batch-1 ms/img + query ms/text (CPU default EP).
//      Bar: recorded, no hard fail (default must not regress import >2x vs CLIP).
//   5. score sanity — matched vs unmatched cosine gap (threshold signal).
//
// Writes JSON per run under MDs/bench-embeddinggemma-<id>-<ts>.json by default.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadStack, median, cosine, argValue } = require("./bench-common.js");
const core = require("../indexer/build-memory-embeddings-core.js");
const {
	centerText,
	TEXT_MEAN_SAMPLE,
} = require("../indexer/memory-embedding-utils.ts");

const now = () => performance.now();

// 16 hues matching bench-common makeSolidJpegs (h=i/16*360, s=.55, l=.45).
const HUE_NAMES = [
	"red",
	"orange",
	"amber",
	"yellow",
	"lime",
	"green",
	"teal",
	"cyan",
	"sky blue",
	"blue",
	"indigo",
	"violet",
	"purple",
	"magenta",
	"pink",
	"rose",
];
const MULTILINGUAL = {
	// Same concept (blue water / ocean) in 4 languages.
	en: "blue ocean water",
	zh: "藍色海水",
	ja: "青い海",
	es: "agua azul del océano",
};

async function embedImage(stack, raw) {
	const { config } = stack;
	if (config.family === "embeddinggemma") {
		return core.gemmaEmbedImageBuild(
			stack.RawImage,
			raw,
			stack.gemmaBundle,
			stack.dim,
		);
	}
	return core.embedRawImage(
		stack.extractor,
		stack.RawImage,
		raw,
		stack.dim,
		config.visionPool,
	);
}

async function embedQueryText(stack, text, textMean) {
	const { config } = stack;
	let vec;
	if (config.family === "embeddinggemma") {
		const { gemmaQueryPrefix } = require("../indexer/models.ts");
		vec = await core.gemmaEmbedTextBuild(
			gemmaQueryPrefix(text),
			stack.gemmaBundle,
			stack.dim,
		);
	} else {
		// Mirror indexer.js buildQueryTemplates: 3-template average, then center.
		const q = text.trim();
		const templates =
			q.length >= 4 ? [q, `a photo of ${q}`, `a screenshot of ${q}`] : [q];
		const vecs = [];
		for (const t of templates) {
			vecs.push(
				await core.embedText(
					t,
					{
						tokenizer: stack.tokenizer,
						textModel: stack.textModel,
						outputKey: stack.outputKey,
					},
					stack.dim,
					config.textMaxLength,
				),
			);
		}
		const sum = new Float32Array(stack.dim);
		for (const v of vecs) for (let i = 0; i < sum.length; i++) sum[i] += v[i];
		let n = 0;
		for (let i = 0; i < sum.length; i++) n += sum[i] * sum[i];
		n = Math.sqrt(n);
		for (let i = 0; i < sum.length; i++) sum[i] /= n;
		vec = sum;
	}
	const centered = centerText(vec, textMean);
	return centered || vec;
}

async function resolveMean(stack, log) {
	// Prefer shipped/cached constant (what the worker adopts); compute for
	// Gemma when missing (gen:text-mean ships it — see promotion step 2).
	if (stack.config.family === "embeddinggemma") {
		const hit = core.loadTextMeanConstant(
			core.resolveModelId(process.env.INDEXER_MODEL),
			stack.dim,
		);
		if (hit) {
			log.log("[gates] textMean: shipped/cached constant hit");
			return { mean: hit, source: "constant" };
		}
		log.log("[gates] textMean: no constant (run gen:text-mean) — computing");
		const { gemmaQueryPrefix } = require("../indexer/models.ts");
		const vecs = [];
		for (const t of TEXT_MEAN_SAMPLE) {
			vecs.push(
				await core.gemmaEmbedTextBuild(
					gemmaQueryPrefix(t),
					stack.gemmaBundle,
					stack.dim,
				),
			);
		}
		const mean = new Float32Array(stack.dim);
		for (const v of vecs) for (let i = 0; i < mean.length; i++) mean[i] += v[i];
		for (let i = 0; i < mean.length; i++) mean[i] /= vecs.length;
		let n = 0;
		for (let i = 0; i < mean.length; i++) n += mean[i] * mean[i];
		n = Math.sqrt(n);
		for (let i = 0; i < mean.length; i++) mean[i] /= n;
		return { mean, source: "computed-fallback" };
	}
	const mean = await core.resolveTextMean({
		registryId: core.resolveModelId(process.env.INDEXER_MODEL),
		dim: stack.dim,
		textPair: {
			tokenizer: stack.tokenizer,
			textModel: stack.textModel,
			outputKey: stack.outputKey,
		},
		textMaxLength: stack.config.textMaxLength,
		log,
	});
	return { mean, source: mean ? "resolved" : "none" };
}

function rank(queryVec, imgVecs) {
	return imgVecs
		.map((v, i) => ({ i, s: cosine(queryVec, v) }))
		.sort((a, b) => b.s - a.s);
}

async function main() {
	const argv = process.argv.slice(2);
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log(
			"usage: node scripts/bench-embeddinggemma-gates.js --model <id> [--out <json>]\n" +
				"       node scripts/bench-embeddinggemma-gates.js --compare <baseline.json> <candidate.json>",
		);
		return;
	}
	const cmpIdx = argv.indexOf("--compare");
	if (cmpIdx !== -1) return compare(argv[cmpIdx + 1], argv[cmpIdx + 2]);
	const modelId =
		argValue("--model", null) ||
		process.env.INDEXER_MODEL ||
		core.DEFAULT_MODEL_ID;
	process.env.INDEXER_MODEL = modelId;
	const outDefault = path.join(
		__dirname,
		"..",
		"MDs",
		`bench-gemma-${modelId.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}.json`,
	);
	const outPath = argValue("--out", outDefault);

	const loadT0 = now();
	const stack = await loadStack({ modelId });
	const loadMs = now() - loadT0;
	const { mean: textMean, source: meanSource } = await resolveMean(
		stack,
		console,
	);

	// Fixed image set: same generator as bench-inference (16 hues).
	const { makeSolidJpegs } = require("./bench-common.js");
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scm-gates-"));
	const jpgs = await makeSolidJpegs(stack.sharp, tmp, 16);
	const raws = [];
	for (const f of jpgs)
		raws.push(await core.decodeToRaw(f, stack.sharp, stack.config.inputSize));

	// Embed images (timed = import-cost signal).
	const imgVecs = [];
	const imgMs = [];
	for (const raw of raws) {
		const t0 = now();
		imgVecs.push(await embedImage(stack, raw));
		imgMs.push(now() - t0);
	}
	// Drop warmup (first embed includes session setup).
	const imgMsTimed = imgMs.slice(1);

	const results = {
		meta: {
			date: new Date().toISOString(),
			node: process.version,
			modelId,
			label: stack.config.label,
			repo: stack.config.repo,
			dim: stack.dim,
			dtype:
				stack.config.family === "embeddinggemma"
					? require("../indexer/models.ts").resolveGemmaDtype(modelId)
					: stack.config.visionQuantized
						? "q8"
						: "fp32",
			eps: stack.eps,
			loadMs: Math.round(loadMs),
			textMeanSource: meanSource,
			inputSize: stack.config.inputSize,
		},
		gates: {},
		speed: {
			visionMedianMs: median(imgMsTimed),
			visionSamplesMs: imgMsTimed.map((x) => Math.round(x * 10) / 10),
		},
	};

	// Gate 1: fine-detail 16.
	let top1 = 0;
	let rrSum = 0;
	const qMs = [];
	for (let i = 0; i < 16; i++) {
		const t0 = now();
		const qv = await embedQueryText(stack, HUE_NAMES[i], textMean);
		qMs.push(now() - t0);
		const ranked = rank(qv, imgVecs);
		const pos = ranked.findIndex((r) => r.i === i);
		if (pos === 0) top1++;
		rrSum += 1 / (pos + 1);
	}
	results.gates.fineDetail16 = {
		top1,
		mrr: Math.round((rrSum / 16) * 1000) / 1000,
		barTop1: 9,
		stretchTop1: 13,
		pass: top1 >= 9,
	};
	results.speed.queryMedianMs = median(qMs);

	// Gate 2: multilingual stability (blue hues live at indices 8-9).
	let multiHits = 0;
	const multiDetail = {};
	for (const [lang, q] of Object.entries(MULTILINGUAL)) {
		const qv = await embedQueryText(stack, q, textMean);
		const ranked = rank(qv, imgVecs).slice(0, 3);
		const hit = ranked.some((r) => r.i === 8 || r.i === 9);
		multiDetail[lang] = { hit, top3: ranked.map((r) => HUE_NAMES[r.i]) };
		if (hit) multiHits++;
	}
	results.gates.multilingual = {
		hits: multiHits,
		of: 4,
		bar: 3,
		pass: multiHits >= 3,
		detail: multiDetail,
	};

	// Gate 3: phrase retrieval (filename semantics).
	const phraseFile = "blue-ocean-sunset.jpg";
	let phraseVec;
	if (stack.config.family === "embeddinggemma") {
		const { gemmaDocumentPrefix } = require("../indexer/models.ts");
		const stem = phraseFile.replace(/\.[^.]+$/, "");
		phraseVec = await core.gemmaEmbedTextBuild(
			gemmaDocumentPrefix("blue ocean sunset", stem),
			stack.gemmaBundle,
			stack.dim,
		);
	} else {
		const {
			buildFilenamePhrase,
		} = require("../indexer/memory-embedding-utils.ts");
		phraseVec = await core.embedText(
			buildFilenamePhrase(phraseFile),
			{
				tokenizer: stack.tokenizer,
				textModel: stack.textModel,
				outputKey: stack.outputKey,
			},
			stack.dim,
			stack.config.textMaxLength,
		);
	}
	const pqv = await embedQueryText(stack, "blue ocean at sunset", textMean);
	const unrelated = await embedQueryText(stack, "a red car engine", textMean);
	results.gates.phrase = {
		phraseQueryCosine: Math.round(cosine(phraseVec, pqv) * 1000) / 1000,
		unrelatedCosine: Math.round(cosine(phraseVec, unrelated) * 1000) / 1000,
		pass: cosine(phraseVec, pqv) > cosine(phraseVec, unrelated) + 0.05,
	};

	// Gate 5: score sanity (matched band vs noise floor).
	const matched = [];
	const unmatched = [];
	for (let i = 0; i < 16; i++) {
		const qv = await embedQueryText(stack, HUE_NAMES[i], textMean);
		const ranked = rank(qv, imgVecs);
		matched.push(ranked[0].s);
		unmatched.push(ranked[ranked.length - 1].s);
	}
	results.gates.scoreSanity = {
		matchedMedian: Math.round(median(matched) * 1000) / 1000,
		noiseMedian: Math.round(median(unmatched) * 1000) / 1000,
		suggestedFloor: 0.04,
	};

	fs.mkdirSync(path.dirname(outPath), { recursive: true });
	fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
	console.log(
		`[gates] ${modelId}: fine-detail ${top1}/16 (MRR ${results.gates.fineDetail16.mrr}) ` +
			`| multi ${multiHits}/4 | phrase ${results.gates.phrase.phraseQueryCosine} vs ${results.gates.phrase.unrelatedCosine} ` +
			`| ${results.speed.visionMedianMs.toFixed(1)}ms/img, ${results.speed.queryMedianMs.toFixed(1)}ms/q, load ${(loadMs / 1000).toFixed(1)}s`,
	);
	console.log(`[gates] results → ${outPath}`);
	fs.rmSync(tmp, { recursive: true, force: true });
}

function compare(baselinePath, candidatePath) {
	if (!baselinePath || !candidatePath) {
		console.error("usage: --compare <baseline.json> <candidate.json>");
		process.exit(1);
	}
	const b = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
	const c = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
	const rows = [
		[
			"fine-detail Top-1",
			b.gates.fineDetail16.top1,
			c.gates.fineDetail16.top1,
			"higher wins, bar 9/16",
		],
		[
			"fine-detail MRR",
			b.gates.fineDetail16.mrr,
			c.gates.fineDetail16.mrr,
			"higher wins",
		],
		[
			"multilingual",
			`${b.gates.multilingual.hits}/4`,
			`${c.gates.multilingual.hits}/4`,
			"bar 3/4",
		],
		[
			"phrase cos",
			b.gates.phrase.phraseQueryCosine,
			c.gates.phrase.phraseQueryCosine,
			"higher wins",
		],
		[
			"vision ms/img",
			b.speed.visionMedianMs.toFixed(1),
			c.speed.visionMedianMs.toFixed(1),
			"lower wins",
		],
		[
			"query ms",
			b.speed.queryMedianMs.toFixed(1),
			c.speed.queryMedianMs.toFixed(1),
			"lower wins",
		],
		[
			"load s",
			(b.meta.loadMs / 1000).toFixed(1),
			(c.meta.loadMs / 1000).toFixed(1),
			"lower wins",
		],
	];
	for (const [k, bv, cv, note] of rows)
		console.log(`  ${k}: ${bv} -> ${cv} (${note})`);
	const promote =
		c.gates.fineDetail16.pass &&
		c.gates.multilingual.pass &&
		c.gates.phrase.pass &&
		c.speed.visionMedianMs < b.speed.visionMedianMs * 2;
	console.log(
		promote
			? "[gates] VERDICT: promote (all bars met)"
			: "[gates] VERDICT: hold (see failing bar)",
	);
	process.exit(promote ? 0 : 2);
}

main().catch((err) => {
	console.error(`[gates] FATAL: ${err.stack || err}`);
	process.exit(1);
});
