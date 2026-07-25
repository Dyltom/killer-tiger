/**
 * The village.
 *
 * The first pass was boxes with pyramid hats. This builds the two silhouettes
 * that actually read as a settlement — round mud huts with a deep conical
 * thatch and a veranda, and squarer store huts — then fills the gaps between
 * them with the clutter that sells a place as lived-in: fences, pots, baskets,
 * woodpiles, drying racks and carts.
 *
 * Everything is assembled from a handful of shared geometries and materials so
 * a village of twenty-odd huts is still only a few dozen draw calls.
 */
import * as THREE from 'three'
import { WORLD } from '../config'
import { Rng } from '../engine/rng'
import { surface } from './materials'
import type { Collider } from './world'

export interface VillageContext {
  rng: Rng
  height: (x: number, z: number) => number
  colliders: Collider[]
  campfires: THREE.Vector3[]
  /** Fire lights the world will flicker each frame. */
  fireLights: { light: THREE.PointLight; base: number; phase: number }[]
  /** Flame meshes, animated by the world. Each carries its own phase so the
   *  village doesn't pulse in unison. */
  flames: { obj: THREE.Object3D; phase: number }[]
}

/** Shared across every hut and prop; built once on first use. */
interface Kit {
  clay: THREE.MeshStandardMaterial
  clayDark: THREE.MeshStandardMaterial
  thatch: THREE.MeshStandardMaterial
  thatchDark: THREE.MeshStandardMaterial
  wood: THREE.MeshStandardMaterial
  rock: THREE.MeshStandardMaterial
  dark: THREE.MeshBasicMaterial
}

function makeKit(): Kit {
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
    const hide = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshStandardMaterial({
        color: rng.chance(0.5) ? 0x8a6a4a : 0x9c9280,
        roughness: 1,
        side: THREE.DoubleSide,
      }),
    )
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
function roundHut(kit: Kit, rng: Rng): { group: THREE.Group; radius: number; height: number } {
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

  return { group: g, radius: eave, height: 0.3 + h + roofH }
}

function squareHut(kit: Kit, rng: Rng): { group: THREE.Group; radius: number; height: number; hw: number; hd: number } {
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
  // Small shuttered window on one side.
  const win = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.5), kit.dark)
  win.position.set(w / 2 + 0.012, 0.3 + h * 0.6, 0)
  win.rotation.y = Math.PI / 2
  g.add(win)

  return { group: g, radius: Math.hypot(w, d) / 2, height: 0.3 + h + roofH, hw: w / 2, hd: d / 2 }
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
  const ash = new THREE.Mesh(
    new THREE.CircleGeometry(0.85, 16),
    new THREE.MeshStandardMaterial({ color: 0x3a342e, roughness: 1 }),
  )
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
  const flame = new THREE.Group()
  flame.name = 'flame'
  flame.position.y = 0.45
  const outer = new THREE.Mesh(
    new THREE.ConeGeometry(0.42, 1.25, 9),
    new THREE.MeshBasicMaterial({ color: 0xff7a18, transparent: true, opacity: 0.72, fog: false, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
  )
  outer.position.y = 0.55
  flame.add(outer)
  const core = new THREE.Mesh(
    new THREE.ConeGeometry(0.2, 0.8, 8),
    new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.9, fog: false, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
  )
  core.position.y = 0.34
  flame.add(core)
  flame.renderOrder = 3
  g.add(flame)

  // Embers glowing in the ash, independent of the flame flicker.
  const embers = new THREE.Mesh(
    new THREE.SphereGeometry(0.28, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xff4d0d, transparent: true, opacity: 0.55, fog: false, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
  )
  embers.position.y = 0.12
  embers.scale.y = 0.4
  g.add(embers)

  return g
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

    const y = ctx.height(x, z)
    const rot = rng.range(0, Math.PI * 2)

    // Round dwellings dominate; the square ones read as stores and granaries.
    if (rng.chance(0.68)) {
      const hut = roundHut(kit, rng)
      hut.group.position.set(x, y, z)
      hut.group.rotation.y = rot
      root.add(hut.group)
      ctx.colliders.push({ kind: 'circle', x, z, r: hut.radius * 0.78, h: hut.height })
    } else {
      const hut = squareHut(kit, rng)
      hut.group.position.set(x, y, z)
      hut.group.rotation.y = rot
      root.add(hut.group)
      ctx.colliders.push({ kind: 'box', x, z, hw: hut.hw, hd: hut.hd, rot, h: hut.height })
    }

    // Clutter in the lee of the hut.
    const props = rng.int(2, 5)
    for (let p = 0; p < props; p++) {
      const pa = rng.range(0, Math.PI * 2)
      const pr = rng.range(3.4, 6.0)
      const px = x + Math.cos(pa) * pr
      const pz = z + Math.sin(pa) * pr
      const py = ctx.height(px, pz)
      const roll = rng.next()
      let obj: THREE.Object3D
      if (roll < 0.3) obj = clayPot(kit, rng)
      else if (roll < 0.55) obj = basket(kit, rng)
      else if (roll < 0.75) obj = woodpile(kit, rng)
      else if (roll < 0.93) obj = dryingRack(kit, rng)
      else obj = cart(kit, rng)
      obj.position.set(px, py, pz)
      obj.rotation.y = rng.range(0, Math.PI * 2)
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

    // Warm, short-range and physically falling off, so it pools on the ground
    // and the huts around it rather than lighting the whole village.
    const light = new THREE.PointLight(0xff7a22, 22, 26, 2)
    light.position.set(x, y + 1.0, z)
    light.castShadow = false
    root.add(light)
    ctx.fireLights.push({ light, base: 22, phase: rng.range(0, 10) })
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

  return root
}
