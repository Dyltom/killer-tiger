#!/usr/bin/env bash
# Portrait of one member of the cast, framed on the head, in the game's own light.
#
# The cast is only judged well at the size a mesh defect actually shows at, which
# is closer than the game ever puts the camera. Everything happens in a single
# eval: a human that has been posed in one call and photographed in the next
# drifts, because the game keeps simulating between them.
#
# usage: tools/characters/portrait.sh <surface> <mesh-substring> <name> [framing] [hide-re] [model]
#        framing: head | body
#        hide-re: meshes matching this are hidden, to find which one owns a defect
#        model:   dress the first villager in this .glb instead of searching for one
#
# The last argument is what makes the whole cast reviewable. Each pool slot draws
# its body once and keeps it for the run, so with ten villagers alive and four
# bodies to draw from, one of the five is usually nowhere on the map — and a
# character you cannot photograph is a character that ships unlooked-at. Naming a
# model re-dresses somebody who is already standing there.
set -euo pipefail
SURFACE="${1:?surface}"
MATCH="${2:?mesh substring, e.g. bob01}"
NAME="${3:?output name}"
FRAME="${4:-head}"
HIDE="${5:-(?!)}"
MODEL="${6:-}"
W=900
H=900

cmux browser --surface "$SURFACE" eval --script "
  (async () => {
  const k = window.__kt;
  if (k.game.state !== 'playing') { document.getElementById('start-btn').click(); k.step(60, 1/60); }
  const want = '${MODEL}';
  const h = want
    ? k.game.humans.find(x => x.alive && x.avatar && x.kind !== 'hunter')
    : k.game.humans.find(x => x.alive && x.avatar &&
        x.avatar.meshes.some(m => /${MATCH}/i.test(m.name)));
  if (!h) return want ? 'no villager alive to dress' : 'no human matching ${MATCH}';
  // attach() is private to TypeScript and ordinary to the runtime. It caches one
  // body per model name per slot, so this costs a clone the first time and a
  // visibility flip after that, and the slot keeps its position and its gait.
  if (want) { h.villagerModel = want; h.attach('villager'); }
  k.renderer.setSize(${W}, ${H}, false);
  k.camera.aspect = 1;
  k.camera.updateProjectionMatrix();
  k.postfx.setSize(${W}, ${H});
  document.getElementById('hud').style.visibility = 'hidden';
  const hidden = h.avatar.meshes.filter(m => /${HIDE}/i.test(m.name));
  hidden.forEach(m => { m.visible = false });
  // Held still for a second of game time, then turned to face the camera. Both
  // halves are needed: without the hold the subject is photographed mid-stride and
  // mid-air, and without the turn afterwards it is photographed from behind,
  // because Human.animate aims the yaw down the direction of travel and the last
  // step it took still counted. A yaw of zero faces (-sin y, 0, -cos y), i.e.
  // straight down -z, which is where the camera stands.
  for (let i = 0; i < 40; i++) {
    h.alerted = false;
    h.target.copy(h.pos);
    h.vel.set(0, 0, 0);
    k.step(1, 1 / 60);
  }
  h.yaw = 0;
  h.group.rotation.set(0, 0, 0);
  h.body.rotation.set(0, 0, 0);
  h.group.updateMatrixWorld(true);
  const p = h.pos, eye = '${FRAME}' === 'head' ? 1.5 : 0.9, d = '${FRAME}' === 'head' ? 0.8 : 2.6;
  k.camera.position.set(p.x, p.y + eye + 0.05, p.z - d);
  k.camera.lookAt(p.x, p.y + eye, p.z);
  k.camera.updateMatrixWorld(true);
  k.postfx.render(1 / 60, 0, 0, k.sky.day.darkness);
  const data = k.renderer.domElement.toDataURL('image/png');
  hidden.forEach(m => { m.visible = true });
  document.getElementById('hud').style.visibility = '';
  k.renderer.setSize(innerWidth, innerHeight, false);
  k.camera.aspect = innerWidth / innerHeight;
  k.camera.updateProjectionMatrix();
  k.postfx.setSize(innerWidth, innerHeight);
  await fetch('http://127.0.0.1:5191/', { method: 'POST', body: JSON.stringify({ name: '${NAME}', data }) });
  return 'posted ${NAME}  ' + h.avatar.meshes.map(m => m.name).join(',');
  })()
" | tail -1
