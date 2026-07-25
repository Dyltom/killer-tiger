/**
 * Chunked instanced scattering.
 *
 * Every field of plants used to be one InstancedMesh spanning the whole map with
 * `frustumCulled = false`. That is one draw call, which sounds ideal and is the
 * single most expensive thing the renderer was doing: the ground-cover field
 * alone pushed 155,000 instances — 1.2 million vertices through a full
 * MeshStandardMaterial vertex shader with wind and distance-fade injected —
 * every frame, of which maybe six per cent were ever on screen. A distance fade
 * that shrinks an instance to zero still runs its vertex shader.
 *
 * Splitting the same instances across a grid of chunks costs a handful of extra
 * draw calls and lets both culls happen before any shading:
 *
 *   - chunks past the field's draw distance are switched off outright, and
 *   - the rest are frustum-culled by three against a real bounding sphere.
 *
 * With a 78-degree FOV that leaves roughly a quarter of the near chunks alive,
 * so the ground cover goes from ~155k instances a frame to ~8k.
 */
import * as THREE from 'three'

interface Bucket {
  /** Cell centre, for the distance test. */
  x: number
  z: number
  matrices: number[]
  colors: number[]
  /** Highest point any instance in this cell reaches, for the bounds. */
  top: number
}

export interface BuildOptions {
  castShadow?: boolean
  receiveShadow?: boolean
  /** Instances stop being drawn past this distance from the camera. */
  drawDistance: number
}

/** One chunk, kept flat so the per-frame visibility pass touches no objects. */
interface Chunk {
  mesh: THREE.InstancedMesh
  x: number
  z: number
}

export class ChunkedScatter {
  readonly group = new THREE.Group()

  private buckets = new Map<number, Bucket>()
  private chunks: Chunk[] = []
  private half: number
  /** Squared cull distance including the chunk's own half-diagonal. */
  private cullSq = Infinity
  private baseDistance = Infinity

  constructor(private cell: number) {
    this.half = cell * 0.5
  }

  /**
   * Queue one instance. `y` is only used to size the chunk's bounding sphere,
   * so an approximate top-of-the-plant height is fine.
   */
  push(m: THREE.Matrix4, x: number, y: number, z: number, color?: THREE.Color) {
    const cx = Math.floor(x / this.cell)
    const cz = Math.floor(z / this.cell)
    // 4096 cells per axis is far more than any map here needs, and the key
    // stays a small integer so the Map hashes it as a fast path.
    const key = (cx + 2048) * 4096 + (cz + 2048)
    let b = this.buckets.get(key)
    if (!b) {
      b = { x: cx * this.cell + this.half, z: cz * this.cell + this.half, matrices: [], colors: [], top: 0 }
      this.buckets.set(key, b)
    }
    for (let i = 0; i < 16; i++) b.matrices.push(m.elements[i]!)
    if (color) b.colors.push(color.r, color.g, color.b)
    if (y > b.top) b.top = y
  }

  /** Turn the queued instances into one InstancedMesh per occupied cell. */
  build(geo: THREE.BufferGeometry, mat: THREE.Material, opts: BuildOptions) {
    this.baseDistance = opts.drawDistance
    this.setDrawDistance(opts.drawDistance)

    for (const b of this.buckets.values()) {
      const count = b.matrices.length / 16
      if (count === 0) continue
      const mesh = new THREE.InstancedMesh(geo, mat, count)
      mesh.instanceMatrix.copyArray(b.matrices)
      mesh.instanceMatrix.needsUpdate = true
      if (b.colors.length) {
        const col = new THREE.InstancedBufferAttribute(new Float32Array(b.colors), 3)
        mesh.instanceColor = col
        col.needsUpdate = true
      }
      mesh.castShadow = opts.castShadow ?? false
      mesh.receiveShadow = opts.receiveShadow ?? true

      // three derives instanced bounds from the geometry's own sphere, which is
      // the unit plant at the origin — every chunk would claim to be at 0,0 and
      // the frustum cull would be meaningless. Set the real cell bounds instead.
      const r = Math.hypot(this.half, this.half) + b.top
      mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(b.x, b.top * 0.5, b.z), r)
      mesh.frustumCulled = true

      this.group.add(mesh)
      this.chunks.push({ mesh, x: b.x, z: b.z })
    }
    // The staging data is several megabytes of plain arrays; drop it.
    this.buckets.clear()
  }

  /** Quality tiers pull the draw distance in and out. */
  setDrawDistance(d: number) {
    const pad = Math.hypot(this.half, this.half)
    this.cullSq = (d + pad) * (d + pad)
  }

  /** Scale the field's build-time draw distance. Used by the quality manager. */
  setDistanceScale(s: number) {
    this.setDrawDistance(this.baseDistance * s)
  }

  /** Switch off whole chunks the camera cannot possibly see. Called per frame. */
  update(camX: number, camZ: number) {
    const chunks = this.chunks
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!
      const dx = c.x - camX
      const dz = c.z - camZ
      c.mesh.visible = dx * dx + dz * dz < this.cullSq
    }
  }
}
