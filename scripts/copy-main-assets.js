"use strict";

// Stage A (ts-migration): tsc emits .js/.mjs into dist-main/, but the prod
// trees also carry runtime assets it cannot emit. This script mirrors them
// so the compiled tree is self-contained (both in dev and inside the asar —
// build.files ships dist-main/** only).
//
// Single source for the asset list: test/packaged-files.test.js requires
// ASSETS to keep the coverage guard honest.
//
// Current assets:
//   indexer/text-mean/*.json — shipped text-mean constants; the indexer
//   worker reads them via build-memory-embeddings-core.js
//   textMeanShippedPath() == path.join(__dirname, "text-mean", id) so the
//   copy must land at dist-main/indexer/text-mean/.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "dist-main");

// Directories copied verbatim into the same relative location under
// dist-main/ after tsc runs.
const ASSETS = ["indexer/text-mean"];

function copyMainAssets() {
	for (const rel of ASSETS) {
		const src = path.join(ROOT, rel);
		const dest = path.join(OUT, rel);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.cpSync(src, dest, { recursive: true });
	}
	console.log(`[copy-main-assets] ${ASSETS.length} asset dir(s) → dist-main/`);
}

if (require.main === module) {
	copyMainAssets();
}

module.exports = { ASSETS, copyMainAssets };
