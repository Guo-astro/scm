"use strict";

// ---------------------------------------------------------------------------
// Whisper model ladder — tiny.en / base.en picker + per-model
// timeouts + worker model passthrough + sidecar stamp + switch invalidation.
// (small.en removed: OOM-crash on 8GB Macs — legacy values alias to base.en.)
//
//   Run:  bun test/whisper-model.test.js
//         bun run test:whisper-model
//
// Sections:
//   1. WHISPER_MODELS table + parseWhisperModel matrix (utils, pure)
//   2. transcribeTimeoutsFor scaling (tiny = base constants, base = 2x)
//   3. Worker: fixture returns model + utterances; invalid modelId → tiny;
//      capUtteranceText guard; real-path no-engine shape carries model
//   4. main.js wiring (source assertions): readWhisperModel, IPC pair,
//      pump passes modelId + per-model timeout, sidecar stamp, switch
//      invalidates + re-queues, mid-flight race drop
//   5. Renderer wiring (source assertions): lib/hook/preload/types/Settings
//
// Deterministic, no binaries, no network. Any failure exits 1.
// ---------------------------------------------------------------------------

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const {
	WHISPER_MODELS,
	DEFAULT_WHISPER_MODEL,
	parseWhisperModel,
	transcribeTimeoutsFor,
	transcriptsPerChunkFor,
	addSkippedSlice,
	TRANSCRIBE_CHUNK_TIMEOUT_MS,
	TRANSCRIBE_STALL_TIMEOUT_MS,
	TRANSCRIBE_HEARTBEAT_INTERVAL_MS,
	TRANSCRIBE_SLICE_DECODE_TIMEOUT_MS,
	TRANSCRIPTS_PER_CHUNK_TINY,
	TRANSCRIPTS_PER_CHUNK_BASE,
} = require("../indexer/transcript-store-utils.ts");

let passed = 0;
let failed = 0;

function check(name, fn) {
	try {
		fn();
		passed++;
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failed++;
		console.error(`  ✗ ${name}: ${err.message}`);
	}
}

// ---------------------------------------------------------------------------
console.log("[whisper-model] 1. table + parse");
// ---------------------------------------------------------------------------
{
	check("four-rung ladder (.en + multilingual twins), tiny.en default", () => {
		assert.deepEqual(Object.keys(WHISPER_MODELS).sort(), [
			"base",
			"base.en",
			"tiny",
			"tiny.en",
		]);
		assert.equal(WHISPER_MODELS["tiny.en"].hfId, "Xenova/whisper-tiny.en");
		assert.equal(WHISPER_MODELS["base.en"].hfId, "Xenova/whisper-base.en");
		assert.equal(WHISPER_MODELS["tiny"].hfId, "Xenova/whisper-tiny");
		assert.equal(WHISPER_MODELS["base"].hfId, "Xenova/whisper-base");
		assert.equal(DEFAULT_WHISPER_MODEL, "tiny.en");
		for (const m of Object.values(WHISPER_MODELS)) {
			assert.ok(m.paramsM > 0 && m.downloadMB > 0 && m.speedVsTiny >= 1);
		}
		// Strictly increasing cost per rung; multilingual twins share the
		// rung's cost (same params/speed, language coverage differs).
		assert.ok(
			WHISPER_MODELS["tiny.en"].paramsM < WHISPER_MODELS["base.en"].paramsM,
		);
		assert.equal(
			WHISPER_MODELS["tiny"].paramsM,
			WHISPER_MODELS["tiny.en"].paramsM,
		);
		assert.equal(
			WHISPER_MODELS["base"].paramsM,
			WHISPER_MODELS["base.en"].paramsM,
		);
		assert.equal(WHISPER_MODELS["tiny"].speedVsTiny, 1);
		assert.equal(WHISPER_MODELS["base"].speedVsTiny, 2);
	});

	check("parseWhisperModel matrix (small.en legacy alias → base.en)", () => {
		assert.equal(parseWhisperModel("tiny.en"), "tiny.en");
		assert.equal(parseWhisperModel("base.en"), "base.en");
		assert.equal(parseWhisperModel("tiny"), "tiny");
		assert.equal(parseWhisperModel("base"), "base");
		assert.equal(parseWhisperModel("small.en"), "base.en");
		for (const bad of [
			null,
			undefined,
			"",
			"small",
			"Tiny",
			"Tiny.en",
			"TINY.EN",
			"large-v3",
			42,
			{},
		]) {
			assert.equal(
				parseWhisperModel(bad),
				"tiny.en",
				`garbage must fall back: ${JSON.stringify(bad)}`,
			);
		}
	});
}

// ---------------------------------------------------------------------------
console.log("[whisper-model] 2. per-model timeouts");
// ---------------------------------------------------------------------------
{
	check(
		"tiny = base constants; base scales chunk+stall+slice, heartbeat fixed",
		() => {
			const tiny = transcribeTimeoutsFor("tiny.en");
			assert.equal(tiny.chunkTimeoutMs, TRANSCRIBE_CHUNK_TIMEOUT_MS);
			assert.equal(tiny.stallTimeoutMs, TRANSCRIBE_STALL_TIMEOUT_MS);
			assert.equal(tiny.heartbeatIntervalMs, TRANSCRIBE_HEARTBEAT_INTERVAL_MS);
			assert.equal(
				tiny.sliceDecodeTimeoutMs,
				TRANSCRIBE_SLICE_DECODE_TIMEOUT_MS,
			);
			assert.equal(tiny.slicesPerChunk, TRANSCRIPTS_PER_CHUNK_TINY);
			const base = transcribeTimeoutsFor("base.en");
			assert.equal(base.chunkTimeoutMs, TRANSCRIBE_CHUNK_TIMEOUT_MS * 2);
			assert.equal(base.stallTimeoutMs, TRANSCRIBE_STALL_TIMEOUT_MS * 2);
			assert.equal(
				base.sliceDecodeTimeoutMs,
				TRANSCRIBE_SLICE_DECODE_TIMEOUT_MS * 2,
			);
			assert.equal(base.heartbeatIntervalMs, TRANSCRIBE_HEARTBEAT_INTERVAL_MS);
			assert.equal(base.slicesPerChunk, TRANSCRIPTS_PER_CHUNK_BASE);
			// Multilingual twins share their rung's math exactly.
			assert.deepEqual(transcribeTimeoutsFor("tiny"), tiny);
			assert.deepEqual(transcribeTimeoutsFor("base"), base);
			assert.equal(
				transcribeTimeoutsFor("garbage").chunkTimeoutMs,
				TRANSCRIBE_CHUNK_TIMEOUT_MS,
			);
			assert.equal(
				transcribeTimeoutsFor("small.en").chunkTimeoutMs,
				TRANSCRIBE_CHUNK_TIMEOUT_MS * 2,
			);
		},
	);

	check("slices-per-chunk closes the chunk budget (stall fix)", () => {
		// 16 base.en slices never fit the 20 min ceiling at ~75-150 s/slice
		// (the chunk-0 class: alive, fresh heartbeat, still timing out).
		assert.equal(TRANSCRIPTS_PER_CHUNK_TINY, 16);
		assert.equal(TRANSCRIPTS_PER_CHUNK_BASE, 8);
		assert.equal(transcriptsPerChunkFor("tiny.en"), 16);
		assert.equal(transcriptsPerChunkFor("base.en"), 8);
		assert.equal(transcriptsPerChunkFor("tiny"), 16);
		assert.equal(transcriptsPerChunkFor("base"), 8);
		assert.equal(transcriptsPerChunkFor("garbage"), 16);
		for (const m of ["tiny.en", "base.en", "tiny", "base"]) {
			const t = transcribeTimeoutsFor(m);
			// Nominal pace is 37.5 s/slice × speedVsTiny (75 s base): the
			// window fits the ceiling with headroom, where 16 base.en
			// slices at that pace (20 min, zero headroom) timed out alive.
			const nominalPaceMs =
				(37.5 * 1000 * t.chunkTimeoutMs) / TRANSCRIBE_CHUNK_TIMEOUT_MS;
			assert.ok(
				t.slicesPerChunk * nominalPaceMs <= t.chunkTimeoutMs,
				`${m}: ${t.slicesPerChunk} slices must fit ${t.chunkTimeoutMs}ms`,
			);
			// Outlier guards sit strictly inside the chunk ceiling.
			assert.ok(t.sliceDecodeTimeoutMs < t.chunkTimeoutMs);
			assert.ok(t.stallTimeoutMs < t.chunkTimeoutMs);
		}
	});

	check("addSkippedSlice validates, dedupes, sorts, caps", () => {
		assert.deepEqual(addSkippedSlice([], 80), [80]);
		assert.deepEqual(addSkippedSlice([80], 80), [80]);
		assert.deepEqual(addSkippedSlice([95], 80), [80, 95]);
		assert.deepEqual(addSkippedSlice(null, 3), [3]);
		assert.deepEqual(addSkippedSlice([1], -2), [1]);
		assert.deepEqual(addSkippedSlice([1], 2.5), [1]);
		assert.deepEqual(addSkippedSlice([1], "80"), [1]);
		const full = addSkippedSlice(
			Array.from({ length: 32 }, (_, i) => i),
			99,
			32,
		);
		assert.equal(full.length, 32);
		assert.ok(!full.includes(99));
	});
}

// ---------------------------------------------------------------------------
console.log("[whisper-model] 3. worker model passthrough + utterances");
// ---------------------------------------------------------------------------
{
	const w = require("../indexer/transcribe-worker.js");

	check("worker exports utterance cap helpers", () => {
		assert.equal(typeof w.capUtteranceText, "function");
		assert.ok(
			w.UTTERANCE_MAX_CHARS >= 240,
			"utterance cap must exceed the 240-char window cap",
		);
		assert.ok(w.capUtteranceText("  a  b  ").length > 0);
		assert.equal(
			w.capUtteranceText("x".repeat(10000)).length,
			w.UTTERANCE_MAX_CHARS,
		);
	});

	check("worker language probe: exported + wired into the slice loop", () => {
		assert.equal(typeof w.detectWhisperLanguage, "function");
		const src = read("indexer/transcribe-worker.ts");
		assert.ok(
			src.includes("detectWhisperLanguage(asr, samples)"),
			"slice loop must probe the language",
		);
		assert.ok(
			src.includes('language, task: "transcribe"'),
			"decodes must carry the detected language + transcribe task",
		);
		assert.ok(
			src.includes("detectAttempts < 3"),
			"probe retries must be capped",
		);
		assert.ok(
			src.includes("cfg.is_multilingual !== true"),
			"English-only models must skip the probe (language kwarg throws)",
		);
	});

	check("fixture resolves multilingual ids (base → base)", async () => {
		const out = spawnSync(
			process.execPath,
			[
				"-e",
				"process.env.TRANSCRIBE_FIXTURE=process.argv[1];import('./indexer/transcribe-worker.js').then(m=>m.transcribeVideo('x.mp4',0,{modelId:'base'}).then(o=>console.log(JSON.stringify(o))))",
				JSON.stringify([{ t0: 0, t1: 8, text: "Hello world today." }]),
			],
			{ cwd: ROOT, env: { ...process.env }, encoding: "utf8", timeout: 30000 },
		);
		assert.equal(out.status, 0, (out.stderr || "").slice(-500));
		const parsed = JSON.parse(out.stdout.trim().split("\n").pop());
		assert.equal(parsed.model, "base");
	});

	check("fixture returns resolved model + overlapped utterances", async () => {
		const env = {
			...process.env,
			TRANSCRIBE_FIXTURE: JSON.stringify([
				{ t0: 0, t1: 8, text: "Welcome to the pricing overview today." },
				{ t0: 40, t1: 48, text: "The architecture diagram shows the flow." },
			]),
		};
		const r = spawnSync(
			process.execPath,
			[
				"-e",
				"process.env.TRANSCRIBE_FIXTURE=process.argv[1];import('./indexer/transcribe-worker.js').then(m=>m.transcribeVideo('x.mp4',0,{modelId:'base.en'}).then(o=>console.log(JSON.stringify(o))))",
				env.TRANSCRIBE_FIXTURE,
			],
			{ cwd: ROOT, env: { ...process.env }, encoding: "utf8", timeout: 30000 },
		);
		assert.equal(r.status, 0, (r.stderr || "").slice(-500));
		const out = JSON.parse(r.stdout.trim().split("\n").pop());
		assert.equal(out.model, "base.en");
		assert.ok(
			Array.isArray(out.utterances) && out.utterances.length === 2,
			`expected 2 utterances, got ${JSON.stringify(out.utterances)}`,
		);
		assert.ok(out.utterances[0].text.includes("pricing"));
	});

	check("legacy small.en resolves to base.en (never throws)", async () => {
		const r = spawnSync(
			process.execPath,
			[
				"-e",
				"process.env.TRANSCRIBE_FIXTURE=process.argv[1];import('./indexer/transcribe-worker.js').then(m=>m.transcribeVideo('x.mp4',0,{modelId:'small.en'}).then(o=>console.log(JSON.stringify(o))))",
				JSON.stringify([{ t0: 0, t1: 8, text: "Hello world today." }]),
			],
			{ cwd: ROOT, env: { ...process.env }, encoding: "utf8", timeout: 30000 },
		);
		assert.equal(r.status, 0, (r.stderr || "").slice(-500));
		const out = JSON.parse(r.stdout.trim().split("\n").pop());
		assert.equal(out.model, "base.en");
	});

	check("invalid modelId resolves to tiny (never throws)", async () => {
		const r = spawnSync(
			process.execPath,
			[
				"-e",
				"process.env.TRANSCRIBE_FIXTURE=process.argv[1];import('./indexer/transcribe-worker.js').then(m=>m.transcribeVideo('x.mp4',0,{modelId:'large-v3'}).then(o=>console.log(JSON.stringify(o))))",
				JSON.stringify([{ t0: 0, t1: 8, text: "Hello world today." }]),
			],
			{ cwd: ROOT, env: { ...process.env }, encoding: "utf8", timeout: 30000 },
		);
		assert.equal(r.status, 0, (r.stderr || "").slice(-500));
		const out = JSON.parse(r.stdout.trim().split("\n").pop());
		assert.equal(out.model, "tiny.en");
	});

	check("no engine → valid empty still carries model", async () => {
		const env = {
			...process.env,
			FFMPEG_PATH: "/nonexistent/ffmpeg-for-tests",
			TRANSFORMERS_CACHE: "/nonexistent/cache-for-tests",
		};
		delete env.TRANSCRIBE_FIXTURE;
		const r = spawnSync(
			process.execPath,
			[
				"-e",
				"import('./indexer/transcribe-worker.js').then(m=>m.transcribeVideo('x.mp4',0,{modelId:'base.en'}).then(o=>console.log(JSON.stringify(o))))",
			],
			{
				cwd: ROOT,
				env,
				encoding: "utf8",
				timeout: 30000,
			},
		);
		assert.equal(r.status, 0, (r.stderr || "").slice(-500));
		const out = JSON.parse(r.stdout.trim().split("\n").pop());
		assert.equal(out.done, true);
		assert.deepEqual(out.chunks, []);
		assert.equal(out.model, "base.en");
	});
}

// ---------------------------------------------------------------------------
console.log("[whisper-model] 4. main.js wiring");
// ---------------------------------------------------------------------------
{
	const main = read("main.ts");

	check("readWhisperModel validated fallback", () => {
		// C-01 Wave 2 (S1): settings accessors live in main-lib/settings.ts.
		const settings = read("main-lib/settings.ts");
		assert.ok(
			settings.includes("function readWhisperModel"),
			"missing readWhisperModel",
		);
		assert.ok(
			settings.includes("parseWhisperModel(readSettings().whisperModel)"),
			"must read settings.json via parse",
		);
	});

	check("IPC get/set-whisper-model pair", () => {
		// Phase 1 (media): handlers moved to main/ipc/media.ts.
		const media = read("main/ipc/media.ts");
		const src = main + media;
		assert.ok(
			src.includes("memories:get-whisper-model"),
			"missing get channel",
		);
		assert.ok(
			src.includes("memories:set-whisper-model"),
			"missing set channel",
		);
		assert.ok(
			src.includes(
				"Unknown speech model (expected tiny.en, base.en, tiny, or base)",
			),
			"missing validation error",
		);
	});

	check("legacy small.en migrates to base.en + orphan weights swept", () => {
		// C-01 Wave 2 (S1): the weights cleanup lives in
		// main-lib/settings.ts; the migration + IPC alias stay in main.js.
		// Phase 1 (media): the set handler moved to main/ipc/media.ts.
		const settings = read("main-lib/settings.ts");
		const media = read("main/ipc/media.ts");
		assert.ok(
			media.includes('requested === "small.en"'),
			"IPC must alias stale small.en requests",
		);
		assert.ok(
			// Phase 1 (protocol→media): helper relocated with media.js.
			(media + main).includes("function migrateRemovedWhisperModel"),
			"missing removal migration",
		);
		assert.ok(
			settings.includes("function cleanupRemovedWhisperWeights"),
			"missing weights cleanup",
		);
		assert.ok(
			settings.includes("whisper-small.en"),
			"cleanup must target the small.en cache",
		);
	});

	check("switch invalidates sidecar + re-queues", () => {
		// Phase 1 (media): handler moved (registers via the wrapper's
		// `handle`, not `ipcMain.handle`).
		const media = read("main/ipc/media.ts");
		const fn = media.slice(
			media.indexOf('handle("memories:set-whisper-model"'),
		);
		assert.ok(fn.includes("c.videos = new Map()"), "must clear chunks");
		assert.ok(fn.includes("c.rows = []"), "must clear bin rows");
		assert.ok(
			fn.includes("c.utterances = new Map()"),
			"must clear utterance lines",
		);
		assert.ok(fn.includes("c.progress = {}"), "must clear progress");
		assert.ok(fn.includes("enqueueTranscription"), "must re-queue library");
	});

	check("pump passes modelId + per-model timeout + race check", () => {
		// Phase 1 (pumps/transcribe): pump moved to main/ipc/pumps/transcribe.ts.
		const pump = read("main/ipc/pumps/transcribe.ts");
		const fn = pump.slice(pump.indexOf("async function pumpTranscription"));
		assert.ok(fn.includes("readWhisperModel()"), "pump must read the setting");
		assert.ok(
			fn.includes("transcribeTimeoutsFor(whisperModel)"),
			"pump must size timeouts per model",
		);
		assert.ok(
			fn.includes("modelId: whisperModel"),
			"message must carry modelId",
		);
		assert.ok(
			fn.includes("timeouts.chunkTimeoutMs"),
			"askTranscribe must use the scaled ceiling",
		);
		assert.ok(
			fn.includes("changed mid-flight"),
			"must drop stale-model replies",
		);
	});

	check("pump wires stall watchdog + poison-slice advance (stall fix)", () => {
		const pump = read("main/ipc/pumps/transcribe.ts");
		// askTranscribe consumes the previously-unused stall interval.
		assert.ok(
			pump.includes("timeouts.stallTimeoutMs"),
			"askTranscribe must use the stall interval",
		);
		// Per-model window + decode ceiling + skip list ride the message.
		assert.ok(
			pump.includes("slicesPerChunk: timeouts.slicesPerChunk"),
			"message must carry the per-model window",
		);
		assert.ok(
			pump.includes("sliceDecodeTimeoutMs: timeouts.sliceDecodeTimeoutMs"),
			"message must carry the per-slice decode ceiling",
		);
		assert.ok(
			pump.includes("skipSlices: job.skipSlices"),
			"message must carry poison slices",
		);
		// Watchdog kill + heartbeat-only accounting + skip persistence.
		assert.ok(
			pump.includes("killTranscribeWorker("),
			"stall path must kill the wedged worker",
		);
		assert.ok(
			pump.includes("!msg.heartbeat"),
			"heartbeat-only ticks must not mark decode progress",
		);
		assert.ok(
			pump.includes("addSkippedSlice(job.skipSlices, stalledSlice)"),
			"stall must advance the skip list, not replay the wedge",
		);
		assert.ok(
			pump.includes("skipped: job.skipSlices.slice()"),
			"skips must persist to sidecar progress for relaunch",
		);
	});

	check("worker: per-slice ceiling + heartbeat + suicide (stall fix)", () => {
		const worker = read("indexer/transcribe-worker.ts");
		assert.ok(
			worker.includes("SLICE_STALL_EXIT_CODE"),
			"worker must define the stall-suicide code",
		);
		assert.ok(
			worker.includes("withTimeout("),
			"decode must run under a per-slice ceiling",
		);
		assert.ok(
			worker.includes("heartbeat: true"),
			"worker must emit interval heartbeats during long decodes",
		);
		assert.ok(
			worker.includes("process.exit(SLICE_STALL_EXIT_CODE)"),
			"wedged decode must suicide so no orphan overlaps the retry",
		);
		assert.ok(
			worker.includes("skipSet.has(si)"),
			"worker must gap previously-stalled slices",
		);
	});

	check("sidecar stamps + validates whisperModel + utterance lines", () => {
		// C-01 Wave 2 (S4): the transcript sidecar lives in
		// main-lib/library-store.ts.
		// Phase 2 (store): sidecars moved to main-lib/store/sidecars.ts.
		const store =
			read("main-lib/library-store.ts") + read("main-lib/store/sidecars.ts");
		assert.ok(
			store.includes("whisperModel: DEFAULT_WHISPER_MODEL"),
			"cache default stamp",
		);
		assert.ok(
			store.includes('parseWhisperModel(parsed.whisperModel || "tiny.en")'),
			"pre-stamp sidecars read as tiny.en",
		);
		assert.ok(
			store.includes("whisperModel: parseWhisperModel(c.whisperModel)"),
			"save stamps validated model",
		);
		assert.ok(
			store.includes("utterances: new Map()"),
			"cache carries utterance lines",
		);
		assert.ok(
			store.includes("utterances: c.utterances.get(filename)"),
			"save persists per-film lines",
		);
	});
}

// ---------------------------------------------------------------------------
console.log("[whisper-model] 5. renderer wiring");
// ---------------------------------------------------------------------------
{
	check("lib parse + hook + preload + types + Settings UI", () => {
		const lib = read("src/lib/whisperModel.ts");
		assert.ok(
			lib.includes('"tiny.en"') &&
				lib.includes('"base.en"') &&
				lib.includes('"tiny"') &&
				lib.includes('"base"'),
			"lib must list the 4 engine ids",
		);
		assert.ok(
			lib.includes("WHISPER_MODEL_LABELS"),
			"multilingual rows need their own labels",
		);
		assert.ok(
			!lib.includes('"small.en": "Best words'),
			"small.en option must be gone",
		);
		assert.ok(
			lib.includes('raw === "small.en"'),
			"lib must keep the legacy alias",
		);
		// Phase 4a (stores): the whisper bridge moved to the prefs store.
		const store = read("src/stores/usePrefsStore.ts");
		assert.ok(
			store.includes("getWhisperModel") && store.includes("setWhisperModel"),
			"store must bridge both",
		);
		const preload = read("preload.js");
		assert.ok(
			preload.includes("memories:get-whisper-model"),
			"missing get bridge",
		);
		assert.ok(
			preload.includes("memories:set-whisper-model"),
			"missing set bridge",
		);
		const types = read("src/types.d.ts");
		assert.ok(
			types.includes("getWhisperModel") && types.includes("setWhisperModel"),
			"missing type declarations",
		);
		const settings = read("src/components/SettingsSheet.tsx");
		assert.ok(
			settings.includes('aria-label="Speech model"'),
			"missing Settings radio group",
		);
		assert.ok(
			settings.includes("WHISPER_MODEL_LABELS[value]"),
			"rows must use per-model labels (not a tiny/base binary)",
		);
		assert.ok(
			settings.includes("onWhisperModelChange"),
			"missing change handler prop",
		);
		assert.ok(
			settings.includes("re-transcribing"),
			"must warn about re-transcription",
		);
		// Phase 4a/c (stores): whisper state lives in the prefs store;
		// the Settings sheet reads it via selector (no prop drilling).
		const sheet = read("src/components/SettingsSheet.tsx");
		assert.ok(
			sheet.includes("usePrefsStore") &&
				sheet.includes("(s) => s.whisperModel"),
			"SettingsSheet must read whisper state from the store",
		);
	});
}

console.log(`\n[whisper-model] ${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
