/**
 * Headless continuity check for every player animation state.
 *
 * Drives the real Tiger.update() at 60 fps through each state and every
 * transition between them — walk, sprint, stop, crouch, pounce and landing,
 * swipe standing and on the run, bite, attack clicked over attack, roar,
 * death — and measures, frame to frame, how far the camera and each paw
 * moved. A discontinuity ("the paws teleport", "the camera cuts") shows up
 * here as a single-frame step far above what any legitimate motion produces.
 * The fastest honest movers, measured by this same script: the swipe drive
 * peaks at 27 m/s on the contact frame (0.45 m/frame — the drive crosses
 * 1.3 m in 0.095 s, fastest at the end by design), and a pounce launched at
 * sprint carries the camera at 29 m/s (0.49 m/frame). The thresholds sit just
 * above those; the bugs this exists to catch were metre-scale single-frame
 * steps, e.g. the paws snapping from the bite clamp to the gait.
 *
 * Run: npx tsx scripts/anim-continuity.ts
 */
// The viewmodel paints its fur grain onto a 2d canvas at build time. Poses
// don't depend on the pixels, so headless the canvas can be a no-op recorder.
;(globalThis as Record<string, unknown>).document ??= {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () =>
      new Proxy({}, { get: () => () => undefined, set: () => true }),
  }),
}

import * as THREE from 'three'
import { Tiger } from '../src/entities/tiger'
import type { World } from '../src/world/world'
import type { Input } from '../src/engine/input'

const DT = 1 / 60
const PAW_LIMIT = 0.6    // m per frame, shoulder space; the strike peaks at 0.45
const CAM_LIMIT = 0.7    // m per frame, world space; a sprint pounce peaks at 0.49
const ROT_LIMIT = 0.30   // rad per frame on the camera

// The tiger only asks the world two things; flat open ground answers both.
const world = {
  resolve: (x: number, z: number) => ({ x, z, hit: false }),
  inGrass: () => false,
} as unknown as World

class FakeInput {
  mouseDX = 0
  mouseDY = 0
  axis = { x: 0, z: 0 }
  heldSet = new Set<string>()
  pressedSet = new Set<string>()
  c0 = false
  c1 = false
  moveAxis() { return this.axis }
  held(c: string) { return this.heldSet.has(c) }
  pressed(c: string) { return this.pressedSet.has(c) }
  clickedPrimary() { const v = this.c0; this.c0 = false; return v }
  clickedSecondary() { const v = this.c1; this.c1 = false; return v }
}

const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 100)
const tiger = new Tiger(camera, world)
const input = new FakeInput()
const t = tiger as unknown as {
  pawL: THREE.Group
  pawR: THREE.Group
  chest: THREE.Mesh
  health: number
}

type Snap = { cam: THREE.Vector3; rot: THREE.Euler; pawL: THREE.Vector3; pawR: THREE.Vector3 }
const snap = (): Snap => ({
  cam: camera.position.clone(),
  rot: camera.rotation.clone(),
  pawL: t.pawL.position.clone(),
  pawR: t.pawR.position.clone(),
})

let failures = 0

/** Step `seconds`, with a per-frame driver, and record the worst frame. */
function run(name: string, seconds: number, drive?: (frame: number) => void) {
  let prev = snap()
  let worstCam = 0, worstPaw = 0, worstRot = 0
  const frames = Math.round(seconds / DT)
  for (let i = 0; i < frames; i++) {
    drive?.(i)
    tiger.update(DT, input as unknown as Input, true)
    input.pressedSet.clear()
    const now = snap()
    worstCam = Math.max(worstCam, now.cam.distanceTo(prev.cam))
    worstPaw = Math.max(
      worstPaw,
      now.pawL.distanceTo(prev.pawL),
      now.pawR.distanceTo(prev.pawR),
    )
    worstRot = Math.max(
      worstRot,
      Math.abs(now.rot.x - prev.rot.x),
      Math.abs(now.rot.z - prev.rot.z),
    )
    prev = now
  }
  const bad = worstCam > CAM_LIMIT || worstPaw > PAW_LIMIT || worstRot > ROT_LIMIT
  if (bad) failures++
  console.log(
    `${bad ? 'FAIL' : ' ok '} ${name.padEnd(38)} cam ${worstCam.toFixed(3)}  paw ${worstPaw.toFixed(3)}  rot ${worstRot.toFixed(3)}`,
  )
}

/** Spawning and respawning place the camera; that frame is a cut on purpose. */
function prime() {
  tiger.update(DT, input as unknown as Input, true)
}

console.log('per-frame worst-case steps (m, m, rad); limits', CAM_LIMIT, PAW_LIMIT, ROT_LIMIT)

prime()
run('settle', 1)
run('walk start', 1.5, () => { input.axis = { x: 0, z: 1 } })
run('walk -> sprint', 2, () => { input.heldSet.add('ShiftLeft') })
run('sprint -> hard stop', 1.5, () => { input.heldSet.clear(); input.axis = { x: 0, z: 0 } })
run('crouch toggle while walking', 2.5, (f) => {
  input.axis = { x: 0, z: 1 }
  if (f === 30) input.heldSet.add('ControlLeft')
  if (f === 90) input.heldSet.delete('ControlLeft')
})
run('turn in place', 1, () => { input.axis = { x: 0, z: 0 }; input.mouseDX = 18 })
run('swipe, standing whiff', 1, (f) => { input.mouseDX = 0; if (f === 0) input.c0 = true })
run('swipe on the run', 1.2, (f) => {
  input.axis = { x: 0, z: 1 }
  if (f === 20) input.c0 = true
})
run('bite on the run', 1.2, (f) => { if (f === 10) input.c1 = true })
run('claw clicked mid-bite (old teleport)', 1.5, (f) => {
  if (f === 0) input.c1 = true
  if (f === 8) input.c0 = true // lands inside the bite; must queue, not snap
})
run('bite clicked mid-swipe', 1.5, (f) => {
  if (f === 0) input.c0 = true
  if (f === 6) input.c1 = true
})
run('pounce + landing at sprint', 2.5, (f) => {
  input.axis = { x: 0, z: 1 }
  input.heldSet.add('ShiftLeft')
  if (f === 30) input.pressedSet.add('Space')
})
run('roar mid-walk', 1.5, (f) => {
  input.heldSet.clear()
  if (f === 10) tiger.roar()
})
run('death collapse', 2.5, (f) => {
  input.axis = { x: 0, z: 0 }
  if (f === 10) tiger.takeDamage(10000)
})
tiger.reset()
prime()
run('after reset', 1)

if (failures) {
  console.error(`\n${failures} scenario(s) show a discontinuity`)
  process.exit(1)
}
console.log('\nall scenarios continuous')
