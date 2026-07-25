/**
 * The player: a first-person tiger.
 *
 * Owns movement + camera, and the viewmodel (two clawed forepaws that swipe
 * across the screen). Combat resolution lives in game.ts — this class only
 * reports "I swung, here is the moment and the arc".
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { CAMERA, TIGER } from '../config'
import { clamp, damp } from '../engine/rng'
import { terrainHeight, World } from '../world/world'
import type { Input } from '../engine/input'

export type AttackKind = 'claw' | 'bite'

export interface AttackEvent {
  kind: AttackKind
  origin: THREE.Vector3
  dir: THREE.Vector3
  range: number
  arc: number
  damage: number
}

type PawState = 'idle' | 'swipeL' | 'swipeR' | 'bite'

/**
 * The forepaws, in viewmodel space.
 *
 * Viewmodel space hangs off the camera but is counter-rotated back to level (see
 * `pitchFollow`), so its y really is world up and its origin is the eye. That is
 * what lets the paws be placed against the ground instead of against the frame.
 *
 * `z` is the number everything else follows from, and it has been wrong in both
 * directions.
 *
 * The temptation is to push the feet out in front. The vertical FOV is fixed, so
 * at distance d the frame reaches only d*tan(fov/2) below the eye line — 0.81d
 * at CAMERA.fov — and the ground is TIGER.eyeHeight down, so at pitch 0 no dirt
 * is in shot until 1.10 / 0.81 = 1.36 m out. Put the paws at 1.74 m and they
 * land four fifths of the way down a level frame, apparently solving it.
 *
 * It solves nothing, because the shoulder does not move with them. At 1.74 m the
 * wrist is 1.86 m in front of a shoulder joint that is one metre away from it,
 * so the "leg" is a two-metre boom pointing almost straight away from the lens.
 * Foreshortened down that axis a forearm is a 40-pixel stub and a forepaw is a
 * dot: what the player actually saw was two tapering pipes rising out of the
 * bottom corners to a bend in mid-frame and then nothing at all. The paws were
 * not hidden by the grass. They were edge-on.
 *
 * So this is the animal's own measurement — 0.66 m ahead of the eye, which with
 * the ground a metre down puts a planted foot 60 degrees below the horizon. The
 * consequence is honest and worth stating: at pitch 0 you cannot see your feet.
 * They come into the bottom of the frame at about 18 degrees of look-down and
 * are centred by 50, which is exactly the deal a human FPS makes about boots.
 * What is gained is that the paw is now 1.2 m from the eye instead of 2.0, so it
 * covers three times the screen area, and the limb behind it is a limb — a short
 * humerus and a forearm crossing the frame broadside, where an elbow bending is
 * something the player can see.
 */
const PAW = {
  /**
   * Half the spread between the two forefeet. Close to the animal's own 40 cm
   * now: at 0.66 m the feet subtend a far wider angle than they did at 1.74, so
   * the old 0.58 would have thrown them into the frame's corners.
   */
  x: 0.30,
  /** Mid-stance: how far ahead of the eye the foot is halfway through contact. */
  z: -0.66,
  /**
   * Half the stride. The foot runs from z - stride (plant) to z + stride (lift),
   * scaled by the gait amplitude.
   *
   * This is a reach limit, not a taste: at 0.28 the wrist at full protraction is
   * 1.26 m from the shoulder, which the forearm covers by stretching about a fifth
   * past its nominal 0.72 m. Beyond that the limb visibly telescopes.
   *
   * It used to be 0.24 with a gait amplitude that saturated at 1.5, so the sweep
   * was already 0.36 — past this limit, not under it. The amplitude tops out at 1
   * now (see updateGait) and the honest number lives here instead.
   *
   * Everything about the cadence follows from it. The clock is advanced by ground
   * covered over the animal's real stride length, so a sweep of 2 * stride against
   * a two-metre stride is what fixes the duty factor. See DUTY_MIN.
   */
  stride: 0.28,
  /** Peak of the swing above the ground. */
  lift: 0.20,
  /**
   * Height of the paw group's origin — the wrist joint — above the ground when
   * the foot is planted. Measured off the geometry: the toe pads bottom out
   * 0.104 m below the wrist, so this is that plus a millimetre so the pads press
   * into the dirt rather than hovering a hair above it.
   */
  sole: 0.105,
  /** Rest pose of a planted foot: nearly flat, toes barely down. */
  pitch: 0.12,
  yaw: 0.20,
  roll: 0.10,
  /**
   * A tiger does not stand with its feet in mirror image. Nudging the right foot
   * forward and the left one out breaks the symmetry that made the two paws read
   * as one prop reflected down the middle of the screen — which is a thing the
   * eye picks up on instantly and reads as "model", not "animal".
   */
  stagger: 0.045,
  /**
   * How far the claws stand out of their sheaths at rest, 0..1.
   *
   * Not zero. A walking cat's claws are retracted, but a *hunting* one carries
   * them half out, and the claws are the one part of the viewmodel that says what
   * the player is — so the tips stay showing over the toe fur even at rest and
   * only come the whole way out to strike. See setClaws().
   */
  clawIdle: 0.34,
  /** Scale of the paw group. Life size — the geometry below is already in metres. */
  scale: 1.0,
  /**
   * How much of the camera's pitch the viewmodel takes back out. This has to be
   * exactly 1.
   *
   * At 1 the forelegs are pinned level with the world, so a paw placed at ground
   * height stays at ground height no matter where the head is pointing. Any less
   * and the leftover rotation swings the feet vertically by the arm's own length:
   * at 0.85 and 0.66 m out, looking down 55 degrees buries the pads a tenth of a
   * metre in the dirt, which is precisely where you look to check your feet.
   *
   * The reason to want less than 1 was that looking up loses the paws off the
   * bottom of the frame — but that is not a bug, it is what happens when an
   * animal lifts its head. Its feet do not come up with it.
   */
  pitchFollow: 1,
}

/**
 * Where the foreleg is joined to the animal, in viewmodel space: the head of the
 * humerus, 0.80 m off the ground on an animal whose eye is at 1.10, and a
 * handspan in front of the eye because a tiger's skull hangs out over its chest.
 *
 * Both numbers are the animal's. The old ones put it 0.70 m below the eye and
 * 0.54 m out to the side, which is not a shoulder — it is the outside of a
 * ribcage the tiger does not have, and it is half of why the limb read as a boom
 * (see PAW.z for the other half).
 *
 * It is also 0.09 m from the camera plane when the player looks down 30 degrees,
 * and that is unfixable — the joint is genuinely inside the animal's own chest,
 * and a first-person camera is a hole in that chest. What makes it survivable is
 * that at every pitch the player can reach, the shoulder projects below the
 * bottom of the frame; only the elbow end of the humerus is ever on screen. See
 * the spindle profile in buildViewmodel().
 *
 * Nothing rotates about this any more. The upper arm is aimed at the paw every
 * frame by updateArms(), so the shoulder is a pure attachment point and the
 * animation only ever moves feet. That inverts the old arrangement, where a
 * swipe rotated the shoulder and the paw went wherever the rotation put it —
 * which is why the strike had to be hand-tuned to land near the reticle and why
 * the limb could read as a striped sausage crossing the frame. Now the foot goes
 * exactly where it is wanted and the leg follows it, so no pose can leave the
 * paw disconnected from the body.
 */
const SHOULDER = { x: 0.20, y: -0.30, z: 0.06 }

/**
 * Duty factor: the fraction of a stride a forefoot spends on the ground. Solved
 * every frame from the two lengths that matter rather than fixed, and that is the
 * whole of why the paws no longer skate.
 *
 * A planted foot has to travel backward past the animal at exactly the rate the
 * ground is going past it, or it is sliding. Two of the three numbers involved are
 * already spoken for: the sweep is 2 * PAW.stride, which is as far as the limb
 * reaches, and the cadence is the animal's own, which comes from the stride length
 * it covers on the ground. So the duty factor is not free — it is
 * sweep / strideLength, and nothing else will do.
 *
 * At walkSpeed that comes out at 0.28, which is a cantering cat's forelimb duty
 * factor to two figures, and it falls further as the animal opens up. The old code
 * fixed it at 0.62 and the cadence at 1.5 strides a second, which left a planted
 * paw crossing the ground at 1.7 m/s while the world went past at 6.2: measured,
 * 76 mm of skid per frame, three quarters of the tiger's own speed.
 *
 * The floor is set by the swing's overshoot rather than by anatomy — see stride(),
 * where a shorter contact forces the foot to reach further past the plant on its
 * way down, and the limb runs out of arm. The ceiling is a slow walk.
 */
const DUTY_MIN = 0.20
const DUTY_MAX = 0.55

/**
 * Where one forefoot is in its stride: +1 fully forward at the instant it
 * plants, falling linearly to -1 as it sweeps back under the chest at ground
 * speed, then whipping forward again through the swing.
 *
 * The stance half is deliberately linear — a foot in contact with the ground
 * travels backward at a constant rate, and easing it would be the paw sliding.
 *
 * The swing is a cubic Hermite whose tangents at *both* ends match the stance's
 * slope, and that is the whole difference between this and the smoothstep it
 * replaces. A smoothstep arrives at the plant with zero velocity, so every
 * footfall was the paw stopping dead in mid-air and then jerking backward at
 * ground speed the instant it touched down — a corner in the foot's velocity
 * twice per stride, which is exactly what the run read as. Matching the slope
 * means the foot is already travelling backward when it lands.
 *
 * The consequence is that it overshoots past +1 mid-swing and comes back to plant,
 * which is both the reach a running cat has and a hard constraint on `duty`: the
 * tangent is 2(1-duty)/duty, so the shorter the contact the bigger the bulge —
 * 1.29x the sweep at duty 0.28, 1.6x at 0.20. That is what DUTY_MIN is protecting.
 */
function stride(phase: number, duty: number): number {
  const c = phase - Math.floor(phase)
  if (c < duty) return 1 - 2 * (c / duty)
  const s = (c - duty) / (1 - duty)
  const s2 = s * s
  const s3 = s2 * s
  // Hermite with p0 = -1, p1 = +1, m0 = m1 = the stance slope, collected.
  const m = (-2 * (1 - duty)) / duty
  return -4 * s3 + 6 * s2 - 1 + m * (2 * s3 - 3 * s2 + s)
}

/** Ease in and out of a 0..1 ramp. Used for every blend between attack keyframes. */
function smoothstep(x: number): number {
  const c = x < 0 ? 0 : x > 1 ? 1 : x
  return c * c * (3 - 2 * c)
}

/**
 * How far off the ground the paw is through the swing; 0 for the whole stance.
 *
 * A quartic hump rather than a sine one. `sin` has a finite slope at both ends,
 * so the foot's vertical speed jumped the moment it left the ground and again
 * the moment it touched down. This leaves and lands at zero vertical speed.
 */
function lift(phase: number, duty: number): number {
  const c = phase - Math.floor(phase)
  if (c < duty) return 0
  const s = (c - duty) / (1 - duty)
  const u = s * (1 - s)
  return 16 * u * u
}

// ------------------------------------------------------- paw geometry helpers
/**
 * A sphere given as half-extents in metres.
 *
 * Every part of the paw used to be a unit sphere with a mesh scale on it, which
 * is fine until the parts are merged into one buffer — a merge bakes geometry,
 * not the transforms of the meshes that were carrying it. Scaling the geometry
 * means the numbers below are the animal's actual dimensions and can be checked
 * against a photograph.
 */
function ellipsoid(rx: number, ry: number, rz: number, w = 14, h = 10): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, w, h)
  g.scale(rx, ry, rz)
  return g
}

/**
 * Lump a surface up along its own normals.
 *
 * A paw assembled from ellipsoids has a perfectly elliptical outline, and that
 * is the one silhouette no furred animal has anywhere on it. Two octaves of
 * smooth trigonometric noise are enough — from a metre and three quarters away
 * what registers is that the edge is uneven, not what the unevenness is — and
 * it costs nothing at runtime because it is baked in at build time.
 *
 * Normals are recomputed afterwards, so the lumps also catch the light. That is
 * doing as much work as the silhouette: a smooth ellipsoid under a low sun has
 * one broad highlight and reads as polished plastic.
 */
function ruffle(geo: THREE.BufferGeometry, amp: number, seed = 0): THREE.BufferGeometry {
  geo.computeVertexNormals()
  const p = geo.attributes.position as THREE.BufferAttribute
  const n = geo.attributes.normal as THREE.BufferAttribute
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i)
    const y = p.getY(i)
    const z = p.getZ(i)
    // A function of position alone, so the duplicated vertices along a sphere's
    // UV seam are displaced identically and the seam cannot split open. `seed`
    // shifts the field for parts that occupy the same local coordinates as each
    // other — the two forelegs would otherwise carry the identical lumps, and a
    // repeated lump reads as a texture defect rather than as fur.
    const a = Math.sin(x * 47 + seed) * Math.sin(y * 61 + 1.7) * Math.sin(z * 53 + 3.1 + seed)
    const b = Math.sin(x * 113 + 2.2) * Math.sin(y * 131 + 0.4 + seed) * Math.sin(z * 97 + 5.5)
    const d = amp * (a + b * 0.45)
    p.setXYZ(i, x + n.getX(i) * d, y + n.getY(i) * d, z + n.getZ(i) * d)
  }
  geo.computeVertexNormals()
  return geo
}

/**
 * Countershade a part: `top` above `y1`, `under` below `y0`, smoothly between.
 *
 * Every mammal alive is darker on its back than on its belly, and a foot painted
 * one flat colour is the shortest route to a model that reads as moulded rubber.
 * The paw carries its colour in vertex attributes rather than in a texture
 * because the interesting boundaries — the cleft between two toes, the cream
 * that comes up over the toe knuckles, the last two stripes dying out at the
 * wrist — are things this code knows the position of and a UV layout does not.
 */
function shade(geo: THREE.BufferGeometry, top: number, under: number, y0: number, y1: number): THREE.BufferGeometry {
  const cTop = new THREE.Color(top)
  const cUnder = new THREE.Color(under)
  const c = new THREE.Color()
  const p = geo.attributes.position as THREE.BufferAttribute
  const arr = new Float32Array(p.count * 3)
  for (let i = 0; i < p.count; i++) {
    const f = smoothstep((p.getY(i) - y0) / (y1 - y0))
    c.copy(cUnder).lerp(cTop, f)
    arr[i * 3] = c.r
    arr[i * 3 + 1] = c.g
    arr[i * 3 + 2] = c.b
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3))
  return geo
}

/** A part in one flat colour. Same attribute as shade(), so the two can merge. */
function tint(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  return shade(geo, hex, hex, 0, 1)
}

/**
 * A claw: a horn that tapers and hooks, flattened side to side the way a cat's
 * is. Built ring by ring rather than as a cone because a straight cone is a
 * thorn — the hook is the entire difference between a claw and a spike, and it
 * is the part you see when the paw is coming down across the frame.
 */
function clawGeo(len: number, rad: number, bend: number, segs = 8, radial = 6): THREE.BufferGeometry {
  const pos: number[] = []
  const idx: number[] = []
  for (let i = 0; i < segs; i++) {
    const t = i / segs
    const cy = -bend * t * t * len
    const cz = -t * len
    const r = rad * Math.pow(1 - t, 0.6)
    for (let k = 0; k < radial; k++) {
      const a = (k / radial) * Math.PI * 2
      // 0.62 laterally: a claw is a blade, not a cone, and edge-on flattening is
      // what makes it catch a rim of light along its outer curve.
      pos.push(Math.cos(a) * r * 0.62, cy + Math.sin(a) * r, cz)
    }
  }
  const tip = segs * radial
  pos.push(0, -bend * len, -len)
  for (let i = 0; i < segs - 1; i++) {
    for (let k = 0; k < radial; k++) {
      const a = i * radial + k
      const b = i * radial + ((k + 1) % radial)
      idx.push(a, b, a + radial, b, b + radial, a + radial)
    }
  }
  const last = (segs - 1) * radial
  for (let k = 0; k < radial; k++) idx.push(last + k, last + ((k + 1) % radial), tip)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/**
 * One segment of a foreleg: a tapered tube from the origin down to y = -1, so it
 * aims and stretches exactly like the CylinderGeometry it replaces.
 *
 * A cylinder was the wrong primitive for this in three separate ways, and all
 * three showed. It has a dead-straight silhouette, which nothing with hair on it
 * has. It has no muscle, so a foreleg read as plumbing. And it forced the coat to
 * come from a texture, which meant tiling the *body's* stripe canvas around a
 * 12 cm tube — eleven bold black bands sized for a two-metre flank, wrapped at
 * 15 cm intervals down a leg, with the UV seam running up the middle of it.
 *
 * So the markings are vertex colours here, the same as the paw's. A tiger's
 * foreleg is mostly plain tawny with a cream inner face and three or four narrow
 * dark bands; that is a thing this function knows the coordinates of, whereas a
 * texture only knows where its own pixels are.
 *
 * `bands` are positions along the segment, 0 at the top, and `stripeW` is their
 * half-width in the same units — so it has to be scaled per segment, because the
 * humerus is less than half the length of the forearm and a stripe is a fixed
 * number of centimetres on the animal either way. `radiusAt` is given the same
 * 0..1 coordinate, which is what lets the upper arm be a spindle — see the
 * profiles in buildViewmodel().
 *
 * `rings` has to stay well above 1/stripeW or the stripes fall between the rings
 * and come out as a flicker of uneven smudges, which is what two dozen rings and
 * a 2 cm stripe gave.
 */
function limbGeo(
  side: -1 | 1,
  radiusAt: (v: number) => number,
  bands: number[],
  stripeW: number,
  rings = 52,
  radial = 18,
): THREE.BufferGeometry {
  const pos: number[] = []
  const uv: number[] = []
  const col: number[] = []
  const idx: number[] = []
  const top = new THREE.Color(LIMB_TOP)
  const under = new THREE.Color(LIMB_UNDER)
  const band = new THREE.Color(LIMB_BAND)
  const c = new THREE.Color()

  for (let i = 0; i < rings; i++) {
    const v = i / (rings - 1)
    const r = radiusAt(v)
    for (let k = 0; k <= radial; k++) {
      const a = (k / radial) * Math.PI * 2
      const cx = Math.cos(a)
      const cz = Math.sin(a)
      pos.push(cx * r, -v, cz * r)
      uv.push(k / radial, v * 2.4)
      // Countershading, and the azimuth here is not arbitrary. The segment is
      // aimed with setFromUnitVectors(DOWN, dir), and for a limb reaching forward
      // and down that rotation is roughly 70 degrees about +x — which sends local
      // -z to world up. So -cz is the "top of the leg", the face the player is
      // looking at, and it has to be the tawny one. Shading on x instead (the
      // anatomically tidier inner-versus-outer) painted the entire visible surface
      // of both forelegs cream, and two cream tubes is what a bone looks like.
      //
      // The 1.3 is a hard falloff on purpose. At 0.75 the tawny and the cream met
      // in a broad mid-tone that covered most of the tube, so the limb had one
      // colour and read as moulded plastic; a tiger's flank-to-belly transition is
      // abrupt, and the abruptness is most of what says "fur" at this distance.
      const up = smoothstep(0.5 - cz * 1.3 + side * cx * 0.22)
      c.copy(under).lerp(top, up)
      // The stripes. Not rings: each one is offset along the limb by a cosine of
      // the azimuth, so it leans across the tube the way a real marking does, and
      // the widths alternate. A set of clean perpendicular bands is a barber pole,
      // and that is what the first version of this looked like.
      let dark = 0
      for (let j = 0; j < bands.length; j++) {
        const centre = bands[j]! + stripeW * 0.9 * Math.cos(a + j * 1.7)
        const w = stripeW * (j % 3 === 1 ? 1.45 : j % 3 === 2 ? 0.75 : 1)
        dark = Math.max(dark, 1 - smoothstep(Math.abs(v - centre) / w))
      }
      // Squared against the countershading, so a stripe reaches full black across
      // the top of the leg and dies out before it gets to the pale underside —
      // which is where they stop on the animal.
      c.lerp(band, dark * up * up)
      col.push(c.r, c.g, c.b)
    }
  }
  const stride = radial + 1
  for (let i = 0; i < rings - 1; i++) {
    for (let k = 0; k < radial; k++) {
      const a = i * stride + k
      idx.push(a, a + 1, a + stride, a + 1, a + stride + 1, a + stride)
    }
  }
  // Caps. The top one is behind the eye and the bottom one is buried in the next
  // part, but an open tube shows its inside surface the moment the limb swings
  // across the frame and a hole in a leg is the one artefact nobody forgives.
  for (const v of [0, 1] as const) {
    const centre = pos.length / 3
    pos.push(0, -v, 0)
    uv.push(0.5, v * 2.4)
    c.copy(v === 0 ? top : under)
    col.push(c.r, c.g, c.b)
    const ring = v === 0 ? 0 : (rings - 1) * stride
    for (let k = 0; k < radial; k++) {
      const a = ring + k
      if (v === 0) idx.push(centre, a + 1, a)
      else idx.push(centre, a, a + 1)
    }
  }

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  g.setIndex(idx)
  // Enough to break the outline without disturbing the taper. Scaled off the
  // thickest part rather than the top, because the upper arm's top is a spindle
  // point and noise proportional to it would be invisible. Seeded per side so the
  // two legs are not the same lump for lump.
  return ruffle(g, radiusAt(1) * 0.08, side === 1 ? 0 : 2.4)
}

/**
 * The foreleg palette, and these are albedos, not colours anyone picked by eye.
 *
 * The first set was a bright saturated orange over a near-white cream, and the
 * viewmodel came out looking like a plush toy: at daylight exposure the tone
 * mapper lifted the top face to roughly #e8a85f and there was nothing darker than
 * it anywhere on the limb. Real tiger fur in sun is a burnt ochre — dark enough
 * that the sunlit side is what looks bright, rather than the albedo doing it — and
 * the underside is a dirty cream, not paper.
 *
 * The band is near black because it is. Tiger stripes are not brown.
 */
const LIMB_TOP = 0x8e5620
const LIMB_UNDER = 0xac9c80
const LIMB_BAND = 0x120c08

/**
 * Fur grain for the paws: near-white strokes, so it multiplies onto the vertex
 * colours without repainting them.
 *
 * The body's fur canvas cannot be reused down here. It is eleven bold black
 * stripes, and a tiger's foot is not striped — the bands run down the foreleg
 * and stop at the wrist. Tiled to paw scale those stripes landed as two black
 * bars across the toes, which flattened all four of them into one shape and is
 * most of the reason the paws read as a pair of novelty mittens.
 */
function pawGrain(): THREE.CanvasTexture {
  const S = 256
  const cv = document.createElement('canvas')
  cv.width = cv.height = S
  const c = cv.getContext('2d')!
  c.fillStyle = '#f4f2ee'
  c.fillRect(0, 0, S, S)
  // A fixed LCG: the paws must look the same on every reload, or a screenshot
  // taken to judge them is not comparing anything to anything.
  let seed = 0x9e3779b9
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
  c.lineWidth = 1
  for (let i = 0; i < 4200; i++) {
    const x = rnd() * S
    const y = rnd() * S
    // Strokes lie along v, which the sphere UVs run pole to pole — near enough
    // to "along the limb" on every part of the foot for the grain to read as
    // combed rather than as static.
    const len = 5 + rnd() * 11
    const lean = (rnd() - 0.5) * 0.5
    const g = 176 + Math.floor(rnd() * 62)
    c.strokeStyle = `rgba(${g},${g - 6},${g - 14},0.5)`
    c.beginPath()
    c.moveTo(x, y)
    c.lineTo(x + lean * len, y + len)
    c.stroke()
  }
  const t = new THREE.CanvasTexture(cv)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  return t
}

/** Fresh arterial blood, for whatever the claws have been in. */
const BLOOD = new THREE.Color(0x6d0a0c)
/**
 * A clean claw. Horn, not bone: keratin is warm and translucent, so this is a
 * bone-buff with a little sheen rather than the chalk white it was.
 *
 * Named because three places set it — the build, the blood fade and reset() — and
 * they had drifted apart, so wiping the blood off left the claws a different
 * colour from the ones the hunt started with.
 */
const CLAW_CLEAN = 0xd9cbb4
const CLAW_ROUGH = 0.26
const lunge = new THREE.Vector3()
/** Axis a fresh limb segment runs along once its top is put at the origin. */
const DOWN = new THREE.Vector3(0, -1, 0)
/**
 * Length of the humerus, shoulder to elbow. A tiger's is about a third of a metre
 * and it does not change, which is the point: this is a *fixed* bone now rather
 * than a fraction of however far away the foot happens to be. See updateArms().
 */
const UPPER_LEN = 0.31
/**
 * Which way the elbow is pushed off the straight shoulder-to-wrist line.
 *
 * A cat's elbow points backward and tucks in against the ribs, so this is mostly
 * +z (behind, in viewmodel space) with a little outward lean that gets mirrored
 * per side. Without it the two-bone solve is ambiguous and the joint pops to
 * whichever side the arithmetic drifts to; with it the leg always folds the way a
 * leg folds, and the elbow is the part of the limb the player sees most of.
 */
const ELBOW_POLE = { x: 0.10, y: -0.20, z: 0.32 }
const elbowAt = new THREE.Vector3()
const poleAt = new THREE.Vector3()
const wristAt = new THREE.Vector3()
const segDir = new THREE.Vector3()
/** Scratch for one paw's target pose. Two of each, so both feet can be posed. */
const poseP = new THREE.Vector3()
const poseR = new THREE.Vector3()
const poseP2 = new THREE.Vector3()
const poseR2 = new THREE.Vector3()
/** Swipe keyframes, rebuilt each frame because they hang off the ground plane. */
const keyP = new THREE.Vector3()
const keyR = new THREE.Vector3()

export class Tiger {
  /** Start out in the long grass at the treeline, facing the village. */
  readonly pos = new THREE.Vector3(0, 0, 56)
  readonly vel = new THREE.Vector3()
  yaw = 0
  pitch = 0

  health = TIGER.maxHealth
  stamina = TIGER.maxStamina
  rage = 0

  grounded = true
  crouching = false
  sprinting = false
  /** Set while the pounce arc is active — used for lunge kills and fall damage skip. */
  pouncing = false

  frenzy = 0
  speedMult = 1
  damageMult = 1
  damageTakenMult = 1

  private clawCd = 0
  private biteCd = 0
  roarCd = 0
  private sinceDamage = 99
  private sinceSprint = 99
  /**
   * The gait clock, in strides. Wrapped at 2 rather than 1 — that is the period
   * of the half-rate sway terms, so the wrap is invisible in every curve that
   * reads it, and the phase never grows large enough to lose precision.
   *
   * It is never rewound. The old code damped `bobPhase % 2pi` toward zero when
   * you stopped, which walked the legs *backward* through the stride while the
   * tiger slowed down, and jumped whenever the modulo wrapped. Amplitude going
   * to zero is what stops the gait now; the clock just keeps its place.
   */
  private gaitPhase = 0
  /** How much of a full stride the legs are taking, 0..1. Damped, never snapped. */
  private gaitAmp = 0
  /** This frame's duty factor. Resolved in updateGait, read by the pose. See DUTY_MIN. */
  private gaitDuty = DUTY_MAX
  /** Stride offset between the two forefeet: 0.5 alternating, near 0 bounding. */
  private pairPhase = 0.5
  /** 0 on the ground, 1 in the air. Tucks the forelegs into a reach mid-pounce. */
  private airBlend = 0
  /** Seconds off the ground. Gates airBlend, so a lip in the dirt is not a leap. */
  private airTime = 0
  /** Which half-stride last fired a footstep. */
  private lastBeat = -1
  /** The bound, resolved once per frame and read by both the paws and the camera. */
  private bobY = 0
  private bobPitch = 0
  private bobX = 0
  private bobRoll = 0
  /** Height of the eye above the ground under it, bob and all. */
  private eyeAbove = TIGER.eyeHeight
  /**
   * The ground the eye is carried over, and the reference the paws are placed
   * against. Not pos.y: it is the terrain run through the leg spring, so the
   * bilinear height field's corners never reach the view. See TIGER.legSpring.
   */
  private eyeGround = 0
  /** Terrain height under the tiger this frame, and its smoothed self. */
  private groundY = 0
  private groundSmooth = 0
  /** The landing spring: how far the eye is pushed down, and how fast. */
  private dip = 0
  private dipVel = 0
  private camShake = 0
  private shakeTime = 0
  private recoilY = 0
  /** Counts down while a connecting blow holds the swipe still. */
  private hitStop = 0
  /** Kick along the look axis on contact — the arm stopping against a body. */
  private impact = 0
  private clawBlood = 0

  /** Viewmodel. */
  private vm = new THREE.Group()
  private pawL!: THREE.Group
  private pawR!: THREE.Group
  private shoulderL!: THREE.Group
  private shoulderR!: THREE.Group
  private armL!: THREE.Mesh
  private armR!: THREE.Mesh
  private foreL!: THREE.Mesh
  private foreR!: THREE.Mesh
  /** The five hooks on each foot, in build order, for sheathing. See setClaws(). */
  private clawsL: THREE.Group[] = []
  private clawsR: THREE.Group[] = []
  /** How far the claws are out of their sheaths, 0..1, damped per foot. */
  private clawOutL = PAW.clawIdle
  private clawOutR = PAW.clawIdle
  private pawState: PawState = 'idle'
  private pawT = 0
  private nextPawIsLeft = true
  private eyeY = TIGER.eyeHeight
  private clawMat!: THREE.MeshStandardMaterial

  /** Populated during update(); the game reads and clears these. */
  pendingAttack: AttackEvent | null = null
  footstepEvent = false
  landedEvent = false
  /**
   * The frame a swing *starts*, and which way it travels: -1 for the left paw,
   * +1 for the right, 0 for the bite. The whoosh has to lead the impact by the
   * length of the wind-up or the hit reads as arriving late, so this is a
   * separate event from `pendingAttack`, which fires on contact.
   */
  swingEvent = 0
  swingIsBite = false
  pounceEvent = false

  constructor(readonly camera: THREE.PerspectiveCamera, private world: World) {
    this.pos.y = terrainHeight(this.pos.x, this.pos.z)
    this.groundY = this.groundSmooth = this.eyeGround = this.pos.y
    this.buildViewmodel()
    camera.add(this.vm)
  }

  // ---------------------------------------------------------- viewmodel
  /**
   * The forepaw, in metres, measured off a Bengal tiger and then scaled up a
   * quarter — which is what every first-person viewmodel does, because a limb at
   * true size reads as small once it is the only thing in the frame with no
   * other object beside it to give it away.
   *
   * The numbers that matter, and what the old paw got wrong:
   *
   *   - a tiger's forefoot is about 16 cm across and 8 cm deep. The old one was
   *     a sphere scaled to 31 cm across and 22 cm deep — nearly a cube of fur,
   *     which is the single biggest reason it read as a mitten. This is 21 cm
   *     across and 11 cm deep, so it is a foot lying flat on the ground rather
   *     than a ball resting on it;
   *   - the toes were spheres buried *inside* that ball. The dome's front face
   *     reached z = -0.213 and the toes sat at -0.185, so three quarters of every
   *     toe was under the surface it was meant to be a bump on. Here the toes
   *     define the front of the foot and the metacarpus stops short behind them;
   *   - four toes in a straight line across the front is a comb. A cat's are on
   *     an arc, splayed, with the middle pair leading and the outer pair set back
   *     and turned out.
   */
  private static readonly TOES = 4

  private buildViewmodel() {
    // Fur grain for the whole viewmodel — legs and paws both. See pawGrain():
    // near-white, so the vertex colours underneath survive it.
    //
    // The AI tigers' stripe canvas is deliberately *not* used here. It is authored
    // for a two-metre flank, and tiling it round a twelve-centimetre foreleg gave
    // bold black bands every fifteen centimetres with the UV seam running up the
    // middle of the limb. The viewmodel's markings are vertex colours instead —
    // see limbGeo().
    const grain = pawGrain()
    grain.repeat.set(2.2, 1.6)

    const pawMat = new THREE.MeshStandardMaterial({
      map: grain,
      vertexColors: true,
      roughness: 0.93,
      metalness: 0,
      // The grain doubles as a bump map. There is no normal map for the coat, and
      // without this the paw is a set of smooth blobs — the ruffle() lumps carry
      // the silhouette but nothing carries the surface.
      bumpMap: grain,
      bumpScale: 0.5,
    })
    // Kept on the instance so a hit can wet it with blood; the claws are the
    // only part of the viewmodel that carries any record of what you just did.
    // Horn, not bone: a claw is translucent keratin, so it wants a little sheen
    // and a warm core rather than the chalk white it was.
    this.clawMat = new THREE.MeshStandardMaterial({ color: CLAW_CLEAN, roughness: CLAW_ROUGH, metalness: 0.05 })

    // --- the palette. Countershading, and the markings a real foot has.
    //
    // The coat colours are the leg's, not their own. They used to be their own —
    // 0xc4762c over the metacarpus and 0xcf8b45 on the toes — and once the foreleg
    // dropped to a burnt ochre those were half again as bright as everything
    // attached to them, so the foot came out of the tone mapper as a cream mitten
    // with four white marshmallows on the front, joined to a striped tawny leg. The
    // foot is the same animal as the leg; it gets the same albedo.
    const FUR_TOP = LIMB_TOP // dorsal ochre, over the metacarpus
    const FUR_UNDER = LIMB_UNDER // the cream that comes round from the belly
    const TOE_TOP = 0x9b6329 // toe knuckles catch the light, so a shade lighter
    const CLEFT = 0x2c1a0c // the shadowed gap between two toes
    const PAD = 0x1b1210 // pads are near black and always in shadow
    const BAND = LIMB_BAND // the last of the leg's stripes, dying at the wrist

    // Everything below is built in place and only then ruffled and shaded, in
    // that order. Both matter: the noise is a function of world-of-the-group
    // position, so ruffling a part before moving it gives all four toes and both
    // feet the identical set of lumps, and shading before moving means the
    // countershading gradient is measured against the wrong y.
    const makePaw = (side: -1 | 1) => {
      const g = new THREE.Group()
      const fur: THREE.BufferGeometry[] = []
      const hooks: THREE.Group[] = []

      /**
       * One claw, in its own group so it can slide back into the toe.
       *
       * The rest transform is stashed on the group because setClaws() has to
       * interpolate away from it every frame and there is nowhere else to keep it
       * — each of the five claws on a foot sits at a different angle, so a single
       * shared sheathed pose would fan them apart on the way in.
       */
      const addClaw = (
        len: number, rad: number, bend: number,
        x: number, y: number, z: number,
        rx: number, ry: number, rz: number,
      ) => {
        const claw = new THREE.Group()
        claw.add(new THREE.Mesh(clawGeo(len, rad, bend), this.clawMat))
        claw.position.set(x, y, z)
        claw.rotation.set(rx, ry, rz)
        claw.userData.rest = { y, z, rx }
        g.add(claw)
        hooks.push(claw)
      }

      // Carpal mass: the wrist itself, generous enough to swallow the joint where
      // the aimed forearm arrives. The forearm's far end is a hard cylinder cap
      // and it is not parented to this group, so it does not rotate with the
      // paw — this is what hides the shear when the foot turns under.
      fur.push(shade(ruffle(ellipsoid(0.078, 0.066, 0.072, 14, 11)
        .translate(0, -0.006, 0.012), 0.004), FUR_TOP, FUR_UNDER, -0.055, 0.005))

      // Metacarpus. Stops at z = -0.104 so the toes are what the front of the
      // foot is made of.
      fur.push(shade(ruffle(ellipsoid(0.086, 0.050, 0.078, 16, 12)
        .translate(0, -0.048, -0.026), 0.005), FUR_TOP, FUR_UNDER, -0.090, -0.015))

      // The last stripe. A tiger's leg bands stop at the carpus; painting one
      // narrow band across the back of the foot is what ties the plain paw to the
      // striped foreleg above it, and it is the only marking on the foot itself.
      fur.push(tint(ruffle(ellipsoid(0.080, 0.058, 0.016, 14, 8)
        .translate(0, -0.020, 0.030), 0.003), BAND))

      for (let i = 0; i < Tiger.TOES; i++) {
        // -1.5, -0.5, 0.5, 1.5 — an even spread with no toe on the centre line.
        const k = i - (Tiger.TOES - 1) / 2
        const t = k / 1.5
        // The middle pair lead. The outer pair sit back and turn out, which is
        // the shape of a cat's foot from above and the reason a real paw reads as
        // an arc of four rather than as a row.
        const back = t * t * 0.020
        // Pitch and height both came down. A standing cat's toes are packed — the
        // clefts between them are creases, not gaps — and they sit no higher than
        // the metacarpus behind them. At 0.0545 apart and 0.026 tall they stood
        // proud of the foot as four distinct balls, which is what a paw looks like
        // only when the animal is holding something.
        const tx = side * k * 0.0495
        const tz = -0.132 + back
        const toe = ellipsoid(0.027, 0.021, 0.046, 10, 8)
        // Turned out, and the outer toes rolled over onto their sides a little.
        toe.rotateY(-side * t * 0.26)
        toe.rotateX(0.10)
        toe.translate(tx, -0.060, tz)
        fur.push(shade(ruffle(toe, 0.0035), TOE_TOP, FUR_UNDER, -0.088, -0.044))

        // The cleft. Three of them, between the four toes, sunk just under the
        // fur so what shows is a dark line rather than a shape — which is all a
        // gap between two toes ever is at this distance, and it is what stops the
        // four of them merging into one lump under a flat overhead sun.
        if (i < Tiger.TOES - 1) {
          const cleft = ellipsoid(0.007, 0.022, 0.042, 6, 6)
          cleft.translate(side * (k + 0.5) * 0.0495, -0.054, tz - 0.006)
          fur.push(tint(cleft, CLEFT))
        }

        // Digital pad, under its own toe and a few millimetres proud of the fur,
        // so the foot is standing on its pads and not on its hair.
        const pad = ellipsoid(0.023, 0.013, 0.030, 8, 6)
        pad.translate(tx, -0.095, tz + 0.002)
        fur.push(tint(pad, PAD))

        // Claw, at the toe tip and angled down and out along the toe it belongs to.
        addClaw(0.052, 0.0105, 0.62, tx, -0.056, tz - 0.038, 0.16, -side * t * 0.26, side * t * 0.20)
      }

      // Metacarpal pad: one broad central lobe with two smaller ones, which is
      // the trilobed shape a cat leaves in mud.
      fur.push(tint(ellipsoid(0.055, 0.014, 0.040, 10, 6).translate(0, -0.092, -0.048), PAD))
      fur.push(tint(ellipsoid(0.026, 0.012, 0.026, 8, 6).translate(-0.050, -0.089, -0.030), PAD))
      fur.push(tint(ellipsoid(0.026, 0.012, 0.026, 8, 6).translate(0.050, -0.089, -0.030), PAD))

      // Dewclaw, high on the inside of the wrist and off the ground. Nobody would
      // miss it, but it is the kind of thing that is only ever on the real animal
      // — and it is visible on the inner edge of the frame, which is where the eye
      // goes when the two paws are symmetrical about the reticle.
      addClaw(0.036, 0.0085, 0.7, -side * 0.070, -0.026, -0.036, -0.25, side * 0.75, -side * 0.5)

      const merged = mergeGeometries(fur.map((p) => (p.index ? p.toNonIndexed() : p)), false)!
      for (const p of fur) p.dispose()
      g.add(new THREE.Mesh(merged, pawMat))

      g.scale.setScalar(PAW.scale)
      return { paw: g, hooks }
    }

    const built = { l: makePaw(-1), r: makePaw(1) }
    this.pawL = built.l.paw
    this.pawR = built.r.paw
    this.clawsL = built.l.hooks
    this.clawsR = built.r.hooks
    // Pure attachment points — see SHOULDER. Their rotation is never touched.
    this.shoulderL = new THREE.Group()
    this.shoulderR = new THREE.Group()
    this.shoulderL.position.set(-SHOULDER.x, SHOULDER.y, SHOULDER.z)
    this.shoulderR.position.set(SHOULDER.x, SHOULDER.y, SHOULDER.z)
    this.shoulderL.add(this.pawL)
    this.shoulderR.add(this.pawR)

    // The limb, in two segments with an elbow between them.
    //
    // It used to be one straight stretched cylinder from the shoulder to a fixed
    // stub of foreleg glued to the paw, and one straight cylinder is a pipe. A
    // joint is the cheapest realism there is: the eye does not measure how long a
    // limb is in first person, but it knows instantly whether it bends.
    //
    // The elbow also fixes a real bug. The old stub ran back and *down* from the
    // wrist, so its far end sat 0.34 m below a paw that is already standing on the
    // dirt — the leg was buried in the ground, and looking down showed it. The
    // elbow is placed above the wrist now (see updateArms), so the forearm rises
    // out of the foot the way a leg does.
    //
    // Both segments are modelled unit-length and stretched along y every frame, so
    // one geometry serves whatever length the solve asks for.
    //
    // Radii are life size — 14 cm across the elbow, 11 at the wrist. They can be,
    // now that the limb is a foreleg rather than a two-metre boom: a real foreleg
    // seen from a metre away is meant to be a substantial thing filling the lower
    // corner of the frame, and shrinking it to fit was compensating for a joint in
    // the wrong place.
    //
    // The upper arm is a spindle: nearly a point at the shoulder, full thickness at
    // the elbow. Not anatomy — a perspective fix. The shoulder joint is inside the
    // animal's chest and so within 10 cm of the camera plane on a hard look-down,
    // where anything with a radius divides by almost nothing and spans the screen.
    // It costs nothing to look at, because the shoulder end is below the frame at
    // every pitch but the very steepest and a thin tip even there; what shows is
    // the elbow half, at full size.
    // Stripe positions and widths are in fractions of each segment, and the widths
    // are set so both come out at about 2 cm on the animal: the humerus is 0.31 m
    // and the forearm 0.72, so the same number in both would put finger-width
    // stripes on one and hand-width bands on the other.
    const arm = (side: -1 | 1) => new THREE.Mesh(
      limbGeo(side, (v) => 0.018 + 0.052 * smoothstep((v - 0.10) / 0.80),
        [0.34, 0.58, 0.80, 0.95], 0.055), pawMat)
    // The forearm is honest: a taper from the elbow to the wrist, with a belly of
    // flexor muscle in the top third and the bones close under the skin at the
    // carpus. Cats carry a lot of the foreleg's mass high, and a straight cone from
    // joint to joint is the silhouette of a table leg.
    const fore = (side: -1 | 1) => new THREE.Mesh(
      limbGeo(side, (v) => 0.070 - 0.014 * v + 0.014 * Math.sin(Math.PI * Math.min(1, v * 1.7)),
        [0.06, 0.22, 0.37, 0.53, 0.70, 0.87], 0.026), pawMat)
    this.armL = arm(-1)
    this.armR = arm(1)
    this.foreL = fore(-1)
    this.foreR = fore(1)
    this.shoulderL.add(this.armL, this.foreL)
    this.shoulderR.add(this.armR, this.foreR)

    this.vm.add(this.shoulderL, this.shoulderR)
    // Viewmodel renders slightly in front of the world; keep it out of walls.
    this.vm.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.renderOrder = 10
        o.castShadow = false
        ;(o.material as THREE.Material).depthTest = true
      }
    })
    this.resetPaws()
  }

  /** Drop both feet onto the ground wherever the gait currently wants them. */
  private resetPaws() {
    this.clawOutL = this.clawOutR = PAW.clawIdle
    this.setClaws(this.clawsL, PAW.clawIdle)
    this.setClaws(this.clawsR, PAW.clawIdle)
    this.gaitPose(-1, poseP, poseR)
    this.place(this.pawL, -1, poseP, poseR)
    this.gaitPose(1, poseP, poseR)
    this.place(this.pawR, 1, poseP, poseR)
    this.updateArms()
  }

  /**
   * Put one paw at a viewmodel-space pose. The paw group is a child of its
   * shoulder, so this is the one place the offset is taken back out — everything
   * upstream gets to think in the level, eye-origin frame the ground is in.
   */
  private place(paw: THREE.Group, side: -1 | 1, pos: THREE.Vector3, rot: THREE.Vector3) {
    paw.position.set(pos.x - side * SHOULDER.x, pos.y - SHOULDER.y, pos.z - SHOULDER.z)
    paw.rotation.set(rot.x, rot.y, rot.z)
  }

  /**
   * Height of the ground under one forefoot, relative to the ground under the
   * eye. Two table lookups a frame, and without them the feet swim: the terrain
   * rolls by up to fifteen centimetres over the metre and three quarters between
   * the tiger's eye and its paws, so on any slope one foot hangs in clear air
   * while the other is buried to the wrist.
   *
   * Measured against `eyeGround` rather than pos.y, because that is what the
   * camera is placed off — the two have to use the same reference or the feet
   * float by whatever the leg spring is absorbing.
   */
  private slopeAt(side: -1 | 1): number {
    const ahead = -PAW.z
    const px = this.pos.x - Math.sin(this.yaw) * ahead + Math.cos(this.yaw) * side * PAW.x
    const pz = this.pos.z - Math.cos(this.yaw) * ahead - Math.sin(this.yaw) * side * PAW.x
    return clamp(terrainHeight(px, pz) - this.eyeGround, -0.45, 0.45)
  }

  /**
   * Where the gait wants one forefoot right now, in viewmodel space.
   *
   * Shared by the walk and by the tail of every attack, so a swipe returns to
   * exactly the pose the legs are already in rather than snapping to a fixed rest
   * position halfway through a stride — which is what the old `resetPaws()` at
   * the end of a swing did, and it showed every time you clawed on the run.
   */
  private gaitPose(side: -1 | 1, pos: THREE.Vector3, rot: THREE.Vector3) {
    // Left leads; the right is offset by however alternating the gait currently is.
    const phase = this.gaitPhase + (side === 1 ? this.pairPhase : 0)
    const reach = stride(phase, this.gaitDuty) * this.gaitAmp
    const air = lift(phase, this.gaitDuty) * this.gaitAmp
    const ground = -this.eyeAbove + this.slopeAt(side)
    const tuck = this.airBlend
    // Asymmetry — see PAW.stagger. Not simply +/-: an equal and opposite offset is
    // still a mirror, just about a shifted axis. The right foot leads by the full
    // amount and the left gives back a little over half of it.
    const skew = side === 1 ? 1 : -0.6
    pos.set(
      side * PAW.x,
      ground + PAW.sole + air * PAW.lift + tuck * 0.66,
      PAW.z - reach * PAW.stride - tuck * 0.34 - skew * PAW.stagger,
    )
    rot.set(
      // Toes down into the plant, curled up through the swing, and thrown out
      // ahead of the animal while it is off the ground.
      PAW.pitch + reach * 0.16 - air * 0.5 - tuck * 0.55,
      -side * PAW.yaw - skew * 0.05,
      -side * PAW.roll,
    )
  }

  // ------------------------------------------------------------- combat
  get canClaw() { return this.clawCd <= 0 }
  get canBite() { return this.biteCd <= 0 }
  get canRoar() { return this.roarCd <= 0 }

  private startAttack(kind: AttackKind) {
    if (kind === 'claw') {
      this.clawCd = TIGER.clawCooldown
      this.pawState = this.nextPawIsLeft ? 'swipeL' : 'swipeR'
      this.swingEvent = this.nextPawIsLeft ? -1 : 1
      this.nextPawIsLeft = !this.nextPawIsLeft
    } else {
      this.biteCd = TIGER.biteCooldown
      this.pawState = 'bite'
      this.swingEvent = 1
    }
    this.swingIsBite = kind === 'bite'
    this.pawT = 0
  }

  /** Fired mid-animation so the swipe connects when it looks like it should. */
  private emitAttack(kind: AttackKind) {
    const dir = this.lookDir()
    const origin = this.eyePos()
    const base = kind === 'claw' ? TIGER.clawDamage : TIGER.biteDamage
    this.pendingAttack = {
      kind,
      origin,
      dir,
      range: kind === 'claw' ? TIGER.clawRange : TIGER.biteRange,
      arc: kind === 'claw' ? TIGER.clawArc : TIGER.biteArc,
      damage: base * this.damageMult * (this.frenzy > 0 ? TIGER.frenzyDamageMult : 1),
    }
  }

  /**
   * Told by the game what the swing actually did, on the frame it landed.
   *
   * Without this the viewmodel plays the same arc whether you opened a throat
   * or swiped at fog, which is exactly what "the hits don't connect" means: the
   * animation has no idea it touched anything. A connecting blow now stalls
   * mid-swing, drives the camera along the look axis, and leaves the claws wet.
   */
  onAttackResult(hit: boolean, killed: boolean) {
    if (!hit) return
    this.hitStop = killed ? TIGER.killStop : TIGER.hitStop
    this.impact = killed ? TIGER.hitJolt * 1.7 : TIGER.hitJolt
    this.clawBlood = 1
  }

  lookDir(target = new THREE.Vector3()): THREE.Vector3 {
    return target.set(
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch),
    )
  }

  eyePos(target = new THREE.Vector3()): THREE.Vector3 {
    return target.set(this.pos.x, this.pos.y + this.eyeY, this.pos.z)
  }

  // ------------------------------------------------------------- damage
  takeDamage(amount: number): boolean {
    const dmg = amount * this.damageTakenMult * (this.frenzy > 0 ? 0.75 : 1)
    this.health = Math.max(0, this.health - dmg)
    this.sinceDamage = 0
    this.shake(0.45)
    return this.health <= 0
  }

  heal(amount: number) {
    this.health = Math.min(TIGER.maxHealth, this.health + amount)
  }

  addRage(amount: number) {
    this.rage = Math.min(TIGER.maxRage, this.rage + amount)
  }

  shake(amount: number) {
    this.camShake = Math.min(1.4, this.camShake + amount)
  }

  startFrenzy(): boolean {
    if (this.rage < TIGER.maxRage) return false
    this.rage = 0
    this.frenzy = TIGER.frenzyDuration
    this.shake(0.7)
    return true
  }

  /** Noise the tiger is currently making — drives AI detection. */
  get noise(): number {
    const moving = Math.hypot(this.vel.x, this.vel.z)
    if (moving < 0.4) return 2
    if (this.crouching) return TIGER.noiseCrouch
    if (this.sprinting) return TIGER.noiseSprint
    return TIGER.noiseWalk
  }

  /** How visible the tiger is right now, 0..1. Grass + crouch hide you. */
  get visibility(): number {
    let v = 1
    if (this.crouching) v *= 0.55
    if (this.world.inGrass(this.pos.x, this.pos.z)) {
      v *= this.crouching ? TIGER.grassConcealment : 0.75
    }
    if (this.sprinting) v = Math.min(1, v * 1.6)
    return v
  }

  // ------------------------------------------------------------- update
  update(dt: number, input: Input, locked: boolean) {
    this.pendingAttack = null
    this.footstepEvent = false
    this.landedEvent = false
    this.swingEvent = 0
    this.pounceEvent = false

    if (locked) this.updateLook(input)
    this.updateTimers(dt)
    this.updateMovement(dt, input, locked)
    if (locked) this.updateActions(input)
    // Bound first: it resolves how high the eye is above the ground this frame,
    // and the paws are placed against that ground rather than against the frame.
    this.updateBound(dt)
    this.updateViewmodel(dt)
    this.updateCamera(dt)
  }

  private updateLook(input: Input) {
    this.yaw -= input.mouseDX * CAMERA.sensitivity
    this.pitch -= input.mouseDY * CAMERA.sensitivity
    this.pitch = clamp(this.pitch, -CAMERA.pitchLimit, CAMERA.pitchLimit)
  }

  private updateTimers(dt: number) {
    this.clawCd = Math.max(0, this.clawCd - dt)
    this.biteCd = Math.max(0, this.biteCd - dt)
    this.roarCd = Math.max(0, this.roarCd - dt)
    this.sinceDamage += dt
    this.sinceSprint += dt
    this.frenzy = Math.max(0, this.frenzy - dt)
    this.camShake = Math.max(0, this.camShake - dt * 2.4)
    this.shakeTime += dt
    this.recoilY = damp(this.recoilY, 0, 9, dt)
    this.hitStop = Math.max(0, this.hitStop - dt)
    this.impact = damp(this.impact, 0, 11, dt)

    // The landing spring. Critically damped, and integrated semi-implicitly so it
    // cannot gain energy at a long frame: velocity first, then position off the
    // velocity we just solved. The eye's *velocity* is what an impact changes —
    // subtracting a height on the contact frame, which is what this replaces, is
    // a teleport.
    const w = TIGER.dipFreq
    this.dipVel -= (w * w * this.dip + 2 * w * this.dipVel) * dt
    this.dip += this.dipVel * dt

    // Off the ground the forelegs stop striding and reach: a pouncing cat throws
    // both front feet out ahead of itself and holds them there until it lands.
    // Gated on having been airborne a moment, because the pose is far too big to
    // enter over a bump — see TIGER.airGrace.
    this.airTime = this.grounded ? 0 : this.airTime + dt
    this.airBlend = damp(this.airBlend, this.airTime > TIGER.airGrace ? 1 : 0, 7, dt)

    if (this.clawBlood > 0) {
      this.clawBlood = Math.max(0, this.clawBlood - dt / TIGER.clawBloodTime)
      // Bone white when clean, wet arterial red when fresh, drying to brown.
      this.clawMat.color.setHex(CLAW_CLEAN).lerp(BLOOD, this.clawBlood * 0.92)
      this.clawMat.roughness = CLAW_ROUGH - this.clawBlood * 0.16
    }

    if (this.sinceDamage > TIGER.regenDelay) {
      this.health = Math.min(TIGER.maxHealth, this.health + TIGER.healthRegen * dt)
    }
    if (this.sinceSprint > TIGER.staminaRegenDelay) {
      this.stamina = Math.min(TIGER.maxStamina, this.stamina + TIGER.staminaRegen * dt)
    }
    if (this.frenzy <= 0) {
      this.rage = Math.max(0, this.rage - TIGER.rageDecay * dt)
    }
  }

  private updateMovement(dt: number, input: Input, locked: boolean) {
    const axis = locked ? input.moveAxis() : { x: 0, z: 0 }
    const wantsSprint = locked && input.held('ShiftLeft') && this.stamina > 1 && axis.z > 0.1
    this.crouching = locked && (input.held('ControlLeft') || input.held('KeyC')) && this.grounded
    this.sprinting = wantsSprint && !this.crouching

    if (this.sprinting) {
      this.stamina = Math.max(0, this.stamina - TIGER.sprintDrain * dt)
      this.sinceSprint = 0
    }

    let target = TIGER.walkSpeed
    if (this.sprinting) target = TIGER.sprintSpeed
    else if (this.crouching) target = TIGER.crouchSpeed
    target *= this.speedMult * (this.frenzy > 0 ? TIGER.frenzySpeedMult : 1)

    // Desired velocity in world space from local input.
    const fwdX = -Math.sin(this.yaw)
    const fwdZ = -Math.cos(this.yaw)
    const rightX = Math.cos(this.yaw)
    const rightZ = -Math.sin(this.yaw)
    const wantX = (fwdX * axis.z + rightX * axis.x) * target
    const wantZ = (fwdZ * axis.z + rightZ * axis.x) * target

    // A force, not a lerp. The error between the velocity we have and the one we
    // want is chased at a capped acceleration, easing off inside `knee` of the
    // target so the arrival has no corner in it. Acceleration is therefore
    // continuous everywhere, including the frame the key goes down, the frame it
    // comes up, and the frame the target flips through a direction change — the
    // error is a vector, so a reversal is just a long way to go, not a special case.
    //
    // The old form was `min(1, accel*dt/target)` with a second friction multiply
    // stacked on top when the stick was neutral, and the two together took
    // 1.7 m/s out of the tiger in a single frame — 103 m/s², ten gravities. The
    // exponential that briefly replaced it was no better at the top: chasing
    // 6.2 m/s from rest at rate 7 is 43 m/s² on the first frame. Nothing that
    // reads speed, least of all the gait clock, stays smooth across either.
    const moving = axis.x !== 0 || axis.z !== 0
    const ex = wantX - this.vel.x
    const ez = wantZ - this.vel.z
    const err = Math.hypot(ex, ez)
    if (err > 1e-6) {
      const cap = (moving ? TIGER.accelForce : TIGER.brakeForce) * (this.grounded ? 1 : TIGER.airControl)
      const knee = moving ? TIGER.accelKnee : TIGER.brakeKnee
      // Never step past the target: at 20 fps a full-force frame is 0.7 m/s.
      const dv = Math.min(err, cap * Math.min(1, err / knee) * dt)
      this.vel.x += (ex / err) * dv
      this.vel.z += (ez / err) * dv
    }

    // Pounce.
    if (locked && input.pressed('Space') && this.grounded && this.stamina >= TIGER.pounceCost) {
      this.stamina -= TIGER.pounceCost
      this.sinceSprint = 0
      const dir = this.lookDir()
      const horiz = Math.hypot(dir.x, dir.z) || 1
      const moving = axis.z > 0.05 || axis.x !== 0 || true
      if (moving) {
        this.vel.x += (dir.x / horiz) * TIGER.pounceForward
        this.vel.z += (dir.z / horiz) * TIGER.pounceForward
      }
      this.vel.y = TIGER.pounceUp + Math.max(0, dir.y) * 5
      this.grounded = false
      this.airTime = TIGER.airGrace + 1 // a leap is a leap from the first frame
      this.pouncing = true
      this.pounceEvent = true
      // Through the spring rather than straight onto the eye: the coil is a shove
      // downward on the head, not an instant nine centimetres of it.
      this.dipVel += TIGER.pounceDip
    }

    // Gravity + integrate.
    if (!this.grounded) this.vel.y -= TIGER.gravity * dt
    this.pos.x += this.vel.x * dt
    this.pos.z += this.vel.z * dt
    this.pos.y += this.vel.y * dt

    // Static collision.
    const r = this.world.resolve(this.pos.x, this.pos.z, TIGER.radius, this.pos.y)
    if (r.hit) {
      // Kill velocity into the surface so we slide instead of sticking.
      const dx = r.x - this.pos.x
      const dz = r.z - this.pos.z
      const l = Math.hypot(dx, dz)
      if (l > 1e-5) {
        const nx = dx / l
        const nz = dz / l
        const into = this.vel.x * nx + this.vel.z * nz
        if (into < 0) {
          this.vel.x -= nx * into
          this.vel.z -= nz * into
        }
      }
      this.pos.x = r.x
      this.pos.z = r.z
    }

    // Ground.
    const gy = terrainHeight(this.pos.x, this.pos.z)
    this.groundY = gy
    if (this.pos.y <= gy) {
      if (!this.grounded) {
        // The impact, as an initial velocity for the spring in updateTimers.
        this.dipVel += Math.min(TIGER.landDipMax, Math.abs(this.vel.y) * TIGER.landDipTake)
        this.landedEvent = true
        this.pouncing = false
      }
      this.pos.y = gy
      this.vel.y = 0
      this.grounded = true
    } else if (this.grounded && this.vel.y <= 0 && this.pos.y - gy <= TIGER.stepDown) {
      // Ground that fell away underneath a foot that is still on it. Follow it
      // down instead of going ballistic for three frames — see TIGER.stepDown.
      this.pos.y = gy
      this.vel.y = 0
    } else if (this.pos.y > gy + 0.06) {
      this.grounded = false
    }

    this.updateGait(dt)
  }

  /**
   * The gait clock: how far the legs are reaching, how long they hold the ground,
   * and how far round the stride they are.
   *
   * The clock is advanced by *ground covered*, not by a cadence read off the
   * speedometer, and that one change is what makes the whole thing hold together:
   *
   *   - the planted foot is stuck to the world by construction rather than by
   *     coincidence, at any speed and through any acceleration, because both it
   *     and the phase are driven by the same displacement;
   *   - the cadence falls out correct — strideLength grows as speed^0.7, so
   *     cadence takes speed^0.3 — instead of being a second curve that has to be
   *     kept in agreement with the first;
   *   - it reaches zero exactly when the tiger does, with no threshold to cross.
   *     The old `speed > 0.35` gate stopped the clock dead while the amplitude was
   *     still 1.46, which put a corner in the head bob's velocity every time the
   *     player let go of the stick.
   *
   * Nothing here is switched on a state. Amplitude ramping in and out is what
   * starts and stops the walk, and the phase is never rewound.
   */
  private updateGait(dt: number) {
    const speed = Math.hypot(this.vel.x, this.vel.z)
    const pace = speed / TIGER.walkSpeed

    // Reach. Saturates at 1 rather than 1.5: PAW.stride is already the limb's
    // reach, so there is nothing left to give above walking pace and the extra
    // ground has to be bought with cadence and a shorter contact instead. The old
    // curve hit its 1.5 clamp at 0.9 of walkSpeed, so a walk and a flat sprint
    // reached identically far and the walk was doing it 50% past the limb's reach.
    //
    // Off the ground the reach folds away into the pounce tuck instead.
    const want = clamp(Math.pow(pace, 0.55), 0, 1) * (1 - this.airBlend)
    this.gaitAmp = damp(this.gaitAmp, want, 10, dt)

    // The animal's own stride length, which is the only thing the clock needs.
    const strideLen = Math.max(0.05, (TIGER.walkSpeed / CAMERA.strideRate) * Math.pow(pace, CAMERA.strideGrowth))
    this.gaitPhase = (this.gaitPhase + (speed * dt) / strideLen) % 2

    // Contact, as the fraction of that stride the sweep can actually cover.
    this.gaitDuty = clamp((2 * PAW.stride * this.gaitAmp) / strideLen, DUTY_MIN, DUTY_MAX)

    // A walking cat moves its forefeet alternately; a bounding one reaches with
    // both together and lands on them together. Interpolated by speed — and moved
    // only while the trailing foot is off the ground, because re-timing a foot that
    // is standing on something drags it across the dirt: at the old flat rate of 4
    // the sprint transition alone slid it a metre a second.
    const bound = clamp(
      (speed - TIGER.walkSpeed) / (TIGER.sprintSpeed - TIGER.walkSpeed), 0, 1,
    )
    const rightPhase = this.gaitPhase + this.pairPhase
    if (rightPhase - Math.floor(rightPhase) > this.gaitDuty) {
      this.pairPhase = damp(this.pairPhase, 0.5 - bound * 0.34, 6, dt)
    }

    // Footsteps fire on the plant, so the sound is on the frame the paw touches
    // the ground. The old distance counter drifted out of step with the legs
    // within a couple of strides of any change of pace.
    const striding = this.grounded && this.gaitAmp > 0.25
    const beat = Math.floor(this.gaitPhase * 2)
    if (striding && beat !== this.lastBeat && this.lastBeat >= 0) this.footstepEvent = true
    this.lastBeat = striding ? beat : -1
  }

  private updateActions(input: Input) {
    if (input.clickedPrimary() && this.canClaw) this.startAttack('claw')
    else if (input.clickedSecondary() && this.canBite) this.startAttack('bite')
  }

  private updateViewmodel(dt: number) {
    // Take the camera's pitch back out, so the forelegs stay level with the world
    // and the feet stay on the ground when you raise or drop your head. Without
    // this the whole rig is pinned to the frame and the paws swing up into the
    // sky the moment you look up — which is what "on the ground" costs.
    this.vm.rotation.x = -this.pitch * PAW.pitchFollow
    this.updateClaws(dt)

    if (this.pawState === 'idle') {
      this.gaitPose(-1, poseP, poseR)
      this.place(this.pawL, -1, poseP, poseR)
      this.gaitPose(1, poseP, poseR)
      this.place(this.pawR, 1, poseP, poseR)
      this.updateArms()
      return
    }

    const dur = this.pawState === 'bite' ? 0.42 : 0.34
    const prev = this.pawT
    // Hit-stop: the swing holds on the contact frame while the camera keeps
    // moving. Nothing else in the game pauses, so it costs a few frames of the
    // paw and buys the whole impression of hitting something solid.
    if (this.hitStop <= 0) this.pawT += dt
    const t = clamp(this.pawT / dur, 0, 1)
    // Contact is the end of the drive, so the paw is *at* the reticle on the
    // frame the damage lands rather than four fifths of the way to it.
    const hitAt = this.pawState === 'bite' ? 0.44 : 0.52
    if (prev / dur < hitAt && t >= hitAt) {
      this.emitAttack(this.pawState === 'bite' ? 'bite' : 'claw')
    }

    const ground = -this.eyeAbove
    if (this.pawState === 'bite') {
      // Both forelegs come up and in to clamp the body, then drag it down and out
      // of frame as the jaws close on the throat.
      for (const [paw, side] of [[this.pawL, -1], [this.pawR, 1]] as const) {
        this.gaitPose(side, poseP2, poseR2)
        // Clamp: both feet up and in, around where the body will be. Drag: hauled
        // down and back under the chest as the jaws close on the throat.
        const gx = side * 0.26, gy = ground + 1.06, gz = -0.86
        const dx = side * 0.42, dy = ground + 0.20, dz = -0.56
        if (t < 0.44) {
          // Blended out of whatever the legs were already doing, so a bite taken
          // at a dead run doesn't begin by teleporting both feet.
          const e = smoothstep(t / 0.44)
          keyP.set(gx, gy, gz)
          keyR.set(-0.55, side * 0.34, side * 0.30)
          poseP.copy(poseP2).lerp(keyP, e)
          poseR.copy(poseR2).lerp(keyR, e)
        } else if (t < 0.74) {
          const e = smoothstep((t - 0.44) / 0.30)
          poseP.set(gx, gy, gz).lerp(keyP.set(dx, dy, dz), e)
          poseR.set(-0.55, side * 0.34, side * 0.30)
            .lerp(keyR.set(0.35, side * 0.12, side * 0.10), e)
        } else {
          const e = smoothstep((t - 0.74) / 0.26)
          poseP.set(dx, dy, dz).lerp(poseP2, e)
          poseR.set(0.35, side * 0.12, side * 0.10).lerp(poseR2, e)
        }
        this.place(paw, side, poseP, poseR)
      }
      // A quartic hump rather than a half sine: `sin(pi t)` leaves zero with a
      // slope, so the eye picked up 0.56 m/s of downward velocity on the frame
      // the bite started and lost it again on the frame it ended. This peaks at
      // exactly the same depth but starts and ends at rest.
      const h = t * (1 - t)
      this.recoilY = -0.075 * 16 * h * h
    } else {
      const left = this.pawState === 'swipeL'
      const paw = left ? this.pawL : this.pawR
      const other = left ? this.pawR : this.pawL
      const side = left ? -1 : 1
      const otherSide = left ? 1 : -1

      // Four beats, all of them positions of the foot. Cock it back and out, drive
      // it up and across the centre of the frame — where the reticle, and so the
      // target, is — carry it through and down, then hand it back to the gait.
      //
      // Contact sits a touch above the eye line on purpose: the tiger's eye is at
      // 1.10 m and a standing villager's chest is at 1.20, so a swipe aimed at
      // what you are looking at goes slightly *up*.
      if (t < 0.24) {
        // Wind up, out of whatever the legs are already doing.
        this.gaitPose(side, poseP2, poseR2)
        // Smoothstep, not an ease-out: an ease-out leaves the gait pose at full
        // speed, so a swipe thrown mid-stride began with the foot snapping off
        // whatever it was doing. Both ends of this are at rest, and the drive
        // that follows also starts at rest, so the whole chain is C1.
        const e = smoothstep(t / 0.24)
        poseP.set(side * (PAW.x + 0.14), ground + 0.42, PAW.z + 0.44)
        poseR.set(PAW.pitch + 0.42, -side * (PAW.yaw + 0.30), -side * (PAW.roll + 0.28))
        keyP.copy(poseP); keyR.copy(poseR)
        poseP.copy(poseP2).lerp(keyP, e)
        poseR.copy(poseR2).lerp(keyR, e)
      } else if (t < 0.52) {
        // The drive. Squared, so the stroke is at its fastest on the contact
        // frame — the old ease-out had it fastest as it left the wind-up and
        // coasting by the time it arrived.
        const u = (t - 0.24) / 0.28
        const e = u * u
        poseP.set(side * (PAW.x + 0.14), ground + 0.42, PAW.z + 0.44)
        poseR.set(PAW.pitch + 0.42, -side * (PAW.yaw + 0.30), -side * (PAW.roll + 0.28))
        keyP.set(side * 0.10, ground + 1.20, -0.98)
        keyR.set(-0.75, side * 0.55, side * 0.62)
        poseP.lerp(keyP, e)
        poseR.lerp(keyR, e)
      } else if (t < 0.74) {
        const e = smoothstep((t - 0.52) / 0.22)
        poseP.set(side * 0.10, ground + 1.20, -0.98)
        poseR.set(-0.75, side * 0.55, side * 0.62)
        keyP.set(-side * 0.40, ground + 0.66, -0.72)
        keyR.set(-0.25, side * 0.30, side * 0.30)
        poseP.lerp(keyP, e)
        poseR.lerp(keyR, e)
      } else {
        // Back into the stride, not back to a fixed rest pose.
        this.gaitPose(side, poseP2, poseR2)
        const e = smoothstep((t - 0.74) / 0.26)
        poseP.set(-side * 0.40, ground + 0.66, -0.72).lerp(poseP2, e)
        poseR.set(-0.25, side * 0.30, side * 0.30).lerp(poseR2, e)
      }
      this.place(paw, side, poseP, poseR)

      // The other foreleg keeps walking, and takes the weight: a cat swiping
      // plants its far foot and shoves off it. Freezing it — which is what the
      // old brace did — stopped the animal dead underneath the swing.
      this.gaitPose(otherSide, poseP2, poseR2)
      // Same reason as the bite's recoil: a half sine over 0..0.6 both enters and
      // leaves with slope, and the leaving end lands right in the middle of the
      // stroke where the far foot is supposed to be carrying the weight.
      const u = clamp(t / 0.6, 0, 1)
      const brace = 8 * (u * (1 - u)) ** 2
      poseP2.z -= brace * 0.10
      poseR2.x += brace * 0.12
      this.place(other, otherSide, poseP2, poseR2)

      // Down through the drive and back up as the foot comes through. Both halves
      // are smoothsteps so the head is at rest at t=0, at the contact and at the
      // hand-back to the gait; the old pair of linear ramps put a step in the
      // eye's velocity at all three.
      this.recoilY = -0.045 * (t < 0.52 ? smoothstep(t / 0.52) : 1 - smoothstep((t - 0.52) / 0.48))
    }

    if (t >= 1) this.pawState = 'idle'
    this.updateArms()
  }

  /**
   * Aim both segments of both forelegs at wherever the feet ended up.
   *
   * The paw group's origin *is* the wrist, so in shoulder space the wrist is
   * simply `paw.position` and no forward-kinematic chain is needed — the animation
   * moves feet and this closes the loop back to the body.
   *
   * The humerus is a fixed length and the forearm takes up the slack. The elbow
   * goes UPPER_LEN out from the shoulder along a direction that leans toward the
   * foot but is pushed backward and outward by ELBOW_POLE, so the joint always
   * ends up behind and below the shoulder — tucked against the ribs, where a cat's
   * elbow is — and the forearm crosses the frame broadside from there down to the
   * paw.
   *
   * Deliberately not a full two-bone IK solve. The leg is close to straight at a
   * normal stance, only a few centimetres inside its own reach, and a circle
   * intersection near its degenerate case snaps the elbow between solutions on
   * noise. Fixing the bone that shows and letting the hidden one stretch is stable
   * every frame: the forearm runs between 0.62 and 0.80 m over the whole stride,
   * an eighth either side of nominal, and nothing about a furred tube gives that
   * away. The alternative — pinning both bones and letting the wrist miss the foot
   * — is the one error the player would see, because the foot is the thing they
   * are looking at.
   */
  private updateArms() {
    for (const [paw, arm, fore, side] of [
      [this.pawL, this.armL, this.foreL, -1],
      [this.pawR, this.armR, this.foreR, 1],
    ] as const) {
      wristAt.copy(paw.position)
      const reach = Math.max(1e-4, wristAt.length())
      // Fade the pole out as the foot comes in toward the chest: a tucked paw is
      // already behind the shoulder, and a full backward bias there would fold the
      // elbow out past the foot it is meant to be holding up.
      const bias = Math.min(1, reach / 0.9)
      poleAt.set(side * ELBOW_POLE.x, ELBOW_POLE.y, ELBOW_POLE.z).multiplyScalar(bias)
      segDir.copy(wristAt).divideScalar(reach).add(poleAt).normalize()
      elbowAt.copy(segDir).multiplyScalar(UPPER_LEN)

      arm.quaternion.setFromUnitVectors(DOWN, segDir)
      // Overshoot slightly so the two caps overlap instead of meeting exactly,
      // which would show a seam the moment the joint bends.
      arm.scale.y = UPPER_LEN + 0.04

      segDir.subVectors(wristAt, elbowAt)
      const lower = Math.max(1e-4, segDir.length())
      fore.position.copy(elbowAt)
      fore.quaternion.setFromUnitVectors(DOWN, segDir.divideScalar(lower))
      fore.scale.y = lower + 0.03
    }
  }

  /**
   * Unsheathe the striking paw and let the other one rest.
   *
   * Damped rather than switched, and fast — 22 per second is roughly two frames
   * of travel, which is about how quickly a cat's claws actually come out, but
   * still enough to stop the snap that setting them directly would give. The paw
   * that is *not* swinging stays at rest, so a strike is visibly asymmetric: one
   * foot armed, one foot carried.
   */
  private updateClaws(dt: number) {
    const want = (mine: PawState) =>
      this.pawState === mine ? 1 : this.pawState === 'bite' ? 0.8 : PAW.clawIdle
    this.clawOutL = damp(this.clawOutL, want('swipeL'), 22, dt)
    this.clawOutR = damp(this.clawOutR, want('swipeR'), 22, dt)
    this.setClaws(this.clawsL, this.clawOutL)
    this.setClaws(this.clawsR, this.clawOutR)
  }

  /**
   * Slide one foot's claws in or out. 0 sheathed, 1 fully extended.
   *
   * Retraction in a cat is a rotation about the last joint, not a slide, so the
   * claw is tucked *up* and *back* into the fur over the toe rather than pulled
   * straight in — hence all three of position and pitch moving together. The
   * distances are small on purpose: the whole travel is about the length of the
   * claw, and overdoing it pushes the tip out through the top of the toe.
   */
  private setClaws(hooks: THREE.Group[], out: number) {
    const hide = 1 - out
    for (const claw of hooks) {
      const rest = claw.userData.rest as { y: number; z: number; rx: number }
      claw.position.y = rest.y + hide * 0.013
      claw.position.z = rest.z + hide * 0.030
      claw.rotation.x = rest.rx - hide * 0.55
    }
  }

  /**
   * The bound, and the eye height it implies.
   *
   * Split out of updateCamera because the viewmodel needs the same numbers: the
   * paws are placed against the ground now, so they have to know exactly how far
   * the head is above it this frame, bob included. Anything less and the feet swim
   * against the terrain by the amplitude of the bob.
   *
   * Everything here is a plain sinusoid of the gait phase. The old curve took
   * `pow( max( sin, 0 ), 0.6 )`, which has an infinite slope where it leaves zero
   * — a corner in the camera's vertical velocity twice per stride, and a good part
   * of what read as jank in the run. Phase offsets do the same shaping job without
   * the kink.
   *
   * The offsets are keyed off the plant, which is phase 0. The head is lowest a
   * little way into the contact and highest at the top of the suspension between
   * strides, and the nose pitches down into the plant itself. They had to move when
   * the duty factor did: at the old 0.62 an offset of 1.9 rad put the low point
   * inside the contact, but with contact now less than a third of the stride the
   * same number put it out in mid-air, and a head that dips while the animal is
   * airborne reads as a spring in the neck rather than weight on a leg.
   */
  private updateBound(dt: number) {
    const targetEye = this.crouching ? TIGER.crouchEyeHeight : TIGER.eyeHeight
    this.eyeY = damp(this.eyeY, targetEye, 12, dt)

    // The legs, absorbing the height field's corners. Only the view uses this;
    // pos.y stays exactly on the terrain. See TIGER.legSpring, and note the fade:
    // in the air the body is ballistic and there is no leg to spring.
    this.groundSmooth = damp(this.groundSmooth, this.groundY, TIGER.legSpring, dt)
    this.eyeGround = this.pos.y + (this.groundSmooth - this.groundY) * (1 - this.airBlend)

    const w = this.gaitPhase * Math.PI * 2
    const amp = this.gaitAmp
    // Low a sixth of a stride after the plant, i.e. through the middle of contact.
    this.bobY = Math.sin(w + 3.77) * CAMERA.boundAmp * amp
    this.bobPitch = -Math.sin(w + 1.07) * CAMERA.boundPitch * amp
    // Half rate: a quadruped's shoulders roll once per *pair* of strides, and 2 is
    // exactly where gaitPhase wraps, so this stays continuous across the wrap.
    this.bobX = Math.sin(w * 0.5) * CAMERA.swayAmp * amp
    this.bobRoll = Math.sin(w * 0.5 + 1.2) * CAMERA.boundRoll * amp
    this.eyeAbove = this.eyeY + this.bobY + this.recoilY - this.dip
  }

  private updateCamera(dt: number) {
    const bobPitch = this.bobPitch
    const bobX = this.bobX
    const bobRoll = this.bobRoll

    // Shake uses layered sines rather than random so it never jitters harshly.
    const s = this.camShake
    const st = this.shakeTime
    const shakeX = s * Math.sin(st * 47) * 0.16
    const shakeY = s * Math.sin(st * 61 + 1.3) * 0.16
    const shakeR = s * Math.sin(st * 39 + 2.1) * 0.05

    // A connecting blow shoves the whole head along the look axis, so the
    // impact is felt in the world rather than only in the arm.
    this.lookDir(lunge).multiplyScalar(this.impact)

    // Sway and shake go along the tiger's own right, not along world x. They used
    // to be added straight to pos.x with the z axis getting `shakeY * 0.2`, which
    // meant the shoulder sway turned into a fore-and-aft lurch whenever the animal
    // happened to be facing along x, and the shake ran on a fixed world diagonal.
    const rx = Math.cos(this.yaw)
    const rz = -Math.sin(this.yaw)
    const lateral = bobX + shakeX
    this.camera.position.set(
      this.pos.x + rx * lateral + lunge.x,
      this.eyeGround + this.eyeAbove + shakeY + lunge.y,
      this.pos.z + rz * lateral + lunge.z,
    )
    this.camera.rotation.set(
      this.pitch + bobPitch + shakeY * 0.4 - this.impact * 2.2,
      this.yaw,
      bobX * 0.08 + bobRoll + shakeR,
      'YXZ',
    )

    // FOV punches out when you're moving fast or frenzied.
    let fov = CAMERA.fov
    if (this.frenzy > 0) fov = CAMERA.frenzyFov
    else if (this.sprinting) fov = CAMERA.sprintFov
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov = damp(this.camera.fov, fov, 6, dt)
      this.camera.updateProjectionMatrix()
    }
  }

  reset() {
    this.pos.set(0, 0, 56)
    this.pos.y = terrainHeight(this.pos.x, this.pos.z)
    this.vel.set(0, 0, 0)
    this.yaw = 0
    this.pitch = 0
    this.health = TIGER.maxHealth
    this.stamina = TIGER.maxStamina
    this.rage = 0
    this.frenzy = 0
    this.speedMult = 1
    this.damageMult = 1
    this.damageTakenMult = 1
    this.clawCd = this.biteCd = this.roarCd = 0
    this.camShake = 0
    this.hitStop = 0
    this.impact = 0
    this.clawBlood = 0
    this.clawMat.color.setHex(CLAW_CLEAN)
    this.clawMat.roughness = CLAW_ROUGH
    this.pawState = 'idle'
    this.gaitPhase = 0
    this.gaitAmp = 0
    this.gaitDuty = DUTY_MAX
    this.pairPhase = 0.5
    this.grounded = true
    this.pouncing = false
    this.airTime = 0
    this.airBlend = 0
    this.lastBeat = -1
    this.bobY = this.bobPitch = this.bobX = this.bobRoll = 0
    this.recoilY = 0
    this.dip = this.dipVel = 0
    this.eyeY = TIGER.eyeHeight
    this.eyeAbove = TIGER.eyeHeight
    // The leg spring has to start relaxed, or the first frame after a respawn
    // carries the old ground height and drops the view a metre at 14/s.
    this.groundY = this.groundSmooth = this.eyeGround = this.pos.y
    this.resetPaws()
  }
}
