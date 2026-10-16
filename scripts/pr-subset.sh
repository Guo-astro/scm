#!/usr/bin/env bash
# PR-tier smoke subset (ts-migration plan, Tier 0.3).
#
# The cheapest real-Electron suites that exercise main-process wiring, run
# automatically on every PR that touches main-process paths (see ci.yml's
# `changes` job). The full battery (scripts/smoke-all.sh) stays on main
# pushes / nightly / manual dispatch — macOS runner minutes bill 10x.
#
#   build:  renderer bundle (main-process compile joins here at Stage A)
#   boot:   ELECTRON_SMOKE=1 — boot + protocol + renderer, then quit
#   cto:    prune guard, bin quarantine, atomic saves, sandbox, CSP, rank perf
#   reveal: source → library copy → null resolution (import + verify)
#
# Each suite gets its own scratch MEMORIES_DATA_DIR with the model cache and
# OCR traineddata symlinked in (same convention as smoke-all.sh). A cold
# model cache downloads once; the CI cache below makes later runs warm.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODELS="$HOME/Library/Application Support/scm/models"
OCR_DATA="$HOME/Library/Application Support/scm/ocr-data"
LOG=/tmp/scm-pr-subset.log
: >"$LOG"

FAILED=0
step() { echo ""; echo "=== $1 ===" | tee -a "$LOG"; }

# Fresh temp data dir with the model cache + OCR traineddata symlinked in.
setup_tmp() {
	local prefix="$1"
	local tmp
	tmp="$(mktemp -d "/tmp/${prefix}-XXXX")"
	ln -s "$MODELS" "$tmp/models" 2>/dev/null || true
	mkdir -p "$tmp/ocr-data"
	for f in "$OCR_DATA"/*.traineddata; do
		[ -e "$f" ] || continue
		ln -s "$f" "$tmp/ocr-data/"
	done
	echo "$tmp"
}

# One Electron launch: MEMORIES_DATA_DIR + whatever env flags are passed.
# (Same bash-3.2 env-word workaround as smoke-all.sh.)
electron_run() {
	local tmp="$1"
	shift
	env MEMORIES_DATA_DIR="$tmp" "$@" "$ROOT/node_modules/.bin/electron" . >>"$LOG" 2>&1
	local ok=$?
	tail -6 "$LOG"
	return $ok
}

step "build: renderer bundle"
bun run build >>"$LOG" 2>&1 || { tail -25 "$LOG"; FAILED=1; }

step "electron: boot smoke (boot + protocol + renderer)"
TMP_BOOT="$(setup_tmp scm-pr-boot)"
electron_run "$TMP_BOOT" ELECTRON_SMOKE=1 || { tail -25 "$LOG"; FAILED=1; }

step "electron: cto — prune guard, bin quarantine, atomic saves, sandbox, CSP"
TMP_CTO="$(setup_tmp scm-pr-cto)"
electron_run "$TMP_CTO" ELECTRON_SMOKE=1 ELECTRON_SMOKE_CTO=1 || { tail -25 "$LOG"; FAILED=1; }

step "electron: reveal-target resolution (source → copy → null)"
TMP_REVEAL="$(setup_tmp scm-pr-reveal)"
REVEAL_DIR="$(mktemp -d /tmp/scm-pr-reveal-src-XXXX)"
electron_run "$TMP_REVEAL" ELECTRON_SMOKE_REVEAL=import REVEAL_TEST_DIR="$REVEAL_DIR" || { tail -25 "$LOG"; FAILED=1; }
mv "$REVEAL_DIR/source/fallback-test.jpg" "$REVEAL_DIR/source/moved-away.jpg"
electron_run "$TMP_REVEAL" ELECTRON_SMOKE_REVEAL=verify REVEAL_TEST_DIR="$REVEAL_DIR" || { tail -25 "$LOG"; FAILED=1; }

# Stage A linchpin: the packaged asar boot. Runs the real electron-builder
# --dir layout (unsigned, local electronDist) and launches the packaged
# binary with a scratch data dir — this is the only check that the shipped
# dist-main/ entry, preload emission, copied assets, and require(esm)
# inside the asar all resolve.
step "package: electron-builder --dir (unsigned)"
CSC_IDENTITY_AUTO_DISCOVERY=false bunx electron-builder --mac --dir >>"$LOG" 2>&1 || { tail -30 "$LOG"; FAILED=1; }

step "packaged: boot smoke from the asar (dist-main entry)"
TMP_PKG="$(setup_tmp scm-pr-pkg)"
APP_BIN="$(ls -d "$ROOT"/dist-app/mac*/SCM.app/Contents/MacOS/SCM 2>/dev/null | head -1)"
if [ -n "$APP_BIN" ]; then
	env MEMORIES_DATA_DIR="$TMP_PKG" ELECTRON_SMOKE=1 "$APP_BIN" >>"$LOG" 2>&1
	ok=$?
	tail -6 "$LOG"
	[ "$ok" -eq 0 ] || { tail -25 "$LOG"; FAILED=1; }
else
	echo "packaged app not found under dist-app/ — electron-builder --dir failed?" | tee -a "$LOG"
	FAILED=1
fi

echo "" | tee -a "$LOG"
if [ "$FAILED" -eq 0 ]; then
	echo "PR SUBSET PASSED — full log: $LOG" | tee -a "$LOG"
else
	echo "PR SUBSET FAILED — full log: $LOG" | tee -a "$LOG"
	exit 1
fi
