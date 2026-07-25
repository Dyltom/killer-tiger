#!/usr/bin/env bash
# Like drive.sh, but with the post chain off so you can read the raw render.
# usage: scripts/probe.sh <surface> <out.png> [js]
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
  // Shader link failures are silent: WebGL just draws black. Surface them.
  const _ce = console.error;
  console.error = (...a) => { window.__errs.push(String(a[0]).slice(0, 400)); _ce(...a); };
  document.getElementById('start-btn').click();
  k.postfx.godrays.enabled = false;
  k.postfx.bloom.enabled = false;
  k.postfx.grade.enabled = false;
  k.step(30);
  ${EXTRA}
  k.step(2);
  JSON.stringify({ state: k.game.state, errs: window.__errs.slice(0, 3) })
" | tail -2
cmux browser --surface "$SURFACE" screenshot --out "$OUT" >/dev/null
echo "shot -> $OUT"
