/** Deterministic, seedable RNG + tiny value-noise. Keeps worlds reproducible. */

export class Rng {
  private s: number
  constructor(seed = 1337) {
    this.s = seed >>> 0 || 1
  }
  /** mulberry32 */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0
    let t = this.s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  range(a: number, b: number): number {
    return a + this.next() * (b - a)
  }
  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1))
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)]!
  }
  chance(p: number): boolean {
    return this.next() < p
  }
  /** Uniform point in a disc of the given radius. */
  inDisc(radius: number): { x: number; z: number } {
    const a = this.next() * Math.PI * 2
    const r = Math.sqrt(this.next()) * radius
    return { x: Math.cos(a) * r, z: Math.sin(a) * r }
  }
}

/** Cheap deterministic 2D value noise, smoothed. Range roughly -1..1. */
export function noise2(x: number, y: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const u = xf * xf * (3 - 2 * xf)
  const v = yf * yf * (3 - 2 * yf)
  const h = (a: number, b: number) => {
    let n = a * 374761393 + b * 668265263
    n = (n ^ (n >>> 13)) * 1274126177
    return (((n ^ (n >>> 16)) >>> 0) / 4294967296) * 2 - 1
  }
  const a = h(xi, yi)
  const b = h(xi + 1, yi)
  const c = h(xi, yi + 1)
  const d = h(xi + 1, yi + 1)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

/** Fractal brownian motion over noise2. */
export function fbm(x: number, y: number, octaves = 4): number {
  let amp = 1
  let freq = 1
  let sum = 0
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    sum += noise2(x * freq, y * freq) * amp
    norm += amp
    amp *= 0.5
    freq *= 2.03
  }
  return sum / norm
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
/** Frame-rate independent exponential smoothing. */
export const damp = (a: number, b: number, lambda: number, dt: number) =>
  lerp(a, b, 1 - Math.exp(-lambda * dt))
