#!/usr/bin/env bash
# Full test: build, install+smoke the zip via foundry-test, then run the Playwright suite (fake mic via Chromium flags).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; MOD="$(dirname "$HERE")"; FT="${FT:-$MOD/../foundry-test}"
"$MOD/build.sh" >/dev/null
"$FT/tests/test-module.sh" "$MOD/dist/module.zip"
FOUNDRY_TESTS="$FT/tests" node "$HERE/npc-voice.test.mjs"
