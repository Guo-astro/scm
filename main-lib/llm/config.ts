// LLM settings (Settings → AI Chat): the Ask-mode feature flag and chat
// model, persisted under settings.json `llm`. Validated-fallback like
// readWhisperModel — the parse lives HERE (the way parseVideoQuality lives
// in indexer/video-utils.js) and reads go through the cached readSettings().
// No electron dependency: plain-node tests init settings with a tmpdir.

import path from "node:path";
import { readSettings, writeSettings } from "../settings.ts";
import { LLM_MODELS, resolveLlmModelId } from "./models.ts";

// The user-data dir holding the downloaded sidecar (bin/ + models/). Set by
// initLlmConfig from main; tests point it at a tmpdir.
let LLM_DIR: string | null = null;

export function initLlmConfig({ userDataDir }: { userDataDir: string }): void {
	LLM_DIR = path.join(userDataDir, "llm");
}

export function llmDir(): string | null {
	return LLM_DIR;
}

export interface LlmConfig {
	enabled: boolean;
	chatModel: string;
}

// Pure: validate a raw settings.json `llm` value into the effective config.
// Unknown/missing fields fall back — a hand-edited or half-written key can
// never disable the defaults silently.
export function parseLlmConfig(raw: unknown): LlmConfig {
	const src: { enabled?: unknown; chatModel?: unknown } =
		raw && typeof raw === "object"
			? (raw as { enabled?: unknown; chatModel?: unknown })
			: {};
	return {
		enabled: src.enabled === true,
		chatModel: resolveLlmModelId(src.chatModel),
	};
}

export function readLlmConfig(): LlmConfig {
	try {
		return parseLlmConfig(readSettings().llm);
	} catch {
		return parseLlmConfig(null);
	}
}

// Merge-patch one validated config through the atomic settings write.
// Returns the effective config after the write.
export function writeLlmConfig(
	patch?: Record<string, unknown> | null,
): LlmConfig {
	const prev = parseLlmConfig(readSettings().llm);
	const next = parseLlmConfig({ ...prev, ...(patch || {}) });
	writeSettings({ llm: next });
	return next;
}

export interface LlmModelInfo {
	id: string;
	label: string;
	shortLabel: string;
	blurb: string;
	sizeBytes: number;
	ctxTokens: number;
	license: string;
	speed: string;
	downloaded: boolean;
}

// Model rows for the Settings UI / status IPC: registry order, with the
// on-disk downloaded flag resolved by the caller-supplied checker (kept out
// of this module so config stays pure).
export function llmModelInfos(isDownloaded?: unknown): LlmModelInfo[] {
	const check = typeof isDownloaded === "function" ? isDownloaded : () => false;
	return Object.entries(LLM_MODELS).map(([id, m]) => ({
		id,
		label: m.label,
		shortLabel: m.shortLabel,
		blurb: m.blurb,
		sizeBytes: m.sizeBytes,
		ctxTokens: m.ctxTokens,
		license: m.license,
		speed: m.speed,
		downloaded: check(id) === true,
	}));
}

export { DEFAULT_LLM_MODEL_ID } from "./models.ts";
