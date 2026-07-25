#!/usr/bin/env bash
# Drive the game in a cmux browser surface at a fixed timestep and screenshot it.
# Backgrounded webviews get no requestAnimationFrame, so we step the loop by hand
# via the __kt debug handle instead of waiting on wall-clock frames.
#
# usage: scripts/drive.sh <surface> <out.png> [js-to-run-after-start]
set -euo pipefail
SURFACE="${1:?surface}"
OUT="${2:?out png}"
EXTRA="${3:-}"

cmux browser --surface "$SURFACE" goto "http://localhost:5180/?nolock" >/dev/null
sleep 3
cmux browser --surface "$SURFACE" eval --script "
  const k = window.__kt;
  window.__errs = [];
  addEventListener('error', e => window.__errs.push((e.error && e.error.stack) || e.message));
  document.getElementById('start-btn').click();
  k.step(60);
  ${EXTRA}
  JSON.stringify({ state: k.game.state, errs: window.__errs.slice(0, 3) })
" | tail -2
cmux browser --surface "$SURFACE" screenshot --out "$OUT" >/dev/null
echo "shot -> $OUT"
