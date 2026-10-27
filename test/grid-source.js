"use strict";

// Source-scanning wiring tests (grid ↔ hooks ↔ bridge) need the whole grid
// surface, not just MasonryGrid.tsx: the UI is split into the grid container
// plus presentational components under src/components/grid/.
// Reading only MasonryGrid.tsx made the splits look like deleted controls
// (the Dialogue mode pill, the background trays). One helper, so the next
// slice updates a single place.

const fs = require("node:fs");
const path = require("node:path");

const COMPONENTS = path.join(__dirname, "..", "src", "components");

function readGridSource() {
	const parts = [
		fs.readFileSync(path.join(COMPONENTS, "MasonryGrid.tsx"), "utf8"),
	];
	const slices = path.join(COMPONENTS, "grid");
	for (const file of fs.readdirSync(slices).sort()) {
		if (file.endsWith(".tsx")) {
			parts.push(fs.readFileSync(path.join(slices, file), "utf8"));
		}
	}
	return parts.join("\n");
}

module.exports = { readGridSource };
