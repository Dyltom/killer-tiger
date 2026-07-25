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

const NUMERIC = ['turbidity', 'rayleigh', 'mie', 'dome', 'sunI', 'bounceI', 'env', 'density', 'stars', 'exposure'] as const
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
    env: 0, density: 0, stars: 0, exposure: 1,
    sun: new THREE.Color(), skyB: new THREE.Color(), gndB: new THREE.Color(),
    fogSun: new THREE.Color(), fogAway: new THREE.Color(),
    elevation: 0, night: false,
  }

  constructor() {
    this.evaluate()
  }

  advance(dt: number) {
    this.t = (this.t + dt / this.period) % 1
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

    // Azimuth sweeps a full turn over the day, anchored so that the opening
    // golden hour still sits behind the village.
    const theta = THREE.MathUtils.degToRad(168 + (t - DAY.start) * 360)
    this.sunDir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - elev), theta)
    // The moon is simply the anti-solar point, so the handover happens while
    // both bodies are on the horizon and the key light is near zero anyway.
    if (s.night) this.keyDir.copy(this.sunDir).negate()
    else this.keyDir.copy(this.sunDir)
  }

  /** Where the dome's sun goes: held near the horizon so Preetham stays sane. */
  domeElevation(): number {
    return Math.max(this.state.elevation, DAY.domeMinElevation)
  }
}

const tmp = new THREE.Color()

/** Ken Perlin's smootherstep: zero first *and* second derivative at both ends. */
function smootherstep(x: number): number {
  const c = Math.min(1, Math.max(0, x))
  return c * c * c * (c * (c * 6 - 15) + 10)
}

export type { DayPhase }
