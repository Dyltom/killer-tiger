/**
 * Fetch the CC0 human-voice samples into public/assets/audio/voices/ and
 * normalise them into something the game can fire ten of at once.
 *
 * These are the only audio assets in the project — see `src/engine/samples.ts`
 * for why the voices are recorded and everything else is synthesised. The
 * .m4a output and the manifest are committed, so a clean checkout needs no
 * network and no token; this only needs re-running to change the sample set.
 *
 * Everything fetched is filtered to Creative Commons 0 at the API. That is not
 * a nicety: CC BY would put an attribution obligation on anyone who ships the
 * game, and CC BY-NC would make the game uncommercial. The licence of every
 * file is recorded in CREDITS.md by this script, from the API's own metadata
 * rather than from anything typed here by hand.
 *
 * Requires: a free Freesound API token from https://freesound.org/apiv2/apply
 * exported as FREESOUND_TOKEN, and ffmpeg (brew install ffmpeg).
 *
 *   npx tsx scripts/fetch-voices.ts --list     # search only, print candidates
 *   npx tsx scripts/fetch-voices.ts            # fetch, process, write manifest
 *   npx tsx scripts/fetch-voices.ts --set scream --list
 *
 * `--list` first is the intended workflow. Search relevance for "scream" is
 * not the same thing as "sounds like a person in a village at night", and the
 * only way to tell the difference is to look at what came back.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'public/assets/audio/voices')
const API = 'https://freesound.org/apiv2'

const TOKEN = process.env.FREESOUND_TOKEN
const args = process.argv.slice(2)
const LIST_ONLY = args.includes('--list')
const ONLY_SET = args[args.indexOf('--set') + 1]

/**
 * What to search for, and what counts as a usable result.
 *
 * `want` is deliberately more than the handful you would guess. The engine
 * gets its variation from the chain around the sample — per-voice tilt,
 * distance, placement, rate jitter — but that cannot rescue a set so small
 * the player starts recognising individual takes, and a fleeing village
 * fires these in bursts of five or six.
 */
interface SetSpec {
  name: string
  queries: string[]
  /** Seconds; the API filter, so unusable lengths never get downloaded. */
  dur: [number, number]
  want: number
  /** Loop the result seamlessly (ambience beds) rather than trim it (one-shots). */
  loop?: boolean
}

const SETS: SetSpec[] = [
  {
    name: 'scream',
    queries: [
      'scream terror',
      'man scream',
      'woman scream',
      'panic scream human',
      'screaming fear',
    ],
    dur: [0.4, 3],
    want: 14,
  },
  {
    name: 'shout',
    queries: ['shout man', 'yell voice', 'shouting angry', 'man yelling hey'],
    dur: [0.3, 2],
    want: 10,
  },
  {
    name: 'murmur',
    queries: [
      'crowd murmur walla',
      'crowd talking background',
      'market crowd ambience',
      'village people talking',
    ],
    dur: [20, 180],
    // Two is enough: this is a bed under everything at a twentieth of full
    // scale, and each one is thirty seconds. A third costs 240 kB of download
    // for a layer the player is not meant to be listening to.
    want: 2,
    loop: true,
  },
]

// ---------------------------------------------------------------- helpers

interface Sound {
  id: number
  name: string
  username: string
  license: string
  url: string
  duration: number
  num_downloads: number
  previews: Record<string, string>
}

async function search(query: string, dur: [number, number], n: number): Promise<Sound[]> {
  const params = new URLSearchParams({
    query,
    // Quoted exactly as the API's own licence string. `Creative Commons 0` is
    // the only value here that carries no downstream obligation.
    filter: `license:"Creative Commons 0" duration:[${dur[0]} TO ${dur[1]}]`,
    // Downloads is a blunt quality proxy, but it is the only one that is not
    // dominated by three-vote averages.
    sort: 'downloads_desc',
    fields: 'id,name,username,license,url,duration,num_downloads,previews',
    page_size: String(n),
  })
  const res = await fetch(`${API}/search/text/?${params}`, {
    headers: { Authorization: `Token ${TOKEN}` },
  })
  if (!res.ok) {
    throw new Error(`search "${query}" failed: ${res.status} ${await res.text()}`)
  }
  const body = (await res.json()) as { results?: Sound[] }
  return body.results ?? []
}

const ff = (fileArgs: string[]) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...fileArgs])

/** Peak level in dBFS, via ffmpeg's volumedetect. */
function peakDb(file: string): number {
  const out = execFileSync(
    'ffmpeg',
    ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const m = /max_volume:\s*(-?[\d.]+) dB/.exec(out)
  return m ? Number(m[1]) : 0
}

/**
 * A one-shot: trim the silence off both ends, then normalise the peak.
 *
 * The trim matters more than it looks. These are uploads, not a sound library,
 * so a scream can sit behind a quarter-second of room tone — and the engine
 * schedules a voice to land at a particular moment, so leading silence is not
 * a level problem, it is a timing one.
 *
 * Peak normalisation rather than loudness normalisation is deliberate: what
 * has to be consistent here is how close these get to the limiter, because a
 * dozen of them arrive together. Their relative loudness is then one number in
 * config (LEVELS.screamSample) instead of a property of whichever take fired.
 *
 * The target is -3 rather than -1 because AAC does not preserve peaks: measured
 * on a normalised test tone, the decoded output ran about 2.5 dB above whatever
 * it was encoded at. That overshoot is harmless — `decodeAudioData` yields
 * float, which holds values past 1.0 without clipping, and the only converter
 * in the path is behind the limiter — but it would otherwise make the one
 * number these are normalised to a lie by a couple of decibels.
 */
function oneShot(src: string, dest: string) {
  const tmp = join(TMP, 'trim.wav')
  ff([
    '-i', src,
    '-af',
    'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.01,' +
      'areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse',
    '-ac', '1', '-ar', '44100', tmp,
  ])
  const gain = (-3 - peakDb(tmp)).toFixed(2)
  ff(['-i', tmp, '-af', `volume=${gain}dB`, '-ac', '1', '-c:a', 'aac', '-b:a', '96k', dest])
  rmSync(tmp, { force: true })
}

const LOOP_SECONDS = 30
const XFADE = 2

/**
 * An ambience bed, made to loop without a seam.
 *
 * `loop = true` on a BufferSource jumps from the last sample straight back to
 * the first, so unless the waveform happens to match across that join it is a
 * discontinuity — a click, once every pass, forever. The fix is to take a
 * window slightly longer than the loop and crossfade its tail back over its
 * own head, which makes the two ends of the result identical by construction.
 *
 * The window starts 5 s in because uploads of this kind commonly open with a
 * recorder handling noise or a fade.
 */
function loopBed(src: string, dest: string) {
  const T = LOOP_SECONDS + XFADE
  const tmp = join(TMP, 'loop.wav')
  ff([
    '-ss', '5', '-t', String(T), '-i', src,
    '-filter_complex',
    `[0:a]aformat=channel_layouts=mono,asplit=2[a][b];` +
      `[a]atrim=0:${T - XFADE},asetpts=N/SR/TB,asplit=2[a1][a2];` +
      `[b]atrim=${T - XFADE}:${T},asetpts=N/SR/TB[tail];` +
      `[a1]atrim=0:${XFADE},asetpts=N/SR/TB[head];` +
      `[a2]atrim=${XFADE},asetpts=N/SR/TB[body];` +
      `[tail][head]acrossfade=d=${XFADE}[x];` +
      `[x][body]concat=n=2:v=0:a=1[out]`,
    '-map', '[out]', '-ac', '1', '-ar', '44100', tmp,
  ])
  const gain = (-3 - peakDb(tmp)).toFixed(2)
  ff(['-i', tmp, '-af', `volume=${gain}dB`, '-ac', '1', '-c:a', 'aac', '-b:a', '64k', dest])
  rmSync(tmp, { force: true })
}

// ------------------------------------------------------------------- main

const TMP = join(tmpdir(), 'kt-voices')

async function main() {
  if (!TOKEN) {
    console.error(
      'FREESOUND_TOKEN is not set.\n' +
        'Get a free API token at https://freesound.org/apiv2/apply, then:\n' +
        '  export FREESOUND_TOKEN=...\n' +
        '  npx tsx scripts/fetch-voices.ts --list',
    )
    process.exit(1)
  }
  mkdirSync(TMP, { recursive: true })
  if (!LIST_ONLY) mkdirSync(OUT, { recursive: true })

  const manifest: Record<string, string[]> = {}
  const credits: { set: string; s: Sound }[] = []

  for (const spec of SETS) {
    if (ONLY_SET && ONLY_SET !== spec.name) continue
    console.log(`\n=== ${spec.name} (want ${spec.want})`)

    // Round-robin across the queries rather than draining the first one.
    // Five takes off "scream terror" are five takes by whoever uploaded the
    // most popular scream pack, and they sound like it.
    const seen = new Set<number>()
    const pools = await Promise.all(
      spec.queries.map((q) =>
        search(q, spec.dur, spec.want).catch((e: unknown) => {
          console.warn(`  ! ${q}: ${String(e)}`)
          return [] as Sound[]
        }),
      ),
    )
    const picks: Sound[] = []
    for (let i = 0; picks.length < spec.want; i++) {
      if (i >= Math.max(...pools.map((p) => p.length), 0)) break
      for (const pool of pools) {
        const s = pool[i]
        if (!s || seen.has(s.id) || picks.length >= spec.want) continue
        seen.add(s.id)
        picks.push(s)
      }
    }

    manifest[spec.name] = []
    for (const [i, s] of picks.entries()) {
      const label = `${s.name} — ${s.username} (${s.duration.toFixed(1)}s, ${s.num_downloads} dl)`
      if (LIST_ONLY) {
        console.log(`  ${String(i + 1).padStart(2)}. ${label}\n      ${s.url}`)
        continue
      }
      const file = `${spec.name}-${String(i + 1).padStart(2, '0')}.m4a`
      const dest = join(OUT, file)
      if (existsSync(dest)) {
        console.log(`  have ${file}`)
        manifest[spec.name]!.push(file)
        credits.push({ set: spec.name, s })
        continue
      }
      // HQ preview rather than the original. Downloading originals needs a
      // full OAuth2 flow; the preview is 128 kbps and every one of these is
      // about to be filtered by distance and folded into a mix anyway.
      const url = s.previews['preview-hq-mp3'] ?? s.previews['preview-hq-ogg']
      if (!url) {
        console.warn(`  ! no preview for ${s.id}`)
        continue
      }
      try {
        const res = await fetch(url, { headers: { Authorization: `Token ${TOKEN}` } })
        if (!res.ok) throw new Error(String(res.status))
        const raw = join(TMP, `raw-${s.id}.mp3`)
        writeFileSync(raw, Buffer.from(await res.arrayBuffer()))
        if (spec.loop) loopBed(raw, dest)
        else oneShot(raw, dest)
        rmSync(raw, { force: true })
        manifest[spec.name]!.push(file)
        credits.push({ set: spec.name, s })
        console.log(`  got  ${file}  ${label}`)
      } catch (e) {
        console.warn(`  ! ${s.id}: ${String(e)}`)
      }
    }
  }

  if (LIST_ONLY) return

  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ sets: manifest }, null, 2) + '\n')

  // Credits come from the API's own metadata. CC0 imposes no attribution
  // requirement, but the project credits everything it ships regardless, and a
  // recorded licence is what makes it checkable later that it really was CC0.
  const nonCC0 = credits.filter((c) => c.s.license.indexOf('/zero/') === -1)
  if (nonCC0.length) {
    console.error('\nRefusing to write credits: non-CC0 licence came back from the API:')
    for (const c of nonCC0) console.error(`  ${c.s.url} → ${c.s.license}`)
    process.exit(1)
  }
  // Written straight into CREDITS.md between its markers rather than left as a
  // fragment to paste. A credits step that needs a human to remember it is a
  // credits step that eventually does not happen.
  const body = credits
    .map((c) => `- **${c.set}** — [${c.s.name}](${c.s.url}) by ${c.s.username}, CC0`)
    .join('\n')
  const md = join(ROOT, 'CREDITS.md')
  const doc = readFileSync(md, 'utf8')
  const BEGIN = '<!-- voices:begin — generated by scripts/fetch-voices.ts -->'
  const END = '<!-- voices:end -->'
  const a = doc.indexOf(BEGIN)
  const b = doc.indexOf(END)
  if (a === -1 || b === -1) {
    console.error(`Could not find the voices markers in ${md}; credits not written.`)
    process.exit(1)
  }
  writeFileSync(md, `${doc.slice(0, a + BEGIN.length)}\n\n${body}\n\n${doc.slice(b)}`)

  const total = Object.values(manifest).flat().length
  console.log(`\n${total} samples in ${OUT}`)
  console.log(`${credits.length} entries written into CREDITS.md`)
}

main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
}).finally(() => rmSync(TMP, { recursive: true, force: true }))
