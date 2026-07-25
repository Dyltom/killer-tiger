/**
 * The adaptive score.
 *
 * One piece of music runs for the whole session. There is no track to loop and
 * no crossfade between "exploration" and "combat" stems, because there are no
 * stems — every note is synthesised as it is scheduled, so the arrangement can
 * change on the next sixteenth rather than on the next loop point.
 *
 * Two signals drive it. `wave` is the hunt number, which unlocks layers and
 * turns the mode from plain minor to Phrygian dominant once the village stops
 * being surprised and starts hunting back. `intensity` is how much trouble the
 * player is in right now, which is what actually opens and closes those layers
 * bar to bar. Tempo rides both.
 *
 * Scheduling is the standard two-clock arrangement: a coarse `setInterval`
 * wakes up every ~30 ms and queues every note that falls inside the next fifth
 * of a second onto the audio clock, which is sample-accurate. Nothing is ever
 * played "now" — jitter in the timer never reaches the music.
 */
import { MUSIC } from '../config'

/** Sixteenths per bar. Everything below is written against this grid. */
const STEPS = 16

/** Aeolian: ordinary minor. The first three hunts, before anyone is organised. */
const AEOLIAN = [0, 2, 3, 5, 7, 8, 10]
/**
 * Phrygian dominant. A flat second over a major third — the interval that has
 * carried menace in every score set anywhere east of Suez, and the one the
 * later hunts turn on.
 */
const PHRYGIAN_DOM = [0, 1, 4, 5, 7, 8, 10]

/**
 * The groove. Velocity per sixteenth for the frame drum, patterned after a
 * dholak keherwa rather than a rock backbeat: the weight is on 1 and the
 * halfway point, and the space between them is filled with palm strokes.
 */
const FRAME_PATTERN = [1.0, 0, 0.45, 0.3, 0.75, 0, 0.4, 0.5, 0.95, 0, 0.35, 0.55, 0.7, 0.3, 0.5, 0.4]

/** Which sixteenths the sitar ostinato speaks on, and what degree it plays. */
const OSTI_MASK = [1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0]
const OSTI_DEGREE = [0, 0, 2, 4, 0, 3, 2, 0, 4, 0, 3, 2, 0, 1, 2, 0]

/**
 * Harmonic movement, in scale degrees, one per bar of a four-bar phrase. i - i
 * - iv - v in minor; in Phrygian dominant the second degree is that flat
 * second, so the same shape comes out as i - i - bII - v and the third bar is
 * the one that makes the room tilt.
 */
const PROGRESSION = [0, 0, 3, 4]
const PROGRESSION_LATE = [0, 0, 1, 4]

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** Smooth 0..1 ramp — layers come up over a range of intensity, not on a switch. */
function ramp(v: number, from: number, to: number): number {
  if (to <= from) return v >= to ? 1 : 0
  const t = clamp01((v - from) / (to - from))
  return t * t * (3 - 2 * t)
}

/** Deterministic per-bar variation, so phrases differ but never sound random. */
function hash(n: number): number {
  let t = (n + 0x9e3779b9) >>> 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export type MusicMode = 'menu' | 'hunt' | 'dead'

interface Layers {
  drone: number
  pulse: number
  bass: number
  frame: number
  ostinato: number
  taiko: number
  brass: number
  choir: number
  strings: number
}

export class Music {
  private noise: AudioBuffer
  /** Per-layer output gains, so the mix can breathe without re-voicing notes. */
  private dry: GainNode
  private drone: GainNode | null = null
  private droneOscs: OscillatorNode[] = []

  private timer: number | null = null
  private droneTimer: number | null = null
  private nextStepTime = 0
  private step = 0
  private bar = 0

  private wave = 1
  private target = 0
  private smoothed = 0
  private lastTick = 0
  private frenzy = false
  private mode: MusicMode = 'menu'

  constructor(
    private ctx: BaseAudioContext,
    out: GainNode,
    private verb: GainNode,
  ) {
    this.dry = ctx.createGain()
    this.dry.gain.value = 1
    this.dry.connect(out)

    // Two seconds of white noise, reused by every percussion voice at a random
    // offset. One buffer costs 88 kB and removes every per-hit allocation.
    const n = Math.floor(ctx.sampleRate * 2)
    this.noise = ctx.createBuffer(1, n, ctx.sampleRate)
    const d = this.noise.getChannelData(0)
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1
  }

  // ------------------------------------------------------------- transport
  start() {
    if (this.timer !== null) return
    this.nextStepTime = this.ctx.currentTime + 0.08
    this.lastTick = this.ctx.currentTime
    this.startDrone()
    this.timer = setInterval(() => this.pump(), MUSIC.tickMs) as unknown as number
  }

  stop() {
    if (this.timer !== null) clearInterval(this.timer)
    if (this.droneTimer !== null) clearInterval(this.droneTimer)
    this.timer = null
    this.droneTimer = null
    for (const o of this.droneOscs) {
      try { o.stop(this.ctx.currentTime + 0.4) } catch { /* already stopped */ }
    }
    this.droneOscs = []
    this.drone = null
  }

  setWave(w: number) {
    this.wave = Math.max(1, w)
  }
  setIntensity(v: number) {
    this.target = clamp01(v)
  }
  setFrenzy(on: boolean) {
    this.frenzy = on
  }
  setMode(m: MusicMode) {
    this.mode = m
    if (m === 'menu') this.target = 0
  }

  /** Current musical energy, 0..1 — the HUD and the ambience both read it. */
  get energy(): number {
    return this.smoothed
  }

  private get bpm(): number {
    const w = Math.min(this.wave, MUSIC.waveCap) - 1
    return (
      MUSIC.bpmBase +
      w * MUSIC.bpmPerWave +
      this.smoothed * MUSIC.bpmIntensity +
      (this.frenzy ? MUSIC.bpmFrenzy : 0)
    )
  }

  private get scale(): number[] {
    return this.wave >= MUSIC.exoticFrom ? PHRYGIAN_DOM : AEOLIAN
  }

  /** Scale degree (may run past an octave) to a frequency, in the given octave. */
  private pitch(degree: number, octave = 0): number {
    const sc = this.scale
    const oct = Math.floor(degree / sc.length) + octave
    const semi = sc[((degree % sc.length) + sc.length) % sc.length]!
    return MUSIC.root * Math.pow(2, oct + semi / 12)
  }

  // ------------------------------------------------------------ scheduling
  private pump() {
    const ctx = this.ctx
    const now = ctx.currentTime
    // Chase the combat signal. Rising fast and falling slowly is what keeps a
    // fight feeling like one fight instead of a dozen stings.
    const dt = Math.max(0, Math.min(0.5, now - this.lastTick))
    this.lastTick = now
    const tau = this.target > this.smoothed ? MUSIC.riseTime : MUSIC.fallTime
    this.smoothed += (this.target - this.smoothed) * (1 - Math.exp(-dt / tau))

    if (this.mode === 'dead') return

    const spb = 60 / this.bpm / 4 // seconds per sixteenth
    while (this.nextStepTime < now + MUSIC.lookahead) {
      this.scheduleStep(this.step, this.nextStepTime)
      this.nextStepTime += spb
      this.step++
      if (this.step >= STEPS) {
        this.step = 0
        this.bar++
      }
    }
  }

  /** Layer gains for right now: unlocked by hunt, opened by intensity. */
  private layers(): Layers {
    const i = this.smoothed
    const L = MUSIC.layers
    const gate = (l: { wave: number; need: number }) =>
      this.wave < l.wave ? 0 : ramp(i, l.need, Math.min(1, l.need + 0.35))

    if (this.mode === 'menu') {
      return { drone: 0.55, pulse: 0, bass: 0, frame: 0, ostinato: 0.18, taiko: 0, brass: 0, choir: 0.2, strings: 0 }
    }

    const f = this.frenzy ? 1 : 0
    // A hunt that has just started still wants a pulse under it, so the quiet
    // layers get a floor from the hunt number itself rather than from combat.
    const floor = Math.min(0.45, (this.wave - 1) * 0.07)
    const g = (l: { wave: number; need: number }, base = 0) =>
      Math.max(base, Math.min(1, Math.max(gate(l), this.wave >= l.wave ? floor : 0) + f * 0.5))

    return {
      drone: 0.75,
      pulse: g(L.pulse, 0.35),
      bass: g(L.bass),
      frame: g(L.frame),
      ostinato: g(L.ostinato),
      taiko: g(L.taiko),
      brass: g(L.brass),
      choir: g(L.choir),
      strings: g(L.strings),
    }
  }

  private scheduleStep(step: number, t: number) {
    const L = this.layers()
    const barPhase = this.bar % 4
    const prog = this.wave >= MUSIC.exoticFrom ? PROGRESSION_LATE : PROGRESSION
    const chordRoot = prog[barPhase]!
    const r = hash(this.bar * 16 + step)

    // Auto gain compensation. Six layers all mixed at unity is mud; this keeps
    // the sum roughly constant as the arrangement fills in.
    const busy = L.pulse + L.bass + L.frame + L.ostinato + L.taiko + L.brass + L.choir + L.strings
    const trim = 1 / Math.sqrt(1 + busy * 0.55)

    // ---- heartbeat. Lub-dub on 1, and again in the second half once it matters.
    if (L.pulse > 0.01) {
      if (step === 0) this.heart(t, 1.0 * L.pulse * trim)
      if (step === 3) this.heart(t, 0.62 * L.pulse * trim)
      if (this.smoothed > 0.45) {
        if (step === 8) this.heart(t, 0.9 * L.pulse * trim)
        if (step === 11) this.heart(t, 0.55 * L.pulse * trim)
      }
    }

    // ---- bass. Root of the bar, with a push onto the second half.
    if (L.bass > 0.01) {
      const beat = 60 / this.bpm
      if (step === 0) this.bassNote(t, this.pitch(chordRoot, 0), beat * 1.8, 0.85 * L.bass * trim)
      if (step === 10 && this.smoothed > 0.3) {
        this.bassNote(t, this.pitch(chordRoot + 4, 0), beat * 0.5, 0.5 * L.bass * trim)
      }
    }

    // ---- frame drum.
    if (L.frame > 0.01) {
      const v = FRAME_PATTERN[step]!
      if (v > 0 && (v > 0.5 || this.smoothed > 0.25 || r > 0.4)) {
        this.frameDrum(t, v * L.frame * trim, v > 0.7, r)
      }
    }

    // ---- sitar ostinato.
    if (L.ostinato > 0.01 && OSTI_MASK[step] === 1) {
      const deg = chordRoot + OSTI_DEGREE[step]!
      // Every fourth bar the line reaches an octave up, so the phrase has a top.
      const oct = barPhase === 3 && step > 8 ? 3 : 2
      this.pluck(t, this.pitch(deg, oct), (0.5 + r * 0.5) * L.ostinato * trim)
    }

    // ---- taiko. Downbeats, with a run-up into the top of each phrase.
    if (L.taiko > 0.01) {
      if (step === 0) this.taikoHit(t, 1.0 * L.taiko * trim, 1)
      if (step === 8) this.taikoHit(t, 0.7 * L.taiko * trim, 1.12)
      if (barPhase === 3 && step >= 12) {
        this.taikoHit(t, (0.4 + (step - 12) * 0.18) * L.taiko * trim, 1 + (step - 12) * 0.06)
      }
    }

    // ---- brass. One sustained cluster per bar, entering just before the bar.
    if (L.brass > 0.01 && step === 0) {
      const beat = 60 / this.bpm
      const stack = [this.pitch(chordRoot, 1), this.pitch(chordRoot + 4, 1)]
      // The minor second on top only shows up when it is genuinely bad.
      if (this.smoothed > 0.6) stack.push(this.pitch(chordRoot, 2) * Math.pow(2, 1 / 12))
      this.brassStab(t, stack, beat * 3.4, 0.6 * L.brass * trim)
    }

    // ---- choir. Two bars long, so it floats across the harmony rather than
    // articulating it.
    if (L.choir > 0.01 && step === 0 && barPhase % 2 === 0) {
      const beat = 60 / this.bpm
      this.choirPad(t, [this.pitch(chordRoot, 1), this.pitch(chordRoot + 2, 1)], beat * 7.5, 0.5 * L.choir * trim)
    }

    // ---- string cluster. High, tremolo, and deliberately not in the chord.
    if (L.strings > 0.01 && step === 0) {
      const beat = 60 / this.bpm
      this.stringCluster(t, this.pitch(chordRoot, 3), beat * 3.6, 0.42 * L.strings * trim)
    }
  }

  // ----------------------------------------------------------- instruments
  /** Voice helper: gain into the dry bus with a matched reverb send. */
  private voice(gain: number, wet: number, pan = 0): GainNode {
    const ctx = this.ctx
    const g = ctx.createGain()
    g.gain.value = gain
    let node: AudioNode = g
    if (pan !== 0 && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner()
      p.pan.value = pan
      g.connect(p)
      node = p
    }
    node.connect(this.dry)
    if (wet > 0) {
      const s = ctx.createGain()
      s.gain.value = wet
      node.connect(s)
      s.connect(this.verb)
    }
    return g
  }

  private noiseSource(t: number, dur: number): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource()
    src.buffer = this.noise
    src.loop = true
    src.start(t, Math.random() * 1.5)
    src.stop(t + dur + 0.02)
    return src
  }

  /**
   * The tanpura. Four strings, detuned against each other so the drone beats
   * slowly instead of sitting still, through a lowpass that opens with the
   * intensity — the one layer that is always there and is never in the way.
   */
  private startDrone() {
    const ctx = this.ctx
    const g = ctx.createGain()
    g.gain.value = 0
    const filt = ctx.createBiquadFilter()
    filt.type = 'lowpass'
    filt.frequency.value = 380
    filt.Q.value = 0.8
    filt.connect(g)
    g.connect(this.dry)

    const send = ctx.createGain()
    send.gain.value = 0.35
    g.connect(send)
    send.connect(this.verb)

    const root = MUSIC.root
    for (const [mult, detune, level] of [
      [1, 0, 0.5],
      [1, 6, 0.4],
      [1.5, -5, 0.26],
      [2, 4, 0.16],
    ] as const) {
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.value = root * mult
      osc.detune.value = detune
      const lg = ctx.createGain()
      lg.gain.value = level
      osc.connect(lg)
      lg.connect(filt)
      osc.start()
      this.droneOscs.push(osc)
    }

    // A slow swell so the drone breathes rather than droning.
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 0.06
    const lfoGain = ctx.createGain()
    lfoGain.gain.value = 90
    lfo.connect(lfoGain)
    lfoGain.connect(filt.frequency)
    lfo.start()
    this.droneOscs.push(lfo)

    this.drone = g
    // Driven from pump() would mean a param write every 28 ms; this is enough.
    this.droneTimer = setInterval(() => {
      if (!this.drone) return
      const lvl = this.mode === 'dead' ? 0.05 : this.layers().drone
      const open = 300 + this.smoothed * 900 + (this.frenzy ? 500 : 0)
      this.drone.gain.setTargetAtTime(lvl * 0.22, ctx.currentTime, 1.2)
      filt.frequency.setTargetAtTime(open, ctx.currentTime, 1.5)
    }, 400) as unknown as number
  }

  /** Heartbeat. Not a kick drum: no click, all chest. */
  private heart(t: number, vel: number) {
    const ctx = this.ctx
    const out = this.voice(vel * 0.9, 0.05)
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(78, t)
    osc.frequency.exponentialRampToValueAtTime(34, t + 0.16)
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, t)
    env.gain.exponentialRampToValueAtTime(1, t + 0.012)
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.22)
    osc.connect(env)
    env.connect(out)
    osc.start(t)
    osc.stop(t + 0.25)
  }

  private bassNote(t: number, freq: number, dur: number, vel: number) {
    const ctx = this.ctx
    const out = this.voice(vel * 0.5, 0.06)
    const filt = ctx.createBiquadFilter()
    filt.type = 'lowpass'
    filt.frequency.setValueAtTime(180 + vel * 500, t)
    filt.frequency.exponentialRampToValueAtTime(110, t + dur)
    filt.Q.value = 6
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, t)
    env.gain.exponentialRampToValueAtTime(1, t + 0.02)
    env.gain.setTargetAtTime(0.0001, t + dur * 0.7, dur * 0.2)
    filt.connect(env)
    env.connect(out)

    for (const [type, mult, level] of [
      ['sine', 1, 1],
      ['sawtooth', 1, 0.32],
      ['square', 0.5, 0.22],
    ] as const) {
      const osc = ctx.createOscillator()
      osc.type = type
      osc.frequency.value = freq * mult
      const g = ctx.createGain()
      g.gain.value = level
      osc.connect(g)
      g.connect(filt)
      osc.start(t)
      osc.stop(t + dur + 0.1)
    }
  }

  /**
   * Dholak. A membrane is a noise transient plus a pitched body that bends down
   * as the skin relaxes; `hi` picks the small right-hand head over the bass one.
   */
  private frameDrum(t: number, vel: number, hi: boolean, r: number) {
    const ctx = this.ctx
    const out = this.voice(vel * 0.4, 0.14, (r - 0.5) * 0.5)
    const f0 = (hi ? 320 : 130) * (0.94 + r * 0.12)

    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(f0, t)
    osc.frequency.exponentialRampToValueAtTime(f0 * 0.62, t + 0.1)
    const oe = ctx.createGain()
    oe.gain.setValueAtTime(0.0001, t)
    oe.gain.exponentialRampToValueAtTime(1, t + 0.004)
    oe.gain.exponentialRampToValueAtTime(0.0001, t + (hi ? 0.13 : 0.26))
    osc.connect(oe)
    oe.connect(out)
    osc.start(t)
    osc.stop(t + 0.3)

    const src = this.noiseSource(t, 0.09)
    const filt = ctx.createBiquadFilter()
    filt.type = 'bandpass'
    filt.frequency.value = hi ? 2600 : 900
    filt.Q.value = 1.4
    const ne = ctx.createGain()
    ne.gain.setValueAtTime(0.0001, t)
    ne.gain.exponentialRampToValueAtTime(hi ? 0.5 : 0.28, t + 0.002)
    ne.gain.exponentialRampToValueAtTime(0.0001, t + 0.07)
    src.connect(filt)
    filt.connect(ne)
    ne.connect(out)
  }

  /** Taiko. Same shape as the frame drum an octave down, with real air behind it. */
  private taikoHit(t: number, vel: number, pitchMult: number) {
    const ctx = this.ctx
    const out = this.voice(vel * 0.6, 0.3)
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(96 * pitchMult, t)
    osc.frequency.exponentialRampToValueAtTime(48 * pitchMult, t + 0.24)
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, t)
    env.gain.exponentialRampToValueAtTime(1, t + 0.006)
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.5)
    osc.connect(env)
    env.connect(out)
    osc.start(t)
    osc.stop(t + 0.55)

    const src = this.noiseSource(t, 0.12)
    const filt = ctx.createBiquadFilter()
    filt.type = 'lowpass'
    filt.frequency.setValueAtTime(1800, t)
    filt.frequency.exponentialRampToValueAtTime(300, t + 0.1)
    const ne = ctx.createGain()
    ne.gain.setValueAtTime(0.0001, t)
    ne.gain.exponentialRampToValueAtTime(0.4, t + 0.003)
    ne.gain.exponentialRampToValueAtTime(0.0001, t + 0.11)
    src.connect(filt)
    filt.connect(ne)
    ne.connect(out)
  }

  /**
   * Sitar. A plucked string is a bright saw collapsing into a narrow resonance;
   * the jawari buzz that makes it a sitar rather than a guitar comes from the
   * detuned second voice a beat behind and the sympathetic ring on top.
   */
  private pluck(t: number, freq: number, vel: number) {
    const ctx = this.ctx
    const out = this.voice(vel * 0.22, 0.26, (Math.random() - 0.5) * 0.6)
    for (const [mult, delay, level] of [
      [1, 0, 1],
      [1.004, 0.012, 0.55],
      [2, 0.004, 0.2],
    ] as const) {
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.value = freq * mult
      const filt = ctx.createBiquadFilter()
      filt.type = 'bandpass'
      filt.frequency.setValueAtTime(freq * 4, t + delay)
      filt.frequency.exponentialRampToValueAtTime(freq * 1.4, t + delay + 0.35)
      filt.Q.value = 3.2
      const env = ctx.createGain()
      env.gain.setValueAtTime(0.0001, t + delay)
      env.gain.exponentialRampToValueAtTime(level, t + delay + 0.006)
      env.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.42)
      osc.connect(filt)
      filt.connect(env)
      env.connect(out)
      osc.start(t + delay)
      osc.stop(t + delay + 0.45)
    }
  }

  /** Brass cluster. Slow filter opening plus vibrato is most of what reads as horns. */
  private brassStab(t: number, freqs: number[], dur: number, vel: number) {
    const ctx = this.ctx
    const out = this.voice(vel * 0.16, 0.35)
    const vib = ctx.createOscillator()
    vib.frequency.value = 5.2
    const vibGain = ctx.createGain()
    vibGain.gain.value = 4
    vib.connect(vibGain)
    vib.start(t)
    vib.stop(t + dur + 0.2)

    for (const f of freqs) {
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.value = f
      vibGain.connect(osc.detune)
      const filt = ctx.createBiquadFilter()
      filt.type = 'lowpass'
      filt.frequency.setValueAtTime(f * 1.5, t)
      filt.frequency.linearRampToValueAtTime(f * 7, t + 0.28)
      filt.frequency.linearRampToValueAtTime(f * 2.5, t + dur)
      filt.Q.value = 2
      const env = ctx.createGain()
      env.gain.setValueAtTime(0.0001, t)
      env.gain.linearRampToValueAtTime(1 / freqs.length, t + 0.16)
      env.gain.setTargetAtTime(0.0001, t + dur * 0.6, dur * 0.25)
      osc.connect(filt)
      filt.connect(env)
      env.connect(out)
      osc.start(t)
      osc.stop(t + dur + 0.3)
    }
  }

  /** Voices. Three formants on a saw and a breath layer — an "oo" that never breathes in. */
  private choirPad(t: number, freqs: number[], dur: number, vel: number) {
    const ctx = this.ctx
    const out = this.voice(vel * 0.12, 0.5)
    for (const f of freqs) {
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.value = f
      osc.detune.value = (Math.random() - 0.5) * 14
      const env = ctx.createGain()
      env.gain.setValueAtTime(0.0001, t)
      env.gain.linearRampToValueAtTime(1 / freqs.length, t + dur * 0.35)
      env.gain.linearRampToValueAtTime(0.0001, t + dur)
      // "oo" formants: low, tight, and dark.
      for (const [cf, q, lvl] of [
        [320, 9, 1],
        [800, 11, 0.4],
        [2400, 13, 0.12],
      ] as const) {
        const bp = ctx.createBiquadFilter()
        bp.type = 'bandpass'
        bp.frequency.value = cf
        bp.Q.value = q
        const g = ctx.createGain()
        g.gain.value = lvl
        osc.connect(bp)
        bp.connect(g)
        g.connect(env)
      }
      env.connect(out)
      osc.start(t)
      osc.stop(t + dur + 0.2)
    }
  }

  /** Tremolo strings, a semitone apart. Not a chord — a warning. */
  private stringCluster(t: number, freq: number, dur: number, vel: number) {
    const ctx = this.ctx
    const out = this.voice(vel * 0.1, 0.4)
    const trem = ctx.createOscillator()
    trem.frequency.value = 13 + this.smoothed * 8
    const tremGain = ctx.createGain()
    tremGain.gain.value = 0.5
    const bias = ctx.createGain()
    bias.gain.value = 0.5
    trem.connect(tremGain)
    trem.start(t)
    trem.stop(t + dur + 0.2)

    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, t)
    env.gain.linearRampToValueAtTime(1, t + 0.3)
    env.gain.linearRampToValueAtTime(0.0001, t + dur)
    // Tremolo is a 0..1 multiplier: a unity DC path plus the LFO around it.
    tremGain.connect(bias.gain)
    env.connect(bias)
    bias.connect(out)

    for (const mult of [1, Math.pow(2, 1 / 12), 1.5]) {
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.value = freq * mult
      osc.detune.value = (Math.random() - 0.5) * 10
      const hp = ctx.createBiquadFilter()
      hp.type = 'highpass'
      hp.frequency.value = freq * 0.8
      const g = ctx.createGain()
      g.gain.value = 0.33
      osc.connect(hp)
      hp.connect(g)
      g.connect(env)
      osc.start(t)
      osc.stop(t + dur + 0.2)
    }
  }

  /**
   * Hunt transition. A reversed swell into a downbeat, and the bar clock is
   * reset so the next phrase starts from the top rather than mid-sentence.
   */
  stinger(wave: number) {
    const ctx = this.ctx
    const t = ctx.currentTime + 0.02
    const dur = 1.5
    this.bar = 0
    this.step = 0
    this.nextStepTime = t + dur

    // Riser: noise sweeping up through a resonant bandpass.
    const out = this.voice(0.5, 0.6)
    const src = this.noiseSource(t, dur)
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.setValueAtTime(300, t)
    bp.frequency.exponentialRampToValueAtTime(6500, t + dur)
    bp.Q.value = 3
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, t)
    env.gain.exponentialRampToValueAtTime(0.5, t + dur * 0.92)
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.08)
    src.connect(bp)
    bp.connect(env)
    env.connect(out)

    // Horn call on the new mode's root, so the key change is announced.
    const stack = [this.pitch(0, 1), this.pitch(4, 1)]
    if (wave >= MUSIC.exoticFrom) stack.push(this.pitch(1, 2))
    this.brassStab(t + dur - 0.05, stack, 2.2, 1.0)
    this.taikoHit(t + dur, 1.1, 0.9)
    this.taikoHit(t + dur, 0.8, 1.4)
  }
}
