/**
 * Renders every sound effect offline and measures it.
 *
 * There is no way to look at this synth and tell whether it sounds expensive.
 * There is a way to render four seconds of it at 48 kHz and read the numbers
 * off, and the numbers that separate a game sound from a jam are specific:
 *
 * - **crest** — peak over RMS, in dB. A real impact is spiky: a hard transient
 *   over a much quieter tail. Anything under about 12 dB is a sound that has
 *   been flattened into a block of energy, which is the single most reliable
 *   measurable signature of "cheap".
 * - **decay shape** — the ratio of the level 30 ms after the peak to the level
 *   at 150 ms, against what a single exponential would give. Every envelope in
 *   a naive synth is one exponential; real material rings down in two stages,
 *   fast then slow, and the ear hears the difference as wood versus a beep.
 * - **variance** — the same sound rendered twenty times, compared band by band.
 *   If two renders of a footstep measure the same, the player hears one
 *   footstep sample ten thousand times.
 * - **width** — mid/side ratio. A mono point source in the middle of the image
 *   is the other half of why synthesised effects read as flat.
 * - **bands** — energy split sub/low/mid/presence/air, as dB relative to the
 *   whole. This is the one the earlier passes on this file were driven by, and
 *   it is still what catches a sound with no top on it.
 *
 * Run: npx tsx scripts/audio-probe.ts [name ...]
 */
import { AudioContext, OfflineAudioContext } from 'node-web-audio-api'

// audio.ts reads window.AudioContext at init even when handed a context.
;(globalThis as Record<string, unknown>).window = { AudioContext }

const { Audio } = await import('../src/engine/audio')

const RATE = 48000

type Metrics = {
  peak: number
  rms: number
  crest: number
  attack: number
  bands: number[]
  width: number
  early: number
  late: number
}

const BANDS: [string, number, number][] = [
  ['sub', 20, 90],
  ['low', 90, 300],
  ['mid', 300, 2000],
  ['pres', 2000, 6000],
  ['air', 6000, 16000],
]

const db = (x: number) => (x <= 1e-9 ? -90 : 20 * Math.log10(x))

/** Goertzel-free: a plain periodogram over a Hann-windowed slab, power per band. */
function bandEnergy(x: Float32Array): number[] {
  // 4096-point DFT via naive real transform on a decimated grid of bin centres.
  // Only 60 log-spaced probes are needed to split five bands, so this is cheap.
  const N = Math.min(x.length, 1 << 15)
  const win = new Float32Array(N)
  for (let i = 0; i < N; i++) win[i] = x[i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N))
  const out = BANDS.map(() => 0)
  const PROBES = 96
  for (let p = 0; p < PROBES; p++) {
    const f = 20 * Math.pow(16000 / 20, p / (PROBES - 1))
    const w = (2 * Math.PI * f) / RATE
    let re = 0
    let im = 0
    for (let i = 0; i < N; i++) {
      re += win[i]! * Math.cos(w * i)
      im += win[i]! * Math.sin(w * i)
    }
    const pw = (re * re + im * im) / N
    const b = BANDS.findIndex(([, lo, hi]) => f >= lo && f < hi)
    if (b >= 0) out[b]! += pw
  }
  const total = out.reduce((a, b) => a + b, 0) || 1e-12
  return out.map((v) => db(Math.sqrt(v / total)))
}

function measure(buf: { getChannelData(c: number): Float32Array; length: number; numberOfChannels: number }): Metrics {
  const L = buf.getChannelData(0)
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L
  const n = buf.length
  const mono = new Float32Array(n)
  let msMid = 0
  let msSide = 0
  for (let i = 0; i < n; i++) {
    mono[i] = (L[i]! + R[i]!) * 0.5
    const s = (L[i]! - R[i]!) * 0.5
    msMid += mono[i]! * mono[i]!
    msSide += s * s
  }
  let peak = 0
  let peakAt = 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const a = Math.abs(mono[i]!)
    if (a > peak) {
      peak = a
      peakAt = i
    }
    sum += mono[i]! * mono[i]!
  }
  // RMS over the part that is actually sounding, not over the trailing silence
  // the render window leaves behind — otherwise a long tail flatters the crest.
  let end = n - 1
  while (end > 0 && Math.abs(mono[end]!) < peak * 0.002) end--
  let act = 0
  for (let i = 0; i <= end; i++) act += mono[i]! * mono[i]!
  const rms = Math.sqrt(act / Math.max(1, end + 1))

  /** RMS of a 12 ms window centred `ms` after the peak. */
  const at = (ms: number) => {
    const c = peakAt + Math.round((ms / 1000) * RATE)
    const half = Math.round(0.006 * RATE)
    let s = 0
    let k = 0
    for (let i = Math.max(0, c - half); i < Math.min(n, c + half); i++) {
      s += mono[i]! * mono[i]!
      k++
    }
    return Math.sqrt(s / Math.max(1, k))
  }

  return {
    peak,
    rms,
    crest: db(peak) - db(rms),
    attack: (peakAt / RATE) * 1000,
    bands: bandEnergy(mono.subarray(peakAt)),
    width: db(Math.sqrt(msSide / n)) - db(Math.sqrt(msMid / n)),
    early: db(at(25)) - db(peak),
    late: db(at(160)) - db(peak),
  }
}

/** Render one call of `fire` into an offline context and measure it. */
async function render(fire: (a: InstanceType<typeof Audio>) => void, seconds: number): Promise<Metrics> {
  const ctx = new OfflineAudioContext(2, Math.round(RATE * seconds), RATE)
  const a = new Audio()
  a.init(ctx as unknown as BaseAudioContext)
  fire(a)
  const buf = await ctx.startRendering()
  return measure(buf as unknown as Parameters<typeof measure>[0])
}

const CASES: [string, number, (a: InstanceType<typeof Audio>) => void][] = [
  ['roar', 3.0, (a) => a.roar()],
  ['growl', 1.2, (a) => a.growl()],
  ['swipeWhoosh', 0.8, (a) => a.swipeWhoosh(1)],
  ['clawHit', 1.2, (a) => a.clawHit({ dist: 2 })],
  ['biteKill', 1.6, (a) => a.biteKill({ dist: 2 })],
  ['scream', 2.0, (a) => a.scream({ dist: 8, pan: 0.3 })],
  ['scream near', 2.0, (a) => a.scream({ dist: 1 })],
  ['shout', 1.5, (a) => a.shout({ dist: 14, pan: -0.4 })],
  ['shout near', 1.5, (a) => a.shout({ dist: 1 })],
  ['gunshot near', 2.5, (a) => a.gunshot({ pan: 0.2 }, 8)],
  ['gunshot far', 3.5, (a) => a.gunshot({ pan: -0.5 }, 70)],
  ['bulletWhiz', 1.0, (a) => a.bulletWhiz({ pan: 0.6 })],
  ['hurt', 2.5, (a) => a.hurt()],
  ['chew', 1.0, (a) => a.chew()],
  ['gulp', 1.2, (a) => a.gulp(true)],
  ['pickup', 1.0, (a) => a.pickup()],
  ['powerup', 1.8, (a) => a.powerup()],
  ['uiClick', 0.4, (a) => a.uiClick()],
  ['uiHover', 0.3, (a) => a.uiHover()],
  ['killConfirm', 0.8, (a) => a.killConfirm()],
  ['pounce', 1.2, (a) => a.pounce()],
  ['land soft', 1.0, (a) => a.land(0.8)],
  ['land hard', 1.2, (a) => a.land(2.0)],
  ['footstep', 0.6, (a) => a.footstep({ pan: 0.2 })],
  ['footstep heavy', 0.6, (a) => a.footstep({ pan: -0.2 }, true)],
  ['waveStart', 4.0, (a) => a.waveStart(3)],
  ['gameOver', 5.0, (a) => a.gameOver()],
  ['comboTick', 0.8, (a) => a.comboTick(4)],
  ['frenzyStart', 3.0, (a) => a.frenzyStart()],
  // The ambience one-shots pick a branch at random off a roll the probe can't
  // steer, so they're driven straight rather than through ambientOneShot().
  ['bird', 1.0, (a) => amb(a).birdCall(bus(a))],
  ['dogBark', 1.5, (a) => amb(a).dogBark(bus(a), 3)],
  ['scrubRustle', 1.5, (a) => amb(a).scrubRustle(bus(a))],
]

type Amb = {
  birdCall(d: AudioNode): void
  dogBark(d: AudioNode, n: number): void
  scrubRustle(d: AudioNode): void
  voice(p: number, dur: number, g: number, place: object, wet: number): AudioNode | null
}
const amb = (a: InstanceType<typeof Audio>) => a as unknown as Amb
/** The same routing ambientOneShot() gives them: distant, off to one side. */
const bus = (a: InstanceType<typeof Audio>) =>
  amb(a).voice(1, 0.5, 0.5, { pan: 0.5, dist: 55 }, 2.2) ?? ({} as AudioNode)

const only = process.argv.slice(2).filter((a) => a !== '--env')
const pick = CASES.filter(([n]) => !only.length || only.some((o) => n.includes(o)))

// --env: the level over time, in 50 ms buckets. This is the only way to see a
// cue that peaks two seconds in — the summary says "attack 2795 ms" but not
// whether the front is missing or the tail is winning.
if (process.argv.includes('--env')) {
  for (const [name, secs, fire] of pick) {
    const ctx = new OfflineAudioContext(2, Math.round(RATE * secs), RATE)
    const a = new Audio()
    a.init(ctx as unknown as BaseAudioContext)
    fire(a)
    const buf = (await ctx.startRendering()) as unknown as { getChannelData(c: number): Float32Array; length: number }
    const x = buf.getChannelData(0)
    const step = Math.round(0.05 * RATE)
    const rows: string[] = []
    let top = 1e-9
    const vals: number[] = []
    for (let i = 0; i < x.length; i += step) {
      let s = 0
      for (let k = i; k < Math.min(x.length, i + step); k++) s += x[k]! * x[k]!
      const v = Math.sqrt(s / step)
      vals.push(v)
      top = Math.max(top, v)
    }
    vals.forEach((v, i) => {
      const d = db(v / top)
      rows.push(`${String(i * 50).padStart(5)}ms ${d.toFixed(1).padStart(6)} ${'#'.repeat(Math.max(0, Math.round(40 + d * 0.8)))}`)
    })
    console.log(`\n== ${name} (0 dB = ${db(top).toFixed(1)} dBFS rms)`)
    console.log(rows.join('\n'))
  }
  process.exit(0)
}

const pad = (s: string, n: number) => s.padEnd(n)
const f = (x: number, d = 1) => x.toFixed(d).padStart(6)

console.log(
  `${pad('sound', 17)}${pad('peak', 8)}${pad('crest', 7)}${pad('atk ms', 8)}` +
    BANDS.map(([b]) => pad(b, 7)).join('') +
    `${pad('width', 7)}${pad('-25ms', 7)}${pad('-160ms', 8)}var`,
)

for (const [name, secs, fire] of pick) {
  // Twenty renders: one for the shape, all twenty for how much it varies. The
  // variance number is the mean absolute band spread across renders, in dB —
  // under about 0.8 dB and the sound is effectively a fixed sample.
  const runs: Metrics[] = []
  for (let i = 0; i < 20; i++) runs.push(await render(fire, secs))
  const m = runs[0]!
  let spread = 0
  for (let b = 0; b < BANDS.length; b++) {
    const vals = runs.map((r) => r.bands[b]!)
    const mean = vals.reduce((a, v) => a + v, 0) / vals.length
    spread += vals.reduce((a, v) => a + Math.abs(v - mean), 0) / vals.length
  }
  spread /= BANDS.length
  const peakSpread = Math.max(...runs.map((r) => db(r.peak))) - Math.min(...runs.map((r) => db(r.peak)))
  console.log(
    `${pad(name, 17)}${f(db(m.peak))}  ${f(m.crest)} ${f(m.attack, 1)}  ` +
      m.bands.map((v) => f(v)).join(' ') +
      ` ${f(m.width)} ${f(m.early)} ${f(m.late)}  ${f(spread, 2)} /${f(peakSpread, 1)}`,
  )
}
