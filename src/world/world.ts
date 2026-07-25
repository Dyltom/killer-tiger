/**
 * The hunting ground: rolling terrain, a village, treeline, rocks, scrub and
 * the tall grass the tiger stalks through unseen.
 *
 * Sky, sun and image-based lighting live in render/sky.ts; the huts and props
 * in village.ts; the plants in flora.ts. What stays here is the terrain itself,
 * the things that define the edge of the world, and the queries every other
 * system depends on — ground height, static collision, line of sight and
 * "am I hidden right now".
 */
import * as THREE from 'three'
import { COLORS, SKY, WORLD } from '../config'
import { fbm, Rng } from '../engine/rng'
import { buildBushes, buildGrass, buildTrees, type GrassPatch } from './flora'
import type { ChunkedScatter } from './scatter'
import { surface, terrainMaterial } from './materials'
import { terrainHeight, terrainNormal, TERRAIN_SIZE } from './terrain'
import { textures } from './textures'
import { buildVillage } from './village'
import { updateWind } from './wind'

interface ColliderBase {
  x: number
  z: number
  /** How tall it is — the tiger can pounce over short things. */
  h: number
  /**
   * Ground height under the collider, cached at build time. `resolve` tests it
   * for every collider near every entity every frame; evaluating the height
   * field there was one of the largest single costs in the simulation.
   */
  gy?: number
}
export interface CircleCollider extends ColliderBase {
  kind: 'circle'
  r: number
}
export interface BoxCollider extends ColliderBase {
  kind: 'box'
  hw: number
  hd: number
  rot: number
}
export type Collider = CircleCollider | BoxCollider

export type { GrassPatch }
export { terrainHeight, terrainNormal }

/**
 * Uniform grid over the static colliders.
 *
 * Both hot queries — "push this circle out of anything it overlaps" and "is the
 * line between these two points blocked" — were linear scans over every
 * collider in the world. With fifty humans and the tiger each resolving three
 * iterations a frame that was tens of thousands of collider tests per frame for
 * a handful of real overlaps. A 12 m grid turns both into a look at the two or
 * three cells that can possibly matter.
 */
class ColliderGrid {
  private static readonly CELL = 12
  private cells = new Map<number, number[]>()
  /** Per-query stamp, so a collider spanning several cells is tested once. */
  private stamp: Int32Array = new Int32Array(0)
  private tick = 0

  constructor(private list: Collider[]) {}

  private static key(cx: number, cz: number) {
    return (cx + 1024) * 4096 + (cz + 1024)
  }

  /** Rebuild after all the world's builders have finished adding colliders. */
  build() {
    const C = ColliderGrid.CELL
    this.cells.clear()
    this.stamp = new Int32Array(this.list.length)
    for (let i = 0; i < this.list.length; i++) {
      const c = this.list[i]!
      c.gy = terrainHeight(c.x, c.z)
      const rad = c.kind === 'circle' ? c.r : Math.hypot(c.hw, c.hd)
      const x0 = Math.floor((c.x - rad) / C)
      const x1 = Math.floor((c.x + rad) / C)
      const z0 = Math.floor((c.z - rad) / C)
      const z1 = Math.floor((c.z + rad) / C)
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const k = ColliderGrid.key(cx, cz)
          let bucket = this.cells.get(k)
          if (!bucket) this.cells.set(k, (bucket = []))
          bucket.push(i)
        }
      }
    }
  }

  /** Start a fresh query; every `visit` after this dedupes against it. */
  private begin() {
    this.tick++
  }

  private visit(i: number): boolean {
    if (this.stamp[i] === this.tick) return false
    this.stamp[i] = this.tick
    return true
  }

  /** Every collider whose cell overlaps the disc, each yielded once. */
  near(x: number, z: number, radius: number, fn: (c: Collider) => void) {
    const C = ColliderGrid.CELL
    this.begin()
    const x0 = Math.floor((x - radius) / C)
    const x1 = Math.floor((x + radius) / C)
    const z0 = Math.floor((z - radius) / C)
    const z1 = Math.floor((z + radius) / C)
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const bucket = this.cells.get(ColliderGrid.key(cx, cz))
        if (!bucket) continue
        for (const i of bucket) if (this.visit(i)) fn(this.list[i]!)
      }
    }
  }

  /**
   * Every collider in a cell the segment passes through. Walks the line in
   * half-cell steps rather than doing a proper DDA — the segments here are tens
   * of metres over 12 m cells, so this is a dozen map lookups either way and
   * stepping is far less code to get wrong.
   */
  along(ax: number, az: number, bx: number, bz: number, fn: (c: Collider) => boolean): boolean {
    const C = ColliderGrid.CELL
    this.begin()
    const dx = bx - ax
    const dz = bz - az
    const len = Math.hypot(dx, dz)
    const steps = Math.ceil(len / (C * 0.5)) + 1
    let lastKey = NaN
    for (let s = 0; s <= steps; s++) {
      const t = s / steps
      const px = ax + dx * t
      const pz = az + dz * t
      const cx = Math.floor(px / C)
      const cz = Math.floor(pz / C)
      // Neighbours too: a collider centred in the next cell can still bulge
      // across the line, and missing those makes cover flicker.
      for (let ox = -1; ox <= 1; ox++) {
        for (let oz = -1; oz <= 1; oz++) {
          const k = ColliderGrid.key(cx + ox, cz + oz)
          if (k === lastKey) continue
          const bucket = this.cells.get(k)
          if (!bucket) continue
          for (const i of bucket) if (this.visit(i) && fn(this.list[i]!)) return true
        }
      }
      lastKey = ColliderGrid.key(cx, cz)
    }
    return false
  }
}

export class World {
  readonly group = new THREE.Group()
  readonly colliders: Collider[] = []
  readonly grassPatches: GrassPatch[] = []
  /** Fire positions used for light flicker + "safe zones" the AI runs toward. */
  readonly campfires: THREE.Vector3[] = []
  /** Good open spots to drop pickups. */
  readonly spawnPoints: THREE.Vector3[] = []

  private fireLights: { light: THREE.PointLight; base: number; phase: number }[] = []
  private flames: { obj: THREE.Object3D; phase: number }[] = []
  private decals: THREE.Mesh[] = []
  private decalPool = 0
  private rng = new Rng(20260725)
  private grid = new ColliderGrid(this.colliders)
  /** Every chunked foliage field, culled and retuned together. */
  private fields: ChunkedScatter[] = []

  constructor(scene: THREE.Scene) {
    this.buildTerrain()
    // Village first: everything after it tests against its colliders to keep
    // trees and rocks from growing through a wall.
    this.group.add(
      buildVillage({
        rng: this.rng,
        height: terrainHeight,
        colliders: this.colliders,
        campfires: this.campfires,
        fireLights: this.fireLights,
        flames: this.flames,
      }),
    )

    const flora = {
      rng: this.rng,
      height: terrainHeight,
      clearOf: (x: number, z: number, pad: number) => this.clearOf(x, z, pad),
      colliders: this.colliders,
    }
    this.fields.push(...buildTrees(flora))
    this.buildRocks()
    this.fields.push(buildBushes(flora))

    const grass = buildGrass(flora)
    this.grassPatches.push(...grass.patches)
    this.spawnPoints.push(...grass.centres)
    this.fields.push(grass.tall, grass.cover)
    for (const f of this.fields) this.group.add(f.group)

    this.buildBoundaryCliffs()
    this.buildHorizon()
    this.buildDecalPool()
    // Colliders are complete only now, so index them last.
    this.grid.build()
    scene.add(this.group)
  }

  /** Quality tiers pull every foliage field's draw distance in together. */
  setFoliageDistance(scale: number) {
    for (const f of this.fields) f.setDistanceScale(scale)
  }

  // -------------------------------------------------------------- terrain
  private buildTerrain() {
    // 192 segments over 260 m is a vertex every 1.35 m — enough that the
    // shadow of a ridge line curves instead of stepping.
    const seg = 192
    const geo = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, seg, seg)
    geo.rotateX(-Math.PI / 2)
    const pos = geo.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, terrainHeight(pos.getX(i), pos.getZ(i)))
    }
    geo.computeVertexNormals()

    const mesh = new THREE.Mesh(geo, terrainMaterial(TERRAIN_SIZE))
    mesh.receiveShadow = true
    this.group.add(mesh)
  }

  // ---------------------------------------------------------------- rocks
  private buildRocks() {
    const rng = this.rng
    // Two subdivisions plus per-vertex jitter: a bare dodecahedron reads as a
    // die, and the normal map has no low-frequency shape to sit on.
    const geo = new THREE.IcosahedronGeometry(1, 2)
    const p = geo.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i)
      const y = p.getY(i)
      const z = p.getZ(i)
      const n = 1 + fbm(x * 1.6 + 11, z * 1.6 - 7, 3) * 0.34 + fbm(y * 2.4, x * 2.4, 2) * 0.18
      p.setXYZ(i, x * n, y * n, z * n)
    }
    geo.computeVertexNormals()

    // Boulders run 1-5 m across, so ~4 tiles around puts the rock face at a
    // believable metre or so per tile.
    const mat = surface('rock', { repeat: [4, 2.5], roughness: 1, normalScale: 1.5 })
    const mesh = new THREE.InstancedMesh(geo, mat, WORLD.rocks)
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(WORLD.rocks * 3), 3)
    const m = new THREE.Matrix4()
    const tint = new THREE.Color()

    for (let i = 0; i < WORLD.rocks; i++) {
      let x = 0
      let z = 0
      for (let tries = 0; tries < 25; tries++) {
        const d = rng.inDisc(WORLD.bounds - 6)
        x = d.x
        z = d.z
        if (Math.hypot(x, z) > 12 && this.clearOf(x, z, 3)) break
      }
      const y = terrainHeight(x, z)
      const sc = rng.range(0.6, 2.4)
      m.compose(
        new THREE.Vector3(x, y + sc * 0.28, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3))),
        new THREE.Vector3(sc, sc * rng.range(0.55, 0.9), sc * rng.range(0.8, 1.2)),
      )
      mesh.setMatrixAt(i, m)
      const g = rng.range(0.72, 1.06)
      tint.setRGB(g * rng.range(0.95, 1.05), g, g * rng.range(0.88, 1.0))
      mesh.setColorAt(i, tint)
      if (sc > 1.1) this.colliders.push({ kind: 'circle', x, z, r: sc * 0.85, h: sc })
      else this.spawnPoints.push(new THREE.Vector3(x, y, z))
    }
    mesh.instanceMatrix.needsUpdate = true
    mesh.instanceColor.needsUpdate = true
    this.group.add(mesh)
  }

  /** Rock wall ring so the world edge reads as a valley, not a void. */
  private buildBoundaryCliffs() {
    const rng = this.rng
    // Subdivision 1 is 80 triangles, which at 15 m across is a faceted crystal
    // the size of a house — the single most "placeholder" thing on the skyline.
    // 3 costs 1,280 per instance (~205k for the whole ring, in three draw
    // calls), which is what it takes for the silhouette against a bright sky to
    // stop reading as a set of smooth pyramids. This ring fills a large part of
    // the horizon in every direction and is on screen permanently, so it is a
    // reasonable place to spend triangles.
    const cliffGeo = (seed: number) => {
      const geo = new THREE.IcosahedronGeometry(1, 3)
      const p = geo.attributes.position as THREE.BufferAttribute
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i)
        let y = p.getY(i)
        const z = p.getZ(i)

        // Ridged noise — 1 - |fbm| — creases sharply wherever the underlying
        // noise crosses zero, instead of rolling smoothly through it. Sampled
        // against azimuth and height so the creases run down the face as
        // gullies rather than wrapping it in contour lines, and faded out near
        // the crown where a real butte is bare caprock.
        const az = Math.atan2(z, x)
        const gully = (1 - Math.abs(fbm(az * 2.6 + seed, y * 0.9, 2))) * (1 - Math.abs(y) * 0.8)

        const n =
          1 +
          fbm(x * 1.1 + seed, z * 1.1 + 9, 3) * 0.4 +
          gully * 0.2 +
          fbm(y * 6.1 + 17, x * 6.1 - 4, 2) * 0.07

        // Mesa profile: pushing |y| toward 1 flattens the crown and stands the
        // sides up. The old shoulder taper did the opposite — it pinched the
        // poles, so every block came out as a lemon.
        y = Math.sign(y) * Math.abs(y) ** 0.68
        const waist = 1 - Math.abs(y) ** 3 * 0.3

        p.setXYZ(i, x * n * waist, y * n, z * n * waist)
      }
      geo.computeVertexNormals()
      return geo
    }

    // These are 9-17 m boulders, so the old [3, 3] smeared one rock tile across
    // 27 m of cliff face — the reason the escarpment read as smooth brown lumps
    // however much displacement the geometry carried. 14 x 9 lands near 7 m per
    // tile, fine detail at the 250 m these sit at without moire.
    const mat = surface('rock', { repeat: [14, 9], roughness: 1, normalScale: 1.2, color: 0x9a958a })

    // Three carvings rather than one. A single geometry spun to random angles
    // still reads as the same rock 160 times over — the eye picks the repeat out
    // of a skyline faster than out of almost anything else.
    const VARIANTS = 3
    const total = 160
    const per = Math.ceil(total / VARIANTS)
    const m = new THREE.Matrix4()
    const pos = new THREE.Vector3()
    const quat = new THREE.Quaternion()
    const scl = new THREE.Vector3()
    const euler = new THREE.Euler()
    const tint = new THREE.Color()

    for (let v = 0; v < VARIANTS; v++) {
      const count = Math.min(per, total - v * per)
      const mesh = new THREE.InstancedMesh(cliffGeo(v * 31.7 + 3), mat, count)
      // Deliberately not a shadow caster. The ring is 205k triangles sitting
      // outside the playable area, so every one of them was being rasterised
      // into the shadow map to darken ground the player can never stand on.
      mesh.castShadow = false
      mesh.receiveShadow = true
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3)

      for (let j = 0; j < count; j++) {
        const i = v * per + j
        const a = (i / total) * Math.PI * 2 + rng.range(-0.02, 0.02)
        // Two overlapping rings at different scales; one ring of identical
        // blobs reads as a fence, two read as a broken escarpment.
        const back = i % 2 === 0
        const r = WORLD.bounds + (back ? rng.range(8, 18) : rng.range(1, 7))
        const x = Math.cos(a) * r
        const z = Math.sin(a) * r
        const sc = back ? rng.range(9, 17) : rng.range(4, 9)
        // Yaw freely, but only tip a few degrees off vertical. Tumbling these
        // through all three axes, as this used to, threw away the mesa profile
        // the displacement had just carved.
        euler.set(rng.range(-0.09, 0.09), rng.range(0, Math.PI * 2), rng.range(-0.09, 0.09))
        m.compose(
          pos.set(x, terrainHeight(x, z) + sc * 0.12, z),
          quat.setFromEuler(euler),
          scl.set(sc, sc * rng.range(0.8, 1.5), sc),
        )
        mesh.setMatrixAt(j, m)
        // Iron-stained sandstone varies from block to block; one flat colour
        // across a whole escarpment is the giveaway that it is one mesh.
        tint.setHSL(rng.range(0.055, 0.09), rng.range(0.12, 0.3), rng.range(0.42, 0.62))
        mesh.setColorAt(j, tint)
      }
      mesh.instanceMatrix.needsUpdate = true
      mesh.instanceColor.needsUpdate = true
      this.group.add(mesh)
    }
  }

  // -------------------------------------------------------------- horizon
  private horizon = new THREE.Group()

  /**
   * Layered ridge lines beyond the valley wall. They ride with the camera, so
   * they never approach and never cross the far plane; what sells the distance
   * is that each layer is paler and bluer than the one in front of it.
   *
   * The ridge top is one continuous fbm curve sampled densely around the ring
   * rather than a fan of triangles — isolated triangles read as bunting, and no
   * amount of colour grading fixes that. Each layer also carries a vertical
   * vertex-colour gradient: haze is thickest at ground level, so the base of a
   * distant range washes out into the sky while the peaks stay dark. That
   * gradient is doing most of the work of making these read as far away.
   *
   * Haze is also tinted around the ring by how close that bearing is to the
   * sun. A single warm palette is right downsun and badly wrong away from it,
   * where it paints a pale beige smudge over a cold dusk sky — the ridge ends
   * up *brighter* than what is behind it, which no distant range ever is.
   */
  private buildHorizon() {
    const layers = [
      { dist: 250, height: 34, peak: 0x2f3944, warm: 0xa08c76, cool: 0x4e5c6b, opacity: 0.94, seed: 3.1, rough: 1.0 },
      { dist: 310, height: 58, peak: 0x3f4b58, warm: 0xb4a087, cool: 0x5d6b7a, opacity: 0.78, seed: 17.7, rough: 0.78 },
      { dist: 372, height: 88, peak: 0x53616f, warm: 0xc4b298, cool: 0x6c7a88, opacity: 0.55, seed: 41.3, rough: 0.6 },
    ]
    // Bearing of the sun in the XZ plane, to tint each sample by how much of
    // the lit haze it is looking through.
    const sunA = THREE.MathUtils.degToRad(SKY.sunAzimuth)
    const sunX = Math.sin(sunA)
    const sunZ = Math.cos(sunA)
    // Enough samples that the ridge silhouette is smooth at the far plane; the
    // whole horizon is still under 4k triangles.
    const STEPS = 320
    const BASE_Y = -30

    for (const [li, layer] of layers.entries()) {
      const pos: number[] = []
      const col: number[] = []
      const idx: number[] = []
      const peak = new THREE.Color(layer.peak)
      const warm = new THREE.Color(layer.warm)
      const cool = new THREE.Color(layer.cool)
      const haze = new THREE.Color()

      for (let i = 0; i <= STEPS; i++) {
        const a = (i / STEPS) * Math.PI * 2
        // 1 looking straight downsun, 0 with the sun behind you.
        const toSun = (Math.cos(a) * sunX + Math.sin(a) * sunZ) * 0.5 + 0.5
        haze.copy(cool).lerp(warm, toSun * toSun)
        // Sample the noise on the unit circle so the ridge wraps seamlessly.
        const nx = Math.cos(a) * 3.4 + layer.seed
        const nz = Math.sin(a) * 3.4 - layer.seed
        // Two octaves: broad ranges, then a rockier crest line on top.
        const h =
          layer.height * (0.34 + fbm(nx, nz, 4) * 0.95) +
          layer.height * layer.rough * 0.3 * (fbm(nx * 3.7, nz * 3.7, 3) - 0.5)
        const top = Math.max(h, layer.height * 0.16)

        pos.push(Math.cos(a) * layer.dist, BASE_Y, Math.sin(a) * layer.dist)
        col.push(haze.r, haze.g, haze.b)
        pos.push(Math.cos(a) * layer.dist, top, Math.sin(a) * layer.dist)
        // Taller peaks punch through more of the haze layer, so they read darker.
        const t = THREE.MathUtils.smoothstep(top / layer.height, 0.1, 0.95)
        const c = haze.clone().lerp(peak, 0.35 + t * 0.65)
        col.push(c.r, c.g, c.b)

        if (i < STEPS) {
          const b = i * 2
          idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2)
        }
      }

      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
      geo.setIndex(idx)

      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          vertexColors: true,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: layer.opacity,
          fog: false,
          depthWrite: false,
        }),
      )
      // All three layers share an origin, so distance sorting can't order them.
      // Draw back to front explicitly or the far range paints over the near one.
      mesh.renderOrder = -900 - li
      mesh.frustumCulled = false
      this.horizon.add(mesh)
    }
    this.group.add(this.horizon)
  }

  // --------------------------------------------------------------- decals
  private buildDecalPool() {
    const tex = textures()
    const geo = new THREE.PlaneGeometry(1, 1)
    geo.rotateX(-Math.PI / 2)
    for (let i = 0; i < 48; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: tex.blood,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        color: COLORS.blood,
      })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.visible = false
      mesh.renderOrder = 2
      this.group.add(mesh)
      this.decals.push(mesh)
    }
  }

  /** Stamp a blood pool on the ground. Recycles the oldest decal. */
  addBloodDecal(x: number, z: number, scale = 1) {
    const d = this.decals[this.decalPool % this.decals.length]!
    this.decalPool++
    d.position.set(x, terrainHeight(x, z) + 0.045, z)
    d.rotation.y = Math.random() * Math.PI * 2
    const s = scale * (2 + Math.random() * 1.6)
    d.scale.set(s, 1, s)
    d.visible = true
    ;(d.material as THREE.MeshBasicMaterial).opacity = 0.9
  }

  // ------------------------------------------------------------- queries
  /** Build-time only — runs before the grid is indexed, so it stays linear. */
  private clearOf(x: number, z: number, pad: number): boolean {
    for (const c of this.colliders) {
      const r = c.kind === 'circle' ? c.r : Math.max(c.hw, c.hd)
      if (Math.hypot(c.x - x, c.z - z) < r + pad) return false
    }
    return true
  }

  /** Is this position inside tall grass (concealment)? */
  inGrass(x: number, z: number): boolean {
    for (const g of this.grassPatches) {
      const dx = g.x - x
      const dz = g.z - z
      if (dx * dx + dz * dz < g.r * g.r) return true
    }
    return false
  }

  /**
   * Push a circle out of every static collider it overlaps.
   * Returns the corrected position. Colliders shorter than the feet are
   * ignored, so a pounce clears a fire pit or a low wall.
   */
  resolve(x: number, z: number, radius: number, feetY: number): { x: number; z: number; hit: boolean } {
    let hit = false
    for (let iter = 0; iter < 3; iter++) {
      let moved = false
      // Nothing further than the entity's radius plus the largest prop can
      // matter, and the grid only hands back what shares a cell with that disc.
      this.grid.near(x, z, radius + 4, (c) => {
        if (feetY > c.gy! + c.h) return // pounced clean over it
        if (c.kind === 'circle') {
          const dx = x - c.x
          const dz = z - c.z
          const d = Math.hypot(dx, dz)
          const min = c.r + radius
          if (d < min && d > 1e-5) {
            const push = (min - d) / d
            x += dx * push
            z += dz * push
            moved = hit = true
          }
        } else {
          // Transform into the box's local frame, clamp, push out on the shallow axis.
          const cos = Math.cos(-c.rot)
          const sin = Math.sin(-c.rot)
          const lx = (x - c.x) * cos - (z - c.z) * sin
          const lz = (x - c.x) * sin + (z - c.z) * cos
          const ox = c.hw + radius - Math.abs(lx)
          const oz = c.hd + radius - Math.abs(lz)
          if (ox > 0 && oz > 0) {
            let nlx = lx
            let nlz = lz
            if (ox < oz) nlx += Math.sign(lx || 1) * ox
            else nlz += Math.sign(lz || 1) * oz
            const c2 = Math.cos(c.rot)
            const s2 = Math.sin(c.rot)
            x = c.x + nlx * c2 - nlz * s2
            z = c.z + nlx * s2 + nlz * c2
            moved = hit = true
          }
        }
      })
      if (!moved) break
    }
    // Valley wall.
    const d = Math.hypot(x, z)
    if (d > WORLD.bounds) {
      x = (x / d) * WORLD.bounds
      z = (z / d) * WORLD.bounds
      hit = true
    }
    return { x, z, hit }
  }

  /** Line-of-sight test against static colliders (2D, ignores height). */
  losBlocked(ax: number, az: number, bx: number, bz: number): boolean {
    const dx = bx - ax
    const dz = bz - az
    const len = Math.hypot(dx, dz)
    if (len < 0.001) return false
    const ux = dx / len
    const uz = dz / len
    return this.grid.along(ax, az, bx, bz, (c) => {
      if (c.h < 1.2) return false // low things don't block sight
      const r = c.kind === 'circle' ? c.r : Math.hypot(c.hw, c.hd) * 0.8
      // Closest approach of the segment to the collider centre.
      const t = (c.x - ax) * ux + (c.z - az) * uz
      if (t < 0 || t > len) return false
      const px = ax + ux * t
      const pz = az + uz * t
      return Math.hypot(px - c.x, pz - c.z) < r
    })
  }

  /** A random navigable spot at least `minR` out. */
  randomOpenPoint(minR: number, maxR: number, rng: Rng): THREE.Vector3 {
    for (let i = 0; i < 40; i++) {
      const a = rng.range(0, Math.PI * 2)
      const r = rng.range(minR, maxR)
      const x = Math.cos(a) * r
      const z = Math.sin(a) * r
      if (this.clearOf(x, z, 1.4)) return new THREE.Vector3(x, terrainHeight(x, z), z)
    }
    return new THREE.Vector3(0, terrainHeight(0, 0), 0)
  }

  update(dt: number, time: number, viewer?: THREE.Vector3) {
    updateWind(time)

    if (viewer) {
      this.horizon.position.set(viewer.x, 0, viewer.z)
      for (const f of this.fields) f.update(viewer.x, viewer.z)
    }

    for (const f of this.fireLights) {
      f.light.intensity = f.base * (0.72 + Math.abs(fbm(time * 2.4 + f.phase, f.phase, 2)) * 0.85)
    }
    for (const f of this.flames) {
      const t = time + f.phase
      f.obj.scale.set(
        0.85 + Math.sin(t * 9) * 0.16,
        0.9 + Math.sin(t * 13.7) * 0.28,
        0.85 + Math.cos(t * 11.3) * 0.16,
      )
      f.obj.rotation.y = t * 2.4
    }
    // Fade decals slowly so the village accumulates evidence but not forever.
    for (const d of this.decals) {
      if (!d.visible) continue
      const m = d.material as THREE.MeshBasicMaterial
      m.opacity -= dt * 0.012
      if (m.opacity <= 0) d.visible = false
    }
  }
}
