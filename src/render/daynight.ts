/**
 * The clock behind the sky.
 *
 * One object owns the time of day and hands out a single interpolated palette
 * per frame; Sky, the fog uniforms and the tone mapper all read from it. Keeping
 * it separate from Sky is what stops the cycle from turning into nine different
 * lerps scattered across the renderer.
 *
 * Two things make a moving sun cheap enough to run every frame:
 *
 *   - the key light is *one* DirectionalLight for the whole cycle. At night it
 *     swings to the anti-solar point and turns cold, so the moon is the same
 *     light and the scene's light count never changes — a light appearing or
 *     disappearing would recompile every material in the world; and
 *   - the environment map is only re-baked when the sun has actually moved a
 *     few degrees, not on every frame.
 */
import * as THREE from 'three'
import { DAY, type DayPhase } from '../config'

/** The palette, resolved for one instant. Colours are live objects, reused. */
export interface SkyState {
  turbidity: number
  rayleigh: number
  mie: number
  dome: number
  sunI: number
  bounceI: number
  env: number
  density: number
  stars: number
  exposure: number
  /** Clock rate divisor at this point in the cycle. See DAY.phases. */
  dwell: number
  sun: THREE.Color
  skyB: THREE.Color
  gndB: THREE.Color
  fogSun: THREE.Color
  fogAway: THREE.Color
  /** Degrees above the horizon; negative at night. */
  elevation: number
  /** True while the moon, not the sun, is the key light. */
  night: boolean
}

const NUMERIC = ['turbidity', 'rayleigh', 'mie', 'dome', 'sunI', 'bounceI', 'env', 'density', 'stars', 'exposure', 'dwell'] as const
const COLOURS = ['sun', 'skyB', 'gndB', 'fogSun', 'fogAway'] as const

export class DayNight {
  /** Position in the cycle, 0..1. */
  t = DAY.start
  /** Seconds per full rotation. Waves can stretch or compress this. */
  period = DAY.period

  /** Direction to the true sun, wherever it is. Drives the sky dome. */
  readonly sunDir = new THREE.Vector3()
  /** Direction to whichever body is currently lighting the scene. */
  readonly keyDir = new THREE.Vector3()

  readonly state: SkyState = {
    turbidity: 0, rayleigh: 0, mie: 0, dome: 0, sunI: 0, bounceI: 0,
    env: 0, density: 0, stars: 0, exposure: 1, dwell: 1,
    sun: new THREE.Color(), skyB: new THREE.Color(), gndB: new THREE.Color(),
    fogSun: new THREE.Color(), fogAway: new THREE.Color(),
    elevation: 0, night: false,
  }

  constructor() {
    this.evaluate()
  }

  /**
   * Step the clock. The rate is divided by `dwell`, so the cycle crawls through
   * the golden hour and hurries through the small hours — see DAY.phases for
   * why a uniform clock cannot give a playable night.
   *
   * `dwell` is read from the state the last evaluate() left behind rather than
   * re-derived here. It is a slow, smooth curve and dt is a frame, so the lag is
   * far below anything visible, and it keeps the clock a single line.
   */
  advance(dt: number) {
    this.t = (this.t + dt / (this.period * Math.max(0.05, this.state.dwell))) % 1
    this.evaluate()
  }

  /** Jump straight to a point in the cycle — used by the wave script. */
  setPhase(t: number) {
    this.t = ((t % 1) + 1) % 1
    this.evaluate()
  }

  /** Resolve the palette and both directions for the current `t`. */
  private evaluate() {
    const t = this.t
    const p = DAY.phases
    // Find the bracketing pair, wrapping the last back to the first.
    let i = p.length - 1
    for (let k = 0; k < p.length; k++) if (p[k]!.t <= t) i = k
    const a = p[i]!
    const b = p[(i + 1) % p.length]!
    const span = (b.t - a.t + 1) % 1 || 1
    const f = smootherstep(((t - a.t + 1) % 1) / span)

    const s = this.state
    for (const key of NUMERIC) s[key] = a[key] + (b[key] - a[key]) * f
    // setHex already lands in the renderer's working space (linear), so no
    // manual convertSRGBToLinear here — doing it twice halves every colour and
    // is exactly why the night used to render black. Lerping in linear also
    // keeps a warm sun from passing through grey on its way to a cold moon.
    for (const key of COLOURS) {
      s[key].setHex(a[key])
      s[key].lerp(tmp.setHex(b[key]), f)
    }

    const elev = DAY.maxElevation * Math.sin(t * Math.PI * 2)
    s.elevation = elev
    s.night = elev < DAY.moonHandoff

    // Azimuth sweeps a full turn over the rotation, so the half of it the sun
    // is up covers the 180 degrees from sunrise to sunset: east at t = 0, over
    // the village at noon, west as it goes down.
    //
    // Anchored on the rotation, not on `DAY.start`. Tying it to the start meant
    // the sun was always due south at whatever moment the hunt happened to open
    // — so a different start time silently rotated sunrise into the west, and
    // the arc no longer agreed with the elevation curve underneath it.
    const theta = THREE.MathUtils.degToRad(DAY.noonAzimuth - 90 + t * 360)
    this.sunDir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - elev), theta)
    // The moon is simply the anti-solar point, so the handover happens while
    // both bodies are on the horizon and the key light is near zero anyway.
    if (s.night) this.keyDir.copy(this.sunDir).negate()
    else this.keyDir.copy(this.sunDir)
  }

  /**
   * Where the dome's sun goes: held near the horizon so Preetham stays sane.
   *
   * This is a lie about position and it has to stay one — see
   * DAY.domeMinElevation. What it must not also decide is whether a sun is
   * *drawn*, which is what sunDisc() and sunGlow() are for. Conflating the two
   * is how the dome ended up painting a sun on the horizon at midnight.
   */
  domeElevation(): number {
    return Math.max(this.state.elevation, DAY.domeMinElevation)
  }

  /**
   * How much of the dome's solar disc may be drawn, 0..1.
   *
   * The disc is its own term in the scattering shader — `vSunE * 19000` inside
   * the sun's angular radius, four orders of magnitude over the sky around it —
   * and it is drawn wherever domeElevation() puts it. So with nothing gating it
   * there was a hot disc parked one degree under the horizon all night, which
   * the horizon ridges only ever half hid, and which bloom and the god rays then
   * happily smeared across the frame.
   *
   * Faded rather than switched: at the rate the clock runs through sunset a hard
   * cutoff is a visible blink. Zero by -1.5 degrees, which is under the terrain
   * edge and well under the ridge line, so the last of it goes out behind
   * something solid.
   */
  sunDisc(): number {
    return THREE.MathUtils.smoothstep(this.state.elevation, -1.5, 0.5)
  }

  /**
   * How much Mie forward-scatter the dome may draw, 0..1 — the hot lobe of haze
   * around the sun, which is most of what "the sun is over there" looks like
   * even when the disc itself is behind a ridge.
   *
   * Preetham dims this on its own through vSunE, which reaches zero at about
   * -2.3 degrees. But vSunE is derived from the *clamped* sun, so once the true
   * sun is down it freezes at roughly 1.5% of noon and never dims again — and
   * the night phase rows ask for six times the dome brightness of noon on top of
   * that. The result was a golden-hour lobe welded to the night horizon,
   * pointing at wherever the sun was under the ground: the sun the player could
   * see at night.
   *
   * Squared because afterglow does not decay linearly — most of it is gone in
   * the first few degrees, and a straight ramp leaves a smear sitting on the
   * horizon well into the night. Zero by -9 degrees, which at the dwell rate
   * through dusk is about a minute of fade.
   */
  sunGlow(): number {
    const s = THREE.MathUtils.smoothstep(this.state.elevation, -9, -1)
    return s * s
  }

  /** Degrees above the horizon of the anti-solar point, where the moon is drawn. */
  get moonElevation(): number {
    return -this.state.elevation
  }

  /**
   * How much of the moon may be drawn, 0..1.
   *
   * The moon is the anti-solar point, so for the whole of the day it is *under
   * the ground*. Its alpha used to be the `stars` ramp alone, and that ramp is
   * not zero in the morning — it has to hold 0.25 at sunrise for the last of the
   * dawn stars and interpolates away from there — so a hunt opened with a moon
   * showing through the terrain seventeen degrees below the horizon. Gating on
   * the body's own elevation is what makes the ramp mean brightness instead of
   * existence.
   *
   * The fade finishes a few degrees *above* the horizon rather than at it,
   * because down there the moon is behind the ridge line and looking through far
   * more haze than a point sprite knows how to model.
   */
  moonVisibility(): number {
    return THREE.MathUtils.smoothstep(this.moonElevation, -1.5, 3)
  }

  /**
   * How much of the night *sky* is allowed on screen, 0..1: the star field, the
   * moon, and the navy gradient the dome adds underneath Preetham.
   *
   * `stars` on its own is the darkness ramp, not a statement about the sky. It
   * is authored at 0.25 at sunrise and smootherstep-interpolated to zero by
   * mid-morning, so a sixth of the night — faint stars and a navy veil over the
   * blue — was still up with the sun seventeen degrees high, which is exactly
   * where the hunt starts. The second term is daylight washing them out, keyed
   * to the sun's own elevation so it cannot disagree with where the sun is.
   *
   * Deliberately still 1 at elevation zero: sunrise is the moment the table's
   * twilight values are describing, and this must not eat them.
   */
  get nightSky(): number {
    return this.state.stars * (1 - THREE.MathUtils.smoothstep(this.state.elevation, 0, 8))
  }

  /**
   * What to set the key light's intensity to, given that `sunI` in the phase
   * table is authored as *irradiance on level ground* rather than as the light's
   * own intensity. See DAY.phases.
   *
   * A directional light delivers `intensity * sin(elevation)` to a horizontal
   * surface, so authoring intensity directly multiplies every keyframe by a
   * geometric factor that runs from 0 at the horizon to 0.88 at 62 degrees.
   * Dividing it back out here is what makes the column mean what it says, and
   * what stops a change of start time from silently rebalancing the whole day.
   *
   * The floor is sin(11 degrees), roughly where the golden-hour keyframe sits.
   * Below it the division stops, so the last of the light drains away into dusk
   * on its own instead of the intensity running to infinity at the horizon.
   *
   * Uses the absolute sine because at night the key light is the anti-solar
   * point, whose elevation is the negation of the sun's.
   */
  keyIntensity(): number {
    const sin = Math.abs(Math.sin(THREE.MathUtils.degToRad(this.state.elevation)))
    return this.state.sunI / Math.max(sin, KEY_SIN_FLOOR)
  }

  /**
   * How dark it is, 0..1. Everything that has to respond to nightfall — the
   * village lamps, the moonlit clouds, the grade's night-eye lift — keys off
   * this one number rather than re-deriving nightfall from the elevation with
   * its own thresholds, which is how three systems end up disagreeing about
   * when dusk was.
   *
   * It is the same ramp that fades the stars in, because "you can see stars" and
   * "it is dark enough to need a lamp" are the same statement.
   *
   * Not the same as nightSky: this one is about the ground, and it is read by
   * gameplay. Anything *drawn on the sky* wants nightSky, which is this ramp
   * times a daylight wash, because the sky is the one place a sixth of a night
   * is plainly visible in the morning.
   */
  get darkness(): number {
    return this.state.stars
  }
}

const tmp = new THREE.Color()

/** sin(11 degrees) — see keyIntensity(). */
const KEY_SIN_FLOOR = 0.19

/** Ken Perlin's smootherstep: zero first *and* second derivative at both ends. */
function smootherstep(x: number): number {
  const c = Math.min(1, Math.max(0, x))
  return c * c * c * (c * (c * 6 - 15) + 10)
}

export type { DayPhase }
