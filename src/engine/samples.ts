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
 * So the voices are recordings and the rest is not. The samples are CC0 from
 * Freesound — see CREDITS.md — fetched by `scripts/fetch-voices.ts`, which
 * writes the manifest this reads.
 *
 * Nothing here is allowed to be load-bearing. A missing manifest, a failed
 * fetch and an undecodable file all land in the same place: the set stays
 * empty, `pick()` returns null, and the caller runs the procedural voice it
 * was running before any of this existed. A clean checkout with no assets
 * fetched is a working game.
 */

/** The voice sets. One name per procedural cue these stand in for. */
export type VoiceSet = 'scream' | 'shout' | 'murmur'

const SETS: VoiceSet[] = ['scream', 'shout', 'murmur']

interface Manifest {
  sets?: Partial<Record<VoiceSet, string[]>>
}

const BASE = 'assets/audio/voices/'

export class Samples {
  private buffers: Record<VoiceSet, AudioBuffer[]> = {
    scream: [],
    shout: [],
    murmur: [],
  }

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
    return SETS.reduce((n, s) => n + this.buffers[s].length, 0)
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
      SETS.flatMap((set) =>
        (manifest.sets?.[set] ?? []).map(async (file) => {
          try {
            const res = await fetch(BASE + file)
            if (!res.ok) throw new Error(String(res.status))
            const buf = await ctx.decodeAudioData(await res.arrayBuffer())
            this.buffers[set].push(buf)
          } catch (e) {
            console.warn(`[audio] could not load ${file}:`, e)
          }
        }),
      ),
    )
    this.done = true
    console.info(`[audio] loaded ${this.loaded} voice samples`)
  }

  /** A random take from a set, or null if the set is empty. */
  pick(set: VoiceSet): AudioBuffer | null {
    const b = this.buffers[set]
    return b.length ? b[Math.floor(Math.random() * b.length)]! : null
  }

  has(set: VoiceSet) {
    return this.buffers[set].length > 0
  }
}
