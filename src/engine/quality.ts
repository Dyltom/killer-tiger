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
  /**
   * Half-extent of the sun's shadow frustum, in metres.
   *
   * Read this together with `shadowMapSize`: what matters is the metres per
   * texel, and the tiers below sit between 33 and 47 mm. Every one of them is a
   * deliberate loss of distant shadows in exchange for shadows the player can
   * see at their own feet — the hunt happens inside about 30 m, and a box big
   * enough to shadow the treeline can only afford 73 mm per texel, which is
   * wider than a fence post.
   */
  shadowExtent: number
  godrays: boolean
  bloom: boolean
  smaa: boolean
  /** Multiplier on every foliage field's draw distance. */
  foliageDistance: number
  /**
   * Practical lights in the pool (see world/lamps.ts).
   *
   * Every one of them is evaluated for every lit pixel in the frame whether it
   * is contributing anything or not — three has no per-object light culling, so
   * a point light two hundred metres away still costs a full GGX evaluation on
   * every blade of grass in front of the camera. Measured on the ground plane
   * that came to roughly 0.7 ms per light at 1.3 megapixels, which made the pool
   * the most expensive single thing in the frame.
   *
   * Unlike everything else here this is read once, at boot: the pool size is the
   * scene's point-light count, and changing it recompiles every material in the
   * world. See the note at the top of world/lamps.ts.
   */
  lightPool: number
}

/** Ordered worst to best; `tier` indexes this. */
export const PRESETS: QualityPreset[] = [
  // mm/texel:                                                    47
  { name: 'Low',    pixelRatio: 1.0,  shadowMapSize: 1024, shadowExtent: 24, godrays: false, bloom: false, smaa: false, foliageDistance: 0.5,  lightPool: 3 },
  // 29 mm/texel — the tightest of the four, because a 1024 map at this extent
  // would be the low tier and 2048 has the density to spend on coverage.
  { name: 'Medium', pixelRatio: 1.25, shadowMapSize: 2048, shadowExtent: 30, godrays: false, bloom: true,  smaa: true,  foliageDistance: 0.72, lightPool: 5 },
  // 33 mm/texel. This is where most machines settle, so it is the one tuned
  // against: 34 m covers the whole 30 m engagement range plus the huts behind it.
  { name: 'High',   pixelRatio: 1.5,  shadowMapSize: 2048, shadowExtent: 34, godrays: true,  bloom: true,  smaa: true,  foliageDistance: 1.0,  lightPool: 7 },
  // 21 mm/texel *and* 44 m of reach — 4096 is the only tier that can buy both.
  { name: 'Ultra',  pixelRatio: 2.0,  shadowMapSize: 4096, shadowExtent: 44, godrays: true,  bloom: true,  smaa: true,  foliageDistance: 1.25, lightPool: 10 },
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
