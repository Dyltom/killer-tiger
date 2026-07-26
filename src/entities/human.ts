/**
 * Prey and predators-of-the-predator.
 *
 * Villagers wander, notice the tiger, and scatter screaming toward firelight.
 * Hunters patrol, close the distance, and shoot. Both share one body rig and
 * one state machine; the differences are in the config table and the brain.
 *
 * The rig is a procedural skinned mesh: a twenty-one bone skeleton — pelvis,
 * three spine joints, clavicles, shoulders, elbows, wrists, hips, knees, ankles,
 * toes — with the geometry auto-weighted onto it by distance. That replaces the
 * old rig of six rigid meshes, and it is the whole reason these read as people
 * now rather than as jointed dolls:
 *
 *   - limbs bend. A knee that folds through the swing and an ankle that keeps
 *     the sole flat on the ground during stance is the difference between
 *     walking and two pendulums swinging under a box;
 *   - the torso is one continuous surface from hip to collarbone, so it can
 *     lean, twist and counter-rotate against the pelvis instead of hinging at a
 *     seam;
 *   - hands exist and can be put somewhere, which is why the hunters now hold
 *     their rifles instead of wearing them.
 *
 * It is also *cheaper*: a villager is two draw calls (skin, cloth) where it used
 * to be six, because vertex colours let one buffer carry five palettes at once.
 * With fifty-two of these alive that is two hundred calls back.
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { HUMAN, HUT } from '../config'
import { clamp, damp, Rng } from '../engine/rng'
import { textures } from '../world/textures'
import { terrainHeight, World } from '../world/world'
import type { Hut } from '../world/village'
import {
  addWoundShading, clearWounds, createWoundSet, cutWound, extendRun, RUN_SLOTS, startRun,
} from './wounds'

export type HumanKind = 'villager' | 'hunter'
/** What a pool slot was built wearing. Baked once; see buildRig. */
export type Dress = 'shirt' | 'vest' | 'bare'
export type Lower = 'trouser' | 'dhoti' | 'shorts'
export type HumanState = 'wander' | 'suspicious' | 'flee' | 'hide' | 'hunt' | 'panic' | 'dead'

/**
 * What opened the wound. Claws rake and jaws puncture, and the two leave marks
 * a player can tell apart without ever being told to look — which is the point
 * of carrying the distinction this far down at all.
 */
export type BlowKind = 'claw' | 'bite'

export interface ShotEvent {
  origin: THREE.Vector3
  dir: THREE.Vector3
  damage: number
  hit: boolean
}

/**
 * Skin. Far darker than a swatch suggests, and darker again than it used to be.
 *
 * The reason is a calibration mismatch, and it was the single most damaging
 * thing about these bodies. Measured in engine at the high sun, on a villager's
 * chest: a diffuse albedo of 0.041 linear renders as mid grey (sRGB 0.50), 0.08
 * renders 0.71, and 0.15 renders 0.90. Every *world* surface sits down at the
 * bottom of that range because every world surface is a photoscanned set — the
 * clay a hut is walled with means 0.186/0.090/0.046 linear at its brightest and
 * carries an aoMap and a normal map to break it up. The skin layer has no map at
 * all, so whatever is in this table *is* the albedo, flat, over the whole body.
 * The old table was 0.053-0.238 linear and measured 0.42-0.97 sRGB on screen: a
 * mid-brown man came out the brightest thing in the frame bar the clouds.
 *
 * These are 0.030-0.078 linear, which measures 0.42-0.70. The tonal range that
 * an albedo map would have given comes from CREASE instead.
 */
const SKIN = [0x3f291b, 0x462f20, 0x372216, 0x4f3626, 0x301d13]
/** Garment palettes are multiplied by the cloth weave map, whose own mean is
 * about a quarter, so they are already four times down and need no such cut.
 *
 * Four of the six used to be brown or khaki and one of those was a rust at the
 * same hue as skin, so a shirted man at twenty metres read as a bare one in a
 * slightly different brown — the same failure as finding one, arrived at from
 * the other direction. The replacements hold the same luminance to within 5%
 * (0.24-0.35 linear) and only move in hue: madder, indigo and a dull green in
 * place of the rust, the second khaki and the second brown. */
const SHIRT = [0x59653f, 0x8e4136, 0x3d4a58, 0x3f5878, 0x7d684a, 0x36462f]
const HUNTER_SHIRT = [0x333d2a, 0x3d3325, 0x2b333c]
const TROUSER = [0x3d3527, 0x4a4030, 0x2e2a22, 0x554c3c, 0x6a6152, 0x484030]
const HAIR = [0x241a13, 0x1b1410, 0x3a2a1c]
/** Grey hair and white beards, on the same scale as SKIN — and they were not.
 * At 0.156 and 0.245 linear an elder's beard rendered above 0.9 sRGB, which is
 * why it read as a surgical mask stuck over the mouth rather than as hair.
 *
 * The first cut to 0.079 and 0.113 was still not enough. By this file's own
 * calibration 0.113 linear renders about 0.80 sRGB, and measured on the model it
 * did: a grey beard came out the brightest surface in the frame, brighter than
 * the thatch, brighter than the clay, and two shades above the face it sat on.
 * White hair is not a white surface — it is a mid-grey one that reads as white
 * because of what it is next to. 0.052 and 0.070 linear put it a stop and a half
 * over the skin, which is the whole contrast a head of grey hair actually has. */
const GREY = [0x433f39, 0x4d4941]
const TURBAN = [0xb0a48b, 0xa5522c, 0xbdb39c, 0x5f7488, 0xa8873c, 0x93362d]

/** Leather, felt and brass on the hunters' kit. */
const LEATHER = 0x513520
const FELT = 0x3f342a
const BRASS = 0xa9853f
/** Eyes, mouth and nostrils. Not black — black reads as a hole at any distance. */
const DARK = 0x140d09
/** The white of an eye, on the same scale as SKIN and then sunk in the orbital
 * shadow on top of that. Anything actually white here is a headlamp — and 0.145
 * linear, which is what the previous value was, is a headlamp: it renders near
 * 0.89 sRGB, so what showed through the 9 mm of opening between the lids was two
 * hard specks brighter than anything else on the body, and a dark face with two
 * bright dots on it is a cartoon face. 0.062 linear reads as the wet white it is
 * without being the first thing the eye finds on the model. */
const SCLERA = 0x494540
/** Iris. Dark enough to read as a pupil at forty metres, brown enough to read
 * as an iris at two. */
const IRIS = 0x241610

/**
 * Which palette slot a vertex belongs to. Everything is one buffer, so recolouring
 * a recycled body means rewriting colours rather than swapping materials.
 */
const enum Reg { skin = 0, shirt = 1, trouser = 2, fixed = 3 }

const TAU = Math.PI * 2
const UP = new THREE.Vector3(0, 1, 0)

// -------------------------------------------------------------- geometry
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

/**
 * A tapered tube between two points, built in body space. `ra` is the radius at
 * `a`. Authoring limbs as "from this joint to that joint" rather than as a
 * cylinder plus a rotation is what keeps the mesh and the skeleton agreeing:
 * both are written in terms of the same joint positions.
 */
function tube(a: THREE.Vector3, b: THREE.Vector3, ra: number, rb: number, radial = 7): THREE.BufferGeometry {
  const dir = new THREE.Vector3().subVectors(b, a)
  const len = dir.length()
  const g = new THREE.CylinderGeometry(rb, ra, len, radial, 1, true)
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir.divideScalar(len)))
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2)
  return g
}

/** Scaled sphere. Does most of the modelling — muscle bellies, skull, joints. */
function ell(x: number, y: number, z: number, rx: number, ry: number, rz: number, w = 8, h = 6): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, w, h)
  g.scale(rx, ry, rz)
  g.translate(x, y, z)
  return g
}

/** Vertical oval-section trunk, open-ended: the torso and the skirts. */
function trunk(y0: number, y1: number, r0: number, r1: number, z: number, radial = 12): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, y1 - y0, radial, 1, true)
  g.scale(1, 1, z)
  g.translate(0, (y0 + y1) / 2, 0)
  return g
}

function slab(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d)
  g.translate(x, y, z)
  return g
}

/** One ring of a swept surface: height, half-width, half-depth, fore-aft centre. */
type Ring = readonly [number, number, number, number]

/**
 * A closed surface lofted through a stack of elliptical rings.
 *
 * The torso used to be five overlapping primitives and two of them fought. At
 * y = 1.275 the chest cone's half-width was 0.1592 and its half-depth 0.1114,
 * while the ribcage ellipsoid over it was 0.1560 and 0.1120: the ribcage was
 * 3.2 mm *inside* at the flanks and 0.6 mm *outside* at the breastbone, so the
 * two shells crossed somewhere over the pectorals and the whole chest carried a
 * stipple of z-fighting. Under a cloth map you never saw it. On bare skin it was
 * the first thing you saw.
 *
 * A sweep cannot fight itself. It also buys two things a stack of cones cannot:
 * a waist genuinely narrower than both the hips and the ribs above it (a cone
 * can only taper one way), and a per-ring fore-aft offset, which is the lumbar
 * curve and the seat.
 *
 * An end ring with no width and no depth is a cap: one apex vertex and a fan,
 * the way loft() closes its top. That is what lets a limb end — a hand, a foot —
 * be one closed surface rather than a tube with a lid butted onto it. Note that
 * sweepSplit() below indexes rows off the head of the buffer and so may only be
 * given uncapped rings; the torso, its only caller, has none.
 */
function sweep(rings: readonly Ring[], radial = 12): THREE.BufferGeometry {
  const n = radial + 1
  const capped = (r: Ring) => r[1] <= 0 && r[2] <= 0
  const capLo = capped(rings[0]!)
  const capHi = capped(rings[rings.length - 1]!)
  const first = capLo ? 1 : 0
  const rows = rings.length - first - (capHi ? 1 : 0)
  const count = rows * n + (capLo ? 1 : 0) + (capHi ? 1 : 0)
  const pos = new Float32Array(count * 3)
  const uv = new Float32Array(count * 2)
  const idx: number[] = []
  // UVs in tiles of the cloth weave, not 0..1 over the whole surface. The weave
  // map is 64 px; stretched once round a metre of torso each thread is a
  // centimetre and a half wide, so it stops reading as cloth and becomes a soft
  // mottle over a shell that has nothing else on it. Twelve tiles round and one
  // per eight centimetres of height puts it back at the scale it was drawn at.
  // Twelve is an integer, so the seam still meets.
  const put = (i: number, x: number, y: number, z: number, u: number) => {
    pos[i * 3] = x
    pos[i * 3 + 1] = y
    pos[i * 3 + 2] = z
    uv[i * 2] = u * 12
    uv[i * 2 + 1] = y / 0.08
  }
  for (let r = 0; r < rows; r++) {
    const ring = rings[first + r]!
    for (let c = 0; c < n; c++) {
      const t = c / radial
      const a = t * TAU
      put(r * n + c, Math.sin(a) * ring[1], ring[0], ring[3] - Math.cos(a) * ring[2], t)
    }
  }
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < radial; c++) {
      const a = r * n + c
      const b = (r + 1) * n + c
      // Wound so the face normal points away from the axis. Rings must ascend
      // in y or the whole surface turns inside out and culls to nothing.
      idx.push(a, b, a + 1, a + 1, b, b + 1)
    }
  }
  // The apexes go on the end of the buffer, and each fan keeps the winding the
  // quad it replaces would have had. Collapsing a whole ring onto the point
  // instead would leave every triangle on it degenerate, and a degenerate
  // triangle contributes nothing to computeVertexNormals, so the tip would come
  // back with a null normal and render black.
  let apex = rows * n
  if (capLo) {
    const ring = rings[0]!
    put(apex, 0, ring[0], ring[3], 0.5)
    for (let c = 0; c < radial; c++) idx.push(apex, c, c + 1)
    apex++
  }
  if (capHi) {
    const ring = rings[rings.length - 1]!
    const base = (rows - 1) * n
    put(apex, 0, ring[0], ring[3], 0.5)
    for (let c = 0; c < radial; c++) idx.push(base + c, apex, base + c + 1)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  weldSeam(g, radial, rows)
  return g
}

/**
 * A sweep laid on its side: local +y becomes world -z, so the rings stack from
 * the heel forward and each one reads as [how far along the foot, half-width
 * across it, half-height, and how high its centre sits].
 *
 * A foot is a wedge and a wedge is a stack of sections that change width,
 * height and ground clearance independently along its length — which is exactly
 * a sweep's four numbers, and is exactly what a tube cannot do. Rigid, so the
 * welded seam normals survive the turn.
 */
function lie(g: THREE.BufferGeometry, x: number, z: number): THREE.BufferGeometry {
  return g.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2).setPosition(x, 0, z))
}

/**
 * Average the normals of the two coincident vertices that close each ring.
 *
 * A ring carries radial+1 vertices so the last one can hold the wrapped UV, and
 * the two copies sit exactly on top of each other — but computeVertexNormals
 * only sees the faces on each copy's own side, so each comes out rotated half a
 * facet from the truth, in opposite directions. Measured on a shirt at y 1.030,
 * where the other fifteen vertices of the ring matched the ellipse's analytic
 * normal to within a tenth of a degree, the two seam copies came out at +7.9 and
 * -7.8 degrees against a true 0. A 15.7-degree kink is as strong a crease as a
 * facet edge, and since c = 0 is sin and cos of zero it lands dead centre front:
 * that is the hard vertical ridge down the middle of every shirt in the village.
 *
 * Only the lofts here need it. Three's own cylinders and spheres split their
 * seam the same way but write analytic normals, so both copies already agree.
 */
function weldSeam(g: THREE.BufferGeometry, radial: number, rows: number) {
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute
  const n = radial + 1
  for (let r = 0; r < rows; r++) {
    const a = r * n
    const b = a + radial
    const x = (nrm.getX(a) + nrm.getX(b)) / 2
    const y = (nrm.getY(a) + nrm.getY(b)) / 2
    const z = (nrm.getZ(a) + nrm.getZ(b)) / 2
    const l = Math.hypot(x, y, z) || 1
    nrm.setXYZ(a, x / l, y / l, z / l)
    nrm.setXYZ(b, x / l, y / l, z / l)
  }
}

/**
 * The same sweep cut in two at ring `at`, so the halves can bind to different
 * bone sets without a seam showing between them.
 *
 * Two separate sweeps meeting on a shared ring have no gap — at rest they are
 * the same circle — but each one computes that ring's normals from its own side
 * only, so the two disagree by half the surface's curvature and the join renders
 * as a bright line straight across the chest. Slicing one finished surface keeps
 * the normals the whole surface computed.
 */
function sweepSplit(
  rings: readonly Ring[], at: number, radial = 12,
): [THREE.BufferGeometry, THREE.BufferGeometry] {
  const full = sweep(rings, radial)
  const n = radial + 1
  const cut = (r0: number, r1: number) => {
    const g = new THREE.BufferGeometry()
    const v0 = r0 * n
    const cnt = (r1 - r0 + 1) * n
    for (const [k, w] of [['position', 3], ['normal', 3], ['uv', 2]] as const) {
      const a = full.getAttribute(k).array as Float32Array
      g.setAttribute(k, new THREE.BufferAttribute(a.slice(v0 * w, (v0 + cnt) * w), w))
    }
    const idx: number[] = []
    for (let r = 0; r < r1 - r0; r++) {
      for (let c = 0; c < radial; c++) {
        const a = r * n + c
        const b = (r + 1) * n + c
        idx.push(a, b, a + 1, a + 1, b, b + 1)
      }
    }
    g.setIndex(idx)
    return g
  }
  // The halves overlap by a whole ring rather than meeting on one. Sharing a
  // ring is exact in the bind pose and only in the bind pose: the two copies of
  // it are weighted to different bone sets, so the moment the hips and the chest
  // stop agreeing — which is every frame, breathing alone does it — they part by
  // a few tenths of a millimetre and the daylight behind the model comes through
  // as a bright hairline straight across the chest. Measured at y 1.170 on the
  // shirt, which is exactly where SHIRT_SPLIT is. Overlapped, the same divergence
  // just slides one shirt-coloured surface a hair inside another one.
  return [cut(0, at + 1), cut(at, rings.length - 1)]
}

/** One hoop of a limb loft: height, and radius about the limb's axis. */
type Hoop = readonly [number, number]

/**
 * A tube of varying radius threaded on the line a->b, closed at the top if the
 * last hoop's radius is zero.
 *
 * A sleeve was a ball for the shoulder plus one or two cones for the arm, and
 * every join between those was a place where two surfaces computed their normals
 * from their own side only and disagreed. The shoulder ball's own pole was
 * another one: a sphere splits its apex into one vertex per column, so the crown
 * of every sleeve head carried a dark point. One surface has none of that, and
 * it also lets the cap profile be authored freely rather than being whatever an
 * ellipsoid happens to do — a sleeve head is not a hemisphere, it is nearly
 * straight off the shoulder line and then turns hard at the top.
 *
 * Hoops ascend in y, like sweep's rings, and for the same reason.
 */
function loft(a: THREE.Vector3, b: THREE.Vector3, hoops: readonly Hoop[], radial = 12): THREE.BufferGeometry {
  const n = radial + 1
  const capped = hoops[hoops.length - 1]![1] <= 0
  const rows = capped ? hoops.length - 1 : hoops.length
  const y0 = hoops[0]![0]
  const y1 = hoops[hoops.length - 1]![0]
  const count = rows * n + (capped ? 1 : 0)
  const pos = new Float32Array(count * 3)
  const uv = new Float32Array(count * 2)
  const idx: number[] = []
  const put = (i: number, x: number, y: number, z: number, u: number, v: number) => {
    pos[i * 3] = x
    pos[i * 3 + 1] = y
    pos[i * 3 + 2] = z
    uv[i * 2] = u
    uv[i * 2 + 1] = v
  }
  /** Where the axis is at this height. */
  const axis = (y: number) => (y - a.y) / (b.y - a.y)
  for (let r = 0; r < rows; r++) {
    const [y, rad] = hoops[r]!
    const t = axis(y)
    const cx = a.x + (b.x - a.x) * t
    const cz = a.z + (b.z - a.z) * t
    for (let c = 0; c < n; c++) {
      const u = c / radial
      // 0..1, so reweave() can retile it off the finished bounding box; the
      // sleeve is a fifth of the torso's circumference and would carry the
      // weave at five times the scale if it copied sweep's fixed twelve tiles.
      put(r * n + c, cx + Math.sin(u * TAU) * rad, y, cz - Math.cos(u * TAU) * rad, u, (y - y0) / (y1 - y0))
    }
  }
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < radial; c++) {
      const p = r * n + c
      const q = (r + 1) * n + c
      idx.push(p, q, p + 1, p + 1, q, q + 1)
    }
  }
  if (capped) {
    const t = axis(y1)
    put(count - 1, a.x + (b.x - a.x) * t, y1, a.z + (b.z - a.z) * t, 0.5, 1)
    for (let c = 0; c < radial; c++) idx.push((rows - 1) * n + c, count - 1, (rows - 1) * n + c + 1)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  weldSeam(g, radial, rows)
  return g
}

/** Tiles of the cloth weave per metre. Set by sweep(); everything else matches it. */
const WEAVE = 12

/**
 * Retile a primitive's 0..1 UVs to the weave's real scale, from its own size.
 *
 * A weave map only reads as a weave at the size it was drawn at, and sweep() is
 * the only thing in here that says so — a tube() or an ell() runs its UVs 0..1
 * over whatever it happens to be. So the same 64 px cloth came out as fine
 * speckle on the shirt body and as fist-sized blotches on the shoulder cap and
 * the sleeve right beside it, and a shoulder covered in blotches at a different
 * scale from the panel next to it is what "gathered" looks like. That mismatch,
 * not the polygon count, is most of what still made the shoulders read as puffed.
 *
 * u wraps a circumference on every primitive used here except the box strips, so
 * it is scaled by pi x width; v runs the height. Anything already tiled — a
 * sweep — is left alone.
 */
function reweave(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const uv = g.getAttribute('uv') as THREE.BufferAttribute | undefined
  if (!uv) return g
  for (let i = 0; i < uv.count; i++) if (uv.getX(i) > 1.5 || uv.getY(i) > 1.5) return g
  g.computeBoundingBox()
  const s = g.boundingBox!.getSize(new THREE.Vector3())
  const u = Math.max(0.2, Math.max(s.x, s.z) * Math.PI * WEAVE)
  const v = Math.max(0.2, s.y * WEAVE)
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * u, uv.getY(i) * v)
  return g
}

/**
 * A flat oriented band: cloth. `w` across, `thick` through, running a->b with
 * `out` as the face direction.
 *
 * The shawl used to be a 5.5 cm tube from the shoulder to the hip, which is the
 * exact description of a bandolier, and that is what it read as on every bare
 * villager in the village. Cloth is wide and thin. Nothing else about the shape
 * matters as much as that ratio.
 */
function strip(a: THREE.Vector3, b: THREE.Vector3, w: number, thick: number, out: THREE.Vector3, grow = 0): THREE.BufferGeometry {
  const y = new THREE.Vector3().subVectors(b, a)
  const len = y.length()
  y.divideScalar(len)
  const z = out.clone().normalize()
  const x = new THREE.Vector3().crossVectors(y, z).normalize()
  z.crossVectors(x, y).normalize()
  // `grow` runs the band past both ends. A drape is a chain of these and each
  // joint changes direction, so butted end to end they open a wedge of daylight
  // on the outside of every bend; overrunning by a centimetre closes it.
  const g = new THREE.BoxGeometry(w, len + grow * 2, thick)
  g.applyMatrix4(new THREE.Matrix4().makeBasis(x, y, z))
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2)
  return g
}

/** One node of a drape: where the cloth passes, how wide it is there, and which
 * way its face points. */
type Node = { p: THREE.Vector3; w: number; out: THREE.Vector3 }

/** Uniform Catmull-Rom through p1..p2, componentwise on whatever is passed. */
function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t
  return 0.5 * (2 * p1 + (p2 - p0) * t
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
    + (3 * p1 - 3 * p2 + p3 - p0) * t2 * t)
}

/**
 * One continuous length of cloth swept along a path: a drape, as opposed to the
 * chain of boxes that `strip` builds.
 *
 * The shawl was five strips butted end to end, and a box has square corners and
 * one fixed idea of which way is out. Every joint between two of them therefore
 * opened a notch of daylight on the outside of the bend and pushed a corner
 * through the cloth on the inside, and the widths stepped between sections as
 * well — so what should have read as a length of cloth over one shoulder read as
 * a torn red zigzag with holes in it. It was the worst artefact on the model and
 * no amount of adjusting the five sets of numbers could fix it, because the
 * defect is in the joints, and the joints exist because there are five pieces.
 *
 * There is one piece here. The path runs through a Catmull-Rom, so a bend is a
 * curve; the width is interpolated along the same parameter, so it never steps;
 * and the section is a rounded rectangle rather than a box, which is what lets
 * the edge of the cloth catch a highlight along its whole length instead of
 * presenting a 90-degree corner that is either lit or not. Being one surface, its
 * normals are computed across the joins rather than up to them.
 *
 * `seg` samples per input span. Ends are closed with a fan; a drape hanging off a
 * hip has a visible end and an open rim there is a hole straight into the model.
 */
function ribbon(nodes: readonly Node[], thick: number, seg = 6, radial = 10): THREE.BufferGeometry {
  const n = nodes.length
  const at = (i: number) => nodes[Math.max(0, Math.min(n - 1, i))]!
  const rows: { p: THREE.Vector3; w: number; out: THREE.Vector3 }[] = []
  for (let i = 0; i < n - 1; i++) {
    const [a, b, c, d] = [at(i - 1), at(i), at(i + 1), at(i + 2)]
    // The last span carries its endpoint; the others stop short of it so rows
    // are not duplicated at the knots.
    const last = i === n - 2 ? seg : seg - 1
    for (let k = 0; k <= last; k++) {
      const t = k / seg
      const cm = (f: (x: Node) => number) => catmull(f(a), f(b), f(c), f(d), t)
      rows.push({
        p: V(cm((x) => x.p.x), cm((x) => x.p.y), cm((x) => x.p.z)),
        w: cm((x) => x.w),
        out: V(cm((x) => x.out.x), cm((x) => x.out.y), cm((x) => x.out.z)),
      })
    }
  }

  const m = rows.length
  const cols = radial + 1
  const count = m * cols + 2
  const pos = new Float32Array(count * 3)
  const uv = new Float32Array(count * 2)
  const idx: number[] = []
  // 0.45 rather than 1: at 1 the section is an ellipse and the cloth is a
  // flattened tube, at 0 it is the box we are getting away from. Between them is
  // a rounded rectangle — two broad faces and a soft edge, which is hemmed cloth.
  const ROUND = 0.45
  const tan = new THREE.Vector3()
  const ax = new THREE.Vector3()
  const az = new THREE.Vector3()
  for (let r = 0; r < m; r++) {
    const row = rows[r]!
    tan.subVectors(at2(rows, r + 1).p, at2(rows, r - 1).p).normalize()
    az.copy(row.out).normalize()
    ax.crossVectors(tan, az).normalize()
    az.crossVectors(ax, tan).normalize()
    const hw = row.w / 2
    const ht = thick / 2
    for (let c = 0; c <= radial; c++) {
      const th = (c / radial) * TAU
      const cs = Math.cos(th)
      const sn = Math.sin(th)
      const u = hw * Math.sign(cs) * Math.abs(cs) ** ROUND
      const v = ht * Math.sign(sn) * Math.abs(sn) ** ROUND
      const i = r * cols + c
      pos[i * 3] = row.p.x + ax.x * u + az.x * v
      pos[i * 3 + 1] = row.p.y + ax.y * u + az.y * v
      pos[i * 3 + 2] = row.p.z + ax.z * u + az.z * v
      uv[i * 2] = c / radial
      uv[i * 2 + 1] = r / (m - 1)
    }
    if (r === 0) continue
    for (let c = 0; c < radial; c++) {
      const a = (r - 1) * cols + c
      const b = r * cols + c
      idx.push(a, b, a + 1, a + 1, b, b + 1)
    }
  }
  // End caps, as a fan on the row's own centre.
  for (const [r, k] of [[0, m * cols], [m - 1, m * cols + 1]] as const) {
    const row = rows[r]!
    pos[k * 3] = row.p.x
    pos[k * 3 + 1] = row.p.y
    pos[k * 3 + 2] = row.p.z
    uv[k * 2] = 0.5
    uv[k * 2 + 1] = r / (m - 1)
    for (let c = 0; c < radial; c++) {
      const a = r * cols + c
      if (r === 0) idx.push(k, a + 1, a)
      else idx.push(k, a, a + 1)
    }
  }

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  weldSeam(g, radial, m)
  return g
}

/** Clamped row lookup, so the tangent at either end is one-sided. */
function at2<T>(a: readonly T[], i: number): T {
  return a[Math.max(0, Math.min(a.length - 1, i))]!
}

// ------------------------------------------------------------------ rig
interface BoneDef {
  name: string
  parent: string | null
  /** Rest position, in body space. */
  p: THREE.Vector3
  /**
   * Far end of this bone's influence. Weighting measures distance to the
   * segment p->tip, not to the joint: a point measured from a joint pulls in
   * a sphere, and a sphere around the hip claims half the other thigh.
   */
  tip: THREE.Vector3
}

/**
 * Joint positions for a 1.72 m person, in fractions of stature that a figure
 * artist would recognise: acromion 0.818, elbow 0.612, wrist 0.463, crotch 0.47,
 * knee 0.285, ankle 0.043. Seven and a half heads, which is the proportion that
 * stops a figure reading as a child or a cartoon.
 *
 * The four numbers that were wrong before, and each is a mannequin tell on its
 * own:
 *
 *   - the arm was 10 cm short, with the elbow above the navel and the wrist above
 *     the crotch. Short arms are the single strongest childlike cue there is; the
 *     wrist belongs level with the crotch and the fingertips at mid-thigh;
 *   - the thigh was 6 cm longer than the shin. They are within a centimetre of
 *     each other on a real skeleton, and the mismatch is what made the legs read
 *     as stumpy;
 *   - the shoulder sat at 1.42 with the chin at 1.49, which is a 7 cm neck. The
 *     acromion belongs at 1.41 and the joint 2 cm under it;
 *   - the head was 18 cm wide. A skull is 15 cm wide and 20 deep — narrow and
 *     long. Anything rounder is a bobblehead.
 */
const RIG: BoneDef[] = (() => {
  const list: BoneDef[] = [
    { name: 'hips', parent: null, p: V(0, 0.92, 0), tip: V(0, 1.075, 0) },
    { name: 'spine', parent: 'hips', p: V(0, 1.075, 0), tip: V(0, 1.245, 0) },
    { name: 'chest', parent: 'spine', p: V(0, 1.245, 0), tip: V(0, 1.415, 0) },
    // Carries the dhoti and nothing else. It never rotates — it exists to be
    // *scaled*, because a wrapped skirt bound rigidly to the pelvis is a cone,
    // and a cone does not care that its wearer is lying down. On a corpse that
    // read as a lampshade round the hips with two legs coming out of it, which
    // is the single loudest tell left on a body on the ground.
    { name: 'skirt', parent: 'hips', p: V(0, 0.92, 0), tip: V(0, 0.60, 0) },
    { name: 'neck', parent: 'chest', p: V(0, 1.415, 0.01), tip: V(0, 1.52, 0.012) },
    { name: 'head', parent: 'neck', p: V(0, 1.52, 0.012), tip: V(0, 1.66, 0.016) },
  ]
  for (const side of ['L', 'R'] as const) {
    const s = side === 'L' ? -1 : 1
    list.push(
      { name: `clav${side}`, parent: 'chest', p: V(s * 0.042, 1.402, 0.004), tip: V(s * 0.158, 1.383, 0) },
      { name: `arm${side}`, parent: `clav${side}`, p: V(s * 0.158, 1.383, 0), tip: V(s * 0.182, 1.053, 0) },
      { name: `fore${side}`, parent: `arm${side}`, p: V(s * 0.182, 1.053, 0), tip: V(s * 0.196, 0.797, 0) },
      { name: `hand${side}`, parent: `fore${side}`, p: V(s * 0.196, 0.797, 0), tip: V(s * 0.2, 0.69, -0.008) },
      { name: `thigh${side}`, parent: 'hips', p: V(s * 0.085, 0.92, 0), tip: V(s * 0.088, 0.495, 0) },
      { name: `shin${side}`, parent: `thigh${side}`, p: V(s * 0.088, 0.495, 0), tip: V(s * 0.092, 0.075, 0) },
      { name: `foot${side}`, parent: `shin${side}`, p: V(s * 0.092, 0.075, 0), tip: V(s * 0.092, 0.028, -0.115) },
      { name: `toe${side}`, parent: `foot${side}`, p: V(s * 0.092, 0.028, -0.115), tip: V(s * 0.092, 0.024, -0.175) },
    )
  }
  return list
})()

/** Segment lengths the leg IK solves against, and the foot's contact geometry:
 * sole below the ankle, heel behind it, ball in front. The gait rolls the foot
 * from the heel point to the ball point and pivots about whichever is down. */
const L_THIGH = 0.425
const L_SHIN = 0.42
/** Never quite locked: a leg solved to full extension pops, and the knee angle
 * is so sensitive in the last two percent that 0.997 is the difference between
 * heel strike at 7 degrees of flex (right) and at 24 (a permanent sneak). */
const L_REACH = (L_THIGH + L_SHIN) * 0.997
const SOLE = 0.075
const HEEL_Z = 0.055
const BALL_Z = -0.115

const BONE_AT = new Map(RIG.map((b, i) => [b.name, i]))

/** Bone sets a part may bind to. Restricting the set is what keeps the inner
 * thigh from welding itself to the other leg — proximity alone cannot tell the
 * two apart, and no amount of falloff tuning fixes it. */
const B_SPINE = ['hips', 'spine', 'chest']
/** Shoulders and ribs. Deliberately excludes the neck: the trapezius runs out to
 * x 0.12, which is as far from the chest axis as it is from the neck axis, so a
 * set containing both hands the outer shoulder a fifty-fifty blend and the whole
 * shoulder line shears every time the head turns. */
const B_CHEST = ['spine', 'chest']
/**
 * The head is one rigid piece.
 *
 * It has to be. The neck bone's segment ends exactly where the head's begins, and
 * the entire lower face — jaw, chin, mouth — is nearer the neck's axis than the
 * head's, so distance weighting handed the chin 64% to the neck. On every corpse
 * (head rolls 34 degrees) the jaw slid a centimetre and a half out of the face.
 * Nothing about a skull deforms, so nothing about it needs two bones.
 */
const B_HEAD = ['head']
/** The neck itself does deform, and its base has to stay welded to the chest. */
const B_NECK = ['chest', 'neck', 'head']
const B_ARM = (s: string) => [`clav${s}`, `arm${s}`, `fore${s}`, `hand${s}`]
const B_LEG = (s: string) => ['hips', `thigh${s}`, `shin${s}`, `foot${s}`]

type Layer = 'skin' | 'cloth'
interface Part {
  g: THREE.BufferGeometry
  bones: string[]
  layer: Layer
  region: Reg
  /** Only read for Reg.fixed parts. */
  hex: number
  /**
   * Worn by one kind only. Geometry is baked once per pool slot and a slot comes
   * back as either a villager or a hunter, so anything kind-specific has to be
   * built for both and switched off — see the index swap in the assembly below.
   */
  only?: HumanKind
}

// ------------------------------------------------------ torso profile
/**
 * The torso section, hips to the base of the neck, at unit girth.
 *
 * Rings of [y, half-width, half-depth, fore-aft centre]. The waist minimum is at
 * 1.085 and is narrower than both the hips below it and the ribs above — the old
 * stack of cones could only taper one way at a time, so it had no waist at all
 * and the body read as a barrel. The centre column is the spinal curve: the seat
 * pushed back at the bottom, the lumbar tucked in, the ribs carried forward.
 *
 * Garments are derived from this rather than guessed, which is the only reliable
 * way to keep a hem outside the body it is meant to be hanging on.
 */
const TORSO: readonly Ring[] = [
  [0.772, 0.006, 0.006, 0.000],  // closed at the perineum, buried between the thighs
  [0.788, 0.052, 0.040, 0.004],
  [0.828, 0.108, 0.084, 0.012],
  [0.862, 0.136, 0.102, 0.016],
  [0.895, 0.150, 0.111, 0.018],  // widest at the hips
  [0.930, 0.153, 0.109, 0.010],
  [0.975, 0.148, 0.104, 0.002],
  [1.030, 0.140, 0.098, -0.004],
  [1.085, 0.133, 0.093, -0.008],  // waist
  [1.135, 0.137, 0.096, -0.008],
  [1.190, 0.147, 0.102, -0.006],
  [1.240, 0.156, 0.107, -0.002],
  [1.290, 0.161, 0.110, 0.002],  // widest at the ribs; 0.32 across, not 0.36 —
  [1.335, 0.157, 0.105, 0.008],  // at 0.36 the arms hang inside the ribcage
  [1.375, 0.138, 0.090, 0.012],
  [1.405, 0.108, 0.072, 0.014],
  [1.430, 0.048, 0.042, 0.014],  // inside the neck tube, so the rim never shows
]

/**
 * The same section as worn by a shirt: hem to collar, one surface.
 *
 * A shirt is not the torso with a gap added, and the difference is the whole
 * reason the shirted villagers read as women. Measured off the old build, the
 * silhouette went 0.161 at the ribs, 0.137 at the waist and 0.184 at the hem —
 * chest, nipped waist, flared skirt, which is a fitted bodice with a peplum. It
 * had that shape because the shirt was the body sweep (which has a real waist,
 * and should) with a hem cone ramped outward over the hips on top of it.
 *
 * Cloth hung off a pair of shoulders does none of that. From the ribs down this
 * holds 0.162 and drifts out four millimetres to the hem, which is 2.9 cm clear
 * of the waist underneath and 1.6 cm clear of the hips: it hangs. Above the ribs
 * it follows the body, because a shirt does take the shape of the shoulders.
 *
 * The last three rings are the collar, folded into the same surface. As a
 * separate tube it had to start somewhere, and wherever that was left either a
 * visible rim or — at 1.478, which is 78% of the way up the neck — a polo neck.
 * Ending the sweep by turning up and then in at 1.442 gives an open collar with
 * seven centimetres of throat above it and no rim anywhere.
 */
const SHIRT_CUT: readonly Ring[] = [
  [0.886, 0.150, 0.104, 0.008],  // turned under: the hem has a thickness
  [0.894, 0.166, 0.116, 0.008],  // the hem line
  [0.960, 0.164, 0.114, 0.004],
  [1.030, 0.163, 0.113, 0.000],
  [1.100, 0.162, 0.112, -0.002],
  [1.170, 0.162, 0.112, -0.002],
  [1.240, 0.162, 0.112, 0.000],
  [1.290, 0.163, 0.112, 0.002],
  // The yoke. These three were the torso's own numbers plus a couple of
  // millimetres, which made the shirt *narrower* at the shoulder (0.160) than at
  // the ribs (0.163) — a garment whose widest point is the bust and which tapers
  // up to the shoulder, which is a woman's blouse and not a man's shirt. Worse,
  // a shirt that stops at 0.160 leaves the deltoid ball (centre 0.158, radius
  // 0.072) standing 7 cm proud of it on each side with nothing but its own
  // outline joining the two, and a rounded lump sitting on a shoulder that ends
  // short of it is exactly the puffed sleeve head the whole pass is chasing.
  //
  // A shirt hangs off a pair of shoulders, so its widest point is the shoulders.
  // At 0.172 the yoke buries the deltoid to just past its centre and only 5.8 cm
  // of ball is left outside, which reads as the sleeve head of a set-in sleeve
  // rather than as a separate ball. It is 1.2 cm out from the torso at 1.335,
  // which is a shoulder seam sitting slightly proud, which is what they do.
  [1.335, 0.172, 0.110, 0.006],
  [1.375, 0.156, 0.096, 0.010],
  [1.405, 0.120, 0.078, 0.014],
  [1.418, 0.082, 0.072, 0.014],  // the neck hole, 2.7 cm clear of the throat
  [1.434, 0.074, 0.067, 0.014],  // collar band
  [1.442, 0.064, 0.059, 0.014],  // rolled in over the top edge
]
/** Rings 0..N of SHIRT_CUT go on the spine set, N.. on the chest set. */
const SHIRT_SPLIT = 5  // y = 1.170, far enough above the hips bone to weigh alike

/** The profile at any height, clamped at the ends. */
function torsoAt(y: number): [number, number, number] {
  if (y <= TORSO[0]![0]) return [TORSO[0]![1], TORSO[0]![2], TORSO[0]![3]]
  for (let i = 1; i < TORSO.length; i++) {
    const b = TORSO[i]!
    if (y > b[0]) continue
    const a = TORSO[i - 1]!
    const t = (y - a[0]) / (b[0] - a[0])
    return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t]
  }
  const l = TORSO[TORSO.length - 1]!
  return [l[1], l[2], l[3]]
}

/**
 * A point `gap` clear of the torso surface, at height `y` and angle `a` — 0
 * straight ahead, positive turning toward the wearer's right.
 *
 * Draped garments were authored in raw xyz before, which is why the shawl ended
 * up four centimetres off the chest at the shoulder and buried inside the
 * pectoral at the sternum: a straight line between two points on an ellipse cuts
 * a chord through everything between them.
 */
function torsoPoint(y: number, a: number, gap: number, girth = 1): THREE.Vector3 {
  const p = torsoAt(y)
  const rx = p[0] * girth
  const rz = p[1] * girth
  const sn = Math.sin(a)
  const cs = Math.cos(a)
  let nx = sn / rx
  let nz = -cs / rz
  const l = Math.hypot(nx, nz) || 1
  nx /= l
  nz /= l
  return V(sn * rx + nx * gap, y, p[2] - cs * rz + nz * gap)
}

/**
 * A patch of relief lying *on* the torso surface, between heights y0..y1 and
 * angles a0..a1, standing `peak` proud at its centre and sinking 1.5 mm inside
 * the body all the way round its border, so the open edges of the patch are
 * never visible and no rim can show.
 *
 * This exists because an axis-aligned ellipsoid cannot sit on a barrel. The
 * pectorals were a pair of them, and the arithmetic is why they read as breasts:
 * an ellipsoid 3 mm proud of the chest *at the breastbone* is 13 mm proud of the
 * ribcage out at its own centre, because the ribcage has curved 10 mm away by
 * then and the ellipsoid has not. What surfaces is a dome. A patch offset along
 * the surface normal stands the same height everywhere and can have a hard lower
 * border and a soft upper one, which is the actual difference between a pectoral
 * and a breast.
 *
 * a0 must be less than a1 or the winding inverts; the left side is authored by
 * passing the negated range in ascending order.
 */
function relief(
  y0: number, y1: number, a0: number, a1: number,
  peak: number, girth: number, cols = 6, rows = 7,
): THREE.BufferGeometry {
  const s = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))
  const nc = cols + 1
  const pos = new Float32Array((rows + 1) * nc * 3)
  const uv = new Float32Array((rows + 1) * nc * 2)
  const idx: number[] = []
  for (let r = 0; r <= rows; r++) {
    const v = r / rows
    // Hard along the bottom, soft along the top: the shelf has a lower border
    // you can see and no upper border at all, it just becomes chest.
    const fv = s(v / 0.09) * s((1 - v) / 0.55)
    for (let c = 0; c < nc; c++) {
      const u = c / cols
      const fu = s(u / 0.28) * s((1 - u) / 0.28)
      const p = torsoPoint(y0 + (y1 - y0) * v, a0 + (a1 - a0) * u, peak * fu * fv - 0.0015, girth)
      const i = r * nc + c
      pos[i * 3] = p.x
      pos[i * 3 + 1] = p.y
      pos[i * 3 + 2] = p.z
      uv[i * 2] = u
      uv[i * 2 + 1] = v
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = r * nc + c
      const b = (r + 1) * nc + c
      idx.push(a, b, a + 1, a + 1, b, b + 1)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/**
 * Rings for a garment hugging the torso, `gap` clear of it at y0 ramping to
 * `gap1` at y1, in `steps` sections.
 *
 * The ramp is what lets a hem hang: a garment worn over another one has to end
 * up further off the body than the one underneath, or its last few centimetres
 * are simply inside it and the hem you see is the wrong garment's.
 */
function garmentRings(y0: number, y1: number, gap: number, steps: number, girth = 1, gap1 = gap): Ring[] {
  const out: Ring[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const y = y0 + (y1 - y0) * t
    const g = gap + (gap1 - gap) * t
    const p = torsoAt(y)
    out.push([y, p[0] * girth + g, p[1] * girth + g, p[2]])
  }
  return out
}

// -------------------------------------------------------------- shading
/**
 * Authored ambient occlusion, baked into the vertex colours.
 *
 * Every other diffuse surface in this world carries an aoMap and a normal map;
 * the skin layer has no maps at all, so without this a body is one flat value
 * from the crown to the soles and reads as something cast in a mould. The light
 * cannot rescue it either: measured on a villager's chest at the high sun,
 * zeroing the key light moved it 0.89 -> 0.81 sRGB while zeroing the sky IBL
 * moved it to 0.24. Nine tenths of the light on a human arrives from the whole
 * dome at once, which is another way of saying there is almost no form shading
 * to be had for free.
 *
 * Each entry is an ellipsoidal well of shadow in body space: a place where two
 * forms meet and light cannot get in. Half of them are on the face, because the
 * face is what the player is looking at when the tiger is close enough to kill.
 */
interface Crease {
  x: number
  y: number
  z: number
  rx: number
  ry: number
  rz: number
  /** Darkening at the centre, 0..1. */
  k: number
  /**
   * Skip this one on the cloth layer.
   *
   * The list was authored against a bare torso and then applied to every vertex
   * of every layer, so a shirt got the wearer's anatomy painted onto it: the
   * under-pectoral shadow landed 2 cm inside the shirt's own front surface and
   * came out as a horizontal shadow under two soft panels — which is what a
   * bust dart looks like, and is most of why the shirted villagers still read
   * as women after the pectoral *geometry* was already suppressed. The armpit
   * well did the same to the front of the shoulder: a hard vertical groove
   * between the chest and the sleeve head, which turns a set-in sleeve back
   * into a separate puffed tube stuck on the side.
   *
   * Cloth creases where cloth folds — the groin, the seat, the inside of the
   * elbow, the back of the knee, the yoke at the neck — and those are left on.
   * What it does not do is show the navel.
   */
  anat?: true
}

const CREASE: Crease[] = (() => {
  const out: Crease[] = []
  const one = (x: number, y: number, z: number, rx: number, ry: number, rz: number, k: number) =>
    out.push({ x, y, z, rx, ry, rz, k })
  /** Mirrored pair; `x` is the right-hand one. */
  const two = (x: number, y: number, z: number, rx: number, ry: number, rz: number, k: number) => {
    one(x, y, z, rx, ry, rz, k)
    one(-x, y, z, rx, ry, rz, k)
  }
  /** Anatomy: skin only. See Crease.anat. */
  const skinOne = (x: number, y: number, z: number, rx: number, ry: number, rz: number, k: number) =>
    out.push({ x, y, z, rx, ry, rz, k, anat: true })
  const skinTwo = (x: number, y: number, z: number, rx: number, ry: number, rz: number, k: number) => {
    skinOne(x, y, z, rx, ry, rz, k)
    skinOne(-x, y, z, rx, ry, rz, k)
  }

  // Torso. The lower border of the pectoral is the one that matters: a male
  // chest is defined by a hard horizontal shadow under the muscle, not by the
  // silhouette, which is why the old hemispherical pecs could only read as
  // breasts however they were coloured.
  skinTwo(0.112, 1.302, -0.004, 0.056, 0.066, 0.062, 0.55)   // armpit
  skinTwo(0.070, 1.264, -0.086, 0.082, 0.015, 0.044, 0.56)   // under the pectoral
  skinOne(0, 1.300, -0.104, 0.014, 0.062, 0.032, 0.34)       // sternal groove
  skinOne(0, 1.180, -0.100, 0.010, 0.072, 0.026, 0.20)       // linea alba
  skinOne(0, 1.128, -0.096, 0.020, 0.026, 0.026, 0.45)       // navel
  skinOne(0, 1.200, 0.098, 0.013, 0.175, 0.032, 0.32)        // spinal groove
  one(0, 0.905, -0.030, 0.056, 0.062, 0.056, 0.50)       // groin
  one(0, 0.882, 0.096, 0.016, 0.072, 0.046, 0.45)        // gluteal cleft
  two(0.052, 1.400, 0.004, 0.042, 0.052, 0.052, 0.45)    // where the neck leaves the trapezius
  one(0, 1.500, -0.020, 0.072, 0.030, 0.070, 0.55)       // under the jaw
  one(0, 1.478, -0.050, 0.046, 0.030, 0.030, 0.42)       // under the chin

  // Limbs: the flexion creases, which are the only shading a straight tube gets.
  two(0.176, 1.056, -0.032, 0.036, 0.046, 0.030, 0.38)   // inner elbow
  two(0.090, 0.498, 0.052, 0.052, 0.046, 0.030, 0.42)    // back of the knee
  // The hand's old single well was 6.0 x 9.2 x 8.4 cm centred on the knuckles,
  // which is the whole hand and then some: it took a flat 32% off every vertex
  // of it at once, and a uniform darkening is the opposite of form. It is why
  // the hands read as dark paddles even before you got to their shape. What
  // actually shades a hanging hand is the line at the base of the fingers, the
  // valleys between them, and the hollow under the wrist bones — all narrow.
  two(0.194, 0.7065, -0.014, 0.026, 0.011, 0.040, 0.34)  // the web
  two(0.190, 0.672, -0.030, 0.024, 0.028, 0.036, 0.18)   // down between the fingers
  two(0.196, 0.786, 0.000, 0.032, 0.009, 0.032, 0.20)    // wrist crease
  two(0.092, 0.098, 0.006, 0.046, 0.034, 0.042, 0.26)    // ankle hollow
  // A bare foot has two shadows worth the name, and the second is standing in
  // for the four toes that have no geometry of their own.
  two(0.072, 0.014, -0.022, 0.024, 0.018, 0.042, 0.30)   // under the arch
  two(0.082, 0.016, -0.156, 0.008, 0.014, 0.030, 0.34)   // beside the big toe

  // Face. The eye socket does most of the work: an eye is a wet ball at the
  // bottom of a hole, and the hole is the reason you can read a gaze at all.
  // The old face had none of this — two flat dark discs on a flat lit plane,
  // which is a drawing of a face rather than a face.
  two(0.032, 1.5995, -0.062, 0.028, 0.019, 0.032, 0.52)  // orbit
  two(0.033, 1.612, -0.070, 0.026, 0.013, 0.024, 0.32)   // under the brow ridge
  two(0.026, 1.572, -0.084, 0.015, 0.022, 0.022, 0.40)   // side of the nose
  two(0.027, 1.548, -0.080, 0.014, 0.020, 0.022, 0.40)   // nasolabial fold
  one(0, 1.5585, -0.090, 0.017, 0.009, 0.016, 0.42)      // under the nose
  one(0, 1.5375, -0.088, 0.028, 0.006, 0.016, 0.48)      // the mouth line itself
  two(0.021, 1.5375, -0.083, 0.011, 0.013, 0.018, 0.42)  // corners of the mouth
  one(0, 1.5215, -0.085, 0.019, 0.008, 0.016, 0.38)      // under the lower lip
  two(0.070, 1.588, 0.014, 0.020, 0.032, 0.020, 0.48)    // behind the ear
  two(0.062, 1.618, -0.046, 0.021, 0.028, 0.026, 0.22)   // temple
  return out
})()

/**
 * Occlusion at a body-space point.
 *
 * The floor of 0.34 is there because this is multiplied into an albedo that is
 * already down at 0.03-0.08 linear: below the floor a crease stops reading as a
 * crease and starts reading as a hole punched in the model.
 */
function shadeAt(x: number, y: number, z: number, cloth = false): number {
  let s = 1
  for (const c of CREASE) {
    // Cheap reject first. Thirty-three fields against three thousand vertices
    // against fifty-two pooled bodies is six million tests at load; the y test
    // throws out nine in ten of them before any division.
    if (y < c.y - c.ry || y > c.y + c.ry) continue
    if (cloth && c.anat) continue
    const dx = (x - c.x) / c.rx
    const dy = (y - c.y) / c.ry
    const dz = (z - c.z) / c.rz
    const q = dx * dx + dy * dy + dz * dz
    if (q >= 1) continue
    const f = 1 - q
    s *= 1 - c.k * f * Math.sqrt(f)
  }
  // Vertex-scale mottle standing in for a pore/blemish map. Four percent is
  // under the threshold where it starts to read as dirt rather than as skin, and
  // three thousand vertices is dense enough to carry the low frequency of it.
  const n = Math.sin(x * 61.7 + y * 113.3 + z * 79.1) * Math.sin(x * 29.3 - y * 41.9 + z * 53.7)
  return Math.max(0.34, s) * (1 + n * 0.04)
}

function distToSeg(px: number, py: number, pz: number, a: THREE.Vector3, b: THREE.Vector3): number {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const abz = b.z - a.z
  const apx = px - a.x
  const apy = py - a.y
  const apz = pz - a.z
  const ab2 = abx * abx + aby * aby + abz * abz || 1
  let t = (apx * abx + apy * aby + apz * abz) / ab2
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.hypot(apx - abx * t, apy - aby * t, apz - abz * t)
}

/**
 * Auto-weight a part onto its bone set.
 *
 * Inverse distance to the fourth power: the nearest bone dominates almost
 * everywhere, and the blend only opens up where two bones are genuinely
 * equidistant — which is exactly at a joint, which is exactly where you want
 * the surface to smear rather than crease. A lower power gives a rubbery figure
 * whose shoulder drags the hip; a higher one gives visible seams at the elbows.
 */
function weigh(g: THREE.BufferGeometry, bones: string[]) {
  const pos = g.attributes.position!
  const n = pos.count
  const idx = new Uint16Array(n * 4)
  const wgt = new Float32Array(n * 4)
  const dist = new Float32Array(bones.length)
  const px = pos.array as ArrayLike<number>
  const pick: number[] = []
  const pickW: number[] = []
  for (let i = 0; i < n; i++) {
    const x = px[i * 3]!
    const y = px[i * 3 + 1]!
    const z = px[i * 3 + 2]!
    let best = Infinity
    for (let k = 0; k < bones.length; k++) {
      const def = RIG[BONE_AT.get(bones[k]!)!]!
      const d = distToSeg(x, y, z, def.p, def.tip)
      dist[k] = d
      if (d < best) best = d
    }
    pick.length = 0
    pickW.length = 0
    for (let k = 0; k < bones.length; k++) {
      const r = (best + 0.02) / (dist[k]! + 0.02)
      const w = r * r * r * r
      if (w > 0.05) {
        pick.push(BONE_AT.get(bones[k]!)!)
        pickW.push(w)
      }
    }
    // Descending, so the four slots go to the four strongest.
    for (let a = 1; a < pickW.length; a++) {
      for (let b = a; b > 0 && pickW[b]! > pickW[b - 1]!; b--) {
        ;[pickW[b], pickW[b - 1]] = [pickW[b - 1]!, pickW[b]!]
        ;[pick[b], pick[b - 1]] = [pick[b - 1]!, pick[b]!]
      }
    }
    let sum = 0
    const count = Math.min(4, pickW.length)
    for (let k = 0; k < count; k++) sum += pickW[k]!
    for (let k = 0; k < 4; k++) {
      idx[i * 4 + k] = k < count ? pick[k]! : 0
      wgt[i * 4 + k] = k < count ? pickW[k]! / sum : 0
    }
  }
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4))
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wgt, 4))
}

/**
 * The overall soak, which is the *only* blood the vertex colours carry.
 *
 * Wounds themselves live in the fragment shader — see wounds.ts for why they
 * have to. What is left here is the general darkening of a man who has been
 * losing blood for a while, which is broad, soft and low-contrast, and so is
 * exactly the kind of thing vertex colours are good at.
 */
const SOAKED = new THREE.Color(0x3a0709)

/** One skinned layer: its mesh, and the buffers needed to repaint it. */
interface Skin {
  mesh: THREE.SkinnedMesh
  region: Uint8Array
  base: Float32Array
  /** Baked occlusion, one multiplier per vertex. See CREASE. */
  shade: Float32Array
  attr: THREE.BufferAttribute
  /**
   * One index buffer per kind, present only on a layer that carries geometry
   * some kinds don't wear. Swapped in on spawn; see Part.only.
   */
  alt?: Record<HumanKind, THREE.BufferAttribute>
}

interface Limb {
  clav: THREE.Bone
  upper: THREE.Bone
  fore: THREE.Bone
  hand: THREE.Bone
}
interface Leg {
  thigh: THREE.Bone
  shin: THREE.Bone
  foot: THREE.Bone
  toe: THREE.Bone
}

/** Ankle pitch at the two ends of stance: eight degrees of toe-up at heel strike,
 * thirty of toe-down at push-off. */
const FOOT_HS = 0.14
const FOOT_TO = 0.52
/** How high the ankle arcs over its own endpoints through the swing. It needs
 * barely any: both ends of stance already hold the ankle 8-14 cm up, so the
 * straight line between them clears the ground on its own. Real mid-swing toe
 * clearance is about a centimetre and looks like nothing; three is the compromise
 * that survives a tussock without turning into a goose step. */
const FOOT_LIFT = 0.045
/**
 * Fraction of the contact travel spent in front of the hip. Not a free choice: the
 * heel-strike ankle is low (0.078) and the toe-off ankle is raised 0.122 by the
 * plantarflexion, so the two ends have different reach costs, and 0.36 is where
 * the pelvis height the front end demands and the pelvis height the back end
 * demands come out equal (0.841 against 0.834 at a 0.87 travel). Any other split
 * makes one end binding and drops the pelvis further: shifting it to 0.21 to stop
 * a sprinter over-striding turned a 7 cm dip into an 18 cm crouch.
 */
const STRIKE = 0.36

interface FootTarget {
  x: number
  y: number
  z: number
  /** Sole pitch in body space. Positive is toe-up. */
  pitch: number
}
/** Scratch, shared: two of these per human times fifty-two humans allocated per
 * frame is a garbage collector pause you can feel. */
const FOOT: FootTarget[] = [
  { x: 0, y: SOLE, z: 0, pitch: 0 },
  { x: 0, y: SOLE, z: 0, pitch: 0 },
]
const hipOff = new THREE.Vector3()
const ikV = new THREE.Vector3()
const qInv = new THREE.Quaternion()
const qTmp = new THREE.Quaternion()
const qAcc = new THREE.Quaternion()
const DOWN = new THREE.Vector3(0, -1, 0)
const XAXIS = new THREE.Vector3(1, 0, 0)

/**
 * Where the ankle has to be, in body space, at phase `c` of this leg's cycle.
 *
 * Stance is a rolling contact. The point of the foot that is touching the ground
 * is pinned there, migrating forward along the sole from the heel to the ball as
 * the foot rolls over it, and the ankle is whatever that pinning implies — so the
 * ankle's own path is an output, and the sole cannot slide even while the foot is
 * pitching. In body space the pinned point recedes at exactly one stride per unit
 * phase, which is the entire no-skate condition.
 *
 * Swing is a Hermite back to the next heel strike whose end tangents are that same
 * stride-per-phase. That matters more than it sounds: the foot has to still be
 * travelling *backwards* relative to the body as it lands, at exactly ground
 * speed. Land it with any other velocity and it visibly jerks on contact, which is
 * the other half of why feet look like they're on a treadmill.
 */
function footTarget(
  c: number,
  duty: number,
  travel: number,
  gait: number,
  run: number,
  out: FootTarget,
): FootTarget {
  if (c < duty) {
    stancePose(c / duty, travel, gait, out)
  } else {
    const q = (c - duty) / (1 - duty)
    stancePose(1, travel, gait, out)
    const z1 = out.z
    const y1 = out.y
    const p1 = out.pitch
    stancePose(0, travel, gait, swingEnd)
    // Hermite. Tangents at both ends are the ground speed, in q units.
    const m = (travel / duty) * (1 - duty)
    const q2 = q * q
    const q3 = q2 * q
    const h0 = 2 * q3 - 3 * q2 + 1
    const h1 = q3 - 2 * q2 + q
    const h2 = -2 * q3 + 3 * q2
    const h3 = q3 - q2
    out.z = h0 * z1 + h1 * m + h2 * swingEnd.z + h3 * m
    // Heel flick. At a sprint the trailing leg leaves the ground almost straight
    // and 0.4 m behind the hip; if the ankle does not come up fast the target is
    // 10 cm beyond the leg's reach, the IK clamps, and the man runs stiff-legged
    // with the foot skating along behind him. Peaks just after toe-off and is
    // gone by mid-swing, with zero slope at both ends so toe-off stays smooth.
    const flick = (0.035 + 0.135 * run) * smooth01(q / 0.12) * (1 - smooth01((q - 0.12) / 0.38))
    // A sprinter's swing foot is 40 cm in front of the hip at maximum reach, which
    // is further than a straight leg goes: the knee has to still be folded there
    // and the foot still up, dropping onto the ground only in the last fifth. Let
    // it come down early and the target leaves the reach envelope, the IK clamps,
    // and the leg reaches out flat. Held to zero slope at q=1, so the foot still
    // arrives with no vertical velocity and does not stamp.
    const reach = 0.05 * run * smooth01(q / 0.3) * smooth01((1 - q) / 0.2)
    out.y =
      h0 * y1 +
      h2 * swingEnd.y +
      (FOOT_LIFT * smooth01(q / 0.3) * smooth01((1 - q) / 0.55) + flick + reach) * gait
    // Dorsiflex hard and early out of push-off, or the toe drags for the first
    // quarter of the swing — at 30 degrees of plantarflexion the tip of the boot
    // is 14 cm below the ankle and the ankle is only 13 cm up.
    out.pitch = p1 + (swingEnd.pitch - p1) * smooth01(q / 0.45)
  }
  return out
}
const swingEnd: FootTarget = { x: 0, y: SOLE, z: 0, pitch: 0 }

/**
 * The stance half, at 0..1 through it. Heel down and toe-up at 0, flat by 0.18,
 * heel lifting off the ball from 0.55, fully up at 1.
 *
 * Centred so heel strike lands the ankle in front of the hip and push-off leaves it
 * behind: the split is 0.36/0.64 rather than even, because the far end gets the
 * ankle raised 13 cm by the plantarflexion and can therefore reach further without
 * over-extending the leg. Splitting it evenly is what forces the pelvis into a
 * ten-centimetre crouch.
 */
function stancePose(p: number, travel: number, gait: number, out: FootTarget): FootTarget {
  const roll = smooth01(p / 0.18)
  const off = smooth01((p - 0.55) / 0.45)
  // The fade to a stand is applied to the ankle *pitch*, and the height and the
  // fore-aft offset are then derived from the faded pitch, so the sole is on the
  // ground at every value of gait. Fading the height separately, which is the
  // obvious way, leaves the height and the angle disagreeing and pushes the heel
  // 3 mm through the ground all the way through the walk-up.
  const pitch = (FOOT_HS * (1 - roll) - FOOT_TO * off) * gait
  // The pivot migrates heel-to-ball strictly *inside* the flat-foot window, where
  // the pitch is exactly zero and the migration therefore has no effect on the
  // ankle at all. Overlapping it with the heel rocker instead — which is the
  // obvious way to write it — pins a point halfway along a sole that is still
  // tipped 5 degrees toe-up, and drives the heel 6 mm through the ground.
  const pz = HEEL_Z + (BALL_Z - HEEL_Z) * smooth01((p - 0.2) / 0.25)
  const sn = Math.sin(pitch)
  const cs = Math.cos(pitch)
  out.pitch = pitch
  out.y = SOLE * cs + pz * sn
  out.z = travel * (p - STRIKE) - HEEL_Z + pz * (1 - cs) + SOLE * sn
  return out
}

export class Human {
  readonly group = new THREE.Group()
  readonly pos = new THREE.Vector3()
  readonly vel = new THREE.Vector3()
  kind: HumanKind = 'villager'
  /** Baked at build time and never changes. Public because the only way to tell
   * from outside what a slot is wearing was to classify it from its vertex
   * colours, and a classifier that has to guess is a classifier that lies. */
  dress: Dress = 'shirt'
  lower: Lower = 'trouser'
  state: HumanState = 'wander'
  health = 60
  maxHealth = 60
  alive = true
  yaw = 0

  /** Awareness of the tiger, 0..1. Crosses 1 -> the human is certain. */
  awareness = 0
  alerted = false
  /** Set by roar / a nearby kill. */
  fearTimer = 0
  staggerTimer = 0

  /**
   * The hut this one has claimed, and how far through using it they are.
   *
   * Stages, in order: 0 walking to the door from outside, 1 stepping through
   * it, 2 crossing the floor to the dark at the back, 3 cowering there facing
   * the only way in, 4 bolting back out. Holding a hut also holds a slot in its
   * `occupants` count, so it has to be given back on death and on respawn as
   * well as on the way out — a leaked slot is a hut nobody can ever use again.
   */
  private hideHut: Hut | null = null
  private hideStage = 0
  /** Stops the door search running every frame, and every flush every second. */
  private hideCooldown = 0
  /**
   * How long they will keep trying to reach the door before giving up on it.
   *
   * These men path by walking at the thing they want and being pushed out of
   * whatever they walk into, which is enough for open ground and not enough for
   * a doorway on the far side of somebody else's hut. Without a deadline, one
   * villager wedged against a wall holds a slot in that hut for the rest of the
   * round and stands there while the tiger eats him.
   */
  private hideTimeout = 0
  /** Rolled once per life. Some people run for a door; some just run. */
  private willHide = false

  private target = new THREE.Vector3()
  private repathTimer = 0
  private fireTimer = 0
  private aimTimer = 0
  private stepPhase = 0
  /** Only drives breathing and the idle sway; never the gait. */
  private idleTime = 0
  private deathTimer = 0
  private hurtFlash = 0
  private rng: Rng

  /** Lean away from the last blow, in body-local x/z. Decays back to nothing. */
  private leanX = 0
  private leanZ = 0
  /** Which way the body falls when it dies, in body-local space. */
  private fallX = 1
  private fallZ = 0
  private bleedTimer = 0
  private bleedNext = 0
  private fed = false
  /** Where the last blow landed, in bind-pose body space. */
  private lastCut = new THREE.Vector3()

  /**
   * How the body goes down, decided by the blow that did it and then fixed.
   *
   * `force` 0 is a man whose legs stopped working under him and 1 is a man
   * thrown off his feet; `roll` is the twist about his own spine on the way
   * down, which is what decides whether he lands on his face, his back or his
   * shoulder; `jitter` is a per-death seed that pushes every slack joint angle
   * off the shared default, so twenty corpses are not one corpse twenty times.
   */
  private deathForce = 1
  private deathRoll = 0
  private jitter: number[] = []
  /** Ground pools stamped so far, the cap, and the clock to the next one. */
  private poolCount = 0
  private poolMax = 4
  private poolNext = 0

  /** Pose blends, all damped so nothing snaps between stances. */
  private aimBlend = 0
  private panicBlend = 0
  private lean = 0

  /** The skeleton and the handful of bones the animation actually drives. */
  private bones: THREE.Bone[] = []
  private rest: THREE.Vector3[] = []
  private hips!: THREE.Bone
  private spine!: THREE.Bone
  private chest!: THREE.Bone
  private neck!: THREE.Bone
  private head!: THREE.Bone
  private skirt!: THREE.Bone
  private arms: Limb[] = []
  private legs: Leg[] = []

  /** Girth scale. The gait has to divide its stride by it: body-space z is scaled
   * on the way out, so an identical stride comes out 13% longer on a broad man. */
  private wide = 1

  private layers: Skin[] = []
  private skinMat!: THREE.MeshStandardMaterial
  private clothMat!: THREE.MeshStandardMaterial
  private cSkin = new THREE.Color()
  private cShirt = new THREE.Color()
  private cTrouser = new THREE.Color()

  private rifle: THREE.Group | null = null
  /** Hunter-only kit: bandolier and belt on the chest, slouch hat on the head. */
  private kitBody: THREE.Mesh | null = null
  private kitHat: THREE.Mesh | null = null
  /** A turban already fills the space a hat would go, so this slot never gets one. */
  private turbaned = false
  private body = new THREE.Group()
  /** Every material on this body, for the dissolve at the end of the corpse's life. */
  private mats: THREE.MeshStandardMaterial[] = []
  /** Every capsule cut into this body. Handed straight to its two shaders. */
  private wounds = createWoundSet()
  /**
   * Where blood is still leaving from, in bind-pose body space, with the slot
   * holding the streak below it. Only as many as the shader has room for; past
   * that the oldest source stops growing, which nobody has ever noticed on a
   * body that by then is more red than not.
   */
  private runs: { x: number; y: number; z: number; slot: number; len: number }[] = []
  private runNext = 0

  pendingShot: ShotEvent | null = null
  pendingShout = false
  screamed = false
  /**
   * Behind a wall and thinking it is enough. The game reads this the instant
   * before a kill lands, because "dragged out of a hut" is worth saying and
   * worth more points than the same kill in the open.
   */
  get hiding() {
    const h = this.hideHut
    if (!h || this.state !== 'hide' || this.hideStage < 2) return false
    // Includes the ones who have already broken and are running for the door:
    // being flushed happens at `HUT.flushRadius`, which is further out than a
    // paw reaches, so every kill indoors is a kill on someone mid-bolt. What
    // decides it is whether they are still between the walls.
    const lz = (this.pos.x - h.x) * h.dx + (this.pos.z - h.z) * h.dz
    return lz < (h.kind === 'round' ? h.r : h.hd)
  }
  /** Set for one frame each time the corpse pumps out another gout of blood. */
  bleedPulse = false
  /** Where the last wound was opened, in world space. */
  readonly woundPos = new THREE.Vector3()
  /**
   * Set for one frame when the corpse has soaked enough ground to be worth a
   * decal. The game stamps it; the body only knows where and how big.
   */
  poolPulse = false
  readonly poolPos = new THREE.Vector3()
  poolScale = 1

  constructor(seed: number) {
    this.rng = new Rng(seed)
    this.buildRig()
    this.group.add(this.body)
  }

  // ----------------------------------------------------------------- rig
  /**
   * Build the skeleton, then the surface around it.
   *
   * Order matters for the binding. The bones are posed and the Skeleton is
   * constructed while the root is still detached, so every bone's world matrix
   * *is* its rest position in body space and the inverses come out in the same
   * space the geometry is authored in. Only then does the rig go under `body`.
   * Bind with an explicit identity matrix so three doesn't recompute the
   * inverses against a world transform that changes every frame.
   *
   * Everything that varies between people is baked here, once, because geometry
   * can't change when a pool slot is recycled: build, dress, sleeve length,
   * hair, headwear, beard. Only the three palette colours stay mutable. That is
   * also why none of the variety can be kind-specific — any slot may come back
   * as either a villager or a hunter, so the hunters' kit is bolted on top.
   */
  private buildRig() {
    const rng = this.rng

    for (const def of RIG) {
      const bone = new THREE.Bone()
      const parent = def.parent === null ? null : this.bones[BONE_AT.get(def.parent)!]!
      const origin = parent === null ? V(0, 0, 0) : RIG[BONE_AT.get(def.parent!)!]!.p
      bone.position.copy(def.p).sub(origin)
      this.rest.push(bone.position.clone())
      if (parent) parent.add(bone)
      this.bones.push(bone)
    }
    const root = this.bones[0]!
    root.updateMatrixWorld(true)
    const skeleton = new THREE.Skeleton(this.bones)

    const at = (n: string) => this.bones[BONE_AT.get(n)!]!
    this.hips = at('hips')
    this.spine = at('spine')
    this.chest = at('chest')
    this.neck = at('neck')
    this.head = at('head')
    this.skirt = at('skirt')
    for (const s of ['L', 'R'] as const) {
      this.arms.push({
        clav: at(`clav${s}`),
        upper: at(`arm${s}`),
        fore: at(`fore${s}`),
        hand: at(`hand${s}`),
      })
      this.legs.push({ thigh: at(`thigh${s}`), shin: at(`shin${s}`), foot: at(`foot${s}`), toe: at(`toe${s}`) })
    }

    // ---- variation. Height and girth vary independently, which is what
    // separates a crowd from a row of the same doll at slightly different
    // sizes: one uniform scale makes everyone the same shape, and shape is
    // what you read at forty metres through grass.
    const tall = rng.range(0.93, 1.07)
    const wide = rng.range(0.9, 1.13)
    /** Muscle/fat, on top of the overall girth: a thin man in a loose shirt. */
    const bulk = rng.range(0.92, 1.12)
    // One in five used to come back bare-chested, and a bare chest is the one
    // state where every modelling shortcut on the torso is on show. One in seven
    // is enough to keep the crowd from looking uniformed.
    const dress = rng.pick(['shirt', 'shirt', 'shirt', 'shirt', 'vest', 'vest', 'bare'] as const)
    const lower = rng.pick(['trouser', 'trouser', 'dhoti', 'dhoti', 'shorts'] as const)
    this.dress = dress
    this.lower = lower
    // Never zero. A shirt with no sleeve at all is a torso in a different
    // colour: in a line-up of five, four bodies read as naked because three of
    // them were wearing sleeveless shirts and nothing said otherwise.
    // Sleeve length, measured down the arm from the shoulder; the shoulder to
    // the wrist is 0.587. The old set was 0.1/0.13/0.13/0.3, so three shirts in
    // four ended three quarters of the way up the *upper* arm. Nothing about
    // that length is male. A work shirt ends above the elbow, below it, or at
    // the wrist, and all three of those are here.
    const cuff = dress === 'shirt' ? rng.pick([0.30, 0.30, 0.42, 0.56]) : 0
    const shod = rng.chance(0.55)

    const parts: Part[] = []
    const skin = (bones: string[], g: THREE.BufferGeometry) =>
      parts.push({ g, bones, layer: 'skin', region: Reg.skin, hex: 0 })
    const cloth = (bones: string[], g: THREE.BufferGeometry, region: Reg, only?: HumanKind) =>
      parts.push({ g: reweave(g), bones, layer: 'cloth', region, hex: 0, only })
    const fixed = (bones: string[], g: THREE.BufferGeometry, hex: number, layer: Layer = 'skin') =>
      parts.push({ g, bones, layer, region: Reg.fixed, hex })

    // ---- torso. One continuous surface, hips to collarbone. Which layer it
    // lands in is the dress: a shirted man's chest *is* the shirt, and building
    // a skin torso underneath one would be two thousand vertices nobody ever
    // sees.
    const shirted = dress === 'shirt'
    const r = (v: number) => v * bulk

    // One swept surface for the whole trunk, replacing a pelvis, a seat, a waist
    // cone, a chest cone and a ribcage ellipsoid that overlapped each other five
    // deep and z-fought across the breastbone. See sweep() for the measurement.
    // Split at the chest bone's height so the halves can bind to different bone
    // sets — the same split the cones had, just made once instead of five times.
    const grow = (rs: readonly Ring[]) =>
      rs.map(([y, rx, rz, cz]) => [y, rx * bulk, rz * bulk, cz] as Ring)
    if (shirted) {
      // The shirt *is* the torso above its hem, so it gets no body underneath —
      // two thousand vertices nobody would ever see. Sixteen segments round
      // rather than twelve: this is the largest unbroken surface on the model
      // and a twelve-gon a foot across shows every quad as a flat step, which
      // nothing else in the world does because everything else carries a normal
      // map. Sixteen and the tiled weave together is what kills it.
      const [lo, hi] = sweepSplit(grow(SHIRT_CUT), SHIRT_SPLIT, 16)
      cloth(B_SPINE, lo, Reg.shirt)
      cloth(B_CHEST, hi, Reg.shirt)
      // Below the hem there has to be *something*, or the space between the
      // thighs is a hole into the inside of the model. Pulled in to 90% of the
      // body: matched to it, its twelve-gon crossed the shirt's sixteen-gon
      // within a millimetre or two and came out of the render as a ring of dark
      // points round the hem. Three centimetres inside, nothing can cross.
      cloth(B_SPINE, sweep(grow(TORSO.slice(0, 5)).map(
        ([y, rx, rz, cz]) => [y, rx * 0.9, rz * 0.9, cz] as Ring), 12), Reg.trouser)
    } else {
      const split = 9  // y = 1.135, just above the navel
      const [lo, hi] = sweepSplit(grow(TORSO), split, 12)
      skin(B_SPINE, lo)
      skin(B_CHEST, hi)
    }
    const upper = (g: THREE.BufferGeometry) =>
      shirted ? cloth(B_CHEST, g, Reg.shirt) : skin(B_CHEST, g)

    // Pectorals: a shelf laid on the ribcage, not two hemispheres stuck to it.
    // Three attempts at this were ellipsoids and all three read as breasts at
    // two metres, for a reason that is arithmetic rather than taste — see
    // relief(). Whatever an axis-aligned ellipsoid is set to stand proud of the
    // breastbone, it stands four times that proud out at its own centre, and a
    // lens that tall has a round outline no matter how it is scaled.
    //
    // The relief is 1.1 cm at its thickest, which is life-size for a working
    // man, and it runs from 8 degrees off the breastbone (leaving the sternal
    // gutter) out to 60, where it passes under the deltoid. What actually sells
    // it is the border: the bottom edge comes up over 9% of the patch height,
    // which is a hard step at y 1.27 with the under-pectoral shadow in CREASE
    // sitting directly beneath it, while the top fades over half the patch and
    // simply becomes chest. Breasts hang and have a soft lower border; pectorals
    // sit and have a hard one. That contrast is the whole read.
    //
    // On a bare chest. Not under a shirt: at two metres a 1.1 cm relief under
    // cloth is not a pectoral, it is two panels either side of the breastbone
    // with a seam down the middle, and a seam down the middle of a bodice is a
    // dart. It was left in on the last pass on the argument that it kept a
    // shirted man reading as male, and the render says it did the opposite.
    if (!shirted) {
      skin(B_CHEST, relief(1.262, 1.382, 0.14, 1.05, 0.011, bulk))
      skin(B_CHEST, relief(1.262, 1.382, -1.05, -0.14, 0.011, bulk))
    }

    // Trapezius. It used to be one flat 24 cm pancake laid across the top of the
    // chest, which from the front read as a yoke and closed off the base of the
    // neck — most of the reason the head looked bolted on. It is a *slope*: high
    // beside the neck, falling away to the point of the shoulder, and the
    // falling away is what leaves a neck standing above it.
    //
    // Under a shirt it is not a muscle, it is the shoulder line of the garment,
    // and it has two extra jobs. It runs 1 cm further out and finishes on a
    // radius small enough to be swallowed by the sleeve head — the old 0.056 end
    // at x 0.136 poked 8 mm out through the sleeve as a triangular fin, which is
    // the notch that was left at the top of each shoulder. And it is eight-sided
    // rather than six, because at 6 the one surface joining the collar to the
    // point of the shoulder is visibly a ridge with a flat either side of it.
    for (const s of ['L', 'R'] as const) {
      const sg = s === 'L' ? -1 : 1
      upper(shirted
        ? tube(V(sg * 0.022, 1.398, 0.014), V(sg * 0.146, 1.354, 0.002), 0.038, 0.042, 8)
        : tube(V(sg * 0.020, 1.400, 0.016), V(sg * 0.136, 1.360, 0.004), 0.038, 0.056, 6))
    }

    // Neck always skin — a collar covers the base of it, not the whole thing.
    // Cut in at the front so the throat sits behind the jaw rather than under it.
    skin(B_NECK, tube(V(0, 1.36, 0.008), V(0, 1.5, 0.014), 0.058, 0.048))
    // The two cords from behind the ear down to the top of the breastbone.
    // Nothing else says "neck" as cheaply: without them a neck is a smooth tube
    // and the head might as well be on a post. Twelve vertices each.
    for (const s of ['L', 'R'] as const) {
      const sg = s === 'L' ? -1 : 1
      skin(B_NECK, tube(V(sg * 0.042, 1.492, 0.010), V(sg * 0.018, 1.392, -0.036), 0.015, 0.011, 5))
    }
    // Larynx, 4.6 mm proud. Any more and it is a growth.
    skin(B_NECK, ell(0, 1.443, -0.034, 0.013, 0.017, 0.008, 6, 4))

    // Deltoids sit on the clavicle/upper-arm pair so they follow the shoulder:
    // the cap stays with the (unrotating) clavicle and the belly goes with the
    // arm, which is why the arm can raise without the shoulder opening a seam.
    // Taller and narrower than the old ball, and dropped 1.6 cm so its lower
    // point tapers into the arm at the insertion instead of sitting on top of
    // the shoulder like an epaulette.
    // Dropped again, to 1.336, so its crown lands at 1.416 — level with the top
    // of the trapezius. At 1.352 it stood 2.2 cm above it and the shoulder had a
    // separate rounded lump on top of it, which with the sleeve over it is a
    // puffed sleeve, and a puffed sleeve is a blouse. Widened at the same time
    // (0.072 against 0.069) so the sleeve's top rim can hide inside it.
    // Made to follow the girth, which the fixed 0.072 did not: on the broad end
    // of the range the upper arm (0.058 x 1.12 = 0.065) was wider than the
    // deltoid over it at the shoulder line, so a strip of bare arm surfaced
    // above the sleeve. Widening it further than that is the trap — at 0.078 the
    // shoulder stands 3.8 cm proud of the sleeve below it on each side, and a
    // ball that much bigger than the arm coming out of it is a puffed sleeve
    // however long the sleeve is. The height stays fixed at 0.080 so the crown
    // lands on 1.416 whatever the girth, level with the trapezius.
    //
    // Under a shirt there is no deltoid any more. Suppressing the ball was not
    // enough on its own: a sphere of radius R butted onto a tube of radius R has
    // no step, but it is still a hemisphere, and the render says a hemisphere on
    // a shoulder is a puffed sleeve whatever it is joined to. The sleeve head is
    // part of the sleeve now — see the loft below.
    for (const s of ['L', 'R'] as const) {
      if (shirted) continue
      // A deltoid is narrower front to back (0.066) than it is across.
      skin(B_ARM(s), ell((s === 'L' ? -1 : 1) * 0.158, 1.336, -0.004, r(0.072), 0.080, r(0.066)))
    }

    /** A rolled edge. An open cylinder rim is a knife edge with backface culling
     * behind it, which is exactly what the waist read as: a bright line with a
     * seam under it and no thickness anywhere. Every hem in here gets one. */
    const roll = (y: number, rx: number, rz: number, cz = 0, radial = 12) =>
      ell(0, y, cz, rx, 0.014, rz, radial, 3)

    /**
     * A sleeveless jerkin rather than the old pair of flat panels, which stood
     * 1.3 cm off a bare chest and read as a bib hung round the neck. Derived
     * from the body profile so it clears the torso all the way round, and
     * stopped at 1.345 so it passes under the deltoid instead of through it.
     *
     * The lower half widens its clearance from 1.1 cm to 2.4 cm on the way down
     * so the jerkin finishes outside the waistband (1.3 cm) instead of inside
     * it — tucked into the trousers it stopped being a garment at all and just
     * made the torso two colours. 1.7 cm clear over the chest rather than 1.0,
     * because the pectoral relief under it stands 1.1 cm proud and at a
     * centimetre it came through as two brown rectangles on the front.
     */
    const jerkin = (only?: HumanKind) => {
      // One surface split at 1.190, not two sweeps butted on a shared ring — the
      // shirt's chest hairline was exactly that and this had it too, a bright
      // line across the front of every vest at the level of the lower ribs.
      const [lo, hi] = sweepSplit([
        ...garmentRings(0.965, 1.190, 0.026, 4, bulk, 0.017).slice(0, -1),
        ...garmentRings(1.190, 1.345, 0.017, 3, bulk, 0.014),
      ], 4, 16)
      cloth(B_SPINE, lo, Reg.shirt, only)
      cloth(B_CHEST, hi, Reg.shirt, only)
      const top = torsoAt(1.345)
      const bot = torsoAt(0.965)
      cloth(B_CHEST, roll(1.345, top[0] * bulk + 0.016, top[1] * bulk + 0.016, top[2], 16), Reg.shirt, only)
      cloth(B_SPINE, roll(0.965, bot[0] * bulk + 0.028, bot[1] * bulk + 0.028, bot[2], 16), Reg.shirt, only)
      // Straps. Without them the jerkin is a tube that stops under the armpits
      // and stays up by magic, which is a strapless bodice — the one silhouette
      // that undoes everything the chest underneath it is doing. On the arm set
      // like the shawl's shoulder piece, so a raised arm carries them with it
      // instead of tearing them open at the deltoid.
      for (const s of ['L', 'R'] as const) {
        const sg = s === 'L' ? -1 : 1
        const f = torsoPoint(1.320, sg * 0.62, 0.016, bulk)
        const bk = torsoPoint(1.320, sg * (Math.PI - 0.62), 0.016, bulk)
        const over = V(sg * 0.112 * bulk, 1.424, -0.002)
        cloth(B_ARM(s), strip(f, over, 0.050, 0.012, V(sg * 0.5, 0.15, -0.85)), Reg.shirt, only)
        cloth(B_ARM(s), strip(over, bk, 0.050, 0.012, V(sg * 0.5, 0.15, 0.85)), Reg.shirt, only)
      }
    }

    if (dress === 'vest') {
      jerkin()
    } else if (dress === 'bare') {
      // A man carrying a rifle is not shirtless, and one in seven pool slots is
      // built bare-chested, so roughly one hunter in seven turned up in nothing
      // but a bandolier — which undoes the only thing the hunter silhouette has
      // to say, that he is the dangerous one.
      //
      // The slot cannot know: it is built once and comes back as either kind.
      // So a bare slot carries both, the shawl and a jerkin, and the assembly
      // below drops one of them out of the index buffer on spawn. It costs the
      // 340 vertices of a jerkin on a seventh of the pool and no draw calls.
      jerkin('hunter')
      // A shawl over one shoulder and across the chest and back. Asymmetry does
      // more for a crowd than any symmetric garment can — but it has to read as
      // cloth. It was a 5.5 cm tube once, which is a bandolier; then five boxes,
      // which is worse, because five boxes chained round a ribcage is a torn
      // zigzag with daylight through every joint. See ribbon(): the front and the
      // back are one swept surface each now, and the only butt joint left in the
      // garment is under the shoulder piece where nothing can see it.
      //
      // 12-13 cm across and 1.5 cm through, draped 2.2 cm off the body: less and
      // the cloth sinks into the pectoral between two points on the ribcage.
      const s = rng.chance(0.5) ? -1 : 1
      const g = 0.022
      /** A node of the drape, `gap` clear of the torso at height y and angle a. */
      const p = (y: number, a: number, w: number, gap = g): Node => {
        const q = torsoPoint(y, a * s, gap, bulk)
        return { p: q, w, out: V(q.x, 0, q.z - torsoAt(y)[2]) }
      }
      const shoulder = V(s * 0.126 * bulk, 1.422, -0.040)
      const nape = V(s * 0.122 * bulk, 1.426, 0.044)
      // Over the point of the shoulder, bound to the arm like the deltoid is: on
      // the chest set it tore open the first time a hunter shouldered a rifle.
      const arm = B_ARM(s < 0 ? 'L' : 'R')
      cloth(arm, ribbon([
        { p: V(shoulder.x, 1.410, -0.052), w: 0.104, out: V(s * 0.34, 0.62, -0.71) },
        { p: V(s * 0.134 * bulk, 1.428, 0.000), w: 0.108, out: V(s * 0.46, 0.89, 0) },
        { p: V(nape.x, 1.412, 0.056), w: 0.104, out: V(s * 0.34, 0.62, 0.71) },
      ], 0.015, 5, 8), Reg.shirt, 'villager')
      // Down the chest and across to the opposite hip, then a loose end hanging
      // off it. Bound to the whole spine rather than split at the ribs: the
      // weighting is by distance to each bone, so one surface running shoulder to
      // hip picks up chest at the top and hips at the bottom on its own — and a
      // surface that is never cut is a surface with no seam to disagree across.
      const tail = V(-s * 0.116 * bulk, 0.845, -0.020)
      cloth(B_SPINE, ribbon([
        { p: shoulder, w: 0.100, out: V(s * 0.42, 0.28, -0.86) },
        p(1.352, 0.74, 0.116),
        p(1.246, 0.40, 0.126),
        p(1.140, 0.06, 0.128),
        p(1.032, -0.40, 0.120),
        { p: V(-s * 0.104 * bulk, 0.940, -0.052), w: 0.108, out: V(-s * 0.52, 0.10, -0.85) },
        { p: tail, w: 0.086, out: V(-s * 0.62, 0.06, -0.78) },
      ], 0.015), Reg.shirt, 'villager')
      cloth(B_SPINE, ribbon([
        { p: nape, w: 0.100, out: V(s * 0.42, 0.28, 0.86) },
        p(1.352, 2.40, 0.116),
        p(1.246, 2.74, 0.126),
        p(1.140, 3.08, 0.128),
        p(1.032, 3.54, 0.116),
        { p: V(-s * 0.100 * bulk, 0.962, 0.030), w: 0.098, out: V(-s * 0.70, 0.14, 0.70) },
      ], 0.015), Reg.shirt, 'villager')
    }

    // The collar and the hem used to be two more pieces bolted onto the torso.
    // Both are rings of SHIRT_CUT now, for the reasons in that table: a separate
    // hem cone flared past the hips and its rolled cap was a twelve-gon ellipsoid
    // butted against a twelve-gon sweep, which alternated which of the two was
    // outside and came out of the render as a row of points round the bottom of
    // the shirt.

    // ---- arms. Upper arm with a biceps belly, elbow, forearm with a flexor
    // belly, then a hand that is a hand: palm, knuckles, four fingers, thumb.
    //
    // The fingers cost twelve vertices each — a five-sided tube that tapers to a
    // 6 mm end, which is a hole you can only see by lying under the villager. A
    // single-blob mitten was the most visible defect on the whole model, because
    // a mitten wrapped round a rifle grip is what a mannequin holding a prop
    // looks like, and the hunters are the one silhouette the player studies.
    for (const s of ['L', 'R'] as const) {
      const sg = s === 'L' ? -1 : 1
      const sh = V(sg * 0.158, 1.383, 0)
      const el = V(sg * 0.182, 1.053, 0)
      const wr = V(sg * 0.196, 0.797, 0)
      const bones = B_ARM(s)
      /** The bare limb's own radius at a height. Every sleeve is cut from these. */
      const upperR = (y: number) => r(0.058) + (r(0.048) - r(0.058)) * ((sh.y - y) / (sh.y - el.y))
      const foreR = (y: number) => r(0.052) + (r(0.032) - r(0.052)) * ((el.y - y) / (el.y - wr.y))
      // The forearm was 9.4 cm across at the elbow and 5.8 cm at the wrist, and
      // its flexor belly measured 4.2 cm against a 4.2 cm tube — exactly flush,
      // so there was no belly at all and the whole limb was a straight taper.
      // That, more than the length, is what made the arms read as sticks: an arm
      // is not a cone, it is two spindles. The tube goes to 10.4 cm at the elbow
      // and 6.4 at the wrist and the belly now stands 2.5 mm proud of it.
      //
      // Under a shirt it starts at 1.310 instead of at the joint, the same trick
      // the thigh plays at the hem. It was the arm, not the shoulder, that set
      // the sleeve head's minimum size: a cap has to swallow 0.058 of arm at
      // 1.383, which is 4.7 cm above the shoulder line, and only a shape close
      // to a hemisphere is still that wide that far up. Everything above 1.310
      // is inside a closed sleeve and the only thing its width can do is dictate
      // the shape of the sleeve over it.
      const armTop = shirted
        ? new THREE.Vector3().lerpVectors(sh, el, (sh.y - 1.310) / (sh.y - el.y))
        : sh
      skin(bones, tube(armTop, el, upperR(armTop.y), r(0.048)))
      skin(bones, ell(sg * 0.17, 1.215, -0.016, r(0.055), 0.078, r(0.048)))   // biceps
      skin(bones, ell(sg * 0.182, 1.053, 0.004, r(0.050), 0.046, r(0.050)))   // elbow
      skin(bones, tube(el, wr, r(0.052), r(0.032)))
      skin(bones, ell(sg * 0.186, 0.982, -0.004, r(0.049), 0.058, r(0.046)))  // forearm belly
      // The hand. Measured off the built mesh before touching it: the palm was
      // an ellipsoid 6.8 cm through the body axis and 4.8 cm fore-aft, with a
      // 6.4 x 6.4 x 2.8 cm flat disc of knuckles under it and four tubes on
      // 2.0 cm centres fanned across 8.0 cm — wider than the palm they came out
      // of. Every one of those numbers is the wrong way round.
      //
      // An arm hangs with the palm facing the thigh, so on this body *breadth
      // across the knuckles* is the fore-aft axis and *thickness* is the
      // across-body one. A hand is 8.5 cm across and 3 cm through. The old palm
      // had the two swapped, which is the flat paddle, and the digits were
      // splayed wider than the mass behind them, which is the fork.
      //
      // One swept mass now carries the carpus, the metacarpals and the web, and
      // the fingers leave it already touching. A relaxed hand at the side is a
      // soft curl, not a plumb line: its fore-aft centre walks 1.5 cm forward
      // between the wrist and the web and the digits carry on forward from
      // there, so the tips finish 3.5 cm in front of the wrist.
      //
      // The top two rings are the wrist and they are circular and cut from the
      // arm's own girth. The forearm tube ends here on an open rim of r(0.032)
      // and anything narrower leaves an annulus of daylight straight into the
      // model — which the old ellipsoid did, along the front and back of every
      // wrist, since it was only 4.8 cm deep against a 6.4 cm rim.
      const palm: Ring[] = [
        [0.6965, 0, 0, -0.016],                 // closed under the fingers
        [0.7040, 0.0120, 0.0320, -0.014],
        [0.7200, 0.0152, 0.0415, -0.008],       // knuckles: 3.0 through, 8.3 across
        [0.7450, 0.0165, 0.0390, -0.002],
        [0.7720, 0.0190, 0.0310, 0.001],
        [0.7955, r(0.0360), r(0.0360), 0.001],  // seals the forearm's rim
        [0.8120, r(0.0320), r(0.0320), 0.001],  // and is inside it from here up
      ]
      skin(bones, sweep(palm, 8).translate(sg * 0.196, 0, 0))
      // Fingers on 1.9 cm centres at 2.0 cm across, so they touch at the web and
      // open to a 5 mm gap at the tips: together, but readable as four. They
      // leave the mass 1.2 cm inside it, curl forward as they go and lean 1.3 cm
      // medially. Middle longest, little shortest and set back.
      const digit = [[-0.0385, 0.6555], [-0.0195, 0.6505], [-0.0005, 0.6560], [0.0175, 0.6720]] as const
      for (const [dz, tipY] of digit) {
        skin(bones, tube(
          V(sg * 0.196, 0.7160, dz),
          V(sg * 0.183, tipY, dz * 0.88 - 0.016),
          0.0100, 0.0068, 5,
        ))
      }
      // Thumb: forward off the radial edge and inboard, which is where a hanging
      // one sits. Short, because only the distal half of it clears the thenar —
      // and it starts on the palm's *axis*, 1.4 cm inside the front face, not on
      // it. Started flush, the tube's flat end cap is a visible facet and the
      // thumb reads as a slab stuck on the side rather than as part of the hand.
      skin(bones, tube(V(sg * 0.196, 0.770, -0.020), V(sg * 0.180, 0.7125, -0.053), 0.0125, 0.0082, 5))
      if (cuff > 0) {
        // Sleeve head, sleeve and cuff as one lofted surface on the arm's axis.
        //
        // It was a ball for the head and one or two cones for the arm. Every
        // number in that was already sized off the limb — the ball sat on the
        // deltoid's equator at the deltoid's own radius so there was no step
        // between them — and it still read as a leg-of-mutton sleeve, because a
        // sphere of radius R on a shoulder is a puffed sleeve whether or not the
        // tube under it matches. A sleeve head is not a hemisphere. It leaves the
        // shoulder line at about 10 degrees off vertical, holds that most of the
        // way, and then turns through 70 in the last centimetre and a half.
        //
        // Ease scales with the girth, because everything it has to clear does.
        const end = new THREE.Vector3().lerpVectors(sh, wr, Math.min(1, cuff / sh.distanceTo(wr)))
        const ease = r(0.010)
        // The upper arm is not its tube. The biceps belly reaches 6.4 cm from the
        // arm's axis at 1.215 where the tube under it is 5.5, and the sleeve was
        // cut to the tube, so a straight cone from the shoulder passed inside the
        // belly halfway down and a skin-coloured patch of biceps came through the
        // front of both sleeves on every shirt in the village. A twelve-sided
        // sleeve's flats sit a further 3.4% inside its radius, which is most of
        // the remaining margin, so the taper is floored rather than trimmed.
        const widest = r(0.066)
        const top = r(0.072)
        const limb = (y: number) => (y >= el.y ? upperR(y) : foreR(y))
        const barrel = (y: number) => Math.max(limb(y) + ease, widest)
        const hem = end.y
        // The cuff. The floor above held the sleeve at 0.066 all the way to its
        // opening, which on the short sleeve is 1.83 cm of radius more than the
        // arm coming out of it, cut off square with no thickness — an abrupt
        // step in diameter with a culled rim behind it. The floor is only there
        // to clear the biceps at 1.215, and no hem is ever within 8 cm of that,
        // so the last 4.5 cm are free to draw back in to the arm. It closes to
        // 1 cm of ease and then turns under by 7 mm, which is a cut or rolled
        // edge with something behind it rather than a knife edge.
        const hoops: Hoop[] = [
          [hem - 0.010, limb(hem) + r(0.003)],
          [hem, limb(hem) + r(0.010)],
          [hem + 0.045, barrel(hem + 0.045)],
        ]
        // The forearm is a different taper from the upper arm, so a sleeve that
        // crosses the elbow needs a hoop on it or it sinks into the flexor belly.
        if (hem + 0.045 < el.y) hoops.push([el.y, barrel(el.y)])
        // The head. Full width to 1.330 — the shoulder line, and the widest the
        // garment gets at 0.239 against the yoke's 0.185 — then four hoops that
        // turn 10, 26, 57 and 77 degrees off vertical to a point at 1.409, which
        // is the acromion (0.818 of stature) and 7 mm under where the old ball
        // crowned. The same span as a hemisphere; nothing like the same profile.
        hoops.push(
          [1.330, top],
          [1.362, top * 0.925],
          [1.386, top * 0.775],
          [1.400, top * 0.500],
          [1.409, 0],
        )
        cloth(bones, loft(sh, wr, hoops), Reg.shirt)
      }
    }

    // ---- legs. Thigh, knee, shin with a calf belly, ankle, foot, toes.
    for (const s of ['L', 'R'] as const) {
      const sg = s === 'L' ? -1 : 1
      const hip = V(sg * 0.085, 0.945, 0)
      const knee = V(sg * 0.088, 0.495, 0)
      const ankle = V(sg * 0.092, 0.075, 0)
      const bones = B_LEG(s)
      const bare = lower === 'dhoti' || lower === 'shorts'
      // The thigh tube is 0.088 at the top, not 0.105. At 0.105 it reached 2 cm
      // past the centreline, so the two thighs interpenetrated through the whole
      // crotch and each leg's inner surface surfaced inside the other one as soon
      // as the legs split. The lateral mass that made the thigh read as a thigh
      // goes on the outside, where the vastus actually is.
      // The bare thigh is 8.8 cm at the hip joint, 0.945, which puts its outside
      // edge at 0.173 against a shirt of 0.165 — it stood outside the shirt above
      // the hem and only ever looked right because the trouser leg over it was
      // fatter still and hid it. Tuck the trousers under the hem and the skin
      // comes out instead, as two tan wedges at the hips. So under a shirt the
      // thigh starts at the hem rather than at the joint, and 6.4 cm rather than
      // 8.8: everything above that is inside a closed garment and the only thing
      // its width can do is show through.
      skin(bones, shirted
        ? tube(V(sg * 0.085, 0.895, 0), knee, r(0.064), r(0.066))
        : tube(hip, knee, r(0.088), r(0.066)))
      skin(bones, ell(sg * 0.112, 0.79, 0.008, r(0.052), 0.13, r(0.08)))     // vastus / outer thigh
      skin(bones, ell(sg * 0.088, 0.495, 0.006, r(0.066), 0.056, r(0.062)))  // knee
      // Kneecap on the femur alone. The joint blob has to blend across the hinge
      // and loses a fifth of its radius at 60 degrees of flex; a bony front that
      // rides rigidly on the thigh is what stops that reading as a dent.
      // Pulled back 6 mm from where it was: at the low end of the girth range it
      // stood a millimetre outside the trouser leg and came through as a
      // skin-coloured patch on each knee.
      // Back another 5 mm and taller than it is wide. Standing 8 mm proud of the
      // knee blob it cut a perfect circle across a bare shin and read as a decal
      // rather than as bone; at 3 mm the outline is an oval that dies out at the
      // sides, which is what a patella looks like.
      skin([`thigh${s}`], ell(sg * 0.088, 0.484, -0.039, 0.032, 0.044, 0.020))
      skin(bones, tube(knee, ankle, r(0.062), 0.036))
      // The calf measured 0.050 where the shin tube it sits on measures 0.054 —
      // it was *inside* the bone, so the lower leg was a plain taper from knee
      // to ankle with no gastrocnemius on it at all. This one stands 5 mm proud
      // of the shin at the side and 2 cm behind it, and is set 1.2 cm higher,
      // because a calf's widest point is just below the knee and not halfway.
      skin(bones, ell(sg * 0.092, 0.372, 0.018, r(0.058), 0.090, r(0.050)))  // calf
      /**
       * Foot. The malleoli belong to the shin; everything past the ankle is one
       * swept wedge shared between the ankle and toe bones.
       *
       * It was a horizontal tube of radius 0.048 with an ellipsoid stuck on each
       * end, and measured off the built mesh that came out 9.5-10.0 cm wide and
       * 7.4-7.9 cm tall from the heel right through to the toe pad, with the sole
       * a flat line at y 0.002 the whole way and 7.6 mm of it below the ground.
       * A barrel of constant section is a clog. A foot is 26.9 cm long — which
       * this already was, and is the one number that was right — 9.6 cm across
       * the ball, 6.2 across the heel, 4.7 tall at the ball and 2.7 at the toes,
       * and it has an arch: the sole leaves the ground for the 8 cm between the
       * heel pad and the ball. Those are the sections below.
       *
       * The sole sits 4 mm under y = 0 at the two contact patches on purpose. An
       * ellipse touches a plane at one point, so a section whose bottom is exactly
       * on the ground gives a foot standing on a knife edge; sinking it gives a
       * 5 cm flat where the ball meets the ground and 3 cm at the heel, and the
       * buried part only ever surfaces at push-off, when it reads as the arch.
       *
       * Bound to the ankle and toe bones together rather than one piece each:
       * distance weighting across those two alone puts 93% of the heel on the
       * ankle and all of the pad on the toe, and blends them over the ball, which
       * is where the joint actually is. Excluding the shin is what the old hard
       * split was really for — a set containing it took half the heel, so the
       * heel only lifted half as far as the ankle rolled and push-off never left
       * the ground.
       */
      skin([`shin${s}`], ell(sg * 0.092, 0.086, 0.004, 0.037, 0.040, 0.034, 8, 5))
      /** [how far forward, half-width, half-height, height of the centre]. */
      const section = (z: number, w: number, h: number, y: number): Ring => [0.083 - z, w, h, y]
      skin([`foot${s}`, `toe${s}`], lie(sweep([
        section(0.083, 0, 0, 0.050),            // back of the heel
        section(0.070, 0.0230, 0.0300, 0.040),
        section(0.048, 0.0310, 0.0420, 0.038),  // heel: 6.2 across, sole 4 mm under
        section(0.015, 0.0345, 0.0400, 0.046),  // under the ankle
        section(-0.020, 0.0390, 0.0280, 0.040), // arch: sole 1.2 cm clear
        section(-0.058, 0.0450, 0.0250, 0.029),
        section(-0.095, 0.0480, 0.0250, 0.021), // ball: 9.6 across, 4.6 tall
        section(-0.130, 0.0440, 0.0195, 0.017),
        section(-0.155, 0.0350, 0.0150, 0.014),
        section(-0.174, 0, 0, 0.012),           // ends on the lesser toes
      ], 8), sg * 0.092, 0.083))
      // The big toe is the one that reads, and it is the only one worth its own
      // geometry: set on the medial third, a centimetre longer than the rest, and
      // what actually sets the 26.9 cm. The other four are a shading job.
      skin([`toe${s}`], tube(V(sg * 0.072, 0.019, -0.135), V(sg * 0.070, 0.013, -0.186), 0.0125, 0.0100, 5))
      if (shod) {
        // Sandals, not clogs. The old pair was a 10 x 24.5 cm rectangular plank
        // — as wide at the heel as at the ball, so it stood 1.9 cm proud of the
        // new heel on each side — under an ellipsoid that swallowed the whole
        // midfoot. A footbed cut to the foot's own plan and a single band over
        // the instep leave the heel and the toes out in the open, which is the
        // whole difference between a sandal and a shoe.
        // Bottomed on the same plane as the bare sole, y -0.004, because the gait
        // plants the ankle at one height whether or not there is a sandal under
        // it. A bed hung below that plane is a centimetre of leather in the dirt
        // on every planted step — measured at -1.4 cm against -0.4 for a bare
        // foot before this was pulled up.
        const bed = (z: number, w: number): Ring => section(z, w, w > 0 ? 0.009 : 0, 0.005)
        fixed([`foot${s}`, `toe${s}`], lie(sweep([
          bed(0.086, 0), bed(0.070, 0.028), bed(0.030, 0.038), bed(-0.020, 0.044),
          bed(-0.070, 0.050), bed(-0.120, 0.052), bed(-0.165, 0.042), bed(-0.192, 0),
        ], 6), sg * 0.092, 0.083), LEATHER, 'cloth')
        // Over the instep in two runs, because a strip is straight and one run
        // across a foot 4.5 cm tall passes through it. They meet 3 mm proud of
        // the instep and overrun so the bend cannot open.
        const peak = V(sg * 0.092, 0.062, -0.060)
        for (const e of [-1, 1]) {
          fixed([`foot${s}`], strip(
            peak, V(sg * 0.092 + e * sg * 0.046, 0.014, -0.060),
            0.036, 0.006, V(e * sg * 0.7, 0.7, 0), 0.008,
          ), LEATHER, 'cloth')
        }
      }

      /**
       * A leg tube starts at the hip joint, 0.945, which is 5 cm *above* the
       * shirt hem, and it is 10.4 cm across the top against a shirt half-width of
       * 16.5 — so 2.4 cm of trouser stood outside the shirt on each side, above
       * the hem, in a different colour. Under a vest or bare it never showed,
       * because the waistband there is the same colour and the eye reads the pair
       * as one pair of hips.
       *
       * So under a shirt the leg is tucked: it narrows to 0.070 by 0.892 (outer
       * edge 0.155 against the shirt's 0.162 at that height) and reaches full
       * width again below the hem, where it is meant to be seen. Narrowing it
       * also closes the open cylinder rim that a straight cut would leave
       * sticking out past the hem.
       *
       * The flare has to be visible — the hips are 0.189 half-width at the top
       * of the leg against a 0.166 shirt, so no shirt that hangs straight can
       * cover the point where a full-width leg starts, and the transition has to
       * happen in the open. What it must not do is *look* like a cone. As one
       * seven-sided jump from 0.860 to 0.892 it was a 48-degree slope with seven
       * flats on it, and the two facing the sky came out pale blue against dark
       * trousers: a bright triangle on the front of each thigh under the hem.
       * So it is two cones, steep then shallow, and ten-sided. The steep half
       * ends at 0.878, which is under the hem edge at 0.894 but behind it from
       * any camera at or above hip height; what is actually seen starts at 0.096
       * and drifts 8 mm out over 3.3 cm, which is 14 degrees and reads as the
       * seat of a pair of trousers rather than as a funnel.
       */
      const tuck = (full: number) => {
        if (!shirted) return hip
        const x = sg * 0.085
        cloth(bones, tube(V(x, 0.892, 0), V(x, 0.878, 0), r(0.070), r(full * 0.92), 10), Reg.trouser)
        cloth(bones, tube(V(x, 0.878, 0), V(x, 0.845, 0), r(full * 0.92), r(full), 10), Reg.trouser)
        return V(x, 0.845, 0)
      }
      // Ten sides, not the default seven, on every trouser tube: seven is coarse
      // enough on a leg this close to read as a hexagonal post, and the tuck
      // above has to hand off to something with the same facet count or the seam
      // shades as a step whatever the profile does.
      if (lower === 'trouser') {
        cloth(bones, tube(tuck(0.104), knee, r(0.104), r(0.08), 10), Reg.trouser)
        // The shin tube follows the calf rather than the bone. The calf belly is
        // an ellipsoid 2 cm behind the shin axis and 5 cm proud of it, and its
        // offset is fixed while its radius scales with girth, so at the thin end
        // of the range it reached 6.4 cm back where a straight 0.056 trouser leg
        // on ten flats only reached 6.3 — the gastrocnemius came through the back
        // of both trouser legs on the leanest villagers. Shifting the axis 1 cm
        // back and scaling the cuff with girth like everything else puts 8 mm of
        // clearance on it at every bulk, and a trouser leg that bags at the calf
        // is what a trouser leg does.
        cloth(bones, tube(V(sg * 0.090, 0.495, 0.010), V(sg * 0.092, 0.155, 0.002), r(0.082), r(0.058), 10), Reg.trouser)
      } else if (bare && lower === 'shorts') {
        cloth(bones, tube(tuck(0.11), V(sg * 0.088, 0.63, 0), r(0.11), r(0.098), 10), Reg.trouser)
      }
    }

    // The waist was a hard seam: a cylinder butted against the torso with its
    // open rim showing as a thin bright line and no overlap either side of it.
    // Both garments now run 3 cm higher, tuck their top ring inside the body,
    // and finish on a rolled edge so the join has thickness.
    /**
     * Where the trousers stop, and how far off the body.
     *
     * A waistband derived from the body plus a constant 1.3 cm clears the hips
     * (0.153 wide) at 0.166, and the shirt over it is 0.165: the trousers stood
     * a millimetre outside the shirt across the front of the hips, and because
     * one is a twelve-gon and the other a sixteen-gon they alternated, so the
     * hem was a ring of trouser-coloured spikes standing up into the shirt.
     * Colouring the trouser region green and re-shooting is what found it. In
     * depth it was worse — 12.2 mm against 11.5 — which is why it was worst dead
     * front-on, which is how a villager is nearly always seen.
     *
     * So under a shirt the band ends at 0.940 rather than the waist, and its gap
     * ramps to *minus* 8 mm at the top instead of plus 13, which puts its rim
     * 1.4 cm inside the shirt with nothing above it to see. It crosses back
     * outside a couple of millimetres under the hem's turn-under ring at 0.886,
     * which is where trousers are supposed to be. The belt roll goes with it: it
     * existed to give an open rim some thickness, and there is no visible rim
     * left once the shirt hangs over the top of it.
     */
    if (lower === 'dhoti') {
      // A wrapped skirt to the knee. Bound to the pelvis alone, which is what a
      // real dhoti does — it swings with the hips, not with each thigh.
      // Tucked to 0.130 at the top under a shirt, for the reason above: the
      // skirt's 0.78 z-squash makes it 12.3 cm deep at 0.955 against a shirt
      // 11.4 cm deep, so it came through the front and the back of the shirt
      // even at heights where it was safely inside it at the sides.
      cloth(['skirt'], trunk(0.56, shirted ? 0.940 : 0.955, 0.235, r(shirted ? 0.130 : 0.158), 0.78, 14), Reg.trouser)
      // The hem, and it has to sit *on* the trunk's rim. It used to be centred at
      // 0.59, three centimetres up the cone, where the ellipsoid's own taper has
      // pulled it in to 0.188 against a rim of 0.235: a 4.7 cm lip of open
      // cylinder stood proud of it all the way round. Nothing hides that. Looking
      // up at a standing villager, or along a corpse lying on its side, the skirt
      // is a bucket with the legs coming out of the middle of it — which is most
      // of what made a dead man in a dhoti read as furniture rather than a body.
      // Equator on the rim, four millimetres outside it, so the seal is also the
      // turn-under every hemmed edge has.
      cloth(['skirt'], ell(0, 0.566, 0, 0.239, 0.055, 0.187, 14, 4), Reg.trouser)
      if (!shirted) {
        // The tie: a separate band, wide enough to swallow the top of the skirt.
        // Under a shirt there is nothing to swallow and nothing to see.
        cloth(B_SPINE, trunk(0.94, 1.052, r(0.166), r(0.134), 0.78, 12), Reg.trouser)
        cloth(B_SPINE, roll(0.942, r(0.168), r(0.131)), Reg.trouser)
      }
    } else {
      // Swept from the body profile rather than coned, so it takes the flare of
      // the hips, and carried down to 0.80 rather than 0.86. Both the trouser
      // and the shorts leg tubes start at the hip joint and are cut square
      // across, so between 0.795 and 0.86 the front of the crotch was outside
      // both of them and outside the waistband: a 6 cm wedge of bare skin under
      // the belt of every trousered villager and every hunter in the game.
      cloth(B_SPINE, sweep(garmentRings(0.80, shirted ? 0.940 : 1.050, 0.013, shirted ? 4 : 6, bulk, shirted ? -0.008 : 0.013), 12), Reg.trouser)
      if (!shirted) {
        const w = torsoAt(1.050)
        cloth(B_SPINE, roll(1.050, w[0] * bulk + 0.015, w[1] * bulk + 0.015, w[2]), Reg.trouser)
      }
    }

    // ---- head. Skull, brow, cheekbones, jaw, chin, nose, ears, eyes, mouth.
    // Nearly all the crowd variety lives here: a body is a body, but you read a
    // person from the head, and at forty metres you read them from the
    // silhouette above the shoulders.
    // Width 0.158, depth 0.196, chin to crown 0.228 — a skull is long and narrow.
    // Twelve segments round rather than ten: at ten the silhouette of the crown
    // was visibly a polygon against the sky, and the crown is the one contour on
    // a human that is never straight.
    skin(B_HEAD, ell(0, 1.607, 0.012, 0.079, 0.108, 0.098, 12, 8))
    skin(B_HEAD, ell(0, 1.625, -0.058, 0.066, 0.026, 0.032))            // brow ridge
    // Cheekbones flattened against the skull. At 3 cm through and 2.3 cm proud
    // they were two balls stuck on the sides of the face; a zygomatic arch is a
    // ridge, and 9 mm is as far as one stands out.
    //
    // 32 x 28 x 28 mm was still very nearly a sphere, and a sphere on a cheek is
    // a ball on a cheek however far it is sunk: on the render there were two
    // round lumps either side of the nose with their own terminators, which at a
    // conversational distance is the strongest mannequin tell left on the face.
    // The arch runs *back* toward the ear, so it is long in x, shallow in z, and
    // shallower still in y — 44 mm of length against 15 mm of projection.
    skin(B_HEAD, ell(-0.048, 1.581, -0.030, 0.044, 0.021, 0.030))       // cheekbones
    skin(B_HEAD, ell(0.048, 1.581, -0.030, 0.044, 0.021, 0.030))
    skin(B_HEAD, ell(0, 1.545, -0.022, 0.058, 0.05, 0.072))             // jaw
    skin(B_HEAD, ell(0, 1.517, -0.056, 0.03, 0.03, 0.03))               // chin
    // The nose was one 3 cm ellipsoid on the bridge and one on the tip, which
    // from the front is a bump and from the side is nothing. A nose is four
    // things: a bridge that starts *between the brows*, a dorsum that runs down
    // and forward, a tip that hooks back under, and two wings either side of it.
    // The tip reaches z -0.1175, 2 cm proud of the cheek, which is what puts a
    // shadow across half the face when the sun is off to one side.
    // The root is level with the skull, not proud of it: the nasion is the
    // deepest point of the profile, and pushing it forward turned the whole nose
    // into one bulb running from the brow to the lip. 2.2 cm of dorsum, 1.5 cm
    // across, and 1.7 cm of projection past the upper lip.
    skin(B_HEAD, ell(0, 1.6035, -0.062, 0.012, 0.022, 0.016))           // root, between the brows
    skin(B_HEAD, tube(V(0, 1.6035, -0.070), V(0, 1.5715, -0.094), 0.011, 0.0135, 6))  // dorsum
    skin(B_HEAD, ell(0, 1.5665, -0.098, 0.0145, 0.0125, 0.0155, 8, 5))  // tip
    skin(B_HEAD, ell(-0.0135, 1.5605, -0.084, 0.009, 0.010, 0.0125, 6, 4))  // alae
    skin(B_HEAD, ell(0.0135, 1.5605, -0.084, 0.009, 0.010, 0.0125, 6, 4))
    fixed(B_HEAD, ell(-0.0115, 1.5545, -0.0875, 0.005, 0.0035, 0.006, 5, 3), DARK)  // nostrils
    fixed(B_HEAD, ell(0.0115, 1.5545, -0.0875, 0.005, 0.0035, 0.006, 5, 3), DARK)

    // Eyes. Previously a 2.6 cm dark disc stuck flat on a lit cheek, which is
    // the single most cartoon thing on the model. An eye is a ball sunk in a
    // socket, mostly covered: a sclera almond only 4 mm of which ever shows, a
    // brown iris over it, and lids of skin above and below with the upper one
    // sitting lower and heavier. The socket shadow that makes it read is in
    // CREASE.
    //
    // The depths matter more than the shapes. The skull surface at the eye is
    // z -0.0778; the first attempt put the eyeball's front at -0.0825, which is
    // 5 mm proud, and it bulged out of the face like a headlamp. The ball is
    // flush, the lids are 3 mm proud of it, and the 9 mm of opening between them
    // is all that ever shows.
    for (const s of [-1, 1]) {
      const x = s * 0.0315
      fixed(B_HEAD, ell(x, 1.599, -0.0695, 0.0125, 0.0065, 0.0085, 7, 4), SCLERA)
      // 7.2 mm across, not 5.5. At 5.5 there were seven millimetres of sclera
      // either side of the iris against eleven of iris, and eyes with that much
      // white showing are eyes that are staring — every villager looked
      // startled, standing still, in daylight.
      fixed(B_HEAD, ell(x, 1.5985, -0.0725, 0.0072, 0.0062, 0.006, 6, 4), IRIS)
      skin(B_HEAD, ell(x, 1.6115, -0.0705, 0.0165, 0.0085, 0.0105, 7, 4))  // upper lid, heavier
      skin(B_HEAD, ell(x, 1.5875, -0.0700, 0.0155, 0.007, 0.0100, 7, 4))   // lower lid
    }

    // Mouth. Was a 4 cm black bar. Lips are skin, not a hole: two soft rolls
    // with a dark line between them, the upper thinner than the lower and the
    // whole thing set back under the nose rather than on the front of the chin.
    skin(B_HEAD, ell(0, 1.5425, -0.0845, 0.024, 0.0075, 0.011, 8, 4))   // upper lip
    skin(B_HEAD, ell(0, 1.5305, -0.0845, 0.022, 0.0095, 0.012, 8, 4))   // lower lip
    fixed(B_HEAD, ell(0, 1.5375, -0.0885, 0.023, 0.0028, 0.006, 8, 3), DARK)

    skin(B_HEAD, ell(-0.078, 1.59, 0.012, 0.011, 0.026, 0.02))          // ears
    skin(B_HEAD, ell(0.078, 1.59, 0.012, 0.011, 0.026, 0.02))

    // Hair, headwear and beards, all vertex-coloured into the skin layer so a
    // white beard under a red turban is still no extra draw call.
    const old = rng.chance(0.22)
    const hairCol = old ? rng.pick(GREY) : rng.pick(HAIR)
    const style = rng.pick(['cap', 'cap', 'cap', 'turban', 'turban', 'bald', 'long'] as const)
    fixed(B_HEAD, ell(-0.037, 1.636, -0.057, 0.024, 0.009, 0.018), hairCol)  // brows
    fixed(B_HEAD, ell(0.037, 1.636, -0.057, 0.024, 0.009, 0.018), hairCol)

    this.turbaned = style === 'turban'
    if (style === 'turban') {
      const clothCol = rng.pick(TURBAN)
      fixed(B_HEAD, ell(0, 1.662, 0.014, 0.097, 0.055, 0.108, 12, 6), clothCol, 'cloth')
      fixed(B_HEAD, ell(0, 1.699, 0.016, 0.079, 0.04, 0.088, 12, 6), clothCol, 'cloth')
      fixed(B_HEAD, ell(0, 1.6, 0.096, 0.034, 0.06, 0.03), clothCol, 'cloth')  // tail at the nape
    } else if (style === 'bald') {
      // Fringe round the back and sides only — the crown stays skin.
      fixed(B_HEAD, ell(0, 1.585, 0.038, 0.084, 0.075, 0.094), hairCol)
    } else {
      // A cap of hair clipped at the brow, not a slab: past the equator it
      // swallows the ears and the head reads as a motorcycle helmet.
      const cap = new THREE.SphereGeometry(1, 12, 8, 0, TAU, 0, Math.PI * 0.46)
      cap.scale(0.086, 0.116, 0.106)
      cap.translate(0, 1.605, 0.016)
      fixed(B_HEAD, cap, hairCol)
      if (style === 'long') fixed(B_HEAD, ell(0, 1.555, 0.058, 0.089, 0.085, 0.075), hairCol)
    }

    if (rng.chance(0.45)) {
      // The beard was one 14 cm ball centred on the mouth, and the note that
      // replaced it claimed to stop 1.4 cm short of the lips. It did not: the
      // mass reached z -0.093 against a lip front of -0.0955, so it cleared them
      // by two and a half millimetres, and its top at 1.5575 was above the upper
      // lip at 1.5425 — it covered the mouth. It was 11.8 cm across on a 15.8 cm
      // head, which is wider than the jaw it is supposed to be growing on. On the
      // grey-haired quarter of the crowd the result read, again and exactly, as a
      // surgical mask.
      //
      // The two numbers that matter are the top and the front. The top is 1.526,
      // under the lower lip, so the mouth is on skin; the front is z -0.088 at
      // the chin and falls away behind the lips going up, so the profile is a
      // beard on a jaw rather than a pad over a face. 9.8 cm across hugs the jaw,
      // which measures 11.6 at its widest, and leaves the cheeks bare.
      fixed(B_HEAD, ell(0, 1.5085, -0.036, 0.046, 0.027, 0.058, 10, 6), hairCol)  // chin and jaw
      // Small, and set back. A mass this colour spanning the full width of the
      // throat is a bandage no matter what shape it is; 7.2 cm across against a
      // 7.8 cm neck leaves the sides of it bare, which is what stops the eye
      // reading the beard as something that goes all the way round.
      fixed(B_HEAD, ell(0, 1.4915, -0.014, 0.036, 0.021, 0.048, 8, 5), hairCol)   // under the jaw
      // Along the sides of the jaw, up toward the ear: a beard has a border that
      // runs *up*, and stopping it level all the way round is what makes a chin
      // mass read as something strapped on rather than something growing.
      for (const sd of [-1, 1]) {
        fixed(B_HEAD, ell(sd * 0.049, 1.539, 0.002, 0.020, 0.031, 0.036, 6, 5), hairCol)
      }
      // Moustache: on the top edge of the upper lip, 3 mm proud of the philtrum
      // and narrower than the mouth, so the lips still read under it.
      if (rng.chance(0.6)) fixed(B_HEAD, ell(0, 1.5485, -0.0855, 0.019, 0.006, 0.011, 8, 4), hairCol)
    }

    // ---- assemble. One skinned mesh per layer: skin has no cloth weave and a
    // lower roughness, which is most of why the two have to stay apart.
    const tex = textures()
    this.skinMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86 })
    this.clothMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: tex.cloth, roughness: 1 })
    this.mats.push(this.skinMat, this.clothMat)
    // Both layers, because a claw that opens a shirt opens the man under it and
    // the cut has to cross the hem without noticing it is there.
    addWoundShading(this.skinMat, this.wounds)
    addWoundShading(this.clothMat, this.wounds)
    for (const [layer, mat] of [['skin', this.skinMat], ['cloth', this.clothMat]] as const) {
      const mine = parts.filter((p) => p.layer === layer)
      if (!mine.length) continue
      const geos: THREE.BufferGeometry[] = []
      let total = 0
      for (const p of mine) total += p.g.attributes.position!.count
      const region = new Uint8Array(total)
      const base = new Float32Array(total * 3)
      const shade = new Float32Array(total)
      const col = new THREE.Color()
      /** Runs of the merged *index* buffer belonging to one kind only. */
      const worn: { only: HumanKind; from: number; to: number }[] = []
      let o = 0
      let io = 0
      for (const p of mine) {
        const n = p.g.attributes.position!.count
        const ic = p.g.index!.count
        if (p.only) worn.push({ only: p.only, from: io, to: io + ic })
        io += ic
        weigh(p.g, p.bones)
        // Every part needs the same attribute set or the merge drops one.
        p.g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3))
        if (p.region === Reg.fixed) col.setHex(p.hex)
        const pv = p.g.attributes.position!.array as ArrayLike<number>
        for (let i = 0; i < n; i++) {
          region[o + i] = p.region
          // Baked in the bind pose, which is the only pose that exists at build
          // time and close enough to every pose the gait ever reaches.
          shade[o + i] = shadeAt(pv[i * 3]!, pv[i * 3 + 1]!, pv[i * 3 + 2]!, p.layer === 'cloth')
          if (p.region === Reg.fixed) {
            base[(o + i) * 3] = col.r
            base[(o + i) * 3 + 1] = col.g
            base[(o + i) * 3 + 2] = col.b
          }
        }
        o += n
        geos.push(p.g)
      }
      const geo = mergeGeometries(geos, false)!
      // Switching a garment on or off by index rather than by moving vertices.
      // The obvious way — collapse the unworn vertices to a point — does not
      // survive skinning: the three corners of a triangle can sit on different
      // bones, so a triangle that is degenerate in the bind pose opens up again
      // as soon as the spine turns, and a shard of cloth flickers out of the
      // chest. Dropping its triangles from the index buffer cannot do that, and
      // costs one small upload on spawn.
      let alt: Record<HumanKind, THREE.BufferAttribute> | undefined
      if (worn.length) {
        const full = geo.index!.array
        const build = (kind: HumanKind) => {
          const cut = worn.filter((w) => w.only !== kind)
          const keep: number[] = []
          for (let i = 0; i < full.length; i++) {
            if (!cut.some((w) => i >= w.from && i < w.to)) keep[keep.length] = full[i]!
          }
          return new THREE.BufferAttribute(new Uint16Array(keep), 1)
        }
        alt = { villager: build('villager'), hunter: build('hunter') }
      }
      // Skinning moves vertices outside the bind pose, so the bind-pose sphere
      // pops the whole body out of frame when an arm goes up. Cheaper to pad it
      // than to recompute per frame.
      geo.computeBoundingSphere()
      geo.boundingSphere!.radius *= 1.5
      const mesh = new THREE.SkinnedMesh(geo, mat)
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.bind(skeleton, new THREE.Matrix4())
      this.body.add(mesh)
      this.layers.push({
        mesh,
        region,
        base,
        shade,
        attr: geo.attributes.color as THREE.BufferAttribute,
        alt,
      })
    }
    this.body.add(root)

    this.wide = wide
    this.body.scale.set(wide, tall, wide)
  }

  /**
   * Write the palette into the vertex colours.
   *
   * With everything in one buffer there are no per-region materials left to
   * recolour, so a recycled slot repaints instead. It touches a couple of
   * thousand vertices and only runs on spawn and on damage, which is nothing
   * next to the two hundred draw calls the single buffer saves.
   */
  private paint() {
    const pal = [this.cSkin, this.cShirt, this.cTrouser]
    for (const l of this.layers) {
      const a = l.attr.array as Float32Array
      for (let i = 0; i < l.region.length; i++) {
        const reg = l.region[i]!
        // The occlusion multiplies whichever colour lands here, palette or
        // fixed alike: an eye socket has to darken the eye in it as well as the
        // lids around it, or the eye is a lamp at the bottom of a hole.
        const s = l.shade[i]!
        let r: number
        let g: number
        let b: number
        if (reg === Reg.fixed) {
          r = l.base[i * 3]!
          g = l.base[i * 3 + 1]!
          b = l.base[i * 3 + 2]!
        } else {
          const c = pal[reg]!
          r = c.r
          g = c.g
          b = c.b
        }
        a[i * 3] = r * s
        a[i * 3 + 1] = g * s
        a[i * 3 + 2] = b * s
      }
      l.attr.needsUpdate = true
    }
  }

  /**
   * A point on the body's surface, in bind-pose body space.
   *
   * `theta` turns around the body's axis from the direction the blow came from,
   * so a wound can be laid out as an arc across the man rather than as a set of
   * offsets that walk off him. Anything wide has to be built this way: a claw
   * rake spans a third of the way round the ribs, and if its far end is placed
   * on the tangent plane instead of the surface it ends up hanging seven
   * centimetres out in the air beside him.
   *
   * `bulge` pushes the point out past the skin, which is how a straight capsule
   * covers a curved arc. A chord across an arc sags inward and would leave the
   * middle of a rake unpainted; lifting both ends by 1/cos(half the arc) puts
   * the sag back on the surface, and the ends finish slightly proud, which only
   * narrows the mark where a claw is leaving the body anyway.
   */
  private surfaceAt(
    theta: number, y: number,
    nx: number, nz: number, ax: number, az: number,
    bulge: number, out: THREE.Vector3,
  ) {
    const c = Math.cos(theta)
    const s = Math.sin(theta)
    const dx = nx * c + ax * s
    const dz = nz * c + az * s
    const r = sectionR(y, dx, dz) * bulge
    out.set(dx * r, y, dz * r)
  }

  /** Everything back to the bind pose. */
  private resetPose() {
    for (let i = 0; i < this.bones.length; i++) {
      this.bones[i]!.position.copy(this.rest[i]!)
      this.bones[i]!.rotation.set(0, 0, 0)
      // The skirt bone is the only one that is ever scaled, and these slots are
      // recycled — leave it out and the second man to wear this body walks off
      // with the drape of the corpse it was last used for.
      this.bones[i]!.scale.set(1, 1, 1)
    }
  }

  // ------------------------------------------------------------- spawning
  spawn(kind: HumanKind, pos: THREE.Vector3, waveScale: number) {
    this.kind = kind
    this.pos.copy(pos)
    this.vel.set(0, 0, 0)
    this.alive = true
    this.state = 'wander'
    this.awareness = 0
    this.alerted = false
    this.fearTimer = 0
    this.staggerTimer = 0
    this.deathTimer = 0
    this.hurtFlash = 0
    this.screamed = false
    this.releaseHut()
    this.hideStage = 0
    this.hideCooldown = 0
    this.hideTimeout = 0
    this.willHide = kind === 'villager' && this.rng.chance(HUT.hideChance)
    this.repathTimer = 0
    this.fireTimer = this.rng.range(0.4, 1.6)
    this.aimTimer = 0
    this.aimBlend = 0
    this.panicBlend = 0
    this.lean = 0
    this.yaw = this.rng.range(0, Math.PI * 2)

    const cfg = kind === 'hunter' ? HUMAN.hunter : HUMAN.villager
    this.maxHealth = cfg.health * (1 + waveScale)
    this.health = this.maxHealth

    this.leanX = this.leanZ = 0
    this.bleedTimer = 0
    this.fed = false

    // Recolour so hunters read instantly as the dangerous ones. The pool
    // recycles corpses, so every trace of the last life has to be scrubbed:
    // a slot that came back with someone else's blood still on it was the
    // giveaway that these are the same twenty bodies over and over.
    this.cSkin.setHex(this.rng.pick(SKIN))
    this.cShirt.setHex(kind === 'hunter' ? this.rng.pick(HUNTER_SHIRT) : this.rng.pick(SHIRT))
    this.cTrouser.setHex(this.rng.pick(TROUSER))
    clearWounds(this.wounds)
    this.runs.length = 0
    this.runNext = 0
    this.skinMat.roughness = 0.86
    this.clothMat.roughness = 1
    for (const m of this.mats) {
      m.transparent = false
      m.opacity = 1
      m.depthWrite = true
    }
    this.paint()
    // Put on whatever this kind wears. Only a bare-chested slot has anything to
    // switch — the shawl for a villager, a jerkin for a hunter.
    for (const l of this.layers) if (l.alt) l.mesh.geometry.setIndex(l.alt[kind])
    this.skinMat.emissive.setHex(0x000000)
    this.clothMat.emissive.setHex(0x000000)

    this.setRifleVisible(kind === 'hunter')
    this.setKit(kind === 'hunter')
    this.group.visible = true
    this.group.rotation.set(0, this.yaw, 0)
    this.group.position.copy(this.pos)
    this.body.rotation.set(0, 0, 0)
    this.body.position.set(0, 0, 0)
    this.resetPose()
    this.syncTransform()
  }

  private setRifleVisible(on: boolean) {
    if (on && !this.rifle) {
      const g = new THREE.Group()
      // One vertex-coloured mesh: wood, steel and brass in a single call, so an
      // armed hunter costs one more draw than an unarmed one rather than three.
      const stock = slab(0.056, 0.082, 0.34, 0, 0, 0.16)
      const grip = slab(0.05, 0.13, 0.1, 0, -0.05, 0.02)
      const fore = slab(0.05, 0.06, 0.3, 0, 0.004, -0.2)
      const barrel = new THREE.CylinderGeometry(0.014, 0.012, 0.62, 6)
      barrel.rotateX(Math.PI / 2)
      barrel.translate(0, 0.026, -0.29)
      const bolt = new THREE.CylinderGeometry(0.011, 0.011, 0.09, 5)
      bolt.rotateZ(Math.PI / 2)
      bolt.translate(0.045, 0.02, -0.02)
      const mesh = new THREE.Mesh(
        mergeGeometries([
          tintGeo(stock, 0x4a3220), tintGeo(grip, 0x4a3220), tintGeo(fore, 0x53381f),
          tintGeo(barrel, 0x22242a), tintGeo(bolt, BRASS),
        ], false)!,
        new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.35 }),
      )
      mesh.castShadow = true
      g.add(mesh)
      this.body.add(g)
      this.rifle = g
    }
    if (this.rifle) this.rifle.visible = on
  }

  /**
   * The hunters' kit — bandolier, belt and slouch hat.
   *
   * Two extra draw calls, and only ever on hunters, which the wave table caps at
   * fourteen. The one silhouette in the crowd you have to identify before it
   * shoots you is worth that; dressing all fifty-two is not.
   *
   * Rigid, hung off the chest and head bones rather than skinned — a bandolier
   * does not deform, and the geometry is pre-shifted into bone space.
   */
  private setKit(on: boolean) {
    if (on && !this.kitBody) {
      const gear = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72 })
      this.mats.push(gear)

      // Bandolier: over the left shoulder to the right hip, with the return
      // strap round the back so it doesn't read as a stripe painted on.
      const parts: THREE.BufferGeometry[] = [
        tintGeo(tube(V(-0.095, 1.408, -0.04), V(0.128, 1.05, -0.06), 0.026, 0.026, 6), LEATHER),
        tintGeo(tube(V(-0.086, 1.398, 0.055), V(0.124, 1.06, 0.07), 0.026, 0.026, 6), LEATHER),
      ]
      // Cartridges up the front of the strap.
      for (let i = 0; i <= 6; i++) {
        const f = i / 6
        const c = new THREE.CylinderGeometry(0.015, 0.015, 0.048, 5)
        c.rotateX(Math.PI / 2)
        c.translate(-0.095 + f * 0.223, 1.408 - f * 0.358, -0.073 - f * 0.012)
        parts.push(tintGeo(c, BRASS))
      }
      // Belt over the waist, with a pouch on the hip.
      const belt = trunk(0.985, 1.045, 0.157, 0.157, 0.8, 14)
      parts.push(tintGeo(belt, LEATHER))
      parts.push(tintGeo(slab(0.11, 0.1, 0.06, 0.12, 0.975, -0.078), LEATHER))
      const kit = mergeGeometries(parts, false)!
      kit.translate(0, -1.245, 0)
      this.kitBody = new THREE.Mesh(kit, gear)
      this.kitBody.castShadow = true
      this.chest.add(this.kitBody)

      // Slouch hat. The brim throws the eyes into shadow, which is most of why
      // a hunter reads as a different animal from a villager at range.
      if (!this.turbaned) {
        const brim = new THREE.CylinderGeometry(0.19, 0.175, 0.018, 14)
        brim.translate(0, 1.662, 0.014)
        const crown = new THREE.CylinderGeometry(0.082, 0.104, 0.098, 14)
        crown.translate(0, 1.716, 0.014)
        const dome = ell(0, 1.763, 0.014, 0.082, 0.045, 0.082, 12, 4)
        const hatBand = trunk(1.669, 1.696, 0.107, 0.104, 1, 14)
        const hat = mergeGeometries(
          [tintGeo(brim, FELT), tintGeo(crown, FELT), tintGeo(dome, FELT), tintGeo(hatBand, LEATHER)],
          false,
        )!
        hat.translate(0, -1.52, -0.012)
        this.kitHat = new THREE.Mesh(hat, gear)
        this.kitHat.castShadow = true
        this.head.add(this.kitHat)
      }
    }
    if (this.kitBody) this.kitBody.visible = on
    if (this.kitHat) this.kitHat.visible = on
  }

  private syncTransform() {
    this.group.position.copy(this.pos)
    this.group.rotation.y = this.yaw
  }

  get cfg() {
    return this.kind === 'hunter' ? HUMAN.hunter : HUMAN.villager
  }

  get chestPos(): THREE.Vector3 {
    return new THREE.Vector3(this.pos.x, this.pos.y + 1.245, this.pos.z)
  }

  // --------------------------------------------------------------- damage
  /** Returns true if this hit killed them. */
  hurt(amount: number, from: THREE.Vector3, blow: BlowKind = 'claw', at?: THREE.Vector3): boolean {
    if (!this.alive) return false
    this.health -= amount
    this.hurtFlash = 1
    this.alerted = true
    this.awareness = 1.4
    this.staggerTimer = Math.max(this.staggerTimer, 0.3)

    // Direction the blow came from, in world space and then in body-local — the
    // rig has to lean and fall away from it, not always forward.
    const dx = this.pos.x - from.x
    const dz = this.pos.z - from.z
    const l = Math.hypot(dx, dz) || 1
    const wx = dx / l
    const wz = dz / l
    // Body-local is the *inverse* of the group's yaw, and this used to build the
    // forward rotation instead: sin came out with the wrong sign, so fallZ was
    // negated and every body toppled toward whatever had just hit it. Front and
    // back are the one axis a viewer can read on a falling man, so the whole
    // topple was playing backwards.
    const c = Math.cos(this.yaw)
    const s = Math.sin(this.yaw)
    this.fallX = wx * c - wz * s
    this.fallZ = wx * s + wz * c
    // Whipped away from the impact hard enough to see, then damped out.
    this.leanX = clamp(this.leanX + this.fallZ * 0.85, -1, 1)
    this.leanZ = clamp(this.leanZ - this.fallX * 0.85, -1, 1)

    // Knocked back, harder the bigger the hit.
    const shove = 3.4 + Math.min(amount, 140) * 0.03
    this.vel.x += wx * shove
    this.vel.z += wz * shove

    // Torn open, and it stays torn.
    this.openWound(blow, at)

    if (this.health <= 0) {
      this.die(amount)
      return true
    }
    if (this.kind === 'villager') this.state = 'flee'
    return false
  }

  /**
   * Cut the shape of the blow into the body, wherever the blow landed.
   *
   * This replaced five red ellipsoids parented to the chest bone. Those never
   * had a chance: an ellipsoid centred just inside a surface is a sphere
   * sticking *out* of it, they scaled up from the bone's origin as the damage
   * grew so they climbed further off the ribs the worse things got, and being
   * in the same place on every body meant a man shot in the back grew a red
   * bubble on his front. It read exactly as what it was — beads glued on.
   *
   * A wound has no geometry of its own now. It is a handful of capsules handed
   * to the shader the body is already drawn with — see wounds.ts — so it
   * follows the silhouette because it is evaluated *on* the silhouette, it
   * skins along with the surface it is on, it cannot z-fight or float, and it
   * adds no draw call.
   *
   * Each kind of blow leaves its own signature. That is the part a player reads
   * without knowing they are reading it — a bite is not a smaller claw.
   *
   * All of it is laid out in bind-pose body space rather than world space, and
   * that is not a convenience. The girth and height scales on `body` are ±10%
   * per villager, so a mark placed in world metres lands a centimetre or two
   * off on a broad man and a couple more on a tall one — which is nothing on a
   * hand-sized rake and everything on a bite, where the jaw has to find a
   * five-centimetre throat. Working in the frame the vertices live in means the
   * numbers below can be read straight off TORSO, and they are.
   */
  private openWound(blow: BlowKind, at?: THREE.Vector3) {
    // Local direction to whatever did it. fallX/fallZ point *away* from it.
    const nx = -this.fallX
    const nz = -this.fallZ
    // Across the body, on the ground plane: the axis a swipe travels along and
    // a jaw closes across.
    const ax = -nz
    const az = nx

    // How high up the body it landed, in the body's own units. A tiger's paw
    // arrives wherever the swing was aimed; its jaws go for the throat, which
    // is why a bite is floored well above where the swipe that missed it was.
    let hy = clamp(at ? (at.y - this.pos.y) / this.body.scale.y : 1.28, 0.5, 1.66)
    if (blow === 'bite') hy = clamp(hy, 1.34, 1.56)
    // Out to the surface facing the blow, on the section that is actually there
    // at that height. A constant here cannot work: the ribs are 16 cm from the
    // spine across and 11 cm through, and the throat is 5 — work at the chest
    // radius and a bite lands in mid-air beside the neck, work at the throat
    // radius and a rake is buried inside the ribcage.
    const r = sectionR(hy, nx, nz)
    const cx = nx * r
    const cz = nz * r

    if (blow === 'claw') {
      // Three or four rakes, parallel, running diagonally across the body —
      // claws arrive as a set and they arrive at an angle. One capsule each,
      // which is the shape a drawn claw makes and the reason for capsules at
      // all: a rake is a line, and a line is two points and a radius.
      const rakes = 3 + (this.rng.chance(0.45) ? 1 : 0)
      // Between the claws of one paw. Measured along the skin, not in angle —
      // 4 cm is 4 cm whether it lands on a chest or a forearm.
      const gap = 0.043
      // Which way the paw was travelling. Both are equally likely and the
      // difference is obvious once there are two bodies next to each other.
      const lift = this.rng.chance(0.5) ? 1 : -1
      // Off the horizontal. A swipe that lands dead level reads as a printed
      // barcode; a tiger's arrives on the diagonal and drags as the man turns.
      const phi = lift * this.rng.range(0.5, 1.0)
      const cp = Math.cos(phi)
      const sp = Math.sin(phi)
      for (let k = 0; k < rakes; k++) {
        const off = (k - (rakes - 1) / 2) * gap + this.rng.range(-0.005, 0.005)
        // Uneven, because the outer claws of a paw never travel as far as the
        // middle ones and four identical strokes read as a stamp.
        const len = this.rng.range(0.17, 0.29)
        // Perpendicular offset for this claw, then half the stroke either way.
        const s0 = -cp * len * 0.5 - sp * off
        const u0 = -sp * len * 0.5 + cp * off
        const s1 = cp * len * 0.5 - sp * off
        const u1 = sp * len * 0.5 + cp * off
        // Arc length to angle. Half the arc sets how far the chord sags, and
        // therefore how far out both ends have to sit to put it back.
        const half = Math.abs(s1 - s0) * 0.5 / r
        const bulge = 1 / Math.max(0.6, Math.cos(half))
        this.surfaceAt(s0 / r, hy + u0, nx, nz, ax, az, bulge, WOUND_AT)
        this.surfaceAt(s1 / r, hy + u1, nx, nz, ax, az, bulge, RUN_AT)
        cutWound(
          this.wounds,
          WOUND_AT.x, WOUND_AT.y, WOUND_AT.z,
          RUN_AT.x, RUN_AT.y, RUN_AT.z,
          this.rng.range(0.009, 0.014), 1,
        )
        // Blood leaves from the low end, whichever end that is.
        this.mark(u0 < u1 ? WOUND_AT : RUN_AT)
      }
    } else {
      // Two arcs, upper and lower jaw, closed on the throat. The noise on the
      // capsule edge does the punctures for free: at this radius it breaks the
      // arc into a row of deep bites with shallow ground between them, which is
      // what a set of canines leaves and what drawing four separate holes at
      // this scale would cost four more slots to say.
      // The gape between the jaws, and how far round the head is turned. Both
      // vary, because two bites that land in the same place on the same body
      // should not stack into one symmetrical brand.
      const gape = this.rng.range(0.045, 0.075)
      const tilt = this.rng.range(-0.25, 0.25)
      for (const jaw of [-1, 1]) {
        // The upper jaw reaches further round than the lower one — that is how
        // a skull is built, and it is the reason a bite mark is two arcs of
        // different length rather than a pair of brackets.
        const arc = jaw > 0 ? 0.92 : 0.7
        const bulge = 1 / Math.cos(arc * 0.5)
        const y = hy + jaw * gape
        this.surfaceAt(tilt - arc * 0.5, y - 0.008, nx, nz, ax, az, bulge, WOUND_AT)
        this.surfaceAt(tilt + arc * 0.5, y + 0.008, nx, nz, ax, az, bulge, RUN_AT)
        cutWound(
          this.wounds,
          WOUND_AT.x, WOUND_AT.y, WOUND_AT.z,
          RUN_AT.x, RUN_AT.y, RUN_AT.z,
          0.021, 1,
        )
      }
      // And the mess the jaw makes around what it closed on. Pulled in most of
      // the way to the axis and sized off the section, so it scales itself: on
      // a throat it swallows the whole neck, which is what a jaw closing round
      // one does, and on a chest the same sphere is still a hand's width short
      // of coming out of the back.
      const cr = sectionR(hy, nx, nz)
      cutWound(
        this.wounds,
        nx * cr * 0.3, hy, nz * cr * 0.3,
        nx * cr * 0.3, hy, nz * cr * 0.3,
        cr * 0.95 + 0.04, 0.36,
      )
      WOUND_AT.set(nx * cr, hy - 0.05, nz * cr)
      this.mark(WOUND_AT)
    }

    // Short, because it just happened. It grows on its own from here.
    this.bleedRun(0.09)

    // A light overall soak on top, so a man who has taken a lot is dressed in a
    // darker shirt than one who has taken a little. Deliberately weak — the
    // wounds carry the story now, and dyeing the whole garment on top of them
    // just flattens the contrast that makes them read.
    const gone = clamp(1 - this.health / this.maxHealth, 0, 1)
    this.cShirt.lerp(SOAKED, gone * 0.12)
    this.cSkin.lerp(SOAKED, gone * 0.06)
    // Blood is wet, and wet is the one property that separates it from a brown
    // patch. Nothing here can vary roughness per vertex, but a badly cut man is
    // mostly blood by area, so pulling the whole surface toward a sheen is
    // close enough and costs a single float.
    this.skinMat.roughness = 0.86 - gone * 0.24
    this.clothMat.roughness = 1 - gone * 0.22
    this.paint()

    // Hand the spray back the place it should be leaving from. The blood the
    // game throws has to come off the opening, not out of the middle of the man
    // — it is the same point, and it is the difference between an arterial jet
    // and a red cloud with a villager standing in it.
    this.body.updateWorldMatrix(true, false)
    this.lastCut.set(cx, hy, cz)
    this.woundPos.copy(this.body.localToWorld(SOAK_AT.set(cx, hy, cz)))
  }

  /**
   * Register a place blood is leaving from, in bind-pose body space.
   *
   * Only a blow leaves one. If the run-down streaks registered as sources too,
   * each pass would seed the next one further down and the body would be solid
   * red inside a couple of seconds.
   */
  private mark(p: THREE.Vector3) {
    const slot = startRun(this.wounds, p.x, p.y, p.z, this.rng.range(0.012, 0.019))
    this.runs[this.runNext] = { x: p.x, y: p.y, z: p.z, slot, len: 0 }
    this.runNext = (this.runNext + 1) % RUN_SLOTS
  }

  /**
   * Let what has already been spilt run downhill.
   *
   * Blood that appears all at once and then holds still is paint. Calling this
   * again as they bleed out is what turns a set of cuts into a body that is
   * still losing blood: each pass drags the bottom of every run a little
   * further down, so the streaks lengthen over the seconds after the hit rather
   * than arriving finished.
   */
  private bleedRun(reach = 0.16) {
    for (const run of this.runs) {
      if (!run || reach <= run.len) continue
      run.len = reach
      const y = run.y - reach
      // Follow the body in. A man is wider at the chest than at the waist, so a
      // run that drops straight down in a straight line is off his surface
      // inside a hand's length and hanging in front of his belt. Closing it
      // toward the axis by however much the section has closed keeps it on him
      // — and because both radii are measured along the same direction, the
      // arbitrary length of that direction cancels out of the ratio.
      const k = sectionR(y, run.x, run.z) / Math.max(1e-4, sectionR(run.y, run.x, run.z))
      extendRun(this.wounds, run.slot, run.x * k, y, run.z * k, 0.46)
    }
  }

  private die(amount: number) {
    this.alive = false
    // Give the hut back before the state changes, or the slot is held by a
    // corpse until the pool recycles it.
    this.releaseHut()
    this.state = 'dead'
    this.deathTimer = 0
    this.vel.set(0, 0, 0)
    this.health = 0
    // Keep pumping for a couple of seconds. The game turns each pulse into a
    // spray, which is what an opened throat looks like and one burst does not.
    this.bleedTimer = HUMAN.bleedDuration
    this.bleedNext = 0
    this.poolNext = 0.5
    this.poolCount = 0
    this.poolMax = 4

    // The blow that killed him is not the blow that grazed him, and up to here
    // nothing has said so — `openWound` cuts the same three rakes whether the
    // man walks away from them or not, so a corpse was arriving on the ground
    // carrying a flesh wound. Flood the area round what landed last with one
    // wide capsule, shallow enough that it can only ever reach the staining end
    // of the ramp, and start the runs long instead of letting them crawl out of
    // him over the next two seconds. A man who is already dead is already
    // emptying; the streaks should be there when he lands, not catch him up.
    const c = this.lastCut
    cutWound(this.wounds, c.x, c.y, c.z, c.x * 0.9, c.y - 0.09, c.z * 0.9, 0.105, 0.34)
    this.mark(c)
    this.bleedRun(0.26)
    this.cShirt.lerp(SOAKED, 0.2)
    this.cSkin.lerp(SOAKED, 0.1)
    this.paint()

    // How they go down. A man whose heart stops folds where he stands; a man
    // hit by three hundred kilos of tiger leaves the ground. Everything about
    // the fall reads off this one number, so the two look nothing alike.
    this.deathForce = clamp((amount - 30) / 90, 0, 1)
    // The twist on the way down. Small most of the time — a fall is not a
    // gymnastic event — but occasionally enough to land them on a shoulder,
    // and biased by which way they were struck.
    this.deathRoll = this.fallX * this.rng.range(0.3, 0.9)
      + (this.rng.chance(0.25) ? this.rng.range(-1.1, 1.1) : 0)
    // One seed per joint, drawn once. Two corpses with the same seed would be
    // the same corpse, and this pool is only twenty slots deep.
    this.jitter = []
    for (let i = 0; i < 18; i++) this.jitter.push(this.rng.range(-1, 1))
    this.setRifleVisible(false)
  }

  // ---------------------------------------------------------------- feeding
  /** Can the tiger still get something out of this body? */
  get feedable(): boolean {
    return !this.alive && !this.fed && this.group.visible && this.deathTimer > 0.35
  }

  /** Consume the corpse. It collapses further and stops being worth anything. */
  feed() {
    this.fed = true
    // A fed-on body has been opened up, not tidily killed. Tear the torso from
    // several directions at once with something much blunter than a claw — a
    // carcass is not a set of neat lines, it is a hole — and then let all of it
    // run. The difference between a corpse and a carcass is that a carcass is
    // mostly blood.
    for (let i = 0; i < 4; i++) {
      const a = this.rng.range(0, Math.PI * 2)
      const y0 = this.rng.range(1.0, 1.42)
      const y1 = y0 + this.rng.range(-0.12, 0.12)
      const dx = Math.cos(a)
      const dz = Math.sin(a)
      const r0 = sectionR(y0, dx, dz) * 0.86
      const r1 = sectionR(y1, dx, dz) * 0.86
      cutWound(
        this.wounds,
        dx * r0, y0, dz * r0,
        dx * r1, y1, dz * r1,
        this.rng.range(0.055, 0.085), 1,
      )
      WOUND_AT.set(dx * r0, Math.min(y0, y1), dz * r0)
      this.mark(WOUND_AT)
    }
    // Straight to full length. The tiger has been at this for a while; nothing
    // about it should look like it started a moment ago.
    this.bleedRun(0.42)
    // And it goes on emptying onto the ground under it, further and wider than
    // a clean kill ever does.
    this.poolMax = 8
    this.poolNext = 0
    // Torn apart: sinks flatter and stops registering on the radar.
    this.deathTimer = Math.max(this.deathTimer, HUMAN.corpseLife * 0.72)
  }

  terrify(duration: number, stagger: number) {
    if (!this.alive) return
    this.fearTimer = Math.max(this.fearTimer, duration)
    this.staggerTimer = Math.max(this.staggerTimer, stagger)
    this.alerted = true
    this.awareness = 1.2
    this.state = 'panic'
  }

  alertTo(_tigerPos: THREE.Vector3) {
    if (!this.alive || this.alerted) return
    this.alerted = true
    this.awareness = Math.max(this.awareness, 1.0)
    this.state = this.kind === 'hunter' ? 'hunt' : 'flee'
  }

  // --------------------------------------------------------------- update
  update(
    dt: number,
    tigerPos: THREE.Vector3,
    tigerVisibility: number,
    tigerNoise: number,
    world: World,
    waveScale: number,
  ) {
    this.pendingShot = null
    this.pendingShout = false
    this.bleedPulse = false
    this.poolPulse = false
    // The hit tell used to be an emissive of 0.7 red over the whole body for a
    // third of a second, which lit a man from the inside: at night he was the
    // brightest object in the village, and by day he flushed scarlet head to
    // foot including his hat. Nothing about a man being clawed makes him glow.
    //
    // What is left has to be judged against these men rather than in the
    // abstract, because they are *dark*: dark skin, dark cloth, an albedo of
    // about 0.03 linear, which under village light leaves about 0.04 coming off
    // them. An emissive is added to that, so 0.13 is not a tint on a body, it is
    // three times the body, and every man who took a claw went uniformly the
    // colour of the glow from his hat to his sandals — which is most of what
    // "he goes weird and red when you hit him" was. Half of what he already
    // reflects, gone in a tenth of a second, is a flicker; anything more is a
    // repaint. The actual read comes from the wound that just opened and the
    // spray off it.
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 6)
    const flash = this.hurtFlash * this.hurtFlash * 0.022
    this.clothMat.emissive.setRGB(flash, flash * 0.22, flash * 0.16)
    this.skinMat.emissive.setRGB(flash * 0.7, flash * 0.16, flash * 0.1)
    this.leanX = damp(this.leanX, 0, 7, dt)
    this.leanZ = damp(this.leanZ, 0, 7, dt)

    if (!this.alive) {
      this.updateDeath(dt)
      return
    }

    this.fearTimer = Math.max(0, this.fearTimer - dt)
    this.staggerTimer = Math.max(0, this.staggerTimer - dt)

    this.updatePerception(dt, tigerPos, tigerVisibility, tigerNoise, world)
    this.updateBrain(dt, tigerPos, world, waveScale)
    this.updateMotion(dt, world)
    this.animate(dt)
    this.syncTransform()
  }

  private updatePerception(
    dt: number,
    tigerPos: THREE.Vector3,
    visibility: number,
    noise: number,
    world: World,
  ) {
    const cfg = this.cfg
    const dx = tigerPos.x - this.pos.x
    const dz = tigerPos.z - this.pos.z
    const dist = Math.hypot(dx, dz)

    let gain = 0

    // Hearing: loud movement gives you away regardless of cover.
    if (dist < noise) gain += (1 - dist / noise) * 1.4

    // Sight: needs range, facing, line of sight, and the tiger not concealed.
    if (dist < cfg.sightRange * visibility + 3) {
      const fx = -Math.sin(this.yaw)
      const fz = -Math.cos(this.yaw)
      const dot = (dx * fx + dz * fz) / (dist || 1)
      const inFov = Math.acos(clamp(dot, -1, 1)) < cfg.sightFov
      if (inFov && !world.losBlocked(this.pos.x, this.pos.z, tigerPos.x, tigerPos.z)) {
        const closeness = 1 - dist / (cfg.sightRange || 1)
        gain += closeness * 2.6 * visibility
      }
    }

    if (gain > 0) {
      this.awareness = Math.min(1.6, this.awareness + (gain * dt) / HUMAN.alertTime)
    } else {
      this.awareness = Math.max(0, this.awareness - dt * 0.35)
      if (this.awareness <= 0.05) this.alerted = false
    }

    if (this.awareness >= 1 && !this.alerted) {
      this.alerted = true
      this.pendingShout = true
      if (!this.screamed) this.screamed = true
    }
  }

  private updateBrain(dt: number, tigerPos: THREE.Vector3, world: World, waveScale: number) {
    const cfg = this.cfg
    const dist = Math.hypot(tigerPos.x - this.pos.x, tigerPos.z - this.pos.z)
    this.repathTimer -= dt
    this.hideCooldown -= dt
    this.hideTimeout -= dt

    // Holding a hut outranks everything else. A roar is meant to scatter people
    // in the open; it is not meant to empty the huts, because emptying the huts
    // is what the tiger has to walk through a door to do.
    if (this.hideHut) this.state = 'hide'
    else if (this.fearTimer > 0) this.state = 'panic'
    else if (this.alerted) this.state = this.kind === 'hunter' ? 'hunt' : 'flee'
    else if (this.awareness > 0.35) this.state = 'suspicious'
    else if (this.state !== 'wander') this.state = 'wander'

    // Anyone already running and inclined to hide picks a door as soon as there
    // is one worth picking. Failing to find one is the expensive case, so it is
    // the one on a cooldown.
    if (
      this.willHide && !this.hideHut && this.hideCooldown <= 0 &&
      (this.state === 'flee' || this.state === 'panic')
    ) {
      if (this.claimHut(world, tigerPos)) this.state = 'hide'
    }

    switch (this.state) {
      case 'wander': {
        if (this.repathTimer <= 0) {
          this.repathTimer = this.rng.range(2.5, 6)
          this.target.copy(world.randomOpenPoint(4, 74, this.rng))
        }
        this.moveToward(this.target, cfg.wanderSpeed, dt)
        break
      }

      case 'suspicious': {
        // Stop, turn toward the noise, scan.
        this.vel.x = damp(this.vel.x, 0, 6, dt)
        this.vel.z = damp(this.vel.z, 0, 6, dt)
        this.faceToward(tigerPos, dt, 3.5)
        break
      }

      case 'flee': {
        // Run away from the tiger, biased toward firelight (villagers feel safe there).
        if (this.repathTimer <= 0) {
          this.repathTimer = 0.7
          const away = new THREE.Vector3(this.pos.x - tigerPos.x, 0, this.pos.z - tigerPos.z)
          if (away.lengthSq() < 0.01) away.set(1, 0, 0)
          away.normalize().multiplyScalar(22)
          let dest = new THREE.Vector3(this.pos.x + away.x, 0, this.pos.z + away.z)
          let bestFire: THREE.Vector3 | null = null
          let bestScore = -Infinity
          for (const f of world.campfires) {
            const dFire = Math.hypot(f.x - this.pos.x, f.z - this.pos.z)
            const fireFromTiger = Math.hypot(f.x - tigerPos.x, f.z - tigerPos.z)
            const score = fireFromTiger - dFire * 0.6
            if (score > bestScore) { bestScore = score; bestFire = f }
          }
          if (bestFire && bestScore > 8) dest = dest.lerp(bestFire, 0.55)
          this.target.set(dest.x, 0, dest.z)
        }
        this.moveToward(this.target, HUMAN.villager.fleeSpeed, dt)
        // Look back over the shoulder at what's chasing them.
        if (dist < 14) this.faceAwayFrom(tigerPos, dt, 7)
        break
      }

      case 'hide': {
        const hut = this.hideHut!

        // Never got there. Stop holding a door open for someone who cannot
        // reach it and go back to running like everybody else.
        if (this.hideStage < 2 && this.hideTimeout <= 0) {
          this.releaseHut()
          this.hideCooldown = 5
          this.state = this.fearTimer > 0 ? 'panic' : 'flee'
          break
        }

        // Flushed. Being cornered in a room with a tiger is worse than the open
        // ground they gave up to get here, and they work that out all at once.
        if (this.hideStage >= 2 && this.hideStage < 4) {
          const tdx = tigerPos.x - this.pos.x
          const tdz = tigerPos.z - this.pos.z
          if (tdx * tdx + tdz * tdz < HUT.flushRadius * HUT.flushRadius) {
            this.hideStage = 4
            this.fearTimer = Math.max(this.fearTimer, HUT.flushPanic)
            this.pendingShout = true
          }
        }

        // ...or the thing they were running from has gone, and they come out on
        // their own. Without this the village fills its huts once and the rest
        // of the round is played in an empty clearing.
        if (this.hideStage === 3 && !this.alerted && this.fearTimer <= 0 && dist > 24) {
          this.hideStage = 4
        }

        const way = this.hideStage <= 0 ? hut.out : this.hideStage >= 4 ? hut.out : this.hideStage === 1 ? hut.in : hut.hide
        const d = Math.hypot(way.x - this.pos.x, way.z - this.pos.z)

        if (this.hideStage === 3) {
          // Pressed into the dark at the back, watching the doorway, because
          // the doorway is the only thing that can happen to them now.
          this.vel.x = damp(this.vel.x, 0, 8, dt)
          this.vel.z = damp(this.vel.z, 0, 8, dt)
          this.faceToward(hut.out, dt, 4)
        } else {
          // No sprinting indoors: there is nowhere to sprint to, and a man at
          // full flee speed crosses one of these rooms in half a second.
          const indoors = this.hideStage >= 2
          this.moveToward(way, indoors ? HUT.insideSpeed : HUMAN.villager.fleeSpeed, dt)
        }

        if (this.hideStage < 3 && d < 0.55) this.hideStage++
        else if (this.hideStage === 4 && d < 0.9) {
          this.releaseHut()
          // Long enough that they run somewhere rather than straight back in.
          this.hideCooldown = HUT.flushPanic
          this.state = this.fearTimer > 0 ? 'panic' : 'wander'
          this.repathTimer = 0
        }
        break
      }

      case 'hunt': {
        const h = HUMAN.hunter
        this.faceToward(tigerPos, dt, 4.5)
        // Hold at a firing stand-off; close in if the tiger breaks away.
        const ideal = h.fireRange * 0.6
        if (dist > h.fireRange * 0.95) {
          this.moveToward(tigerPos, h.chaseSpeed, dt)
        } else if (dist < ideal * 0.5) {
          // Back off, keep the rifle useful.
          const away = new THREE.Vector3(this.pos.x - tigerPos.x, 0, this.pos.z - tigerPos.z).normalize()
          this.target.set(this.pos.x + away.x * 8, 0, this.pos.z + away.z * 8)
          this.moveToward(this.target, h.chaseSpeed * 0.8, dt)
        } else {
          this.vel.x = damp(this.vel.x, 0, 8, dt)
          this.vel.z = damp(this.vel.z, 0, 8, dt)
        }

        this.fireTimer -= dt
        const clear = !world.losBlocked(this.pos.x, this.pos.z, tigerPos.x, tigerPos.z)
        if (dist < h.fireRange && clear && this.staggerTimer <= 0) {
          this.aimTimer += dt
          if (this.fireTimer <= 0 && this.aimTimer >= h.aimTime) {
            this.fireTimer = h.fireInterval * this.rng.range(0.8, 1.25)
            this.aimTimer = 0
            this.fire(tigerPos, dist, waveScale)
          }
        } else {
          this.aimTimer = Math.max(0, this.aimTimer - dt * 2)
        }
        break
      }

      case 'panic': {
        // Blind terror: sprint in a wobbling line away from the tiger.
        if (this.repathTimer <= 0) {
          this.repathTimer = 0.45
          const a = Math.atan2(this.pos.z - tigerPos.z, this.pos.x - tigerPos.x) + this.rng.range(-0.9, 0.9)
          this.target.set(this.pos.x + Math.cos(a) * 18, 0, this.pos.z + Math.sin(a) * 18)
        }
        const panicSpeed = (this.kind === 'hunter' ? HUMAN.hunter.chaseSpeed : HUMAN.villager.fleeSpeed) * 1.12
        this.moveToward(this.target, this.staggerTimer > 0 ? 0.4 : panicSpeed, dt)
        break
      }

      default:
        break
    }
  }

  /**
   * Pick a door and take a slot behind it.
   *
   * The score is the walk to the doorstep plus a penalty for doors near the
   * tiger, so that a hut twenty metres off in clear air beats one ten metres
   * away that means running past the thing chasing you. Huts the tiger is
   * already standing on are out entirely — running into a room with a tiger in
   * it is not hiding, it is queueing.
   */
  private claimHut(world: World, tigerPos: THREE.Vector3): boolean {
    this.hideCooldown = 0.6
    let best: Hut | null = null
    let bestScore = Infinity
    for (const h of world.huts) {
      if (h.occupants >= h.capacity) continue
      const d = Math.hypot(h.out.x - this.pos.x, h.out.z - this.pos.z)
      if (d > HUT.seekRange) continue
      if (Math.hypot(h.x - tigerPos.x, h.z - tigerPos.z) < HUT.tigerClear) continue
      const doorFromTiger = Math.hypot(h.out.x - tigerPos.x, h.out.z - tigerPos.z)
      const score = d + Math.max(0, 26 - doorFromTiger) * 1.5
      if (score < bestScore) {
        bestScore = score
        best = h
      }
    }
    if (!best) return false
    best.occupants++
    this.hideHut = best
    this.hideStage = 0
    this.hideTimeout = 4 + bestScore / HUMAN.villager.fleeSpeed
    return true
  }

  /** Give the slot back. Safe to call on someone who never had one. */
  private releaseHut() {
    if (!this.hideHut) return
    this.hideHut.occupants = Math.max(0, this.hideHut.occupants - 1)
    this.hideHut = null
  }

  private fire(tigerPos: THREE.Vector3, dist: number, waveScale: number) {
    const h = HUMAN.hunter
    const origin = new THREE.Vector3(this.pos.x, this.pos.y + HUMAN.eyeHeight, this.pos.z)
    const dir = new THREE.Vector3(
      tigerPos.x - origin.x,
      tigerPos.y + 1.2 - origin.y,
      tigerPos.z - origin.z,
    ).normalize()

    // Aim error grows with range; a sprinting tiger is a harder target.
    const spread = h.spread * (1 + dist / h.fireRange)
    const miss = this.rng.next() < clamp(spread * 6, 0.08, 0.6)
    if (miss) {
      dir.x += this.rng.range(-spread, spread) * 5
      dir.y += this.rng.range(-spread, spread) * 3
      dir.z += this.rng.range(-spread, spread) * 5
      dir.normalize()
    }
    this.pendingShot = {
      origin,
      dir,
      damage: h.damage * (1 + waveScale),
      hit: !miss,
    }
    // Recoil kick on the rifle arm.
    this.staggerTimer = Math.max(this.staggerTimer, 0.12)
  }

  private moveToward(dest: THREE.Vector3, speed: number, dt: number) {
    if (this.staggerTimer > 0) speed *= 0.25
    const dx = dest.x - this.pos.x
    const dz = dest.z - this.pos.z
    const d = Math.hypot(dx, dz)
    if (d < 0.4) {
      this.vel.x = damp(this.vel.x, 0, 8, dt)
      this.vel.z = damp(this.vel.z, 0, 8, dt)
      return
    }
    const wantX = (dx / d) * speed
    const wantZ = (dz / d) * speed
    this.vel.x = damp(this.vel.x, wantX, 8, dt)
    this.vel.z = damp(this.vel.z, wantZ, 8, dt)
    if (this.state !== 'hunt') {
      const targetYaw = Math.atan2(-this.vel.x, -this.vel.z)
      this.yaw = angleDamp(this.yaw, targetYaw, 8, dt)
    }
  }

  private faceToward(p: THREE.Vector3, dt: number, rate: number) {
    const targetYaw = Math.atan2(-(p.x - this.pos.x), -(p.z - this.pos.z))
    this.yaw = angleDamp(this.yaw, targetYaw, rate, dt)
  }
  private faceAwayFrom(p: THREE.Vector3, dt: number, rate: number) {
    const targetYaw = Math.atan2(p.x - this.pos.x, p.z - this.pos.z)
    this.yaw = angleDamp(this.yaw, targetYaw, rate, dt)
  }

  private updateMotion(dt: number, world: World) {
    this.pos.x += this.vel.x * dt
    this.pos.z += this.vel.z * dt
    const r = world.resolve(this.pos.x, this.pos.z, HUMAN.radius, this.pos.y + 1)
    this.pos.x = r.x
    this.pos.z = r.z
    if (r.hit) {
      // Bumped a wall — repath next tick instead of grinding against it.
      this.repathTimer = Math.min(this.repathTimer, 0.15)
    }
    this.pos.y = terrainHeight(this.pos.x, this.pos.z)
  }

  // ------------------------------------------------------------ animation
  /**
   * The walk.
   *
   * The legs are solved, not posed. Every previous attempt at this was forward
   * kinematics — swing the hip on a sine, fold the knee on a bump, cancel the
   * ankle against both — and forward kinematics cannot keep a foot on the ground,
   * because where the foot ends up is whatever the three angles happen to add to.
   * The old curves put a "planted" foot 0.40 m out of position over a 0.73 m step:
   * more than half the stride spent sliding. That is the single reason the walk
   * read as animated rather than as movement, and no amount of retuning the
   * amplitudes fixes it — the constraint isn't expressible in that form.
   *
   * So it runs the other way round. The contact point under the foot is *pinned*
   * to the ground and recedes through body space at exactly one stride per cycle,
   * the foot rolls over it from heel to ball, the ankle is derived from the foot,
   * the pelvis is dropped to whatever height puts that ankle inside the leg's
   * reach, and the hip and knee are solved from there. Nothing can skate, because
   * nothing is free to: the sole is an input.
   *
   * The pay-off beyond the sliding: nothing about the walk is a number somebody
   * picked any more. Solving out the whole cycle gives 12 degrees of knee flexion
   * at heel strike and 53 through the swing at 1.6 m/s, rising to 67 at a sprint,
   * against 5-15 and 60-65 in a real one — and a 58 mm pelvis rise and fall, where
   * a real walk is about 45. All of it falls out of the ground constraint.
   */
  private animate(dt: number) {
    const speed = Math.hypot(this.vel.x, this.vel.z)
    const amp = clamp(speed / 4.2, 0, 1)
    /** How far into a run, as opposed to a walk. */
    const run = clamp((speed - 2.4) / 3.4, 0, 1)
    // Below walking pace the gait fades out to a stand rather than freezing
    // mid-stride with a foot in the air.
    const gait = smooth01((speed - 0.1) / 0.55)
    // Duty factor: both feet down for a fifth of a walk, neither of them down at
    // a jog and above. It has to start falling from 1.4 m/s, because the only other
    // way to cover ground is cadence, and a villager hurrying at 2.4 m/s on a
    // walker's duty factor mills his legs at three and a half steps a second.
    // With this it is 2.4 steps/s at 1.6 m/s and 5.3 at a full sprint, and neither
    // number was chosen: the travel and the duty imply the stride, the stride and
    // the speed imply the cadence.
    const jog = clamp((speed - 1.4) / 3.5, 0, 1)
    const duty = 0.62 - 0.26 * jog
    // Contact travel, faded out to a floor rather than to zero. The floor is what
    // stops the phase rate blowing up as the speed goes to nothing, and it is why a
    // villager who stops mid-swing puts that foot down where it was going instead
    // of freezing it in the air: only the ankle lift fades, never the ground plan.
    const travel = Math.max(Math.min(0.78 + 0.025 * speed, 0.87) * gait, 0.34)
    const stride = travel / duty
    this.stepPhase = (this.stepPhase + (speed * dt) / stride) % 1
    this.idleTime += dt

    const aiming = this.kind === 'hunter' && (this.state === 'hunt' || this.aimTimer > 0.1)
    const terrified = this.state === 'panic' || (this.state === 'flee' && speed > 3)
    this.aimBlend = damp(this.aimBlend, aiming ? 1 : 0, 7, dt)
    this.panicBlend = damp(this.panicBlend, terrified ? 1 : 0, 6, dt)
    this.lean = damp(this.lean, clamp(speed / 13, 0, 0.34) + this.panicBlend * 0.1, 6, dt)

    this.resetPose()
    const c = this.stepPhase
    const w = c * TAU
    const sw = Math.sin(w)
    const cw = Math.cos(w)
    /** Breath, so a villager standing still is not a statue. */
    const breath = Math.sin(this.idleTime * 1.7) * (1 - amp)

    // ---- pelvis. Shifts toward the stance leg, rotates forward with the swinging
    // one, drops on the swing side. No vertical term: the height is solved below,
    // and a hand-authored rise on top of a solved one is how you get a limp.
    this.hips.position.x += amp * -0.022 * sw
    this.hips.rotation.y = amp * -0.1 * cw
    this.hips.rotation.z = amp * -0.05 * sw

    // ---- spine. Counter-rotation against the pelvis, plus the lean into the run.
    this.spine.rotation.x = this.lean * 0.55 + breath * 0.012
    this.spine.rotation.y = amp * 0.05 * cw
    this.chest.rotation.x = this.lean * 0.45 - breath * 0.02
    this.chest.rotation.y = amp * 0.15 * cw
    this.chest.rotation.z = amp * 0.035 * sw
    // Head holds its line while the body works underneath it — the thing that
    // makes a walk look like a person going somewhere rather than a puppet.
    this.neck.rotation.x = -this.lean * 0.55 + breath * 0.01
    this.neck.rotation.y = -(this.hips.rotation.y + this.chest.rotation.y) * 0.7
    this.head.rotation.x = -this.lean * 0.45 + amp * 0.02 * Math.cos(2 * w)
    this.head.rotation.y = breath * 0.05

    // ---- legs. Ankle targets first, then the pelvis height they imply, then the
    // solve. Order matters: the hip has to be somewhere before the leg can reach.
    const phase = [c, (c + 0.5) % 1]
    let floor = 0.92
    for (let i = 0; i < 2; i++) {
      const t = footTarget(phase[i]!, duty, travel, gait, run, FOOT[i]!)
      t.x = (i === 0 ? -1 : 1) * 0.092
      // Body-space z is squashed by the girth scale, so the stride would come out
      // 10% long on a wide villager and the feet would skate by the difference.
      t.z /= this.wide
      // How high this leg can hold the pelvis with that ankle under it — but only
      // while the foot is actually on the ground. An airborne leg is free to fold,
      // so it must not vote: for the first fraction of swing the trailing ankle is
      // still stretched out behind and nearly straight, and letting it vote put a
      // second four-centimetre dip in the middle of every step. Four dips a cycle
      // instead of two is a limp, and it was the most obvious thing left in the walk.
      // Hands over to the landing leg across the last fifth of its swing rather
      // than the last few percent: the pelvis has to be on its way down before
      // the heel arrives, or the leg is still 3 cm short of the ground when it is
      // supposed to be taking weight.
      const plant = 1 - smooth01((phase[i]! - duty) / 0.07) + smooth01((phase[i]! - 0.8) / 0.2)
      hipOff.set(t.x < 0 ? -0.085 : 0.085, 0, 0).applyQuaternion(this.hips.quaternion)
      const dx = t.x - (this.hips.position.x + hipOff.x)
      const dz = t.z - hipOff.z
      const span = Math.max(L_REACH * L_REACH - dx * dx - dz * dz, 0.01)
      const lift = t.y - hipOff.y + Math.sqrt(span)
      // A soft min rather than Math.min: a hard changeover between which leg is
      // limiting puts a corner in the pelvis height, and a corner is a hitch.
      const vote = 0.92 + (lift - 0.92) * plant
      floor = 0.5 * (floor + vote) - 0.5 * Math.sqrt((floor - vote) * (floor - vote) + 0.0004)
    }
    this.hips.position.y = clamp(floor, 0.6, 0.92)
    for (let i = 0; i < 2; i++) {
      this.solveLeg(this.legs[i]!, FOOT[i]!)
      // Contralateral: each arm swings with the opposite leg.
      this.poseArm(this.arms[i]!, (phase[i]! + 0.5) % 1, amp, run, i === 0 ? -1 : 1)
    }

    if (this.panicBlend > 0.01) this.posePanic(this.panicBlend, c)
    if (this.aimBlend > 0.01) this.poseAim(this.aimBlend)

    // Clutching the wound while they run. Not while aiming — a man with a rifle
    // up has both hands committed, and that is the point of him.
    const hurtAmt = clamp(1 - this.health / this.maxHealth, 0, 1) * (1 - this.aimBlend)
    if (hurtAmt > 0.25) {
      const a = this.arms[1]!
      a.upper.rotation.x += hurtAmt * 0.55
      a.upper.rotation.z += -hurtAmt * 0.45
      a.fore.rotation.x += hurtAmt * 1.5
      a.fore.rotation.y += -hurtAmt * 0.5
    }

    // The whipped-away lean from the last blow. Applied to the whole body rather
    // than the spine so the legs buckle with it — a struck man folds, he doesn't
    // bow politely from the waist.
    this.body.rotation.x = this.leanX * 0.5
    this.body.rotation.z = this.leanZ * 0.5

    this.placeRifle()
  }

  /**
   * Two-bone IK: put the ankle on the target, bend the knee backwards to get it
   * there, then counter-rotate the foot so the sole holds the pitch the gait asked
   * for regardless of how the leg above it ended up arranged.
   *
   * The target arrives in body space and has to be solved in the pelvis' frame,
   * because the pelvis rotates and sways and the thigh hangs off it — solving in
   * body space and ignoring that is how a walk ends up with the feet swinging
   * sideways every time the hips turn.
   */
  private solveLeg(leg: Leg, t: FootTarget) {
    const hips = this.hips
    ikV.set(t.x, t.y, t.z).sub(hips.position).applyQuaternion(qInv.copy(hips.quaternion).invert())
    ikV.x -= t.x < 0 ? -0.085 : 0.085
    const d = clamp(ikV.length(), Math.abs(L_THIGH - L_SHIN) + 0.02, (L_THIGH + L_SHIN) * 0.999)
    // Interior angle at the knee, then the thigh's lift off the hip-to-ankle line.
    const bend = Math.acos(clamp((L_THIGH * L_THIGH + L_SHIN * L_SHIN - d * d) / (2 * L_THIGH * L_SHIN), -1, 1))
    const lift = Math.acos(clamp((d * d + L_THIGH * L_THIGH - L_SHIN * L_SHIN) / (2 * d * L_THIGH), -1, 1))
    leg.thigh.quaternion
      .setFromUnitVectors(DOWN, ikV.normalize())
      .multiply(qTmp.setFromAxisAngle(XAXIS, lift))
    leg.shin.rotation.set(bend - Math.PI, 0, 0)
    // Sole pitch is absolute, so the foot cancels everything above it.
    qAcc.copy(hips.quaternion).multiply(leg.thigh.quaternion).multiply(leg.shin.quaternion)
    leg.foot.quaternion.copy(qAcc.invert()).multiply(qTmp.setFromAxisAngle(XAXIS, t.pitch))
    // Rising onto the ball of the foot extends the toes: they stay flat on the
    // ground while the heel comes up, which is the last third of a real step and
    // the part that makes it look like it pushed off something.
    leg.toe.rotation.set(t.pitch < 0 ? -t.pitch : 0, 0, 0)
  }

  /**
   * The arm swing, and the rest pose it swings around.
   *
   * Nobody stands with a straight arm hanging flat against the ribs — the elbow
   * carries 10 degrees, the humerus is abducted 6 and rolled slightly in, and the
   * shoulder is a shade forward of the coronal plane. Zeroing all three is the
   * single clearest tell of a rig that has never been posed: it reads as a
   * mannequin no matter how good the mesh is.
   */
  private poseArm(arm: Limb, c: number, amp: number, run: number, side: number) {
    const w = c * TAU
    const swing = amp * (0.4 + run * 0.32) * Math.cos(w)
    arm.upper.rotation.x = 0.09 + swing
    // Held a little off the ribs, more so the faster they go, and rolled in at the
    // humerus so the elbow points back rather than straight out sideways.
    arm.upper.rotation.z = side * (0.11 + amp * 0.07)
    arm.upper.rotation.y = side * -0.14
    // The elbow is never straight, and closes as the hand comes forward.
    arm.fore.rotation.x = 0.2 + amp * (0.5 + run * 0.75) * (0.5 + 0.5 * Math.cos(w))
    this.setClav(arm)
  }

  /**
   * Shoulder girdle. The clavicle takes a third of whatever the humerus is doing.
   *
   * Not decoration — it is the only defence this rig has against the standard
   * linear-blend-skinning collapse. A deltoid vertex sitting half on the clavicle
   * and half on the humerus shrinks to cos(theta/2) of its radius under a relative
   * rotation theta, so an arm thrown up 2.45 rad over the head pinches the shoulder
   * to 0.34 of its width and the arm appears to come out of a dent. Handing 33% of
   * the raise to the clavicle, plus capping the panic raise, takes the worst case
   * from 0.34 to 0.79, and it happens to be exactly what a real shoulder does.
   */
  private setClav(arm: Limb) {
    const raise = arm.upper.rotation.x
    arm.clav.rotation.x = raise * 0.33
    arm.clav.rotation.z = arm.upper.rotation.z * 0.33
    arm.upper.rotation.x = raise * 0.67
    arm.upper.rotation.z *= 0.67
  }

  /** Arms over the head, body thrown forward. Blended in, so it can be partial. */
  private posePanic(k: number, c: number) {
    const flail = Math.sin(c * TAU * 2)
    for (let i = 0; i < 2; i++) {
      const a = this.arms[i]!
      const side = i === 0 ? -1 : 1
      // 1.9 rather than 2.45, and abducted rather than raised straight up the
      // sagittal plane. Past about two radians the shoulder cannot hold its volume
      // (see setClav) and the elbows also swing in front of the face and hide it,
      // which on a panicking villager is the thing you actually want to see.
      const x = 1.9 + flail * (i === 0 ? 0.35 : -0.35)
      a.upper.rotation.x = a.upper.rotation.x + (x - a.upper.rotation.x) * k
      a.upper.rotation.z += (side * 0.8 - a.upper.rotation.z) * k
      a.fore.rotation.x += (1.05 - a.fore.rotation.x) * k
      this.setClav(a)
    }
  }

  /**
   * Rifle up. Both hands on the weapon, which the old rig could not do at all:
   * its arms were rigid, so a hand could only ever sit half a metre dead in line
   * with the shoulder and never landed on the grip. With an elbow the right hand
   * comes to the shoulder and the left reaches under the fore-end, and the gun
   * is then placed *from* the hand rather than the hand waved near the gun.
   */
  private poseAim(k: number) {
    const blend = (b: THREE.Bone, x: number, y: number, z: number) => {
      b.rotation.x += (x - b.rotation.x) * k
      b.rotation.y += (y - b.rotation.y) * k
      b.rotation.z += (z - b.rotation.z) * k
    }
    // Bladed stance: chest turned across the line of fire, head back onto it.
    blend(this.chest, this.chest.rotation.x, -0.3, 0)
    blend(this.neck, -0.05, 0.22, 0)
    // Trigger hand high and tight, elbow out.
    blend(this.arms[1]!.upper, 0.5, 0, -0.62)
    blend(this.arms[1]!.fore, 1.85, 0, -0.15)
    // Support hand forward, under the fore-end.
    blend(this.arms[0]!.upper, 1.15, 0, 0.3)
    blend(this.arms[0]!.fore, 1.05, 0, -0.35)
    this.setClav(this.arms[0]!)
    this.setClav(this.arms[1]!)
  }

  /**
   * Put the rifle where the hands are.
   *
   * Reading the posed hand back out of the skeleton costs one matrix update on
   * at most fourteen hunters, and it means the grip lands in the palm for every
   * pose without a single hand-tuned offset. Orientation comes from the aim, not
   * from the wrist: a rifle whose muzzle followed the hand's roll would wander
   * off target every time the arm swung.
   */
  private placeRifle() {
    const rifle = this.rifle
    if (!rifle || !rifle.visible) return
    const k = this.aimBlend
    if (k > 0.01) {
      this.body.updateMatrixWorld(true)
      this.arms[1]!.hand.getWorldPosition(handAt)
      this.body.worldToLocal(handAt)
      // Toward the grip, which sits behind and below the muzzle line.
      slungPos.set(handAt.x - 0.02, handAt.y + 0.06, handAt.z - 0.06)
      rifle.position.lerpVectors(SLUNG_POS, slungPos, k)
      rifle.rotation.set(
        THREE.MathUtils.lerp(SLUNG_ROT.x, -0.04, k),
        THREE.MathUtils.lerp(SLUNG_ROT.y, 0.16, k),
        THREE.MathUtils.lerp(SLUNG_ROT.z, 0, k),
      )
    } else {
      // Slung across the back, muzzle above the left shoulder. A sling needs no
      // hands, leaves the walk swing alone, and still says "armed" from the front.
      rifle.position.copy(SLUNG_POS)
      rifle.rotation.copy(SLUNG_ROT)
    }
  }

  private updateDeath(dt: number) {
    this.deathTimer += dt

    // Arterial pulses for the first couple of seconds. The game reads the flag
    // and sprays from woundPos; this only decides when.
    if (this.bleedTimer > 0) {
      this.bleedTimer -= dt
      this.bleedNext -= dt
      if (this.bleedNext <= 0) {
        this.bleedNext = HUMAN.bleedInterval
        this.bleedPulse = true
        this.woundPos.set(this.pos.x, this.pos.y + 0.9 - (1 - this.bleedTimer / HUMAN.bleedDuration) * 0.6, this.pos.z)
      }
    }

    const t = this.deathTimer
    const force = this.deathForce

    // Blood keeps arriving after the fall — the streaks lengthen for as long as
    // there is pressure behind them, which is what stops the wounds reading as
    // a texture that was already on him when he died.
    if (this.bleedTimer > 0 && this.bleedPulse) {
      this.bleedRun(0.1 + (1 - this.bleedTimer / HUMAN.bleedDuration) * 0.34)
    }

    // ---- the fall.
    //
    // Two things happen and they do not happen together. First the legs stop
    // holding him up, which drops the whole body a third of a metre straight
    // down; then it goes over. Playing only the second — which is what a single
    // topple curve does — is a felled tree, and a felled tree is stiff no matter
    // how well its landing is timed. The gap between the two is small, about a
    // tenth of a second, and it is the entire difference.
    //
    // How much of each depends on what killed him. `force` 0 is a man who
    // simply stopped: the legs go, he sags, and he arrives folded more or less
    // where he stood. `force` 1 is a pounce: no buckle worth seeing, he is off
    // the ground and turned over before the legs are relevant at all.
    const buckle = smooth01(t / (0.24 - force * 0.14))
    const delay = 0.11 * (1 - force)
    const fall = clamp((t - delay) / (0.62 - force * 0.24), 0, 1)
    const eased = smooth01(fall)

    // The impact, and what is left of it. A body that reaches the ground and
    // stops on the exact frame it arrives has no weight; one that overshoots
    // and rocks back through a couple of quickly-dying cycles does.
    const after = Math.max(0, t - (delay + (0.62 - force * 0.24)))
    const bounce = Math.exp(-after * 7) * Math.sin(after * 21) * (0.05 + force * 0.07)

    // Not quite flat. A body has a chest and a hip on it, so it comes to rest
    // canted a few degrees off the ground rather than pressed against it, and a
    // crumpled one keeps more of that than a flung one.
    const tip = (Math.PI / 2) * (0.88 + force * 0.1) * eased + bounce

    // Topple about the horizontal axis that carries the spine over toward the
    // fall direction, rather than by adding an x and a z Euler term. The Euler
    // pair is exact on the two cardinal directions and wrong everywhere between
    // them — two 90-degree terms compose to about 120 degrees on the diagonal,
    // so a body knocked at 45 degrees rolled a third of a turn past the ground
    // and came to rest face down having gone through itself. It also cannot
    // express the twist about the spine at all.
    TOPPLE_AXIS.set(this.fallZ, 0, -this.fallX).normalize()
    Q_TOPPLE.setFromAxisAngle(TOPPLE_AXIS, tip)
    Q_ROLL.setFromAxisAngle(UP, this.deathRoll * eased)
    this.body.quaternion.copy(Q_TOPPLE).multiply(Q_ROLL)

    // Height of the body's root, which sits between the feet.
    //
    // Standing, dropping it drops the hips. Flat, it is the line the spine lies
    // along, so it has to come back *up* to half a torso or the body is buried
    // to its ribs in the dirt — which is what the old constant -0.12 did, and
    // why every corpse in the game was sunk to the shoulder blades with its
    // arms underground. Blended by the same curve as the fall, so the drop
    // hands over to the lift as the one stops meaning anything and the other
    // starts.
    const sag = -0.34 * buckle * (1 - force * 0.45)
    this.body.position.y = sag + (LIE_HEIGHT - sag) * eased

    // ---- going slack.
    //
    // A corpse is not a mannequin laid down: the spine curls, the knees stay
    // half bent under it, an arm ends up across the chest and the head lolls
    // off the neck. Every angle carries a per-death offset on top, because the
    // pool is twenty bodies and the player will see all twenty — a shared slack
    // pose is the single loudest tell that these are the same few models, and
    // it is louder than any amount of variation in their faces.
    const j = this.jitter
    const l = 5.5

    // Which way is up, in the body's own frame.
    //
    // Everything below this line depends on it, and getting it wrong is what
    // made the first pass of this look so wrong. A limb joint has two axes and
    // they are not interchangeable once the body is horizontal: one of them
    // swings the limb around *on* the ground, and the other lifts it off the
    // ground or drives it through it. Which is which depends on whether the man
    // landed on his back, his face or his side, so a slack pose authored blind
    // — the same hip flexion for everybody — has to be wrong most of the time,
    // and it was wrong all of the time, because it flexed both hips and every
    // corpse ended up holding both legs in the air like a dead beetle.
    //
    // The body topples about (fallZ, 0, -fallX) *after* a twist about its own
    // spine, and those two compose into a pair of numbers that between them say
    // where the sky is: one across his chest, one across his shoulders. Reading
    // fallZ alone — which is what the first pass did — ignores the twist and so
    // calls a man lying on his face supine as soon as he rolls a quarter turn.
    // They are the two halves of a unit vector, so a body is flat exactly to
    // the extent that it is not on its side.
    const roll = this.deathRoll * eased
    const cr = Math.cos(roll)
    const sr = Math.sin(roll)
    const face = this.fallX * sr + this.fallZ * cr // +1 flat on his back, -1 face down
    const tilt = this.fallZ * sr - this.fallX * cr // which shoulder ended up underneath
    const side = 1 - Math.abs(face) // 0 flat, 1 edge-on

    // A spine can only curl into the space beside it, so a man flat on his back
    // has nowhere to put a curl and one lying on his side has all of it. Doing
    // this unconditionally is what used to lift a supine corpse's shoulders off
    // the ground as though he were halfway through a sit-up.
    const curl = (0.12 + (1 - force) * 0.26) * (0.35 + side * 0.65)
    this.spine.rotation.x = damp(this.spine.rotation.x, curl + j[0]! * 0.1, l, dt)
    // Sideways, the spine does not curl so much as give up: it sags downhill,
    // toward whichever shoulder is taking the weight.
    this.spine.rotation.z = damp(this.spine.rotation.z, -tilt * 0.14 + j[1]! * 0.12, l, dt)
    this.chest.rotation.x = damp(this.chest.rotation.x, curl * 0.5 + j[2]! * 0.1, l, dt)
    this.chest.rotation.y = damp(this.chest.rotation.y, this.fallX * 0.2 + j[3]! * 0.18, l, dt)
    // The head is the tell. It is the heaviest thing on the end of the softest
    // joint, so it keeps moving after everything else has stopped — which is
    // why it damps slower than the rest and carries the widest jitter. Which
    // way it lolls is the same question as everywhere else: a chin drops toward
    // the chest on a man lying on his back, and lifts clear of the dirt on one
    // lying on his face.
    this.neck.rotation.x = damp(this.neck.rotation.x, face * 0.24 + j[4]! * 0.2, 3.5, dt)
    this.head.rotation.z = damp(this.head.rotation.z, -tilt * 0.5 + j[5]! * 0.4, 3, dt)
    this.head.rotation.y = damp(this.head.rotation.y, -this.fallX * 0.4 + j[6]! * 0.45, 3, dt)
    this.hips.rotation.x = damp(this.hips.rotation.x, j[7]! * 0.1, l, dt)
    this.hips.rotation.y = damp(this.hips.rotation.y, this.deathRoll * -0.18, l, dt)
    this.hips.rotation.z = 0

    // Drape the dhoti. It is bound to a bone of its own for exactly this: cloth
    // that keeps a 47 cm hem circle while its wearer is face-down on the dirt is
    // a lampshade, and no amount of work on the pose underneath survives being
    // seen through one. The squash goes on whichever body axis is pointing at
    // the sky — front-to-back for a man on his back or his face, across for one
    // on his side — and what it takes out of that axis it gives back to the
    // other, because fabric collapsing under its own weight spreads, it does not
    // shrink. Damped rather than set, so it settles as he does.
    // It also gets shorter. A hem that hung at the knee off a standing man is
    // resting on his thigh once he is horizontal, and cloth that has stopped
    // being pulled straight by gravity gathers rather than staying at length.
    const flat = Math.abs(face)
    const sq = this.skirt.scale
    sq.x = damp(sq.x, 1 - 0.46 * side + 0.20 * flat, 3.5, dt)
    sq.z = damp(sq.z, 1 - 0.46 * flat + 0.20 * side, 3.5, dt)
    sq.y = damp(sq.y, 0.87, 3.5, dt)

    // One leg drawn up under him, the other straight out. Both flat is a
    // shop-window dummy and both drawn up is the beetle again; one of each is
    // what a body that stopped holding itself together actually does, and it is
    // asymmetric, which is most of why it reads as a person.
    //
    // The knee is the joint that has to be reasoned about rather than dialled
    // in, because it is a one-way hinge and which way that is relative to the
    // sky flips with the facing. So rather than dial an angle in and hope, the
    // pose says where the ankle has to *finish* and the knee is solved for it.
    // Lying flat, the ankle sits `face * shin * (sin hip + sin (hip - fold))`
    // above the hip, and inverting that is the whole of it: on his back the hip
    // lifts the knee and the knee folds the foot back down onto the dirt, which
    // is the propped leg everybody has seen; on his face the hip has nowhere to
    // go and the fold lifts the heel instead; on his side both joints swing
    // flat across the ground and can do as they like, so the solve fades out
    // and a free pose fades in. Folding by a fixed amount regardless is what
    // stood a corpse's shin vertically in the air with daylight under the leg.
    const drawn = j[8]! > 0 ? 0 : 1
    const supine = Math.max(0, face)
    const prone = Math.max(0, -face)
    // Divide by this rather than by `face`: it is the same thing while he is
    // anywhere near flat and it stays finite when he is on his side, where the
    // height of a knee has stopped depending on the hip at all.
    const lean = face / Math.max(flat, 0.34)
    for (let i = 0; i < 2; i++) {
      const leg = this.legs[i]!
      const jj = j[8 + i]!
      const out = i === 0 ? 1 : -1
      const heavy = i === drawn
      // Hip flexion, only as much of it as the ground will take.
      const hip =
        supine * (heavy ? 0.85 + Math.abs(jj) * 0.3 : 0) +
        side * (heavy ? 0.55 + Math.abs(jj) * 0.35 : 0.14) -
        face * 0.12 +
        jj * 0.05
      // A limb is thinner than a chest, and the body lies at the height that
      // suits the chest, so a leg left on that line hovers a couple of inches
      // up with a shadow gap under it — every ankle wants pressing below the
      // hip, not level with it.
      const heel = prone * (heavy ? 0.12 + Math.abs(jj) * 0.1 : 0) - 0.07
      const solved = hip - Math.asin(clamp(heel / (lean * SHIN) - Math.sin(hip), -1, 1))
      // A knee does not go backwards, however much the arithmetic would like it
      // to; past straight it just locks, which is what a dead one does anyway.
      const fold = Math.max(0, solved * flat + (heavy ? 1.05 + Math.abs(jj) * 0.4 : 0.24) * (1 - flat))
      // Splay slides the leg sideways across the dirt while he is flat, and
      // straight down through it once he is on his side, so it goes away as the
      // body rolls over.
      const splay = out * (heavy ? 0.26 : 0.05) * (0.4 + flat * 0.6) + jj * 0.16
      leg.thigh.rotation.x = damp(leg.thigh.rotation.x, hip, l, dt)
      leg.thigh.rotation.z = damp(leg.thigh.rotation.z, splay, 5, dt)
      leg.shin.rotation.x = damp(leg.shin.rotation.x, -fold, l, dt)
      // Ankles go slack, and a slack ankle points and rolls out from under
      // itself. This is the one that reads from across the village: a corpse
      // with its feet still square to the shin is standing up lying down.
      leg.foot.rotation.x = damp(leg.foot.rotation.x, -0.8 + jj * 0.18, l, dt)
      leg.foot.rotation.z = damp(leg.foot.rotation.z, out * 0.4, l, dt)
      leg.toe.rotation.x = damp(leg.toe.rotation.x, 0.1 + jj * 0.12, l, dt)
    }

    // Arms, on the same rule. Thrown bodies land with them out wide; a man who
    // folded takes them down with him and ends up on top of one.
    //
    // The shoulder's z spreads the arm out sideways, which is the ground-plane
    // axis only while he is flat: on his side it points at the sky, and a spread
    // authored regardless is what had a man lying on his shoulder holding the
    // other arm straight up in the air. So it scales away with the roll, and
    // what replaces it is both arms draping toward whichever shoulder ended up
    // underneath, because that is downhill for both of them.
    //
    // The elbow is an elbow: it goes one way, and that way is up off a man's
    // chest and down through a man's chest, so it gets the bend only when there
    // is somewhere for the hand to end up. On his back that is folded across
    // him; on his face it is nowhere, and a corpse lying with its arms straight
    // out is right anyway. The old flat 1.1 radians gave the whole thing away
    // worst of all — it stood the forearm straight up off a supine body like a
    // man asking a question.
    const flung = 0.35 + force * 0.75
    const arms: [Limb, number, number, number][] = [
      [this.arms[0]!, 0.95, supine * 0.62 + side * 0.5 + prone * 0.1, j[10]!],
      [this.arms[1]!, -1.15, supine * 0.34 + side * 0.42 + prone * 0.08, j[11]!],
    ]
    for (const [arm, z, fore, jj] of arms) {
      const swing = -face * (0.1 + Math.abs(jj) * 0.22) + side * (0.3 + jj * 0.5)
      arm.upper.rotation.x = damp(arm.upper.rotation.x, swing, 4.5, dt)
      const spread = z * flung * flat - tilt * (0.45 + Math.abs(jj) * 0.2)
      arm.upper.rotation.z = damp(arm.upper.rotation.z, spread + jj * 0.3, 4.5, dt)
      arm.fore.rotation.x = damp(arm.fore.rotation.x, fore + Math.abs(jj) * 0.45, 4.5, dt)
      // A dead hand is not a fist and it is not a flat plate. It half closes.
      arm.hand.rotation.x = damp(arm.hand.rotation.x, -0.3 + jj * 0.35, 4, dt)
    }

    // Lie *on* the ground, not standing upright through a slope. Two height
    // samples give the gradient; the corpse pitches and rolls onto it.
    const gx = terrainHeight(this.pos.x + 0.6, this.pos.z) - terrainHeight(this.pos.x - 0.6, this.pos.z)
    const gz = terrainHeight(this.pos.x, this.pos.z + 0.6) - terrainHeight(this.pos.x, this.pos.z - 0.6)
    this.group.rotation.set(clamp(gz / 1.2, -0.5, 0.5) * eased, this.yaw, -clamp(gx / 1.2, -0.5, 0.5) * eased, 'YXZ')
    this.group.position.copy(this.pos)

    // ---- what pools under it. Stamped from where the torso actually came to
    // rest rather than from where the feet were: the body travels most of its
    // own length going down, so a pool at `pos` is a pool beside the corpse.
    // It arrives late and grows, because that is how long a body takes to make
    // one and watching it spread is worth more than having it there on frame 1.
    if (this.poolCount < this.poolMax) {
      this.poolNext -= dt
      if (this.poolNext <= 0 && eased > 0.7) {
        this.poolNext = 1.7
        this.poolCount++
        this.chest.getWorldPosition(this.poolPos)
        // The eighth stamp used to come out at 3.86, which the decal's own
        // 2–3.6x spread turned into a fourteen-metre disc of blood from one
        // man. A body empties about five litres; on packed dirt that is a metre
        // and a half of pool, not a tennis court. The ramp now ends a little
        // under one, and the widening still reads because it starts small.
        this.poolScale = 0.30 + this.poolCount * 0.075
        this.poolPulse = true
      }
    }

    // ---- and finally, out of the world.
    //
    // This used to drive the body 2.2 m straight down, and at any range you
    // could actually see it that is a lift descending, not a corpse decaying.
    // Fading it out over the same couple of seconds while it settles a few
    // centimetres into the dirt reads as the ground taking it back.
    if (t > HUMAN.corpseLife) {
      const gone = clamp((t - HUMAN.corpseLife) / 2, 0, 1)
      this.group.position.y = this.pos.y - gone * 0.18
      for (const m of this.mats) {
        if (!m.transparent) {
          m.transparent = true
          m.depthWrite = false
        }
        m.opacity = 1 - gone
      }
      if (gone >= 1) this.group.visible = false
    }
  }

  /** True once the corpse has fully sunk and the slot can be reused. */
  get expired(): boolean {
    return !this.alive && this.deathTimer > HUMAN.corpseLife + 2
  }
}

/** Where the rifle rides when it isn't in the hands. */
const SLUNG_POS = new THREE.Vector3(0.05, 1.14, 0.19)
const SLUNG_ROT = new THREE.Euler(1.2, 0.62, 0)
const handAt = new THREE.Vector3()
const slungPos = new THREE.Vector3()

/**
 * How high the body's root rides once it is flat.
 *
 * The root is between the feet, so on a body lying down it is the line the
 * spine runs along — and a torso is about 23 cm through. Half of that is how
 * far the spine has to be off the soil for the back to be resting on it rather
 * than inside it. A little under half, in fact, since shoulder and hip take
 * most of the weight and the ground gives.
 */
const LIE_HEIGHT = 0.115

/** Knee to ankle, from the rig. The corpse pose solves the knee against it. */
const SHIN = 0.42

const SOAK_AT = new THREE.Vector3()
const WOUND_AT = new THREE.Vector3()
const RUN_AT = new THREE.Vector3()

/**
 * How far the body's surface is from its vertical axis at height `y`, looking
 * along the horizontal unit direction (dx, dz). Bind pose, body units.
 *
 * The torso is the sweep in TORSO, so its rings answer this exactly: pick the
 * pair either side of `y`, lerp the half-width and half-depth, and solve the
 * ellipse for the radius in that direction. Above and below the sweep the body
 * is not a sweep at all, so those get the two numbers that matter — a throat is
 * thin and a skull is not — rather than an extrapolation off the end of a table
 * that would give a neck the width of a ribcage.
 */
function sectionR(y: number, dx: number, dz: number): number {
  let a: number
  let b: number
  const top = TORSO[TORSO.length - 1]!
  if (y >= top[0]) {
    // Neck to crown. Narrow through the throat, opening out into the head, and
    // the crossover is the jaw.
    a = b = y < 1.5 ? 0.052 : Math.min(0.098, 0.052 + (y - 1.5) * 0.6)
  } else if (y <= TORSO[0]![0]) {
    // A thigh, near enough — below the sweep there is no single trunk left.
    a = b = 0.085
  } else {
    let i = 1
    while (i < TORSO.length - 1 && TORSO[i]![0] < y) i++
    const lo = TORSO[i - 1]!
    const hi = TORSO[i]!
    const t = (y - lo[0]) / (hi[0] - lo[0])
    a = lo[1] + (hi[1] - lo[1]) * t
    b = lo[2] + (hi[2] - lo[2]) * t
  }
  // The ellipse x²/a² + z²/b² = 1 along (dx, dz).
  const q = (dx * dx) / (a * a) + (dz * dz) / (b * b)
  return q > 0 ? 1 / Math.sqrt(q) : a
}
const TOPPLE_AXIS = new THREE.Vector3()
const Q_TOPPLE = new THREE.Quaternion()
const Q_ROLL = new THREE.Quaternion()

/**
 * Bake a colour into a geometry's vertices, for the rigid props — rifle, kit,
 * hat. Wood, steel and brass in one buffer is one draw call instead of three.
 */
function tintGeo(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex)
  const n = g.attributes.position!.count
  const arr = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r
    arr[i * 3 + 1] = c.g
    arr[i * 3 + 2] = c.b
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3))
  return g
}

function smooth01(x: number): number {
  const c = x < 0 ? 0 : x > 1 ? 1 : x
  return c * c * (3 - 2 * c)
}

function angleDamp(a: number, b: number, lambda: number, dt: number): number {
  let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI
  if (diff < -Math.PI) diff += Math.PI * 2
  return a + diff * (1 - Math.exp(-lambda * dt))
}
