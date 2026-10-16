import { expect, test } from "bun:test";
import {
	DEFAULT_WHISPER_MODEL,
	WHISPER_MODEL_IDS,
	WHISPER_MODEL_LABELS,
	parseWhisperModel,
} from "../src/lib/whisperModel";
import { detectWhisperLanguage } from "../indexer/transcribe-worker.ts";

// The renderer-side parse must accept exactly the engine ids the
// main process stores (indexer/transcript-store-utils.js WHISPER_MODELS):
// the English-only rungs (tiny.en/base.en) plus their multilingual twins
// (tiny/base). small.en was removed (OOM on 8GB) — it aliases to base.en.
test("parseWhisperModel accepts the 4 engine ids", () => {
	expect(parseWhisperModel("tiny.en")).toBe("tiny.en");
	expect(parseWhisperModel("base.en")).toBe("base.en");
	expect(parseWhisperModel("tiny")).toBe("tiny");
	expect(parseWhisperModel("base")).toBe("base");
});

test("parseWhisperModel aliases legacy small.en to base.en", () => {
	expect(parseWhisperModel("small.en")).toBe("base.en");
});

test("parseWhisperModel falls back to tiny.en on garbage", () => {
	expect(parseWhisperModel(null)).toBe("tiny.en");
	expect(parseWhisperModel(undefined)).toBe("tiny.en");
	expect(parseWhisperModel("")).toBe("tiny.en");
	expect(parseWhisperModel("small")).toBe("tiny.en");
	expect(parseWhisperModel("Tiny")).toBe("tiny.en");
	expect(parseWhisperModel("TINY.EN")).toBe("tiny.en");
	expect(parseWhisperModel("large-v3")).toBe("tiny.en");
	expect(parseWhisperModel(2)).toBe("tiny.en");
});

test("preset ids, labels and default stay in sync with the main-process table", () => {
	expect([...WHISPER_MODEL_IDS].sort()).toEqual([
		"base",
		"base.en",
		"tiny",
		"tiny.en",
	]);
	expect(DEFAULT_WHISPER_MODEL).toBe("tiny.en");
	for (const id of WHISPER_MODEL_IDS) {
		expect(WHISPER_MODEL_LABELS[id].length).toBeGreaterThan(0);
	}
});

// The language probe is the fragile seam with @huggingface/transformers:
// it must seed <|startoftranscript|> as decoder_input_ids (which replaces
// the init tokens, so the library's forced-English default never runs),
// cap the decode at ONE token, and map the sampled token through the
// model's own lang_to_id. These fakes pin that contract without weights.

type ProbeAsr = Parameters<typeof detectWhisperLanguage>[0];
const fakeAsr = (model: Record<string, unknown>) =>
	({
		processor: async () => ({ input_features: { fake: true } }),
		model,
	}) as unknown as ProbeAsr;

test("language probe seeds <|startoftranscript|>, one token, maps lang_to_id", async () => {
	const calls: Array<Record<string, unknown>> = [];
	const asr = fakeAsr({
		generation_config: {
			is_multilingual: true,
			decoder_start_token_id: 50258,
			lang_to_id: { "<|ko|>": 50264, "<|en|>": 50259 },
		},
		generate: async (opts: Record<string, unknown>) => {
			calls.push(opts);
			return { tolist: () => [[50258, 50264]] };
		},
	});
	expect(await detectWhisperLanguage(asr, new Float32Array(16))).toBe("ko");
	expect(calls.length).toBe(1);
	expect(calls[0]!.decoder_input_ids).toEqual([50258]);
	expect(calls[0]!.max_new_tokens).toBe(1);
});

test("language probe returns null for English-only and malformed configs", async () => {
	const samples = new Float32Array(16);
	const multi = {
		is_multilingual: true,
		decoder_start_token_id: 50258,
		lang_to_id: { "<|ko|>": 50264 },
	};
	// English-only: no generation_config at all / not multilingual / no map.
	expect(
		await detectWhisperLanguage(
			fakeAsr({ generation_config: null, generate: async () => [[1]] }),
			samples,
		),
	).toBeNull();
	expect(
		await detectWhisperLanguage(
			fakeAsr({
				generation_config: { ...multi, is_multilingual: false },
				generate: async () => [[50258, 50264]],
			}),
			samples,
		),
	).toBeNull();
	expect(
		await detectWhisperLanguage(
			fakeAsr({
				generation_config: {
					is_multilingual: true,
					lang_to_id: multi.lang_to_id,
				},
				generate: async () => [[50258, 50264]],
			}),
			samples,
		),
	).toBeNull();
	// Sampled token that is not a language token → null (caller omits kwarg).
	expect(
		await detectWhisperLanguage(
			fakeAsr({
				generation_config: multi,
				generate: async () => [[50258, 4711]],
			}),
			samples,
		),
	).toBeNull();
	// Empty / jumbled output shapes → null, never a throw.
	for (const out of [[], [[]], { tolist: () => [] }, { tolist: () => [[]] }]) {
		expect(
			await detectWhisperLanguage(
				fakeAsr({ generation_config: multi, generate: async () => out }),
				samples,
			),
		).toBeNull();
	}
});

test("language probe parses nested arrays, Tensor-like output and BigInt rows", async () => {
	const samples = new Float32Array(16);
	const langMap = { "<|en|>": 50259, "<|ja|>": 50266 };
	const gen = (out: unknown) =>
		fakeAsr({
			generation_config: {
				is_multilingual: true,
				decoder_start_token_id: 50258,
				lang_to_id: langMap,
			},
			generate: async () => out,
		});
	expect(await detectWhisperLanguage(gen([[50258, 50259]]), samples)).toBe(
		"en",
	);
	expect(
		await detectWhisperLanguage(
			gen({ tolist: () => [[50258, 50266]] }),
			samples,
		),
	).toBe("ja");
	// int64 tensors can surface BigInt rows.
	expect(await detectWhisperLanguage(gen([[50258n, 50266n]]), samples)).toBe(
		"ja",
	);
});
