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
 *   - for a second after any change no further change is allowed, because
 *     reallocating a shadow map or a render target costs a frame or two by
 *     itself, and those frames must not be read as evidence that the change was
 *     not enough. The averages keep updating through that window — it is the
 *     decision that waits, not the measurement.
 *
 * There are two levers here, not one, because the ladder is too coarse to steer
 * the frame on its own:
 *
 *   - `renderScale` is the fast lever: a fine step on the render resolution,
 *     moved on a quarter-second average and able to react inside three frames.
 *   - the tier is the slow lever, and it only moves once the fast one has run
 *     out of room. Dropping a tier changes what the game *looks* like — fewer
 *     shadows, shorter foliage draw distance, no god rays — and that is not a
 *     thing to do to someone because one wave spawned.
 *
 * Which of those is the *right* lever depends on what the frame is bound on, and
 * that is a property of the machine, not of the game. This file used to assert
 * fill-boundedness — 2.9 ms per megapixel, spread thin across terrain, lights,
 * post and fog — and on the machine it was written on that is now measurably
 * false: the frame is bound on draw call submission at roughly 14 us a call, and
 * at the resolution the scaler had already talked itself down to, fill was about
 * a millisecond of a twenty-two millisecond frame. Cutting pixels there is a
 * cost with no benefit.
 *
 * So the fast lever is a hypothesis rather than an assumption. Every cut is
 * checked against what it was supposed to save and the whole series is handed
 * back if it did not pay. See PROBE_PAYOFF.
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
  // Redrawing that map is 3.26 ms, and every-other-frame is 1.6 ms of it back
  // for no visible difference: the sun barely moves in 16 ms and the villagers
  // it shadows move less than a shadow texel. Ultra was the odd one out at 1.
  { name: 'Ultra',  pixelRatio: 2.0,  shadowMapSize: 4096, shadowExtent: 44, shadowInterval: 2, godrays: true,  bloom: true,  smaa: true,  foliageDistance: 1.25, lightPool: 10 },
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

/**
 * Both thresholds are multiples of the display's refresh period, not absolute
 * milliseconds, because requestAnimationFrame is paced by vsync and that makes
 * an absolute budget meaningless.
 *
 * The old numbers were a 17.5 ms budget and a 12.0 ms comfort line. On a 60 Hz
 * panel a frame that hits vsync perfectly measures 16.7 ms, so `fast` could
 * never once get under 12 — the branch that gives resolution back was
 * unreachable and the scale was a one-way ratchet. Every transient hitch took
 * pixels off permanently, and the game got blurrier the longer it ran. On a
 * 120 Hz panel the same constants worked fine, which is exactly the kind of
 * bug that survives being tested on the wrong machine.
 *
 * With vsync the frame time quantises: you either hit the refresh period or you
 * miss it and land on a multiple. So the useful question is not "how many
 * milliseconds" but "are we hitting it" — comfortable is a little above one
 * period, late is most of the way to two. Nothing lands between 1.10 and 1.35
 * on a machine that is either locked or missing, which is what makes the band
 * stable rather than a place to oscillate in.
 */
const BUDGET = 1.35
const COMFORT = 1.10
/**
 * What one refresh period is, in ms, learned from the fastest frames seen.
 *
 * Clamped to the range of real display rates. Without the ceiling a machine
 * that never once hit 60 would decide its refresh period was 40 ms and set
 * itself a 54 ms budget, and adaptive quality would switch itself off on
 * precisely the hardware that needs it.
 */
const REFRESH_MIN = 6.9
const REFRESH_MAX = 17.0
const DROP_AFTER = 1.2
const RAISE_AFTER = 4.0
/**
 * Backoff on the climb, and the ceiling it backs off to.
 *
 * A tier that has already been tried and failed is evidence, and a scaler that
 * ignores it oscillates forever: hold 60 for four seconds, climb, fail inside
 * one, drop, hold for four, climb again — a five-second cycle of the shadows
 * and the resolution visibly changing, on a machine that was running perfectly.
 * That loop was latent before and only masked by the fact that the climb was
 * unreachable at all; unblocking one without the other would have traded a
 * ratchet for a pump.
 *
 * So each demotion triples the wait before the next attempt — 4 s, 12 s, 36 s,
 * then the cap. Two failures in and it is effectively done trying, which is the
 * correct conclusion to draw about a machine that has now failed the same tier
 * twice. It never decays: nothing about the hardware improved.
 */
const RAISE_BACKOFF = 3
const RAISE_MAX = 90
const SETTLE = 1.0
/** Resolution changes are cheap to undo, so they get a much shorter cooldown. */
const SCALE_SETTLE = 0.35
/**
 * A step down needs the fast average over budget for this long.
 *
 * Not zero, which is what it used to be. `fast` has a 0.25 smoothing factor, so
 * a single 40 ms hitch lifts it from 16 to 22 on its own — over budget from one
 * frame — and each step's cooldown then skipped the samples that would have let
 * it fall back, so one spike walked the resolution all the way to the floor.
 * Twelve frames of sustained lateness is still inside a fifth of a second.
 */
const SCALE_DROP_AFTER = 0.2
/** Give resolution back more slowly than it is taken, or the two levers ring. */
const SCALE_RAISE_AFTER = 1.2

/**
 * How much of a resolution cut's *predicted* saving has to actually show up.
 *
 * Everything above assumes the frame is fill-bound, and where that holds the
 * fast lever is the right lever. Where it does not, the assumption is not
 * merely imprecise, it is unfalsifiable by the loop as written: fewer pixels
 * does not shorten the frame, the frame stays over budget, so it cuts again,
 * and it arrives at the floor having bought nothing. It cannot climb back out
 * either, because climbing needs a comfortable frame and the thing keeping the
 * frame uncomfortable was never the pixels. The player gets a permanently soft
 * picture as payment for no frame rate at all.
 *
 * Measured on this scene on one machine: about 2.4 ms per megapixel on top of
 * roughly 5 ms that does not move with resolution at all — and the scene it was
 * rendering when it decided to cut was 0.42 megapixels, so the lever had one
 * millisecond of authority over a twenty-two millisecond frame.
 *
 * So each step down is now a hypothesis with a result. Cutting to `s` should
 * cost `s^2` of the pixels and, if the frame really is fill-bound, take a like
 * fraction off the frame time. Measure what it took instead, and if less than
 * this fraction of the prediction materialised, the pixels are not the problem:
 * hand back every step taken on that premise and stop reaching for the lever.
 *
 * Handing back *every* step, not just the one on trial, is the part that was
 * missing. A verdict of "pixels are not what is slow" is not a statement about
 * the step being tested, it is a statement about the lever, and it condemns the
 * steps already taken exactly as much. Undoing one at a time left the game
 * parked at 84 per cent resolution with the lever switched off and no route
 * home: climbing back needs a comfortable frame, and the thing keeping the
 * frame uncomfortable was never the pixels.
 *
 * A third is deliberately generous. A perfectly fill-bound frame scores 1.0 and
 * anything with a real variable component clears 0.35 comfortably, so this only
 * fires where the lever is close to useless — which is the only case where
 * trading the player's sharpness for nothing is the wrong call.
 */
const PROBE_PAYOFF = 0.35
/**
 * Frames to average before judging a step.
 *
 * A plain mean of these rather than `fast`, whose 0.25 smoothing still holds a
 * tenth of the pre-step frame time this far in and would understate every
 * saving by that much — biasing the verdict toward "did not pay" on exactly the
 * slow machines that can least afford a wrong one.
 *
 * The same window is used on both sides of the step. `fast` is what *triggers* a
 * cut, so by construction it is elevated at the moment the cut is made — often
 * by the one hitch that caused it. Holding the after-mean up against that number
 * scores the hitch passing as a saving the resolution bought, which is how a cut
 * that achieved nothing gets a passing grade. Mean-before against mean-after is
 * the only comparison the two sides can both be held to.
 */
const PROBE_FRAMES = 8

export class Quality {
  /** Start one below the top: most machines settle here, and climbing is cheap. */
  tier = 2
  private avg = 16
  private fast = 16
  private over = 0
  private under = 0
  private scaleOver = 0
  private scaleUnder = 0
  private step = 0
  private settle = SETTLE
  private frames = 0
  /** The step-down currently on trial, and the frame time it has to beat. */
  private probe: { from: number; ratio: number; before: number; sum: number; n: number } | null = null
  /**
   * Whether cutting pixels is still believed to buy frame time.
   *
   * Cleared by a step that failed its probe, and only ever restored by a tier
   * change — a different tier is a different frame, and the last one's verdict
   * says nothing about it. Giving resolution *back* is never gated on this: the
   * lever is only ever distrusted in the direction that costs the player
   * something.
   */
  private fillBound = true
  /** How long a comfortable stretch has to be before the next climb; grows. */
  private raiseAfter = RAISE_AFTER
  /**
   * Running estimate of the display's refresh period, in ms.
   *
   * A minimum with a slow upward leak. The minimum is what finds the period —
   * under vsync the floor of the frame time *is* the period, and no amount of
   * load pushes a frame below it. The leak is what stops a single freakishly
   * short frame (a dropped-then-doubled pair, a timer rounding down) from
   * pinning the estimate at 8 ms on a 60 Hz panel forever and holding the
   * budget at an impossible 11.
   *
   * Seeded at 60 Hz, which is what it will converge to on most machines anyway.
   */
  private refresh = 16.7
  /** The last PROBE_FRAMES settled frame times, as the probe's before-picture. */
  private recent = new Float64Array(PROBE_FRAMES)
  private recentAt = 0
  private recentN = 0

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
    if (next < this.tier) this.raiseAfter = Math.min(this.raiseAfter * RAISE_BACKOFF, RAISE_MAX)
    this.tier = next
    this.over = 0
    this.under = 0
    // The new tier is a different frame cost, so whatever the resolution had
    // been trimmed to was an answer to a question nobody is asking any more.
    this.step = 0
    this.scaleOver = 0
    this.scaleUnder = 0
    this.probe = null
    this.fillBound = true
    this.settle = SETTLE
    this.onChange?.(this.preset)
  }

  /** Move the resolution one step and re-apply; returns false at the end. */
  private setStep(step: number): boolean {
    if (step < 0 || step >= SCALE_STEPS.length || step === this.step) return false
    // A step that has been shown not to pay is not a step.
    if (step > this.step && !this.fillBound) return false
    const from = this.step
    this.step = step
    this.scaleOver = 0
    this.scaleUnder = 0
    this.settle = SCALE_SETTLE
    // Only downward steps go on trial, and only the frame time the drop was
    // decided on is a fair thing to hold them to.
    this.probe = step > from
      ? { from, ratio: SCALE_STEPS[step]! ** 2 / SCALE_STEPS[from]! ** 2, before: this.baseline(), sum: 0, n: 0 }
      : null
    this.onChange?.(this.preset)
    return true
  }

  /**
   * Mean of the recent settled frames — what the frame cost before a step.
   *
   * Falls back to `fast` until the window has filled, which only happens in the
   * first few frames after a cooldown; a probe struck that early is judged on
   * the smoothed number, as it always was.
   */
  private baseline(): number {
    if (this.recentN < PROBE_FRAMES) return this.fast
    let sum = 0
    for (let i = 0; i < PROBE_FRAMES; i++) sum += this.recent[i]!
    return sum / PROBE_FRAMES
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

    // The fastest frame anyone manages is the refresh period, near enough:
    // vsync will not let a frame finish early, so the floor of the frame time
    // distribution is the panel and not the workload.
    //
    // Tracked as an asymmetric average rather than a plain minimum, because a
    // plain minimum is one bad sample away from being wrong for the rest of the
    // session — a single 8 ms delta on a 60 Hz panel would set an 11 ms budget
    // that the display makes it physically impossible to meet, and the scaler
    // would strip the game to the floor chasing it. Pulling down ten times
    // faster than up still finds a real 120 Hz panel inside a quarter second,
    // while an occasional short frame among honest ones only drags the estimate
    // to where the two rates balance, which is still above the true period.
    //
    // `target` is clamped before it is used in either direction: a machine that
    // never once renders a frame in under 17 ms has a slow game, not a 22 Hz
    // display, and must not be allowed to talk itself into a 60 ms budget.
    const target = Math.min(ms, REFRESH_MAX)
    this.refresh += (target - this.refresh) * (target < this.refresh ? 0.10 : 0.02)
    this.refresh = Math.max(REFRESH_MIN, this.refresh)
    const budget = this.refresh * BUDGET
    const comfort = this.refresh * COMFORT

    // Keep measuring through the cooldown; only the *decisions* wait. This used
    // to return here, which meant the spike that triggered a change was still
    // sitting in `fast`, undiluted, when the cooldown lifted — so it fired the
    // next step immediately, and the one after that, all from one hitch.
    this.avg += (ms - this.avg) * 0.06
    this.fast += (ms - this.fast) * 0.25
    if (this.settle > 0) {
      this.settle -= dt
      return
    }

    // Only settled frames go in the window: the frames spent reallocating a post
    // chain are not a picture of what anything costs.
    this.recent[this.recentAt] = ms
    this.recentAt = (this.recentAt + 1) % PROBE_FRAMES
    if (this.recentN < PROBE_FRAMES) this.recentN++

    // Did the last cut buy what it promised? Judged after the cooldown, so the
    // frames spent reallocating the post chain are not counted as the answer.
    if (this.probe) {
      const p = this.probe
      p.sum += ms
      if (++p.n < PROBE_FRAMES) return
      this.probe = null
      const predicted = p.before * (1 - p.ratio)
      const delivered = p.before - p.sum / p.n
      if (delivered < predicted * PROBE_PAYOFF) {
        this.fillBound = false
        // Every step down was taken on the premise this one just disproved.
        this.setStep(0)
        return
      }
    }

    // Resolution first, in both directions. A late frame gets pixels taken off
    // it within a few frames of going late; a comfortable one gets them back
    // before the tier is allowed to climb and put god rays on top.
    if (this.fast > budget) {
      this.scaleOver += dt
      this.scaleUnder = 0
      if (this.scaleOver > SCALE_DROP_AFTER && this.setStep(this.step + 1)) return
      // Out of steps: the slow ladder below is the only thing left.
    } else if (this.fast < comfort && this.step > 0) {
      this.scaleUnder += dt
      this.scaleOver = 0
      if (this.scaleUnder > SCALE_RAISE_AFTER && this.setStep(this.step - 1)) return
    } else {
      this.scaleOver = 0
      this.scaleUnder = 0
    }

    if (this.avg > budget) {
      this.over += dt
      this.under = 0
      if (this.over > DROP_AFTER) this.set(this.tier - 1)
    } else if (this.avg < comfort && this.step === 0) {
      // Only climb from full resolution. Climbing a tier while the frame is
      // still being propped up by a resolution cut is how you get a game that
      // trades sharpness for god rays behind the player's back.
      this.under += dt
      this.over = 0
      if (this.under > this.raiseAfter) this.set(this.tier + 1)
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
