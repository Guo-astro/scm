// YouTube video agent core (feat/youtube-agent).
// Pure helpers + settings IO for yt-dlp downloads. No electron dependency:
// plain-node unit tested. The main process owns spawning; the renderer owns
// interest matching (saved searches with watch:true) over indexed rows.
//
// Storage:
//   <userData>/library/youtube-staging/   download scratch (yt-dlp writes here)
//   <userData>/library/youtube.json       videoId -> { filename, channel, ... }
// Settings live under settings.json `youtube` key (see DEFAULT_CONFIG).
//
// Stage B (ts-migration): converted .js → .ts (the last unconverted Node
// module), import/export syntax, and tsc-checked (dist-main still emits
// CJS). The parser/argv/meta boundaries take `unknown` on purpose: their
// inputs are hand-edited settings.json rows, yt-dlp JSON and on-disk
// filenames, so validation stays here instead of trusting a caller cast.

import fs from "node:fs";
import path from "node:path";

export const YTDLP_PINNED_VERSION = "2026.08.19";
export const YTDLP_RELEASE_BASE =
	"https://github.com/yt-dlp/yt-dlp/releases/download";

export type YoutubeQuality = "480p" | "720p" | "1080p";

export interface YoutubeChannelConfig {
	url: string;
	kind: "channel" | "playlist";
	label: string;
	lastSync: string | null;
}

export interface YoutubeConfig {
	enabled: boolean;
	ytDlpVersion: string;
	quality: YoutubeQuality;
	maxPerChannel: number;
	pollHours: number;
	storageCapGB: number;
	channels: YoutubeChannelConfig[];
}

export type ParsedYoutubeInput =
	| { kind: "video"; url: string; id: string }
	| { kind: "channel"; url: string }
	| { kind: "playlist"; url: string }
	| { kind: "unknown"; url: string };

export interface YoutubeMetaEntry {
	filename: string;
	channel: string | null;
	pageUrl: string | null;
	title: string | null;
	downloadedAt: string;
}

/** youtube.json rows. Entries are hand-editable and repaired best-effort,
 *  so fields are optional: readers must narrow before use. */
export type YoutubeMeta = Record<string, Partial<YoutubeMetaEntry>>;

export const QUALITY_HEIGHT: Record<YoutubeQuality, number> = {
	"480p": 480,
	"720p": 720,
	"1080p": 1080,
};

// v1 defaults: 720p keeps scene/Whisper costs near the Balanced preset;
// backfill is capped so adding a big channel never floods the library.
export const DEFAULT_CONFIG: YoutubeConfig = {
	enabled: true,
	ytDlpVersion: YTDLP_PINNED_VERSION,
	quality: "720p",
	maxPerChannel: 20,
	pollHours: 6,
	storageCapGB: 20,
	channels: [],
};

function isYoutubeQuality(raw: string): raw is YoutubeQuality {
	// hasOwnProperty, not `in`: a hand-edited "toString" quality must not
	// resolve through the prototype chain.
	return Object.prototype.hasOwnProperty.call(QUALITY_HEIGHT, raw);
}

export function parseQuality(raw: unknown): YoutubeQuality {
	if (typeof raw === "string" && isYoutubeQuality(raw)) return raw;
	return DEFAULT_CONFIG.quality;
}

export function heightForQuality(q: unknown): number {
	return QUALITY_HEIGHT[parseQuality(q)];
}

// settings.json IO delegates to main-lib/settings.js (injected root via
// initYoutube). Kept here so main.js never hand-rolls the youtube key shape.
let USER_DATA_DIR: string | null = null;

export function initYoutube({ userDataDir }: { userDataDir: string }): void {
	USER_DATA_DIR = userDataDir;
}

/** Storage root; every path helper funnels through here so the "not
 *  initialized" contract is stated once (main.ts inits at boot). */
function storageRoot(): string {
	if (!USER_DATA_DIR) throw new Error("youtube: initYoutube() not called");
	return USER_DATA_DIR;
}

export function stagingDir(): string {
	return path.join(storageRoot(), "library", "youtube-staging");
}

export function metaFile(): string {
	return path.join(storageRoot(), "library", "youtube.json");
}

export function binDir(): string {
	return path.join(storageRoot(), "bin");
}

export function binPath(): string {
	return path.join(binDir(), "yt-dlp");
}

export function parseYoutubeConfig(raw: unknown): YoutubeConfig {
	const out: YoutubeConfig = { ...DEFAULT_CONFIG, channels: [] };
	if (!raw || typeof raw !== "object") return out;
	const src = raw as Record<string, unknown>;
	if (typeof src.enabled === "boolean") out.enabled = src.enabled;
	if (typeof src.ytDlpVersion === "string" && src.ytDlpVersion)
		out.ytDlpVersion = src.ytDlpVersion;
	out.quality = parseQuality(src.quality);
	if (Number.isFinite(Number(src.maxPerChannel))) {
		out.maxPerChannel = Math.min(
			200,
			Math.max(1, Math.floor(Number(src.maxPerChannel))),
		);
	}
	if (Number.isFinite(Number(src.pollHours))) {
		out.pollHours = Math.min(168, Math.max(1, Number(src.pollHours)));
	}
	if (Number.isFinite(Number(src.storageCapGB))) {
		out.storageCapGB = Math.min(500, Math.max(1, Number(src.storageCapGB)));
	}
	if (Array.isArray(src.channels)) {
		for (const c of src.channels) {
			if (!c || typeof c !== "object") continue;
			const chan = c as Record<string, unknown>;
			if (typeof chan.url !== "string" || !chan.url.trim()) continue;
			const url = chan.url.trim();
			// Subscriptions are channels AND playlists (tracked the same way:
			// each sync pulls the newest N, archive-skipped). Kind persists
			// so the poll timer re-enqueues the right job shape.
			let kind: "channel" | "playlist";
			if (chan.kind === "channel" || chan.kind === "playlist") {
				kind = chan.kind;
			} else {
				const parsed = parseYouTubeInput(url);
				kind =
					parsed.kind === "channel" || parsed.kind === "playlist"
						? parsed.kind
						: "channel";
			}
			out.channels.push({
				url,
				kind,
				label:
					typeof chan.label === "string" && chan.label.trim()
						? chan.label.trim().slice(0, 120)
						: url,
				lastSync: typeof chan.lastSync === "string" ? chan.lastSync : null,
			});
		}
	}
	return out;
}

export function readYoutubeConfig(
	readSettings: () => Record<string, unknown>,
): YoutubeConfig {
	try {
		return parseYoutubeConfig(readSettings().youtube);
	} catch {
		return parseYoutubeConfig(null);
	}
}

// ---------------------------------------------------------------------------
// URL parsing (pure, unit-tested)
// ---------------------------------------------------------------------------

export function parseYouTubeInput(input: unknown): ParsedYoutubeInput {
	if (typeof input !== "string" || !input.trim())
		return { kind: "unknown", url: "" };
	const url = input.trim();
	let u: URL;
	try {
		// Bare handles / video ids are common paste shapes; normalize to URLs.
		if (/^@[\w._-]{1,64}$/.test(url)) {
			return { kind: "channel", url: `https://www.youtube.com/${url}` };
		}
		if (/^[\w-]{11}$/.test(url) && !url.includes(".") && !url.includes("/")) {
			return {
				kind: "video",
				url: `https://www.youtube.com/watch?v=${url}`,
				id: url,
			};
		}
		u = new URL(url);
	} catch {
		return { kind: "unknown", url };
	}
	const host = u.hostname.replace(/^www\.|^m\.|^music\./, "");
	if (
		host !== "youtube.com" &&
		host !== "youtu.be" &&
		host !== "youtube-nocookie.com"
	) {
		return { kind: "unknown", url };
	}
	if (host === "youtu.be") {
		const id = u.pathname.split("/").filter(Boolean)[0];
		if (id) return { kind: "video", url, id };
		return { kind: "unknown", url };
	}
	const p = u.pathname;
	const watchId = u.searchParams.get("v");
	if (p === "/watch" && watchId) {
		return { kind: "video", url, id: watchId };
	}
	if (p.startsWith("/shorts/")) {
		const id = p.split("/")[2];
		if (id) return { kind: "video", url, id };
	}
	if (p.startsWith("/live/")) {
		const id = p.split("/")[2];
		if (id) return { kind: "video", url, id };
	}
	if (
		p.startsWith("/@") ||
		p.startsWith("/c/") ||
		p.startsWith("/channel/") ||
		p.startsWith("/user/") ||
		p.endsWith("/videos") ||
		p.endsWith("/streams")
	) {
		return { kind: "channel", url };
	}
	// Real playlists only: /playlist without a list= param names no list,
	// and /results (search pages) + /feed/* are not stable sync sources.
	if (p === "/playlist") {
		if (u.searchParams.get("list")) return { kind: "playlist", url };
		return { kind: "unknown", url };
	}
	if (p === "/results" || p.startsWith("/feed/")) {
		return { kind: "unknown", url };
	}
	// Default ambiguous youtube.com URL to channel (subscription intent).
	if (p === "/" || p === "") return { kind: "channel", url };
	return { kind: "unknown", url };
}

// ---------------------------------------------------------------------------
// yt-dlp argv builders (pure, unit-tested). Callers spawn the resolved
// binary with these args; stdout JSON lines are parsed by main.js.
// ---------------------------------------------------------------------------

export function formatSelectorFor(quality: unknown): string {
	const h = heightForQuality(quality);
	return (
		`bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/` +
		`bv*[height<=${h}]+ba/` +
		`b[height<=${h}][ext=mp4]/b[height<=${h}]/b`
	);
}

export function outputTemplateFor(destDir: string): string {
	// Channel + id prefix keeps renames stable and dedupe-friendly:
	// "[uploader] title [id].mp4". Restrict-filenames off (SCM handles unicode).
	return path.join(destDir, "%(uploader)s - %(title)s [%(id)s].%(ext)s");
}

export interface VideoArgsOptions {
	url: string;
	destDir: string;
	quality?: unknown;
	archiveFile?: string | null;
	ffmpegLocation?: string | null;
}

export interface ListArgsOptions extends VideoArgsOptions {
	max?: number;
}

// Single video download. Returns argv (without the binary).
// ffmpegLocation (optional): passed as --ffmpeg-location so yt-dlp can
// merge the separate video+audio streams even when ffmpeg is not on the
// GUI process PATH (packaged app launched from Finder). Without it yt-dlp
// leaves behind unmerged .fXXX.mp4 video-only intermediates, which import
// as silent videos with zero transcript chunks (dialogue search empty).
export function buildVideoArgs({
	url,
	destDir,
	quality,
	archiveFile,
	ffmpegLocation,
}: VideoArgsOptions): string[] {
	const args = [
		"--no-playlist",
		"--merge-output-format",
		"mp4",
		"-f",
		formatSelectorFor(quality),
		"--write-info-json",
		"--no-write-playlist-metafiles",
		"--no-progress",
		"--concurrent-fragments",
		"4",
		"-o",
		outputTemplateFor(destDir),
	];
	if (ffmpegLocation) {
		args.push("--ffmpeg-location", ffmpegLocation);
	}
	if (archiveFile) {
		args.push("--download-archive", archiveFile);
	}
	args.push(url);
	return args;
}

// List sync (channels + playlists): newest-first, capped,
// archive-skipped. --break-match-filter would abort the whole run on first
// archived item for --newest feeds; --max-downloads is the simpler bound
// for v1. Channels and playlists share the shape — both are multi-item
// feeds, and the archive file dedupes across them by video id.
export function buildListArgs({
	url,
	destDir,
	quality,
	archiveFile,
	max,
	ffmpegLocation,
}: ListArgsOptions): string[] {
	const args = [
		"--merge-output-format",
		"mp4",
		"-f",
		formatSelectorFor(quality),
		"--write-info-json",
		"--no-write-playlist-metafiles",
		"--no-progress",
		"--concurrent-fragments",
		"4",
		"--playlist-end",
		String(Math.min(200, Math.max(1, max || DEFAULT_CONFIG.maxPerChannel))),
		"-o",
		outputTemplateFor(destDir),
	];
	if (ffmpegLocation) {
		args.push("--ffmpeg-location", ffmpegLocation);
	}
	if (archiveFile) {
		args.push("--download-archive", archiveFile);
	}
	args.push(url);
	return args;
}

export function buildChannelArgs(opts: ListArgsOptions): string[] {
	return buildListArgs(opts);
}

export function buildPlaylistArgs(opts: ListArgsOptions): string[] {
	return buildListArgs(opts);
}

export function archiveFileFor(destDir: string): string {
	return path.join(destDir, ".yt-dlp-archive.txt");
}

// youtube.json helpers (videoId -> metadata). Best-effort; a corrupt file
// resets to {} rather than blocking imports.
export function loadYoutubeMeta(): YoutubeMeta {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(metaFile(), "utf-8"));
		if (raw && typeof raw === "object") return raw as YoutubeMeta;
		return {};
	} catch {
		return {};
	}
}

export function saveYoutubeMeta(meta: YoutubeMeta): void {
	try {
		fs.mkdirSync(path.dirname(metaFile()), { recursive: true });
		const tmp = `${metaFile()}.tmp-${process.pid}-${Date.now()}`;
		fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
		fs.renameSync(tmp, metaFile());
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`[youtube] meta save failed: ${message}`);
	}
}

export interface RecordYoutubeFileOptions {
	videoId: string | null | undefined;
	filename: string | null | undefined;
	channel?: string | null;
	pageUrl?: string | null;
	title?: string | null;
}

export function recordYoutubeFile({
	videoId,
	filename,
	channel,
	pageUrl,
	title,
}: RecordYoutubeFileOptions): void {
	if (!videoId || !filename) return;
	const meta = loadYoutubeMeta();
	meta[videoId] = {
		filename,
		channel: channel || null,
		pageUrl: pageUrl || null,
		title: title || null,
		downloadedAt: new Date().toISOString(),
	};
	saveYoutubeMeta(meta);
}

export function youtubeFilenames(): string[] {
	const meta = loadYoutubeMeta();
	const out: string[] = [];
	for (const v of Object.values(meta)) {
		if (v && typeof v.filename === "string") out.push(v.filename);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Staging-file helpers: yt-dlp writes merged output as
// "<uploader> - <title> [<id>].mp4" but its pre-merge intermediates keep the
// format suffix ("... [<id>].f398.mp4" video-only + "... [<id>].f140.m4a"
// audio). A naive strip-one-extension lookup ("... [<id>].f398.info.json")
// misses the real sibling ("... [<id>].info.json"), so youtube.json was
// never written for unmerged downloads and the YouTube tab stayed empty.
// ---------------------------------------------------------------------------

function basenameOf(filename: unknown): string {
	return (
		String(filename || "")
			.split(/[/\\]/)
			.pop() ?? ""
	);
}

// True for yt-dlp pre-merge intermediate streams ("... [id].f398.mp4",
// "... [id].f140-10.m4a"). Final merged files ("... [id].mp4") return false.
export function isIntermediateStreamFile(filename: unknown): boolean {
	return /\.f\d+[^/]*\.(mp4|m4a|webm|mkv|m4v|opus|mp3)$/i.test(
		basenameOf(filename),
	);
}

// Extract the 11-char YouTube video id from a staged filename's "[id]"
// suffix (the output template always embeds it). Null when absent.
export function videoIdFromFilename(filename: unknown): string | null {
	const m = basenameOf(filename).match(/\[([A-Za-z0-9_-]{11})\]/);
	return m?.[1] ?? null;
}

// Resolve the sibling .info.json for a staged download, handling both the
// merged shape ("... [id].mp4" -> "... [id].info.json") and the
// intermediate shape ("... [id].f398.mp4" -> "... [id].info.json").
// Tries (1) strip-one-extension + .info.json, (2) strip the .fXXX stream
// suffix + .info.json, (3) any "<prefix> [id].info.json" in destDir.
// Returns the absolute path or null.
export function findInfoJsonFor(
	stagingFile: string,
	destDir?: string | null,
): string | null {
	try {
		const base = String(stagingFile).replace(/\.[^.]+$/, "");
		const direct = `${base}.info.json`;
		if (fs.existsSync(direct)) return direct;
		const stripped = String(stagingFile).replace(
			/\.f\d+[^.]*(\.[^.]+)$/,
			".info.json",
		);
		if (stripped !== stagingFile && fs.existsSync(stripped)) return stripped;
		const id = videoIdFromFilename(stagingFile);
		if (id && destDir) {
			try {
				for (const entry of fs.readdirSync(destDir)) {
					if (entry.endsWith(`[${id}].info.json`)) {
						const full = path.join(destDir, entry);
						try {
							if (fs.statSync(full).isFile()) return full;
						} catch {
							/* next */
						}
					}
				}
			} catch {
				/* destDir unreadable */
			}
		}
	} catch {
		/* best-effort */
	}
	return null;
}
