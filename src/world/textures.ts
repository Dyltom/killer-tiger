/**
 * Procedural canvas textures.
 *
 * Surfaces that read as *material* — ground, bark, rock, clay, thatch — are
 * scanned PBR sets loaded by materials.ts; nothing hand-drawn competes with a
 * photograph there. What stays procedural is the set of alpha cut-outs and
 * one-off maps where the shape matters more than the surface: grass blades,
 * leaf clusters, tiger fur, blood, and the particle sprites.
 */
import * as THREE from 'three'
import { fbm, Rng } from '../engine/rng'

function make(size: number, draw: (c: CanvasRenderingContext2D, s: number) => void): THREE.CanvasTexture {
  const cv = document.createElement('canvas')
  cv.width = cv.height = size
  const c = cv.getContext('2d')!
  draw(c, size)
  const tex = new THREE.CanvasTexture(cv)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  return tex
}

/**
 * Fraction of texels that would survive an alpha test, with alpha scaled.
 * Sampled on a half-texel grid so the estimate is stable at small mip sizes.
 */
function alphaCoverage(img: ImageData, alphaTest: number, scale: number): number {
  const d = img.data
  let hit = 0
  for (let i = 3; i < d.length; i += 4) if (d[i]! * scale >= alphaTest * 255) hit++
  return hit / (d.length / 4)
}

/**
 * Mip chain that keeps the alpha-tested coverage constant at every level.
 *
 * This is the fix for the single worst artifact in cut-out foliage. A box
 * filter averages a dense clump of blades up toward opaque, so by mip 3 the
 * bottom of a grass card tests solid and the tuft renders as a dark rectangle
 * lying in the field. (Conversely a sparse leaf card dissolves to nothing.)
 * Rescaling each level's alpha so the same fraction of texels passes the test
 * — Ignacio Castaño's alpha-to-coverage mip trick, which is what Unity's
 * "Mip Maps Preserve Coverage" and UE's equivalent do — keeps a tuft reading
 * as a tuft all the way out to the fade distance.
 */
function coverageMipmaps(source: HTMLCanvasElement, alphaTest: number): HTMLCanvasElement[] {
  const ctx = source.getContext('2d')!
  const target = alphaCoverage(ctx.getImageData(0, 0, source.width, source.height), alphaTest, 1)
  const mips: HTMLCanvasElement[] = [source]

  let w = source.width
  let h = source.height
  // Downsample from the previous *unscaled* level; feeding a rescaled level
  // back in would compound the correction and drive alpha to 1 everywhere.
  let prev = source
  while (w > 1 || h > 1) {
    w = Math.max(1, w >> 1)
    h = Math.max(1, h >> 1)
    const cv = document.createElement('canvas')
    cv.width = w
    cv.height = h
    const c = cv.getContext('2d')!
    c.imageSmoothingEnabled = true
    c.imageSmoothingQuality = 'high'
    c.drawImage(prev, 0, 0, w, h)
    prev = cv

    const img = c.getImageData(0, 0, w, h)
    // Bisect for the alpha multiplier that restores mip 0's coverage.
    let lo = 0
    let hi = 6
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2
      if (alphaCoverage(img, alphaTest, mid) > target) hi = mid
      else lo = mid
    }
    const scale = (lo + hi) / 2
    const scaled = document.createElement('canvas')
    scaled.width = w
    scaled.height = h
    const d = img.data
    for (let i = 3; i < d.length; i += 4) d[i] = Math.min(255, d[i]! * scale)
    scaled.getContext('2d')!.putImageData(img, 0, 0)
    mips.push(scaled)
  }
  return mips
}

/**
 * Give a cut-out texture coverage-preserving mips. Must be called with the
 * same alphaTest the material uses, or the correction is aimed at the wrong
 * threshold.
 */
function preserveCoverage(tex: THREE.CanvasTexture, alphaTest: number) {
  tex.mipmaps = coverageMipmaps(tex.image as HTMLCanvasElement, alphaTest) as never
  tex.generateMipmaps = false
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.needsUpdate = true
}

/** Overlay fbm-driven grain on whatever has already been drawn. */
function grain(c: CanvasRenderingContext2D, s: number, scale: number, strength: number, tint = [0, 0, 0]) {
  const img = c.getImageData(0, 0, s, s)
  const d = img.data
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const n = fbm((x / s) * scale, (y / s) * scale, 4)
      const i = (y * s + x) * 4
      d[i] = Math.max(0, Math.min(255, d[i]! + n * strength + tint[0]! * n))
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1]! + n * strength + tint[1]! * n))
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2]! + n * strength + tint[2]! * n))
    }
  }
  c.putImageData(img, 0, 0)
}

let cache: Record<string, THREE.Texture> | null = null

export function textures() {
  if (cache) return cache

  // ------------------------------------------------------------ tiger fur (paws)
  // The forepaws are the closest object to the camera in the whole game, so
  // this one texture is held to a much higher standard than the rest.
  //
  // Stripe scale is the whole game here, and it is easy to miss in both
  // directions. Wide bands on a 256 map blurred into a cream-and-brown beach
  // ball; 20 narrow ones at a 2x vertical repeat gave 40 rings down a 30 cm
  // leg, which read as corduroy. A real tiger carries stripes about a hand's
  // width apart, so 11 bold stripes at the material's 0.55 vertical repeat
  // puts roughly six of them on the visible foreleg. Stripes run along the
  // texture's x, which is the cylinder's circumference, so they wrap the leg
  // as rings the way they do on the animal.
  const fur = make(512, (c, s) => {
    const g = c.createLinearGradient(0, 0, 0, s)
    // Darker and less saturated than it looks like it should be on the swatch.
    // These are albedo values, and the paws are lit by a low sun at intensity 3
    // and then run through bloom, so a #d97a24 base — a perfectly reasonable
    // tiger orange in isolation — came out of the pipe as a glowing traffic cone
    // and made the forepaws read as plush toys against a photographic ground.
    g.addColorStop(0, '#b4661d')
    g.addColorStop(0.5, '#a35415')
    g.addColorStop(0.82, '#c48c48')
    g.addColorStop(1, '#dcc7ab')
    c.fillStyle = g
    c.fillRect(0, 0, s, s)

    const rng = new Rng(1972)
    c.fillStyle = '#150e0a'
    // Tapered to a point at both ends and forking now and then — a stripe of
    // constant width reads as painted-on tape however dark you make it.
    const stripe = (y: number, w: number, x0: number, x1: number, alpha: number) => {
      const wob = rng.range(5, 13)
      const freq = rng.range(0.02, 0.05)
      const ph = rng.range(0, 6.3)
      const wave = (x: number) => Math.sin(x * freq + ph) * wob
      const taper = (x: number) => Math.sin(((x - x0) / (x1 - x0)) * Math.PI) ** 0.5
      c.save()
      c.globalAlpha = alpha
      c.beginPath()
      c.moveTo(x0, y + wave(x0))
      for (let x = x0; x <= x1; x += 6) c.lineTo(x, y + wave(x) - w * taper(x) * 0.5)
      for (let x = x1; x >= x0; x -= 6) c.lineTo(x, y + wave(x) + w * taper(x) * 0.5)
      c.closePath()
      c.fill()
      c.restore()
    }
    for (let i = 0; i < 11; i++) {
      const y = (i / 11) * s + rng.range(-11, 11)
      const w = rng.range(15, 31)
      // Most stripes ring the whole leg; some die out partway round.
      if (rng.chance(0.68)) stripe(y, w, -20, s + 20, rng.range(0.8, 0.97))
      else {
        const x0 = rng.range(-20, s * 0.35)
        stripe(y, w, x0, x0 + rng.range(s * 0.45, s * 0.8), rng.range(0.75, 0.95))
      }
      // A fork trailing off one end of every third stripe or so.
      if (rng.chance(0.34)) {
        const x0 = rng.range(0, s * 0.55)
        stripe(y + rng.range(20, 34), w * rng.range(0.35, 0.6), x0, x0 + rng.range(s * 0.25, s * 0.5), rng.range(0.55, 0.8))
      }
    }

    // Fur direction strokes, light and dark, kept faint. These are meant to
    // break the flat fill up close, not to be seen as individual hairs — at
    // full strength they turned the whole coat into wood grain.
    for (let i = 0; i < 5200; i++) {
      const x = rng.range(0, s)
      const y = rng.range(0, s)
      const lit = rng.chance(0.55)
      c.strokeStyle = lit
        ? `rgba(255,226,190,${rng.range(0.02, 0.07)})`
        : `rgba(60,32,15,${rng.range(0.02, 0.06)})`
      c.lineWidth = 1
      c.beginPath()
      c.moveTo(x, y)
      c.lineTo(x + rng.range(-1.2, 1.2), y + rng.range(4, 11))
      c.stroke()
    }
    grain(c, s, 26, 8)
  })

  // ------------------------------------------------------------ cloth (villager)
  const cloth = make(64, (c, s) => {
    c.fillStyle = '#8d8471'
    c.fillRect(0, 0, s, s)
    const rng = new Rng(303)
    for (let i = 0; i < 400; i++) {
      c.fillStyle = `rgba(${rng.int(90, 160)},${rng.int(85, 150)},${rng.int(75, 130)},0.5)`
      c.fillRect(rng.range(0, s), rng.range(0, s), rng.range(1, 4), rng.range(1, 3))
    }
  })

  // ------------------------------------------------------------ blood splat (alpha decal)
  const blood = make(128, (c, s) => {
    c.clearRect(0, 0, s, s)
    const rng = new Rng(666)
    const cx = s / 2
    const cy = s / 2
    c.fillStyle = '#8e0f14'
    c.beginPath()
    for (let a = 0; a < Math.PI * 2; a += 0.16) {
      const r = s * 0.26 * (0.65 + Math.abs(fbm(Math.cos(a) * 2 + 3, Math.sin(a) * 2 + 3, 3)) * 1.5)
      const x = cx + Math.cos(a) * r
      const y = cy + Math.sin(a) * r
      if (a === 0) c.moveTo(x, y)
      else c.lineTo(x, y)
    }
    c.closePath()
    c.fill()
    // Satellite droplets.
    for (let i = 0; i < 26; i++) {
      const a = rng.range(0, Math.PI * 2)
      const d = rng.range(s * 0.22, s * 0.47)
      c.globalAlpha = rng.range(0.5, 1)
      c.beginPath()
      c.ellipse(cx + Math.cos(a) * d, cy + Math.sin(a) * d, rng.range(1.5, 6), rng.range(1.5, 5), a, 0, Math.PI * 2)
      c.fill()
    }
  })
  blood.wrapS = blood.wrapT = THREE.ClampToEdgeWrapping

  // ------------------------------------------------------------ grass blade card
  // A clump of tapered blades on transparent black. Alpha-tested, so the
  // silhouette is everything: blades taper to a point, lean in both directions,
  // and darken toward the base to fake self-shadowing inside the clump.
  //
  // The count is a balance and the failure at the dense end is the worse one.
  // Piling on blades until the lower third of the card is 100% covered turns
  // every instance into an opaque slab with a hard bottom edge and hard vertical
  // sides — a field of upright doors with grass printed on the top half. Total
  // base coverage has to stay under 1x so daylight gets through between the
  // roots; the density in the field then comes from 92,000 overlapping cards,
  // not from any single one being solid.
  const grassBlade = make(512, (c, s) => {
    c.clearRect(0, 0, s, s)
    const rng = new Rng(404)
    /** @param shade 0 = deep inside the clump, 1 = full sun on the outside. */
    /** Tips of the front rank, so seed heads can sit on a stalk. */
    const tips: [number, number][] = []
    const blade = (x0: number, h: number, lean: number, w: number, dry: boolean, shade: number) => {
      const tipX = x0 + lean
      const tipY = s - h
      tips.push([tipX, tipY])
      const midX = x0 + lean * 0.42
      const midY = s - h * 0.55
      const k = 0.34 + shade * 0.66
      const rgb = (r: number, g2: number, b: number) =>
        `rgb(${Math.round(r * k)},${Math.round(g2 * k)},${Math.round(b * k)})`
      const g = c.createLinearGradient(0, s, 0, tipY)
      // Base is nearly black — inside a clump almost no light reaches the soil.
      g.addColorStop(0, rgb(dry ? 46 : 30, dry ? 38 : 40, dry ? 20 : 20))
      g.addColorStop(0.3, rgb(dry ? 118 : 74, dry ? 100 : 98, dry ? 48 : 40))
      g.addColorStop(0.72, rgb(dry ? 186 : 122, dry ? 162 : 152, dry ? 92 : 66))
      g.addColorStop(1, rgb(dry ? 226 : 168, dry ? 206 : 194, dry ? 136 : 96))
      c.fillStyle = g
      c.beginPath()
      c.moveTo(x0 - w, s)
      c.quadraticCurveTo(midX - w * 0.55, midY, tipX, tipY)
      c.quadraticCurveTo(midX + w * 0.55, midY, x0 + w, s)
      c.closePath()
      c.fill()
    }
    // Back rank first so the front blades overlap them. Each rank is lighter
    // and taller than the last, which fakes depth inside a single flat card.
    // Widths are half-widths, so a rank contributes count * 2 * avgW pixels of
    // base across 512 — keep the three ranks summing to roughly 0.7x.
    for (let i = 0; i < 26; i++) {
      blade(rng.range(6, s - 6), rng.range(s * 0.22, s * 0.5), rng.range(-30, 30), rng.range(1.8, 3.4), rng.chance(0.4), rng.range(0.1, 0.4))
    }
    for (let i = 0; i < 20; i++) {
      blade(rng.range(8, s - 8), rng.range(s * 0.42, s * 0.76), rng.range(-46, 46), rng.range(2.2, 4.2), rng.chance(0.34), rng.range(0.4, 0.75))
    }
    for (let i = 0; i < 14; i++) {
      blade(rng.range(14, s - 14), rng.range(s * 0.7, s * 0.98), rng.range(-62, 62), rng.range(2.6, 5), rng.chance(0.3), rng.range(0.75, 1))
    }
    // Seed heads catch the low sun and break the flat top edge. Each one sits on
    // an existing blade tip: floating in clear space they read as grains of rice
    // hanging in mid-air once the card is alpha-tested.
    for (let i = 0; i < 7; i++) {
      // The front rank is the last one drawn, so its tips are the tail of the list.
      const tip = tips[tips.length - 1 - rng.int(0, 13)]!
      const [x, y] = tip
      if (x < 12 || x > s - 12) continue
      c.fillStyle = `rgba(${rng.int(170, 206)},${rng.int(154, 188)},${rng.int(104, 140)},0.8)`
      c.beginPath()
      c.ellipse(x, y + rng.range(5, 11), rng.range(1.4, 2.4), rng.range(8, 14), rng.range(-0.25, 0.25), 0, Math.PI * 2)
      c.fill()
    }
  })
  grassBlade.wrapS = grassBlade.wrapT = THREE.ClampToEdgeWrapping
  // Matches leafMaterial's alphaTest for grass in flora.ts.
  preserveCoverage(grassBlade, 0.28)

  // ------------------------------------------------------------ canopy leaf card
  // One card is a whole sub-branch of foliage. Scattering a few dozen of these
  // per tree reads as a canopy where a solid mesh blob reads as a lollipop.
  const leafCard = make(512, (c, s) => {
    c.clearRect(0, 0, s, s)
    const rng = new Rng(808)
    const cx = s / 2
    // Twig running up the middle for the leaves to hang off, plus two side
    // shoots — a single stem gives every card the same recognisable shape.
    c.strokeStyle = 'rgba(48,36,22,0.95)'
    c.lineCap = 'round'
    c.lineWidth = 7
    c.beginPath()
    c.moveTo(cx, s)
    c.quadraticCurveTo(cx + 16, s * 0.5, cx - 8, s * 0.12)
    c.stroke()
    c.lineWidth = 4
    for (const [t, dir] of [[0.62, -1], [0.42, 1]] as const) {
      c.beginPath()
      c.moveTo(cx + 8 * (1 - t), s * t)
      c.quadraticCurveTo(cx + dir * s * 0.14, s * (t - 0.14), cx + dir * s * 0.28, s * (t - 0.24))
      c.stroke()
    }

    for (let i = 0; i < 620; i++) {
      // Cluster density falls off toward the edges so the card has a soft,
      // organic silhouette instead of a rectangle of leaves.
      const t = rng.next()
      const along = s * (0.08 + t * 0.9)
      const spread = s * 0.44 * Math.sin(t * Math.PI) ** 0.6
      const x = cx + rng.range(-spread, spread)
      const y = s - along + rng.range(-18, 18)
      if (x < 2 || x > s - 2) continue
      // Sunlit leaves at the top and outside, shadowed ones deep inside.
      const depth = 1 - Math.abs(x - cx) / (spread + 1)
      const lit = rng.range(0, 1) > depth * 0.75
      const r = lit ? rng.int(96, 152) : rng.int(34, 68)
      const g = lit ? rng.int(126, 184) : rng.int(56, 96)
      const b = lit ? rng.int(44, 78) : rng.int(24, 46)
      c.fillStyle = `rgba(${r},${g},${b},${rng.range(0.85, 1)})`
      c.beginPath()
      c.ellipse(x, y, rng.range(4, 10), rng.range(2.5, 5.5), rng.range(0, Math.PI), 0, Math.PI * 2)
      c.fill()
    }
  })
  leafCard.wrapS = leafCard.wrapT = THREE.ClampToEdgeWrapping
  // Matches leafMaterial's default alphaTest in flora.ts.
  preserveCoverage(leafCard, 0.42)

  // ------------------------------------------------------------ soft particle sprite
  // Radial falloff with a slightly hot core. Every particle in the game samples
  // this, which is what turns hard GL points into smoke, blood and embers.
  const spark = make(64, (c, s) => {
    c.clearRect(0, 0, s, s)
    const g = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.28, 'rgba(255,255,255,0.85)')
    g.addColorStop(0.65, 'rgba(255,255,255,0.24)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    c.fillStyle = g
    c.fillRect(0, 0, s, s)
  })
  spark.wrapS = spark.wrapT = THREE.ClampToEdgeWrapping

  // ------------------------------------------------------------ smoke puff
  const smoke = make(128, (c, s) => {
    c.clearRect(0, 0, s, s)
    const rng = new Rng(1313)
    for (let i = 0; i < 40; i++) {
      const a = rng.range(0, Math.PI * 2)
      const d = rng.range(0, s * 0.26)
      const x = s / 2 + Math.cos(a) * d
      const y = s / 2 + Math.sin(a) * d
      const r = rng.range(s * 0.1, s * 0.24)
      const g = c.createRadialGradient(x, y, 0, x, y, r)
      g.addColorStop(0, `rgba(255,255,255,${rng.range(0.06, 0.16)})`)
      g.addColorStop(1, 'rgba(255,255,255,0)')
      c.fillStyle = g
      c.beginPath()
      c.arc(x, y, r, 0, Math.PI * 2)
      c.fill()
    }
  })
  smoke.wrapS = smoke.wrapT = THREE.ClampToEdgeWrapping

  cache = { fur, cloth, blood, grassBlade, leafCard, spark, smoke }
  return cache
}
