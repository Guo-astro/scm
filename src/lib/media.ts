// Media-type helpers shared by the grid and the lightbox. The extension
// set must stay in sync with main.js VIDEO_EXTENSIONS (import whitelist):
// everything ffmpeg can decode becomes searchable. Web-browser playback is
// separate: Chromium can only play mp4/m4v/mov/webm, so everything else
// renders its poster with a "playback not supported" notice.
const PLAYABLE_EXTS = new Set([".mp4", ".m4v", ".mov", ".webm"]);

const VIDEO_EXTS = new Set([
	// playable in Chromium
	".mp4",
	".m4v",
	".mov",
	".webm",
	// searchable only (ffmpeg extracts; the lightbox shows the poster)
	".mkv",
	".avi",
	".ts",
	".m2ts",
	".mts",
	".mpg",
	".mpeg",
	".wmv",
	".flv",
	".3gp",
]);

export function isVideoFile(filename: string): boolean {
	const ext = filename.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
	return VIDEO_EXTS.has(ext);
}

export function isPlayableVideoFile(filename: string): boolean {
	const ext = filename.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
	return PLAYABLE_EXTS.has(ext);
}

// Filenames routinely contain URL-significant characters (#, ?, %, spaces,
// …): "[SUB] … EP.49 #한소희_….mp4" would otherwise truncate at "#" (the URL
// fragment), and main would look for a poster named "… EP.49" → 404 tile.
// Encode the path SEGMENT only; the main-process protocol decodes the
// request path exactly once (safeDecode in main/ipc/protocol.ts), so a
// name round-trips byte-for-byte, percent signs included (a literal "%23"
// in a filename encodes to "%2523" and decodes back to "%23").
const enc = (segment: string) => encodeURIComponent(segment);

// Generated at import by the main process into posters/ (posterFor in
// main.js); the URL is derived purely from the filename.
export function posterFor(filename: string): string {
	const stem = filename.replace(/\.[a-z0-9]+$/i, "");
	return `/images/posters/${enc(stem)}.jpg`;
}

// Photo thumbnail: a ~480px JPEG the main process generates lazily into
// thumbs/ on first request (thumbFor in main.js — basename minus extension
// + ".jpg"). The grid renders this instead of the original so camera-size
// files and huge GIFs never cross the wire per tile; the lightbox keeps
// requesting /images/projects/ for full resolution.
export function thumbFor(filename: string): string {
	return `/images/thumbs/${enc(filename)}`;
}

// Full-resolution original in the library (the lightbox img/video src):
// main serves it from photosDir at /images/projects/<filename>. Same
// single-decode contract as the other builders above.
export function projectFor(filename: string): string {
	return `/images/projects/${enc(filename)}`;
}

// The best-scene thumbnail written by the enrichment worker during import
// (<stem>-scene-<poster>.jpg in POSTERS_DIR) — derived from the segment's
// poster index, matching the worker's naming.
export function scenePosterFor(filename: string, poster: number): string {
	const stem = filename.replace(/\.[a-z0-9]+$/i, "");
	return `/images/posters/${enc(stem)}-scene-${poster}.jpg`;
}

// In-app preview proxy for searchable-only videos (main.js /images/preview/):
// a short mp4/h264 clip transcoded on demand around the matched scene time.
// Deterministic per (file, t) so repeat views hit the disk cache.
export function previewFor(filename: string, t: number): string {
	return `/images/preview/${enc(filename)}?t=${Math.max(0, Math.round(t || 0))}`;
}

// "0:03" / "1:24" — shared by the card badge and the lightbox scene chip.
export function formatTimecode(t: number): string {
	const s = Math.max(0, Math.floor(t));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
