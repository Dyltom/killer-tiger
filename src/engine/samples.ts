/**
 * Recorded human voices, and the only assets the audio engine loads.
 *
 * Everything else in `audio.ts` is synthesised, and stays that way — that
 * approach is genuinely good for impacts, gunfire and foley, where the win is
 * that no two of ten thousand claw strikes are the same sound. It is not good
 * for a human voice. A larynx is a nonlinear oscillator coupled to a moving
 * resonator, and the ear is specialised hardware for spotting when something
 * is only approximating one; the synthesised scream went through a glottal
 * source model, jitter, shimmer, moving formants and fold-break subharmonics
 * and still read as a machine imitating a person, because at that point it
 * was one.
 *
 * So the voices are recordings and the rest is not. They are fetched by
 * `scripts/fetch-voices.ts`, which writes the manifest this reads; two of the
 * six packs are CC BY rather than CC0, so CREDITS.md is a licence condition and
 * not a courtesy.
 *
 * Nothing here is allowed to be load-bearing. A missing manifest, a failed
 * fetch and an undecodable file all land in the same place: the set stays
 * empty, `pick()` returns null, and the caller runs the procedural voice it
 * was running before any of this existed. A clean checkout with no assets
 * fetched is a working game.
 */

/** The voice sets. One name per procedural cue these stand in for. */
export type VoiceSet = 'scream' | 'shout' | 'murmur'

/**
 * Which voice a cue is asked for.
 *
 * A separate axis from `VoiceSet` rather than five set names, because a caller
 * always knows which cue it wants and only sometimes knows — or cares — whose
 * throat it comes out of. The murmur is a room of people and takes neither.
 */
export type Voice = 'm' | 'f'

const SETS: VoiceSet[] = ['scream', 'shout', 'murmur']
const VOICED: VoiceSet[] = ['scream', 'shout']

/**
 * Manifest key for a cue and a voice.
 *
 * `m` is unsuffixed, matching `keyFor` in scripts/fetch-voices.ts. That is not
 * symmetry for its own sake: it means a manifest written before the split still
 * names every set this loader asks for, so assets and code can be updated in
 * either order without a window where the voices go silent.
 */
const keyFor = (set: VoiceSet, voice?: Voice) => (voice === 'f' ? `${set}-f` : set)

const KEYS: string[] = [...SETS, ...VOICED.map((s) => keyFor(s, 'f'))]

interface Manifest {
  sets?: Partial<Record<string, string[]>>
}

const BASE = 'assets/audio/voices/'

export class Samples {
  private buffers: Record<string, AudioBuffer[]> = Object.fromEntries(KEYS.map((k) => [k, []]))

  /**
   * Resolves once loading has finished or given up, never rejects.
   *
   * Callers that want to start something when the samples arrive — the
   * ambience murmur is the only one — await this. Callers that fire on an
   * event just call `pick()` and take the null.
   */
  readonly ready: Promise<void>

  private done = false

  constructor(ctx: BaseAudioContext) {
    this.ready = this.load(ctx).catch((e: unknown) => {
      console.warn('[audio] voice samples unavailable, using synthesis:', e)
    })
  }

  /** True once loading settled, whether or not anything actually loaded. */
  get settled() {
    return this.done
  }

  get loaded() {
    return KEYS.reduce((n, k) => n + this.buffers[k]!.length, 0)
  }

  private async load(ctx: BaseAudioContext) {
    // An offline render has no `fetch` worth using and no assets to wait for;
    // the probe harness measures the synthesis path deliberately.
    if (typeof fetch !== 'function') {
      this.done = true
      return
    }
    let manifest: Manifest
    try {
      const res = await fetch(BASE + 'manifest.json')
      if (!res.ok) throw new Error(`manifest ${res.status}`)
      manifest = (await res.json()) as Manifest
    } catch (e) {
      // Expected on a checkout that has not run the fetch script, so this logs
      // the reason and not the stack — a trace here reads as a fault, and the
      // fallback it describes is a supported way to run the game.
      const why = e instanceof Error ? e.message : String(e)
      console.info(`[audio] no voice manifest (${why}); voices will be synthesised`)
      this.done = true
      return
    }

    await Promise.all(
      KEYS.flatMap((key) =>
        (manifest.sets?.[key] ?? []).map(async (file) => {
          try {
            const res = await fetch(BASE + file)
            if (!res.ok) throw new Error(String(res.status))
            const buf = await ctx.decodeAudioData(await res.arrayBuffer())
            this.buffers[key]!.push(buf)
          } catch (e) {
            console.warn(`[audio] could not load ${file}:`, e)
          }
        }),
      ),
    )
    this.done = true
    console.info(`[audio] loaded ${this.loaded} voice samples`)
  }

  /**
   * A random take from a set, or null if neither it nor its fallback has one.
   *
   * Falling back to the other voice rather than to synthesis is deliberate, and
   * it is the less obvious of the two options: a woman's death cry played from
   * the male set is wrong, and it is wrong in the ordinary way that a stock
   * library is wrong, whereas the synthesised voice is the thing that was
   * rejected twice for sounding like a different decade of game. One of those
   * degrades and the other breaks the illusion for everyone in earshot.
   *
   * This is what makes the female sets safe to ship at five and nine takes
   * against eleven and sixteen: if a pack ever goes away upstream, or a fetch
   * runs on a machine without ffmpeg, the cue does not change character.
   */
  pick(set: VoiceSet, voice?: Voice): AudioBuffer | null {
    const b = this.buffers[keyFor(set, voice)]
    const from = b?.length ? b : this.buffers[keyFor(set, voice === 'f' ? 'm' : 'f')]
    return from?.length ? from[Math.floor(Math.random() * from.length)]! : null
  }

  /** Whether `pick` would return something. Mirrors its fallback exactly. */
  has(set: VoiceSet, voice?: Voice) {
    return (
      !!this.buffers[keyFor(set, voice)]?.length ||
      !!this.buffers[keyFor(set, voice === 'f' ? 'm' : 'f')]?.length
    )
  }
}
