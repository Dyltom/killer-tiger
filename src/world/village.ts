/**
 * The village.
 *
 * The first pass was boxes with pyramid hats. This builds the two silhouettes
 * that actually read as a settlement — round mud huts with a deep conical
 * thatch and a veranda, and squarer store huts — then fills the gaps between
 * them with the clutter that sells a place as lived-in: fences, pots, baskets,
 * woodpiles, drying racks and carts.
 *
 * Everything is assembled from a handful of shared materials, and then baked:
 * `mergeStatic` at the bottom of the build collapses the seven-hundred-odd
 * meshes this file authors into one buffer per material per 40 m cell. Authoring
 * a cart as nineteen parts and drawing it as nineteen draw calls are separate
 * decisions, and only the first one is worth anything — see world/merge.ts.
 *
 * The one rule that falls out of that: anything animated by moving it or by
 * writing to its material has no transform and no material of its own once
 * merged, so it has to opt out with `userData.dynamic`. That is the campfire
 * flames and the doorway glows, and nothing else.
 */
import * as THREE from 'three'
import { WORLD } from '../config'
import { Rng } from '../engine/rng'
import type { LampAnchor } from './lamps'
import { surface } from './materials'
import { mergeStatic } from './merge'
import type { Collider } from './world'

/** An additive glow the world fades up at dusk and down again at dawn. */
export interface NightGlow {
  mat: THREE.MeshBasicMaterial
  base: number
  /** Desynchronises the slow guttering so the village doesn't breathe in unison. */
  phase: number
}

export interface VillageContext {
  rng: Rng
  height: (x: number, z: number) => number
  colliders: Collider[]
  campfires: THREE.Vector3[]
  /**
   * Where the pooled practical lights may be spent. The village registers a
   * point per fire and per doorway; world/lamps.ts decides which of them are
   * worth a real light right now.
   */
  lamps: LampAnchor[]
  /** Doorway and shutter glows, lit from dusk. */
  nightGlows: NightGlow[]
  /** Flame meshes, animated by the world. Each carries its own phase so the
   *  village doesn't pulse in unison. */
  flames: { obj: THREE.Object3D; phase: number }[]
}

/**
 * The warm patch an oil lamp throws on the inside of a doorway.
 *
 * Additive and unlit, so it survives whatever the tone map does to the rest of
 * the frame, and drawn just proud of the dark recess it fills. This is what
 * makes a hut read as inhabited from two hundred metres away, where the pooled
 * point lights have long since been dealt to something nearer.
 */
function lampGlow(ctx: VillageContext, w: number, h: number, color = 0xffa233, base = 0.85): THREE.Mesh {
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
    toneMapped: false,
  })
  ctx.nightGlows.push({ mat, base, phase: ctx.rng.range(0, 20) })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat)
  mesh.renderOrder = 3
  // Each glow owns its own opacity and its own phase; a merged batch would have
  // one material for all of them and the village would gutter in unison.
  mesh.userData.dynamic = true
  return mesh
}

/**
 * Shared across every hut and prop; built once on first use.
 *
 * Every material a static prop uses has to live here rather than being built
 * inline next to the mesh. A `new MeshStandardMaterial` per hide or per ash bed
 * is its own batch in the merge, so ten campfires that ought to collapse to one
 * draw call stay ten.
 */
interface Kit {
  clay: THREE.MeshStandardMaterial
  clayDark: THREE.MeshStandardMaterial
  thatch: THREE.MeshStandardMaterial
  thatchDark: THREE.MeshStandardMaterial
  wood: THREE.MeshStandardMaterial
  rock: THREE.MeshStandardMaterial
  dark: THREE.MeshBasicMaterial
  /** The two cloths on a drying rack. Double-sided; they hang free. */
  hide: [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial]
  ash: THREE.MeshStandardMaterial
  ember: THREE.MeshBasicMaterial
  flame: THREE.MeshBasicMaterial
  flameCore: THREE.MeshBasicMaterial
}

/** Unlit, additive and off the tone map, so fire blows out into the bloom. */
function fireMat(color: number, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    fog: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  })
}

function makeKit(): Kit {
  const hideMat = (color: number) =>
    new THREE.MeshStandardMaterial({ color, roughness: 1, side: THREE.DoubleSide })
  return {
    // Repeats are derived from the geometry these land on, not picked by eye.
    // A hut wall is a ~15 m circumference cylinder 2.5 m tall, so at the old
    // [3, 1.4] a single clay tile spanned five metres of wall and the pattern
    // came out as huge stretched worms. 8.4 x 1.4 keeps the tile square in
    // world space at roughly two metres, which is the size the set was shot at.
    clay: surface('clay', { repeat: [8.4, 1.4], roughness: 1, normalScale: 1.4 }),
    // The plinth and the lower course of every wall are stained darker by rain
    // splash. Two tones is the cheapest way to stop a wall looking printed on.
    clayDark: surface('clay', { repeat: [16, 0.4], roughness: 1, color: 0x8c7a66 }),
    // Roof cone: ~21 m around the eave, ~4 m of slant.
    thatch: surface('thatch', { repeat: [10, 2], roughness: 1, normalScale: 1.6 }),
    thatchDark: surface('thatch', { repeat: [3.4, 3.4], roughness: 1, color: 0x6a5a3c }),
    wood: surface('bark', { repeat: [1, 3], roughness: 0.95 }),
    rock: surface('rock', { repeat: [2, 2], roughness: 1 }),
    dark: new THREE.MeshBasicMaterial({ color: 0x080605, fog: true }),
    hide: [hideMat(0x8a6a4a), hideMat(0x9c9280)],
    ash: new THREE.MeshStandardMaterial({ color: 0x3a342e, roughness: 1 }),
    ember: fireMat(0xff4d0d, 0.55),
    flame: fireMat(0xff7a18, 0.72),
    flameCore: fireMat(0xffe9a8, 0.9),
  }
}

// ------------------------------------------------------------------- props
function clayPot(kit: Kit, rng: Rng): THREE.Mesh {
  // Profile of a water pot: narrow foot, full belly, pinched neck, flared lip.
  const belly = rng.range(0.22, 0.34)
  const pts = [
    new THREE.Vector2(0.001, 0),
    new THREE.Vector2(belly * 0.42, 0.02),
    new THREE.Vector2(belly * 0.9, belly * 0.55),
    new THREE.Vector2(belly, belly * 1.05),
    new THREE.Vector2(belly * 0.72, belly * 1.6),
    new THREE.Vector2(belly * 0.5, belly * 1.85),
    new THREE.Vector2(belly * 0.62, belly * 1.98),
  ]
  const mesh = new THREE.Mesh(new THREE.LatheGeometry(pts, 14), kit.clayDark)
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

function basket(kit: Kit, rng: Rng): THREE.Mesh {
  const r = rng.range(0.28, 0.44)
  const pts = [
    new THREE.Vector2(0.001, 0),
    new THREE.Vector2(r * 0.55, 0),
    new THREE.Vector2(r, r * 0.75),
    new THREE.Vector2(r * 1.06, r * 0.95),
  ]
  const mesh = new THREE.Mesh(new THREE.LatheGeometry(pts, 12), kit.thatchDark)
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

function woodpile(kit: Kit, rng: Rng): THREE.Group {
  const g = new THREE.Group()
  const rows = rng.int(2, 3)
  for (let r = 0; r < rows; r++) {
    const perRow = 4 - r
    for (let i = 0; i < perRow; i++) {
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.1, rng.range(1.1, 1.7), 6), kit.wood)
      log.rotation.z = Math.PI / 2
      log.rotation.y = rng.range(-0.1, 0.1)
      log.position.set(rng.range(-0.05, 0.05), 0.1 + r * 0.19, (i - (perRow - 1) / 2) * 0.21)
      log.castShadow = true
      g.add(log)
    }
  }
  return g
}

function dryingRack(kit: Kit, rng: Rng): THREE.Group {
  const g = new THREE.Group()
  const span = rng.range(2.0, 3.0)
  for (const px of [-span / 2, span / 2]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.11, 2.1, 6), kit.wood)
    post.position.set(px, 1.05, 0)
    post.castShadow = true
    g.add(post)
    // Angled brace — a bare pair of posts always looks like scaffolding.
    const brace = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 1.3, 5), kit.wood)
    brace.position.set(px + Math.sign(px) * 0.3, 0.65, 0)
    brace.rotation.z = Math.sign(px) * 0.5
    g.add(brace)
  }
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, span + 0.4, 6), kit.wood)
  bar.rotation.z = Math.PI / 2
  bar.position.y = 2.0
  g.add(bar)

  // Hides and cloth hanging to dry. These break the horizontal line of the bar
  // and give the low sun something to rake across.
  const hides = rng.int(1, 3)
  for (let i = 0; i < hides; i++) {
    const w = rng.range(0.5, 0.9)
    const h = rng.range(0.7, 1.3)
    const hide = new THREE.Mesh(new THREE.PlaneGeometry(w, h), kit.hide[rng.chance(0.5) ? 0 : 1])
    hide.position.set(rng.range(-span / 2 + 0.3, span / 2 - 0.3), 2.0 - h / 2, 0)
    hide.rotation.y = rng.range(-0.2, 0.2)
    hide.castShadow = true
    g.add(hide)
  }
  return g
}

function cart(kit: Kit, rng: Rng): THREE.Group {
  const g = new THREE.Group()
  const bed = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.16, 2.4), kit.wood)
  bed.position.y = 0.62
  bed.castShadow = true
  bed.receiveShadow = true
  g.add(bed)
  for (const side of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.4, 2.4), kit.wood)
    rail.position.set(side * 0.7, 0.85, 0)
    rail.castShadow = true
    g.add(rail)
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.52, 0.08, 6, 14), kit.wood)
    wheel.rotation.y = Math.PI / 2
    wheel.position.set(side * 0.82, 0.52, -0.2)
    wheel.castShadow = true
    g.add(wheel)
    for (let s = 0; s < 4; s++) {
      const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.0, 4), kit.wood)
      spoke.position.copy(wheel.position)
      spoke.rotation.set(0, Math.PI / 2, (s / 4) * Math.PI)
      g.add(spoke)
    }
    // Shafts tipped into the dirt, so the cart reads as parked.
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.0, 5), kit.wood)
    shaft.position.set(side * 0.5, 0.45, 1.7)
    shaft.rotation.x = rng.range(1.15, 1.35)
    g.add(shaft)
  }
  return g
}

/** A run of posts and rails following an arc. */
function fenceRun(kit: Kit, rng: Rng, height: (x: number, z: number) => number, cx: number, cz: number, radius: number, a0: number, span: number): THREE.Group {
  const g = new THREE.Group()
  const posts = Math.max(3, Math.round((span * radius) / 1.5))
  const pts: THREE.Vector3[] = []
  for (let i = 0; i < posts; i++) {
    const a = a0 + (i / (posts - 1)) * span
    const x = cx + Math.cos(a) * radius
    const z = cz + Math.sin(a) * radius
    const y = height(x, z)
    pts.push(new THREE.Vector3(x, y, z))
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 1.35, 5), kit.wood)
    post.position.set(x, y + 0.6, z)
    post.rotation.set(rng.range(-0.06, 0.06), rng.range(0, 3), rng.range(-0.06, 0.06))
    post.castShadow = true
    g.add(post)
  }
  // Two rails lashed between consecutive posts, following the ground.
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!
    const b = pts[i + 1]!
    for (const h of [0.55, 1.05]) {
      const from = a.clone().setY(a.y + h + rng.range(-0.04, 0.04))
      const to = b.clone().setY(b.y + h + rng.range(-0.04, 0.04))
      const len = from.distanceTo(to)
      const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, len, 5), kit.wood)
      rail.position.copy(from).lerp(to, 0.5)
      rail.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize())
      rail.castShadow = true
      g.add(rail)
    }
  }
  return g
}

// -------------------------------------------------------------------- huts
function roundHut(kit: Kit, rng: Rng, ctx: VillageContext): { group: THREE.Group; radius: number; height: number; door: THREE.Vector3 } {
  const g = new THREE.Group()
  const r = rng.range(1.9, 2.9)
  const h = rng.range(2.1, 2.8)
  const roofH = rng.range(1.6, 2.3)
  const eave = r * 1.42

  // Rain-splash plinth.
  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.07, r * 1.13, 0.35, 18), kit.clayDark)
  plinth.position.y = 0.17
  plinth.receiveShadow = true
  plinth.castShadow = true
  g.add(plinth)

  const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.04, h, 18), kit.clay)
  body.position.y = 0.3 + h / 2
  body.castShadow = true
  body.receiveShadow = true
  g.add(body)

  // The roof overhangs well past the wall, which is what puts the whole
  // veranda into shadow and gives the hut its weight.
  const roof = new THREE.Mesh(new THREE.ConeGeometry(eave, roofH, 20), kit.thatch)
  roof.position.y = 0.3 + h + roofH / 2 - 0.05
  roof.castShadow = true
  roof.receiveShadow = true
  g.add(roof)

  // A darker underside disc, so looking up under the eave isn't blank.
  const soffit = new THREE.Mesh(new THREE.CircleGeometry(eave, 20), kit.thatchDark)
  soffit.rotation.x = Math.PI / 2
  soffit.position.y = 0.3 + h - 0.04
  g.add(soffit)

  // Thatch is bound in courses; a ring at the eave edge reads as the binding.
  const band = new THREE.Mesh(new THREE.TorusGeometry(eave * 0.99, 0.055, 5, 22), kit.wood)
  band.rotation.x = Math.PI / 2
  band.position.y = 0.3 + h + 0.02
  g.add(band)

  // Veranda poles holding the eave up.
  const poles = rng.int(5, 7)
  for (let i = 0; i < poles; i++) {
    const a = (i / poles) * Math.PI * 2 + rng.range(-0.1, 0.1)
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, h + 0.3, 5), kit.wood)
    pole.position.set(Math.cos(a) * eave * 0.9, (h + 0.3) / 2, Math.sin(a) * eave * 0.9)
    pole.castShadow = true
    g.add(pole)
  }

  // Doorway: a dark recess set into the wall with a timber lintel.
  const doorW = 0.95
  const doorH = 1.75
  const door = new THREE.Group()
  const hole = new THREE.Mesh(new THREE.PlaneGeometry(doorW, doorH), kit.dark)
  hole.position.y = 0.3 + doorH / 2
  door.add(hole)
  // The lamp inside, seen from the clearing. Drawn a hair proud of the recess
  // so it isn't z-fighting with it, and slightly narrower so a dark jamb line
  // survives around the edge.
  const glow = lampGlow(ctx, doorW * 0.82, doorH * 0.86)
  glow.position.set(0, 0.3 + doorH / 2, 0.02)
  door.add(glow)
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(doorW + 0.4, 0.16, 0.3), kit.wood)
  lintel.position.set(0, 0.3 + doorH + 0.08, -0.02)
  lintel.castShadow = true
  door.add(lintel)
  for (const s of [-1, 1]) {
    const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.14, doorH, 0.26), kit.wood)
    jamb.position.set((s * (doorW + 0.14)) / 2, 0.3 + doorH / 2, -0.02)
    door.add(jamb)
  }
  // Sit the opening just proud of the wall — the cylinder flares toward its
  // base, so anything at exactly r disappears inside it.
  const da = rng.range(0, Math.PI * 2)
  door.rotation.y = da
  door.position.set(Math.sin(da) * r * 1.05, 0, Math.cos(da) * r * 1.05)
  g.add(door)

  // Where a pooled light goes if this hut wins one: half a metre outside the
  // opening, head height. Point lights here cast no shadows, so putting it
  // *inside* would light straight through the wall and turn the hut into a
  // paper lantern; outside, it pools on the veranda the way spill should.
  const lamp = new THREE.Vector3(Math.sin(da), 0, Math.cos(da)).multiplyScalar(r * 1.05 + 0.5)
  lamp.y = 1.7

  return { group: g, radius: eave, height: 0.3 + h + roofH, door: lamp }
}

function squareHut(kit: Kit, rng: Rng, ctx: VillageContext): { group: THREE.Group; radius: number; height: number; hw: number; hd: number; door: THREE.Vector3 } {
  const g = new THREE.Group()
  const w = rng.range(3.4, 5.0)
  const d = rng.range(3.0, 4.4)
  const h = rng.range(2.2, 2.9)
  const roofH = rng.range(1.5, 2.1)

  const plinth = new THREE.Mesh(new THREE.BoxGeometry(w + 0.5, 0.32, d + 0.5), kit.clayDark)
  plinth.position.y = 0.16
  plinth.receiveShadow = true
  g.add(plinth)

  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), kit.clay)
  body.position.y = 0.3 + h / 2
  body.castShadow = true
  body.receiveShadow = true
  g.add(body)

  // Four-sided cone = pyramid. The 45-degree turn has to be baked into the
  // geometry, not set on the mesh, or the non-uniform Z scale below would be
  // applied along a diagonal and shear the roof into a rhombus.
  const overhangW = w / 2 + 0.4
  const overhangD = d / 2 + 0.4
  const roofGeo = new THREE.ConeGeometry(overhangW * Math.SQRT2, roofH, 4)
  roofGeo.rotateY(Math.PI / 4)
  const roof = new THREE.Mesh(roofGeo, kit.thatch)
  roof.position.y = 0.3 + h + roofH / 2 - 0.06
  roof.scale.set(1, 1, overhangD / overhangW)
  roof.castShadow = true
  roof.receiveShadow = true
  g.add(roof)

  // Eaves soffit so there's a dark line where the thatch meets the wall.
  const soffit = new THREE.Mesh(new THREE.PlaneGeometry(overhangW * 2, overhangD * 2), kit.thatchDark)
  soffit.rotation.x = Math.PI / 2
  soffit.position.y = 0.3 + h - 0.05
  g.add(soffit)

  // Corner posts and a ridge pole poking out of the thatch.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, h + 0.4, 5), kit.wood)
      post.position.set((sx * w) / 2 - sx * 0.06, (h + 0.4) / 2, (sz * d) / 2 - sz * 0.06)
      post.castShadow = true
      g.add(post)
    }
  }

  const doorH = 1.8
  const hole = new THREE.Mesh(new THREE.PlaneGeometry(1.0, doorH), kit.dark)
  hole.position.set(0, 0.3 + doorH / 2, d / 2 + 0.012)
  g.add(hole)
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.15, 0.34), kit.wood)
  lintel.position.set(0, 0.3 + doorH + 0.07, d / 2)
  g.add(lintel)
  const doorGlow = lampGlow(ctx, 0.82, doorH * 0.86)
  doorGlow.position.set(0, 0.3 + doorH / 2, d / 2 + 0.026)
  g.add(doorGlow)

  // Small shuttered window on one side.
  const win = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.5), kit.dark)
  win.position.set(w / 2 + 0.012, 0.3 + h * 0.6, 0)
  win.rotation.y = Math.PI / 2
  g.add(win)
  // Dimmer than the doorway and cooler — it's lamplight through a shutter slat,
  // not an open door.
  const winGlow = lampGlow(ctx, 0.5, 0.4, 0xffb15a, 0.5)
  winGlow.position.set(w / 2 + 0.026, 0.3 + h * 0.6, 0)
  winGlow.rotation.y = Math.PI / 2
  g.add(winGlow)

  const lamp = new THREE.Vector3(0, 1.7, d / 2 + 0.5)

  return { group: g, radius: Math.hypot(w, d) / 2, height: 0.3 + h + roofH, hw: w / 2, hd: d / 2, door: lamp }
}

// --------------------------------------------------------------- campfires
function campfire(kit: Kit, rng: Rng): THREE.Group {
  const g = new THREE.Group()

  for (let s = 0; s < 11; s++) {
    const a = (s / 11) * Math.PI * 2 + rng.range(-0.12, 0.12)
    const sc = rng.range(0.15, 0.27)
    const stone = new THREE.Mesh(new THREE.DodecahedronGeometry(sc, 0), kit.rock)
    stone.position.set(Math.cos(a) * 0.88, sc * 0.5, Math.sin(a) * 0.88)
    stone.rotation.set(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3))
    stone.castShadow = true
    stone.receiveShadow = true
    g.add(stone)
  }

  // Ash bed under the logs.
  const ash = new THREE.Mesh(new THREE.CircleGeometry(0.85, 16), kit.ash)
  ash.rotation.x = -Math.PI / 2
  ash.position.y = 0.02
  ash.receiveShadow = true
  g.add(ash)

  // Logs leaned into a cone, charred at the tips.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 1.1, 5), kit.wood)
    log.position.set(Math.cos(a) * 0.26, 0.42, Math.sin(a) * 0.26)
    log.rotation.set(Math.cos(a) * 0.5, 0, -Math.sin(a) * 0.5)
    log.castShadow = true
    g.add(log)
  }

  // Two nested flame cones: an outer orange body and a hot inner core. Both
  // skip the tone map so they blow out into the bloom instead of clipping grey.
  // The world scales and spins this group every frame, so it stays a real object
  // rather than being baked into the merge.
  const flame = new THREE.Group()
  flame.name = 'flame'
  flame.userData.dynamic = true
  flame.position.y = 0.45
  const outer = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.25, 9), kit.flame)
  outer.position.y = 0.55
  flame.add(outer)
  const core = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.8, 8), kit.flameCore)
  core.position.y = 0.34
  flame.add(core)
  flame.renderOrder = 3
  g.add(flame)

  // Embers glowing in the ash, independent of the flame flicker.
  const embers = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 6), kit.ember)
  embers.position.y = 0.12
  embers.scale.y = 0.4
  g.add(embers)

  return g
}

// ------------------------------------------------------- sitting on the land
type Height = (x: number, z: number) => number

/**
 * Lowest ground anywhere under a footprint of the given radius.
 *
 * Sampling only the centre is what left the uphill side of every hut and pot on
 * the outer ring standing clear of the slope on a wedge of air. Sinking to the
 * minimum instead buries the uphill edge, which nothing can see, rather than
 * floating the downhill one, which everything can.
 */
function groundUnder(height: Height, x: number, z: number, r: number): number {
  let y = height(x, z)
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4
    y = Math.min(y, height(x + Math.cos(a) * r, z + Math.sin(a) * r))
  }
  return y
}

/**
 * Lay a loose prop over on whatever it is sitting on. Buildings stay plumb —
 * people level their own foundations — but a pot or a woodpile does not.
 */
function layOnSlope(obj: THREE.Object3D, height: Height, x: number, z: number, yaw: number) {
  const gx = height(x + 0.7, z) - height(x - 0.7, z)
  const gz = height(x, z + 0.7) - height(x, z - 0.7)
  const clamp = (v: number) => Math.max(-0.32, Math.min(0.32, v / 1.4))
  obj.rotation.set(clamp(gz), yaw, -clamp(gx), 'YXZ')
}

// ------------------------------------------------------------------- build
export function buildVillage(ctx: VillageContext): THREE.Group {
  const { rng } = ctx
  const kit = makeKit()
  const root = new THREE.Group()
  const placed: { x: number; z: number; r: number }[] = []

  for (let i = 0; i < WORLD.huts; i++) {
    let x = 0
    let z = 0
    for (let tries = 0; tries < 40; tries++) {
      // Two loose rings around the clearing.
      const ring = i < WORLD.huts * 0.45 ? rng.range(14, 30) : rng.range(34, 66)
      const a = rng.range(0, Math.PI * 2)
      x = Math.cos(a) * ring
      z = Math.sin(a) * ring
      if (placed.every((p) => Math.hypot(p.x - x, p.z - z) > p.r + 7)) break
    }
    placed.push({ x, z, r: 7 })

    const rot = rng.range(0, Math.PI * 2)

    // Round dwellings dominate; the square ones read as stores and granaries.
    let hutY: number
    let doorLocal: THREE.Vector3
    if (rng.chance(0.68)) {
      const hut = roundHut(kit, rng, ctx)
      hutY = groundUnder(ctx.height, x, z, hut.radius * 0.85)
      hut.group.position.set(x, hutY, z)
      hut.group.rotation.y = rot
      root.add(hut.group)
      ctx.colliders.push({ kind: 'circle', x, z, r: hut.radius * 0.78, h: hut.height })
      doorLocal = hut.door
    } else {
      const hut = squareHut(kit, rng, ctx)
      hutY = groundUnder(ctx.height, x, z, Math.max(hut.hw, hut.hd))
      hut.group.position.set(x, hutY, z)
      hut.group.rotation.y = rot
      root.add(hut.group)
      ctx.colliders.push({ kind: 'box', x, z, hw: hut.hw, hd: hut.hd, rot, h: hut.height })
      doorLocal = hut.door
    }

    // Register the doorway for the light pool, in world space. rotation.y = rot
    // takes hut-local (x, z) to (x cos + z sin, -x sin + z cos).
    const cr = Math.cos(rot)
    const sr = Math.sin(rot)
    ctx.lamps.push({
      x: x + doorLocal.x * cr + doorLocal.z * sr,
      y: hutY + doorLocal.y,
      z: z - doorLocal.x * sr + doorLocal.z * cr,
      kind: 'lamp',
      phase: rng.range(0, 10),
    })

    // Clutter in the lee of the hut.
    const props = rng.int(2, 5)
    for (let p = 0; p < props; p++) {
      const pa = rng.range(0, Math.PI * 2)
      const pr = rng.range(3.4, 6.0)
      const px = x + Math.cos(pa) * pr
      const pz = z + Math.sin(pa) * pr
      const roll = rng.next()
      let obj: THREE.Object3D
      if (roll < 0.3) obj = clayPot(kit, rng)
      else if (roll < 0.55) obj = basket(kit, rng)
      else if (roll < 0.75) obj = woodpile(kit, rng)
      else if (roll < 0.93) obj = dryingRack(kit, rng)
      else obj = cart(kit, rng)
      obj.position.set(px, groundUnder(ctx.height, px, pz, 0.9) - 0.03, pz)
      layOnSlope(obj, ctx.height, px, pz, rng.range(0, Math.PI * 2))
      root.add(obj)
    }

    // A short stretch of fence curving away from some huts.
    if (rng.chance(0.35)) {
      const a0 = rng.range(0, Math.PI * 2)
      root.add(fenceRun(kit, rng, ctx.height, x, z, rng.range(4.5, 7), a0, rng.range(0.9, 2.1)))
    }
  }

  // ---- campfires
  for (let i = 0; i < WORLD.campfires; i++) {
    const a = (i / WORLD.campfires) * Math.PI * 2 + 0.4
    const r = rng.range(8, 22)
    const x = Math.cos(a) * r
    const z = Math.sin(a) * r
    const y = ctx.height(x, z)
    ctx.campfires.push(new THREE.Vector3(x, y, z))

    const fire = campfire(kit, rng)
    fire.position.set(x, y, z)
    fire.rotation.y = rng.range(0, Math.PI * 2)
    root.add(fire)
    const flame = fire.getObjectByName('flame')
    if (flame) ctx.flames.push({ obj: flame, phase: rng.range(0, 20) })

    // The fire asks for a light rather than owning one — see world/lamps.ts for
    // why the pool is fixed and dealt out instead of one light per fire.
    ctx.lamps.push({ x, y: y + 1.0, z, kind: 'fire', phase: rng.range(0, 10) })
    ctx.colliders.push({ kind: 'circle', x, z, r: 1.1, h: 0.5 })

    // A ring of seating logs — gives the AI's "safe zone" a visible reason.
    for (let s = 0; s < 3; s++) {
      const sa = rng.range(0, Math.PI * 2)
      const sx = x + Math.cos(sa) * 2.1
      const sz = z + Math.sin(sa) * 2.1
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.24, rng.range(1.4, 2.2), 7), kit.wood)
      log.rotation.set(Math.PI / 2, 0, sa)
      log.position.set(sx, ctx.height(sx, sz) + 0.22, sz)
      log.castShadow = true
      log.receiveShadow = true
      root.add(log)
    }
  }

  // Nothing above this line has to know it is being batched, and nothing below
  // it can move: from here the village is geometry, not objects.
  mergeStatic(root, 40)
  return root
}
