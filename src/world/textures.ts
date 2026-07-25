/**
 * Procedural canvas textures. Zero external assets means the game always
 * loads, works offline, and has no licensing to track.
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

  // ------------------------------------------------------------ ground
  const ground = make(512, (c, s) => {
    c.fillStyle = '#4b5a32'
    c.fillRect(0, 0, s, s)
    const rng = new Rng(7)
    // Dry patches + soil showing through.
    for (let i = 0; i < 260; i++) {
      const x = rng.range(0, s)
      const y = rng.range(0, s)
      const r = rng.range(6, 46)
      const g = c.createRadialGradient(x, y, 0, x, y, r)
      const dry = rng.chance(0.45)
      g.addColorStop(0, dry ? 'rgba(122,105,60,0.45)' : 'rgba(52,72,38,0.4)')
      g.addColorStop(1, 'rgba(0,0,0,0)')
      c.fillStyle = g
      c.beginPath()
      c.arc(x, y, r, 0, Math.PI * 2)
      c.fill()
    }
    // Grass flecks.
    for (let i = 0; i < 3200; i++) {
      const x = rng.range(0, s)
      const y = rng.range(0, s)
      c.strokeStyle = rng.chance(0.5) ? 'rgba(96,120,56,0.55)' : 'rgba(38,54,28,0.5)'
      c.lineWidth = 1
      c.beginPath()
      c.moveTo(x, y)
      c.lineTo(x + rng.range(-2, 2), y - rng.range(2, 6))
      c.stroke()
    }
    grain(c, s, 9, 22)
  })
  ground.repeat.set(60, 60)

  // ------------------------------------------------------------ dirt path
  const dirt = make(256, (c, s) => {
    c.fillStyle = '#6d5738'
    c.fillRect(0, 0, s, s)
    const rng = new Rng(23)
    for (let i = 0; i < 500; i++) {
      c.fillStyle = rng.chance(0.5) ? 'rgba(90,72,46,0.5)' : 'rgba(52,42,28,0.4)'
      const x = rng.range(0, s)
      const y = rng.range(0, s)
      c.beginPath()
      c.ellipse(x, y, rng.range(1, 7), rng.range(1, 5), rng.range(0, 3), 0, Math.PI * 2)
      c.fill()
    }
    grain(c, s, 14, 26)
  })
  dirt.repeat.set(4, 4)

  // ------------------------------------------------------------ bark
  const bark = make(256, (c, s) => {
    c.fillStyle = '#43331f'
    c.fillRect(0, 0, s, s)
    const rng = new Rng(91)
    for (let i = 0; i < 90; i++) {
      const x = rng.range(0, s)
      c.strokeStyle = rng.chance(0.5) ? 'rgba(28,20,12,0.65)' : 'rgba(96,74,46,0.5)'
      c.lineWidth = rng.range(1, 5)
      c.beginPath()
      c.moveTo(x, 0)
      for (let y = 0; y <= s; y += 16) c.lineTo(x + Math.sin(y * 0.06 + i) * 5, y)
      c.stroke()
    }
    grain(c, s, 22, 18)
  })
  bark.repeat.set(1, 3)

  // ------------------------------------------------------------ leaves
  const leaves = make(128, (c, s) => {
    c.fillStyle = '#2f4a22'
    c.fillRect(0, 0, s, s)
    const rng = new Rng(55)
    for (let i = 0; i < 700; i++) {
      c.fillStyle = `rgba(${rng.int(40, 95)},${rng.int(80, 150)},${rng.int(30, 60)},0.75)`
      const x = rng.range(0, s)
      const y = rng.range(0, s)
      c.beginPath()
      c.ellipse(x, y, rng.range(2, 7), rng.range(1, 4), rng.range(0, 3), 0, Math.PI * 2)
      c.fill()
    }
    grain(c, s, 10, 16)
  })

  // ------------------------------------------------------------ mud-brick wall
  const wall = make(256, (c, s) => {
    c.fillStyle = '#a98a63'
    c.fillRect(0, 0, s, s)
    const rng = new Rng(11)
    const bh = 32
    for (let row = 0, y = 0; y < s; y += bh, row++) {
      const off = row % 2 ? 32 : 0
      for (let x = -64; x < s; x += 64) {
        c.fillStyle = `rgb(${rng.int(150, 186)},${rng.int(120, 152)},${rng.int(84, 112)})`
        c.fillRect(x + off + 2, y + 2, 60, bh - 4)
      }
    }
    c.strokeStyle = 'rgba(60,44,28,0.4)'
    c.lineWidth = 2
    for (let y = 0; y < s; y += bh) {
      c.beginPath(); c.moveTo(0, y); c.lineTo(s, y); c.stroke()
    }
    grain(c, s, 16, 20)
  })
  wall.repeat.set(2, 1)

  // ------------------------------------------------------------ thatch roof
  const thatch = make(256, (c, s) => {
    c.fillStyle = '#8a6a33'
    c.fillRect(0, 0, s, s)
    const rng = new Rng(31)
    for (let i = 0; i < 2200; i++) {
      const x = rng.range(0, s)
      const y = rng.range(0, s)
      c.strokeStyle = `rgba(${rng.int(110, 190)},${rng.int(85, 150)},${rng.int(40, 80)},0.7)`
      c.lineWidth = rng.range(1, 2.5)
      c.beginPath()
      c.moveTo(x, y)
      c.lineTo(x + rng.range(-3, 3), y + rng.range(8, 22))
      c.stroke()
    }
    grain(c, s, 12, 22)
  })
  thatch.repeat.set(3, 2)

  // ------------------------------------------------------------ rock
  const rock = make(256, (c, s) => {
    c.fillStyle = '#6d6d68'
    c.fillRect(0, 0, s, s)
    const rng = new Rng(77)
    for (let i = 0; i < 300; i++) {
      c.fillStyle = `rgba(${rng.int(70, 140)},${rng.int(70, 140)},${rng.int(68, 135)},0.5)`
      const x = rng.range(0, s)
      const y = rng.range(0, s)
      c.beginPath()
      c.ellipse(x, y, rng.range(3, 22), rng.range(3, 18), rng.range(0, 3), 0, Math.PI * 2)
      c.fill()
    }
    grain(c, s, 18, 26)
  })

  // ------------------------------------------------------------ tiger fur (paws)
  const fur = make(256, (c, s) => {
    const g = c.createLinearGradient(0, 0, 0, s)
    g.addColorStop(0, '#e8933a')
    g.addColorStop(0.55, '#d9782a')
    g.addColorStop(1, '#f2e2cc')
    c.fillStyle = g
    c.fillRect(0, 0, s, s)
    // Stripes.
    const rng = new Rng(1972)
    c.fillStyle = '#181310'
    for (let i = 0; i < 11; i++) {
      const y = (i / 11) * s + rng.range(-8, 8)
      const w = rng.range(9, 22)
      c.save()
      c.beginPath()
      c.moveTo(0, y)
      for (let x = 0; x <= s; x += 12) {
        c.lineTo(x, y + Math.sin(x * 0.05 + i * 2) * 7)
      }
      for (let x = s; x >= 0; x -= 12) {
        c.lineTo(x, y + w + Math.sin(x * 0.05 + i * 2) * 7)
      }
      c.closePath()
      c.globalAlpha = rng.range(0.7, 0.95)
      c.fill()
      c.restore()
    }
    // Fur direction strokes.
    for (let i = 0; i < 2600; i++) {
      const x = rng.range(0, s)
      const y = rng.range(0, s)
      c.strokeStyle = `rgba(255,220,180,${rng.range(0.03, 0.13)})`
      c.lineWidth = 1
      c.beginPath()
      c.moveTo(x, y)
      c.lineTo(x + rng.range(-1, 1), y + rng.range(3, 9))
      c.stroke()
    }
    grain(c, s, 26, 12)
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

  // ------------------------------------------------------------ grass blade billboard
  const grassBlade = make(128, (c, s) => {
    c.clearRect(0, 0, s, s)
    const rng = new Rng(404)
    for (let i = 0; i < 26; i++) {
      const x = rng.range(6, s - 6)
      const h = rng.range(s * 0.5, s * 0.95)
      const lean = rng.range(-14, 14)
      const grd = c.createLinearGradient(x, s, x, s - h)
      grd.addColorStop(0, `rgba(${rng.int(38, 60)},${rng.int(58, 82)},${rng.int(26, 40)},1)`)
      grd.addColorStop(1, `rgba(${rng.int(110, 160)},${rng.int(130, 180)},${rng.int(60, 92)},0.92)`)
      c.strokeStyle = grd
      c.lineCap = 'round'
      c.lineWidth = rng.range(2, 5)
      c.beginPath()
      c.moveTo(x, s)
      c.quadraticCurveTo(x + lean * 0.4, s - h * 0.6, x + lean, s - h)
      c.stroke()
    }
  })
  grassBlade.wrapS = grassBlade.wrapT = THREE.ClampToEdgeWrapping

  cache = { ground, dirt, bark, leaves, wall, thatch, rock, fur, cloth, blood, grassBlade }
  return cache
}

/** Vertical gradient sky, drawn once into a large equirect-ish canvas. */
export function skyTexture(): THREE.CanvasTexture {
  const cv = document.createElement('canvas')
  cv.width = 32
  cv.height = 256
  const c = cv.getContext('2d')!
  // v=0.5 on the sphere is the horizon, which is halfway down this canvas —
  // so the warm sunset band has to sit at 0.5, not near the bottom edge.
  const g = c.createLinearGradient(0, 0, 0, 256)
  g.addColorStop(0.0, '#16203a')
  g.addColorStop(0.28, '#33355c')
  g.addColorStop(0.42, '#7a4a52')
  g.addColorStop(0.5, '#e08a45')
  g.addColorStop(0.58, '#9c6236')
  g.addColorStop(1.0, '#33291f')
  c.fillStyle = g
  c.fillRect(0, 0, 32, 256)
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.mapping = THREE.EquirectangularReflectionMapping
  return tex
}
