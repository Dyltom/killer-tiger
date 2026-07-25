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

// Darker than they look on a swatch. The sun is 3.3 intensity and the grade
// adds contrast on top, so anything above about 0xc08150 clips to featureless
// white the moment a villager steps out of shade.
const SKIN = [0x6d4527, 0x7d5433, 0x4f301d, 0x86593a, 0x412818]
const SHIRT = [0x59653f, 0x71462c, 0x3d4a58, 0x655840, 0x7d684a, 0x4a3b2e]
const HUNTER_SHIRT = [0x333d2a, 0x3d3325, 0x2b333c]
const TROUSER = [0x3d3527, 0x4a4030, 0x2e2a22, 0x554c3c, 0x6a6152, 0x484030]
const HAIR = [0x241a13, 0x1b1410, 0x3a2a1c]
const GREY = [0x6e665c, 0x857d72]
const TURBAN = [0xb0a48b, 0xa5522c, 0xbdb39c, 0x5f7488, 0xa8873c, 0x93362d]

/** Leather, felt and brass on the hunters' kit. */
const LEATHER = 0x513520
const FELT = 0x3f342a
const BRASS = 0xa9853f
/** Eyes, mouth and nostrils. Not black — black reads as a hole at any distance. */
const DARK = 0x140d09

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
    const dress = rng.pick(['shirt', 'shirt', 'shirt', 'vest', 'bare'] as const)
    const lower = rng.pick(['trouser', 'trouser', 'dhoti', 'dhoti', 'shorts'] as const)
    const cuff = dress === 'shirt' ? rng.pick([0, 0.13, 0.13, 0.3]) : 0
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
    const bodyPart = (g: THREE.BufferGeometry) =>
      shirted ? cloth(B_SPINE, g, Reg.shirt) : skin(B_SPINE, g)
    const r = (v: number) => v * bulk
    bodyPart(ell(0, 0.95, 0, r(0.15), 0.135, r(0.112)))             // pelvis
    bodyPart(ell(0, 0.9, 0.055, r(0.142), 0.115, r(0.1)))           // buttocks
    bodyPart(trunk(0.97, 1.13, r(0.148), r(0.136), 0.74))           // waist
    parts.push({ g: trunk(1.13, 1.28, r(0.136), r(0.16), 0.7), bones: B_CHEST, layer: shirted ? 'cloth' : 'skin', region: shirted ? Reg.shirt : Reg.skin, hex: 0 })
    const upper = (g: THREE.BufferGeometry) =>
      shirted ? cloth(B_CHEST, g, Reg.shirt) : skin(B_CHEST, g)
    // Chest breadth 0.31, not 0.36. At 0.36 the arms hung five centimetres inside
    // the ribcage and the torso poked out through them the moment they abducted.
    upper(ell(0, 1.275, 0, r(0.156), 0.105, r(0.112)))              // ribcage
    upper(ell(-0.068, 1.285, -0.07, 0.06, 0.05, 0.042))             // pectorals
    upper(ell(0.068, 1.285, -0.07, 0.06, 0.05, 0.042))
    upper(ell(0, 1.388, 0.012, 0.12, 0.048, 0.07))                  // trapezius

    // Neck always skin — a collar covers the base of it, not the whole thing.
    // Cut in at the front so the throat sits behind the jaw rather than under it.
    skin(B_NECK, tube(V(0, 1.36, 0.008), V(0, 1.5, 0.014), 0.058, 0.048))

    // Deltoids sit on the clavicle/upper-arm pair so they follow the shoulder:
    // the cap stays with the (unrotating) clavicle and the belly goes with the
    // arm, which is why the arm can raise without the shoulder opening a seam.
    for (const s of ['L', 'R'] as const) {
      const x = (s === 'L' ? -1 : 1) * 0.155
      const g = ell(x, 1.368, 0, 0.075, 0.078, 0.072)
      if (shirted || dress === 'vest') cloth(B_ARM(s), g, Reg.shirt)
      else skin(B_ARM(s), g)
    }

    if (dress === 'vest') {
      // Front and back panels only, so the shoulders and arms stay bare — the
      // silhouette a shirt doesn't give you.
      cloth(B_CHEST, ell(0, 1.19, -0.086, 0.125, 0.135, 0.035), Reg.shirt)
      cloth(B_SPINE, ell(0, 1.18, 0.085, 0.135, 0.15, 0.032), Reg.shirt)
      cloth(B_CHEST, tube(V(-0.085, 1.4, 0), V(-0.072, 1.26, -0.07), 0.032, 0.03), Reg.shirt)
      cloth(B_CHEST, tube(V(0.085, 1.4, 0), V(0.072, 1.26, -0.07), 0.032, 0.03), Reg.shirt)
    } else if (dress === 'bare') {
      // A shawl over one shoulder and across the chest. Asymmetry does more for
      // a crowd than any symmetric garment can.
      const s = rng.chance(0.5) ? -1 : 1
      cloth(B_CHEST, tube(V(s * 0.132, 1.405, 0.02), V(-s * 0.125, 1.06, -0.06), 0.055, 0.07, 6), Reg.shirt)
      cloth(B_SPINE, tube(V(s * 0.125, 1.39, 0.05), V(-s * 0.1, 1.05, 0.07), 0.05, 0.06, 6), Reg.shirt)
    } else if (cuff === 0) {
      // Sleeveless shirts get a collar so the neckline still reads.
      cloth(B_CHEST, trunk(1.36, 1.43, 0.085, 0.1, 0.8, 10), Reg.shirt)
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
        cloth(bones, tube(sh, end, r(0.078), r(cuff > 0.2 ? 0.053 : 0.068)), Reg.shirt)
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
      skin([`thigh${s}`], ell(sg * 0.088, 0.482, -0.05, 0.03, 0.038, 0.022))
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

    if (lower === 'dhoti') {
      // A wrapped skirt to the knee. Bound to the pelvis alone, which is what a
      // real dhoti does — it swings with the hips, not with each thigh.
      cloth(['hips'], trunk(0.56, 1.015, 0.23, 0.166, 1, 14), Reg.trouser)
      cloth(['hips'], ell(0, 0.59, 0, 0.23, 0.05, 0.23, 14, 4), Reg.trouser)
    } else {
      cloth(B_SPINE, trunk(0.86, 1.015, 0.162, 0.156, 0.78, 12), Reg.trouser)
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
    skin(B_HEAD, ell(-0.05, 1.578, -0.052, 0.03, 0.032, 0.03))          // cheekbones
    skin(B_HEAD, ell(0.05, 1.578, -0.052, 0.03, 0.032, 0.03))
    skin(B_HEAD, ell(0, 1.545, -0.022, 0.058, 0.05, 0.072))             // jaw
    skin(B_HEAD, ell(0, 1.517, -0.056, 0.03, 0.03, 0.03))               // chin
    skin(B_HEAD, ell(0, 1.588, -0.08, 0.015, 0.028, 0.026))             // nose bridge
    skin(B_HEAD, ell(0, 1.566, -0.09, 0.018, 0.014, 0.018))             // tip
    skin(B_HEAD, ell(-0.078, 1.59, 0.012, 0.011, 0.026, 0.02))          // ears
    skin(B_HEAD, ell(0.078, 1.59, 0.012, 0.011, 0.026, 0.02))
    fixed(B_HEAD, ell(-0.031, 1.601, -0.078, 0.013, 0.012, 0.008), DARK)  // eyes
    fixed(B_HEAD, ell(0.031, 1.601, -0.078, 0.013, 0.012, 0.008), DARK)
    fixed(B_HEAD, ell(0, 1.542, -0.073, 0.02, 0.006, 0.008), DARK)      // mouth

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
      // Centred behind and below the nose, so it never reaches the nose tip at
      // z -0.11 and the face stays a face.
      fixed(B_HEAD, ell(0, 1.535, -0.028, 0.068, 0.055, 0.072), hairCol)
      if (rng.chance(0.6)) fixed(B_HEAD, ell(0, 1.56, -0.069, 0.027, 0.012, 0.016), hairCol)  // moustache
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
      const col = new THREE.Color()
      let o = 0
      for (const p of mine) {
        const n = p.g.attributes.position!.count
        weigh(p.g, p.bones)
        // Every part needs the same attribute set or the merge drops one.
        p.g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3))
        if (p.region === Reg.fixed) col.setHex(p.hex)
        for (let i = 0; i < n; i++) {
          region[o + i] = p.region
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
      this.layers.push({ mesh, region, base, attr: geo.attributes.color as THREE.BufferAttribute })
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
        if (reg === Reg.fixed) {
          a[i * 3] = l.base[i * 3]!
          a[i * 3 + 1] = l.base[i * 3 + 1]!
          a[i * 3 + 2] = l.base[i * 3 + 2]!
        } else {
          const c = pal[reg]!
          a[i * 3] = c.r
          a[i * 3 + 1] = c.g
          a[i * 3 + 2] = c.b
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
