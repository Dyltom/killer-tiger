/**
 * The hunting ground: rolling terrain, a village of huts, treeline, rocks,
 * and tall grass the tiger can stalk through unseen.
 *
 * Also owns static collision and the terrain height field so every other
 * system can ask "how high is the ground here" and "can I stand here".
 */
import * as THREE from 'three'
import { COLORS, WORLD } from '../config'
import { fbm, Rng } from '../engine/rng'
import { skyTexture, textures } from './textures'

export interface CircleCollider {
  kind: 'circle'
  x: number
  z: number
  r: number
  /** How tall it is — the tiger can pounce over short things. */
  h: number
}
export interface BoxCollider {
  kind: 'box'
  x: number
  z: number
  hw: number
  hd: number
  rot: number
  h: number
}
export type Collider = CircleCollider | BoxCollider

export interface GrassPatch {
  x: number
  z: number
  r: number
}

/** Terrain height at a world position. Deterministic, cheap, no lookups. */
export function terrainHeight(x: number, z: number): number {
  const big = fbm(x * 0.0085, z * 0.0085, 3) * 3.4
  const small = fbm(x * 0.05 + 40, z * 0.05 - 20, 2) * 0.45
  // Flatten the village bowl in the middle so huts sit properly.
  const d = Math.hypot(x, z)
  const flatten = THREE.MathUtils.smoothstep(d, 18, 62)
  return (big + small) * flatten
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
  private grassMesh: THREE.InstancedMesh | null = null
  private decals: THREE.Mesh[] = []
  private decalPool = 0
  private rng = new Rng(20260725)

  constructor(private scene: THREE.Scene) {
    this.buildSky()
    this.buildLights()
    this.buildTerrain()
    this.buildVillage()
    this.buildTrees()
    this.buildRocks()
    this.buildGrass()
    this.buildBoundaryCliffs()
    this.buildDecalPool()
    scene.add(this.group)
  }

  // ------------------------------------------------------------------ sky
  private sky!: THREE.Mesh

  private buildSky() {
    const tex = skyTexture()
    // The sky rides with the camera. A world-fixed sphere would have its far
    // side pushed past the camera's far plane, punching a hole in the sky.
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(260, 32, 24),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false }),
    )
    this.sky.renderOrder = -1
    this.sky.frustumCulled = false
    this.group.add(this.sky)

    // Big low sun disc on the horizon for mood.
    const sun = new THREE.Mesh(
      new THREE.CircleGeometry(26, 32),
      new THREE.MeshBasicMaterial({ color: 0xffb765, fog: false, transparent: true, opacity: 0.85 }),
    )
    // Child of the sky so it rides along and never clips the far plane.
    sun.position.set(-150, 16, -122)
    sun.lookAt(0, 16, 0)
    sun.renderOrder = -1
    this.sky.add(sun)
  }

  private buildLights() {
    this.scene.add(new THREE.AmbientLight(COLORS.ambient, 2.6))

    const hemi = new THREE.HemisphereLight(0x8ea4c4, 0x5a6340, 2.2)
    this.scene.add(hemi)

    const sun = new THREE.DirectionalLight(COLORS.sun, 2.6)
    sun.position.set(-90, 55, -70)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    const c = sun.shadow.camera
    c.left = -80; c.right = 80; c.top = 80; c.bottom = -80
    c.near = 1; c.far = 260
    sun.shadow.bias = -0.0012
    sun.shadow.normalBias = 0.035
    this.scene.add(sun)
    this.scene.add(sun.target)
  }

  // -------------------------------------------------------------- terrain
  private buildTerrain() {
    const tex = textures()
    const size = WORLD.radius * 2
    const seg = 128
    const geo = new THREE.PlaneGeometry(size, size, seg, seg)
    geo.rotateX(-Math.PI / 2)
    const pos = geo.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const z = pos.getZ(i)
      pos.setY(i, terrainHeight(x, z))
    }
    geo.computeVertexNormals()

    const mat = new THREE.MeshStandardMaterial({
      map: tex.ground,
      roughness: 0.98,
      metalness: 0,
      color: 0xcfd6c0,
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.receiveShadow = true
    this.group.add(mesh)

    // Village dirt clearing, laid slightly above terrain to avoid z-fight.
    const clearing = new THREE.Mesh(
      new THREE.CircleGeometry(30, 48),
      new THREE.MeshStandardMaterial({
        map: tex.dirt,
        roughness: 1,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      }),
    )
    clearing.rotation.x = -Math.PI / 2
    clearing.position.y = 0.03
    clearing.receiveShadow = true
    this.group.add(clearing)
  }

  // -------------------------------------------------------------- village
  private buildVillage() {
    const tex = textures()
    const wallMat = new THREE.MeshStandardMaterial({ map: tex.wall, roughness: 0.95 })
    const roofMat = new THREE.MeshStandardMaterial({ map: tex.thatch, roughness: 1 })
    const woodMat = new THREE.MeshStandardMaterial({ map: tex.bark, roughness: 0.9 })

    const rng = this.rng
    const placed: { x: number; z: number; r: number }[] = []

    for (let i = 0; i < WORLD.huts; i++) {
      // Two loose rings of huts around the clearing.
      let x = 0
      let z = 0
      let ok = false
      for (let tries = 0; tries < 40 && !ok; tries++) {
        const ring = i < WORLD.huts * 0.45 ? rng.range(14, 30) : rng.range(34, 66)
        const a = rng.range(0, Math.PI * 2)
        x = Math.cos(a) * ring
        z = Math.sin(a) * ring
        ok = placed.every((p) => Math.hypot(p.x - x, p.z - z) > p.r + 7)
      }
      placed.push({ x, z, r: 7 })

      const w = rng.range(4.2, 6.6)
      const d = rng.range(4.2, 6.6)
      const h = rng.range(2.6, 3.4)
      const rot = rng.range(0, Math.PI * 2)
      const y = terrainHeight(x, z)

      const hut = new THREE.Group()
      hut.position.set(x, y, z)
      hut.rotation.y = rot

      const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat)
      body.position.y = h / 2
      body.castShadow = true
      body.receiveShadow = true
      hut.add(body)

      // Thatch pyramid roof, slightly oversized for overhang.
      const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.82, rng.range(1.8, 2.6), 4), roofMat)
      roof.position.y = h + (roof.geometry.parameters.height as number) / 2 - 0.05
      roof.rotation.y = Math.PI / 4
      roof.castShadow = true
      hut.add(roof)

      // Dark doorway so huts read as inhabited.
      const door = new THREE.Mesh(
        new THREE.PlaneGeometry(1.1, 1.9),
        new THREE.MeshBasicMaterial({ color: 0x0d0a07 }),
      )
      door.position.set(0, 0.95, d / 2 + 0.01)
      hut.add(door)

      this.group.add(hut)
      this.colliders.push({ kind: 'box', x, z, hw: w / 2, hd: d / 2, rot, h })

      // Occasional drying rack / fence beside a hut for silhouette variety.
      if (rng.chance(0.4)) {
        const rack = new THREE.Group()
        const ra = rng.range(0, Math.PI * 2)
        const rx = x + Math.cos(ra) * (w * 0.9 + 1.2)
        const rz = z + Math.sin(ra) * (d * 0.9 + 1.2)
        rack.position.set(rx, terrainHeight(rx, rz), rz)
        rack.rotation.y = rng.range(0, Math.PI * 2)
        for (const px of [-1.2, 1.2]) {
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 2.1, 6), woodMat)
          post.position.set(px, 1.05, 0)
          post.castShadow = true
          rack.add(post)
        }
        const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.6, 6), woodMat)
        bar.rotation.z = Math.PI / 2
        bar.position.y = 2.0
        rack.add(bar)
        this.group.add(rack)
      }
    }

    // Campfires.
    for (let i = 0; i < WORLD.campfires; i++) {
      const a = (i / WORLD.campfires) * Math.PI * 2 + 0.4
      const r = rng.range(8, 22)
      const x = Math.cos(a) * r
      const z = Math.sin(a) * r
      const y = terrainHeight(x, z)
      this.campfires.push(new THREE.Vector3(x, y, z))

      const pit = new THREE.Group()
      pit.position.set(x, y, z)
      for (let s = 0; s < 9; s++) {
        const sa = (s / 9) * Math.PI * 2
        const stone = new THREE.Mesh(
          new THREE.DodecahedronGeometry(rng.range(0.16, 0.28), 0),
          new THREE.MeshStandardMaterial({ map: tex.rock, roughness: 1 }),
        )
        stone.position.set(Math.cos(sa) * 0.85, 0.1, Math.sin(sa) * 0.85)
        stone.castShadow = true
        pit.add(stone)
      }
      const flame = new THREE.Mesh(
        new THREE.ConeGeometry(0.4, 1.1, 8),
        new THREE.MeshBasicMaterial({ color: 0xffa028, transparent: true, opacity: 0.85, fog: false }),
      )
      flame.position.y = 0.6
      flame.name = 'flame'
      pit.add(flame)
      this.group.add(pit)

      const light = new THREE.PointLight(0xff8a2a, 14, 24, 2)
      light.position.set(x, y + 1.1, z)
      this.scene.add(light)
      this.fireLights.push({ light, base: 14, phase: rng.range(0, 10) })
      this.colliders.push({ kind: 'circle', x, z, r: 1.1, h: 0.5 })
    }
  }

  // ---------------------------------------------------------------- trees
  private buildTrees() {
    const tex = textures()
    const rng = this.rng
    const trunkGeo = new THREE.CylinderGeometry(0.28, 0.44, 1, 7)
    trunkGeo.translate(0, 0.5, 0)
    const canopyGeo = new THREE.IcosahedronGeometry(1, 1)

    const trunkMat = new THREE.MeshStandardMaterial({ map: tex.bark, roughness: 1 })
    const canopyMat = new THREE.MeshStandardMaterial({ map: tex.leaves, roughness: 1, flatShading: true })

    const n = WORLD.trees
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, n)
    const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, n * 2)
    trunks.castShadow = true
    canopies.castShadow = true
    canopies.receiveShadow = true

    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const s = new THREE.Vector3()
    const p = new THREE.Vector3()
    let ci = 0

    for (let i = 0; i < n; i++) {
      // Dense treeline at the edge, sparse inside the village.
      let x = 0
      let z = 0
      for (let tries = 0; tries < 30; tries++) {
        const edgeTree = rng.chance(0.62)
        const r = edgeTree ? rng.range(78, WORLD.bounds - 3) : rng.range(34, 78)
        const a = rng.range(0, Math.PI * 2)
        x = Math.cos(a) * r
        z = Math.sin(a) * r
        if (this.clearOf(x, z, 4)) break
      }
      const y = terrainHeight(x, z)
      const height = rng.range(5.5, 11)
      const lean = rng.range(-0.07, 0.07)

      q.setFromEuler(new THREE.Euler(lean, rng.range(0, Math.PI * 2), rng.range(-0.07, 0.07)))
      p.set(x, y, z)
      s.set(rng.range(0.85, 1.35), height, rng.range(0.85, 1.35))
      m.compose(p, q, s)
      trunks.setMatrixAt(i, m)

      const crown = rng.range(2.2, 3.8)
      for (let k = 0; k < 2; k++) {
        const oy = height * (k === 0 ? 0.86 : 1.02)
        p.set(x + rng.range(-0.8, 0.8), y + oy, z + rng.range(-0.8, 0.8))
        q.setFromEuler(new THREE.Euler(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3)))
        const cs = crown * (k === 0 ? 1 : 0.72)
        s.set(cs, cs * rng.range(0.6, 0.85), cs)
        m.compose(p, q, s)
        canopies.setMatrixAt(ci++, m)
      }

      this.colliders.push({ kind: 'circle', x, z, r: 0.55, h: height })
    }
    // Unused canopy slots collapse to zero scale.
    m.compose(new THREE.Vector3(0, -999, 0), new THREE.Quaternion(), new THREE.Vector3(0.001, 0.001, 0.001))
    for (; ci < n * 2; ci++) canopies.setMatrixAt(ci, m)

    trunks.instanceMatrix.needsUpdate = true
    canopies.instanceMatrix.needsUpdate = true
    this.group.add(trunks, canopies)
  }

  // ---------------------------------------------------------------- rocks
  private buildRocks() {
    const tex = textures()
    const rng = this.rng
    const geo = new THREE.DodecahedronGeometry(1, 0)
    const mat = new THREE.MeshStandardMaterial({ map: tex.rock, roughness: 1, flatShading: true })
    const mesh = new THREE.InstancedMesh(geo, mat, WORLD.rocks)
    mesh.castShadow = true
    mesh.receiveShadow = true
    const m = new THREE.Matrix4()

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
        new THREE.Vector3(x, y + sc * 0.35, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3))),
        new THREE.Vector3(sc, sc * rng.range(0.6, 1), sc * rng.range(0.8, 1.2)),
      )
      mesh.setMatrixAt(i, m)
      if (sc > 1.1) this.colliders.push({ kind: 'circle', x, z, r: sc * 0.85, h: sc })
      else this.spawnPoints.push(new THREE.Vector3(x, y, z))
    }
    mesh.instanceMatrix.needsUpdate = true
    this.group.add(mesh)
  }

  // ---------------------------------------------------------------- grass
  private buildGrass() {
    const tex = textures()
    const rng = this.rng
    const bladesPerPatch = 24
    const total = WORLD.grassPatches * bladesPerPatch

    // Two crossed quads per instance reads as a volumetric clump.
    // Kept around knee height: tall enough to hide a crouching tiger,
    // short enough that standing in it doesn't blind you.
    const quad = new THREE.PlaneGeometry(0.95, 0.95)
    quad.translate(0, 0.475, 0)
    const quadB = quad.clone()
    quadB.rotateY(Math.PI / 2)
    const geo = mergeSimple([quad, quadB])

    const mat = new THREE.MeshStandardMaterial({
      map: tex.grassBlade,
      transparent: true,
      alphaTest: 0.35,
      side: THREE.DoubleSide,
      roughness: 1,
    })
    const mesh = new THREE.InstancedMesh(geo, mat, total)
    mesh.receiveShadow = true
    mesh.frustumCulled = false
    const m = new THREE.Matrix4()
    let i = 0

    for (let p = 0; p < WORLD.grassPatches; p++) {
      let px = 0
      let pz = 0
      for (let tries = 0; tries < 20; tries++) {
        const d = rng.inDisc(WORLD.bounds - 4)
        px = d.x
        pz = d.z
        if (Math.hypot(px, pz) > 16) break
      }
      const pr = rng.range(2.6, 6.5)
      this.grassPatches.push({ x: px, z: pz, r: pr })
      this.spawnPoints.push(new THREE.Vector3(px, terrainHeight(px, pz), pz))

      for (let b = 0; b < bladesPerPatch; b++) {
        const a = rng.range(0, Math.PI * 2)
        const r = Math.sqrt(rng.next()) * pr
        const x = px + Math.cos(a) * r
        const z = pz + Math.sin(a) * r
        const sc = rng.range(0.8, 1.25)
        m.compose(
          new THREE.Vector3(x, terrainHeight(x, z) - 0.06, z),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rng.range(0, Math.PI), 0)),
          new THREE.Vector3(sc, sc * rng.range(0.85, 1.2), sc),
        )
        mesh.setMatrixAt(i++, m)
      }
    }
    for (; i < total; i++) {
      m.compose(new THREE.Vector3(0, -999, 0), new THREE.Quaternion(), new THREE.Vector3(0.001, 0.001, 0.001))
      mesh.setMatrixAt(i, m)
    }
    mesh.instanceMatrix.needsUpdate = true
    this.grassMesh = mesh
    this.group.add(mesh)
  }

  /** Rock wall ring so the world edge reads as a valley, not a void. */
  private buildBoundaryCliffs() {
    const tex = textures()
    const mat = new THREE.MeshStandardMaterial({ map: tex.rock, roughness: 1, flatShading: true, color: 0x8a8a80 })
    const geo = new THREE.DodecahedronGeometry(1, 0)
    const n = 90
    const mesh = new THREE.InstancedMesh(geo, mat, n)
    const m = new THREE.Matrix4()
    const rng = this.rng
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const r = WORLD.bounds + rng.range(2, 7)
      const x = Math.cos(a) * r
      const z = Math.sin(a) * r
      const sc = rng.range(5, 11)
      m.compose(
        new THREE.Vector3(x, terrainHeight(x, z) + sc * 0.2, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3))),
        new THREE.Vector3(sc, sc * rng.range(0.9, 1.6), sc),
      )
      mesh.setMatrixAt(i, m)
    }
    mesh.instanceMatrix.needsUpdate = true
    mesh.castShadow = true
    this.group.add(mesh)
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
   * Returns the corrected position. `stepHeight` lets tall jumps clear
   * low obstacles like fire pits.
   */
  resolve(x: number, z: number, radius: number, feetY: number): { x: number; z: number; hit: boolean } {
    let hit = false
    for (let iter = 0; iter < 3; iter++) {
      let moved = false
      for (const c of this.colliders) {
        if (feetY > terrainHeight(c.x, c.z) + c.h) continue // pounced clean over it
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
      }
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
    for (const c of this.colliders) {
      const r = c.kind === 'circle' ? c.r : Math.hypot(c.hw, c.hd) * 0.8
      if (c.h < 1.2) continue // low things don't block sight
      // Closest approach of the segment to the collider centre.
      const t = (c.x - ax) * ux + (c.z - az) * uz
      if (t < 0 || t > len) continue
      const px = ax + ux * t
      const pz = az + uz * t
      if (Math.hypot(px - c.x, pz - c.z) < r) return true
    }
    return false
  }

  /** A random navigable spot at least `minFromCentre` out. */
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
    if (viewer) {
      // Keep the horizon centred on the viewer; only Y stays fixed so the
      // sunset band always lines up with the ground plane.
      this.sky.position.set(viewer.x, 0, viewer.z)
    }
    for (const f of this.fireLights) {
      f.light.intensity = f.base * (0.72 + Math.abs(fbm(time * 2.4 + f.phase, f.phase, 2)) * 0.85)
    }
    // Fade decals slowly so the village accumulates evidence but not forever.
    for (const d of this.decals) {
      if (!d.visible) continue
      const m = d.material as THREE.MeshBasicMaterial
      m.opacity -= dt * 0.012
      if (m.opacity <= 0) d.visible = false
    }
    // Lazy grass sway via material offset — cheap and reads well at distance.
    if (this.grassMesh) {
      const mat = this.grassMesh.material as THREE.MeshStandardMaterial
      if (mat.map) mat.map.offset.x = Math.sin(time * 0.5) * 0.012
    }
  }
}

/** Minimal geometry merge for a couple of same-attribute BufferGeometries. */
function mergeSimple(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry()
  const keys = ['position', 'normal', 'uv'] as const
  let indexCount = 0
  let vertCount = 0
  for (const g of geos) {
    vertCount += g.attributes.position!.count
    indexCount += g.index ? g.index.count : g.attributes.position!.count
  }
  for (const key of keys) {
    const size = geos[0]!.attributes[key]!.itemSize
    const arr = new Float32Array(vertCount * size)
    let o = 0
    for (const g of geos) {
      arr.set(g.attributes[key]!.array as Float32Array, o)
      o += g.attributes[key]!.array.length
    }
    out.setAttribute(key, new THREE.BufferAttribute(arr, size))
  }
  const idx = new Uint16Array(indexCount)
  let o = 0
  let base = 0
  for (const g of geos) {
    const gi = g.index!
    for (let i = 0; i < gi.count; i++) idx[o++] = gi.getX(i) + base
    base += g.attributes.position!.count
  }
  out.setIndex(new THREE.BufferAttribute(idx, 1))
  return out
}
