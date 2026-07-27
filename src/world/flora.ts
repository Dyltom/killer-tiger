/**
 * Trees, scrub and grass.
 *
 * Everything here is instanced and built once at load, split across a grid of
 * chunks (see scatter.ts) so the renderer can throw away whole cells before
 * shading anything. That is what makes the density affordable: the ground-cover
 * field carries over a hundred thousand tufts and draws around eight thousand.
 *
 * The look rests on three things:
 *
 *   - canopies are alpha cut-out cards scattered through a crown volume, not a
 *     solid icosahedron. A silhouette with holes in it is the single biggest
 *     tell between "placeholder tree" and "tree";
 *   - a second, much denser layer of short grass covers the ground everywhere,
 *     so the terrain texture is never the outermost thing you see; and
 *   - all of it moves, with a travelling gust rather than per-plant jitter.
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { WORLD } from '../config'
import { Rng } from '../engine/rng'
import { ChunkedScatter } from './scatter'
import { surface } from './materials'
import { textures } from './textures'
import { addContactShade } from './contact'
import { addDistanceFade, addTranslucency, addWind } from './wind'
import type { Collider } from './world'

// ---------------------------------------------------------------- dryness
/**
 * CPU port of the terrain shader's dirt weight (materials.ts, terrFbm /
 * terrainDirtWeight). The hash, octave count and lacunarity must stay in
 * lockstep with the GLSL or the grass tint drifts off the ground pattern it is
 * supposed to sit on. The slope term is omitted — it needs the surface normal,
 * and grass is barely scattered on slopes steep enough for it to matter.
 */
function terrHash(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return s - Math.floor(s)
}
function terrNoise(x: number, y: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  let fx = x - xi
  let fy = y - yi
  fx = fx * fx * (3 - 2 * fx)
  fy = fy * fy * (3 - 2 * fy)
  const a = terrHash(xi, yi)
  const b = terrHash(xi + 1, yi)
  const c = terrHash(xi, yi + 1)
  const d = terrHash(xi + 1, yi + 1)
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
}
function terrFbm(x: number, y: number): number {
  let v = 0
  let a = 0.5
  for (let i = 0; i < 4; i++) {
    v += a * terrNoise(x, y)
    x *= 2.03
    y *= 2.03
    a *= 0.5
  }
  return v
}
function smoothstep(lo: number, hi: number, v: number): number {
  const t = Math.min(Math.max((v - lo) / (hi - lo), 0), 1)
  return t * t * (3 - 2 * t)
}
/** 0 where the ground shader shows grass, 1 where it shows bare dirt. */
function terrainDryness(x: number, z: number): number {
  const village = 1 - smoothstep(24, 44, Math.hypot(x, z))
  const dry = smoothstep(0.54, 0.8, terrFbm(x * 0.021, z * 0.021))
  return Math.min(Math.max(village * 1.2 + dry * 0.7, 0), 1)
}

export interface FloraContext {
  rng: Rng
  /** Ground height at a world position. */
  height: (x: number, z: number) => number
  /** Is this spot far enough from everything already placed? */
  clearOf: (x: number, z: number, pad: number) => boolean
  /**
   * Is this spot under a roof? Ground cover is scattered in the hundreds of
   * thousands and skips `clearOf` entirely because it cannot pay for it; the
   * huts are hollow now, so it has to pay for this much at least or every
   * floor in the village comes up through the swept earth in tufts.
   */
  insideHut: (x: number, z: number, pad: number) => boolean
  colliders: Collider[]
}

/**
 * A dome of small cards jittered through a unit hemisphere, merged into one
 * geometry. Three big crossed quads of the same leaf texture read as a flat
 * cut-out from every angle; a dozen small ones at random tilts read as a mass
 * of foliage for the same instance count.
 */
function cardClump(count: number, radius: number, cardSize: number, seed: number): THREE.BufferGeometry {
  const rng = new Rng(seed)
  const parts: THREE.BufferGeometry[] = []
  for (let i = 0; i < count; i++) {
    const q = new THREE.PlaneGeometry(cardSize, cardSize)
    q.translate(0, cardSize * 0.4, 0)
    q.rotateX(rng.range(-0.7, 0.7))
    q.rotateZ(rng.range(-0.7, 0.7))
    q.rotateY(rng.range(0, Math.PI * 2))
    // sqrt keeps the cards from bunching at the centre of the dome.
    const a = rng.range(0, Math.PI * 2)
    const r = Math.sqrt(rng.next()) * radius
    q.translate(Math.cos(a) * r, rng.range(0.05, 1) * radius, Math.sin(a) * r)
    parts.push(q)
  }
  // Shade the clump as one rounded mass: flat card normals inside it flip
  // against each other and light like a pile of paper.
  return radiateNormals(mergeGeometries(parts)!, radius * 0.5)
}

/** Crossed quads, pivoting about the base so wind bends them like a plant. */
function crossedQuads(planes: number, width: number, height: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  for (let i = 0; i < planes; i++) {
    const q = new THREE.PlaneGeometry(width, height)
    q.translate(0, height / 2, 0)
    q.rotateY((i / planes) * Math.PI)
    parts.push(q)
  }
  // Grass takes most of its light from the sky, so the normals lean toward up
  // rather than the card facing — otherwise crossed quads shade as two flat
  // panes with a seam where they meet.
  return bendNormalsUp(mergeGeometries(parts)!, 0.7)
}

/** Foliage lit as a thin surface: no metal, no gloss, lit from both sides. */
function leafMaterial(map: THREE.Texture, color: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map,
    color,
    alphaTest: 0.42,
    side: THREE.DoubleSide,
    roughness: 0.92,
    metalness: 0,
    // Alpha-tested foliage renders as opaque, so it casts and receives real
    // shadows — a transparent material would drop out of the shadow map.
    transparent: false,
  })
}

// -------------------------------------------------------------- bent normals
/**
 * Cut-out cards carry the plane's flat normal, which lights every blade in a
 * tuft identically and flips hard where quads cross. Bending the normals is
 * done here, in the geometry, so the materials stay shared across every
 * instance — per-instance materials are off the table in this project.
 */

/** Blend each vertex normal toward local up. `up` = 1 shades like a lawn. */
function bendNormalsUp(geo: THREE.BufferGeometry, up: number): THREE.BufferGeometry {
  const n = geo.attributes.normal as THREE.BufferAttribute
  const v = new THREE.Vector3()
  for (let i = 0; i < n.count; i++) {
    v.fromBufferAttribute(n, i).multiplyScalar(1 - up)
    v.y += up
    v.normalize()
    n.setXYZ(i, v.x, v.y, v.z)
  }
  n.needsUpdate = true
  return geo
}

/** Point every normal outward from a local centre, as if the clump were a ball. */
function radiateNormals(geo: THREE.BufferGeometry, cy: number): THREE.BufferGeometry {
  const p = geo.attributes.position as THREE.BufferAttribute
  const n = geo.attributes.normal as THREE.BufferAttribute
  const v = new THREE.Vector3()
  for (let i = 0; i < n.count; i++) {
    v.fromBufferAttribute(p, i)
    v.y -= cy
    // A card sitting exactly on the centre keeps its own facing.
    if (v.lengthSq() < 1e-6) continue
    v.normalize()
    n.setXYZ(i, v.x, v.y, v.z)
  }
  n.needsUpdate = true
  return geo
}

const M = new THREE.Matrix4()
const P = new THREE.Vector3()
const Q = new THREE.Quaternion()
const S = new THREE.Vector3()
const E = new THREE.Euler()
/** Separate from M/E — used to resolve a limb's tip while composing matrices. */
const DIR = new THREE.Vector3()
const DE = new THREE.Euler()
const YAXIS = new THREE.Vector3(0, 1, 0)
const QT = new THREE.Quaternion()
const QS = new THREE.Quaternion()

/**
 * Tilt a card away from vertical, then spin it about its own stem.
 *
 * Doing the spin as the middle term of an XYZ Euler does not work: three.js
 * builds that as Rx·Ry·Rz, so the Z tilt lands first, the yaw swings the
 * already-tilted card around the world axis, and the X tilt piles on top. Cards
 * came out pointing in arbitrary directions, including a few hanging straight
 * down like willow fronds. Composing the spin *inside* the tilt keeps the
 * stem-to-leaf axis where the limb put it and only changes which way the flat
 * of the card faces.
 */
function composeCard(
  x: number, y: number, z: number,
  rx: number, rz: number, spin: number,
  sx: number, sy: number, sz: number,
) {
  QT.setFromEuler(DE.set(rx, 0, rz))
  QS.setFromAxisAngle(YAXIS, spin)
  P.set(x, y, z)
  S.set(sx, sy, sz)
  return M.compose(P, QT.multiply(QS), S)
}

function compose(x: number, y: number, z: number, rx: number, ry: number, rz: number, sx: number, sy: number, sz: number) {
  P.set(x, y, z)
  E.set(rx, ry, rz)
  Q.setFromEuler(E)
  S.set(sx, sy, sz)
  return M.compose(P, Q, S)
}

/** Every chunked field, so the world can cull and retune them together. */
export interface FloraFields {
  trees: ChunkedScatter[]
  bushes: ChunkedScatter
  tallGrass: ChunkedScatter
  groundCover: ChunkedScatter
}

// ------------------------------------------------------------------- trees
/**
 * Canopy cards per tree. Enough to close the silhouette from any angle.
 * Many small cards beat few large ones: a card wider than about a third of the
 * crown reads as a printed cut-out no matter how good the alpha map is.
 *
 * These are spent in clumps at the ends of the limbs rather than sprinkled
 * evenly through the crown volume. Even scatter is the trap: it spreads a fixed
 * budget of cards thin, so no part of the crown is dense enough to be opaque
 * and the tree reads as a scattering of leaf blobs floating around a bare pole.
 * A real canopy is lumpy — dense masses of foliage with daylight between them —
 * and you get that by concentrating the same cards into a handful of clusters
 * anchored to branches you can actually see.
 *
 * Down from 88 now that the cards are chunk-culled: the crowns that survive the
 * cull are drawn at full density, and the ones behind you cost nothing, so the
 * budget buys silhouette where it is visible instead of everywhere at once.
 */
const CARDS_PER_TREE = 72
const BRANCHES_PER_TREE = 8
const CARDS_PER_LIMB = CARDS_PER_TREE / BRANCHES_PER_TREE

/** Trees are large; a chunk has to be big enough not to fragment a treeline. */
const TREE_CELL = 40
const SHRUB_CELL = 32
const GRASS_CELL = 26
const COVER_CELL = 20

export function buildTrees(ctx: FloraContext): ChunkedScatter[] {
  const { rng } = ctx
  const tex = textures()
  const n = WORLD.trees

  // ---- geometry
  // Three height segments so the trunk can taper and still light smoothly.
  const trunkGeo = new THREE.CylinderGeometry(0.11, 0.22, 1, 9, 3)
  trunkGeo.translate(0, 0.5, 0)
  // A flare at the base. Trees meeting the ground at a hard cylinder edge is
  // one of those details you don't notice until it's fixed.
  const flareGeo = new THREE.ConeGeometry(1, 1, 9, 1, true)
  flareGeo.translate(0, 0.5, 0)
  const branchGeo = new THREE.CylinderGeometry(0.025, 0.09, 1, 5)
  branchGeo.translate(0, 0.5, 0)
  const cardGeo = new THREE.PlaneGeometry(1, 1)
  cardGeo.translate(0, 0.5, 0)
  // composeCard tilts each card's local up along its limb, and the limbs fan
  // outward from the crown — so an up-biased normal, rotated per instance,
  // points away from the clump centre and the canopy shades as a rounded mass.
  // No per-instance data, so the leaf material stays shared.
  bendNormalsUp(cardGeo, 0.75)

  // ---- materials
  // Repeats are set from the real size of the thing they're on. The bark set is
  // about a metre across, and these trunks run 5-12 m tall on a ~1.3 m
  // circumference, so 2 x 7 puts the plates at life size.
  const barkMat = surface('bark', { repeat: [2, 7], roughness: 1, normalScale: 1.3 })
  const branchMat = surface('bark', { repeat: [2, 3], roughness: 1, normalScale: 1.3 })
  const flareMat = surface('bark', { repeat: [2, 1], roughness: 1, color: 0x9a8b76 })
  const leafMat = leafMaterial(tex.leafCard!, 0xd6e0b4)
  addWind(leafMat, { amplitude: 0.42, height: 1, speed: 1.15, gust: 1.35 })
  // Canopy leaves are the strongest case: a crown between you and the sun
  // should read as a lantern, not a black stencil.
  addTranslucency(leafMat, 0.85, 2.6)

  const trunks = new ChunkedScatter(TREE_CELL)
  const flares = new ChunkedScatter(TREE_CELL)
  const branches = new ChunkedScatter(TREE_CELL)
  const cards = new ChunkedScatter(TREE_CELL)

  const tint = new THREE.Color()

  for (let i = 0; i < n; i++) {
    let x = 0
    let z = 0
    for (let tries = 0; tries < 30; tries++) {
      // Dense treeline at the edge, sparse inside the village.
      const edge = rng.chance(0.62)
      const r = edge ? rng.range(78, WORLD.bounds - 3) : rng.range(34, 78)
      const a = rng.range(0, Math.PI * 2)
      x = Math.cos(a) * r
      z = Math.sin(a) * r
      if (ctx.clearOf(x, z, 4)) break
    }
    const y = ctx.height(x, z)

    // Two silhouettes: flat-topped acacias, and taller rounded crowns.
    const acacia = rng.chance(0.55)
    const h = acacia ? rng.range(5.0, 8.0) : rng.range(7.0, 12.5)
    // Trunk radius is thick * the geometry's 0.22 m base, so this tops out at
    // ~0.6 m across on an 8 m acacia. Anything fatter reads as a redwood.
    const thick = rng.range(0.85, 1.35) * (acacia ? 1.2 : 1)
    const yaw = rng.range(0, Math.PI * 2)
    const lean = rng.range(-0.06, 0.06)
    const lean2 = rng.range(-0.06, 0.06)

    trunks.push(compose(x, y, z, lean, yaw, lean2, thick, h, thick), x, y + h, z)
    const fh = rng.range(0.35, 0.6) * thick
    flares.push(compose(x, y - 0.05, z, 0, yaw, 0, thick * 0.4, fh, thick * 0.4), x, y + fh, z)

    // Crown volume: acacias spread wide and flat, the others build a dome.
    // The round crowns start halfway up rather than at 0.62 — any higher and a
    // 12 m tree is six metres of bare pole with a hat on.
    const crownR = acacia ? h * rng.range(0.5, 0.68) : h * rng.range(0.34, 0.46)
    const forkY = y + h * (acacia ? 0.72 : 0.46)

    // Warm, dusty green near the sunlit top; deeper and cooler underneath.
    const hue = rng.range(0.16, 0.24)

    for (let b = 0; b < BRANCHES_PER_TREE; b++) {
      const ba = yaw + (b / BRANCHES_PER_TREE) * Math.PI * 2 + rng.range(-0.35, 0.35)
      // Pitch away from vertical: acacia branches reach almost sideways.
      const pitch = acacia ? rng.range(0.88, 1.18) : rng.range(0.42, 0.78)
      const len = crownR * rng.range(0.62, 1.0)
      const rx = Math.cos(ba) * pitch
      const rz = -Math.sin(ba) * pitch
      branches.push(compose(x, forkY, z, rx, 0, rz, thick * 0.95, len, thick * 0.95), x, forkY + len, z)

      // Where that limb actually ends, so the foliage hangs off it instead of
      // floating in the general vicinity.
      DIR.set(0, 1, 0).applyEuler(DE.set(rx, 0, rz))
      const tipX = x + DIR.x * len
      const tipY = forkY + DIR.y * len
      const tipZ = z + DIR.z * len
      // Wide enough that neighbouring limbs' clumps overlap. Eight tips on a
      // circle sit about 0.77 R apart, so a clump narrower than ~0.5 R leaves a
      // ring of daylight gaps between them and the crown reads as a handful of
      // separate broccoli florets stuck on a pole.
      const clump = crownR * (acacia ? 0.46 : 0.54)

      for (let k = 0; k < CARDS_PER_LIMB; k++) {
        // Bias along the limb past its tip: foliage sits on the outer third of
        // a branch, not evenly along it.
        const along = rng.range(0.66, 1.1)
        // Jitter inside a ball, cube-rooted so the clump is solid in the middle
        // and ragged at the edge.
        const ja = rng.range(0, Math.PI * 2)
        const jp = Math.acos(rng.range(-1, 1))
        const jr = Math.cbrt(rng.next()) * clump
        const cx = x + (tipX - x) * along + Math.sin(jp) * Math.cos(ja) * jr
        const cy = forkY + (tipY - forkY) * along + Math.cos(jp) * jr * (acacia ? 0.55 : 1)
        const cz = z + (tipZ - z) * along + Math.sin(jp) * Math.sin(ja) * jr

        // Smaller than an even scatter would need — the density comes from
        // overlap inside the clump, so oversized cards only cost silhouette.
        const size = crownR * rng.range(0.36, 0.58)
        // The spray follows its limb but flops off it, more so on the acacias
        // whose foliage lies flat across the top of the branch.
        const cp = pitch * rng.range(0.55, 1.15) + rng.range(-0.28, 0.28)
        tint.setHSL(hue + rng.range(-0.02, 0.02), rng.range(0.26, 0.48), rng.range(0.42, 0.72))
        cards.push(
          composeCard(
            cx, cy, cz,
            Math.cos(ba) * cp, -Math.sin(ba) * cp, rng.range(0, Math.PI * 2),
            size, size * rng.range(0.85, 1.15), size,
          ),
          // Bucket the card by the *trunk*, not by its own position: a crown
          // straddling a cell boundary would otherwise split into two chunks
          // that pop in and out independently and tear the canopy in half.
          x, cy + size, z,
          tint,
        )
      }
    }

    ctx.colliders.push({ kind: 'circle', x, z, r: 0.55 * thick, h })
  }

  // Trunks read at any range; foliage and branches are only worth drawing where
  // the silhouette matters, and the treeline beyond that is the horizon layer's
  // job. Shadows come from the crowns, so the cards keep casting.
  trunks.build(trunkGeo, barkMat, { drawDistance: 250, castShadow: true, receiveShadow: true })
  flares.build(flareGeo, flareMat, { drawDistance: 90, castShadow: false, receiveShadow: true })
  branches.build(branchGeo, branchMat, { drawDistance: 150, castShadow: true, receiveShadow: true })
  cards.build(cardGeo, leafMat, { drawDistance: 220, castShadow: true, receiveShadow: true })

  return [trunks, flares, branches, cards]
}

// ------------------------------------------------------------------ bushes
/** Low scrub. Cheap, and it does most of the work of making the plain look full. */
export function buildBushes(ctx: FloraContext): ChunkedScatter {
  const { rng } = ctx
  const tex = textures()
  const geo = cardClump(11, 0.5, 0.62, 5150)
  const mat = leafMaterial(tex.leafCard!, 0xc8d2a4)
  addWind(mat, { amplitude: 0.14, height: 1, speed: 1.7, gust: 1.0 })
  addTranslucency(mat, 0.6, 3.0)
  addDistanceFade(mat, 105, 150)
  addContactShade(mat)

  const field = new ChunkedScatter(SHRUB_CELL)
  const tint = new THREE.Color()

  for (let i = 0; i < WORLD.bushes; i++) {
    let x = 0
    let z = 0
    for (let tries = 0; tries < 20; tries++) {
      const d = rng.inDisc(WORLD.bounds - 4)
      x = d.x
      z = d.z
      if (Math.hypot(x, z) > 20 && ctx.clearOf(x, z, 1.6)) break
    }
    const s = rng.range(1.1, 2.6)
    const y = ctx.height(x, z) - 0.15
    tint.setHSL(rng.range(0.14, 0.22), rng.range(0.22, 0.42), rng.range(0.42, 0.66))
    field.push(compose(x, y, z, 0, rng.range(0, Math.PI), 0, s, s * rng.range(0.55, 0.85), s), x, y + s, z, tint)
  }

  field.build(geo, mat, { drawDistance: 152, castShadow: true, receiveShadow: true })
  return field
}

// ------------------------------------------------------------------- grass
export interface GrassPatch {
  x: number
  z: number
  r: number
}

export interface GrassResult {
  tall: ChunkedScatter
  cover: ChunkedScatter
  patches: GrassPatch[]
  /** Patch centres, useful as pickup spawn points. */
  centres: THREE.Vector3[]
}

export function buildGrass(ctx: FloraContext): GrassResult {
  const { rng } = ctx
  const tex = textures()
  const tint = new THREE.Color()

  // ---- tall stalking grass, clustered into patches the AI knows about
  // Wider than it is tall: a card taller than it is wide reads as a bulrush.
  // Top of the card lands around 1.2 m, which hides a crouched tiger while a
  // standing one can still see over it.
  const tallGeo = crossedQuads(3, 1.12, 1.0)
  const tallMat = leafMaterial(tex.grassBlade!, 0xffffff)
  tallMat.alphaTest = 0.28
  addWind(tallMat, { amplitude: 0.26, height: 1.05, speed: 2.1, gust: 1.2 })
  // Tighter lobe than the canopy — dry grass is stiffer and less translucent,
  // and a wide lobe here washes out the whole plain.
  addTranslucency(tallMat, 0.9, 4.0)
  addDistanceFade(tallMat, 96, 128)
  // A paw planted in tall grass is standing on the bases of these blades, and
  // this is the only thing in the render that says so. See contact.ts.
  addContactShade(tallMat)

  const patches: GrassPatch[] = []
  const centres: THREE.Vector3[] = []
  const perPatch = WORLD.bladesPerPatch
  const tall = new ChunkedScatter(GRASS_CELL)

  for (let p = 0; p < WORLD.grassPatches; p++) {
    let px = 0
    let pz = 0
    for (let tries = 0; tries < 20; tries++) {
      const d = rng.inDisc(WORLD.bounds - 4)
      px = d.x
      pz = d.z
      if (Math.hypot(px, pz) > 16) break
    }
    const pr = rng.range(2.6, 6.5)
    patches.push({ x: px, z: pz, r: pr })
    centres.push(new THREE.Vector3(px, ctx.height(px, pz), pz))

    for (let b = 0; b < perPatch; b++) {
      const a = rng.range(0, Math.PI * 2)
      const r = Math.sqrt(rng.next()) * pr
      const x = px + Math.cos(a) * r
      const z = pz + Math.sin(a) * r
      // A patch may lap against a hut; the blades that fall indoors are dropped
      // rather than the whole patch moved, so the cover still runs up to the wall.
      if (ctx.insideHut(x, z, 0.7)) continue
      const s = rng.range(0.8, 1.15)
      // Dry-season savanna: olive and straw, never lime. Hues below ~0.12 come
      // out fluorescent yellow once the low sun rakes across them.
      // Pulled toward straw exactly where the terrain shader shows bare dirt,
      // so ground and cover read as one biome rather than green tufts on dust.
      const dw = terrainDryness(x, z) * 0.85
      const h = rng.range(0.13, 0.2)
      const sat = rng.range(0.18, 0.36)
      const l = rng.range(0.3, 0.48)
      tint.setHSL(h + (0.125 - h) * dw, sat + (0.3 - sat) * dw, l + (0.52 - l) * dw)
      // Sunk slightly so no clump shows a floating hard edge on a slope.
      const y = ctx.height(x, z) - 0.08
      tall.push(compose(x, y, z, 0, rng.range(0, Math.PI), 0, s, s * rng.range(0.8, 1.15), s), x, y + 1.3, z, tint)
    }
  }

  // No shadow casting. Fourteen thousand alpha-tested crossed quads is by far
  // the most expensive thing that was going into the shadow map, and what it
  // bought was a faint mottling on ground that is already covered in grass.
  tall.build(tallGeo, tallMat, { drawDistance: 132, castShadow: false, receiveShadow: true })

  // ---- short ground cover, everywhere, close to the camera only
  // Wide and low. A cover card taller than it is wide reads as a planted shrub;
  // real ground cover is a mat, and its job is to hide the terrain texture's
  // tiling, not to be individually legible.
  const coverGeo = crossedQuads(2, 0.62, 0.46)
  const coverMat = leafMaterial(tex.grassBlade!, 0xffffff)
  coverMat.alphaTest = 0.28
  addWind(coverMat, { amplitude: 0.08, height: 0.44, speed: 2.6, gust: 0.9 })
  addTranslucency(coverMat, 0.9, 4.0)
  // The shader fade and the chunk cull have to agree: the fade finishes at 68 m
  // so a chunk switched off past ~72 m can never pop, it was already invisible.
  addDistanceFade(coverMat, 46, 68)
  addContactShade(coverMat)

  const cover = new ChunkedScatter(COVER_CELL)
  for (let c = 0; c < WORLD.groundCover; c++) {
    const d = rng.inDisc(WORLD.bounds - 2)
    if (ctx.insideHut(d.x, d.z, 0.5)) continue
    const s = rng.range(0.85, 1.65)
    // Desaturated and pulled toward the ground's own hue: high-contrast tufts
    // on pale dirt read as scattered props rather than a continuous sward.
    // Same dryness pull as the tall grass — the cover sits directly on the
    // terrain texture, so any mismatch shows as a green film over bare dirt.
    const dw = terrainDryness(d.x, d.z) * 0.85
    const h = rng.range(0.12, 0.19)
    const sat = rng.range(0.12, 0.28)
    const l = rng.range(0.28, 0.46)
    tint.setHSL(h + (0.125 - h) * dw, sat + (0.28 - sat) * dw, l + (0.5 - l) * dw)
    const y = ctx.height(d.x, d.z) - 0.05
    cover.push(compose(d.x, y, d.z, 0, rng.range(0, Math.PI), 0, s, s * rng.range(0.8, 1.25), s), d.x, y + 0.6, d.z, tint)
  }
  cover.build(coverGeo, coverMat, { drawDistance: 72, castShadow: false, receiveShadow: true })

  return { tall, cover, patches, centres }
}
