/**
 * Fully procedural audio — no asset files, no network, never fails to load.
 * Everything you hear is built out of oscillators, shaped noise and filters at
 * the moment it plays.
 *
 * The signal path is the one a game mixer would build:
 *
 *   voices ─┬─ dry ──────────────────────────────┐
 *           ├─ near send → treeline convolver ───┤
 *           └─ far send  → valley convolver ─────┤
 *                                                ├→ sfx bus → glue comp ─┐
 *                             music bus ─────────┤                       │
 *                         ambience bus ──────────┘                       │
 *                                                                        ▼
 *                                         master ← limiter ← muffle ← sum
 *
 * Three things do most of the work of making it sound expensive:
 *
 * - **Distance is not just volume.** Every positional sound is attenuated,
 *   rolled off in the treble by air absorption, sent further into the long
 *   reverb the further away it is, and — for gunshots — delayed by the time
 *   sound actually takes to cross the gap.
 * - **Nothing repeats exactly.** Every one-shot jitters its pitch, its filter
 *   corners and its noise read position, so a burst of six claw hits is six
 *   different claw hits rather than one sample fired six times.
 * - **Layers, not sounds.** A rifle is a click, a crack, a body thump, a bolt
 *   and a tail; a bite is bone, wet tear, sub and spray. Single-oscillator
 *   sounds are what make a game read as a jam.
 */
import { AUDIO, LEVELS } from '../config'
import { Music, type MusicMode } from './music'

/**
 * Anything that can build audio nodes. Normally a live `AudioContext`; an
 * `OfflineAudioContext` when the synth is being rendered for inspection.
 */
type Ctx = BaseAudioContext

/** Where a sound is, relative to the player's head. */
export interface Place {
  /** -1 hard left to +1 hard right. */
  pan?: number
  /** Metres. Drives attenuation, air absorption, reverb send and arrival delay. */
  dist?: number
  /**
   * Scales how fast level falls off with distance. 1 is the default curve,
   * which is tuned for the sort of sound a body makes.
   *
   * Loud things need their own curve. A footstep sixty metres away is nothing;
   * a rifle sixty metres away is still a rifle, and is audible across a valley.
   * Running both through one falloff means either the near shot is driven so
   * far into the mix bus that it distorts, or the far one vanishes — and the
   * player loses the only cue they had for how close the man shooting at them
   * is. A lower `roll` flattens the curve without touching the arrival delay,
   * air absorption or reverb send, which should all stay honest.
   */
  roll?: number
}

/**
 * Priority decides what gets dropped when the voice budget is full. Ambient
 * texture goes first; you never lose the shot that killed you.
 */
const PRI = { low: 0.6, normal: 1, high: 1.6 } as const
type Pri = (typeof PRI)[keyof typeof PRI]

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a)
}

/** Soft saturation. Adds the odd harmonics that make a growl sound like meat. */
function driveCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024
  const c = new Float32Array(new ArrayBuffer(n * 4))
  const k = amount * 50
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    c[i] = ((1 + k) * x) / (1 + k * Math.abs(x))
  }
  return c
}

/**
 * The mix-bus soft clipper: the classic cubic curve, unity below a third of
 * its input range and flat at the top.
 *
 * The linear region matters more than the curve does. An earlier version of
 * this used a plain tanh, which is smoother and sounds nicer in isolation and
 * was completely wrong here — tanh starts bending immediately, so it was
 * quietly compressing *every* sound rather than only the spikes. The
 * measurable symptom was that a rifle shot twenty-five metres away came out
 * louder than one at six, because the near shot was being folded ten decibels
 * harder than the far one. A curve that is exactly linear below the knee
 * cannot do that.
 *
 * This exists because of one number. A rifle's firing pin is six tenths of a
 * millisecond long — thirty samples. No compressor can catch it; the limiter
 * downstream has a two-millisecond attack and will not have begun to move
 * before the spike is over and gone. So the spike survives the entire chain
 * and clips the converter, and the only defence is to make the shot quieter,
 * which is the opposite of what a gunshot needs.
 *
 * A waveshaper has no attack time at all — it is a lookup table, so it acts
 * instantly by construction. It folds the spike down, and the harmonics that
 * folding generates land in the upper midrange where the ear judges loudness.
 * The shot measures quieter and sounds louder. This is most of what "mastered"
 * means.
 */
function saturationCurve(): Float32Array<ArrayBuffer> {
  const n = 2048
  const c = new Float32Array(new ArrayBuffer(n * 4))
  for (let i = 0; i < n; i++) {
    const u = (i / (n - 1)) * 2 - 1
    const a = Math.abs(u)
    const s = Math.sign(u)
    // Gain of 2 in the linear third; the pre-scale halves it back to unity.
    c[i] = a < 1 / 3 ? 2 * u : a < 2 / 3 ? (s * (3 - (2 - 3 * a) ** 2)) / 3 : s
  }
  return c
}

function noiseBuffer(ctx: Ctx, seconds: number, channels = 1): AudioBuffer {
  const n = Math.max(1, Math.floor(ctx.sampleRate * seconds))
  const buf = ctx.createBuffer(channels, n, ctx.sampleRate)
  for (let c = 0; c < channels; c++) {
    const d = buf.getChannelData(c)
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1
  }
  return buf
}

/**
 * A synthetic impulse response: a handful of discrete early reflections in
 * front of an exponentially decaying, progressively darkening noise tail.
 *
 * The early taps are what tell you the size of the space — without them a
 * decaying noise burst reads as a reverb plugin rather than as a place. The
 * tail is lowpassed harder as it decays because air and foliage eat treble
 * before they eat bass, which is why a valley echo comes back muffled.
 */
function impulseResponse(ctx: Ctx, seconds: number, decay: number): AudioBuffer {
  const rate = ctx.sampleRate
  const n = Math.floor(rate * seconds)
  const buf = ctx.createBuffer(2, n, rate)
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    // One-pole lowpass state, its coefficient swept over the tail.
    let lp = 0
    for (let i = 0; i < n; i++) {
      const t = i / n
      const white = Math.random() * 2 - 1
      const a = 0.35 - t * 0.28
      lp += a * (white - lp)
      d[i] = lp * Math.pow(1 - t, decay)
    }
    // Early reflections, decorrelated per channel so the space has width.
    for (let r = 0; r < 6; r++) {
      const at = Math.floor(rate * (0.006 + r * 0.011 + Math.random() * 0.008 + c * 0.002))
      if (at < n) d[at] += (Math.random() * 2 - 1) * (0.6 / (1 + r))
    }
  }
  return buf
}

export class Audio {
  private ctx: Ctx | null = null
  private master: GainNode | null = null
  private muffle: BiquadFilterNode | null = null
  private sfxBus: GainNode | null = null
  private musicBus: GainNode | null = null
  private ambBus: GainNode | null = null
  private nearSend: GainNode | null = null
  private farSend: GainNode | null = null

  private noiseShort: AudioBuffer | null = null
  private noiseLong: AudioBuffer | null = null
  private drive: Float32Array<ArrayBuffer> | null = null

  private ambienceStop: (() => void) | null = null
  private ambienceTimer: number | null = null
  private ambDarkness = 0.5
  private ambWave = 1

  private music: Music | null = null
  /** End times of live voices; the length of the live set is the budget. */
  private voiceEnds: number[] = []
  /** Routing chains waiting to be disconnected once their sound has died. */
  private pending: { at: number; nodes: AudioNode[] }[] = []

  muted = false

  /**
   * Must be called from a user gesture — browsers will not start an audio
   * context otherwise.
   *
   * `into` exists so the whole synth can be built on an OfflineAudioContext and
   * rendered to a buffer faster than real time. That is the only way to check
   * this file: you cannot look at a screenshot and see whether the gunshot has
   * a crack on it, but you can render four seconds of one and measure it.
   */
  init(into?: Ctx) {
    if (this.ctx) return
    const AC: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = into ?? new AC()
    this.ctx = ctx

    // ---- master chain, built back to front.
    this.master = ctx.createGain()
    this.master.gain.value = AUDIO.master
    this.master.connect(ctx.destination)

    // Brick-wall-ish limiter. Six layered gunshots and a roar will otherwise
    // clip the output stage, which is the single most amateur-sounding failure
    // a game mix has.
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -4
    limiter.knee.value = 2
    limiter.ratio.value = 20
    limiter.attack.value = 0.002
    limiter.release.value = 0.12
    limiter.connect(this.master)

    // Instantaneous peak control, ahead of the limiter that cannot be.
    //
    // The curve's linear third has a gain of 2, so pre-scaling by 1/ceiling and
    // post-scaling by ceiling/2 is unity below the knee. `satMakeup` is that
    // ceiling/2 with a little taken off, which is where the output ceiling
    // actually comes from: nothing leaves here above `satMakeup`.
    const satIn = ctx.createGain()
    satIn.gain.value = 1 / AUDIO.satCeiling
    const sat = ctx.createWaveShaper()
    sat.curve = saturationCurve()
    sat.oversample = '4x'
    const satOut = ctx.createGain()
    satOut.gain.value = AUDIO.satMakeup
    satIn.connect(sat)
    sat.connect(satOut)
    satOut.connect(limiter)

    // Concussion filter. Normally wide open; swept down when the tiger is hit.
    this.muffle = ctx.createBiquadFilter()
    this.muffle.type = 'lowpass'
    this.muffle.frequency.value = 20000
    this.muffle.Q.value = 0.6
    this.muffle.connect(satIn)

    // ---- buses.
    // Glue compression on effects only, so the score is not pumped by footsteps.
    //
    // The attack is deliberately slower than the transients it is compressing.
    // A gunshot's crack is over in six milliseconds; if the compressor can
    // catch it, it removes the only part of the sound that reads as danger and
    // leaves you with a distant thump. Twelve milliseconds lets the crack
    // through and clamps the body behind it, which is also roughly what a
    // recording engineer does to a real one.
    const glue = ctx.createDynamicsCompressor()
    glue.threshold.value = -6
    glue.knee.value = 6
    glue.ratio.value = 2.0
    glue.attack.value = 0.012
    glue.release.value = 0.15
    glue.connect(this.muffle)

    this.sfxBus = ctx.createGain()
    this.sfxBus.gain.value = AUDIO.sfx
    this.sfxBus.connect(glue)

    this.musicBus = ctx.createGain()
    this.musicBus.gain.value = AUDIO.music
    this.musicBus.connect(this.muffle)

    this.ambBus = ctx.createGain()
    this.ambBus.gain.value = AUDIO.ambience
    this.ambBus.connect(this.muffle)

    // ---- the two spaces.
    const near = ctx.createConvolver()
    near.buffer = impulseResponse(ctx, AUDIO.nearSeconds, AUDIO.nearDecay)
    near.connect(this.sfxBus)
    this.nearSend = ctx.createGain()
    this.nearSend.gain.value = 1
    this.nearSend.connect(near)

    const far = ctx.createConvolver()
    far.buffer = impulseResponse(ctx, AUDIO.farSeconds, AUDIO.farDecay)
    const farTrim = ctx.createGain()
    farTrim.gain.value = 0.9
    far.connect(farTrim)
    farTrim.connect(this.sfxBus)
    this.farSend = ctx.createGain()
    this.farSend.gain.value = 1
    this.farSend.connect(far)

    this.noiseShort = noiseBuffer(ctx, 1.0)
    this.noiseLong = noiseBuffer(ctx, 4.0, 2)
    this.drive = driveCurve(0.6)

    // The score gets the long reverb as its own send, so it sits in the same
    // room as the game rather than on top of it.
    const musicVerb = ctx.createGain()
    musicVerb.gain.value = 0.5
    musicVerb.connect(far)
    this.music = new Music(ctx, this.musicBus, musicVerb)
  }

  /** Live contexts only; an offline render has no transport to resume. */
  private get live(): AudioContext | null {
    return this.ctx && 'resume' in this.ctx ? (this.ctx as AudioContext) : null
  }

  resume() {
    const c = this.live
    if (c?.state === 'suspended') void c.resume()
  }
  suspend() {
    const c = this.live
    if (c?.state === 'running') void c.suspend()
  }
  setMuted(m: boolean) {
    this.muted = m
    if (this.master) this.master.gain.value = m ? 0 : AUDIO.master
  }

  private get t(): number {
    return this.ctx ? this.ctx.currentTime : 0
  }

  // ------------------------------------------------------------ voice pool
  /** True if there is room for this sound. Quiet texture yields to loud events. */
  private budget(pri: Pri, dur: number): boolean {
    if (!this.ctx) return false
    const now = this.t
    // Prune in place — this runs on every one-shot.
    let w = 0
    for (let i = 0; i < this.voiceEnds.length; i++) {
      if (this.voiceEnds[i]! > now) this.voiceEnds[w++] = this.voiceEnds[i]!
    }
    this.voiceEnds.length = w
    if (w >= AUDIO.maxVoices * pri) return false
    this.voiceEnds.push(now + dur)
    return true
  }

  /**
   * Take down routing chains whose sound is long over.
   *
   * A one-shot builds five or six routing nodes and a dozen layer nodes, and
   * under fire that runs to two hundred nodes a second. Nothing here ever
   * disconnected them. A finished source releases itself, but the gain, the
   * air filter, the panner and the two reverb sends behind it stay wired to
   * the bus — reachable from the destination, so never collected, and still
   * visited by the audio thread on every 128-sample quantum. The graph grows
   * for as long as you play, and once the render thread stops making its
   * deadline the output drops out in bursts.
   *
   * Severing the chain head is enough: everything upstream loses its last path
   * to the destination and goes with it.
   */
  private sweep() {
    const now = this.t
    let w = 0
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i]!
      if (p.at > now) this.pending[w++] = p
      else for (const n of p.nodes) n.disconnect()
    }
    this.pending.length = w
  }

  /**
   * Claim a voice and build its routing, or return null if there is no room.
   *
   * This exists because the two steps have to happen in this order. Building
   * the routing first and then asking the budget — which is what every call
   * site used to do — leaks the whole chain on every denial, and a denied
   * chain is worse than a live one: no source ever feeds it, so the "source
   * finished" collection path that saves the others can never fire. Those are
   * permanent, and they accumulate fastest during exactly the heavy fights
   * where the budget starts saying no.
   *
   * `force` is for sounds that must always play — a gunshot, a roar, the hurt
   * cue. They still register with the pool so quieter things yield to them.
   */
  private voice(
    pri: Pri,
    dur: number,
    gain: number,
    place: Place = {},
    wetMult = 1,
    force = false,
  ): GainNode | null {
    this.sweep()
    const room = this.budget(pri, dur)
    if (!room && !force) return null
    const chain: AudioNode[] = []
    const g = this.out(gain, place, wetMult, chain)
    if (!g) return null
    // Generous: `dur` is a priority weight, not a measured length, and cutting
    // a tail off is far worse than holding a handful of nodes a second longer.
    this.pending.push({ at: this.t + dur * 1.5 + AUDIO.farSeconds + 1, nodes: chain })
    return g
  }

  // -------------------------------------------------------------- routing
  /**
   * Build the input node for one voice: level, distance attenuation, air
   * absorption, stereo placement, and matched sends into both reverbs.
   * Returns null when there is no context yet.
   */
  private out(gain: number, place: Place = {}, wetMult = 1, chain?: AudioNode[]): GainNode | null {
    const ctx = this.ctx
    if (!ctx || !this.sfxBus || !this.nearSend || !this.farSend) return null
    const dist = Math.max(0, place.dist ?? 0)
    const pan = Math.max(-1, Math.min(1, place.pan ?? 0))

    const roll = place.roll ?? 1
    const atten = 1 / (1 + dist * AUDIO.falloff * roll + dist * dist * AUDIO.falloffSq * roll)
    const g = ctx.createGain()
    g.gain.value = gain * atten
    chain?.push(g)

    let node: AudioNode = g
    if (dist > 4) {
      const air = ctx.createBiquadFilter()
      air.type = 'lowpass'
      air.frequency.value = Math.max(AUDIO.airFloor, 20000 * Math.exp(-dist * AUDIO.airAbsorption))
      node.connect(air)
      node = air
      chain?.push(air)
    }
    if (pan !== 0 && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner()
      p.pan.value = pan
      node.connect(p)
      node = p
      chain?.push(p)
    }
    node.connect(this.sfxBus)

    // Wetter with distance: close things are dry and present, far things are
    // mostly the room coming back at you.
    //
    // The sends tap the signal *after* attenuation, so what they control is the
    // wet/dry ratio, not the wet level. Expressing them as a power of the
    // attenuation is what keeps those two straight: the wet ends up falling as
    // `atten^(1-slope)`, which is slower than the dry but still monotonically
    // downhill. Scaling them by raw distance instead — which is what this used
    // to do — let the ratio climb faster than the level fell, and the absolute
    // amount of reverb coming back actually *peaked* about twenty-five metres
    // out. A rifle measured loudest there and got quieter as it approached.
    const spread = (slope: number) => Math.min(AUDIO.wetSpreadMax, Math.pow(atten, -slope))
    const nearAmt = AUDIO.wetNear * wetMult * spread(AUDIO.wetSlopeNear)
    const farAmt = AUDIO.wetFar * wetMult * spread(AUDIO.wetSlopeFar)
    if (nearAmt > 0.002) {
      const s = ctx.createGain()
      s.gain.value = nearAmt
      node.connect(s)
      s.connect(this.nearSend)
      chain?.push(s)
    }
    if (farAmt > 0.002) {
      const s = ctx.createGain()
      s.gain.value = farAmt
      node.connect(s)
      s.connect(this.farSend)
      chain?.push(s)
    }
    return g
  }

  /** Seconds before a sound made `dist` metres away reaches the ear. */
  private travel(place: Place): number {
    return (place.dist ?? 0) / AUDIO.speedOfSound
  }

  // ------------------------------------------------------------ primitives
  /** A pitched voice with an exponential frequency glide and AD envelope. */
  private tone(
    dest: GainNode,
    type: OscillatorType,
    f0: number,
    f1: number,
    dur: number,
    gain: number,
    at = 0,
    attack = 0.008,
  ) {
    const ctx = this.ctx
    if (!ctx) return
    const t = this.t + at
    const osc = ctx.createOscillator()
    osc.type = type
    osc.frequency.setValueAtTime(Math.max(1, f0), t)
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur)
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, t)
    env.gain.exponentialRampToValueAtTime(gain, t + Math.min(attack, dur * 0.3))
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    osc.connect(env)
    env.connect(dest)
    osc.start(t)
    osc.stop(t + dur + 0.02)
  }

  /** A filtered noise burst. `q` above 1 turns it from air into resonance. */
  private noise(
    dest: GainNode,
    dur: number,
    gain: number,
    filterType: BiquadFilterType,
    f0: number,
    f1: number,
    at = 0,
    q = 1.1,
    attack = 0.004,
  ) {
    const ctx = this.ctx
    if (!ctx) return
    const buf = dur > 0.9 ? this.noiseLong : this.noiseShort
    if (!buf) return
    const t = this.t + at
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.loop = true
    const filt = ctx.createBiquadFilter()
    filt.type = filterType
    filt.Q.value = q
    filt.frequency.setValueAtTime(Math.max(20, f0), t)
    filt.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur)
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, t)
    env.gain.exponentialRampToValueAtTime(gain, t + Math.min(attack, dur * 0.3))
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    src.connect(filt)
    filt.connect(env)
    env.connect(dest)
    // Random read offset: the same buffer never grains the same way twice.
    src.start(t, Math.random() * (buf.duration - Math.min(dur, buf.duration * 0.5)))
    src.stop(t + dur + 0.02)
  }

  /**
   * A scatter of very short noise bursts, each with its own band, level, time
   * and stereo position.
   *
   * This is the primitive the whole sound design was missing. Dry grass, grit
   * thrown off a paw, soil compacting, debris off a bullet strike and tissue
   * tearing are all the same physical event: a few hundred tiny independent
   * collisions spread over a few tens of milliseconds. A single filtered noise
   * burst with a smooth exponential envelope is the one thing that emphatically
   * is *not* that — it is a hiss, and the ear files it as a synthesiser.
   *
   * Scattering the energy into grains buys three things at once. The sound gets
   * a texture, because the envelope is now jagged on the millisecond scale the
   * ear reads material from. It stops repeating, because six grains at random
   * times and bands never land the same way twice. And it gets width for free,
   * since each grain is panned independently — which is most of why the result
   * sounds recorded rather than generated.
   *
   * Grains are biased toward the front of the window: debris leaves an impact
   * all at once and then peters out, rather than arriving evenly.
   */
  private grains(
    dest: GainNode,
    count: number,
    spread: number,
    gain: number,
    fLo: number,
    fHi: number,
    grainLo: number,
    grainHi: number,
    at = 0,
    q = 1.8,
    width = 0,
  ) {
    const ctx = this.ctx
    if (!ctx) return
    for (let i = 0; i < count; i++) {
      let d = dest
      if (width > 0 && ctx.createStereoPanner) {
        const g = ctx.createGain()
        const p = ctx.createStereoPanner()
        p.pan.value = rand(-width, width)
        g.connect(p)
        p.connect(dest)
        d = g
      }
      const f = rand(fLo, fHi)
      this.noise(
        d,
        rand(grainLo, grainHi),
        gain * rand(0.4, 1),
        'bandpass',
        f,
        f * rand(0.65, 1.15),
        at + Math.pow(Math.random(), 0.7) * spread,
        q,
        0.0006,
      )
    }
  }

  /**
   * A vocal tract. A buzzing source through three resonant bandpasses is the
   * whole trick behind anything that sounds like a throat rather than a synth —
   * the formant frequencies are what your ear reads as a vowel, and moving them
   * is what turns a scream into a word.
   */
  private formants(
    dest: GainNode,
    source: AudioNode,
    freqs: readonly [number, number, number],
    levels: readonly [number, number, number],
    q = 9,
  ) {
    const ctx = this.ctx
    if (!ctx) return
    for (let i = 0; i < 3; i++) {
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.frequency.value = freqs[i]!
      bp.Q.value = q * (1 + i * 0.15)
      const g = ctx.createGain()
      g.gain.value = levels[i]!
      source.connect(bp)
      bp.connect(g)
      g.connect(dest)
    }
  }

  /** Pull the score down under a loud event, then let it back up. */
  private duck(amount = AUDIO.duckAmount) {
    const ctx = this.ctx
    if (!ctx || !this.musicBus) return
    const t = ctx.currentTime
    const g = this.musicBus.gain
    g.cancelScheduledValues(t)
    g.setTargetAtTime(AUDIO.music * (1 - amount), t, AUDIO.duckAttack)
    g.setTargetAtTime(AUDIO.music, t + AUDIO.duckAttack * 3, AUDIO.duckRelease)
  }

  /** Ears ring and the world goes muddy for a beat. Used when the tiger is hit. */
  private concuss(amount: number) {
    const ctx = this.ctx
    if (!ctx || !this.muffle) return
    const t = ctx.currentTime
    const f = this.muffle.frequency
    f.cancelScheduledValues(t)
    f.setValueAtTime(Math.max(500, 20000 * (1 - amount)), t)
    f.exponentialRampToValueAtTime(20000, t + 0.35 + amount * 0.5)
  }

  // ---------------------------------------------------------------- sounds

  /**
   * The roar.
   *
   * A big cat's roar is not a low note — it is a low note being torn. Tigers
   * have thick, flat vocal folds that flutter chaotically instead of vibrating
   * cleanly, which puts a subharmonic buzz somewhere around thirty hertz on top
   * of the pitch. That is the amplitude modulator below, and it is doing more
   * for this than the oscillators are. On top of that: an intake of breath
   * before it, four vocal layers driven into saturation, a chest sub that falls
   * away underneath, and enough of the long reverb that the valley answers.
   */
  roar(place: Place = {}) {
    const ctx = this.ctx
    if (!ctx || !this.drive) return
    const dest = this.voice(PRI.high, 2.2, LEVELS.roar, place, 2.2, true)
    if (!dest) return
    this.duck(0.45)
    const t0 = this.t + this.travel(place)
    const pitch = rand(0.94, 1.07)

    // Breath in.
    this.noise(dest, 0.26, 0.1, 'bandpass', 380, 900, 0, 1.4, 0.12)

    const start = 0.24
    const dur = 1.55

    // The flutter. Its rate rises through the roar, which is what stops the
    // rasp sounding like a tremolo pedal.
    const am = ctx.createGain()
    am.gain.value = 0.62
    const lfo = ctx.createOscillator()
    lfo.type = 'triangle'
    lfo.frequency.setValueAtTime(26 * pitch, t0 + start)
    lfo.frequency.linearRampToValueAtTime(44 * pitch, t0 + start + dur)
    const lfoGain = ctx.createGain()
    lfoGain.gain.value = 0.38
    lfo.connect(lfoGain)
    lfoGain.connect(am.gain)
    lfo.start(t0 + start)
    lfo.stop(t0 + start + dur + 0.1)

    const shaper = ctx.createWaveShaper()
    shaper.curve = this.drive
    shaper.oversample = '2x'
    am.connect(shaper)

    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, t0 + start)
    env.gain.exponentialRampToValueAtTime(1, t0 + start + 0.09)
    env.gain.setValueAtTime(1, t0 + start + dur * 0.55)
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur)
    // Vocal tract of something with a head the size of a bucket.
    this.formants(env, shaper, [330, 980, 2100], [1, 0.42, 0.14], 5)
    env.connect(dest)

    for (const [type, f0, f1, level] of [
      ['sawtooth', 128, 62, 0.5],
      ['square', 84, 41, 0.3],
      ['sawtooth', 191, 93, 0.18],
    ] as const) {
      const osc = ctx.createOscillator()
      osc.type = type
      osc.frequency.setValueAtTime(f0 * pitch, t0 + start)
      osc.frequency.exponentialRampToValueAtTime(f1 * pitch, t0 + start + dur)
      const g = ctx.createGain()
      g.gain.value = level
      osc.connect(g)
      g.connect(am)
      osc.start(t0 + start)
      osc.stop(t0 + start + dur + 0.1)
    }

    // Chest. Below the formants, unmodulated, so there is something solid under
    // the rasp rather than the whole roar chattering.
    this.tone(dest, 'sine', 68 * pitch, 34, dur * 0.95, 0.5, start, 0.05)
    // Throat air.
    this.noise(dest, dur, 0.16, 'bandpass', 1500, 500, start, 0.9, 0.06)
  }

  /** A warning from the back of the throat. The roar's little brother. */
  growl(place: Place = {}) {
    const ctx = this.ctx
    if (!ctx) return
    const dest = this.voice(PRI.low, 0.6, LEVELS.growl, place, 1.1)
    if (!dest) return
    const pitch = rand(0.9, 1.12)
    const t = this.t
    const dur = rand(0.38, 0.55)

    const am = ctx.createGain()
    am.gain.value = 0.6
    const lfo = ctx.createOscillator()
    lfo.type = 'triangle'
    lfo.frequency.value = rand(22, 33)
    const lg = ctx.createGain()
    lg.gain.value = 0.4
    lfo.connect(lg)
    lg.connect(am.gain)
    lfo.start(t)
    lfo.stop(t + dur + 0.05)

    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, t)
    env.gain.exponentialRampToValueAtTime(0.32, t + 0.05)
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    this.formants(env, am, [300, 820, 1900], [1, 0.3, 0.08], 6)
    env.connect(dest)

    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(96 * pitch, t)
    osc.frequency.exponentialRampToValueAtTime(64 * pitch, t + dur)
    osc.connect(am)
    osc.start(t)
    osc.stop(t + dur + 0.05)

    this.noise(dest, dur, 0.06, 'lowpass', 600, 220)
  }

  /**
   * The paw moving. Fired when the swing starts, not when it lands — a melee
   * hit with no whoosh in front of it always reads as late, because the ear
   * expects to hear the arm before it hears the impact.
   */
  swipeWhoosh(side: number, heavy = false) {
    const ctx = this.ctx
    const dest = this.voice(PRI.normal, 0.3, LEVELS.swipe, {}, 0.5)
    if (!ctx || !dest) return
    const dur = heavy ? 0.26 : 0.19
    const t = this.t

    // The paw crosses in front of the face, so the sound crosses with it. A
    // whoosh that sits in the middle of the image is a sound effect; one that
    // travels is a limb.
    let mid: GainNode = dest
    if (ctx.createStereoPanner) {
      mid = ctx.createGain()
      const p = ctx.createStereoPanner()
      const from = side < 0 ? -0.55 : 0.55
      p.pan.setValueAtTime(from, t)
      p.pan.linearRampToValueAtTime(-from * 0.7, t + dur)
      mid.connect(p)
      p.connect(dest)
    }

    // Two bands sweeping past each other is what turns a noise fade into
    // something moving through air.
    this.noise(mid, dur, heavy ? 0.34 : 0.26, 'bandpass', rand(400, 550), rand(1600, 2200), 0, 1.6)
    this.noise(mid, dur * 0.8, 0.2, 'highpass', 1800, 4200, 0.02, 0.8)
    // Displaced air. Without this the whoosh is all hiss and reads as a sword
    // rather than as a limb with a hundred kilos of cat behind it — a paw that
    // wide pushes a slug of low-mid ahead of itself, and the ear uses exactly
    // that to judge how heavy the thing swinging is.
    //
    // It is a *slug*, though, not the sound itself. Carrying it at the level it
    // used to be left the swing measuring 86% below 250 Hz — the air layers it
    // is supposed to sit under were 15 dB down, and the whoosh had no whoosh in
    // it. It gives weight from underneath; it does not get to be the sound.
    this.noise(mid, dur * 1.1, heavy ? 0.15 : 0.1, 'lowpass', rand(260, 340), rand(90, 130), 0.01, 1.1, 0.05)
    this.tone(mid, 'sine', heavy ? 190 : 240, heavy ? 70 : 96, dur * 0.75, heavy ? 0.09 : 0.045, 0.01, 0.04)
    // Fur moving through its own air, up where the ear places motion.
    this.noise(mid, dur * 0.9, 0.07, 'bandpass', rand(3000, 4200), rand(5500, 7500), 0.01, 0.9, 0.03)
  }

  /**
   * Claws into a body. Four layers: the tip catching, the flat of the paw
   * landing, the tear that follows it, and a sub thump so it has weight.
   */
  clawHit(place: Place = {}) {
    const dest = this.voice(PRI.high, 0.4, LEVELS.clawHit, place, 1.0, true)
    if (!dest) return
    const j = rand(0.88, 1.14)

    // Transient — the very first millisecond, which is all the ear needs to
    // decide something sharp happened. Kept well under the layers behind it:
    // measured, a fatter transient took the strike's peak *above* a rifle going
    // off while leaving it four decibels quieter, which is the worst of both.
    // The ear reads sharpness from the transient and force from what follows.
    //
    // Its corner also sits well below the rifle's. Measured, a claw strike and a
    // close gunshot were the two most confusable sounds in the game — both loud,
    // both broadband, both instant — which in play means not knowing whether you
    // just hit someone or just got shot. A claw is not a blast: it is duller on
    // the very top and far wetter underneath, and separating them there is what
    // makes the two unmistakable without making either quieter.
    this.noise(dest, 0.022, 0.2, 'highpass', 3600 * j, 2200, 0, 0.7, 0.0012)
    // Flat impact on a torso.
    this.noise(dest, 0.14, 0.6, 'lowpass', 900 * j, 220, 0.004, 1.2, 0.002)
    this.tone(dest, 'triangle', 330 * j, 88, 0.13, 0.28, 0.004, 0.002)
    // Wet drag. Bandpassed noise with a slow tail is cloth and skin opening —
    // and it is the claw's identity, so it carries rather than garnishes.
    this.noise(dest, 0.34, 0.46, 'bandpass', 1400 * j, 620, 0.02, 2.4, 0.012)
    // Tissue and cloth separating fibre by fibre.
    this.grains(dest, 8, 0.2, 0.16, 800, 3600, 0.006, 0.03, 0.025, 2.8, 0.5)
    // Weight.
    this.tone(dest, 'sine', 130, 44, 0.24, 0.42, 0, 0.003)
  }

  /**
   * The killing bite. Bone first — a handful of irregular cracks, because a
   * neck does not break on a metronome — then the wet part, then the drop.
   */
  biteKill(place: Place = {}) {
    const dest = this.voice(PRI.high, 0.7, LEVELS.biteKill, place, 1.4, true)
    if (!dest) return
    this.duck(0.22)
    const j = rand(0.9, 1.1)

    // Jaws closing.
    this.noise(dest, 0.05, 0.3, 'lowpass', 2200, 600, 0, 1, 0.001)
    // Bone. Short resonant cracks, scattered over 90 ms.
    for (let i = 0; i < 4; i++) {
      const at = 0.03 + i * rand(0.014, 0.032)
      this.noise(dest, rand(0.012, 0.03), rand(0.2, 0.42), 'bandpass', rand(700, 2600) * j, rand(300, 900), at, 9, 0.0008)
    }
    this.tone(dest, 'triangle', 900 * j, 180, 0.05, 0.2, 0.035, 0.001)
    // Tear.
    this.noise(dest, 0.34, 0.3, 'lowpass', 1600 * j, 240, 0.05, 1.6, 0.008)
    this.noise(dest, 0.26, 0.16, 'bandpass', 2800, 900, 0.07, 3.2, 0.02)
    // Spray, and the body going down.
    this.noise(dest, 0.2, 0.1, 'highpass', 3600, 1400, 0.11, 0.8, 0.01)
    this.tone(dest, 'sine', 96, 36, 0.4, 0.42, 0.02, 0.006)
  }

  /**
   * A human being. The pitch contour — snap up, hold, break, fall away — is
   * what makes this read as a person rather than as a siren, and the formants
   * pick the vowel: a wide open "aa" for terror.
   */
  scream(place: Place = {}, pitch = 1) {
    const ctx = this.ctx
    if (!ctx) return
    const dest = this.voice(PRI.normal, 0.9, LEVELS.scream, place, 1.3)
    if (!dest) return
    const t = this.t + this.travel(place)
    const base = 380 * pitch * rand(0.9, 1.12)
    const dur = rand(0.55, 0.8)

    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(base * 0.7, t)
    osc.frequency.exponentialRampToValueAtTime(base * 1.9, t + 0.06)
    osc.frequency.exponentialRampToValueAtTime(base * 1.6, t + dur * 0.45)
    osc.frequency.exponentialRampToValueAtTime(base * 0.6, t + dur)

    // Vibrato that gets wider as the voice loses control.
    const vib = ctx.createOscillator()
    vib.frequency.setValueAtTime(5.5, t)
    vib.frequency.linearRampToValueAtTime(9, t + dur)
    const vibGain = ctx.createGain()
    vibGain.gain.setValueAtTime(12, t)
    vibGain.gain.linearRampToValueAtTime(75, t + dur)
    vib.connect(vibGain)
    vibGain.connect(osc.detune)
    vib.start(t)
    vib.stop(t + dur + 0.05)

    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, t)
    env.gain.exponentialRampToValueAtTime(0.34, t + 0.035)
    env.gain.setValueAtTime(0.34, t + dur * 0.5)
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    env.connect(dest)
    // "aa" — the vowel you scream in. Scaled by pitch so a lighter voice reads
    // as a smaller person rather than as the same person sped up.
    const s = 0.85 + pitch * 0.18
    this.formants(env, osc, [780 * s, 1180 * s, 2700 * s], [1, 0.55, 0.22], 10)
    osc.start(t)
    osc.stop(t + dur + 0.05)

    // Rasp on the top of the voice.
    this.noise(dest, dur * 0.8, 0.05, 'bandpass', 2400 * pitch, 1400, this.travel(place) + 0.03, 2)
  }

  /** Not a scream — a word. Shorter, lower, and it stops dead. */
  shout(place: Place = {}, pitch = 1) {
    const ctx = this.ctx
    if (!ctx) return
    const dest = this.voice(PRI.normal, 0.5, LEVELS.shout, place, 1.2)
    if (!dest) return
    const t = this.t + this.travel(place)
    const base = 190 * pitch * rand(0.92, 1.1)
    const dur = rand(0.3, 0.42)

    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(base * 1.25, t)
    osc.frequency.exponentialRampToValueAtTime(base * 0.85, t + dur)
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, t)
    env.gain.exponentialRampToValueAtTime(0.3, t + 0.03)
    env.gain.setValueAtTime(0.3, t + dur * 0.6)
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    env.connect(dest)
    // Formants sliding from "aa" to "oh" — the shape of a shouted syllable.
    const ctxNow = t
    for (const [f0, f1, lvl, q] of [
      [720, 520, 1, 9],
      [1150, 900, 0.5, 11],
      [2600, 2400, 0.16, 13],
    ] as const) {
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.frequency.setValueAtTime(f0 * pitch, ctxNow)
      bp.frequency.linearRampToValueAtTime(f1 * pitch, ctxNow + dur)
      bp.Q.value = q
      const g = ctx.createGain()
      g.gain.value = lvl
      osc.connect(bp)
      bp.connect(g)
      g.connect(env)
    }
    osc.start(t)
    osc.stop(t + dur + 0.05)
  }

  /**
   * A bolt-action rifle.
   *
   * Five layers, and which of them you actually hear depends entirely on how
   * far away it is. Close, it is the click and the crack — the supersonic snap
   * of the bullet leaving, which is almost all high frequency and so is the
   * first thing the air eats. Far, all of that is gone and what arrives is the
   * body and the rolling tail, late, because sound takes a third of a second to
   * cross a hundred metres and this game will make you feel that.
   */
  gunshot(place: Place = {}, distance = 0) {
    const p: Place = { pan: place.pan, dist: distance, roll: AUDIO.gunRoll }
    const dest = this.voice(PRI.high, 1.2, LEVELS.gunshot, p, 1.6, true)
    if (!dest) return
    const near = 1 / (1 + distance * 0.06)
    if (distance < 26) this.duck(0.3 * near)
    const at = this.travel(p)
    const j = rand(0.94, 1.08)

    /**
     * How much top end is left by the time it arrives.
     *
     * This is the number that was missing, and it is why the old shot measured
     * identically at six metres and sixty — 1% midrange and no presence at all
     * at either. Level was the only thing distance changed, so every shot was
     * the same shot at a different volume. Real distance is a *lowpass*: it
     * takes the crack off a rifle long before it takes the weight out of it,
     * which is exactly why you can tell a near shot from a far one instantly
     * even when both are loud.
     *
     * A 22 m e-folding is steeper than dry-air absorption alone would give,
     * which is correct here: the sound is crossing scrub and a treeline, and
     * foliage scatters treble far harder than air does.
     */
    const bright = Math.exp(-distance / 22)

    // Firing pin and hammer — mechanical, and only if you are next to him.
    if (distance < 30) {
      this.noise(dest, 0.004, 0.14 * near * bright, 'highpass', 5000, 5000, at - 0.002, 0.7, 0.0004)
    }

    // The crack. Short, *high*, and its filter corner does not move.
    //
    // The old crack was a highpass sweeping 3800 Hz down to 900 over 35 ms —
    // so it spent almost its entire life as a wide-open low-mid hiss, which is
    // the opposite of a crack. Held at 2.5 kHz and over in 7 ms, the same
    // energy reads as the snap of a supersonic round leaving a barrel.
    this.noise(dest, 0.007, 0.62 * bright, 'highpass', 2500 * j, 2500 * j, at, 0.6, 0.0004)
    // The very top of it. This is nearly all that separates a rifle from a
    // shotgun, and it is the first thing distance takes away.
    this.noise(dest, 0.004, 0.4 * bright, 'bandpass', 7000 * j, 7000 * j, at + 0.0004, 0.8, 0.0003)
    // Blast edge: the broadband middle of the muzzle report.
    this.noise(dest, 0.03, 0.5 * (0.35 + 0.65 * bright), 'bandpass', 1500 * j, 1200, at + 0.001, 0.7, 0.0006)

    // Muzzle blast — the loud part, and the part that survives distance.
    this.noise(dest, 0.24, 1.05, 'lowpass', 1600 * j, 260, at + 0.002, 1.3, 0.0015)
    // The slap off the shooter's own chest and the ground under him. This band
    // is where a rifle lives once the crack has gone, and it is the reason a
    // real one is unbearable indoors and merely loud in a field.
    this.noise(dest, 0.18, 0.72, 'bandpass', 1100 * j, 500, at + 0.003, 1.1, 0.002)
    this.tone(dest, 'sine', 130 * j, 42, 0.26, 0.7, at + 0.002, 0.0015)
    this.tone(dest, 'square', 78, 34, 0.16, 0.3, at + 0.002, 0.0015)

    // Ground bounce. A rifle fired over open dirt sends a copy of itself into
    // the ground and gets it back a few milliseconds later, darker; that short
    // double is a lot of why a real shot outdoors sounds like it has a floor
    // under it rather than happening in a vacuum.
    this.noise(dest, 0.09, 0.3 * (0.4 + 0.6 * bright), 'lowpass', 1300, 300, at + rand(0.007, 0.013), 1.0, 0.001)

    // The tail. Distant shots are almost entirely this: a low roll coming back
    // off the treeline, longer and darker the further out the shooter is.
    //
    // It gets longer with distance, and *quieter* to pay for it.
    //
    // `noise` decays from its peak to silence across the whole duration it is
    // given, so stretching the tail also flattens its decay — the level an
    // instant after the shot goes up, not down. Left uncompensated that
    // swamped the distance falloff completely: a rifle measured loudest at
    // twenty-five metres and got quieter as it came towards you. Scaling the
    // peak by the square root of the stretch holds the energy constant, so
    // length reads as distance and level still reads as distance too.
    const tail = 0.35 + Math.min(1.1, distance * 0.03)
    this.noise(dest, tail, 0.24 * Math.sqrt(0.4 / tail), 'lowpass', 900, 150, at + 0.05, 0.9, 0.03)

    // Discrete slapback off the treeline and the valley wall, ahead of the
    // convolved tail.
    //
    // A reverb tail alone is a smooth wash, and smooth is what makes a gunshot
    // sound like a plugin. Outdoors you do not get a wash — you get three or
    // four separate, individually audible returns from named directions, each
    // darker and wider than the last, and *then* the wash. Panning them
    // opposite the shot puts them on the far side of the valley where they
    // belong, and is most of the reason this now reads as a place rather than
    // as an effect.
    const ctx = this.ctx
    if (ctx) {
      const echoes = distance > 12 ? 4 : 3
      for (let i = 0; i < echoes; i++) {
        const delay = 0.11 + i * rand(0.1, 0.19) + distance * 0.0016
        const lvl = 0.19 * Math.pow(0.62, i) * (0.5 + 0.5 * near)
        let d = dest
        if (ctx.createStereoPanner) {
          const g = ctx.createGain()
          const pan = ctx.createStereoPanner()
          pan.pan.value = -(place.pan ?? 0) * rand(0.4, 0.9) + rand(-0.3, 0.3)
          g.connect(pan)
          pan.connect(dest)
          d = g
        }
        this.noise(d, 0.16 + i * 0.06, lvl, 'lowpass', 1500 * Math.pow(0.68, i), 260, at + delay, 0.9, 0.012)
      }
    }

    // Working the bolt. Only audible if he is close enough to matter.
    if (distance < 22) {
      const b = at + rand(0.34, 0.46)
      this.noise(dest, 0.03, 0.14 * near, 'bandpass', 2800, 1800, b, 6, 0.001)
      this.noise(dest, 0.045, 0.1 * near, 'bandpass', 1600, 3200, b + 0.1, 5, 0.002)
      this.tone(dest, 'triangle', 2400, 1900, 0.04, 0.05 * near, b + 0.105, 0.001)
      // Brass hitting dirt.
      this.grains(dest, 2, 0.06, 0.05 * near, 3000, 6000, 0.004, 0.012, b + 0.26, 4, 0.5)
    }
  }

  /**
   * A round going past your head. The pitch falls as it passes — that is real
   * Doppler, not an effect — and the pan sweeps across with it.
   */
  bulletWhiz(place: Place = {}) {
    const ctx = this.ctx
    if (!ctx) return
    const dest = this.voice(PRI.normal, 0.35, LEVELS.bulletWhiz, { pan: 0 }, 0.4)
    if (!dest) return
    const t = this.t
    const dur = 0.1
    const side = (place.pan ?? 0) >= 0 ? 1 : -1

    // The ballistic crack. A round going past faster than sound does not
    // whistle — it drags a shock cone that arrives as a single spike, and that
    // spike is the entire identity of "someone is shooting at me". It is also
    // what keeps this from being mistaken for getting hit: it is over in three
    // milliseconds and has no low end underneath it at all.
    let crackDest = dest
    if (ctx.createStereoPanner) {
      const g = ctx.createGain()
      const pan = ctx.createStereoPanner()
      pan.pan.value = -0.7 * side
      g.connect(pan)
      pan.connect(dest)
      crackDest = g
    }
    this.noise(crackDest, 0.003, 0.75, 'highpass', 3500, 3500, 0, 0.6, 0.0003)
    this.noise(crackDest, 0.0025, 0.5, 'bandpass', 8000, 8000, 0.0003, 0.9, 0.0003)

    // The zip behind it, dropping in pitch as it goes by. This is real Doppler:
    // the band falls because the source is receding, and the pan sweeps with it.
    const src = ctx.createBufferSource()
    src.buffer = this.noiseShort
    src.loop = true
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.setValueAtTime(rand(4200, 5200), t)
    bp.frequency.exponentialRampToValueAtTime(rand(1500, 2000), t + dur)
    bp.Q.value = 3.2
    // Keep the body of the zip out of the low end, so it stays a passing round
    // rather than a thump. The old one measured 44% sub, which is why it read
    // as an impact.
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 900
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, t)
    env.gain.exponentialRampToValueAtTime(0.3, t + 0.008)
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    src.connect(bp)
    bp.connect(hp)
    hp.connect(env)
    if (ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner()
      pan.pan.setValueAtTime(-0.9 * side, t)
      pan.pan.linearRampToValueAtTime(0.9 * side, t + dur)
      env.connect(pan)
      pan.connect(dest)
    } else {
      env.connect(dest)
    }
    src.start(t, Math.random() * 0.5)
    src.stop(t + dur + 0.02)

    // Where it landed, a moment later — dirt kicked up, off to one side.
    this.grains(dest, 5, 0.08, 0.13, 1200, 5000, 0.004, 0.014, dur + 0.03, 1.6, 0.8)
    this.noise(dest, 0.07, 0.11, 'lowpass', 900, 260, dur + 0.03, 1.2, 0.001)
  }

  /**
   * Taking a round.
   *
   * This has to be the least ambiguous sound in the game. It is the one event
   * the player must identify instantly, without looking at the health bar, and
   * without confusing it for a near miss, a kill, or a feed — so it is built
   * around one thing nothing else in the mix is allowed to do: **a sustained
   * pure high tone.** Every other sound here is noise, formants or a low
   * oscillator. The ring is the signature, and it works because a listener can
   * pick a steady sine out of a broadband mix at almost any level.
   *
   * The rest is the physical event, in the order it happens: the shock of the
   * round arriving, the wet slap of it entering, the body absorbing it, the
   * animal's own cry heard from inside its skull, and blood in the ears while
   * the concussion filter drags the whole world dark for a beat.
   */
  hurt() {
    const ctx = this.ctx
    const dest = this.voice(PRI.high, 1.2, LEVELS.hurt, {}, 0.9, true)
    if (!dest) return
    this.concuss(0.8)
    this.duck(0.55)

    // The round arriving — a hard, bright edge, and then meat.
    this.noise(dest, 0.004, 0.32, 'highpass', 3200, 3200, 0, 0.7, 0.0004)
    // Wet entry. Granular and mid-forward: this is the layer that says flesh
    // rather than drum, and the old version had nothing like it.
    this.grains(dest, 7, 0.045, 0.2, 700, 3400, 0.004, 0.016, 0.001, 2.2, 0.35)
    this.noise(dest, 0.05, 0.42, 'lowpass', 1500, 300, 0, 1.1, 0.0012)
    // The body taking it.
    this.tone(dest, 'sine', 170, 52, 0.2, 0.4, 0, 0.002)
    this.tone(dest, 'sine', 68, 30, 0.32, 0.3, 0.004, 0.004)

    if (ctx) {
      const t = this.t + 0.03

      // The cry. Built like the roar rather than as a bare sawtooth — a
      // fluttering, saturated source through a wide-open tract — because a
      // wounded animal's voice tears in exactly the way a clean oscillator
      // cannot. The pitch snaps up, breaks, and collapses.
      const am = ctx.createGain()
      am.gain.value = 0.6
      const lfo = ctx.createOscillator()
      lfo.type = 'triangle'
      lfo.frequency.setValueAtTime(38, t)
      lfo.frequency.linearRampToValueAtTime(62, t + 0.4)
      const lg = ctx.createGain()
      lg.gain.value = 0.45
      lfo.connect(lg)
      lg.connect(am.gain)
      lfo.start(t)
      lfo.stop(t + 0.46)

      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.setValueAtTime(230, t)
      osc.frequency.exponentialRampToValueAtTime(430, t + 0.05)
      osc.frequency.exponentialRampToValueAtTime(120, t + 0.42)
      osc.connect(am)
      osc.start(t)
      osc.stop(t + 0.45)

      const env = ctx.createGain()
      env.gain.setValueAtTime(0.0001, t)
      env.gain.exponentialRampToValueAtTime(0.3, t + 0.03)
      env.gain.exponentialRampToValueAtTime(0.0001, t + 0.42)
      env.connect(dest)
      if (this.drive) {
        const sh = ctx.createWaveShaper()
        sh.curve = this.drive
        sh.oversample = '2x'
        am.connect(sh)
        this.formants(env, sh, [420, 1250, 2600], [1, 0.4, 0.12], 7)
      } else {
        this.formants(env, am, [420, 1250, 2600], [1, 0.4, 0.12], 7)
      }

      // Tinnitus. The signature — and the only sustained pure tone in the game.
      //
      // It comes in a beat *after* the impact rather than with it, which is
      // both what actually happens and what keeps it from being buried by the
      // transient. Two detuned partials beat slowly against each other so it
      // shimmers instead of sitting there like a test tone.
      const ring = ctx.createGain()
      ring.gain.setValueAtTime(0.0001, t)
      ring.gain.exponentialRampToValueAtTime(0.075, t + 0.09)
      ring.gain.exponentialRampToValueAtTime(0.0001, t + 1.5)
      ring.connect(dest)
      const rf = rand(4100, 4900)
      for (const [mult, lvl] of [[1, 1], [1.006, 0.7], [2.02, 0.22]] as const) {
        const o = ctx.createOscillator()
        o.type = 'sine'
        o.frequency.value = rf * mult
        const g = ctx.createGain()
        g.gain.value = lvl
        o.connect(g)
        g.connect(ring)
        o.start(t)
        o.stop(t + 1.55)
      }
    }

    // Blood in the ears.
    this.noise(dest, 0.5, 0.08, 'lowpass', 300, 90, 0.05, 1, 0.02)
  }

  /**
   * One mouthful, while feeding.
   *
   * Eating used to fire `biteKill` — the identical sound to killing someone —
   * and the seconds of feeding before it were silent. So the single most
   * repeated action in the game had no voice of its own and its payoff was
   * indistinguishable from a kill.
   *
   * A chew is deliberately built out of everything a kill is not: no bone, no
   * transient, no sub. It is slow, wet, mid-heavy and *soft-edged* — the attack
   * is twenty times longer than any impact in the game — so it can repeat every
   * few hundred milliseconds without fatiguing, and can never be mistaken for
   * damage in either direction.
   */
  chew() {
    const dest = this.voice(PRI.low, 0.4, LEVELS.chew, {}, 0.7)
    if (!dest) return
    const j = rand(0.86, 1.18)
    // Jaw closing through soft tissue — no edge on it at all.
    this.noise(dest, rand(0.1, 0.16), 0.22 * j, 'bandpass', 480 * j, 260, 0, 1.5, 0.022)
    // Wet fibre separating. Granular, so each mouthful is its own mouthful, and
    // the band runs well up into the mids — the detail that reads as *wet* is
    // all above 1 kHz, and without it a chew is just a soft thud.
    this.grains(dest, 7, 0.13, 0.26, 700, 4200, 0.006, 0.026, 0.01, 2.6, 0.45)
    // Suction as the jaw opens again.
    this.noise(dest, 0.09, 0.16 * j, 'bandpass', 1800 * j, 900, rand(0.11, 0.17), 3.2, 0.02)
    // Just enough body that it has a mouth around it.
    this.tone(dest, 'sine', 120 * j, 78, 0.14, 0.09, 0.005, 0.02)
  }

  /**
   * Swallowing — the payoff at the end of a feed, and the meat pickup.
   *
   * A descending wet gulp. Nothing else in the game falls in pitch through the
   * low mids like this, which is what makes "I got the health" legible without
   * a toast.
   */
  gulp(big = false) {
    const dest = this.voice(PRI.normal, 0.5, LEVELS.pickup, {}, 0.6, true)
    if (!dest) return
    const j = rand(0.92, 1.1)
    // The throat working, top to bottom.
    this.noise(dest, big ? 0.26 : 0.18, big ? 0.24 : 0.17, 'bandpass', 900 * j, 260 * j, 0, 2.8, 0.015)
    this.tone(dest, 'sine', 260 * j, 90 * j, big ? 0.3 : 0.22, big ? 0.2 : 0.14, 0.01, 0.02)
    this.grains(dest, big ? 5 : 3, 0.1, 0.07, 500, 2200, 0.006, 0.022, 0.02, 2.4, 0.35)
    // Settling.
    if (big) this.tone(dest, 'sine', 70, 44, 0.4, 0.22, 0.1, 0.03)
  }

  /** Meat. Not a coin — a wet, low, satisfying swallow. */
  pickup() {
    this.gulp(false)
  }

  /**
   * A buff landing. Built on the score's own root and fifth so it lands in key
   * with whatever is playing rather than across it.
   */
  powerup() {
    const dest = this.voice(PRI.normal, 0.7, LEVELS.powerup, {}, 1.4, true)
    if (!dest) return
    const root = 220
    // A rising fourth-stack, which is the interval every "you got stronger"
    // cue in the medium is built on.
    for (const [i, mult] of [1, 1.5, 2, 3].entries()) {
      this.tone(dest, 'triangle', root * mult, root * mult * 1.002, 0.42, 0.13, i * 0.05, 0.01)
      this.tone(dest, 'sine', root * mult * 2, root * mult * 2, 0.3, 0.05, i * 0.05, 0.01)
    }
    this.tone(dest, 'sine', 55, 55, 0.7, 0.28, 0, 0.02)
    this.noise(dest, 0.5, 0.05, 'highpass', 3000, 8000, 0, 0.7, 0.2)
  }

  /**
   * Leaving the ground.
   *
   * The old version of this was a sawtooth run through vowel formants, which is
   * a synthesiser making an "uh" noise, not an animal jumping. A pounce is
   * three physical events and only one of them is voiced: the hind claws
   * digging in and tearing a divot out of the ground, the body's own mass
   * loading and releasing, and an involuntary exhale forced out by the
   * abdominal wall — which is *breath*, mostly noise, with only a trace of
   * vocal fold under it.
   *
   * The push-off is the loudest part and it is the part that was missing
   * entirely. It is what tells you the jump had a hundred kilos behind it.
   */
  pounce() {
    const ctx = this.ctx
    const dest = this.voice(PRI.normal, 0.5, LEVELS.pounce, {}, 0.5)
    if (!ctx || !dest) return
    const t = this.t
    const j = rand(0.92, 1.1)

    // Claws into dirt, and the divot coming out. Granular and spread over a
    // long window rather than stacked on the first millisecond.
    //
    // A pounce must not read as an impact. Measured against a close rifle it
    // was the second most confusable pair in the game, for the same reason the
    // claw strike was: an instant broadband attack with a low thump under it
    // describes a gunshot exactly. So the push-off *swells* — the ground loads
    // over eighty milliseconds before it lets go — and the sound's centre of
    // mass is the breath, which nothing else here has.
    this.grains(dest, 8, 0.13, 0.055, 700, 4200, 0.006, 0.022, 0.005, 1.5, 0.5)
    this.noise(dest, 0.13, 0.06, 'lowpass', 620 * j, 190, 0, 1.1, 0.03)
    // Soil compressing under the load.
    this.tone(dest, 'sine', 96 * j, 52, 0.16, 0.055, 0, 0.03)

    // The exhale. Noise through a slightly open tract, so it is a breath with a
    // voice behind it rather than a vowel: the formants are fed from the noise,
    // and the sawtooth sits underneath at a fifth of the level just to give the
    // breath a pitch centre.
    const bs = ctx.createBufferSource()
    bs.buffer = this.noiseShort
    bs.loop = true
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.setValueAtTime(720 * j, t + 0.01)
    bp.frequency.exponentialRampToValueAtTime(340 * j, t + 0.26)
    bp.Q.value = 0.9
    const breath = ctx.createGain()
    breath.gain.setValueAtTime(0.0001, t + 0.01)
    breath.gain.exponentialRampToValueAtTime(0.22, t + 0.06)
    breath.gain.exponentialRampToValueAtTime(0.0001, t + 0.34)
    bs.connect(bp)
    bp.connect(breath)
    breath.connect(dest)
    bs.start(t + 0.01, Math.random() * 0.4)
    bs.stop(t + 0.32)
    this.formants(breath, bp, [520 * j, 1150, 2500], [0.5, 0.22, 0.07], 4)

    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(128 * j, t + 0.012)
    osc.frequency.exponentialRampToValueAtTime(88, t + 0.22)
    const ve = ctx.createGain()
    ve.gain.setValueAtTime(0.0001, t + 0.012)
    ve.gain.exponentialRampToValueAtTime(0.045, t + 0.04)
    ve.gain.exponentialRampToValueAtTime(0.0001, t + 0.24)
    osc.connect(ve)
    ve.connect(dest)
    osc.start(t + 0.012)
    osc.stop(t + 0.26)

    // Fur and the air it drags. Quiet, but it is the part that reads as a body.
    this.noise(dest, 0.3, 0.03, 'highpass', 2600, 1500, 0.03, 0.7, 0.05)
  }

  /**
   * Two hundred kilos arriving. Pads, then the dirt, then the chest.
   *
   * `force` is roughly how fast it hit, normalised so 1 is a landing off a flat
   * run and 2 is the end of a full pounce arc. It moves everything at once —
   * level, how much soil is displaced, whether the air gets knocked out — which
   * is the whole difference between a hop and a crash, and is what stops every
   * landing in the game sounding like the same landing.
   */
  land(force = 1) {
    const dest = this.voice(PRI.normal, 0.6, LEVELS.land, {}, 0.8, true)
    if (!dest) return
    const f = Math.max(0.35, Math.min(2.2, force))
    const j = rand(0.9, 1.12)

    // Pad slap. Fast, but not a click — the cushion takes the edge off.
    this.noise(dest, 0.055, 0.2 * f, 'bandpass', 520 * j, 300, 0, 1.1, 0.0012)
    // The ground taking the weight.
    this.noise(dest, 0.1, 0.3 * f, 'lowpass', 460 * j, 120, 0.002, 1.2, 0.0015)
    this.tone(dest, 'sine', 88 * j, 36, 0.24, 0.26 * f, 0, 0.003)
    // Soil and grit thrown out sideways from under the paws. Granular and wide:
    // this is the layer that says "dirt" rather than "drum", and the old single
    // highpassed hiss did not survive the mix at all.
    this.grains(dest, Math.round(6 + f * 5), 0.13, 0.16 * f, 1400, 7000, 0.003, 0.014, 0.006, 1.6, 0.75)
    // Dry litter kicked up, quieter and later than the grit.
    this.grains(dest, 4, 0.22, 0.07 * f, 2600, 9000, 0.004, 0.02, 0.03, 1.3, 0.85)
    // Air forced out of the chest, but only when it actually hurt.
    if (f > 1.15) {
      this.noise(dest, 0.2, 0.06 * (f - 1), 'bandpass', 620, 300, 0.02, 1.2, 0.02)
    }
  }

  /**
   * A paw on ground.
   *
   * Pads are soft, so there is no click — but the old version was *only* the
   * pad, a lowpassed thud with an optional whisper of grass twenty decibels
   * under it. Measured, it was 100% sub and low: a kick drum, not a footfall.
   * What identifies a surface is entirely in the top four octaves, and it has
   * to be at a level comparable to the thud, not hidden beneath it.
   *
   * The litter is granular rather than a single hiss because dry ground is a
   * few dozen separate small collisions, and because grains at random times,
   * bands and pan positions mean no two of the ten thousand steps a player
   * hears are the same step.
   */
  footstep(place: Place = {}, heavy = false) {
    const dest = this.voice(PRI.low, 0.3, LEVELS.footstep, place, 0.35)
    if (!dest) return
    const j = rand(0.85, 1.2)
    const w = heavy ? 1 : 0.68

    // The pad. Soft-edged and short.
    this.noise(dest, heavy ? 0.09 : 0.07, 0.1 * w * j, 'lowpass', 400 * j, 150, 0, 1.2, 0.002)
    // Weight through the leg.
    this.tone(dest, 'sine', 78 * j, 44, heavy ? 0.1 : 0.08, 0.06 * w, 0, 0.0025)
    // Ground litter. Always present — a step with no surface in it is a thump.
    this.grains(
      dest,
      heavy ? 5 : 4,
      heavy ? 0.05 : 0.07,
      (heavy ? 0.09 : 0.065) * j,
      1800,
      heavy ? 7500 : 6000,
      0.003,
      0.012,
      0.001,
      1.7,
      0.6,
    )
    // A blade of grass caught and released, or a claw over grit. Occasional, so
    // the gait has variety rather than a fixed signature.
    if (Math.random() < 0.45) {
      this.noise(dest, rand(0.03, 0.07), rand(0.018, 0.032), 'bandpass', rand(3200, 6500), rand(1600, 3000), rand(0.005, 0.03), 2.2, 0.002)
    }
  }

  /** The hunt turning over. A cinematic drop, and the score answers it. */
  waveStart(wave = 1) {
    const dest = this.voice(PRI.high, 3, LEVELS.waveStart, {}, 2.5, true)
    if (!dest) return
    this.duck(0.35)
    // Sub drop.
    this.tone(dest, 'sine', 96, 30, 1.8, 0.55, 0, 0.02)
    this.tone(dest, 'sawtooth', 144, 45, 1.4, 0.1, 0, 0.05)
    // Impact.
    this.noise(dest, 0.3, 0.32, 'lowpass', 2200, 200, 0, 1.1, 0.002)
    // A struck metal edge — the gong under a title card.
    this.noise(dest, 2.2, 0.09, 'bandpass', 1400, 500, 0.01, 2.4, 0.006)
    this.music?.stinger(wave)
  }

  /** The end. Everything falls, and the reverb keeps it for a while. */
  gameOver() {
    const dest = this.voice(PRI.high, 4, LEVELS.gameOver, {}, 3, true)
    if (!dest) return
    this.music?.setMode('dead')
    this.tone(dest, 'sine', 150, 32, 3.0, 0.45, 0, 0.05)
    this.tone(dest, 'sawtooth', 224, 47, 2.6, 0.13, 0.05, 0.1)
    this.tone(dest, 'sawtooth', 226, 47.5, 2.6, 0.13, 0.05, 0.1)
    this.noise(dest, 2.8, 0.1, 'lowpass', 1200, 90, 0, 1, 0.02)
    // One last breath out.
    this.noise(dest, 1.2, 0.07, 'bandpass', 700, 300, 0.5, 1.6, 0.2)
  }

  /** Chain kills climb the score's own scale, so the combo is musical. */
  comboTick(chain: number) {
    const dest = this.voice(PRI.normal, 0.3, LEVELS.comboTick, {}, 0.9)
    if (!dest) return
    // Minor pentatonic degrees, so a long chain arpeggiates rather than sirens.
    const steps = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24, 27]
    const semi = steps[Math.min(chain - 1, steps.length - 1)]!
    const f = 330 * Math.pow(2, semi / 12)
    this.tone(dest, 'triangle', f, f, 0.16, 0.13, 0, 0.004)
    this.tone(dest, 'sine', f * 2, f * 2, 0.1, 0.05, 0.01, 0.004)
    this.noise(dest, 0.05, 0.03, 'highpass', 6000, 9000, 0, 0.8, 0.001)
  }

  /** Rage tipping over. A held breath, then everything opens up. */
  frenzyStart() {
    const dest = this.voice(PRI.high, 2, LEVELS.frenzy, {}, 2, true)
    if (!dest) return
    this.duck(0.6)
    this.noise(dest, 0.5, 0.14, 'bandpass', 200, 3000, 0, 2.5, 0.4)
    this.tone(dest, 'sine', 42, 62, 0.6, 0.4, 0.35, 0.05)
    this.roar()
  }

  // ------------------------------------------------------------- ambience
  /**
   * The night the hunt happens in. Four beds — ground wind, canopy, insects and
   * the village — plus scattered one-shots. The insects and the village are
   * driven by how dark it is and by how alarmed the village is, so the world
   * sounds different at midnight in hunt eight than it does at dusk in hunt one.
   */
  startAmbience() {
    const ctx = this.ctx
    if (!ctx || !this.ambBus || this.ambienceStop || !this.noiseLong) return

    const stops: (() => void)[] = []

    /** A looping filtered noise bed with a slow LFO on its level. */
    const bed = (
      type: BiquadFilterType,
      freq: number,
      q: number,
      level: number,
      lfoHz: number,
      lfoDepth: number,
    ): GainNode => {
      const src = ctx.createBufferSource()
      src.buffer = this.noiseLong!
      src.loop = true
      const filt = ctx.createBiquadFilter()
      filt.type = type
      filt.frequency.value = freq
      filt.Q.value = q
      const g = ctx.createGain()
      g.gain.value = level
      const lfo = ctx.createOscillator()
      lfo.frequency.value = lfoHz
      const lg = ctx.createGain()
      lg.gain.value = lfoDepth
      lfo.connect(lg)
      lg.connect(g.gain)
      src.connect(filt)
      filt.connect(g)
      g.connect(this.ambBus!)
      src.start(Math.random() * 2)
      lfo.start()
      stops.push(() => {
        try { src.stop(); lfo.stop() } catch { /* already stopped */ }
      })
      return g
    }

    // Ground wind through the grass, and the canopy above it.
    bed('lowpass', 300, 0.7, 0.2, 0.061, 0.1)
    const canopy = bed('bandpass', 1100, 0.9, 0.055, 0.043, 0.035)

    // Insects. Crickets are a fast amplitude flutter, not a steady tone, so the
    // bed gets a second LFO up in the tens of hertz.
    const insects = bed('bandpass', 5000, 9, 0.03, 0.11, 0.02)
    const chirp = ctx.createOscillator()
    chirp.type = 'triangle'
    chirp.frequency.value = 24
    const chirpGain = ctx.createGain()
    chirpGain.gain.value = 0.022
    chirp.connect(chirpGain)
    chirpGain.connect(insects.gain)
    chirp.start()
    stops.push(() => { try { chirp.stop() } catch { /* already stopped */ } })

    // The village: a low murmur of voices and fires, always slightly to one side.
    const village = bed('bandpass', 420, 1.6, 0.02, 0.037, 0.012)

    this.ambienceStop = () => {
      for (const s of stops) s()
      if (this.ambienceTimer !== null) clearInterval(this.ambienceTimer)
      this.ambienceTimer = null
      this.ambienceStop = null
    }

    // Level rebalance + scattered one-shots on one slow timer.
    this.ambienceTimer = setInterval(() => {
      const now = ctx.currentTime
      const dark = this.ambDarkness
      insects.gain.setTargetAtTime(0.012 + dark * 0.055, now, 3)
      canopy.gain.setTargetAtTime(0.04 + (1 - dark) * 0.04, now, 3)
      // An alarmed village is a loud one.
      village.gain.setTargetAtTime(0.012 + Math.min(0.05, this.ambWave * 0.008), now, 3)
      this.ambientOneShot()
    }, 1700) as unknown as number
  }

  /** How dark it is and how far into the night we are; shapes the ambience. */
  setAmbience(darkness: number, wave: number) {
    this.ambDarkness = Math.max(0, Math.min(1, darkness))
    this.ambWave = wave
  }

  /** Birds by day, jackals and village dogs after dark. Rare, and never centred. */
  private ambientOneShot() {
    const roll = Math.random()
    const dark = this.ambDarkness
    // Decide *before* building anything: the branches below do not cover every
    // roll, and the ones that fall through used to leave a routing chain wired
    // to the bus with nothing ever feeding it.
    if (!((dark < 0.4 && roll < 0.14) || (dark > 0.45 && roll < 0.1) || roll < 0.22)) return
    const dest = this.voice(PRI.low, 0.5, LEVELS.distantShot, { pan: rand(-0.9, 0.9), dist: rand(35, 95) }, 2.2)
    if (!dest) return

    if (dark < 0.4 && roll < 0.14) {
      // Daytime bird — a few quick descending whistles.
      const n = 2 + Math.floor(Math.random() * 3)
      const f = rand(1800, 3200)
      for (let i = 0; i < n; i++) {
        this.tone(dest, 'sine', f * rand(0.95, 1.05), f * 0.75, 0.09, 0.22, i * rand(0.1, 0.17), 0.01)
      }
    } else if (dark > 0.45 && roll < 0.1) {
      // A dog in the village, and once the hunts are late, several.
      const barks = this.ambWave > 3 ? 3 : 2
      for (let i = 0; i < barks; i++) {
        const at = i * rand(0.22, 0.38)
        this.noise(dest, 0.06, 0.5, 'bandpass', rand(600, 900), 300, at, 2.5, 0.003)
        this.tone(dest, 'sawtooth', rand(300, 420), 160, 0.1, 0.3, at, 0.004)
      }
    } else if (roll < 0.22) {
      // Something moving in the scrub. Nothing you can see.
      this.noise(dest, rand(0.15, 0.4), 0.4, 'bandpass', rand(2200, 4000), rand(1200, 2000), 0, 1.4, 0.05)
    }
  }

  // ---------------------------------------------------------------- score
  /** Bring the music in. Safe to call more than once. */
  startMusic() {
    this.music?.start()
  }

  /**
   * Advance the score from the render loop.
   *
   * The transport keeps its own backstop timer for when the loop is not
   * running, but a timer is the wrong clock to sequence music from — it is the
   * first thing a browser throttles. requestAnimationFrame is not, so while
   * the tab is visible this is what actually keeps the beat.
   */
  tickMusic() {
    this.music?.tick()
  }

  /** Which hunt we are on — unlocks layers and, past hunt 4, changes the mode. */
  setWave(wave: number) {
    this.music?.setWave(wave)
  }

  /**
   * How much trouble the player is in, 0..1. Opens and closes the arrangement
   * and pushes the tempo. Called every frame; the score smooths it itself.
   */
  setIntensity(level: number) {
    this.music?.setIntensity(level)
  }

  setFrenzy(on: boolean) {
    this.music?.setFrenzy(on)
  }

  setMusicMode(mode: MusicMode) {
    this.music?.setMode(mode)
  }
}

export const audio = new Audio()
