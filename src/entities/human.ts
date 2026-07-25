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
import { HUMAN } from '../config'
import { clamp, damp, Rng } from '../engine/rng'
import { textures } from '../world/textures'
import { terrainHeight, World } from '../world/world'

export type HumanKind = 'villager' | 'hunter'
export type HumanState = 'wander' | 'suspicious' | 'flee' | 'hunt' | 'panic' | 'dead'

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
 * why it read as a surgical mask stuck over the mouth rather than as hair. */
const GREY = [0x4f4c47, 0x5f5c55]
const TURBAN = [0xb0a48b, 0xa5522c, 0xbdb39c, 0x5f7488, 0xa8873c, 0x93362d]

/** Leather, felt and brass on the hunters' kit. */
const LEATHER = 0x513520
const FELT = 0x3f342a
const BRASS = 0xa9853f
/** Eyes, mouth and nostrils. Not black — black reads as a hole at any distance. */
const DARK = 0x140d09
/** The white of an eye, on the same scale as SKIN and then sunk in the orbital
 * shadow on top of that. Anything actually white here is a headlamp. */
const SCLERA = 0x6a635b
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
 */
function sweep(rings: readonly Ring[], radial = 12): THREE.BufferGeometry {
  const n = radial + 1
  const pos = new Float32Array(rings.length * n * 3)
  const uv = new Float32Array(rings.length * n * 2)
  const idx: number[] = []
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r]!
    for (let c = 0; c < n; c++) {
      const t = c / radial
      const a = t * TAU
      const i = r * n + c
      pos[i * 3] = Math.sin(a) * ring[1]
      pos[i * 3 + 1] = ring[0]
      pos[i * 3 + 2] = ring[3] - Math.cos(a) * ring[2]
      uv[i * 2] = t
      uv[i * 2 + 1] = r / (rings.length - 1)
    }
  }
  for (let r = 0; r < rings.length - 1; r++) {
    for (let c = 0; c < radial; c++) {
      const a = r * n + c
      const b = (r + 1) * n + c
      // Wound so the face normal points away from the axis. Rings must ascend
      // in y or the whole surface turns inside out and culls to nothing.
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
const B_FOOT = (s: string) => [`shin${s}`, `foot${s}`, `toe${s}`]

type Layer = 'skin' | 'cloth'
interface Part {
  g: THREE.BufferGeometry
  bones: string[]
  layer: Layer
  region: Reg
  /** Only read for Reg.fixed parts. */
  hex: number
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

  // Torso. The lower border of the pectoral is the one that matters: a male
  // chest is defined by a hard horizontal shadow under the muscle, not by the
  // silhouette, which is why the old hemispherical pecs could only read as
  // breasts however they were coloured.
  two(0.112, 1.302, -0.004, 0.056, 0.066, 0.062, 0.55)   // armpit
  two(0.070, 1.264, -0.086, 0.082, 0.015, 0.044, 0.56)   // under the pectoral
  one(0, 1.300, -0.104, 0.014, 0.062, 0.032, 0.34)       // sternal groove
  one(0, 1.180, -0.100, 0.010, 0.072, 0.026, 0.20)       // linea alba
  one(0, 1.128, -0.096, 0.020, 0.026, 0.026, 0.45)       // navel
  one(0, 1.200, 0.098, 0.013, 0.175, 0.032, 0.32)        // spinal groove
  one(0, 0.905, -0.030, 0.056, 0.062, 0.056, 0.50)       // groin
  one(0, 0.882, 0.096, 0.016, 0.072, 0.046, 0.45)        // gluteal cleft
  two(0.052, 1.400, 0.004, 0.042, 0.052, 0.052, 0.45)    // where the neck leaves the trapezius
  one(0, 1.500, -0.020, 0.072, 0.030, 0.070, 0.55)       // under the jaw
  one(0, 1.478, -0.050, 0.046, 0.030, 0.030, 0.42)       // under the chin

  // Limbs: the flexion creases, which are the only shading a straight tube gets.
  two(0.176, 1.056, -0.032, 0.036, 0.046, 0.030, 0.38)   // inner elbow
  two(0.090, 0.498, 0.052, 0.052, 0.046, 0.030, 0.42)    // back of the knee
  two(0.196, 0.688, 0.000, 0.030, 0.046, 0.042, 0.32)    // between the fingers
  two(0.092, 0.098, 0.006, 0.046, 0.034, 0.042, 0.26)    // ankle hollow

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
function shadeAt(x: number, y: number, z: number): number {
  let s = 1
  for (const c of CREASE) {
    // Cheap reject first. Thirty-three fields against three thousand vertices
    // against fifty-two pooled bodies is six million tests at load; the y test
    // throws out nine in ten of them before any division.
    if (y < c.y - c.ry || y > c.y + c.ry) continue
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

/** Fresh in the wound, and the darker stain it leaves in cloth. */
const WET_BLOOD = new THREE.Color(0x8c0d10)
const SOAKED = new THREE.Color(0x3a0709)

/** One skinned layer: its mesh, and the buffers needed to repaint it. */
interface Skin {
  mesh: THREE.SkinnedMesh
  region: Uint8Array
  base: Float32Array
  /** Baked occlusion, one multiplier per vertex. See CREASE. */
  shade: Float32Array
  attr: THREE.BufferAttribute
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
  private wounds!: THREE.Mesh
  private woundMat!: THREE.MeshStandardMaterial
  private body = new THREE.Group()

  pendingShot: ShotEvent | null = null
  pendingShout = false
  screamed = false
  /** Set for one frame each time the corpse pumps out another gout of blood. */
  bleedPulse = false
  /** Where the last wound was opened, in world space. */
  readonly woundPos = new THREE.Vector3()

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
    // Never zero. A shirt with no sleeve at all is a torso in a different
    // colour: in a line-up of five, four bodies read as naked because three of
    // them were wearing sleeveless shirts and nothing said otherwise.
    const cuff = dress === 'shirt' ? rng.pick([0.1, 0.13, 0.13, 0.3]) : 0
    const shod = rng.chance(0.55)

    const parts: Part[] = []
    const skin = (bones: string[], g: THREE.BufferGeometry) =>
      parts.push({ g, bones, layer: 'skin', region: Reg.skin, hex: 0 })
    const cloth = (bones: string[], g: THREE.BufferGeometry, region: Reg) =>
      parts.push({ g, bones, layer: 'cloth', region, hex: 0 })
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
    const rings = TORSO.map(([y, rx, rz, cz]) => [y, rx * bulk, rz * bulk, cz] as Ring)
    const split = 9  // y = 1.135, just above the navel
    const trunkLo = sweep(rings.slice(0, split + 1), 12)
    const trunkHi = sweep(rings.slice(split), 12)
    if (shirted) {
      cloth(B_SPINE, trunkLo, Reg.shirt)
      cloth(B_CHEST, trunkHi, Reg.shirt)
    } else {
      skin(B_SPINE, trunkLo)
      skin(B_CHEST, trunkHi)
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
    upper(relief(1.262, 1.382, 0.14, 1.05, 0.011, bulk))
    upper(relief(1.262, 1.382, -1.05, -0.14, 0.011, bulk))

    // Trapezius. It used to be one flat 24 cm pancake laid across the top of the
    // chest, which from the front read as a yoke and closed off the base of the
    // neck — most of the reason the head looked bolted on. It is a *slope*: high
    // beside the neck, falling away to the point of the shoulder, and the
    // falling away is what leaves a neck standing above it.
    for (const s of ['L', 'R'] as const) {
      const sg = s === 'L' ? -1 : 1
      upper(tube(V(sg * 0.020, 1.400, 0.016), V(sg * 0.136, 1.360, 0.004), 0.038, 0.056, 6))
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
    for (const s of ['L', 'R'] as const) {
      const x = (s === 'L' ? -1 : 1) * 0.158
      const g = ell(x, 1.336, -0.004, 0.072, 0.080, 0.066)
      // Bare for a vest: bare shoulders are the whole point of wearing one.
      if (shirted) cloth(B_ARM(s), g, Reg.shirt)
      else skin(B_ARM(s), g)
    }

    /** A rolled edge. An open cylinder rim is a knife edge with backface culling
     * behind it, which is exactly what the waist read as: a bright line with a
     * seam under it and no thickness anywhere. Every hem in here gets one. */
    const roll = (y: number, rx: number, rz: number, cz = 0, radial = 12) =>
      ell(0, y, cz, rx, 0.014, rz, radial, 3)

    if (dress === 'vest') {
      // A sleeveless jerkin rather than the old pair of flat panels, which stood
      // 1.3 cm off a bare chest and read as a bib hung round the neck. Derived
      // from the body profile so it clears the torso by a constant centimetre
      // all the way round, and stopped at 1.345 so it passes under the deltoid
      // instead of through it.
      // The lower half widens its clearance from 1.1 cm to 2.4 cm on the way
      // down so the jerkin finishes outside the waistband (1.3 cm) instead of
      // inside it — tucked into the trousers it stopped being a garment at all
      // and just made the torso two colours.
      // 1.7 cm clear over the chest rather than 1.0: the pectoral relief stands
      // 1.1 cm proud, so at a centimetre it came through the vest as two brown
      // rectangles sitting on the front of it.
      cloth(B_CHEST, sweep(garmentRings(1.190, 1.345, 0.017, 3, bulk, 0.014), 12), Reg.shirt)
      cloth(B_SPINE, sweep(garmentRings(0.965, 1.190, 0.026, 4, bulk, 0.017), 12), Reg.shirt)
      const top = torsoAt(1.345)
      const bot = torsoAt(0.965)
      cloth(B_CHEST, roll(1.345, top[0] * bulk + 0.016, top[1] * bulk + 0.016, top[2]), Reg.shirt)
      cloth(B_SPINE, roll(0.965, bot[0] * bulk + 0.028, bot[1] * bulk + 0.028, bot[2]), Reg.shirt)
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
        cloth(B_ARM(s), strip(f, over, 0.050, 0.012, V(sg * 0.5, 0.15, -0.85)), Reg.shirt)
        cloth(B_ARM(s), strip(over, bk, 0.050, 0.012, V(sg * 0.5, 0.15, 0.85)), Reg.shirt)
      }
    } else if (dress === 'bare') {
      // A shawl over one shoulder and across the chest and back. Asymmetry does
      // more for a crowd than any symmetric garment can — but it has to read as
      // cloth, and the old one was a 5.5 cm tube from shoulder to hip, which is
      // the definition of a bandolier. These are 13 cm across and 1.8 cm thick.
      // Draped 2.6 cm off the body: less and the chord between two points on the
      // ribcage sinks straight through the pectoral between them.
      const s = rng.chance(0.5) ? -1 : 1
      const g = 0.021
      const p = (y: number, a: number) => torsoPoint(y, a * s, g, bulk)
      const shoulder = V(s * 0.126 * bulk, 1.422, -0.040)
      const nape = V(s * 0.122 * bulk, 1.426, 0.044)
      // Over the point of the shoulder, bound to the arm like the deltoid is:
      // on the chest set it tore open the first time a hunter shouldered a rifle.
      const arm = B_ARM(s < 0 ? 'L' : 'R')
      cloth(arm, strip(shoulder, nape, 0.098, 0.013, V(s * 0.3, 0.95, 0), 0.012), Reg.shirt)
      // Down the chest, then across to the opposite hip. Four short sections
      // rather than two long ones: a strip is straight, and a straight line
      // between two points on a ribcage passes through everything in between.
      const c = [shoulder, p(1.345, 0.80), p(1.250, 0.45), p(1.150, 0.10), p(1.050, -0.42)]
      const b = [nape, p(1.345, 2.34), p(1.250, 2.69), p(1.150, 3.04), c[4]!]
      const w = [0.108, 0.124, 0.130, 0.126]
      /** Which way the cloth faces: radially out from the body's axis. */
      const out = (u: THREE.Vector3, v: THREE.Vector3) => {
        const my = (u.y + v.y) / 2
        return V(u.x + v.x, 0, u.z + v.z - 2 * torsoAt(my)[2])
      }
      for (let i = 0; i < 4; i++) {
        const set = i < 2 ? B_CHEST : B_SPINE
        cloth(set, strip(c[i]!, c[i + 1]!, w[i]!, 0.014, out(c[i]!, c[i + 1]!), 0.012), Reg.shirt)
        cloth(set, strip(b[i]!, b[i + 1]!, w[i]!, 0.014, out(b[i]!, b[i + 1]!), 0.012), Reg.shirt)
      }
      // The loose end, hanging free off the hip.
      cloth(B_SPINE, strip(c[4]!, V(-s * 0.112 * bulk, 0.870, -0.008), 0.098, 0.013, V(-s * 0.94, 0, -0.34)), Reg.shirt)
    }

    if (shirted) {
      // Collar and hem. Without them a shirt is a differently-coloured torso:
      // the two edges are the only place a garment announces itself as one. The
      // collar stands 1.5 cm clear of the neck; the hem flares away below the
      // waist, with its top ring tucked inside the body so there is no rim.
      cloth(B_NECK, trunk(1.418, 1.478, 0.072, 0.064, 0.88, 10), Reg.shirt)
      // The hem has to be outside the waistband over the whole height the two
      // share, not just at the bottom. A cone that only overtook the waistband
      // at 1.00 left the trousers showing from 1.05 down to 1.00 and the shirt
      // reappearing below: a shirt, then a five-centimetre dark band, then a red
      // band. Everyone read it as a belt.
      //
      // Two segments, because one straight ramp cannot do it: tucked inside the
      // body at 1.10, out past the waistband's 1.3 cm clearance by 1.05 (which
      // is the very top of both the trouser waistband and the dhoti tie), then
      // flaring on out to 3.4 cm at 0.895. Nothing under it ever surfaces.
      const hemK: readonly (readonly [number, number])[] = [[0.895, 0.034], [1.05, 0.018], [1.10, -0.006]]
      const hem: Ring[] = []
      for (let i = 0; i <= 7; i++) {
        const y = 0.895 + (1.10 - 0.895) * (i / 7)
        const j = y <= hemK[1]![0] ? 0 : 1
        const a = hemK[j]!
        const b = hemK[j + 1]!
        const g = a[1] + (b[1] - a[1]) * ((y - a[0]) / (b[0] - a[0]))
        const p = torsoAt(y)
        hem.push([y, p[0] * bulk + g, p[1] * bulk + g, p[2]])
      }
      cloth(B_SPINE, sweep(hem, 12), Reg.shirt)
      // The roll is 2 mm fatter than the ring it caps. Matched exactly, the two
      // 12-gons alternate which one is outside and the hem comes out scalloped.
      const h0 = torsoAt(0.895)
      cloth(B_SPINE, roll(0.895, h0[0] * bulk + 0.036, h0[1] * bulk + 0.036, h0[2]), Reg.shirt)
    }

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
      skin(bones, tube(sh, el, r(0.058), r(0.045)))
      skin(bones, ell(sg * 0.17, 1.215, -0.016, r(0.038), 0.078, r(0.034)))   // biceps
      skin(bones, ell(sg * 0.182, 1.053, 0.004, r(0.045), 0.046, r(0.045)))   // elbow
      skin(bones, tube(el, wr, r(0.047), 0.029))
      skin(bones, ell(sg * 0.186, 0.982, -0.004, r(0.042), 0.058, r(0.04)))   // forearm belly
      skin(bones, ell(sg * 0.198, 0.757, -0.004, 0.034, 0.04, 0.024))         // palm
      skin(bones, ell(sg * 0.198, 0.722, -0.002, 0.032, 0.014, 0.032, 6, 4))  // knuckles
      // Fingers spread front-to-back and curl medially: a relaxed hand, not a
      // flat paddle. Index longest, little shortest.
      const digit = [[-0.021, 0.658], [-0.001, 0.652], [0.019, 0.658], [0.037, 0.672]] as const
      for (const [dz, tipY] of digit) {
        skin(bones, tube(
          V(sg * 0.198, 0.719, dz),
          V(sg * 0.182, tipY, dz - 0.012),
          0.011, 0.006, 5,
        ))
      }
      skin(bones, tube(V(sg * 0.184, 0.766, -0.018), V(sg * 0.166, 0.712, -0.042), 0.016, 0.009, 5))  // thumb
      if (cuff > 0) {
        const end = new THREE.Vector3().lerpVectors(sh, wr, cuff / 0.59)
        // Narrow at the top, wide at the hem — the opposite of what it was. At
        // 0.078 the sleeve's top rim stood 2.6 cm outside the deltoid under it
        // and the two together made a bulb on each shoulder. At 0.056 the rim is
        // inside the deltoid (0.058 at that height) and never surfaces, and the
        // flare to the hem is what makes it read as cloth hanging off an arm
        // rather than as a second skin.
        cloth(bones, tube(sh, end, r(0.056), r(cuff > 0.2 ? 0.052 : 0.066)), Reg.shirt)
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
      skin(bones, tube(hip, knee, r(0.088), r(0.066)))
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
      skin(bones, ell(sg * 0.092, 0.36, 0.026, r(0.05), 0.085, r(0.044)))    // calf
      // Foot. The malleoli belong to the shin, the heel and arch to the foot, the
      // pad to the toes — bound one bone each. Distance weighting split the heel
      // fifty-fifty with the shin, so it only lifted half as far as the ankle
      // rolled and the push-off never left the ground.
      skin([`shin${s}`], ell(sg * 0.092, 0.088, 0.004, 0.038, 0.036, 0.04))
      skin([`foot${s}`], ell(sg * 0.092, 0.05, 0.043, 0.038, 0.05, 0.04))
      skin([`foot${s}`], tube(V(sg * 0.092, 0.05, 0.02), V(sg * 0.092, 0.032, -0.11), 0.048, 0.04, 6))
      skin([`toe${s}`], ell(sg * 0.092, 0.026, -0.148, 0.042, 0.024, 0.038))
      if (shod) {
        fixed(B_FOOT(s), slab(0.1, 0.022, 0.245, sg * 0.092, 0.014, -0.052), LEATHER, 'cloth')
        fixed([`foot${s}`], ell(sg * 0.092, 0.048, -0.012, 0.05, 0.046, 0.088, 8, 5), LEATHER, 'cloth')
      }

      if (lower === 'trouser') {
        cloth(bones, tube(hip, knee, r(0.104), r(0.08)), Reg.trouser)
        cloth(bones, tube(knee, V(sg * 0.092, 0.155, 0), r(0.078), 0.056), Reg.trouser)
      } else if (bare && lower === 'shorts') {
        cloth(bones, tube(hip, V(sg * 0.088, 0.63, 0), r(0.11), r(0.098)), Reg.trouser)
      }
    }

    // The waist was a hard seam: a cylinder butted against the torso with its
    // open rim showing as a thin bright line and no overlap either side of it.
    // Both garments now run 3 cm higher, tuck their top ring inside the body,
    // and finish on a rolled edge so the join has thickness.
    if (lower === 'dhoti') {
      // A wrapped skirt to the knee. Bound to the pelvis alone, which is what a
      // real dhoti does — it swings with the hips, not with each thigh.
      cloth(['hips'], trunk(0.56, 0.955, 0.235, r(0.158), 0.78, 14), Reg.trouser)
      cloth(['hips'], ell(0, 0.59, 0, 0.235, 0.05, 0.184, 14, 4), Reg.trouser)
      // The tie: a separate band, wide enough to swallow the top of the skirt.
      cloth(B_SPINE, trunk(0.94, 1.052, r(0.166), r(0.134), 0.78, 12), Reg.trouser)
      cloth(B_SPINE, roll(0.942, r(0.168), r(0.131)), Reg.trouser)
    } else {
      // Swept from the body profile rather than coned, so it takes the flare of
      // the hips, and carried down to 0.80 rather than 0.86. Both the trouser
      // and the shorts leg tubes start at the hip joint and are cut square
      // across, so between 0.795 and 0.86 the front of the crotch was outside
      // both of them and outside the waistband: a 6 cm wedge of bare skin under
      // the belt of every trousered villager and every hunter in the game.
      cloth(B_SPINE, sweep(garmentRings(0.80, 1.050, 0.013, 6, bulk), 12), Reg.trouser)
      const w = torsoAt(1.050)
      cloth(B_SPINE, roll(1.050, w[0] * bulk + 0.015, w[1] * bulk + 0.015, w[2]), Reg.trouser)
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
    skin(B_HEAD, ell(-0.05, 1.578, -0.040, 0.032, 0.028, 0.028))        // cheekbones
    skin(B_HEAD, ell(0.05, 1.578, -0.040, 0.032, 0.028, 0.028))
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
      // The beard was one 14 cm ball centred on the mouth. Its front surface
      // stood a millimetre proud of the lips, so it covered them completely, and
      // on the grey-haired quarter of the crowd it read — unmistakably — as a
      // surgical mask. It has to be a single mass hugging the jaw and stopping
      // 1.4 cm short of the lips — the first rebuild used four small pieces on
      // the chin and either side of the mouth, which at this vertex density are
      // four separate smooth balls and read as cotton wool glued on.
      fixed(B_HEAD, ell(0, 1.5175, -0.030, 0.059, 0.040, 0.063, 10, 6), hairCol)  // chin and jaw
      fixed(B_HEAD, ell(0, 1.4965, -0.014, 0.050, 0.028, 0.056, 8, 5), hairCol)   // under the jaw
      // Sits on the top edge of the upper lip, 4 mm proud of the philtrum.
      if (rng.chance(0.6)) fixed(B_HEAD, ell(0, 1.5495, -0.084, 0.023, 0.008, 0.013, 8, 4), hairCol)
    }

    // ---- assemble. One skinned mesh per layer: skin has no cloth weave and a
    // lower roughness, which is most of why the two have to stay apart.
    const tex = textures()
    this.skinMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86 })
    this.clothMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: tex.cloth, roughness: 1 })
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
      let o = 0
      for (const p of mine) {
        const n = p.g.attributes.position!.count
        weigh(p.g, p.bones)
        // Every part needs the same attribute set or the merge drops one.
        p.g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3))
        if (p.region === Reg.fixed) col.setHex(p.hex)
        const pv = p.g.attributes.position!.array as ArrayLike<number>
        for (let i = 0; i < n; i++) {
          region[o + i] = p.region
          // Baked in the bind pose, which is the only pose that exists at build
          // time and close enough to every pose the gait ever reaches.
          shade[o + i] = shadeAt(pv[i * 3]!, pv[i * 3 + 1]!, pv[i * 3 + 2]!)
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
      this.layers.push({ mesh, region, base, shade, attr: geo.attributes.color as THREE.BufferAttribute })
    }
    this.body.add(root)

    // ---- wounds. Flattened blobs a hair proud of the torso, hidden until
    // something opens them up. Hung off the chest bone, so the geometry is
    // pre-shifted into that bone's local space.
    this.woundMat = new THREE.MeshStandardMaterial({ color: 0x4a0509, roughness: 0.35 })
    const wound = mergeGeometries([
      ell(-0.086, 1.27, -0.112, 0.095, 0.075, 0.035),  // across the ribs
      ell(0.13, 1.35, -0.088, 0.06, 0.08, 0.03),       // right shoulder
      ell(-0.155, 1.15, 0.02, 0.03, 0.09, 0.06),       // left flank
      ell(0.04, 1.21, 0.122, 0.09, 0.08, 0.03),        // back
      ell(-0.045, 1.46, -0.052, 0.05, 0.04, 0.04),     // throat
    ], false)!
    wound.translate(0, -1.245, 0)
    this.wounds = new THREE.Mesh(wound, this.woundMat)
    this.wounds.visible = false
    this.wounds.castShadow = false
    this.chest.add(this.wounds)

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
        if (reg === Reg.fixed) {
          a[i * 3] = l.base[i * 3]! * s
          a[i * 3 + 1] = l.base[i * 3 + 1]! * s
          a[i * 3 + 2] = l.base[i * 3 + 2]! * s
        } else {
          const c = pal[reg]!
          a[i * 3] = c.r * s
          a[i * 3 + 1] = c.g * s
          a[i * 3 + 2] = c.b * s
        }
      }
      l.attr.needsUpdate = true
    }
  }

  /** Everything back to the bind pose. */
  private resetPose() {
    for (let i = 0; i < this.bones.length; i++) {
      this.bones[i]!.position.copy(this.rest[i]!)
      this.bones[i]!.rotation.set(0, 0, 0)
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
    this.paint()
    this.skinMat.emissive.setHex(0x000000)
    this.clothMat.emissive.setHex(0x000000)
    this.wounds.visible = false
    this.woundMat.color.setHex(0x4a0509)
    this.wounds.scale.setScalar(1)

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
  hurt(amount: number, from: THREE.Vector3): boolean {
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
    const c = Math.cos(-this.yaw)
    const s = Math.sin(-this.yaw)
    this.fallX = wx * c - wz * s
    this.fallZ = wx * s + wz * c
    // Whipped away from the impact hard enough to see, then damped out.
    this.leanX = clamp(this.leanX + this.fallZ * 0.85, -1, 1)
    this.leanZ = clamp(this.leanZ - this.fallX * 0.85, -1, 1)

    // Knocked back, harder the bigger the hit.
    const shove = 3.4 + Math.min(amount, 140) * 0.03
    this.vel.x += wx * shove
    this.vel.z += wz * shove

    // Torn open, and it stays torn: the wound layer surfaces on first blood and
    // spreads as they bleed out, so a half-dead villager looks half-dead.
    this.showWounds()

    if (this.health <= 0) {
      this.die()
      return true
    }
    if (this.kind === 'villager') this.state = 'flee'
    return false
  }

  /**
   * Reveal and grow the wound layer, and soak the clothing. Everything is
   * driven off the health fraction so it is monotonic — the damage only ever
   * gets worse, which is what makes it read as accumulated rather than flashing.
   */
  private showWounds() {
    const gone = clamp(1 - this.health / this.maxHealth, 0, 1)
    this.wounds.visible = true
    // Starts as a couple of gashes, ends as most of the torso.
    this.wounds.scale.setScalar(0.45 + gone * 0.75)
    this.woundMat.color.setHex(0x4a0509).lerp(WET_BLOOD, gone * 0.6)
    // Blood wicks through the cloth from the wound outward.
    this.cShirt.lerp(SOAKED, gone * 0.35)
    this.cSkin.lerp(SOAKED, gone * 0.18)
    this.paint()
    this.woundPos.set(this.pos.x, this.pos.y + 1.3, this.pos.z)
  }

  private die() {
    this.alive = false
    this.state = 'dead'
    this.deathTimer = 0
    this.vel.set(0, 0, 0)
    this.health = 0
    this.showWounds()
    // Keep pumping for a couple of seconds. The game turns each pulse into a
    // spray, which is what an opened throat looks like and one burst does not.
    this.bleedTimer = HUMAN.bleedDuration
    this.bleedNext = 0
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
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 3)
    const flash = this.hurtFlash * 0.7
    this.clothMat.emissive.setRGB(flash, 0, 0)
    this.skinMat.emissive.setRGB(flash * 0.6, 0, 0)
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

    if (this.fearTimer > 0) this.state = 'panic'
    else if (this.alerted) this.state = this.kind === 'hunter' ? 'hunt' : 'flee'
    else if (this.awareness > 0.35) this.state = 'suspicious'
    else if (this.state !== 'wander') this.state = 'wander'

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

    // Topple away from whatever hit them, over the first half-second, with a
    // bounce at the bottom rather than settling dead flat — a body dropping on
    // its face and a body flung onto its back are different deaths, and always
    // playing the first one was most of why kills felt weightless.
    const fall = clamp(this.deathTimer / 0.55, 0, 1)
    const eased = fall * fall * (3 - 2 * fall)
    const settle = fall >= 1 ? 0 : Math.sin(fall * TAU) * 0.09 * (1 - fall)
    const tip = (Math.PI / 2) * 0.96 * (eased + settle)
    this.body.rotation.x = -this.fallZ * tip
    this.body.rotation.z = this.fallX * tip
    this.body.position.y = -eased * 0.12

    // Go slack. A corpse is not a mannequin laid down: the spine curls, the
    // knees stay half bent under it, an arm ends up across the chest and the
    // head lolls off the neck. Damped toward the target, so it drops into the
    // shape over the same half-second the body takes to fall.
    const l = 6
    this.spine.rotation.x = damp(this.spine.rotation.x, 0.22, l, dt)
    this.chest.rotation.x = damp(this.chest.rotation.x, 0.14, l, dt)
    this.chest.rotation.y = damp(this.chest.rotation.y, this.fallX * 0.2, l, dt)
    this.neck.rotation.x = damp(this.neck.rotation.x, -0.3, l, dt)
    this.head.rotation.z = damp(this.head.rotation.z, this.fallX * 0.6, 4, dt)
    this.head.rotation.y = damp(this.head.rotation.y, -this.fallX * 0.4, 4, dt)
    this.hips.rotation.set(0, 0, 0)

    const slack: [Leg, number, number][] = [
      [this.legs[0]!, 0.3, 0.18],
      [this.legs[1]!, -0.12, -0.3],
    ]
    for (const [leg, hip, splay] of slack) {
      leg.thigh.rotation.x = damp(leg.thigh.rotation.x, hip, l, dt)
      leg.thigh.rotation.z = damp(leg.thigh.rotation.z, splay, 5, dt)
      leg.shin.rotation.x = damp(leg.shin.rotation.x, -0.55 - Math.abs(hip), l, dt)
      leg.foot.rotation.x = damp(leg.foot.rotation.x, -0.35, l, dt)
      leg.toe.rotation.x = damp(leg.toe.rotation.x, 0, l, dt)
    }
    const arms: [Limb, number, number, number][] = [
      [this.arms[0]!, 0.45, 0.85, 0.6],
      [this.arms[1]!, 0.9, -1.05, 1.1],
    ]
    for (const [arm, x, z, fore] of arms) {
      arm.upper.rotation.x = damp(arm.upper.rotation.x, x, 5, dt)
      arm.upper.rotation.z = damp(arm.upper.rotation.z, z, 5, dt)
      arm.fore.rotation.x = damp(arm.fore.rotation.x, fore, 5, dt)
    }

    // Lie *on* the ground, not standing upright through a slope. Two height
    // samples give the gradient; the corpse pitches and rolls onto it.
    const gx = terrainHeight(this.pos.x + 0.6, this.pos.z) - terrainHeight(this.pos.x - 0.6, this.pos.z)
    const gz = terrainHeight(this.pos.x, this.pos.z + 0.6) - terrainHeight(this.pos.x, this.pos.z - 0.6)
    this.group.rotation.set(clamp(gz / 1.2, -0.5, 0.5) * eased, this.yaw, -clamp(gx / 1.2, -0.5, 0.5) * eased, 'YXZ')

    if (this.deathTimer > HUMAN.corpseLife) {
      const sink = (this.deathTimer - HUMAN.corpseLife) / 2
      this.group.position.y = this.pos.y - sink * 2.2
      if (sink >= 1) this.group.visible = false
    } else {
      this.group.position.copy(this.pos)
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
