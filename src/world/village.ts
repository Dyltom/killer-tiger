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
 *
 * The huts are hollow. Every wall here is a shell with a hole in it and an
 * inside surface of its own, the floor is a patch of swept dirt that follows the
 * real height field rather than a flat slab, and each hut registers itself in
 * `ctx.huts` with the three waypoints — outside the door, inside the door, and
 * the dark at the back — that a frightened villager walks in order. See config's
 * `HUT` for the numbers and world.ts for the hollow collision that goes with it.
 */
import * as THREE from 'three'
import { HUT, WORLD } from '../config'
import { Rng } from '../engine/rng'
import { addSmokeSource } from '../entities/particles'
import type { LampAnchor } from './lamps'
import { surface } from './materials'
import { mergeStatic } from './merge'
import type { Collider } from './world'

/**
 * One enterable building, as the AI sees it.
 *
 * Doors always face hut-local +z, so the world bearing out through the opening
 * is `(sin rot, cos rot)` and nothing downstream has to remember a second angle.
 */
export interface Hut {
  x: number
  z: number
  /** Ground height the hut was sat on — the floor, near enough. */
  y: number
  kind: 'round' | 'square'
  /** Interior clear radius (round) or inscribed half-extents (square). */
  r: number
  hw: number
  hd: number
  rot: number
  /** Unit vector from the centre out through the doorway. */
  dx: number
  dz: number
  /** Stand here to line up with the door from outside. */
  out: THREE.Vector3
  /** Just through the opening. */
  in: THREE.Vector3
  /** The dark at the back, opposite the door. */
  hide: THREE.Vector3
  capacity: number
  occupants: number
}

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
  /** Every hut the player and the AI can walk into. */
  huts: Hut[]
}

/**
 * A radial falloff, built once and shared by every soft glow in the village.
 *
 * Squared rather than linear: a linear ramp still has a visible ring where it
 * reaches zero, and what is wanted is the shape of light on a wall, which has
 * no edge at all.
 */
let falloff: THREE.DataTexture | null = null
function softFalloff(): THREE.DataTexture {
  if (falloff) return falloff
  const n = 64
  // Four channels, all carrying the same ramp: three reads the *green* one for
  // an alpha map, so a single-channel texture here is a silently invisible quad.
  const data = new Uint8Array(n * n * 4)
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (x + 0.5) / n - 0.5
      const dy = (y + 0.5) / n - 0.5
      const d = Math.min(1, Math.hypot(dx, dy) * 2)
      const v = Math.round(255 * (1 - d) * (1 - d))
      data.fill(v, (y * n + x) * 4, (y * n + x) * 4 + 4)
    }
  }
  falloff = new THREE.DataTexture(data, n, n)
  falloff.needsUpdate = true
  return falloff
}

/**
 * The warm patch an oil lamp throws on the inside of a doorway.
 *
 * Additive and unlit, so it survives whatever the tone map does to the rest of
 * the frame, and drawn just proud of the dark recess it fills. This is what
 * makes a hut read as inhabited from two hundred metres away, where the pooled
 * point lights have long since been dealt to something nearer.
 */
function lampGlow(ctx: VillageContext, w: number, h: number, color = 0xffa233, base = 0.85, soft = false): THREE.Mesh {
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
    toneMapped: false,
    // A shutter is a hard-edged slot and looks right as a flat card. Light
    // falling on an interior wall is not, and a rectangle of solid yellow back
    // there reads as a poster rather than as a lamp burning out of shot.
    alphaMap: soft ? softFalloff() : null,
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
  /** Inside faces of every wall. Same plaster, a third of the sky on it. */
  clayIn: THREE.MeshStandardMaterial
  /** Ceilings — the underside of the thatch, darker again. */
  roofIn: THREE.MeshStandardMaterial
  /** Swept earth floor inside a hut. */
  floor: THREE.MeshStandardMaterial
  thatch: THREE.MeshStandardMaterial
  thatchDark: THREE.MeshStandardMaterial
  wood: THREE.MeshStandardMaterial
  rock: THREE.MeshStandardMaterial
  dark: THREE.MeshBasicMaterial
  /**
   * The pool of light an oil lamp lays on the floor of every hut.
   *
   * One material for the whole village, deliberately: a merged batch has a
   * single material, so sharing it is what lets twenty-two of these collapse
   * into one draw call instead of each becoming its own opted-out mesh the way
   * the doorway glows have to. The cost is that they all gutter together, which
   * is invisible for something only ever seen one hut at a time.
   */
  hearth: THREE.MeshBasicMaterial
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

function makeKit(ctx: VillageContext): Kit {
  const hideMat = (color: number) =>
    new THREE.MeshStandardMaterial({ color, roughness: 1, side: THREE.DoubleSide })
  // Image-based lighting is not occluded by geometry, so an interior surface is
  // handed exactly as much sky as one facing it from the clearing. Turning the
  // environment contribution down is the whole of what makes a hut read as a
  // room rather than a yard — see HUT.interiorLight.
  const inside = <T extends THREE.MeshStandardMaterial>(m: T): T => {
    m.envMapIntensity = HUT.interiorLight
    return m
  }
  // One shared hearth glow, registered once, driving every hut's floor pool.
  const hearth = new THREE.MeshBasicMaterial({
    color: 0xff9b3a,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
    toneMapped: false,
  })
  ctx.nightGlows.push({ mat: hearth, base: 0.5, phase: 0 })
  return {
    clayIn: inside(surface('clay', { repeat: [8.4, 1.4], roughness: 1, normalScale: 1.1, color: 0x9a8871 })),
    roofIn: inside(surface('thatch', { repeat: [4, 4], roughness: 1, color: 0x4e4330 })),
    floor: inside(surface('dirt', { repeat: [1, 1], roughness: 1, normalScale: 1.1, color: 0xa2937d })),
    hearth,
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
function fenceRun(kit: Kit, rng: Rng, height: (x: number, z: number) => number, colliders: Collider[], cx: number, cz: number, radius: number, a0: number, span: number): THREE.Group {
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
    // One thin wall per rail span. Low enough that a pounce clears it — a fence
    // is exactly the thing a tiger goes over — but a walk stops at it.
    const dx = b.x - a.x
    const dz = b.z - a.z
    colliders.push({
      kind: 'box',
      x: (a.x + b.x) / 2, z: (a.z + b.z) / 2,
      hw: Math.hypot(dx, dz) / 2, hd: 0.08,
      rot: Math.atan2(dz, dx), h: 1.1,
    })
  }
  return g
}

// ------------------------------------------------------------ hut geometry
/** Stretch a geometry's U so a shared material's tiling lands at world scale. */
function scaleU(geo: THREE.BufferGeometry, k: number) {
  const uv = geo.attributes.uv as THREE.BufferAttribute
  for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * k)
}

/**
 * A band of a thick-walled cylinder, swept between two angles and two heights.
 *
 * This is what a hut wall is instead of a `CylinderGeometry`: the solid part of
 * the wall is one sweep from the far side of the doorway round to the near side,
 * and the header over the door is a second sweep that starts at lintel height.
 * The gap between them is the door, and it is a real gap — you can see through
 * it, walk through it, and shoot through it.
 *
 * Inner and outer skins are emitted separately so they can carry different
 * materials, which is how the inside of a hut ends up darker than the outside
 * without a second mesh sitting a centimetre inside the first one.
 *
 * Angles follow three's own cylinder convention — `x = sin a`, `z = cos a` — so
 * a door at `a = 0` faces hut-local +z and the winding below matches what
 * `CylinderGeometry` would have produced for the same surface.
 */
function wallBand(o: {
  rIn: number
  rOut: number
  y0: number
  y1: number
  a0: number
  a1: number
  segs: number
  /** Wall height the V coordinate is normalised against, so tiling is uniform. */
  uvH: number
  outer?: boolean
  inner?: boolean
  /** Cap the top of the band (wall head) or the bottom (door header soffit). */
  top?: boolean
  bottom?: boolean
  /** The radial faces at each end — for the solid sweep these are the jambs. */
  ends?: boolean
}): THREE.BufferGeometry {
  const pos: number[] = []
  const nor: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  const vert = (x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number) => {
    pos.push(x, y, z)
    nor.push(nx, ny, nz)
    uv.push(u, v)
    return pos.length / 3 - 1
  }
  const tri = (a: number, b: number, c: number) => idx.push(a, b, c)

  const { rIn, rOut, y0, y1, a0, a1, segs, uvH } = o
  const v0 = y0 / uvH
  const v1 = y1 / uvH

  for (let i = 0; i < segs; i++) {
    const s0 = a0 + ((a1 - a0) * i) / segs
    const s1 = a0 + ((a1 - a0) * (i + 1)) / segs
    const c0 = Math.cos(s0)
    const n0 = Math.sin(s0)
    const c1 = Math.cos(s1)
    const n1 = Math.sin(s1)
    const u0 = s0 / (Math.PI * 2)
    const u1 = s1 / (Math.PI * 2)

    if (o.outer !== false) {
      const t0 = vert(n0 * rOut, y1, c0 * rOut, n0, 0, c0, u0, v1)
      const b0 = vert(n0 * rOut, y0, c0 * rOut, n0, 0, c0, u0, v0)
      const b1 = vert(n1 * rOut, y0, c1 * rOut, n1, 0, c1, u1, v0)
      const t1 = vert(n1 * rOut, y1, c1 * rOut, n1, 0, c1, u1, v1)
      tri(t0, b0, t1)
      tri(b0, b1, t1)
    }
    if (o.inner) {
      const t0 = vert(n0 * rIn, y1, c0 * rIn, -n0, 0, -c0, u0, v1)
      const b0 = vert(n0 * rIn, y0, c0 * rIn, -n0, 0, -c0, u0, v0)
      const b1 = vert(n1 * rIn, y0, c1 * rIn, -n1, 0, -c1, u1, v0)
      const t1 = vert(n1 * rIn, y1, c1 * rIn, -n1, 0, -c1, u1, v1)
      tri(t0, t1, b0)
      tri(b0, t1, b1)
    }
    for (const cap of [o.top ? 1 : 0, o.bottom ? -1 : 0]) {
      if (cap === 0) continue
      const y = cap > 0 ? y1 : y0
      const a = vert(n0 * rIn, y, c0 * rIn, 0, cap, 0, n0 * rIn * 0.3, c0 * rIn * 0.3)
      const b = vert(n0 * rOut, y, c0 * rOut, 0, cap, 0, n0 * rOut * 0.3, c0 * rOut * 0.3)
      const c = vert(n1 * rOut, y, c1 * rOut, 0, cap, 0, n1 * rOut * 0.3, c1 * rOut * 0.3)
      const d = vert(n1 * rIn, y, c1 * rIn, 0, cap, 0, n1 * rIn * 0.3, c1 * rIn * 0.3)
      if (cap > 0) { tri(a, b, c); tri(a, c, d) } else { tri(a, c, b); tri(a, d, c) }
    }
  }

  if (o.ends) {
    for (const end of [0, 1]) {
      const a = end === 0 ? a0 : a1
      const ca = Math.cos(a)
      const sa = Math.sin(a)
      // The solid runs from a0 toward a1, so each end face looks away from it.
      const sign = end === 0 ? -1 : 1
      const nx = sign * ca
      const nz = -sign * sa
      const p1 = vert(sa * rIn, y0, ca * rIn, nx, 0, nz, 0, v0)
      const p2 = vert(sa * rOut, y0, ca * rOut, nx, 0, nz, 1, v0)
      const p3 = vert(sa * rOut, y1, ca * rOut, nx, 0, nz, 1, v1)
      const p4 = vert(sa * rIn, y1, ca * rIn, nx, 0, nz, 0, v1)
      if (end === 0) { tri(p1, p2, p3); tri(p1, p3, p4) } else { tri(p1, p3, p2); tri(p1, p4, p3) }
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  geo.setIndex(idx)
  return geo
}

/**
 * The swept-earth floor inside a hut.
 *
 * Built in world space and sampled straight off the height field rather than
 * laid flat, because the tiger's feet and everybody else's are placed by
 * `terrainHeight` and nothing may disagree with it about where the ground is. A
 * flat slab would either float over the downhill half of the floor or bury the
 * uphill half, and both of those are visible the moment you walk in.
 *
 * The 4 cm lift is for the *rendered* terrain rather than the function: the
 * terrain mesh samples the field every 1.35 m and interpolates between, so it
 * sits a centimetre or two under the true surface in the middle of a span.
 */
function dirtFloor(
  kit: Kit,
  height: Height,
  cx: number,
  cz: number,
  rot: number,
  shape: { r: number } | { hw: number; hd: number },
): THREE.Mesh {
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  const cr = Math.cos(rot)
  const sr = Math.sin(rot)
  const put = (lx: number, lz: number) => {
    // Hut-local to world: the same rotation the hut group carries.
    const x = cx + lx * cr + lz * sr
    const z = cz - lx * sr + lz * cr
    pos.push(x, height(x, z) + 0.04, z)
    uv.push(x * 0.4, z * 0.4)
    return pos.length / 3 - 1
  }

  if ('r' in shape) {
    const rings = 3
    const segs = 16
    const centre = put(0, 0)
    const ringStart: number[] = []
    for (let ring = 1; ring <= rings; ring++) {
      const rr = (shape.r * ring) / rings
      ringStart.push(pos.length / 3)
      for (let s = 0; s < segs; s++) {
        const a = (s / segs) * Math.PI * 2
        put(Math.sin(a) * rr, Math.cos(a) * rr)
      }
    }
    for (let s = 0; s < segs; s++) {
      const n = (s + 1) % segs
      idx.push(centre, ringStart[0]! + s, ringStart[0]! + n)
      for (let ring = 0; ring < rings - 1; ring++) {
        const a = ringStart[ring]!
        const b = ringStart[ring + 1]!
        idx.push(a + s, b + s, b + n)
        idx.push(a + s, b + n, a + n)
      }
    }
  } else {
    const n = 4
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n; j++) {
        put(-shape.hw + (2 * shape.hw * i) / n, -shape.hd + (2 * shape.hd * j) / n)
      }
    }
    const at = (i: number, j: number) => i * (n + 1) + j
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        idx.push(at(i, j), at(i, j + 1), at(i + 1, j))
        idx.push(at(i + 1, j), at(i, j + 1), at(i + 1, j + 1))
      }
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  const mesh = new THREE.Mesh(geo, kit.floor)
  mesh.receiveShadow = true
  return mesh
}

/**
 * What is actually in someone's house: a sleeping mat, a water pot, and the oil
 * lamp whose light has been visible in the doorway from the beginning.
 *
 * Placed against the wall rather than in the middle, so the floor stays clear
 * for the chase that is now allowed to happen in here.
 */
function hutInterior(kit: Kit, rng: Rng, g: THREE.Group, clear: number, floorY: number) {
  // Sleeping mat, rolled against the back wall.
  const mat = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, rng.range(1.1, 1.5), 7), kit.thatchDark)
  mat.rotation.set(Math.PI / 2, rng.range(0, 3), 0)
  const ma = Math.PI + rng.range(-0.7, 0.7)
  mat.position.set(Math.sin(ma) * (clear - 0.35), floorY + 0.16, Math.cos(ma) * (clear - 0.35))
  mat.castShadow = true
  g.add(mat)

  // Water pot by the door-side wall.
  const pot = clayPot(kit, rng)
  const pa = rng.chance(0.5) ? 1.5 : -1.5
  pot.position.set(Math.sin(pa) * (clear - 0.45), floorY, Math.cos(pa) * (clear - 0.45))
  g.add(pot)

  // The lamp itself, and the pool it throws. The pool is a floor quad rather
  // than a light: a point light in here would have no wall to stop it and the
  // hut would glow from outside like a paper lantern.
  const la = rng.range(-2.4, 2.4)
  const lx = Math.sin(la) * (clear - 0.5)
  const lz = Math.cos(la) * (clear - 0.5)
  const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 0.34, 7), kit.clayDark)
  stand.position.set(lx, floorY + 0.17, lz)
  g.add(stand)
  const pool = new THREE.Mesh(new THREE.CircleGeometry(1.5, 14), kit.hearth)
  pool.rotation.x = -Math.PI / 2
  pool.position.set(lx * 0.5, floorY + 0.05, lz * 0.5)
  pool.renderOrder = 3
  g.add(pool)
}

// -------------------------------------------------------------------- huts
interface HutBuild {
  group: THREE.Group
  /** Eave radius — how far the roof reaches, for prop clearance. */
  radius: number
  height: number
  /** Where a pooled practical light goes, in hut-local space. */
  door: THREE.Vector3
  /** Half-angle of the door opening, for the hollow collider. */
  doorHalf: number
  /** Radius (round) or half-extents (square) of the load-bearing wall. */
  wallR: number
  hw: number
  hd: number
  /** Interior clear radius / half-extents, inside the wall thickness. */
  clear: number
  clearW: number
  clearD: number
}

/**
 * A round dwelling, hollow, with the door always on hut-local +z.
 *
 * The door used to be placed at a random bearing inside the hut and the hut
 * itself rotated independently; there is no reason for both, and one angle
 * rather than two is what lets the AI's door bearing be `(sin rot, cos rot)`
 * with nothing to get out of step.
 */
function roundHut(kit: Kit, rng: Rng, ctx: VillageContext, floorY: number): HutBuild {
  const g = new THREE.Group()
  // Wider than the first pass, which had huts you could not have turned around
  // in. A 2.6 m wall radius leaves about 2 m of clear floor either side of the
  // tiger, which is the least a chase indoors can happen in.
  const r = rng.range(2.5, 3.4)
  const h = rng.range(2.3, 2.9)
  const roofH = rng.range(1.7, 2.4)
  const eave = r * 1.36
  const rIn = r - HUT.wall
  const doorH = HUT.doorHeight
  const doorHalf = Math.asin(Math.min(0.9, HUT.doorWidth / 2 / r))

  // Rain-splash plinth — a lathed skirt, not a cylinder, and cut away at the
  // doorway. A solid one caps itself with a disc at 35 cm, and that disc is a
  // floor slab standing above the ground the tiger actually walks on the moment
  // you can get inside; an uncut one leaves a 35 cm step across the threshold
  // for everything to wade through.
  const plinth = new THREE.Mesh(
    new THREE.LatheGeometry(
      [new THREE.Vector2(r * 1.14, 0), new THREE.Vector2(r * 1.14, 0.3), new THREE.Vector2(r * 0.99, 0.36)],
      16,
      doorHalf,
      Math.PI * 2 - doorHalf * 2,
    ),
    kit.clayDark,
  )
  plinth.receiveShadow = true
  plinth.castShadow = true
  g.add(plinth)
  // A worn timber sill filling the gap the skirt leaves, low enough to step on.
  const sill = new THREE.Mesh(new THREE.BoxGeometry(HUT.doorWidth + 0.3, 0.1, HUT.wall + 0.5), kit.wood)
  sill.position.set(0, 0.05, r - HUT.wall / 2)
  sill.receiveShadow = true
  g.add(sill)

  // The wall: solid from one side of the doorway all the way round to the
  // other, then a header spanning the gap above the lintel.
  // The band starts at ground level, not at the top of the plinth: the plinth is
  // a skirt round the outside now, so anything that starts above it leaves a
  // 30 cm slot at the foot of the inside wall to see daylight through.
  const outer = new THREE.Mesh(
    wallBand({ rIn, rOut: r, y0: 0, y1: 0.3 + h, a0: doorHalf, a1: Math.PI * 2 - doorHalf, segs: 16, uvH: h, top: true }),
    kit.clay,
  )
  outer.castShadow = true
  outer.receiveShadow = true
  g.add(outer)
  const innerSkin = new THREE.Mesh(
    wallBand({ rIn, rOut: r, y0: 0, y1: 0.3 + h, a0: doorHalf, a1: Math.PI * 2 - doorHalf, segs: 16, uvH: h, outer: false, inner: true, ends: true }),
    kit.clayIn,
  )
  innerSkin.receiveShadow = true
  g.add(innerSkin)
  const header = new THREE.Mesh(
    wallBand({ rIn, rOut: r, y0: 0.3 + doorH, y1: 0.3 + h, a0: -doorHalf, a1: doorHalf, segs: 5, uvH: h, inner: true, top: true, bottom: true }),
    kit.clay,
  )
  header.castShadow = true
  header.receiveShadow = true
  g.add(header)

  // The roof overhangs well past the wall, which is what puts the whole
  // veranda into shadow and gives the hut its weight.
  const roof = new THREE.Mesh(new THREE.ConeGeometry(eave, roofH, 20), kit.thatch)
  roof.position.y = 0.3 + h + roofH / 2 - 0.05
  roof.castShadow = true
  roof.receiveShadow = true
  g.add(roof)

  // The underside disc is the eave soffit outside the wall and the ceiling
  // inside it, so it is split at the wall line and the inner half is darker.
  const soffit = new THREE.Mesh(new THREE.RingGeometry(rIn, eave, 20), kit.thatchDark)
  soffit.rotation.x = Math.PI / 2
  soffit.position.y = 0.3 + h - 0.04
  g.add(soffit)
  // Well clear of the roof cone's own base cap, which sits at exactly
  // `0.3 + h - 0.05` and will fight this disc for every pixel of the ceiling if
  // they are given the chance.
  const ceiling = new THREE.Mesh(new THREE.CircleGeometry(rIn + 0.02, 18), kit.roofIn)
  ceiling.rotation.x = Math.PI / 2
  ceiling.position.y = 0.3 + h - 0.16
  g.add(ceiling)

  // Thatch is bound in courses; a ring at the eave edge reads as the binding.
  const band = new THREE.Mesh(new THREE.TorusGeometry(eave * 0.99, 0.055, 5, 22), kit.wood)
  band.rotation.x = Math.PI / 2
  band.position.y = 0.3 + h + 0.02
  g.add(band)

  // Veranda poles holding the eave up — skipping the two either side of the
  // doorway, or the way in is barred by a post.
  const poles = rng.int(6, 8)
  for (let i = 0; i < poles; i++) {
    const a = (i / poles) * Math.PI * 2 + rng.range(-0.1, 0.1)
    // Bearings are measured off the door, so the gap is centred on it.
    const off = Math.abs(Math.atan2(Math.sin(a), Math.cos(a)))
    if (off < doorHalf + 0.45) continue
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, h + 0.3, 5), kit.wood)
    pole.position.set(Math.sin(a) * eave * 0.92, (h + 0.3) / 2, Math.cos(a) * eave * 0.92)
    pole.castShadow = true
    g.add(pole)
  }

  // Timber frame around the opening. The jambs are the wall's own end faces —
  // these are the posts lashed against them.
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(HUT.doorWidth + 0.5, 0.17, HUT.wall + 0.16), kit.wood)
  lintel.position.set(0, 0.3 + doorH + 0.085, r - HUT.wall / 2)
  lintel.castShadow = true
  g.add(lintel)
  for (const s of [-1, 1]) {
    const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.13, doorH, HUT.wall + 0.14), kit.wood)
    jamb.position.set((s * (HUT.doorWidth + 0.13)) / 2, 0.3 + doorH / 2, r - HUT.wall / 2 - 0.02)
    jamb.castShadow = true
    g.add(jamb)
  }

  // Lamplight on the back wall, seen through the opening from the clearing.
  // This is what carries a hut two hundred metres off as inhabited, and putting
  // it on the wall the door faces rather than over the door itself means it is
  // visible exactly when you can see into the room, which is correct.
  // Unrotated: a plane faces its own +z, which is out through the door, which
  // is where it is meant to be seen from. Turned to face the wall it is behind
  // it lights nothing and shows through the back of the hut instead.
  const glow = lampGlow(ctx, rIn * 1.5, 2.0, 0xffa233, 0.6, true)
  glow.position.set(0, 0.3 + 0.8, -rIn + 0.06)
  g.add(glow)

  hutInterior(kit, rng, g, rIn, floorY)

  // Where a pooled light goes if this hut wins one: half a metre outside the
  // opening, head height. Point lights here cast no shadows, so putting it
  // *inside* would light straight through the wall and turn the hut into a
  // paper lantern; outside, it pools on the veranda the way spill should.
  const lamp = new THREE.Vector3(0, 1.7, r + 0.5)

  return {
    group: g,
    radius: eave,
    height: 0.3 + h + roofH,
    door: lamp,
    doorHalf,
    wallR: r,
    hw: r,
    hd: r,
    clear: rIn,
    clearW: rIn,
    clearD: rIn,
  }
}

function squareHut(kit: Kit, rng: Rng, ctx: VillageContext, floorY: number): HutBuild {
  const g = new THREE.Group()
  const w = rng.range(4.2, 5.6)
  const d = rng.range(3.8, 5.0)
  const h = rng.range(2.4, 2.9)
  const roofH = rng.range(1.5, 2.1)
  const t = HUT.wall
  const doorH = HUT.doorHeight
  const total = 0.3 + h

  // The plinth is a ring of four slabs, not a slab: a solid one is a floor at
  // 32 cm, and the floor in here is the height field like everywhere else.
  // The front pair leave the doorway open so there is no step to wade over.
  const skirt = (sw: number, sd: number, sx: number, sz: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sw, 0.34, sd), kit.clayDark)
    m.position.set(sx, 0.17, sz)
    m.receiveShadow = true
    m.castShadow = true
    g.add(m)
  }
  skirt(w + 0.5, 0.25, 0, -d / 2 - 0.125)
  for (const s of [-1, 1]) {
    skirt(0.25, d, (s * (w + 0.25)) / 2, 0)
    skirt((w + 0.5 - HUT.doorWidth) / 2, 0.25, (s * (HUT.doorWidth + (w + 0.5 - HUT.doorWidth) / 2)) / 2, d / 2 + 0.125)
  }
  const sill = new THREE.Mesh(new THREE.BoxGeometry(HUT.doorWidth + 0.3, 0.1, t + 0.5), kit.wood)
  sill.position.set(0, 0.05, d / 2 - t / 2)
  sill.receiveShadow = true
  g.add(sill)

  // Walls as five slabs and a header, so the front has a hole in it. The inner
  // faces get their own lining a centimetre in, because a box face carries one
  // material and the inside of a room does not read at the brightness of a wall
  // in the sun. See `Kit.clayIn`.
  const slab = (sw: number, sh: number, sd: number, sx: number, sy: number, sz: number) => {
    const geo = new THREE.BoxGeometry(sw, sh, sd)
    // `kit.clay` repeats 8.4 across the U range, which is a metre-odd tile on a
    // round hut's 18 m circumference and a five-centimetre one on a wall five
    // metres wide. Rescaling U here rather than adding a second clay material
    // keeps every wall in the village in the same merged batch.
    scaleU(geo, sw / 17.6)
    const m = new THREE.Mesh(geo, kit.clay)
    m.position.set(sx, sy, sz)
    m.castShadow = true
    m.receiveShadow = true
    g.add(m)
  }
  slab(w, total, t, 0, total / 2, -d / 2 + t / 2)
  for (const s of [-1, 1]) {
    slab(t, total, d - 2 * t, (s * (w - t)) / 2, total / 2, 0)
    const panel = (w - HUT.doorWidth) / 2
    slab(panel, total, t, (s * (HUT.doorWidth + panel)) / 2, total / 2, d / 2 - t / 2)
  }
  slab(HUT.doorWidth, total - 0.3 - doorH, t, 0, (0.3 + doorH + total) / 2, d / 2 - t / 2)

  const clearW = w / 2 - t
  const clearD = d / 2 - t
  const lining = (lw: number, lx: number, lz: number, ry: number) => {
    const geo = new THREE.PlaneGeometry(lw, total)
    scaleU(geo, lw / 17.6)
    const m = new THREE.Mesh(geo, kit.clayIn)
    m.position.set(lx, total / 2, lz)
    m.rotation.y = ry
    g.add(m)
  }
  lining(w - 2 * t, 0, -clearD + 0.01, 0)
  lining(d - 2 * t, -clearW + 0.01, 0, Math.PI / 2)
  lining(d - 2 * t, clearW - 0.01, 0, -Math.PI / 2)
  for (const s of [-1, 1]) {
    const panel = (w - HUT.doorWidth) / 2
    lining(panel, (s * (HUT.doorWidth + panel)) / 2, clearD - 0.01, Math.PI)
  }
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(w - 2 * t, d - 2 * t), kit.roofIn)
  ceiling.rotation.x = Math.PI / 2
  // Well below the eave soffit and the roof's own base cap, both of which span
  // the whole footprint including this and will z-fight it if given the chance.
  ceiling.position.y = total - 0.18
  g.add(ceiling)

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

  // Corner posts, kept clear of the doorway.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, h + 0.4, 5), kit.wood)
      post.position.set((sx * w) / 2 - sx * 0.06, (h + 0.4) / 2, (sz * d) / 2 - sz * 0.06)
      post.castShadow = true
      g.add(post)
    }
  }

  const lintel = new THREE.Mesh(new THREE.BoxGeometry(HUT.doorWidth + 0.5, 0.16, t + 0.16), kit.wood)
  lintel.position.set(0, 0.3 + doorH + 0.08, d / 2 - t / 2)
  lintel.castShadow = true
  g.add(lintel)
  for (const s of [-1, 1]) {
    const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.13, doorH + 0.3, t + 0.14), kit.wood)
    jamb.position.set((s * (HUT.doorWidth + 0.13)) / 2, (0.3 + doorH) / 2, d / 2 - t / 2 - 0.02)
    jamb.castShadow = true
    g.add(jamb)
  }

  // Lamplight on the back wall, seen through the opening from the clearing.
  const glow = lampGlow(ctx, Math.min(w - 2 * t, 3.0), 2.0, 0xffa233, 0.6, true)
  glow.position.set(0, 1.0, -clearD + 0.06)
  g.add(glow)

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

  hutInterior(kit, rng, g, Math.min(clearW, clearD), floorY)

  const lamp = new THREE.Vector3(0, 1.7, d / 2 + 0.5)

  return {
    group: g,
    radius: Math.hypot(w, d) / 2,
    height: 0.3 + h + roofH,
    door: lamp,
    doorHalf: Math.atan2(HUT.doorWidth / 2, d / 2),
    wallR: Math.max(w, d) / 2,
    hw: w / 2,
    hd: d / 2,
    clear: Math.min(clearW, clearD),
    clearW,
    clearD,
  }
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
 * How much the ground rises and falls across a footprint.
 *
 * Only huts care. A pot on a slope is a pot on a slope; a *room* on a slope has
 * a hill in the middle of its floor, because the floor is drawn off the same
 * height field that decides where feet go. See `HUT.maxRelief`.
 */
function relief(height: Height, x: number, z: number, r: number): number {
  let lo = height(x, z)
  let hi = lo
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2
    const cos = Math.cos(a)
    const sin = Math.sin(a)
    for (const k of [0.55, 1]) {
      const y = height(x + cos * r * k, z + sin * r * k)
      if (y < lo) lo = y
      else if (y > hi) hi = y
    }
  }
  return hi - lo
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
  const kit = makeKit(ctx)
  const root = new THREE.Group()
  const placed: { x: number; z: number }[] = []

  for (let i = 0; i < WORLD.huts; i++) {
    let x = 0
    let z = 0
    let best = Infinity
    for (let tries = 0; tries < 48; tries++) {
      // Two loose rings around the clearing.
      const ring = i < WORLD.huts * 0.45 ? rng.range(14, 30) : rng.range(34, 66)
      const a = rng.range(0, Math.PI * 2)
      const cx = Math.cos(a) * ring
      const cz = Math.sin(a) * ring
      // The spacing gives way as the tries run out rather than being all or
      // nothing. Ten huts want a 14 m gap on a ring only 140 m round, so the
      // inner ring used to exhaust its tries and fall back on a site that
      // clashed outright — two huts five metres apart, one of them with its
      // doorstep inside the other's wall, which is the one square metre a
      // villager running for cover has to be able to stand on.
      const need = 13 - (tries / 48) * 5
      const clash = !placed.every((p) => Math.hypot(p.x - cx, p.z - cz) > need)
      const rel = clash ? Infinity : relief(ctx.height, cx, cz, 3.4)
      if (rel < best || best === Infinity) {
        best = rel
        x = cx
        z = cz
      }
      if (rel < HUT.maxRelief) break
    }

    // The walls sit on the lowest ground under the footprint so nothing floats,
    // but the *floor* is drawn at the height field's value in the middle of the
    // room. Everything standing on that floor has to be told the difference, or
    // the pots and the lamp end up shin-deep in their own floor.
    const hutY = groundUnder(ctx.height, x, z, 3.2)
    const floorY = ctx.height(x, z) + 0.04 - hutY

    // Round dwellings dominate; the square ones read as stores and granaries.
    const round = rng.chance(0.68)
    const hut = round ? roundHut(kit, rng, ctx, floorY) : squareHut(kit, rng, ctx, floorY)
    const depth = round ? hut.clear : hut.clearD

    // Doors point outward, away from the middle of the village, with enough
    // slop that the ring doesn't read as a parade — and then whichever of a
    // handful of those leaves the most air in front of the doorstep wins. A
    // door facing into the hillside behind the hut is a door nobody would have
    // cut there; a door facing the neighbour's wall is one nobody can use.
    let rot = 0
    let bestGap = -Infinity
    for (let t = 0; t < 8; t++) {
      const cand = Math.atan2(x, z) + rng.range(-0.85, 0.85)
      const ox = x + Math.sin(cand) * (depth + HUT.approach)
      const oz = z + Math.cos(cand) * (depth + HUT.approach)
      let gap = Infinity
      for (const p of placed) gap = Math.min(gap, Math.hypot(p.x - ox, p.z - oz))
      if (gap > bestGap) {
        bestGap = gap
        rot = cand
      }
      if (gap > 6) break
    }
    placed.push({ x, z })

    // rotation.y = rot takes hut-local (x, z) to (x cos + z sin, -x sin + z cos).
    const cr = Math.cos(rot)
    const sr = Math.sin(rot)
    const toWorld = (v: THREE.Vector3, y: number) =>
      new THREE.Vector3(x + v.x * cr + v.z * sr, y, z - v.x * sr + v.z * cr)

    hut.group.position.set(x, hutY, z)
    hut.group.rotation.y = rot
    root.add(hut.group)

    // The collider frame runs the other way round from the scene graph's — see
    // `resolve` — so the yaw handed to it is negated. Before the huts were
    // hollow this only mirrored a near-square footprint and went unnoticed;
    // with a door in one wall it decides which way the door faces.
    const hollow = { wall: HUT.wall, doorW: HUT.doorWidth, rot: -rot }
    if (round) {
      ctx.colliders.push({ kind: 'circle', x, z, r: hut.wallR, h: hut.height, hollow })
    } else {
      ctx.colliders.push({ kind: 'box', x, z, hw: hut.hw, hd: hut.hd, rot: -rot, h: hut.height, hollow })
    }

    // The floor is drawn in world space off the shared height field rather than
    // as part of the hut, because everything that walks on it is placed by that
    // same function and a flat slab would disagree with it on any slope.
    root.add(
      round
        ? dirtFloor(kit, ctx.height, x, z, rot, { r: hut.clear + 0.06 })
        : dirtFloor(kit, ctx.height, x, z, rot, { hw: hut.clearW + 0.04, hd: hut.clearD + 0.04 }),
    )

    // The three waypoints a frightened villager walks, in order.
    ctx.huts.push({
      x,
      z,
      y: hutY,
      kind: round ? 'round' : 'square',
      r: hut.clear,
      hw: hut.clearW,
      hd: hut.clearD,
      rot,
      dx: sr,
      dz: cr,
      out: toWorld(new THREE.Vector3(0, 0, depth + HUT.approach), hutY),
      in: toWorld(new THREE.Vector3(0, 0, depth - HUT.entry), hutY),
      hide: toWorld(new THREE.Vector3(rng.range(-0.4, 0.4), 0, -(depth - 0.7)), hutY),
      capacity: round ? HUT.capacityRound : HUT.capacitySquare,
      occupants: 0,
    })

    // Register the doorway for the light pool, in world space.
    const doorLocal = hut.door
    ctx.lamps.push({
      x: x + doorLocal.x * cr + doorLocal.z * sr,
      y: hutY + doorLocal.y,
      z: z - doorLocal.x * sr + doorLocal.z * cr,
      kind: 'lamp',
      phase: rng.range(0, 10),
    })

    // Clutter in the lee of the hut, kept off the path in and out of the door.
    const props = rng.int(2, 5)
    const outR = Math.max(hut.radius, Math.hypot(hut.hw, hut.hd)) + 0.8
    for (let p = 0; p < props; p++) {
      const pa = rng.range(0, Math.PI * 2)
      const pr = rng.range(outR, outR + 2.6)
      const px = x + Math.cos(pa) * pr
      const pz = z + Math.sin(pa) * pr
      // Hut-local +z is the doorway; nothing gets left in the threshold.
      if (Math.abs((px - x) * cr + (pz - z) * -sr) < 1.6 && (px - x) * sr + (pz - z) * cr > 0) continue
      const roll = rng.next()
      const yaw = rng.range(0, Math.PI * 2)
      let obj: THREE.Object3D
      // Each prop registers the footprint it actually stands on. A drying rack
      // is two posts and hanging hides, not a wall — only the posts collide, so
      // a tiger still shoulders through the cloth like it should.
      if (roll < 0.3) {
        obj = clayPot(kit, rng)
        ctx.colliders.push({ kind: 'circle', x: px, z: pz, r: 0.34, h: 0.65 })
      } else if (roll < 0.55) {
        obj = basket(kit, rng)
        ctx.colliders.push({ kind: 'circle', x: px, z: pz, r: 0.42, h: 0.42 })
      } else if (roll < 0.75) {
        obj = woodpile(kit, rng)
        ctx.colliders.push({ kind: 'circle', x: px, z: pz, r: 0.7, h: 0.55 })
      } else if (roll < 0.93) {
        obj = dryingRack(kit, rng)
        // Posts sit at hut-local ±span/2 along x, spun by yaw. rotation.y = yaw
        // maps local (x, z) to (x cos + z sin, -x sin + z cos).
        for (const side of [-1.25, 1.25]) {
          ctx.colliders.push({ kind: 'circle', x: px + Math.cos(yaw) * side, z: pz - Math.sin(yaw) * side, r: 0.16, h: 2.0 })
        }
      } else {
        obj = cart(kit, rng)
        // Collider frame is mirrored from the scene graph's — same negation as
        // the huts above.
        ctx.colliders.push({ kind: 'box', x: px, z: pz, hw: 0.9, hd: 1.35, rot: -yaw, h: 1.0 })
      }
      obj.position.set(px, groundUnder(ctx.height, px, pz, 0.9) - 0.03, pz)
      layOnSlope(obj, ctx.height, px, pz, yaw)
      root.add(obj)
    }

    // A short stretch of fence curving away round the back of some huts —
    // fenceRun measures from +x, and the door bearing in that frame is
    // atan2(cos rot, sin rot), so the arc starts half a span past its opposite.
    if (rng.chance(0.35)) {
      const span = rng.range(0.9, 2.1)
      const a0 = Math.atan2(cr, sr) + Math.PI - span / 2 + rng.range(-0.5, 0.5)
      root.add(fenceRun(kit, rng, ctx.height, ctx.colliders, x, z, Math.max(5.4, outR + 1.2), a0, span))
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
    // Smoke rises off the flame tip, not the ash bed — puffs born inside the
    // cone would pop against it before they cleared the fire.
    addSmokeSource(x, y + 1.5, z)

    // A ring of seating logs — gives the AI's "safe zone" a visible reason.
    for (let s = 0; s < 3; s++) {
      const sa = rng.range(0, Math.PI * 2)
      const sx = x + Math.cos(sa) * 2.1
      const sz = z + Math.sin(sa) * 2.1
      const len = rng.range(1.4, 2.2)
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.24, len, 7), kit.wood)
      log.rotation.set(Math.PI / 2, 0, sa)
      log.position.set(sx, ctx.height(sx, sz) + 0.22, sz)
      log.castShadow = true
      log.receiveShadow = true
      root.add(log)
      // The XYZ euler above lays the log along (-sin sa, 0, cos sa).
      ctx.colliders.push({ kind: 'box', x: sx, z: sz, hw: len / 2, hd: 0.25, rot: Math.atan2(Math.cos(sa), -Math.sin(sa)), h: 0.48 })
    }
  }

  // Nothing above this line has to know it is being batched, and nothing below
  // it can move: from here the village is geometry, not objects.
  mergeStatic(root, 70)
  return root
}
