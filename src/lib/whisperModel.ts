// Speech-model preference (Settings → Video search → Speech model): the
// whisper engine for background transcription. Pure helpers live here so
// parsing is unit-testable without a DOM or IPC bridge. Must stay in sync
// with WHISPER_MODELS in indexer/whisper-models.ts (the engine ids and
// timeout math live there; these blurbs only describe them).

export type WhisperModelSetting = "tiny.en" | "base.en" | "tiny" | "base";

export const WHISPER_MODEL_IDS: WhisperModelSetting[] = [
	"tiny.en",
	"base.en",
	"tiny",
	"base",
];

export const DEFAULT_WHISPER_MODEL: WhisperModelSetting = "tiny.en";

// Card titles shown in Settings (OptionCard-style rows).
export const WHISPER_MODEL_LABELS: Record<WhisperModelSetting, string> = {
	"tiny.en": "Tiny",
	"base.en": "Base",
	tiny: "Tiny · multilingual",
	base: "Base · multilingual",
};

// One-line cost/benefit blurbs shown under each option in Settings.
export const WHISPER_MODEL_BLURBS: Record<WhisperModelSetting, string> = {
	"tiny.en": "Fast, background-friendly",
	"base.en": "Best words, ~300MB download",
	tiny: "Auto-detects each video's language, ~150MB",
	base: "Auto-detects each video's language, ~300MB",
};

/** Parses a stored/bridge value into a valid setting; legacy "small.en" → "base.en", anything else → "tiny.en". */
export function parseWhisperModel(raw: unknown): WhisperModelSetting {
	if (raw === "small.en") return "base.en";
	return raw === "tiny.en" ||
		raw === "base.en" ||
		raw === "tiny" ||
		raw === "base"
		? raw
		: DEFAULT_WHISPER_MODEL;
}
