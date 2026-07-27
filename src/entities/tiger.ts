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
import { setContact } from '../world/contact'
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
  x: 0.33,
  /**
   * Mid-stance: how far ahead of the eye the foot is halfway through contact.
   *
   * Down from 0.66, and this is the number that decides whether the limb has an
   * elbow the player can see.
   *
   * At 0.66 the wrist was 1.006 m from the shoulder. Split against a 0.44 m
   * humerus that leaves a 0.57 m forearm — a bone a third longer than the one
   * above it, on an animal whose humerus and radius are the same length. Worse,
   * the whole limb was then long enough to run from the corner of the frame to
   * the middle of it, so what the player saw was a metre of unbroken tube with
   * the joint somewhere off the bottom of the screen. That is a tail, and it is
   * what the render showed.
   *
   * At 0.44 the reach is 0.86 m, the split is 0.44 against 0.42, and the elbow
   * lands inside the frame at every pitch the paws are visible at. The cost is
   * honest: the feet now enter the bottom of the frame at about 28 degrees of
   * look-down rather than 18, and centre at 67 rather than 50. That is simply
   * where a tiger's feet are — under its shoulders, not out in front of them.
   */
  z: -0.44,
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
  stride: 0.24,
  /** Peak of the swing above the ground. */
  lift: 0.20,
  /**
   * Height of the paw group's origin — the wrist joint — above the ground when
   * the foot is planted. Measured off the geometry: the pads bottom out 0.106 m
   * below the wrist.
   *
   * Deliberately six millimetres *under* that, so the pads sink into the dirt
   * rather than resting exactly on it. The ground is a bilinear height field with
   * a metre of grass standing in it, and a foot placed at the arithmetically
   * correct height sits visibly above the surface the player can actually see —
   * which is half of why the paws read as hovering. The other half is that
   * nothing was casting a shadow; see the contact shadows in buildViewmodel().
   */
  sole: 0.100,
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
   *
   * Down from 0.34, which was not "the tips". At 0.34 four centimetres of a six
   * centimetre claw stood clear of each toe, and against dark ground five bright
   * horn spikes per foot are the first thing in the frame — the paw read as a
   * garden fork rather than a foot. A tenth leaves a couple of millimetres of tip
   * showing, which is what you see on a cat that is merely walking, and the whole
   * of the rest of the claw is still there the moment anything is worth striking.
   */
  clawIdle: 0.1,
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
 *
 * x and y are set where they are by the torso, not by anatomy. Measured against
 * torsoGeo()'s skin at z = 0.06 — the bare ellipse there is 0.181 by 0.167 about
 * a centre at y = -0.47, and the scapula lump adds about 8 cm along the normal —
 * the surface reaches 0.259 m from that centre in the shoulder direction. At the
 * old x = 0.20, y = -0.30 the joint sat 0.2625 m out: a few millimetres *outside*
 * its own body, which is a hairline of daylight between arm and chest at any
 * angle that catches it. Pulled in to 0.185 / -0.315 the root is buried 1.8 cm
 * deep and no pose can open that gap.
 *
 * Growing the shoulder mass to swallow the old position would have worked too and
 * was the wrong trade: the scapula lumps carry to the spine, so the four
 * millimetres needed at the joint cost four millimetres of extra withers, and
 * withers height is exactly what was cut to stop the back hiding a swinging leg.
 */
const SHOULDER = { x: 0.185, y: -0.315, z: 0.06 }

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
 * Countershade a chest mass and put the shoulder bars on it.
 *
 * Separate from shade() because the body's markings are not the leg's. A tiger's
 * shoulder stripes are broad vertical bars — a hand wide, a hand apart — that
 * sweep backward as they come down over the point of the shoulder and stop dead
 * on the white of the brisket. The narrow tapering slashes limbGeo() draws are
 * the *leg's* markings and would read as scratches at this size.
 *
 * `s = z + 0.55 * |x|` is the sweep. Bars at constant z are vertical bars on the
 * animal's midline, and on the sides of a barrel that is what they stay — which
 * is wrong: they rake backward the further round the ribs they go, and the rake
 * is most of what makes a striped body read as a body rather than as a barrel
 * with hoops painted on it.
 */
function chestShade(geo: THREE.BufferGeometry, bars: number[]): THREE.BufferGeometry {
  const cTop = new THREE.Color(LIMB_TOP)
  const cUnder = new THREE.Color(LIMB_UNDER)
  const cBand = new THREE.Color(LIMB_BAND)
  const c = new THREE.Color()
  const p = geo.attributes.position as THREE.BufferAttribute
  const arr = new Float32Array(p.count * 3)
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i)
    const y = p.getY(i)
    const z = p.getZ(i)
    // Withers to brisket. The transition is hard: on a tiger the flank is tawny
    // almost all the way down and then turns white over about a hand, and a soft
    // gradient through the middle of the body is the moulded-plastic look
    // shade()'s comment warns about.
    //
    // It also rides higher at the front. The white on a tiger is not a waterline
    // — it climbs the brisket to between the elbows and then drops away along
    // the belly, and that rise is the single marking that reads as "chest"
    // rather than "underside of a barrel" from directly above.
    const y0 = -0.645 + 0.055 * (1 - smoothstep(z / 0.45))
    const up = smoothstep((y - y0) / 0.2)
    c.copy(cUnder).lerp(cTop, up)
    // Same trick as limbGeo: a coat that is one exact value everywhere reads as
    // paint whatever shape it is on.
    const mot = Math.sin(x * 37 + 0.7) * Math.sin(y * 43 + 2.2) * Math.sin(z * 31 + 4.4)
    c.offsetHSL(0, 0, mot * 0.045 * up)

    // The wobble is not decoration. A bar drawn at an exact constant s is a
    // machined hoop, and the eye picks that out as printed-on before it picks
    // out anything else about the animal.
    // 0.32, not the 0.55 this started at. The sweep is what stops the bars being
    // hoops, but at 0.55 the pair either side of the spine met in a chevron
    // pointing straight down the barrel and the back read as a chameleon's.
    const s = z + Math.abs(x) * 0.32 + Math.sin(y * 9 + x * 4) * 0.014
    // The dorsal line. A tiger seen from directly above — which is the whole of
    // what the player sees of its own body — has a dark stripe running the length
    // of the spine that every bar on the back runs into, and its absence is why
    // the first version of this read as a striped cushion.
    let dark = (1 - smoothstep((Math.abs(x) - 0.010) / 0.016)) * smoothstep((up - 0.75) / 0.2) * 0.8
    for (let k = 0; k < bars.length; k++) {
      const b = bars[k]!
      // Widest on the spine and tapering as they come down the ribs, which is
      // the shape of the real marking and also what keeps them from closing into
      // hoops round the belly. Varied per bar off the bar's own position: a set
      // of identical bars is as obviously drawn as a set of straight ones.
      const w = (0.024 + up * 0.018) * (0.75 + 0.55 * Math.abs(Math.sin(b * 12.9898)))
      // w is the bar's full width, so it reaches w/2 either side of the centre —
      // solid to half of that and ramping over the rest. Reading w as the
      // half-width, which is what this did, darkens 2w and at a bar spacing of
      // 0.16 the widest bars then met their neighbours: the back came out black
      // with tawny gaps between the stripes, which is a tiger inside out.
      //
      // Ramping across the whole width instead of the outer half is the other way
      // to get this wrong — it leaves a black core a centimetre wide inside eight
      // centimetres of gradient, and eight centimetres of gradient on a shoulder
      // is not a stripe, it is a dent.
      dark = Math.max(dark, 1 - smoothstep((Math.abs(s - b) - w * 0.35) / (w * 0.15)))
      // Every other bar forks, and only out on the flank. A tiger's bars split
      // and rejoin constantly; a set of clean parallel bands is a deckchair.
      if (k % 2 === 1) {
        const branch = Math.abs(s - (b + 0.036)) - w * 0.25
        dark = Math.max(dark, smoothstep((Math.abs(x) - 0.09) / 0.06) * (1 - smoothstep(branch / (w * 0.2))))
      }
    }
    // Bars carry onto the white at 40% rather than being cut off at the
    // countershading line. Suppressing them entirely — which is what
    // min(1, up * 1.5) did on its own — left the brisket a bare cream panel, and
    // the brisket is most of what is on screen at the pitch where the player is
    // looking at their own feet. A tiger's chest is not blank: the flank bars run
    // down over it and fade rather than stop, and the throat carries its own
    // short crossing ones.
    c.lerp(cBand, dark * (0.4 + 0.6 * Math.min(1, up * 1.5)))
    arr[i * 3] = c.r
    arr[i * 3 + 1] = c.g
    arr[i * 3 + 2] = c.b
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3))
  return geo
}

/**
 * Muscle masses laid over the forequarters, as centre / radius / height in
 * viewmodel metres. Each pushes the skin out along its own normal by a gaussian
 * in distance, which is a metaball in everything but name and — unlike welding
 * separate ellipsoids together — cannot produce a seam, because there is only
 * ever one surface.
 *
 * The two scapulae are the ones that have to be right. The humerus starts at
 * SHOULDER, x = 0.20 and y = -0.30, and the bare ribcage at that station is only
 * 0.17 across at that height; without these the arm leaves the body four
 * centimetres inside thin air, which is exactly the fault being fixed.
 */
const TORSO_LUMPS = [
  { x: 0.205, y: -0.355, z: 0.11, r: 0.24, a: 0.075 },
  { x: -0.205, y: -0.355, z: 0.11, r: 0.24, a: 0.075 },
  // Points of the shoulder, below and in front of the blades.
  { x: 0.155, y: -0.515, z: 0.06, r: 0.15, a: 0.030 },
  { x: -0.155, y: -0.515, z: 0.06, r: 0.15, a: 0.030 },
  // The keel of the brisket, between the elbows.
  { x: 0, y: -0.6, z: 0.18, r: 0.2, a: 0.026 },
  // Ribs, well back, mostly to stop the barrel being a surface of revolution.
  { x: 0.235, y: -0.44, z: 0.5, r: 0.24, a: 0.03 },
  { x: -0.235, y: -0.44, z: 0.5, r: 0.24, a: 0.03 },
]

/**
 * The forequarters, as one continuous skin.
 *
 * This was three merged ellipsoids — brisket, barrel, two scapulae — and it read
 * as three orange balloons in a bag. Two separate faults, both fatal. The merge
 * leaves every ellipsoid's surface intact inside the others, so the render shows
 * the intersection curves as hard creases where no crease belongs; and at 20x14
 * segments the vertex spacing is 8 cm, so the shoulder bars — 5 cm wide, and
 * carried in a vertex attribute like every other marking on this model — fell
 * between the rings and did not appear at all. The chest came out bald.
 *
 * So: a swept surface instead, 150 rings by 44, which is 8 mm along the body and
 * puts six rings across a bar. The profile is an ellipse per station whose width,
 * depth and centre vary along z — narrow high brisket at the front, opening into
 * a deep barrel behind the camera, with a swelling over the shoulder — and the
 * masses in TORSO_LUMPS are then pushed out through it.
 *
 * Normals are computed from the parametric grid rather than by
 * computeVertexNormals, and that is not fussiness. The seam column is duplicated
 * so the fur UVs can wrap, and averaging face normals gives each copy only the
 * faces on its own side, which draws a lit hairline straight down the front of
 * the chest. Differencing across the grid with a wrap in the ring index gives
 * both copies the same answer and there is no seam to see.
 */
function torsoGeo(rings = 150, radial = 44): THREE.BufferGeometry {
  // Front cap a little below the eye, back cap behind it. Both are outside the
  // frustum at every pitch the player can reach; they exist so the body is
  // closed, not to be looked at.
  const Z0 = -0.05
  const Z1 = 1.05
  const stride = radial + 1
  const nv = (rings + 1) * stride
  const pos = new Float32Array(nv * 3)
  const nrm = new Float32Array(nv * 3)
  const uv = new Float32Array(nv * 2)

  for (let i = 0; i <= rings; i++) {
    const t = i / rings
    const z = Z0 + (Z1 - Z0) * t
    // A semicircular envelope closes both ends smoothly. The 0.55 power fattens
    // the middle back out again — a plain ellipsoid taper puts the widest part
    // of the animal halfway down its own length, and a tiger's is at the ribs.
    const f = Math.pow(Math.max(0, 1 - (2 * t - 1) ** 2), 0.5 * 0.55)
    const sh = Math.exp(-(((z - 0.12) / 0.2) ** 2))
    const hx = f * (0.19 + 0.068 * smoothstep((z - 0.14) / 0.36) + 0.055 * sh)
    // The withers used to be four centimetres higher, and four centimetres of
    // back was enough to hide a swinging foreleg completely: at a sprint both
    // feet come up behind the shoulder, and what the player saw was a paw
    // apparently resting on top of the animal's back with no leg under it. The
    // body has to sit low enough that the legs pass in front of its skyline.
    const hy = f * (0.175 + 0.062 * smoothstep((z - 0.18) / 0.42) + 0.05 * sh)
    const cy = -0.47 + 0.02 * smoothstep((z - 0.25) / 0.55)
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2
      const sx = Math.sin(a)
      const sy = Math.cos(a)
      const o = (i * stride + j) * 3
      pos[o] = sx * hx
      // Flatter underneath than over the spine, because a chest is.
      pos[o + 1] = cy + sy * hy * (sy > 0 ? 1 : 0.9)
      pos[o + 2] = z
      const u = (i * stride + j) * 2
      // Three wraps of the fur canvas round the body and 2.4 per metre along it,
      // which is the density limbGeo uses so the grain matches at the shoulder.
      uv[u] = (j / radial) * 3
      uv[u + 1] = z * 2.4
    }
  }

  const A = new THREE.Vector3()
  const B = new THREE.Vector3()
  const P = new THREE.Vector3()
  const at = (i: number, j: number, out: THREE.Vector3) => {
    const o = (i * stride + (((j % radial) + radial) % radial)) * 3
    return out.set(pos[o]!, pos[o + 1]!, pos[o + 2]!)
  }
  const reNormal = () => {
    for (let i = 0; i <= rings; i++) {
      for (let j = 0; j <= radial; j++) {
        at(Math.min(rings, i + 1), j, A).sub(at(Math.max(0, i - 1), j, P))
        at(i, j + 1, B).sub(at(i, j - 1, P))
        P.copy(A).cross(B)
        // Both caps collapse to a point, where there is no ring to difference.
        if (P.lengthSq() < 1e-12) P.set(0, 0, i === 0 ? -1 : 1)
        P.normalize()
        const o = (i * stride + j) * 3
        nrm[o] = P.x
        nrm[o + 1] = P.y
        nrm[o + 2] = P.z
      }
    }
  }
  const displace = (amount: (x: number, y: number, z: number) => number) => {
    for (let v = 0; v < nv; v++) {
      const o = v * 3
      const d = amount(pos[o]!, pos[o + 1]!, pos[o + 2]!)
      pos[o] += nrm[o]! * d
      pos[o + 1] += nrm[o + 1]! * d
      pos[o + 2] += nrm[o + 2]! * d
    }
  }

  reNormal()
  displace((x, y, z) => {
    let d = 0
    for (const l of TORSO_LUMPS) {
      const dx = x - l.x
      const dy = y - l.y
      const dz = z - l.z
      d += l.a * Math.exp(-(dx * dx + dy * dy + dz * dz) / (l.r * l.r))
    }
    return d
  })
  reNormal()
  // The same two octaves ruffle() uses — inlined because ruffle() would recompute
  // normals the averaging way and reopen the seam this function exists to close.
  displace((x, y, z) => {
    const a = Math.sin(x * 47 + 0.6) * Math.sin(y * 61 + 1.7) * Math.sin(z * 53 + 3.7)
    const b = Math.sin(x * 113 + 2.2) * Math.sin(y * 131 + 1) * Math.sin(z * 97 + 5.5)
    return 0.011 * (a + b * 0.45)
  })
  reNormal()

  const idx = new Uint32Array(rings * radial * 6)
  let n = 0
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * stride + j
      idx[n++] = a
      idx[n++] = a + stride
      idx[n++] = a + 1
      idx[n++] = a + 1
      idx[n++] = a + stride
      idx[n++] = a + stride + 1
    }
  }

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.setIndex(new THREE.BufferAttribute(idx, 1))
  return g
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
 * One marking on a limb segment. A *slash across* the upper face, not a band
 * around it — and that distinction is the whole of why the forelegs used to read
 * as two tails hanging in front of the camera.
 *
 * A tiger's tail is ringed: evenly spaced bands that close all the way round it.
 * Its legs are not. The leg markings are sparse, irregular, crowded toward the
 * elbow, and each one is a stroke that starts on the outer face, runs up over the
 * top and dies before it reaches the inner one. The old code drew a stripe as a
 * function of position along the limb alone, offset a little by a cosine of the
 * azimuth — which is exactly the definition of a leaning ring, and paired with a
 * tube tapering to a blunt tip it gave the player two tails.
 *
 * So a stripe now owns an arc as well as a position, and gets points on both ends
 * of it. `az` is measured off the dorsal midline — the face that is actually
 * pointed at the camera, see the note on `up` in limbGeo — and mirrored per side,
 * so a positive value leans a stripe toward the outside of the animal.
 */
interface Stripe {
  /** Position along the segment, 0 at the top. */
  v: number
  /** Half-width along the segment, at the near end of the arc. */
  w: number
  /** Centre of the arc, radians off the dorsal midline, positive outward. */
  az: number
  /** Half-extent of the arc, radians. Past ~1.3 it starts to close into a ring. */
  arc: number
  /** How far the stripe slides along the limb over its own arc — the lean. */
  lean: number
  /** How much narrower the far end is than the near one, 0..1. */
  taper: number
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
 * `bands` are Stripes, whose `v` and `w` are in fractions of this segment — so
 * they have to be scaled per segment, because the humerus and the forearm are
 * different lengths and a stripe is a fixed number of centimetres on the animal
 * either way. `radiusAt` is given the same 0..1 coordinate, which is what lets
 * the upper arm be a spindle — see the profiles in buildViewmodel().
 *
 * `rings` is the one number here with a hard floor under it, and it has been
 * under that floor twice. A marking is drawn into a vertex attribute, so a stripe
 * narrower than the gap between two rings simply falls between them and does not
 * exist. At 72 rings the spacing is 0.014 of the segment, and a 2 cm stripe on a
 * 50 cm forearm is 0.04 wide — under three rings, with the tapered end of it
 * under one. That is why the second attempt at these came out as a leg with two
 * faint smudges on it when the arithmetic said full black.
 *
 * 180 puts eight rings across the widest stripe and three across the narrowest
 * tail of one, which is enough for an edge that reads as an edge. It costs about
 * 6 000 triangles a segment, paid once at build time, on a model that is the
 * closest thing to the camera in the game.
 */
function limbGeo(
  side: -1 | 1,
  radiusAt: (v: number) => number,
  bands: Stripe[],
  rings = 180,
  radial = 16,
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
      // Mottle. Real fur is never one flat tone — it is a mix of hairs banded at
      // different heights, and at a metre away what that reads as is a coat that
      // varies by a few percent over a hand's breadth. Without it the tawny is a
      // single value across the whole limb and the tube reads as painted plastic
      // no matter how good its silhouette is.
      const mot = Math.sin(v * 21 + side * 2.1) * Math.sin(a * 3 + v * 13) * 0.5
        + Math.sin(v * 47 + 1.3) * Math.sin(a * 7 - v * 29) * 0.25
      c.offsetHSL(0, 0, mot * 0.035 * up)

      // The markings. Each is a slash across the upper face with its own arc and
      // its own lean, tapering to a point at both ends — see Stripe. A stripe
      // that closes round the limb is a tail ring, and two ringed tubes is what
      // this used to be.
      let dark = 0
      for (const s of bands) {
        // Signed angle from this stripe's own azimuth, wrapped to -pi..pi so a
        // stripe sitting near the seam does not tear in half.
        const d0 = a - (-Math.PI / 2 + side * s.az)
        const d = Math.atan2(Math.sin(d0), Math.cos(d0))
        const k = d / s.arc
        if (k <= -1 || k >= 1) continue
        // Ends fade rather than stopping square, so the stripe has points on it
        // the way a real marking does instead of ending in two blunt corners.
        const ends = 1 - smoothstep((Math.abs(k) - 0.5) / 0.5)
        const centre = s.v + s.lean * k
        const w = s.w * (1 - s.taper * (k * 0.5 + 0.5))
        dark = Math.max(dark, ends * (1 - smoothstep(Math.abs(v - centre) / w)))
      }
      // Against the countershading as well, so whatever the arc leaves on the
      // flank still dies out before it reaches the pale underside — which is
      // where a marking stops on the animal. Scaled up first, though: `up` is
      // already down to a half a third of the way round the tube, and multiplying
      // straight by it left the stripes so faint on the visible face that the leg
      // came out plain.
      c.lerp(band, dark * Math.min(1, up * 1.6))
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
 * Down again from 0x8e5620, which was still coming out of the tone mapper as a
 * clean pumpkin. Direct sun in this game runs at intensity 3 and ACES lifts the
 * midtones hard, so an albedo that looks correct in a swatch renders a full stop
 * brighter and a good deal more saturated than the animal. This is a rust with
 * brown in it, and the mottle in limbGeo breaks it up further — a coat that is
 * one exact value everywhere is the tell of a painted model no matter what
 * shape it is on.
 *
 * The band is near black because it is. Tiger stripes are not brown.
 */
const LIMB_TOP = 0x7c4a20
const LIMB_UNDER = 0xa8977c
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
// Down from 0xd9cbb4, which under a direct sun at intensity 3 came back out of
// ACES as flat white — five specular white slivers per foot, brighter than
// anything else in the frame and the loudest thing on the whole viewmodel.
const CLAW_CLEAN = 0xb5a58c
const CLAW_ROUGH = 0.26
const lunge = new THREE.Vector3()
/** Axis a fresh limb segment runs along once its top is put at the origin. */
const DOWN = new THREE.Vector3(0, -1, 0)
/**
 * Length of the humerus, shoulder to elbow. Fixed, which is the point: this is a
 * *bone* rather than a fraction of however far away the foot happens to be. See
 * updateArms().
 *
 * It was 0.31 against a forearm that solved out at about 0.72, and that 1:2.3
 * split is why there was no elbow to see. On a tiger the humerus and the radius
 * are within a centimetre of each other — call it 1:1 — so at 0.31 the joint sat
 * a third of the way down a limb whose top third is inside the animal's chest and
 * below the bottom of the frame at every pitch. What the player got was one
 * unbroken tapering tube from the corner of the screen to the foot: a tail.
 *
 * At 0.44 against a forearm of about 0.55 the split is 1:1.25, and the elbow
 * lands out in the open where the bend can be seen. That is the single change
 * that makes the thing read as a leg, because the eye does not measure how long a
 * limb is in first person — it only checks whether it bends.
 */
const UPPER_LEN = 0.44
/**
 * Which way the elbow is pushed off the straight shoulder-to-wrist line.
 *
 * A cat's elbow points backward and tucks in against the ribs, so this is mostly
 * +z (behind, in viewmodel space) with a little outward lean that gets mirrored
 * per side. Without it the two-bone solve is ambiguous and the joint pops to
 * whichever side the arithmetic drifts to; with it the leg always folds the way a
 * leg folds, and the elbow is the part of the limb the player sees most of.
 *
 * Lengthened along with the humerus. The pole is added to a *unit* wrist
 * direction, so its magnitude is what sets the angle between the two bones: at
 * 0.39 the old one bent the limb 21 degrees, which over a 31 cm humerus bowed the
 * leg 11 cm off straight — less than the width of the limb itself, so it was
 * invisible. This is 0.62, which is a 32-degree bend and a 23 cm offset on a
 * bone half again as long.
 */
const ELBOW_POLE = { x: 0.17, y: -0.30, z: 0.52 }
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
  /** Breathing clock for the chest, in radians. See updateChest(). */
  private breath = 0
  /** 0 on the ground, 1 in the air. Tucks the forelegs into a reach mid-pounce. */
  private airBlend = 0
  /** Seconds off the ground. Gates airBlend, so a lip in the dirt is not a leap. */
  private airTime = 0
  /**
   * Where each foot's stride clock was last frame, so a plant is the wrap the
   * clock actually makes rather than a beat counted off the left foot. -1 while
   * not striding.
   */
  private prevFootL = -1
  private prevFootR = -1
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
  /**
   * Multiplier on the braking force, 1 except in the moments after a landing.
   * See TIGER.landGrip: it is what makes a pounce plant instead of skate, and it
   * is a multiplier rather than a velocity subtraction so the camera never steps.
   */
  private gripBoost = 1
  private camShake = 0
  private shakeTime = 0
  private recoilY = 0
  /**
   * The roar, 0..1 and parked at 1. A player action deserves a body: without
   * this the roar was a sound effect over a perfectly still animal. The head
   * tips back and the chest swells, both on the one quartic hump every other
   * transient here uses, so it starts and ends at rest.
   */
  private roarT = 1
  /**
   * The collapse, 0 alive and rising to 1 dead. Damped rather than switched so
   * the eye goes down like a body folding, not like a camera cut; see
   * updateBound and updateCamera.
   */
  private deathFall = 0
  /** Counts down while a connecting blow holds the swipe still. */
  private hitStop = 0
  /** Kick along the look axis on contact — the arm stopping against a body. */
  private impact = 0
  /** Degrees of momentary FOV pull-in; set on a kill, decays on its own. */
  fovKick = 0
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
  /** Brisket, barrel and both scapulae, merged. See buildViewmodel(). */
  private chest!: THREE.Mesh
  /** The five hooks on each foot, in build order, for sheathing. See setClaws(). */
  private clawsL: THREE.Group[] = []
  private clawsR: THREE.Group[] = []
  /** How far the claws are out of their sheaths, 0..1, damped per foot. */
  private clawOutL = PAW.clawIdle
  private clawOutR = PAW.clawIdle
  private pawState: PawState = 'idle'
  private pawT = 0
  private nextPawIsLeft = true
  /** An attack clicked while another was still playing; fired when it ends. */
  private queuedAttack: AttackKind | null = null
  private eyeY = TIGER.eyeHeight
  private clawMat!: THREE.MeshStandardMaterial

  /** Populated during update(); the game reads and clears these. */
  pendingAttack: AttackEvent | null = null
  footstepEvent = false
  landedEvent = false
  /** Downward speed the frame `landedEvent` fired, in m/s. Scales the landing. */
  landImpact = 0
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
    // The toes get the leg's ochre too. They used to be 0x8a5626, a shade lighter
    // on the theory that a knuckle catches more light — which it does, and the
    // geometry was already doing it. Painting the lift in on top of it as well
    // made the front of the foot the brightest thing in the frame, and four bright
    // knobs on the end of a dark leg is the mitten read the whole paw is fighting.
    const TOE_TOP = LIMB_TOP
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
      //
      // Shorter front-to-back than it was and wider across. The old foot was
      // 20 cm wide and 26 cm long, which is the proportion of a hand; a cat's
      // forepaw is as wide as it is long, and the roundness is a good part of what
      // the eye is reading when it decides whether it is looking at a paw.
      fur.push(shade(ruffle(ellipsoid(0.084, 0.068, 0.058, 16, 12)
        .translate(0, -0.006, 0.030), 0.004), FUR_TOP, FUR_UNDER, -0.055, 0.005))

      // Metacarpus. Stops at z = -0.078 so the toes are what the front of the
      // foot is made of, and 19.6 cm across — wider than the 14.6 cm forearm
      // above it, which is the flare that says "foot" before any detail on it
      // gets a chance to.
      fur.push(shade(ruffle(ellipsoid(0.098, 0.052, 0.062, 18, 12)
        .translate(0, -0.048, -0.016), 0.005), FUR_TOP, FUR_UNDER, -0.090, -0.015))

      // The last stripe. A tiger's leg bands stop at the carpus; painting one
      // narrow band across the back of the foot is what ties the plain paw to the
      // striped foreleg above it, and it is the only marking on the foot itself.
      fur.push(tint(ruffle(ellipsoid(0.086, 0.060, 0.015, 14, 8)
        .translate(0, -0.018, 0.034), 0.003), BAND))

      for (let i = 0; i < Tiger.TOES; i++) {
        // -1.5, -0.5, 0.5, 1.5 — an even spread with no toe on the centre line.
        const k = i - (Tiger.TOES - 1) / 2
        const t = k / 1.5
        // The middle pair lead. The outer pair sit back and turn out, which is
        // the shape of a cat's foot from above and the reason a real paw reads as
        // an arc of four rather than as a row.
        const back = t * t * 0.018
        // Short, fat and packed. The old toe was 5.4 cm across and 9.2 cm long —
        // a finger, and four of them splayed on the front of the foot is a hand.
        // A cat's toe is 6 cm across and 7.6 long, wider than it is deep, and at
        // 5.2 cm apart they overlap each other by nearly a centimetre: the clefts
        // between them are creases, not gaps.
        const tx = side * k * 0.049
        const tz = -0.094 + back
        const toe = ellipsoid(0.034, 0.025, 0.038, 12, 9)
        // Turned out, and the outer toes rolled over onto their sides a little.
        toe.rotateY(-side * t * 0.26)
        toe.rotateX(0.10)
        toe.translate(tx, -0.058, tz)
        fur.push(shade(ruffle(toe, 0.0035), TOE_TOP, FUR_UNDER, -0.088, -0.042))

        // The cleft. Three of them, between the four toes, sunk just under the
        // fur so what shows is a dark line rather than a shape — which is all a
        // gap between two toes ever is at this distance, and it is what stops the
        // four of them merging into one lump under a flat overhead sun.
        if (i < Tiger.TOES - 1) {
          const cleft = ellipsoid(0.006, 0.021, 0.034, 6, 6)
          cleft.translate(side * (k + 0.5) * 0.049, -0.050, tz - 0.004)
          fur.push(tint(cleft, CLEFT))
        }

        // Digital pad, under its own toe and a few millimetres proud of the fur,
        // so the foot is standing on its pads and not on its hair.
        const pad = ellipsoid(0.026, 0.014, 0.026, 8, 6)
        pad.translate(tx, -0.092, tz + 0.004)
        fur.push(tint(pad, PAD))

        // Claw, at the toe tip and angled down and out along the toe it belongs to.
        addClaw(0.060, 0.0115, 0.62, tx, -0.054, tz - 0.032, 0.16, -side * t * 0.26, side * t * 0.20)
      }

      // Metacarpal pad: one broad central lobe with two smaller ones, which is
      // the trilobed shape a cat leaves in mud.
      fur.push(tint(ellipsoid(0.062, 0.015, 0.038, 10, 6).translate(0, -0.090, -0.036), PAD))
      fur.push(tint(ellipsoid(0.028, 0.013, 0.026, 8, 6).translate(-0.056, -0.087, -0.020), PAD))
      fur.push(tint(ellipsoid(0.028, 0.013, 0.026, 8, 6).translate(0.056, -0.087, -0.020), PAD))

      // Dewclaw, high on the inside of the wrist and off the ground. Nobody would
      // miss it, but it is the kind of thing that is only ever on the real animal
      // — and it is visible on the inner edge of the frame, which is where the eye
      // goes when the two paws are symmetrical about the reticle.
      addClaw(0.038, 0.0090, 0.7, -side * 0.080, -0.022, -0.008, -0.25, side * 0.75, -side * 0.5)

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
    // Stripe positions and widths are in fractions of each segment, so they have
    // to be set per segment: the humerus is 0.44 m and the forearm about 0.55,
    // and the same fraction in both would put finger-width stripes on one and
    // hand-width bands on the other.
    //
    // The humerus now necks in over its last quarter. That is the olecranon: the
    // triceps mass sits above the elbow and the joint itself is bone close under
    // the skin, so a foreleg is at its thickest a hand's breadth *above* the
    // bend. Without the neck the two segments met at their widest and the elbow
    // was the one place on the limb with no shape at all — which is most of why
    // the whole thing read as one continuous tube. It ends at 0.062, which is
    // exactly where the forearm below it starts, so there is no cuff.
    const arm = (side: -1 | 1) => new THREE.Mesh(
      limbGeo(side, (v) => 0.018 + 0.060 * smoothstep((v - 0.06) / 0.52)
        - 0.016 * smoothstep((v - 0.70) / 0.30),
      [
        { v: 0.46, w: 0.052, az: 0.15, arc: 1.15, lean: 0.10, taper: 0.45 },
        { v: 0.68, w: 0.040, az: -0.30, arc: 0.95, lean: -0.09, taper: 0.55 },
        { v: 0.86, w: 0.046, az: 0.34, arc: 1.05, lean: 0.11, taper: 0.40 },
      ]), pawMat)
    // The forearm is honest: a taper from the elbow to the wrist, with a belly of
    // flexor muscle in the top third and the bones close under the skin at the
    // carpus. Cats carry a lot of the foreleg's mass high, and a straight cone from
    // joint to joint is the silhouette of a table leg.
    //
    // The previous profile peaked at 172 mm across and ended at 66 mm. The first
    // of those is the number that mattered: at 172 mm the forearm was as wide as
    // the paw on the end of it, and the flare that makes a cat's foot read as a
    // foot cannot exist if the leg is already that thick. A tiger's forearm is
    // about 110 mm at the thickest and its forepaw is 170 mm across — the foot is
    // half again wider than the leg, and that ratio is doing more work than any
    // amount of detail on the foot itself.
    //
    // So this peaks at 146 mm (110 on the animal, at the viewmodel's scale) and
    // necks to 56 at the carpus. The loss goes in two places rather than evenly,
    // because that is where it goes on the animal: the shaft sheds its girth
    // through the middle third, and then the carpus necks in hard over the last
    // 20 cm.
    const fore = (side: -1 | 1) => new THREE.Mesh(
      limbGeo(side, (v) => {
        const shaft = 0.062 - 0.022 * smoothstep((v - 0.12) / 0.66)
        const belly = 0.011 * Math.sin(Math.PI * Math.min(1, v * 2.2))
        const wrist = 0.012 * smoothstep((v - 0.78) / 0.19)
        return shaft + belly - wrist
      },
      // Three markings, all of them in the top half. A tiger's foreleg stripes
      // crowd toward the elbow and the lower leg is plain but for the single band
      // across the carpus, which the paw draws itself. The previous set ran four
      // bands down to two thirds of the way to the wrist and closed each of them
      // round the tube, which is a tail.
      [
        { v: 0.10, w: 0.030, az: 0.12, arc: 1.30, lean: 0.060, taper: 0.40 },
        { v: 0.29, w: 0.021, az: -0.38, arc: 1.00, lean: -0.045, taper: 0.60 },
        { v: 0.47, w: 0.026, az: 0.30, arc: 1.15, lean: 0.050, taper: 0.50 },
        { v: 0.66, w: 0.017, az: -0.12, arc: 0.90, lean: -0.034, taper: 0.55 },
      ]), pawMat)
    this.armL = arm(-1)
    this.armR = arm(1)
    this.foreL = fore(-1)
    this.foreR = fore(1)
    this.shoulderL.add(this.armL, this.foreL)
    this.shoulderR.add(this.armR, this.foreR)

    this.vm.add(this.shoulderL, this.shoulderR)

    // --- the animal the legs belong to.
    //
    // Without this the forelegs enter the frame out of two points in mid-air at
    // the bottom corners, and no amount of work on the legs themselves fixes
    // that: a limb is only read as attached if you can see the thing it is
    // attached to. It is the other half of "floating", and the cheaper half —
    // the contact shadow says the foot is on the ground, the chest says the leg
    // is on an animal.
    //
    // Sizes are the animal's. The brisket sits 0.51 m off the ground and the
    // withers 0.93, against an eye at 1.10, which is where those numbers put
    // them on a Bengal tiger; the chest is 0.52 m across the shoulders. What
    // that works out to in the frame is nothing at all at level pitch — the top
    // of it is 0.21 m below the eye and level with it in z, so it is outside the
    // frustum until you look down about twenty degrees — and then it fills the
    // bottom of the frame between the legs, which is what a tiger sees.
    //
    // Bars a hand apart down the body, in the sweep coordinate chestShade()
    // uses. The front five land on the brisket and the shoulders, which is all
    // the player ever sees of it.
    //
    // Spacing is 8 cm and not the 16 cm this had. Sixteen put two bars in the
    // whole of the visible back, which at the distance this sits from the eye is
    // a tawny animal with a couple of dark bands on it rather than a striped one;
    // a Bengal's trunk carries a dozen. They are deliberately not evenly spaced —
    // an even set is a barcode.
    this.chest = new THREE.Mesh(
      // The first two are ahead of the front cap in z. They are not wasted: the
      // sweep adds 0.32 * |x|, so a bar at a negative station still crosses the
      // shoulder out on the flank, and without them the crest of the withers —
      // the first thing that comes into frame on the way down, and the only part
      // of the body visible at all between about -0.7 and -0.9 — was a bald
      // orange band a hand deep.
      chestShade(torsoGeo(), [
        -0.15, -0.075, 0.0, 0.085, 0.17, 0.245, 0.33, 0.415, 0.49, 0.58, 0.66, 0.745, 0.83, 0.915, 1.0,
      ]),
      pawMat,
    )
    this.vm.add(this.chest)

    // Viewmodel renders slightly in front of the world; keep it out of walls.
    // The contact shadow under each foot is not here — it lives in the ground's
    // own materials, see updateContact() and world/contact.ts.
    this.vm.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.renderOrder = 10
        o.castShadow = false
        ;(o.material as THREE.Material).depthTest = true
      }
    })
    this.resetPaws()
  }

  /**
   * Breathe, and roll the chest onto whichever foreleg is carrying.
   *
   * A body that holds perfectly still while its own legs swing under it is worse
   * than no body at all — it reads as a prop the legs are passing in front of.
   * Both terms here are small on purpose: the camera already carries the walk's
   * bob and sway, and doubling that up on the chest makes the animal look like
   * it is coming apart.
   *
   * The roll is at the stride frequency and the sink is at twice it, because a
   * quadruped's chest drops onto each forefoot in turn: one roll per stride, two
   * dips. Getting those two the same way round is the difference between a walk
   * and a limp.
   */
  private updateChest(dt: number) {
    this.breath = (this.breath + dt * (0.9 + this.gaitAmp * 1.6)) % (Math.PI * 2)
    const w = this.gaitPhase * Math.PI
    const amp = this.gaitAmp
    // Which forefoot is down. pairPhase is the offset between them, so this is
    // the same clock place() reads and the chest cannot drift out of step.
    const carry = Math.sin(w * 2 - this.pairPhase * Math.PI * 2)
    this.chest.position.y = Math.sin(this.breath) * 0.006 - Math.abs(Math.sin(w * 2)) * 0.022 * amp
    this.chest.position.z = Math.sin(w * 2) * 0.010 * amp
    this.chest.rotation.z = carry * 0.055 * amp
    this.chest.rotation.x = Math.sin(w * 2 + 0.9) * 0.030 * amp
    // Ribs. Barely visible, and that is the point — a chest that does not move at
    // all while you stand still is the one thing here the eye checks for.
    // The roar fills them: the same hump the camera pitch rides, so the swell
    // and the thrown-back head are one motion.
    const rh = this.roarT * (1 - this.roarT)
    const b = 1 + Math.sin(this.breath) * 0.012 * (1 - amp * 0.6) + 16 * rh * rh * 0.04
    this.chest.scale.set(b, b, 1)
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

  /** Throw the head back and swell the chest. The game decides when; see game.ts. */
  roar() {
    this.roarT = 0
    // A breath of tremor, through the same layered-sine shake a hit uses.
    this.shake(0.22)
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
    this.fovKick = damp(this.fovKick, 0, 8, dt)
    this.roarT = Math.min(1, this.roarT + dt / 0.7)
    // Rate 5, not the eye spring's 12: a body folds over about half a second.
    this.deathFall = damp(this.deathFall, this.health <= 0 ? 1 : 0, 5, dt)

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

    // The landing's grip on the ground, relaxing back to ordinary braking.
    this.gripBoost = 1 + (this.gripBoost - 1) * Math.exp(-dt / TIGER.landGripFall)

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
    const ex = wantX - this.vel.x
    const ez = wantZ - this.vel.z
    const err = Math.hypot(ex, ez)
    if (err > 1e-6) {
      // Braking is not "no key held" — it is the error pointing back against the
      // way the tiger is already travelling. Choosing the cap off the key meant a
      // pounce landing, which arrives at twice a sprint with the stick still
      // pushed forward, shed its surplus at the *acceleration* force: the softest
      // number here, applied to the fastest the tiger ever goes.
      const braking = ex * this.vel.x + ez * this.vel.z < 0
      const cap = (braking ? TIGER.brakeForce * this.gripBoost : TIGER.accelForce)
        * (this.grounded ? 1 : TIGER.airControl)
      const knee = braking ? TIGER.brakeKnee : TIGER.accelKnee
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
        // Downward speed at contact, so the landing can be *heard* as hard or
        // soft rather than being one fixed sample every time.
        this.landImpact = Math.abs(this.vel.y)
        // Forelegs planting. Scaled by how hard the landing was, so that a lip
        // in the terrain the tiger was barely airborne over does not grab the
        // ground like a pounce touching down.
        this.gripBoost = 1 + (TIGER.landGrip - 1) * Math.min(1, Math.abs(this.vel.y) / 8)
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

    // Footsteps fire on the plant — per foot, off each foot's own clock. A foot
    // plants when its stride clock wraps (stride() puts the plant at c = 0), so
    // this watches both clocks for the wrap rather than counting half-phase
    // beats off the left foot alone. The beat counter was only right at
    // pairPhase 0.5: in the bound, with the right foot 0.16 behind instead of
    // half a stride, the second beat of every pair fired while both feet were
    // in the air. The half-stride guard is what makes a wrap a wrap — pairPhase
    // easing during the swing can move the right clock a few hundredths either
    // way, and that must not read as a footfall.
    const striding = this.grounded && this.gaitAmp > 0.25
    const cL = this.gaitPhase - Math.floor(this.gaitPhase)
    const rp = this.gaitPhase + this.pairPhase
    const cR = rp - Math.floor(rp)
    if (striding) {
      if (this.prevFootL >= 0 && cL < this.prevFootL - 0.5) this.footstepEvent = true
      if (this.prevFootR >= 0 && cR < this.prevFootR - 0.5) this.footstepEvent = true
      this.prevFootL = cL
      this.prevFootR = cR
    } else {
      this.prevFootL = this.prevFootR = -1
    }
  }

  private updateActions(input: Input) {
    // Queued rather than started, because a swing can only begin from the gait:
    // every wind-up blends out of gaitPose, so an attack started while another
    // was still playing teleported the paws from wherever that animation had
    // them — a claw clicked mid-bite snapped both feet from the clamp at
    // head height back onto the ground in one frame. The click is never
    // dropped; it waits out the rest of the current swing, which is at most
    // 0.42 s and usually far less.
    if (input.clickedPrimary() && this.canClaw) this.queuedAttack = 'claw'
    else if (input.clickedSecondary() && this.canBite) this.queuedAttack = 'bite'
    if (this.queuedAttack !== null && this.pawState === 'idle') {
      // The cooldown that admitted the click can only have run down since.
      this.startAttack(this.queuedAttack)
      this.queuedAttack = null
    }
  }

  private updateViewmodel(dt: number) {
    // Take the camera's pitch back out, so the forelegs stay level with the world
    // and the feet stay on the ground when you raise or drop your head. Without
    // this the whole rig is pinned to the frame and the paws swing up into the
    // sky the moment you look up — which is what "on the ground" costs.
    this.vm.rotation.x = -this.pitch * PAW.pitchFollow
    this.updateClaws(dt)
    this.updateChest(dt)

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
        // Carry-through, as an ease-out rather than a smoothstep. The drive is
        // built to arrive at the contact at its fastest, and a smoothstep here
        // starts from rest — so on a whiff, with no hit-stop to hide it, the
        // paw stopped dead in mid-air at full extension, which reads as
        // striking something that is not there. `1 - (1-u)^2` leaves the
        // contact with a normalized slope of 2, the same slope u^2 arrives
        // with, and still comes to rest at the end where the hand-back to the
        // gait starts at rest.
        const u = (t - 0.52) / 0.22
        const e = 1 - (1 - u) * (1 - u)
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
    this.updateContact()
  }

  /**
   * Tell the ground where the feet are, and how hard they are pressing on it.
   *
   * The darkening itself is the ground's job — terrain and grass shade
   * themselves from these two points, see world/contact.ts. Both halves of the
   * cue matter. A shadow that appears under a planted foot is what says the foot
   * is on the dirt; a shadow that then *stays* while the foot swings forward
   * would say the opposite about every other frame of a stride. So it tracks the
   * foot horizontally, sits on the ground vertically, and trades size for density
   * with height exactly the way a real contact shadow does.
   */
  private updateContact() {
    // Viewmodel space is level and forward is -z, so a paw's offset maps into
    // the world through the same basis slopeAt() uses.
    const sy = Math.sin(this.yaw)
    const cy = Math.cos(this.yaw)
    for (const [paw, i, side] of [
      [this.pawL, 0, -1],
      [this.pawR, 1, 1],
    ] as const) {
      const slope = this.slopeAt(side)
      const ground = -this.eyeAbove + slope
      // Back out of shoulder space; see place().
      const px = side * SHOULDER.x + paw.position.x
      const pz = SHOULDER.z + paw.position.z
      const h = Math.max(0, SHOULDER.y + paw.position.y - ground - PAW.sole)
      // Gone by a third of a metre up, which is well above the gait's peak lift
      // but not so high that a pounce leaves a blot hanging under the animal.
      const near = Math.max(0, 1 - h / 0.34)
      // Wider and weaker as the foot climbs, the way a real contact shadow
      // trades size for density with the height of the thing casting it.
      setContact(
        i,
        this.pos.x + cy * px + sy * pz,
        this.eyeGround + slope,
        this.pos.z - sy * px + cy * pz,
        near * near * 0.88,
        0.34 + h * 0.5,
        0.5 + h * 0.5,
      )
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
      // The z travel has to be most of the claw's own length or "sheathed" still
      // leaves half of it in the air. 0.030 against a 0.060 claw did exactly that.
      claw.position.y = rest.y + hide * 0.013
      claw.position.z = rest.z + hide * 0.046
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
    // Dying folds the legs: the eye sinks toward shoulder-on-the-dirt height.
    // deathFall is damped, so this is a slump, not a cut.
    const fallen = this.deathFall * (this.eyeY - 0.22)
    this.eyeAbove = this.eyeY + this.bobY + this.recoilY - this.dip - fallen
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
    // The roar: chin thrown up over the hump of the call, at rest at both ends.
    const rh = this.roarT * (1 - this.roarT)
    const roarPitch = 16 * rh * rh * 0.11
    this.camera.rotation.set(
      this.pitch + bobPitch + shakeY * 0.4 - this.impact * 2.2 + roarPitch
        - this.deathFall * 0.18,
      this.yaw,
      bobX * 0.08 + bobRoll + shakeR + this.deathFall * 0.55,
      'YXZ',
    )

    // FOV punches out when you're moving fast or frenzied.
    let fov = CAMERA.fov
    if (this.frenzy > 0) fov = CAMERA.frenzyFov
    else if (this.sprinting) fov = CAMERA.sprintFov
    fov -= this.fovKick
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
    this.fovKick = 0
    this.clawBlood = 0
    this.clawMat.color.setHex(CLAW_CLEAN)
    this.clawMat.roughness = CLAW_ROUGH
    this.pawState = 'idle'
    this.queuedAttack = null
    this.roarT = 1
    this.deathFall = 0
    this.gaitPhase = 0
    this.gaitAmp = 0
    this.gaitDuty = DUTY_MAX
    this.pairPhase = 0.5
    this.grounded = true
    this.pouncing = false
    this.airTime = 0
    this.airBlend = 0
    this.gripBoost = 1
    this.prevFootL = this.prevFootR = -1
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
