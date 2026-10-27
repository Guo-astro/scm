import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

// sharp decode regression suite (bump 0.33.4 → 0.35.5).
//
// sharp is the one native dependency that parses untrusted files from the
// user's disk (import, thumbnails, OCR, embeddings, migration), so a version
// bump is only safe if the exact call shapes the app uses still behave:
//
//   - embedding decode: sharp(file, { animated: false, limitInputPixels:
//     false }).resize(n, n, { fit: "inside", withoutEnlargement: true }).raw()
//     (indexer/build-memory-embeddings-core.ts)
//   - thumbnails: .rotate().resize({ width, withoutEnlargement: true })
//     .jpeg({ quality: 82 }) (main/ipc/protocol.ts)
//   - OCR normalize: .resize({ 2400, 2400, fit: "inside",
//     withoutEnlargement: true }).png() (indexer/ocr-worker.ts)
//   - raw video frames: sharp(rgb, { raw: { width, height, channels } })
//     (the poster/frame path in indexer/indexer.ts)
//
// Fixtures are generated in a temp dir rather than checked in: no binary
// assets, and the image content is defined next to the assertion. These
// mirror the production option objects on purpose — if one of those call
// sites changes, update this file in the same commit.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scm-sharp-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const WIDE = path.join(tmp, "wide.jpg");
const TAGGED = path.join(tmp, "tagged.jpg");
const PNG = path.join(tmp, "pixel.png");
const WEBP = path.join(tmp, "pixel.webp");

async function makeFixtures() {
	await sharp({
		create: {
			width: 1920,
			height: 1080,
			channels: 3,
			background: { r: 20, g: 120, b: 200 },
		},
	})
		.jpeg({ quality: 90 })
		.toFile(WIDE);

	// Orientation 6 = "rotate 90° clockwise on display": the stored frame is
	// 40x20, the displayed photo is 20x40.
	await sharp({
		create: {
			width: 40,
			height: 20,
			channels: 3,
			background: { r: 240, g: 240, b: 240 },
		},
	})
		.withMetadata({ orientation: 6 })
		.jpeg({ quality: 90 })
		.toFile(TAGGED);

	const pixel = await sharp({
		create: {
			width: 64,
			height: 48,
			channels: 3,
			background: { r: 10, g: 200, b: 30 },
		},
	})
		.png()
		.toBuffer();
	fs.writeFileSync(PNG, pixel);
	fs.writeFileSync(WEBP, await sharp(PNG).webp().toBuffer());
}

// One setup promise, awaited by every test, so ordering never matters.
const ready = makeFixtures();

test("metadata reads format, dimensions and channels", async () => {
	await ready;
	const meta = await sharp(WIDE).metadata();
	expect(meta.format).toBe("jpeg");
	expect(meta.width).toBe(1920);
	expect(meta.height).toBe(1080);
	expect(meta.channels).toBe(3);
});

test("embedding decode: inside-fit resize preserves aspect and never crops", async () => {
	await ready;
	const { data, info } = await sharp(WIDE, {
		animated: false,
		limitInputPixels: false,
	})
		.resize(224, 224, { fit: "inside", withoutEnlargement: true })
		.raw()
		.toBuffer({ resolveWithObject: true });

	// 1920x1080 → 224x126 at 3 channels; the CLIP processor does the crop.
	expect(info.width).toBe(224);
	expect(info.height).toBe(126);
	expect(info.channels).toBe(3);
	expect(data.byteLength).toBe(info.width * info.height * info.channels);
});

test("embedding decode of a raw frame round-trips the exact bytes", async () => {
	// 3x2 RGB with a distinct value per pixel: any channel-order or stride
	// change shows up as a byte mismatch, not a plausible-looking resize.
	const bytes = Buffer.from([
		1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
	]);
	const { data, info } = await sharp(bytes, {
		raw: { width: 3, height: 2, channels: 3 },
		limitInputPixels: false,
	})
		.resize(4, 4, { fit: "inside", withoutEnlargement: true })
		.raw()
		.toBuffer({ resolveWithObject: true });

	// withoutEnlargement keeps 3x2, so this is a pure decode, not a resample.
	expect(info.width).toBe(3);
	expect(info.height).toBe(2);
	expect(info.channels).toBe(3);
	expect(Buffer.compare(data, bytes)).toBe(0);
});

test("thumbnail: .rotate() honors EXIF orientation, width caps, output is JPEG", async () => {
	await ready;
	const out = path.join(tmp, "thumb.jpg");

	// Production shape (main/ipc/protocol.ts).
	await sharp(TAGGED)
		.rotate()
		.resize({ width: 32, withoutEnlargement: true })
		.jpeg({ quality: 82 })
		.toFile(out);

	const meta = await sharp(out).metadata();
	// Orientation 6 swaps the stored 40x20 into a displayed 20x40; the
	// output is not upscaled past its 20px width.
	expect(meta.format).toBe("jpeg");
	expect(meta.width).toBe(20);
	expect(meta.height).toBe(40);
	// The tag is applied, not carried into the output (no double-rotation
	// when the renderer displays the thumbnail).
	expect(meta.orientation ?? 1).toBe(1);
});

test("OCR normalize: 2400 inside-fit does not upscale a 1920px photo", async () => {
	await ready;
	const { data, info } = await sharp(WIDE)
		.resize({
			width: 2400,
			height: 2400,
			fit: "inside",
			withoutEnlargement: true,
		})
		.png()
		.toBuffer({ resolveWithObject: true });

	expect(info.format).toBe("png");
	expect(info.width).toBe(1920);
	expect(info.height).toBe(1080);
	// A PNG signature: the OCR worker feeds these bytes straight to tesseract.
	expect(data.subarray(0, 4).toString("hex")).toBe("89504e47");
});

test("webp and png decode (library formats outside the JPEG path)", async () => {
	await ready;
	const png = await sharp(PNG).metadata();
	const webp = await sharp(WEBP).metadata();
	expect(png.format).toBe("png");
	expect(png.width).toBe(64);
	expect(png.height).toBe(48);
	expect(webp.format).toBe("webp");
	expect(webp.width).toBe(64);
	expect(webp.height).toBe(48);
});

test("a static image reports no extra pages (GIF page math falls back to 1)", async () => {
	await ready;
	const meta = await sharp(PNG, {
		animated: true,
		limitInputPixels: false,
	}).metadata();
	// Production reads `meta.pages ?? 1`.
	expect(meta.pages ?? 1).toBe(1);
});

test("undecodable input rejects (the OCR path swallows this)", async () => {
	await expect(sharp(Buffer.from("not an image")).metadata()).rejects.toThrow();
});
