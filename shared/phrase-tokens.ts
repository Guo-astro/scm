// Filename → phrase tokens — the single source for the phrase-embedding gate.
//
// Two consumers must agree exactly:
//
//   - indexer/memory-embedding-utils.ts (buildFilenamePhrase) embeds these
//     tokens into the persisted phrase vectors, and
//   - src/lib/memoryRank.ts (phraseTokenOverlap) gates the runtime phrase
//     boost on LITERAL overlap with the same tokens.
//
// Drift here does not throw: it silently makes the boost fire on the wrong
// filenames (or stop firing), so this lives in one place and
// test/phrase-tokens.test.ts runs a corpus through both entry points.
//
// Rules — deliberately simple, and frozen because changing them invalidates
// the persisted phrase embeddings (a reindex is required if they change):
// lowercase; split on ".", "_", "-" and whitespace; "scr" → "screenshot";
// drop generic filename noise; cap at MAX_PHRASE_TOKENS.

export const PHRASE_NOISE_TOKENS: ReadonlySet<string> = new Set([
	"img",
	"image",
	"photo",
	"pic",
	"picture",
	"dsc",
	"dscn",
	"untitled",
	"new",
]);

export const MAX_PHRASE_TOKENS = 8;

/** Filename → phrase tokens. Deterministic; no CJK bigrams (see header). */
export function phraseTokens(filename: string): string[] {
	const base = filename.replace(/\.[^.]+$/, "");
	return base
		.toLowerCase()
		.split(/[._\-\s]+/)
		.filter(Boolean)
		.map((token) => (token === "scr" ? "screenshot" : token))
		.filter((token) => !PHRASE_NOISE_TOKENS.has(token))
		.slice(0, MAX_PHRASE_TOKENS);
}
