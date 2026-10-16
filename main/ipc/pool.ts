// Phase 1 (pool): pure move from main.js (2026-10-10) — indexer worker pool
// (spawn/grow/ask/restart/stop), ffmpeg-child tracking + reaping, model
// status + weights. No behavior change: same placement, timeouts,
// broadcasts. Shared refs still owned by main.js arrive via main/context.js
// and are read AT CALL TIME: updateTrayState (tray). Worker-model pinning
// reads the migration module directly (no cycle: migration never requires
// pool). Sibling progress intake rides the enrich module directly. Own state
// (workers, ready promise, status, ffmpeg maps, pool size) is exported below
// for the stayers (boot, tray, purge, will-quit, e2e ctxs) and backfills the
// shared slots sibling modules read — same live bindings. This module never
// requires main.js.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { utilityProcess, BrowserWindow, app } from "electron";
import { handle } from "../ipc-wrapper.ts";
import ctx from "../context.ts";
import { noteEnrichProgress } from "./pumps/enrich.ts";
import { loadLibrary, saveLibrary } from "../../main-lib/library-store.ts";
import {
	getModel,
	resolveModelId,
	type ModelConfig,
} from "../../indexer/models.ts";
import {
	reembedToModel,
	preloadModelWeights,
	preloadAllModels,
} from "./migration.ts";
// NOTE: the reembedToModel/preloadModelWeights/preloadAllModels require was
// mid-file through the Phase 1 move (kept verbatim then); the conversion
// hoists it into this top block — migration.js never requires pool (its pool
// slots arrive via ctx), so the load order has no observable effect.
import type {
	IndexerInbound,
	IndexerOutbound,
} from "../../shared/worker-messages.ts";

// ---------------------------------------------------------------------------

const INDEXER_POOL_SIZE = Math.max(
	1,
	Number(process.env.INDEXER_POOL_SIZE) || 1,
);

interface FfmpegPidEntry {
	firstSeen: number;
	label: string;
}

// One pending ask: resolve/reject unknown-typed (the caller casts its reply
// once at the ask site — the same pattern as the pumps).
interface PendingRequest {
	resolve: (v: unknown) => void;
	reject: (e: unknown) => void;
	timer: NodeJS.Timeout;
}

interface IndexerWorker {
	process: Electron.UtilityProcess | null;
	primary: boolean;
	ready: Promise<unknown> | null;
	dead: boolean;
	pending: Map<string, PendingRequest>;
	// Set inside the ready executor so the exit handler can settle init when
	// the process dies before answering (see createIndexerWorker).
	readyReject: ((e: unknown) => void) | null;
}

let indexerWorkers: IndexerWorker[] = []; // { process, primary, ready, dead, pending }
let indexerReady: Promise<unknown> | null = null; // primary worker's init-done promise
// Set when the primary's init handshake rejects (model load failed) so
// import batches can fail fast without copying files that will never embed.
// Cleared on a fresh spawn (a respawn retries init from scratch).
let indexerInitFailed: Error | null = null;
let requestId = 0;
let pickRoundRobin = 0;
// Latest AI-model status (loading/ready/error + download %). Cached so a
// window that mounts after events fired still learns the current state.
let modelStatus: {
	type: string;
	phase: string;
	progress: number | null;
	firstRun: boolean;
	modelId: string;
} | null = null;
// True while the ACTIVE model's weights are absent from the model cache —
// i.e. the user's first launch with this model. Computed once per worker
// spawn and stamped onto every model status so the UI can show a one-time
// download hint without flapping mid-download (partial files appear in the
// cache early).
let modelFirstRun = false;
// Phase 1 (migration): workerModelId moved with the migration module (it
// owns all writes; poolModelId + restore read it via getters).

// Which model the next worker fork should load: the migration target when
// one is pinned, else the library's active model.
function poolModelId() {
	// Phase 1 (migration): workerModelId lives in the migration module.
	return ctx.getWorkerModelId() || resolveModelId(loadLibrary().modelId);
}

// ---------------------------------------------------------------------------
// Orphan-proof ffmpeg PID tracking (2026-09-28 ffmpeg-CPU fix).
//
// Workers report every ffmpeg spawn/exit ({type:ffmpeg-spawn/exit,pid}) so
// main can SIGKILL grandchildren by PID even AFTER the worker died (the old
// code only killed the Node worker; ffmpeg survived to PID 1 with no timers
// left — the 500%+ CPU after "done" and after quit). Maps survive worker
// restarts; entries are best-effort (ESRCH on kill = already gone).
// ---------------------------------------------------------------------------
const indexerFfmpegPids = new Map<number, FfmpegPidEntry>(); // pid -> { firstSeen, label }
const transcribeFfmpegPids = new Map<number, FfmpegPidEntry>();

function trackFfmpegSpawn(
	map: Map<number, FfmpegPidEntry>,
	pid: number,
	label: unknown,
) {
	if (!Number.isInteger(pid) || pid <= 0) return;
	if (!map.has(pid)) {
		map.set(pid, { firstSeen: Date.now(), label: String(label || "") });
	}
}

function untrackFfmpegExit(map: Map<number, FfmpegPidEntry>, pid: number) {
	if (Number.isInteger(pid)) map.delete(pid);
}

// SIGKILL every PID in the map. Never throws. Returns killed count.
function killTrackedFfmpegPids(
	map: Map<number, FfmpegPidEntry>,
	reason: string,
) {
	let killed = 0;
	for (const pid of [...map.keys()]) {
		try {
			process.kill(pid, "SIGKILL");
			killed++;
		} catch {
			/* ESRCH = already gone, EPERM = not ours — both fine */
		} finally {
			map.delete(pid);
		}
	}
	if (killed > 0) {
		console.warn(
			`[memories] killed ${killed} tracked ffmpeg child(ren) (${reason || "unknown"})`,
		);
	}
	return killed;
}

// Ask a live worker to kill its own ffmpeg children first (fast path when
// the worker is still alive), then belt-and-braces kill tracked PIDs by PID
// (covers the worker-already-dead case). Never throws, never awaits. The
// worker param is structural: pool workers and the transcribe handle both
// carry { process, dead }.
function requestWorkerKillFfmpeg(
	worker: { process?: Electron.UtilityProcess | null; dead?: boolean } | null,
	map: Map<number, FfmpegPidEntry> | null,
	reason: string,
) {
	try {
		if (worker && worker.process && !worker.dead) {
			try {
				worker.process.postMessage({ type: "kill-ffmpeg", reason });
			} catch {
				/* worker gone — PID sweep below still applies */
			}
		}
	} finally {
		if (map) killTrackedFfmpegPids(map, reason);
	}
}

// Startup orphan reaper (2026-09-28): previous runs (pre-fix, or crashes)
// may have left ffmpeg children reparented to PID 1 still decoding. They
// share our bundled binary path and usually the library path. Best-effort:
// list processes via `ps`, SIGKILL matches, never throw, never kill anything
// that does not look like ours.
function reapStaleFfmpegOrphans() {
	try {
		let out = "";
		try {
			out = execFileSync("ps", ["-ax", "-o", "pid=,ppid=,command="], {
				encoding: "utf8",
				timeout: 5000,
				windowsHide: true,
			});
		} catch {
			return 0;
		}
		let killed = 0;
		for (const line of String(out).split("\n")) {
			const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
			if (!m) continue;
			const pid = Number(m[1]);
			const ppid = Number(m[2]);
			const cmd = m[3] || "";
			if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
			// Our bundled binary only: packaged Resources/ffmpeg or
			// ffmpeg-static under node_modules. Never touch system ffmpeg.
			const isOurs =
				cmd.includes("Contents/Resources/ffmpeg") ||
				cmd.includes("node_modules/ffmpeg-static");
			if (!isOurs) continue;
			// Extra guard: only orphans (PPID 1) or library-path decodes.
			// A live worker's ffmpeg has a live parent and is tracked; the
			// dangerous leftovers are exactly the PPID-1 ones.
			const touchesLibrary =
				cmd.includes("library/photos") || cmd.includes("memories-transcribe-");
			if (ppid !== 1 && !touchesLibrary) continue;
			try {
				process.kill(pid, "SIGKILL");
				killed++;
			} catch {
				/* already gone */
			}
		}
		if (killed > 0) {
			console.warn(
				`[memories] reaped ${killed} stale ffmpeg orphan(s) from previous runs`,
			);
		}
		return killed;
	} catch {
		return 0;
	}
}

// transformers.js writes the ONNX weights last, so a cache holding only
// partial files is an interrupted FIRST download — that must still count as
// first run. Both quantized weights (vision + text) must be on disk for the
// model to count as downloaded. Per-model: the cache root may already hold
// ANOTHER model's weights, which says nothing about the active one's.
function countOnnx(dir: string): number {
	try {
		let n = 0;
		for (const entry of fs.readdirSync(dir)) {
			const full = path.join(dir, entry);
			if (fs.statSync(full).isDirectory()) {
				n += countOnnx(full);
			} else if (entry.endsWith(".onnx")) {
				n++;
			}
		}
		return n;
	} catch {
		return 0;
	}
}

// transformers.js (v2 and v3 alike) caches each repo under
// <cache>/<org>/<name>/onnx/ (the FileCache keys on the request path, e.g.
// Xenova/clip-vit-base-patch32/onnx/…), so weights downloaded by either
// version are found. Legacy v1 caches used models--<org>--<name>; both are
// checked so a model downloaded by any version counts as downloaded.
function modelCacheDir(modelId: string) {
	// Partial fallback: the empty-object shape the pre-conversion code used.
	const config: Partial<ModelConfig> = getModel(resolveModelId(modelId)) || {};
	const repo = config.repo || "";
	return path.join(app.getPath("userData"), "models", ...repo.split("/"));
}

function modelDownloaded(modelId: string) {
	const config: Partial<ModelConfig> = getModel(resolveModelId(modelId)) || {};
	if (config.minimumWeightBytes) {
		const root = modelCacheDir(modelId);
		return Object.entries(
			config.minimumWeightBytes as Record<string, number>,
		).every(([relativePath, minimumBytes]) => {
			try {
				return fs.statSync(path.join(root, relativePath)).size >= minimumBytes;
			} catch {
				return false;
			}
		});
	}
	const current = countOnnx(modelCacheDir(modelId));
	if (current >= 2) return true;
	// Legacy transformers v1 layout (models--<org>--<name>).
	const repo = (getModel(resolveModelId(modelId)) || {}).repo || "";
	const legacy = path.join(
		app.getPath("userData"),
		"models",
		`models--${repo}`,
	);
	return countOnnx(legacy) >= 2;
}

function indexerEnv() {
	const ffmpegPath =
		process.env.FFMPEG_PATH ||
		(process.resourcesPath &&
		fs.existsSync(path.join(process.resourcesPath, "ffmpeg"))
			? path.join(process.resourcesPath, "ffmpeg")
			: undefined);
	return {
		...process.env,
		INDEXER_MODEL: poolModelId(),
		TRANSFORMERS_CACHE: path.join(app.getPath("userData"), "models"),
		// Phase 1.4 detect cache: per-file shot plans live next to other
		// userData state so re-import / re-analysis skips the ffmpeg scene
		// pass. MEMORIES_DATA_DIR smoke runs already isolate userData; this
		// makes the packaged app (which does not set MEMORIES_DATA_DIR)
		// cache too.
		SCM_DETECT_CACHE_DIR: path.join(app.getPath("userData"), "detect-cache"),
		// EP A/B knob (plan 0.3): pass through if set in the main process;
		// default remains cpu inside the worker when unset.
		...(process.env.SCM_EXECUTION_PROVIDERS
			? { SCM_EXECUTION_PROVIDERS: process.env.SCM_EXECUTION_PROVIDERS }
			: {}),
		...(ffmpegPath ? { FFMPEG_PATH: ffmpegPath } : {}),
	};
}

// Kill the whole pool (and any in-flight requests). Used when the model
// must change: the workers hold the old model in memory, so a model switch
// is a pool respawn, never a reload inside a worker.
//
// Orphan fix: each worker is asked to SIGKILL its ffmpeg children FIRST,
// then tracked PIDs are killed by PID (covers workers already dead), and
// only then is the Node worker itself killed. The old order (kill worker
// only) orphaned ffmpeg to PID 1.
function stopIndexerPool() {
	for (const worker of indexerWorkers) {
		requestWorkerKillFfmpeg(worker, indexerFfmpegPids, "stopIndexerPool");
		if (worker.process) {
			try {
				worker.process.kill();
			} catch {
				/* already gone */
			}
		}
	}
	indexerWorkers = [];
	indexerReady = null;
	indexerInitFailed = null;
	modelStatus = null;
	modelFirstRun = false;
}

// Fork one worker and wire its message/exit handlers. The worker serializes
// its own message handling (see indexer.js) — the pool just feeds it requests.
function createIndexerWorker({ primary = false }: { primary?: boolean } = {}) {
	const worker: IndexerWorker = {
		process: null,
		primary,
		ready: null,
		dead: false,
		pending: new Map(),
		readyReject: null,
	};
	worker.ready = new Promise((resolve, reject) => {
		// Kept so the exit handler can settle init when the process dies
		// before answering (kill-during-fork): without this, an
		// `await indexerReady` that captured this promise hangs forever —
		// every other indexer call carries a timeout, this one never did.
		worker.readyReject = reject;
		worker.process = utilityProcess.fork(
			path.join(__dirname, "..", "..", "indexer", "indexer.js"),
			[],
			{
				env: indexerEnv(),
				serviceName: primary
					? "clip-indexer"
					: `clip-indexer-${indexerWorkers.length}`,
			},
		);
		// From the moment a worker forks the model is warming; the primary
		// drives the renderer's status (a first-run download is its job; the
		// extras load from the already-populated cache and stay quiet).
		if (primary) {
			modelFirstRun = !modelDownloaded(poolModelId());
			modelStatus = {
				type: "model",
				phase: "loading",
				progress: null,
				firstRun: modelFirstRun,
				modelId: poolModelId(),
			};
			ctx.updateTrayState();
			for (const win of BrowserWindow.getAllWindows()) {
				win.webContents.send("memories:status", modelStatus);
			}
		}
		const onInit = (reply: IndexerOutbound) => {
			// The union types init-done as ok:true (the worker posts failures
			// under the request type "init" — see indexer.js's dispatch
			// catch); the ok:false branch below is the pool's defensive copy
			// of the pre-union protocol shape, kept verbatim — hence the
			// widened cast instead of narrowing.
			const msg = reply as IndexerOutbound & {
				ok?: boolean;
				error?: string;
			};
			if (msg && msg.type === "init-done") {
				worker.process?.off("message", onInit);
				// Widen the ok read: the union types init-done's ok as literal
				// true (failures ride the request type "init"), which would
				// collapse the defensive else below to never — the pre-union
				// protocol shape it preserves stays verbatim.
				if ((msg as { ok?: boolean }).ok) {
					// A worker for the CURRENTLY ACTIVE model owns the library's
					// textMean (centering is per-model). During a migration the
					// pool runs the TARGET model while the library still names
					// the old one, so its textMean is NOT adopted here — the
					// migration fetches it explicitly at the flip.
					if (
						primary &&
						poolModelId() === loadLibrary().modelId &&
						!loadLibrary().pendingModelMigration
					) {
						if (Array.isArray(msg.textMean)) {
							loadLibrary().textMean = new Float32Array(msg.textMean);
							void saveLibrary();
						}
						// The ONNX output dim is the truth: align the library's
						// dim with it (and warn when the persisted dim disagreed
						// — a stale/wrong-model bin must not rank silently).
						if (Number(msg.dim) > 0 && loadLibrary().dim !== msg.dim) {
							if (loadLibrary().filenames.length === 0) {
								loadLibrary().dim = msg.dim;
							} else {
								console.warn(
									`[memories] indexed dim ${loadLibrary().dim} does not match ` +
										`the ${loadLibrary().modelId} model output (${msg.dim}); ` +
										"re-embed the library (switch models or re-import) to fix ranking.",
								);
							}
						}
					}
					resolve(msg);
					// The active model's weights just finished downloading (first
					// run): let the picker refresh its downloaded flags via the
					// same channel the preload path uses.
					if (primary && modelFirstRun) {
						for (const win of BrowserWindow.getAllWindows()) {
							win.webContents.send("memories:status", {
								type: "model-preload",
								modelId: poolModelId(),
								phase: "ready",
								progress: 100,
							});
						}
					}
				} else {
					const err = new Error(msg.error || "Indexer init failed");
					if (primary) indexerInitFailed = err;
					// A worker that cannot load its model can never serve a
					// request. Drop it from dispatch and free the half-loaded
					// model so the pool rebuilds cleanly: the primary's exit
					// resets indexerReady/status (the next spawn retries the
					// load — an interrupted first download resumes from its
					// cache, which is the recovery path), and a failed extra
					// just disappears from round-robin instead of poisoning
					// every Nth request with a 180s timeout.
					worker.dead = true;
					// Demote before killing so a late exit event can't promote a
					// stale worker's ready promise onto a newer pool.
					worker.primary = false;
					try {
						worker.process?.kill();
					} catch {
						/* already gone */
					}
					reject(err);
				}
			}
		};
		worker.process.on("message", (event) => {
			// The intersection adds the optional request-envelope props
			// (id/ok/error): broadcast members lack them, but this listener
			// handles every message shape and resolves pending asks on the
			// tagged ones — same reads as the pre-conversion code.
			const msg = (
				event && event.data !== undefined ? event.data : event
			) as IndexerOutbound & {
				id?: string;
				ok?: boolean;
				error?: string;
			};
			// Orphan-fix PID tracking: workers report every ffmpeg spawn/exit
			// so main can SIGKILL grandchildren by PID after the worker dies.
			if (msg && msg.type === "ffmpeg-spawn") {
				trackFfmpegSpawn(indexerFfmpegPids, msg.pid, msg.label);
				return;
			}
			if (msg && msg.type === "ffmpeg-exit") {
				untrackFfmpegExit(indexerFfmpegPids, msg.pid);
				return;
			}
			if (msg && msg.type === "ffmpeg-killed") {
				// Worker confirmed its own sweep; PID map entries for exited
				// children arrive separately as ffmpeg-exit. Best-effort sync:
				// drop any PIDs the worker says are gone (none named = noop).
				return;
			}
			if (msg && (msg.type === "status" || msg.type === "model")) {
				if (msg.type === "model" && primary) {
					modelStatus = {
						...msg,
						firstRun: modelFirstRun,
						modelId: poolModelId(),
					};
					ctx.updateTrayState();
				}
				for (const win of BrowserWindow.getAllWindows()) {
					win.webContents.send("memories:status", msg);
				}
			}
			if (msg && msg.type === "enrich-progress") {
				// Background scene analysis → renderer tray (Phase 4). The
				// worker omits the request id so this can never collide with
				// the pending-map resolution below; the queue length rides
				// along so the tray can show "N more waiting". Progress
				// bookkeeping lives in the enrich module (Phase 1 move).
				// Cast: the union types this member as a Record<string,
				// unknown> pass-through, so its optional fields read unknown —
				// noteEnrichProgress re-validates each field at runtime.
				noteEnrichProgress(msg as Parameters<typeof noteEnrichProgress>[0]);
				for (const win of BrowserWindow.getAllWindows()) {
					win.webContents.send("memories:status", {
						...msg,
						type: "enrich",
						pending: Math.max(0, ctx.getEnrichQueue().length - 1),
					});
				}
			}
			onInit(msg);
			if (msg && msg.id && worker.pending.has(msg.id)) {
				const {
					resolve: r,
					reject: j,
					timer,
				} = worker.pending.get(msg.id) as PendingRequest;
				worker.pending.delete(msg.id);
				clearTimeout(timer);
				if (msg.ok) r(msg);
				else j(new Error(msg.error || "Indexer request failed"));
			}
		});
		worker.process.on("exit", (...args: unknown[]) => {
			// Forensic log: a dead worker with no reason in the log is
			// undebuggable from CI artifacts. Arg shape varies by Electron
			// version, so dump everything (code-first vs event-first).
			// Pair with the app-level child-process-gone listener below,
			// whose `reason` names oom/crashed/killed explicitly.
			try {
				console.log(`[indexer] worker exited args=${JSON.stringify(args)}`);
			} catch {
				console.log(`[indexer] worker exited (unserializable args)`);
			}
			worker.dead = true;
			indexerWorkers = indexerWorkers.filter((w) => w !== worker);
			for (const [, req] of worker.pending) {
				clearTimeout(req.timer);
				req.reject(new Error("Indexer exited"));
			}
			worker.pending = new Map();
			// Init never answered and never will — settle it so a captured
			// `await indexerReady` fails fast (every awaiter try/catches)
			// instead of hanging on a dead fork. A later spawn assigns a
			// fresh promise, so this rejection can't poison the new pool.
			if (worker.readyReject) {
				const reject = worker.readyReject;
				worker.readyReject = null;
				reject(new Error("Indexer exited during init"));
			}
			if (indexerWorkers.length === 0) {
				// Whole pool gone: let a fresh spawn rebuild everything.
				indexerReady = null;
				indexerInitFailed = null;
				modelStatus = null;
				modelFirstRun = false;
			} else if (worker.primary) {
				// The primary died but extras survive: promote the oldest
				// remaining worker so indexerReady always points at a live
				// worker's (already settled) promise — a dead primary's ready
				// could otherwise hang embed-query/healPhraseBin forever.
				const survivor = indexerWorkers[0] as IndexerWorker; // length > 0 here
				survivor.primary = true;
				indexerReady = survivor.ready;
			}
		});
		worker.process.postMessage({ type: "init" });
	});
	// Extras' ready promises are never awaited (only the primary's is, via
	// indexerReady); without a handler, a failed extra's rejection would be
	// an unhandled rejection, which crashes the main process on modern Node.
	worker.ready?.catch(() => {});
	return worker;
}

function spawnIndexer() {
	if (indexerWorkers.some((w) => !w.dead)) {
		// Pool already alive — top it up (e.g. after a worker exited).
		void growPool();
		return;
	}
	indexerWorkers = [];
	indexerInitFailed = null;
	const primary = createIndexerWorker({ primary: true });
	indexerWorkers.push(primary);
	indexerReady = primary.ready;
	void growPool();
}

// Fork the extra workers once the primary's model is ready (on a first run
// that means after the ~150MB download, so the extras never race it). Extra
// workers that fail init are simply dropped from dispatch — the pool keeps
// serving from whatever is alive.
async function growPool() {
	try {
		await indexerReady;
	} catch {
		return; // primary init failed; extras can't help
	}
	while (indexerWorkers.filter((w) => !w.dead).length < INDEXER_POOL_SIZE) {
		indexerWorkers.push(createIndexerWorker({ primary: false }));
	}
}

// Round-robin dispatch across live workers; queries and batch embeds share
// the pool (a query landing on a busy worker is an edge case, not the norm).
function askIndexer(message: IndexerInbound) {
	const live = indexerWorkers.filter((w) => !w.dead && w.process);
	if (live.length === 0) {
		return Promise.reject(new Error("Indexer not running"));
	}
	const worker = live[pickRoundRobin++ % live.length] as IndexerWorker; // length > 0 here
	return new Promise((resolve, reject) => {
		const id = `r${++requestId}`;
		const timer = setTimeout(() => {
			worker.pending.delete(id);
			reject(new Error("Indexer request timed out"));
		}, 180000);
		worker.pending.set(id, { resolve, reject, timer });
		worker.process?.postMessage({ ...message, id });
	});
}

// Enrichment is pinned to the PRIMARY worker so chunked scene data reuses
// the worker's per-path plan cache — a round-robin would bounce chunks
// across workers and re-run the ffmpeg scene pass on every chunk.
// `timeoutMs` overrides the 180 s default: enrich-video chunks of a 2–3 h
// Ultra film (16 ffmpeg seeks + 16 CLIP embeds) are legitimately slower
// than a single photo embed, so pumpEnrichment passes ENRICH_CHUNK_TIMEOUT_MS.
function askPrimaryIndexer(message: IndexerInbound, timeoutMs = 180000) {
	const primary = indexerWorkers.find((w) => !w.dead && w.process && w.primary);
	if (!primary) return askIndexer(message);
	return new Promise((resolve, reject) => {
		const id = `r${++requestId}`;
		const timer = setTimeout(() => {
			primary.pending.delete(id);
			const err = new Error("Indexer request timed out") as Error & {
				code?: string;
				timeoutMs?: number;
			};
			err.code = "INDEXER_TIMEOUT";
			err.timeoutMs = timeoutMs;
			reject(err);
		}, timeoutMs);
		primary.pending.set(id, { resolve, reject, timer });
		primary.process?.postMessage({ ...message, id });
	});
}

// Restart a wedged primary worker: a chunk that timed out on the main side
// may still be grinding inside the worker (its queue stays busy), so every
// later chunk would queue behind the zombie and time out too — the exact
// 16/1024-forever signature.
//
// Orphan fix (2026-09-28): killing the Node worker does NOT drop ffmpeg —
// POSIX reparents it to PID 1 with no timers left. So the worker is asked to
// SIGKILL its ffmpeg children first AND main kills tracked PIDs by PID
// (covers the worker-already-dead case) before the worker itself is killed.
// The exit handler promotes an extra (or spawnIndexer rebuilds a fresh
// primary when the pool was size 1), and the plan cache rebuilds on the next
// chunk's scene pass. The job's `off` is preserved by the caller, so the
// retry resumes where it stalled.
function restartPrimaryIndexer(reason: string) {
	try {
		const primary = indexerWorkers.find(
			(w) => w.process && w.primary && !w.dead,
		);
		if (primary) {
			console.warn(`[memories] restarting wedged indexer worker (${reason})`);
			requestWorkerKillFfmpeg(primary, indexerFfmpegPids, `restart:${reason}`);
			primary.dead = true;
			primary.primary = false;
			try {
				primary.process?.kill();
			} catch {
				/* already gone */
			}
		} else {
			// No live primary (already dead): tracked ffmpeg PIDs may still
			// be grinding — sweep them so a dead worker can't leave orphans.
			killTrackedFfmpegPids(indexerFfmpegPids, `restart-no-primary:${reason}`);
		}
	} finally {
		try {
			spawnIndexer();
		} catch {
			/* spawn retries on next pump */
		}
	}
}

// Live accessors over module state for the stayers (tray, indexer-status
// handler) and the shared slots. In-place reads/writes only.
const getModelStatus = () => modelStatus;
const getIndexerReady = () => indexerReady;
const getIndexerInitFailed = () => indexerInitFailed;

// Phase 1 (model IPC): the model handlers live with the pool (moved from
// main.js — same validation, same delegates, no behavior change).
// Current AI-engine status, so the renderer can ask on mount instead of
// hoping it didn't miss the broadcast window.
handle("memories:indexer-status", () => getModelStatus());

// Switch the library's model: re-embed every row in the target model, then
// flip the index. Throws on unknown models and concurrent migrations; the
// renderer shows progress from the "migrate" status events.
handle("memories:set-model", async (_event: unknown, modelId: unknown) => {
	if (typeof modelId !== "string" || !getModel(modelId)) {
		throw new Error(`Unknown model: ${modelId}`);
	}
	return reembedToModel(modelId);
});

// Preload a model's weights without switching to it (the picker's per-model
// "Download" chip). Never touches the library or the active worker pool.
handle("memories:preload-model", (_event: unknown, modelId: unknown) =>
	preloadModelWeights(String(modelId)),
);

// "Download all models": fetch every model's weights so future switches are
// instant. Returns per-model results ({ modelId, downloaded, skipped?, error? }).
handle("memories:preload-all", () => preloadAllModels());

export {
	INDEXER_POOL_SIZE,
	indexerWorkers,
	getIndexerReady,
	indexerFfmpegPids,
	transcribeFfmpegPids,
	trackFfmpegSpawn,
	untrackFfmpegExit,
	killTrackedFfmpegPids,
	requestWorkerKillFfmpeg,
	reapStaleFfmpegOrphans,
	getModelStatus,
	modelDownloaded,
	poolModelId,
	indexerEnv,
	spawnIndexer,
	askIndexer,
	askPrimaryIndexer,
	restartPrimaryIndexer,
	stopIndexerPool,
	getIndexerInitFailed,
};
