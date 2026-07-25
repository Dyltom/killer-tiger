/**
 * The ground height field.
 *
 * `terrainHeight` is the single hottest function in the game: every human, every
 * particle, the tiger, every prop placement and every collider resolution asks
 * it where the floor is, several times a frame. Evaluating the noise stack
 * analytically costs five value-noise lookups (twenty hashes) per call, and at
 * ~1,500 particles plus fifty humans that alone was a measurable slice of the
 * frame.
 *
 * So the shape is evaluated once into a table at load and sampled bilinearly
 * afterwards. At this spacing the interpolation error is well under a
 * centimetre, and — more useful — the terrain *mesh* is built from the same
 * sampled function, so entities stand exactly on the surface that gets drawn
 * rather than a few millimetres above or below it.
 */
import { fbm } from '../engine/rng'
import { WORLD } from '../config'

/** Terrain plane edge length. The playable disc sits well inside it. */
export const TERRAIN_SIZE = WORLD.radius * 2

const smoothstep = (x: number, a: number, b: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** The analytic shape. Only ever called while building the table. */
function shape(x: number, z: number): number {
  const big = fbm(x * 0.0085, z * 0.0085, 3) * 3.4
  const small = fbm(x * 0.05 + 40, z * 0.05 - 20, 2) * 0.45
  // Flatten the village bowl in the middle so huts sit properly.
  const flatten = smoothstep(Math.hypot(x, z), 18, 62)
  return (big + small) * flatten
}

// 0.68 m between samples — finer than the terrain mesh's own 1.35 m vertices,
// so the table is never the thing limiting fidelity.
const N = 385
const STEP = TERRAIN_SIZE / (N - 1)
const INV_STEP = 1 / STEP
const HALF = TERRAIN_SIZE / 2
const LAST = N - 1

const table = new Float32Array(N * N)
for (let j = 0; j < N; j++) {
  const z = -HALF + j * STEP
  for (let i = 0; i < N; i++) {
    table[j * N + i] = shape(-HALF + i * STEP, z)
  }
}

/** Ground height at a world position. Bilinear, clamped at the table edge. */
export function terrainHeight(x: number, z: number): number {
  let fx = (x + HALF) * INV_STEP
  let fz = (z + HALF) * INV_STEP
  fx = fx < 0 ? 0 : fx > LAST ? LAST : fx
  fz = fz < 0 ? 0 : fz > LAST ? LAST : fz
  const ix = fx | 0
  const iz = fz | 0
  const jx = ix < LAST ? ix + 1 : ix
  const jz = iz < LAST ? iz + 1 : iz
  const tx = fx - ix
  const tz = fz - iz
  const row0 = iz * N
  const row1 = jz * N
  const a = table[row0 + ix]!
  const b = table[row0 + jx]!
  const c = table[row1 + ix]!
  const d = table[row1 + jx]!
  return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * tz
}

/**
 * Ground normal, from central differences on the same table. Used to lay
 * corpses and low props flat against a slope instead of leaving them hovering
 * with one corner in the dirt.
 */
export function terrainNormal(x: number, z: number, out: [number, number, number]): [number, number, number] {
  const e = STEP
  const nx = terrainHeight(x - e, z) - terrainHeight(x + e, z)
  const nz = terrainHeight(x, z - e) - terrainHeight(x, z + e)
  const ny = 2 * e
  const len = Math.hypot(nx, ny, nz) || 1
  out[0] = nx / len
  out[1] = ny / len
  out[2] = nz / len
  return out
}
