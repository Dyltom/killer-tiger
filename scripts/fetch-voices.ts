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
  /**
   * Which villagers this pack can speak for. Defaults to `m`.
   *
   * The cue name and the voice are separate axes because they fail separately:
   * a set can be missing because nobody published a usable recording of it, or
   * because the half of the cast that would use it has no source yet. Keeping
   * them separate means the second case degrades to "women use the men's
   * takes" rather than to "nobody screams" — see `pick()` in samples.ts.
   *
   * `murmur` is a room of people and has no voice; leaving it unset is correct
   * rather than an omission.
   */
  voice?: 'm' | 'f'
  url: string
  title: string
  author: string
  license: string
  source: string
  /** Extract an archive and take every member matching this. */
  archive?: RegExp
  /**
   * Keep only members whose *trimmed* length falls in this window, in seconds.
   *
   * Trimmed, not as published: a pack can be cut on half-second boundaries with
   * room tone padding every file out to the grid, in which case the length on
   * disk says nothing about the length of the sound. The filter therefore costs
   * one extra trim per candidate, which is a fetch-time cost and not a
   * ship-time one.
   */
  dur?: [number, number]
  /**
   * Cap on how many members to keep, selected by an even stride through the
   * name-sorted survivors rather than by taking the first N.
   *
   * Packs of this kind are named `<vocalist><take>`, so name order groups all of
   * one person's takes together and the first N would be one voice. A stride
   * spreads the selection over everybody in the pack, which for a cue that
   * fires once per villager is the entire point.
   */
  want?: number
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
    //
    // Filed under `f`, which is where it always belonged. Its median voiced f0
    // is 400 Hz against 103-170 Hz for the eleven Baradari takes above, so for
    // as long as `scream` was one undifferentiated pool this was a woman's
    // scream that a male villager had a one-in-twelve chance of producing.
    // Splitting the pool fixed a miscast that predates the split.
    set: 'scream',
    voice: 'f',
    url: 'https://opengameart.org/sites/default/files/high_pitch_scream.mp3',
    title: 'High pitch scream sounds(2)',
    author: 'pauliuw',
    license: 'CC0',
    source: 'https://opengameart.org/content/high-pitch-scream-sounds2',
  },
  {
    // Four women screaming, 0.6-1.3 s, which is the same window the Baradari
    // pack covers for the men.
    //
    // Taken as CC BY 3.0, the licence on the page, and not as the CC0 that four
    // of the five entries in the pack's own license.txt carry. That file is a
    // per-source manifest listing five originals — one CC BY 3.0
    // (`women_scream_AAA.aiff`) and four CC0 — and the zip contains four files
    // named `1.ogg`-`4.ogg`, so the obvious reading is that the CC BY original
    // is the one that was dropped and everything shipping here is CC0.
    //
    // The obvious reading is not a verified one. There is no `0.ogg` to anchor
    // the offset, and the members have been trimmed and re-encoded, so the
    // mapping cannot be recovered from the audio: the check that would have
    // settled it — entry 1 is `Girl_Two_Screams`, so its file should contain
    // two bursts — came back with no internal silence in any of the four, and
    // `1.ogg` is 0.61 s, too short to hold two screams either way. Rather than
    // credit under terms that might be a decibel short of the truth, all four
    // are credited under the strictest licence in the pack. CC BY discharges a
    // CC0 obligation; the reverse does not.
    set: 'scream',
    voice: 'f',
    url: 'https://opengameart.org/sites/default/files/female_screams.zip',
    archive: /\d+\.ogg$/i,
    title: 'Female screams',
    author: 'congusbongus, from Freesound recordings by thanvannispen, tcrocker68, pushkin and Archeos',
    license: 'CC BY 3.0',
    source: 'https://opengameart.org/content/female-screams',
  },
  {
    // Three voice actors' worth of wordless RPG barks. CC0, single tag for the
    // whole pack, so unlike the screams above there is nothing to disambiguate.
    //
    // Only the `attack` takes. The pack also has `damaged`, `jump`, `healed`
    // and spoken spell names: the spoken lines are English words and this
    // village does not speak any, `healed` and `jump` are the wrong events, and
    // `damaged` is a 0.3-0.5 s hit reaction rather than a death. Firing an
    // "ugh" where the male set fires a 1 s death cry would put the exact
    // cheapness this whole exercise is about back into the one cue that cannot
    // afford it. `attack` is a person yelling at something, which is what the
    // shout cue is.
    //
    // All three voice types, not a chosen subset. Their median voiced f0 runs
    // 281-457 Hz with no type separated from the others, so there is no
    // measurement that would justify dropping one, and the pack's own
    // descriptions of them are about acting rather than pitch.
    set: 'shout',
    voice: 'f',
    url: 'https://opengameart.org/sites/default/files/RPG%20Voice%20Starter%20Pack.zip',
    archive: /Type [123]\/attack[123]\.wav$/i,
    title: 'Female RPG Voice Starter Pack',
    author: 'cicifyre',
    license: 'CC0',
    source: 'https://opengameart.org/content/female-rpg-voice-starter-pack',
  },
  {
    // Four men yelling, 10-16 takes each. Dual licensed OGA-BY 3.0 and CC0;
    // taken under CC0, so this adds no obligation.
    //
    // 62 files go in and 16 come out. The window drops both ends for the same
    // reason: under 0.35 s the pack's effort grunts and clipped takes, over
    // 0.95 s the sustained screams, and what is left is the length of a person
    // calling out to someone rather than to nobody. Everything here is padded
    // out to a half-second grid on disk, so this is measured after the trim.
    set: 'shout',
    url: 'https://opengameart.org/sites/default/files/yelling%20sounds.zip',
    archive: /yell\d+\.wav$/i,
    dur: [0.35, 0.95],
    want: 16,
    title: 'Male Grunt/Yelling sounds',
    author: 'HaelDB',
    license: 'CC0',
    source: 'https://opengameart.org/content/male-gruntyelling-sounds',
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

// The note that used to sit here said `shout` had no pinned source, because
// the scream packs above are pain rather than speech and a pain grunt fired
// when a hunter spots the tiger would be worse than the synthesised shout. The
// first half of that is still true; the conclusion was wrong, and it was wrong
// because "nothing exists" had been inferred from two packs rather than looked
// for. HaelDB's pack is four people yelling into a good microphone, dual
// licensed OGA-BY 3.0 and CC0, and taken here under CC0.
//
// It matters more than one missing cue. `shout` fires the moment a villager
// sees the tiger, which is the loudest human sound in a typical round and the
// one that sets the tone for everything after it, and it was the last cue still
// running the voice synthesis that was rejected twice.

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
/**
 * Strip leading and trailing silence. Shared so that the length `Pinned.dur`
 * filters on is the length that actually ships, rather than two trims that
 * agree until one of them is edited.
 */
const TRIM =
  'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.01,' +
  'areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse'

/** How long `src` is once trimmed, in seconds. Used to select archive members. */
function trimmedSeconds(src: string): number {
  const tmp = join(TMP, 'measure.wav')
  ff(['-i', src, '-af', TRIM, '-ac', '1', '-ar', '44100', tmp])
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', tmp],
    { encoding: 'utf8' },
  )
  rmSync(tmp, { force: true })
  return Number(out.trim()) || 0
}

/** Overall RMS in dBFS, via ffmpeg's astats. */
function rmsDb(file: string): number {
  const out = execFileSync(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-i', file,
     '-af', 'astats=metadata=1:reset=0,ametadata=mode=print:file=-', '-f', 'null', '-'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const all = [...out.matchAll(/astats\.Overall\.RMS_level=(-?[\d.]+)/g)]
  return all.length ? Number(all[all.length - 1]![1]) : 0
}

/**
 * Where a peak-normalised take of this material lands, in dBFS RMS.
 *
 * Not a target chosen on principle — it is measured. The eleven Baradari
 * screams come out of the peak normalisation at a median of -22.4 and the
 * sixteen HaelDB shouts at -24.5, and those two sets are what every level in
 * `LEVELS` was tuned against in a browser. Anything within a decibel or two of
 * this is left alone; the number exists to catch the take that is nowhere near.
 */
const TARGET_RMS = -22

function oneShot(src: string, dest: string) {
  const tmp = join(TMP, 'trim.wav')
  ff([
    '-i', src,
    '-af', TRIM,
    '-ac', '1', '-ar', '44100', tmp,
  ])
  // Peak first, then pull back anything far louder than the rest at that peak.
  //
  // Peak normalisation alone is not enough, and the female scream pack is why:
  // measured after it, those five sat at a median of -11.2 dBFS RMS against
  // -22.4 for the male screams — the same distance from the limiter and eleven
  // decibels louder to the ear, because they are dense, already-compressed
  // uploads where the men's takes are a cry with air around it. Shipped as-is
  // that is not a woman screaming, it is a woman screaming through a megaphone
  // while the man beside her uses his voice.
  //
  // Attenuate only, never boost, which is what keeps the paragraph above this
  // function true. The peak target is about headroom — a dozen of these arrive
  // together and the limiter has to survive it — and a gain that could go
  // positive would spend that headroom to make a quiet take match a loud one,
  // which is the compressor's job and not the fetch script's. Clamped at zero,
  // the male sets measure inside a decibel of `TARGET_RMS` and come through
  // untouched, so every level already tuned against them still holds.
  const peakGain = -3 - peakDb(tmp)
  // The RMS the peak normalisation would leave, which is what `TARGET_RMS` is a
  // figure for — measuring `tmp` directly would compare raw uploads.
  const trim = Math.min(0, TARGET_RMS - (rmsDb(tmp) + peakGain))
  ff([
    '-i', tmp,
    '-af', `volume=${(peakGain + trim).toFixed(2)}dB`,
    '-ac', '1', '-c:a', 'aac', '-b:a', '96k', dest,
  ])
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

/**
 * Manifest key for a cue and a voice, and also the filename stem.
 *
 * `m` is unsuffixed so that a manifest written before the voices were split
 * still names every male set exactly as it did — the female sets are additive,
 * and an old checkout's assets keep working against the new loader.
 */
const keyFor = (set: string, voice?: 'm' | 'f') => (voice === 'f' ? `${set}-f` : set)

const manifest: Record<string, string[]> = {
  scream: [],
  shout: [],
  murmur: [],
  'scream-f': [],
  'shout-f': [],
}
const credits: Credit[] = []

/** Next free filename in a set, so pinned and Freesound takes cannot collide. */
const nameFor = (key: string) => `${key}-${String(manifest[key]!.length + 1).padStart(2, '0')}.m4a`

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

    if (p.dur) {
      const [lo, hi] = p.dur
      const before = members.length
      members = members.filter((m) => {
        const d = trimmedSeconds(m)
        return d >= lo && d <= hi
      })
      console.log(`  dur  ${before} -> ${members.length} in [${lo}, ${hi}]s after trim`)
    }
    if (p.want && members.length > p.want) {
      // Even stride through name order, so the takes come from everyone in the
      // pack rather than from whoever sorts first. See `want` on Pinned.
      const step = members.length / p.want
      const spread = Array.from({ length: p.want }, (_, i) => members[Math.floor(i * step)]!)
      console.log(`  pick ${members.length} -> ${spread.length} by stride ${step.toFixed(2)}`)
      members = spread
    }

    const key = keyFor(p.set, p.voice)
    for (const m of members) {
      const file = nameFor(key)
      try {
        if (p.loop) loopBed(m, join(OUT, file))
        else oneShot(m, join(OUT, file))
      } catch (e) {
        console.warn(`  ! ${m}: ${String(e)}`)
        continue
      }
      manifest[key]!.push(file)
    }
    credits.push({ set: key, title: p.title, author: p.author, license: p.license, source: p.source })
    console.log(`  got  ${members.length.toString().padStart(2)} × ${key}  ${p.title} (${p.license})`)
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
