/**
 * Fetch the human-voice samples into public/assets/audio/voices/ and normalise
 * them into something the game can fire ten of at once.
 *
 * These are the only audio assets in the project — see `src/engine/samples.ts`
 * for why the voices are recorded and everything else is synthesised. The .m4a
 * output and the manifest are committed, so a clean checkout needs no network
 * and no token; this only needs re-running to change the sample set.
 *
 * There are two source tiers, and the split is about what a machine can fetch
 * unattended rather than about quality:
 *
 * - **Pinned** (default, no token). Specific files at known URLs, listed in
 *   `PINNED` below with the licence each one was published under. Nothing is
 *   searched for, so nothing can silently change underneath the build.
 * - **Freesound** (`--freesound`, needs a token). Searched at the API, filtered
 *   to Creative Commons 0. This is the better source — it is the only one with
 *   a real spread of takes — but it needs a key a human has to create.
 *
 * Requires: ffmpeg, and bsdtar (macOS `tar`) for the one archived pack.
 *
 *   npx tsx scripts/fetch-voices.ts                  # pinned sources only
 *   npx tsx scripts/fetch-voices.ts --freesound      # add Freesound CC0
 *   npx tsx scripts/fetch-voices.ts --freesound --list   # search, print, fetch nothing
 *
 * `--list` first is the intended workflow for the Freesound half. Search
 * relevance for "scream" is not the same thing as "sounds like a person in a
 * village at night", and the only way to tell is to look at what came back.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'public/assets/audio/voices')
const API = 'https://freesound.org/apiv2'
const UA = 'killer-tiger-asset-fetch/1.0'

const TOKEN = process.env.FREESOUND_TOKEN
const args = process.argv.slice(2)
const LIST_ONLY = args.includes('--list')
const WANT_FREESOUND = args.includes('--freesound')

/** A credit line. Every take that ships has one of these behind it. */
interface Credit {
  set: string
  title: string
  author: string
  license: string
  source: string
}

/**
 * Files fetched by exact URL, with the licence they were published under.
 *
 * Recorded by hand rather than read from an API because none of these sources
 * offers licence metadata over one — which is exactly why they are pinned to a
 * fixed URL and a fixed expectation. If an upstream file is ever replaced with
 * something under different terms, the URL is here to check against.
 *
 * Not all of this is CC0, and that is a change from how the rest of the
 * project's assets work. CC BY is free and commercially usable, but it puts an
 * attribution obligation on anyone shipping the game, discharged by the
 * generated block in CREDITS.md.
 */
interface Pinned {
  set: 'scream' | 'shout' | 'murmur'
  url: string
  title: string
  author: string
  license: string
  source: string
  /** Extract an archive and take every member matching this. */
  archive?: RegExp
  /** Build a seamless loop rather than trimming a one-shot. */
  loop?: boolean
}

const PINNED: Pinned[] = [
  {
    // Eleven real male pain and death cries, 0.5-1.1 s — which is exactly the
    // length the game's scream cue wants, and the reason this pack is worth an
    // attribution obligation when the CC0 alternatives are two files.
    set: 'scream',
    url: 'https://opengameart.org/sites/default/files/michelbaradari-human.7z',
    archive: /\.wav$/i,
    title: '11 male human pain/death sounds',
    author: 'Michel Baradari',
    license: 'CC BY 3.0',
    source: 'https://opengameart.org/content/11-male-human-paindeath-sounds',
  },
  {
    // The dry take only. The pack's other file has gverb printed into it, and
    // this engine adds its own distance reverb — baked-in room would put a
    // sample two hundred metres away in a hall while everything around it is
    // outdoors at night.
    set: 'scream',
    url: 'https://opengameart.org/sites/default/files/high_pitch_scream.mp3',
    title: 'High pitch scream sounds(2)',
    author: 'pauliuw',
    license: 'CC0',
    source: 'https://opengameart.org/content/high-pitch-scream-sounds2',
  },
  {
    // A minute of real crowd walla. Public domain, and genuinely a room full of
    // people rather than a synthesised approximation of one, which is the whole
    // point of the exercise.
    set: 'murmur',
    url: 'https://upload.wikimedia.org/wikipedia/commons/f/fd/1_minute_at_the_alexa_mall_in_berlin.ogg',
    loop: true,
    title: '1 minute at the Alexa mall in Berlin',
    author: 'thore',
    license: 'Public domain',
    source: 'https://commons.wikimedia.org/wiki/File:1_minute_at_the_alexa_mall_in_berlin.ogg',
  },
]

// `shout` has no pinned source. Nothing free and licence-clean that this
// script can reach unattended is a person calling out to someone — the packs
// above are pain, not speech — and a pain grunt fired when a hunter spots the
// tiger would be worse than the synthesised shout, not better. It stays
// synthesised until the Freesound half of this script runs.

/** Freesound searches. Only used with --freesound and a token. */
interface SetSpec {
  name: string
  queries: string[]
  dur: [number, number]
  want: number
  loop?: boolean
}

const SETS: SetSpec[] = [
  {
    name: 'scream',
    queries: ['scream terror', 'man scream', 'woman scream', 'panic scream human', 'screaming fear'],
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
    queries: ['crowd murmur walla', 'crowd talking background', 'market crowd ambience', 'village people talking'],
    dur: [20, 180],
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
    filter: `license:"Creative Commons 0" duration:[${dur[0]} TO ${dur[1]}]`,
    sort: 'downloads_desc',
    fields: 'id,name,username,license,url,duration,num_downloads,previews',
    page_size: String(n),
  })
  const res = await fetch(`${API}/search/text/?${params}`, {
    headers: { Authorization: `Token ${TOKEN}` },
  })
  if (!res.ok) throw new Error(`search "${query}" failed: ${res.status} ${await res.text()}`)
  return ((await res.json()) as { results?: Sound[] }).results ?? []
}

const ff = (a: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a])

/** Peak level in dBFS, via ffmpeg's volumedetect. */
function peakDb(file: string): number {
  const out = execFileSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const m = /max_volume:\s*(-?[\d.]+) dB/.exec(out)
  return m ? Number(m[1]) : 0
}

async function download(url: string, dest: string) {
  const res = await fetch(url, {
    headers: TOKEN && url.includes('freesound') ? { Authorization: `Token ${TOKEN}`, 'User-Agent': UA } : { 'User-Agent': UA },
  })
  if (!res.ok) throw new Error(`${res.status} for ${url}`)
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
}

/**
 * A one-shot: trim the silence off both ends, then normalise the peak.
 *
 * The trim matters more than it looks. These are uploads, not a sound library,
 * so a scream can sit behind a quarter-second of room tone — and the engine
 * schedules a voice to land at a particular moment, so leading silence is not
 * a level problem, it is a timing one.
 *
 * Peak normalisation rather than loudness normalisation is deliberate: what has
 * to be consistent is how close these get to the limiter, because a dozen of
 * them arrive together. Their relative loudness is then one number in config
 * (LEVELS.screamSample) instead of a property of whichever take fired.
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
  ff(['-i', tmp, '-af', `volume=${(-3 - peakDb(tmp)).toFixed(2)}dB`, '-ac', '1', '-c:a', 'aac', '-b:a', '96k', dest])
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
 * window slightly longer than the loop and crossfade its tail back over its own
 * head, which makes the two ends of the result identical by construction.
 *
 * Verified rather than assumed: on the material this was built against, the
 * step across the join measured below the *median* sample-to-sample step of the
 * audio either side of it.
 *
 * The window starts 5 s in because recordings of this kind commonly open with a
 * recorder being handled or a fade.
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
  ff(['-i', tmp, '-af', `volume=${(-3 - peakDb(tmp)).toFixed(2)}dB`, '-ac', '1', '-c:a', 'aac', '-b:a', '64k', dest])
  rmSync(tmp, { force: true })
}

// ------------------------------------------------------------------- main

const TMP = join(tmpdir(), 'kt-voices')
const manifest: Record<string, string[]> = { scream: [], shout: [], murmur: [] }
const credits: Credit[] = []

/** Next free filename in a set, so pinned and Freesound takes cannot collide. */
const nameFor = (set: string) => `${set}-${String(manifest[set]!.length + 1).padStart(2, '0')}.m4a`

async function doPinned() {
  console.log('=== pinned sources (no token needed)')
  for (const p of PINNED) {
    const raw = join(TMP, `raw-${p.url.split('/').pop()!}`)
    try {
      await download(p.url, raw)
    } catch (e) {
      console.warn(`  ! ${p.title}: ${String(e)}`)
      continue
    }

    // One entry can be an archive of many takes. bsdtar reads 7z, so this
    // needs no extra tool on macOS.
    let members: string[] = [raw]
    if (p.archive) {
      const dir = join(TMP, 'ex')
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      execFileSync('tar', ['-xf', raw, '-C', dir])
      const walk = (d: string): string[] =>
        readdirSync(d, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
        )
      members = walk(dir).filter((f) => p.archive!.test(f)).sort()
    }

    for (const m of members) {
      const file = nameFor(p.set)
      try {
        if (p.loop) loopBed(m, join(OUT, file))
        else oneShot(m, join(OUT, file))
      } catch (e) {
        console.warn(`  ! ${m}: ${String(e)}`)
        continue
      }
      manifest[p.set]!.push(file)
    }
    credits.push({ set: p.set, title: p.title, author: p.author, license: p.license, source: p.source })
    console.log(`  got  ${members.length.toString().padStart(2)} × ${p.set}  ${p.title} (${p.license})`)
  }
}

async function doFreesound() {
  if (!TOKEN) {
    console.error(
      '\n--freesound needs FREESOUND_TOKEN.\n' +
        'Get a free API token at https://freesound.org/apiv2/apply, then:\n' +
        '  export FREESOUND_TOKEN=...\n' +
        '  npx tsx scripts/fetch-voices.ts --freesound --list',
    )
    process.exit(1)
  }
  for (const spec of SETS) {
    console.log(`\n=== freesound: ${spec.name} (want ${spec.want})`)
    // Round-robin across the queries rather than draining the first one. Five
    // takes off "scream terror" are five takes by whoever uploaded the most
    // popular scream pack, and they sound like it.
    const pools = await Promise.all(
      spec.queries.map((q) =>
        search(q, spec.dur, spec.want).catch((e: unknown) => {
          console.warn(`  ! ${q}: ${String(e)}`)
          return [] as Sound[]
        }),
      ),
    )
    const seen = new Set<number>()
    const picks: Sound[] = []
    for (let i = 0; picks.length < spec.want && i < Math.max(0, ...pools.map((p) => p.length)); i++) {
      for (const pool of pools) {
        const s = pool[i]
        if (!s || seen.has(s.id) || picks.length >= spec.want) continue
        seen.add(s.id)
        picks.push(s)
      }
    }

    for (const [i, s] of picks.entries()) {
      const label = `${s.name} — ${s.username} (${s.duration.toFixed(1)}s, ${s.num_downloads} dl)`
      if (LIST_ONLY) {
        console.log(`  ${String(i + 1).padStart(2)}. ${label}\n      ${s.url}`)
        continue
      }
      // HQ preview rather than the original: downloading originals needs a full
      // OAuth2 flow, and every one of these is about to be filtered by distance
      // and folded into a mix anyway.
      const url = s.previews['preview-hq-mp3'] ?? s.previews['preview-hq-ogg']
      if (!url) {
        console.warn(`  ! no preview for ${s.id}`)
        continue
      }
      const file = nameFor(spec.name)
      try {
        const raw = join(TMP, `fs-${s.id}.mp3`)
        await download(url, raw)
        if (spec.loop) loopBed(raw, join(OUT, file))
        else oneShot(raw, join(OUT, file))
        rmSync(raw, { force: true })
      } catch (e) {
        console.warn(`  ! ${s.id}: ${String(e)}`)
        continue
      }
      manifest[spec.name]!.push(file)
      credits.push({
        set: spec.name,
        title: s.name,
        author: s.username,
        license: s.license.includes('/zero/') ? 'CC0' : s.license,
        source: s.url,
      })
      console.log(`  got  ${file}  ${label}`)
    }
  }
}

/**
 * Write the credits between the markers in CREDITS.md.
 *
 * Straight into the file rather than left as a fragment to paste, because a
 * credits step that needs a human to remember it is a credits step that
 * eventually does not happen — and unlike the CC0 material, the CC BY entries
 * here are an actual licence condition rather than a courtesy.
 */
function writeCredits() {
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
  const body = credits
    .map((c) => `- **${c.set}** — [${c.title}](${c.source}) by ${c.author} — ${c.license}`)
    .join('\n')
  writeFileSync(md, `${doc.slice(0, a + BEGIN.length)}\n\n${body}\n\n${doc.slice(b)}`)
}

async function main() {
  mkdirSync(TMP, { recursive: true })
  if (!LIST_ONLY) mkdirSync(OUT, { recursive: true })

  if (!LIST_ONLY) await doPinned()
  if (WANT_FREESOUND) await doFreesound()
  if (LIST_ONLY) return

  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ sets: manifest }, null, 2) + '\n')
  writeCredits()

  const total = Object.values(manifest).flat().length
  for (const [k, v] of Object.entries(manifest)) {
    console.log(`  ${k.padEnd(7)} ${v.length}${v.length ? '' : '   (synthesised — no recorded source)'}`)
  }
  console.log(`\n${total} samples in ${OUT}`)
  console.log(`${credits.length} entries written into CREDITS.md`)
  if (credits.some((c) => c.license.startsWith('CC BY'))) {
    console.log('NOTE: CC BY material is included. Attribution in CREDITS.md is a licence condition.')
  }
}

main()
  .catch((e: unknown) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => rmSync(TMP, { recursive: true, force: true }))
