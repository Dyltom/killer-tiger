/**
 * Fully procedural audio — no asset files, no network, never fails to load.
 * Everything is synthesised from oscillators + shaped noise buffers.
 */

type Ctx = AudioContext

function noiseBuffer(ctx: Ctx, seconds: number, decay = 1): AudioBuffer {
  const n = Math.max(1, Math.floor(ctx.sampleRate * seconds))
  const buf = ctx.createBuffer(1, n, ctx.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < n; i++) {
    d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay)
  }
  return buf
}

export class Audio {
  private ctx: Ctx | null = null
  private master: GainNode | null = null
  private sfxBus: GainNode | null = null
  private musicBus: GainNode | null = null
  private noiseShort: AudioBuffer | null = null
  private noiseLong: AudioBuffer | null = null
  private ambienceStop: (() => void) | null = null
  muted = false

  /** Must be called from a user gesture. */
  init() {
    if (this.ctx) return
    const AC: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new AC()
    this.ctx = ctx
    this.master = ctx.createGain()
    this.master.gain.value = 0.85
    this.master.connect(ctx.destination)

    this.sfxBus = ctx.createGain()
    this.sfxBus.gain.value = 1
    this.sfxBus.connect(this.master)

    this.musicBus = ctx.createGain()
    this.musicBus.gain.value = 0.5
    this.musicBus.connect(this.master)

    this.noiseShort = noiseBuffer(ctx, 0.5, 2)
    this.noiseLong = noiseBuffer(ctx, 3.0, 0.4)
  }

  resume() {
    if (this.ctx?.state === 'suspended') void this.ctx.resume()
  }
  suspend() {
    if (this.ctx?.state === 'running') void this.ctx.suspend()
  }
  setMuted(m: boolean) {
    this.muted = m
    if (this.master) this.master.gain.value = m ? 0 : 0.85
  }

  private get t(): number {
    return this.ctx ? this.ctx.currentTime : 0
  }

  /** Gain node wired to the SFX bus, with pan. */
  private voice(gain: number, pan = 0): GainNode | null {
    if (!this.ctx || !this.sfxBus) return null
    const g = this.ctx.createGain()
    g.gain.value = gain
    if (pan !== 0 && this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner()
      p.pan.value = Math.max(-1, Math.min(1, pan))
      g.connect(p)
      p.connect(this.sfxBus)
    } else {
      g.connect(this.sfxBus)
    }
    return g
  }

  private tone(
    type: OscillatorType,
    f0: number,
    f1: number,
    dur: number,
    gain: number,
    pan = 0,
    delay = 0,
  ) {
    const ctx = this.ctx
    if (!ctx) return
    const t = this.t + delay
    const out = this.voice(1, pan)
    if (!out) return
    const osc = ctx.createOscillator()
    osc.type = type
    osc.frequency.setValueAtTime(f0, t)
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur)
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, t)
    env.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.02, dur * 0.2))
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    osc.connect(env)
    env.connect(out)
    osc.start(t)
    osc.stop(t + dur + 0.02)
  }

  private noise(
    dur: number,
    gain: number,
    filterType: BiquadFilterType,
    f0: number,
    f1: number,
    pan = 0,
    delay = 0,
    long = false,
  ) {
    const ctx = this.ctx
    if (!ctx) return
    const buf = long ? this.noiseLong : this.noiseShort
    if (!buf) return
    const t = this.t + delay
    const out = this.voice(1, pan)
    if (!out) return
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.loop = true
    const filt = ctx.createBiquadFilter()
    filt.type = filterType
    filt.Q.value = 1.1
    filt.frequency.setValueAtTime(f0, t)
    filt.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur)
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, t)
    env.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.015, dur * 0.25))
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    src.connect(filt)
    filt.connect(env)
    env.connect(out)
    src.start(t)
    src.stop(t + dur + 0.02)
  }

  // ---------------------------------------------------------------- sounds

  roar(pan = 0) {
    // Layered: sub growl + throaty saw + breath noise.
    this.tone('sine', 110, 42, 1.5, 0.55, pan)
    this.tone('sawtooth', 180, 62, 1.35, 0.3, pan)
    this.tone('square', 88, 33, 1.2, 0.16, pan)
    this.noise(1.4, 0.24, 'bandpass', 900, 260, pan, 0, true)
  }

  growl(pan = 0) {
    this.tone('sawtooth', 92, 58, 0.42, 0.16, pan)
    this.noise(0.4, 0.09, 'lowpass', 500, 180, pan)
  }

  clawHit(pan = 0) {
    this.noise(0.16, 0.42, 'highpass', 2600, 900, pan)
    this.tone('triangle', 320, 90, 0.13, 0.24, pan)
  }

  biteKill(pan = 0) {
    this.noise(0.3, 0.5, 'lowpass', 1500, 220, pan)
    this.tone('sine', 150, 46, 0.34, 0.4, pan)
    this.noise(0.2, 0.22, 'bandpass', 3000, 800, pan, 0.05)
  }

  scream(pan = 0, pitch = 1) {
    const base = 420 * pitch
    this.tone('sawtooth', base, base * 1.9, 0.1, 0.13, pan)
    this.tone('sawtooth', base * 1.9, base * 0.55, 0.55, 0.17, pan, 0.09)
    this.noise(0.5, 0.07, 'bandpass', 1800 * pitch, 700, pan, 0.09)
  }

  gunshot(pan = 0, distance = 0) {
    const atten = 1 / (1 + distance * 0.055)
    this.noise(0.09, 0.62 * atten, 'highpass', 4200, 1100, pan)
    this.tone('square', 160, 40, 0.12, 0.32 * atten, pan)
    // Slap-back off the treeline.
    this.noise(0.42, 0.14 * atten, 'lowpass', 1400, 260, pan, 0.11, true)
  }

  bulletWhiz(pan = 0) {
    this.noise(0.14, 0.16, 'bandpass', 2600, 1400, pan)
  }

  hurt() {
    this.tone('sine', 220, 70, 0.28, 0.3)
    this.noise(0.22, 0.16, 'lowpass', 800, 200)
  }

  pickup() {
    this.tone('triangle', 660, 1320, 0.14, 0.2)
    this.tone('sine', 990, 1760, 0.22, 0.14, 0, 0.06)
  }

  powerup() {
    for (let i = 0; i < 4; i++) {
      this.tone('triangle', 330 * Math.pow(1.26, i), 660 * Math.pow(1.26, i), 0.18, 0.15, 0, i * 0.055)
    }
  }

  pounce() {
    this.noise(0.24, 0.13, 'bandpass', 700, 2000)
    this.tone('sine', 150, 300, 0.16, 0.1)
  }

  land() {
    this.noise(0.16, 0.2, 'lowpass', 420, 120)
  }

  footstep(pan = 0, heavy = false) {
    this.noise(heavy ? 0.13 : 0.08, heavy ? 0.09 : 0.05, 'lowpass', heavy ? 500 : 900, 180, pan)
  }

  waveStart() {
    this.tone('sine', 60, 55, 1.6, 0.4)
    this.tone('sawtooth', 120, 118, 1.4, 0.09)
    this.noise(1.8, 0.1, 'lowpass', 600, 180, 0, 0, true)
  }

  gameOver() {
    this.tone('sine', 140, 40, 2.4, 0.42)
    this.tone('sawtooth', 210, 52, 2.0, 0.14)
    this.noise(2.2, 0.12, 'lowpass', 900, 120, 0, 0, true)
  }

  comboTick(chain: number) {
    const f = 440 * Math.pow(1.12, Math.min(chain, 12))
    this.tone('square', f, f * 1.5, 0.09, 0.1)
  }

  /** Low wind + insect bed that runs for the whole session. */
  startAmbience() {
    const ctx = this.ctx
    if (!ctx || !this.musicBus || this.ambienceStop || !this.noiseLong) return
    const src = ctx.createBufferSource()
    src.buffer = this.noiseLong
    src.loop = true
    const filt = ctx.createBiquadFilter()
    filt.type = 'lowpass'
    filt.frequency.value = 340
    const g = ctx.createGain()
    g.gain.value = 0.16

    // Slow LFO so the wind breathes.
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 0.07
    const lfoGain = ctx.createGain()
    lfoGain.gain.value = 0.09
    lfo.connect(lfoGain)
    lfoGain.connect(g.gain)

    src.connect(filt)
    filt.connect(g)
    g.connect(this.musicBus)
    src.start()
    lfo.start()

    // Distant crickets: a faint high shimmer.
    const cr = ctx.createBufferSource()
    cr.buffer = this.noiseLong
    cr.loop = true
    const crf = ctx.createBiquadFilter()
    crf.type = 'bandpass'
    crf.frequency.value = 5200
    crf.Q.value = 8
    const crg = ctx.createGain()
    crg.gain.value = 0.035
    cr.connect(crf)
    crf.connect(crg)
    crg.connect(this.musicBus)
    cr.start()

    this.ambienceStop = () => {
      try { src.stop(); lfo.stop(); cr.stop() } catch { /* already stopped */ }
      this.ambienceStop = null
    }
  }

  /** Tension drone that rises with threat level (0..1). */
  private tensionGain: GainNode | null = null
  setTension(level: number) {
    const ctx = this.ctx
    if (!ctx || !this.musicBus) return
    if (!this.tensionGain) {
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.value = 55
      const osc2 = ctx.createOscillator()
      osc2.type = 'sawtooth'
      osc2.frequency.value = 55 * 1.005 // slight detune beat
      const filt = ctx.createBiquadFilter()
      filt.type = 'lowpass'
      filt.frequency.value = 220
      const g = ctx.createGain()
      g.gain.value = 0
      osc.connect(filt)
      osc2.connect(filt)
      filt.connect(g)
      g.connect(this.musicBus)
      osc.start()
      osc2.start()
      this.tensionGain = g
    }
    this.tensionGain.gain.setTargetAtTime(Math.max(0, Math.min(1, level)) * 0.2, ctx.currentTime, 0.6)
  }
}

export const audio = new Audio()
