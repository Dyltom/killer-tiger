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
 *
 * The catch is that the cell size was picked for that field and then handed to
 * every other one. Trees are 130 instances of a 78-vertex trunk; at a 40 m cell
 * that is 35 chunks holding 290 vertices each, so the cull was saving a few
 * microseconds of vertex work and being charged a draw call for it. The cell is
 * now chosen from the field's own density — see MIN_CHUNK_VERTS.
 */
import * as THREE from 'three'

/**
 * Coarsen a field's cells until each occupied chunk carries at least this much
 * vertex work.
 *
 * A chunk earns its keep when the vertex time saved by culling it beats the
 * draw call it costs when it isn't culled. With a quarter of chunks surviving
 * the frustum, K chunks over V total vertices break even at
 *
 *   0.25 * K * callCost  =  0.75 * V * vertCost
 *
 * Measured here: a draw call costs about 14 us amortized (this frame is bound
 * on submission, not on fill or on vertices), which puts break-even near a
 * thousand vertices per chunk. The number below is three times that on purpose.
 * Vertex work lands on a GPU that currently finishes early and waits, so it is
 * the cheaper side of the trade until that stops being true.
 *
 * Coarsening cannot make anything pop, whatever this is set to. The distance
 * test pads by the chunk's own radius, so a chunk only switches off once every
 * instance in it is at least `drawDistance` away — grow the chunks and the cull
 * gets more conservative, never less. The worst a big cell can do is draw
 * something the fog was already hiding.
 */
const MIN_CHUNK_VERTS = 3000

interface Bucket {
  /** Indices into the staging arrays. */
  at: number[]
  minX: number
  maxX: number
  minZ: number
  maxZ: number
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
  /** Horizontal radius, so the distance test doesn't clip a chunk's near edge. */
  r: number
  /** (drawDistance + r)^2, refreshed whenever the draw distance moves. */
  cullSq: number
}

export class ChunkedScatter {
  readonly group = new THREE.Group()

  // Staging. Instances are bucketed in build(), not here, because the cell size
  // isn't known until the whole field has been pushed and its density is known.
  private mats: number[] = []
  private px: number[] = []
  private py: number[] = []
  private pz: number[] = []
  private cols: number[] = []

  private chunks: Chunk[] = []
  private drawDistance = Infinity
  private baseDistance = Infinity

  /** `cell` is the finest grid this field will use; sparse fields coarsen it. */
  constructor(private cell: number) {}

  /**
   * Queue one instance. `y` is only used to size the chunk's bounding sphere,
   * so an approximate top-of-the-plant height is fine.
   */
  push(m: THREE.Matrix4, x: number, y: number, z: number, color?: THREE.Color) {
    for (let i = 0; i < 16; i++) this.mats.push(m.elements[i]!)
    this.px.push(x)
    this.py.push(y)
    this.pz.push(z)
    if (color) this.cols.push(color.r, color.g, color.b)
  }

  /** Turn the queued instances into one InstancedMesh per occupied cell. */
  build(geo: THREE.BufferGeometry, mat: THREE.Material, opts: BuildOptions) {
    this.baseDistance = opts.drawDistance
    this.drawDistance = opts.drawDistance

    const n = this.px.length
    if (n === 0) return

    const verts = geo.attributes.position?.count ?? 1
    let cell = this.cell
    let buckets = this.bucket(cell)
    // Halving the grid count per step, so this settles in a few passes even for
    // a field of one instance, and stops at a single chunk covering the map.
    while (buckets.size > 1 && (n * verts) / buckets.size < MIN_CHUNK_VERTS) {
      cell *= 2
      buckets = this.bucket(cell)
    }

    const hasColor = this.cols.length > 0
    for (const b of buckets.values()) {
      const count = b.at.length
      const mesh = new THREE.InstancedMesh(geo, mat, count)
      const dst = mesh.instanceMatrix.array as Float32Array
      const col = hasColor ? new Float32Array(count * 3) : null
      for (let i = 0; i < count; i++) {
        const src = b.at[i]! * 16
        for (let e = 0; e < 16; e++) dst[i * 16 + e] = this.mats[src + e]!
        if (col) {
          const c = b.at[i]! * 3
          col[i * 3] = this.cols[c]!
          col[i * 3 + 1] = this.cols[c + 1]!
          col[i * 3 + 2] = this.cols[c + 2]!
        }
      }
      mesh.instanceMatrix.needsUpdate = true
      if (col) {
        mesh.instanceColor = new THREE.InstancedBufferAttribute(col, 3)
        mesh.instanceColor.needsUpdate = true
      }
      mesh.castShadow = opts.castShadow ?? false
      mesh.receiveShadow = opts.receiveShadow ?? true

      // three derives instanced bounds from the geometry's own sphere, which is
      // the unit plant at the origin — every chunk would claim to be at 0,0 and
      // the frustum cull would be meaningless. Bound the instances themselves;
      // a coarsened cell is mostly empty and its cell bounds would be far
      // looser than the handful of plants actually in it.
      const cx = (b.minX + b.maxX) * 0.5
      const cz = (b.minZ + b.maxZ) * 0.5
      const r = Math.hypot(b.maxX - cx, b.maxZ - cz) + b.top
      mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, b.top * 0.5, cz), r)
      mesh.frustumCulled = true

      this.group.add(mesh)
      this.chunks.push({ mesh, x: cx, z: cz, r: Math.hypot(b.maxX - cx, b.maxZ - cz), cullSq: 0 })
    }
    this.refreshCull()

    // The staging data is several megabytes of plain arrays; drop it.
    this.mats = []
    this.px = []
    this.py = []
    this.pz = []
    this.cols = []
  }

  /** Sort the staged instances into a grid of the given cell size. */
  private bucket(cell: number) {
    const buckets = new Map<number, Bucket>()
    for (let i = 0; i < this.px.length; i++) {
      const x = this.px[i]!
      const z = this.pz[i]!
      // 4096 cells per axis is far more than any map here needs, and the key
      // stays a small integer so the Map hashes it as a fast path.
      const key = (Math.floor(x / cell) + 2048) * 4096 + (Math.floor(z / cell) + 2048)
      let b = buckets.get(key)
      if (!b) {
        b = { at: [], minX: x, maxX: x, minZ: z, maxZ: z, top: 0 }
        buckets.set(key, b)
      }
      b.at.push(i)
      if (x < b.minX) b.minX = x
      if (x > b.maxX) b.maxX = x
      if (z < b.minZ) b.minZ = z
      if (z > b.maxZ) b.maxZ = z
      if (this.py[i]! > b.top) b.top = this.py[i]!
    }
    return buckets
  }

  private refreshCull() {
    for (const c of this.chunks) {
      const d = this.drawDistance + c.r
      c.cullSq = d * d
    }
  }

  /** Quality tiers pull the draw distance in and out. */
  setDrawDistance(d: number) {
    this.drawDistance = d
    this.refreshCull()
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
      c.mesh.visible = dx * dx + dz * dz < c.cullSq
    }
  }
}
