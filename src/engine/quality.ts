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
 *
 * There are two levers here, not one, because the frame is fill-bound and the
 * ladder is too coarse to steer it. Measured on the scene at 1920x1200, the
 * cost is 2.9 ms per megapixel and it is spread thin — terrain 1.6 ms, the
 * light pool 1.6, the whole post chain 1.9, foliage 0.6, fog 0.6, shadows 0.7.
 * Nothing in there is a switch worth throwing on its own, and all of it scales
 * with the pixel count. So:
 *
 *   - `renderScale` is the fast lever: a fine step on the render resolution,
 *     moved on a quarter-second average and able to react inside three frames.
 *     It is what actually holds the frame rate.
 *   - the tier is the slow lever, and it only moves once the fast one has run
 *     out of room. Dropping a tier changes what the game *looks* like — fewer
 *     shadows, shorter foliage draw distance, no god rays — and that is not a
 *     thing to do to someone because one wave spawned.
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
  /**
   * Re-render the sun's shadow map every N frames.
   *
   * The map is the second render of every frame and it is not cheap: measured
   * at High it is 102 of the frame's 260 draw calls and 50k of its triangles,
   * spent re-rasterising a village that has not moved since the frame before.
   *
   * What makes it skippable is that the shadow camera is snapped to whole
   * texels and only moved on the frames the map is actually redrawn, so the map
   * and the matrix that samples it never disagree — a stale map is a *correct*
   * map, just one frame old. All that ages is the shadow of something moving,
   * and a human's shadow arriving 16 ms late is not a thing anyone can see.
   */
  shadowInterval: number
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
  { name: 'Low',    pixelRatio: 1.0,  shadowMapSize: 1024, shadowExtent: 24, shadowInterval: 3, godrays: false, bloom: false, smaa: false, foliageDistance: 0.5,  lightPool: 3 },
  // 29 mm/texel — the tightest of the four, because a 1024 map at this extent
  // would be the low tier and 2048 has the density to spend on coverage.
  { name: 'Medium', pixelRatio: 1.25, shadowMapSize: 2048, shadowExtent: 30, shadowInterval: 2, godrays: false, bloom: true,  smaa: true,  foliageDistance: 0.72, lightPool: 5 },
  // 33 mm/texel. This is where most machines settle, so it is the one tuned
  // against: 34 m covers the whole 30 m engagement range plus the huts behind it.
  { name: 'High',   pixelRatio: 1.5,  shadowMapSize: 2048, shadowExtent: 34, shadowInterval: 2, godrays: true,  bloom: true,  smaa: true,  foliageDistance: 1.0,  lightPool: 7 },
  // 21 mm/texel *and* 44 m of reach — 4096 is the only tier that can buy both.
  { name: 'Ultra',  pixelRatio: 2.0,  shadowMapSize: 4096, shadowExtent: 44, shadowInterval: 1, godrays: true,  bloom: true,  smaa: true,  foliageDistance: 1.25, lightPool: 10 },
]

/**
 * Multipliers on the tier's pixelRatio, best first.
 *
 * Quantised rather than continuous because applying one reallocates every
 * render target in the post chain — a continuous knob would pay that on frames
 * it was trying to make cheaper. Six steps span a 2.8x range in pixel count,
 * which at 2.9 ms per megapixel is enough authority to drag a 30 ms frame back
 * under budget without touching the tier.
 */
const SCALE_STEPS = [1, 0.92, 0.84, 0.76, 0.68, 0.6]

/** 60 fps target with a little headroom before we call a frame late. */
const BUDGET_MS = 17.5
/** Only climb when there is room for the next tier's extra cost. */
const COMFORT_MS = 12.0
const DROP_AFTER = 1.2
const RAISE_AFTER = 4.0
const SETTLE = 1.0
/** Resolution changes are cheap to undo, so they get a much shorter cooldown. */
const SCALE_SETTLE = 0.35
/** Give resolution back more slowly than it is taken, or the two levers ring. */
const SCALE_RAISE_AFTER = 2.0

export class Quality {
  /** Start one below the top: most machines settle here, and climbing is cheap. */
  tier = 2
  private avg = 16
  private fast = 16
  private over = 0
  private under = 0
  private scaleUnder = 0
  private step = 0
  private settle = SETTLE
  private frames = 0

  onChange: ((p: QualityPreset) => void) | null = null

  get preset(): QualityPreset {
    return PRESETS[this.tier]!
  }

  /**
   * Multiplier on `preset.pixelRatio`. Whoever sizes the framebuffer has to
   * fold this in — the tier's cap on its own is only half the answer.
   */
  get renderScale(): number {
    return SCALE_STEPS[this.step]!
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
    // The new tier is a different frame cost, so whatever the resolution had
    // been trimmed to was an answer to a question nobody is asking any more.
    this.step = 0
    this.scaleUnder = 0
    this.settle = SETTLE
    this.onChange?.(this.preset)
  }

  /** Move the resolution one step and re-apply; returns false at the end. */
  private setStep(step: number): boolean {
    if (step < 0 || step >= SCALE_STEPS.length || step === this.step) return false
    this.step = step
    this.scaleUnder = 0
    this.settle = SCALE_SETTLE
    this.onChange?.(this.preset)
    return true
  }

  /** Feed one frame's delta, in seconds. */
  sample(dt: number) {
    // A dt above a fifth of a second is an alt-tab or a load hitch, not a slow
    // frame; folding it into the average would drop two tiers for nothing.
    //
    // Zero is the other end of the same thing: the loop's Timer is connected to
    // the Page Visibility API and reports exactly 0 while the tab is hidden. A
    // frame that took no time is not a fast frame, it is no frame — believing it
    // would walk the quality back up to Ultra behind a backgrounded tab and hand
    // it to the player the moment they came back.
    if (dt <= 0 || dt > 0.2) return
    const ms = dt * 1000

    // Ignore the first handful of frames outright — they include shader
    // compilation for every material in the scene.
    if (this.frames++ < 30) return

    if (this.settle > 0) {
      this.settle -= dt
      return
    }

    this.avg += (ms - this.avg) * 0.06
    this.fast += (ms - this.fast) * 0.25

    // Resolution first, in both directions. A late frame gets pixels taken off
    // it within a few frames of going late; a comfortable one gets them back
    // before the tier is allowed to climb and put god rays on top.
    if (this.fast > BUDGET_MS) {
      if (this.setStep(this.step + 1)) return
      // Out of steps: the slow ladder below is the only thing left.
    } else if (this.fast < COMFORT_MS && this.step > 0) {
      this.scaleUnder += dt
      if (this.scaleUnder > SCALE_RAISE_AFTER && this.setStep(this.step - 1)) return
    } else {
      this.scaleUnder = 0
    }

    if (this.avg > BUDGET_MS) {
      this.over += dt
      this.under = 0
      if (this.over > DROP_AFTER) this.set(this.tier - 1)
    } else if (this.avg < COMFORT_MS && this.step === 0) {
      // Only climb from full resolution. Climbing a tier while the frame is
      // still being propped up by a resolution cut is how you get a game that
      // trades sharpness for god rays behind the player's back.
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
