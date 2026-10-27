"use strict";

// Source-scanning wiring tests (Settings ↔ bridge ↔ store) need the whole
// Settings surface, not just the sheet: the UI is split into the sheet
// chrome plus one component per section under src/components/settings/.
// Reading only SettingsSheet.tsx made the section splits look like deleted
// controls (the re-read button, the speech radios, the speech-index note).
// One helper, so the next split updates a single place.

const fs = require("node:fs");
const path = require("node:path");

const COMPONENTS = path.join(__dirname, "..", "src", "components");

function readSettingsSource() {
	const parts = [
		fs.readFileSync(path.join(COMPONENTS, "SettingsSheet.tsx"), "utf8"),
	];
	const sections = path.join(COMPONENTS, "settings");
	for (const file of fs.readdirSync(sections).sort()) {
		if (file.endsWith(".tsx")) {
			parts.push(fs.readFileSync(path.join(sections, file), "utf8"));
		}
	}
	return parts.join("\n");
}

module.exports = { readSettingsSource };
