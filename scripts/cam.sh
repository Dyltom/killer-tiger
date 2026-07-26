#!/usr/bin/env bash
# Screenshot from an arbitrary camera, not from behind the tiger.
#
# scripts/shot.sh poses the *tiger* and lets the game place the camera, which is
# the right way round for judging the model and the wrong way round for judging a
# building you want to stand inside. Here the frame is stepped first and the
# camera moved afterwards, so the pose is the last word on where it is.
#
# The pose JS runs with `k`, `cam` and `world` in scope, after the step.
#
# usage: scripts/cam.sh <surface> <name> <pose-js> [width] [height]
set -euo pipefail
SURFACE="${1:?surface}"
NAME="${2:?name}"
POSE="${3:-}"
W="${4:-1400}"
H="${5:-900}"

cmux browser --surface "$SURFACE" eval --script "
  (async () => {
  const k = window.__kt;
  if (k.game.state !== 'playing') { document.getElementById('start-btn').click(); k.step(30); }
  const world = k.world, cam = k.camera;
  k.renderer.setSize(${W}, ${H}, false);
  k.camera.aspect = ${W} / ${H};
  k.camera.updateProjectionMatrix();
  k.postfx.setSize(${W}, ${H});
  document.getElementById('hud').style.visibility = 'hidden';
  k.game.tiger.health = 100;
  k.step(1);
  ${POSE}
  cam.updateMatrixWorld(true);
  k.postfx.render(1 / 60, 0, 0, k.sky.day.darkness);
  const data = k.renderer.domElement.toDataURL('image/png');
  document.getElementById('hud').style.visibility = '';
  k.renderer.setSize(innerWidth, innerHeight, false);
  k.camera.aspect = innerWidth / innerHeight;
  k.camera.updateProjectionMatrix();
  k.postfx.setSize(innerWidth, innerHeight);
  await fetch('http://127.0.0.1:5191/', { method: 'POST', body: JSON.stringify({ name: '${NAME}', data }) });
  return 'posted ${NAME}'
  })()
" | tail -1
