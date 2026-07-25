/**
 * Adaptive quality.
 *
 * The one thing you cannot know about a browser game is what it is running on.
 * A fixed settings menu asks the player to guess; instead this watches the real
 * frame time and walks a ladder of presets until the game holds its target.
 *
 * The rules that keep it from oscillating:
 *
 *   - the frame time is a slow exponential average, so one stutter (a wave
 *     spawning, a shader compiling) never drops a tier on its own;
 *   - dropping needs the average to sit over budget for a sustained period,
 *     and climbing back needs twice as long *and* a comfortable margin, so the
 *     hysteresis band is wide enough that the steady state is one tier, not a
 *     cycle between two; and
 *   - the first second after any change is ignored, because reallocating a
 *     shadow map or a render target costs a frame or two by itself.
 */

export interface QualityPreset {
  name: string
  /** Cap on devicePixelRatio. The single biggest lever on a retina display. */
  pixelRatio: number
  shadowMapSize: number
  /** Half-extent of the sun's shadow frustum, in metres. */
  shadowExtent: number
  godrays: boolean
  bloom: boolean
  smaa: boolean
  /** Multiplier on every foliage field's draw distance. */
  foliageDistance: number
}

/** Ordered worst to best; `tier` indexes this. */
export const PRESETS: QualityPreset[] = [
  { name: 'Low',    pixelRatio: 1.0,  shadowMapSize: 1024, shadowExtent: 60, godrays: false, bloom: false, smaa: false, foliageDistance: 0.5 },
  { name: 'Medium', pixelRatio: 1.25, shadowMapSize: 2048, shadowExtent: 75, godrays: false, bloom: true,  smaa: true,  foliageDistance: 0.72 },
  { name: 'High',   pixelRatio: 1.5,  shadowMapSize: 2048, shadowExtent: 90, godrays: true,  bloom: true,  smaa: true,  foliageDistance: 1.0 },
  { name: 'Ultra',  pixelRatio: 2.0,  shadowMapSize: 4096, shadowExtent: 95, godrays: true,  bloom: true,  smaa: true,  foliageDistance: 1.25 },
]

/** 60 fps target with a little headroom before we call a frame late. */
const BUDGET_MS = 17.5
/** Only climb when there is room for the next tier's extra cost. */
const COMFORT_MS = 12.0
const DROP_AFTER = 1.2
const RAISE_AFTER = 4.0
const SETTLE = 1.0

export class Quality {
  /** Start one below the top: most machines settle here, and climbing is cheap. */
  tier = 2
  private avg = 16
  private over = 0
  private under = 0
  private settle = SETTLE
  private frames = 0

  onChange: ((p: QualityPreset) => void) | null = null

  get preset(): QualityPreset {
    return PRESETS[this.tier]!
  }

  /** Pick a sensible opening tier from what the device advertises. */
  constructor() {
    const cores = navigator.hardwareConcurrency ?? 4
    const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    if (mobile || cores <= 4) this.tier = 0
    else if (cores <= 8) this.tier = 1
  }

  /** Apply the current preset without waiting for a measurement. */
  apply() {
    this.onChange?.(this.preset)
    this.settle = SETTLE
  }

  private set(tier: number) {
    const next = Math.max(0, Math.min(PRESETS.length - 1, tier))
    if (next === this.tier) return
    this.tier = next
    this.over = 0
    this.under = 0
    this.settle = SETTLE
    this.onChange?.(this.preset)
  }

  /** Feed one frame's delta, in seconds. */
  sample(dt: number) {
    // A dt above a fifth of a second is an alt-tab or a load hitch, not a slow
    // frame; folding it into the average would drop two tiers for nothing.
    if (dt > 0.2) return
    const ms = dt * 1000

    // Ignore the first handful of frames outright — they include shader
    // compilation for every material in the scene.
    if (this.frames++ < 30) return

    if (this.settle > 0) {
      this.settle -= dt
      return
    }

    this.avg += (ms - this.avg) * 0.06

    if (this.avg > BUDGET_MS) {
      this.over += dt
      this.under = 0
      if (this.over > DROP_AFTER) this.set(this.tier - 1)
    } else if (this.avg < COMFORT_MS) {
      this.under += dt
      this.over = 0
      if (this.under > RAISE_AFTER) this.set(this.tier + 1)
    } else {
      this.over = 0
      this.under = 0
    }
  }

  /** Smoothed frames per second, for the debug readout. */
  get fps(): number {
    return 1000 / Math.max(this.avg, 0.001)
  }
}
