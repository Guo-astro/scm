import { expect, test } from "bun:test";
import { posix } from "node:path";
import {
	posterFor,
	thumbFor,
	scenePosterFor,
	previewFor,
	projectFor,
} from "../src/lib/media";

// Media-URL encoding (the "#" tile bug). Filenames are user data: they
// carry "#", "?", "%", spaces, emoji, CJK — all URL-significant. The
// builders must percent-encode the filename SEGMENT so nothing leaks into
// the URL's fragment/query, while the main process decodes the path
// exactly once (safeDecode in main/ipc/protocol.ts) and resolves it to
// the on-disk name byte-for-byte.
//
// Round-trip contract per builder: parse the URL, decode pathname ONCE
// (exactly what main does), compare with the true path. hash must be empty
// and search must hold only the builder's own params.

const BASE = "app://scm";
const once = (url: string) => decodeURIComponent(new URL(url, BASE).pathname);

// The real library regression case (main looked up "… EP.49" → 404 tile).
const KOREAN =
	"[SUB] 차쥐뿔 문 닫으러 온 국가권력급 BOSS✨  [차린건 쥐뿔도 없지만] EP.49 #한소희_20260828_100019.mp4";

// Every entry must survive builder → URL parse → single decode intact.
const HOSTILE = [
	"photo.jpg",
	"my photo.jpg",
	"what?.png",
	"50% off #1.jpg",
	"already%20encoded.jpg",
	"pair (1) [final].mp4",
	"東京 駅 構内.jpg",
	"한소희 #shorts.mp4",
	KOREAN,
];

test("posterFor encodes the stem and round-trips", () => {
	for (const name of HOSTILE) {
		const stem = name.replace(/\.[a-z0-9]+$/i, "");
		const url = posterFor(name);
		expect(once(url)).toBe(`/images/posters/${stem}.jpg`);
		expect(new URL(url, BASE).hash).toBe("");
		expect(new URL(url, BASE).search).toBe("");
	}
	expect(once(posterFor(KOREAN))).toContain("#한소희_20260828_100019.jpg");
	expect(posterFor(KOREAN)).not.toContain("#");
});

test("scenePosterFor encodes the stem, keeps -scene-N literal", () => {
	for (const name of HOSTILE) {
		const stem = name.replace(/\.[a-z0-9]+$/i, "");
		const url = scenePosterFor(name, 196);
		expect(once(url)).toBe(`/images/posters/${stem}-scene-196.jpg`);
		expect(new URL(url, BASE).hash).toBe("");
	}
});

test("thumbFor / projectFor round-trip the full filename", () => {
	for (const name of HOSTILE) {
		expect(once(thumbFor(name))).toBe(`/images/thumbs/${name}`);
		expect(once(projectFor(name))).toBe(`/images/projects/${name}`);
		expect(new URL(thumbFor(name), BASE).hash).toBe("");
		expect(new URL(projectFor(name), BASE).hash).toBe("");
	}
});

test("previewFor keeps ?t= as the only query param", () => {
	for (const name of HOSTILE) {
		const url = previewFor(name, 12.6);
		const parsed = new URL(url, BASE);
		expect(once(url)).toBe(`/images/preview/${name}`);
		expect(parsed.search).toBe("?t=13");
		expect(parsed.searchParams.get("t")).toBe("13");
	}
	// A "?" in the filename must not become a parameter boundary.
	const q = previewFor("what?.mp4", 5);
	expect(new URL(q, BASE).searchParams.get("t")).toBe("5");
	expect(once(q)).toBe("/images/preview/what?.mp4");
});

test("main's decode lands on the exact on-disk basename", () => {
	// Mirror main's /images/posters/ route: decode path → basename → name.
	const url = posterFor(KOREAN);
	const decodedPath = once(url);
	expect(posix.basename(decodedPath)).toBe(KOREAN.replace(/\.mp4$/, ".jpg"));
});
