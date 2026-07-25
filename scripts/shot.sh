#!/usr/bin/env bash
# Render one frame at a size of our choosing and post it to scripts/shotd.mjs.
#
# The pose JS runs with `k` (the debug handle), `t` (the tiger) and `humans` in
# scope, and is expected to leave the camera where it wants the shot from.
#
# usage: scripts/shot.sh <surface> <name> <pose-js> [width] [height]
set -euo pipefail
SURFACE="${1:?surface}"
NAME="${2:?name}"
POSE="${3:-}"
W="${4:-1280}"
H="${5:-900}"

cmux browser --surface "$SURFACE" eval --script "
  (async () => {
  const k = window.__kt;
  if (k.game.state !== 'playing') { document.getElementById('start-btn').click(); k.step(30); }
  const t = k.game.tiger;
  const humans = k.game.humans;
  ${POSE}
  // Render at our size, not the pane's, and with the HUD out of the way.
  k.renderer.setSize(${W}, ${H}, false);
  k.camera.aspect = ${W} / ${H};
  k.camera.updateProjectionMatrix();
  k.postfx.setSize(${W}, ${H});
  document.getElementById('hud').style.visibility = 'hidden';
  k.step(1);
  const data = k.renderer.domElement.toDataURL('image/png');
  document.getElementById('hud').style.visibility = '';
  k.renderer.setSize(innerWidth, innerHeight, false);
  k.camera.aspect = innerWidth / innerHeight;
  k.camera.updateProjectionMatrix();
  k.postfx.setSize(innerWidth, innerHeight);
  await fetch('http://127.0.0.1:5191/', {
    method: 'POST',
    body: JSON.stringify({ name: '${NAME}', data }),
  });
  return 'posted ${NAME}'
  })()
" | tail -1
