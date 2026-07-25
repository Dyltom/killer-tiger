#!/usr/bin/env bash
# Screenshot the world from one spot at several headings, and report frame cost.
# The tiger is topped up every step so hunters can't end the run mid-tour and
# leave the near-death grade over every shot.
#
# usage: scripts/tour.sh <surface> <out-prefix> [pitch-px]
set -euo pipefail
SURFACE="${1:?surface}"
PREFIX="${2:?out prefix}"
PITCH="${3:-0}"

cmux browser --surface "$SURFACE" goto "http://localhost:5180/?nolock" >/dev/null
sleep 3
cmux browser --surface "$SURFACE" eval --script "
  const k = window.__kt;
  document.getElementById('start-btn').click();
  window.__hold = () => { k.game.tiger.health = 100; k.step(1); };
  for (let i = 0; i < 30; i++) window.__hold();
  k.look(0, ${PITCH});
  'ok'
" >/dev/null

for i in 0 1 2 3; do
  cmux browser --surface "$SURFACE" eval --script "
    const k = window.__kt;
    if (${i} > 0) k.look(Math.PI / 2 / 0.0022);
    for (let n = 0; n < 4; n++) window.__hold();
    // Frame cost, measured on the real loop rather than rAF (which the headless
    // browser throttles). Draw calls matter as much as the number here.
    const t0 = performance.now();
    for (let n = 0; n < 20; n++) window.__hold();
    const ms = (performance.now() - t0) / 20;
    JSON.stringify({ heading: ${i}, ms: +ms.toFixed(2), calls: k.renderer.info.render.calls, tris: k.renderer.info.render.triangles })
  " | tail -1
  cmux browser --surface "$SURFACE" screenshot --out "${PREFIX}-${i}.png" >/dev/null
  echo "shot -> ${PREFIX}-${i}.png"
done
