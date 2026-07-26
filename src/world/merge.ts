/**
 * Bake a static object tree down to one mesh per material per spatial cell.
 *
 * The village is built the way it is drawn on paper — a hut is a plinth and a
 * wall and a cone of thatch and six veranda poles and a doorway, a cart is a bed
 * and two rails and two wheels and eight spokes — and every one of those is a
 * `new THREE.Mesh`. Twenty-two huts and their clutter came to 777 meshes, which
 * is 777 draw calls in the colour pass and most of another 233 in the shadow
 * pass, for geometry that has not moved since it was built. Measured on the
 * frame loop that was 9 ms of a 20 ms frame: the single most expensive thing in
 * the game, and all of it submission overhead rather than anything the GPU was
 * being asked to do.
 *
 * Nothing about how the village is authored has to change to fix that. The
 * transforms are constant, so they can be baked into the vertices; the meshes
 * share a handful of materials, so what is left merges into one buffer each.
 *
 * Why per *cell* rather than one buffer per material: a single mesh spanning the
 * whole village can never be frustum-culled, so standing at one edge of it still
 * pays for the far side. A 40 m grid keeps the draw count near the material
 * count while leaving three's cull something to work with — and 40 m is chosen
 * against the fog, not the village: past `WORLD.fogFar` there is nothing to see
 * anyway, so cells only need to be small enough that a cell is either mostly in
 * frame or mostly out of it.
 *
 * What must not be merged, and why it is opted out by hand rather than detected:
 * a merged mesh has no transform of its own and no material of its own, so
 * anything that is animated by moving it (the campfire flames) or by writing to
 * its material (the doorway glows, which each carry their own phase) has to stay
 * a mesh. `userData.dynamic` on the object or any ancestor keeps it out.
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/** Every attribute the merge carries. Anything else on a source is dropped. */
const ATTRS = ['position', 'normal', 'uv'] as const

/**
 * mergeGeometries refuses a mix of indexed and non-indexed inputs, and the
 * polyhedra (`DodecahedronGeometry`, the campfire stones) are the only
 * non-indexed things in the village. A sequential index is a no-op that makes
 * them mergeable without expanding everything else to non-indexed, which would
 * roughly triple the vertex count of every cylinder in the place.
 */
function indexed(g: THREE.BufferGeometry): THREE.BufferGeometry {
  if (g.index) return g
  const n = g.attributes.position!.count
  const arr = new Uint32Array(n)
  for (let i = 0; i < n; i++) arr[i] = i
  g.setIndex(new THREE.BufferAttribute(arr, 1))
  return g
}

interface Batch {
  mat: THREE.Material
  cast: boolean
  receive: boolean
  geos: THREE.BufferGeometry[]
}

export interface MergeStats {
  before: number
  after: number
}

/**
 * Flatten every static mesh under `root` into merged meshes parented to `root`.
 *
 * @param cell Grid size in metres. Bigger trades culling for draw calls.
 */
export function mergeStatic(root: THREE.Object3D, cell = 40): MergeStats {
  root.updateMatrixWorld(true)
  // Everything is baked into root-local space, so a root that has been moved or
  // rotated since is still correct.
  const toLocal = new THREE.Matrix4().copy(root.matrixWorld).invert()
  const local = new THREE.Matrix4()
  const at = new THREE.Vector3()

  const batches = new Map<string, Batch>()
  const merged: THREE.Mesh[] = []
  let before = 0

  root.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh) return
    const m = o as THREE.Mesh
    before++
    // Opted out, or under something that is.
    for (let n: THREE.Object3D | null = m; n; n = n.parent) {
      if (n.userData.dynamic) return
      if (n === root) break
    }
    // A multi-material mesh carries draw groups the merge would have to
    // renumber, and the village has none. Leave anything like that alone.
    if (Array.isArray(m.material)) return
    const g = m.geometry
    for (const a of ATTRS) if (!g.attributes[a]) return

    local.copy(toLocal).multiply(m.matrixWorld)
    const copy = g.clone()
    // Drop anything the batch's other geometries won't have — mergeGeometries
    // requires the attribute sets to match exactly.
    for (const name of Object.keys(copy.attributes)) {
      if (!(ATTRS as readonly string[]).includes(name)) copy.deleteAttribute(name)
    }
    copy.applyMatrix4(local)
    indexed(copy)

    at.setFromMatrixPosition(m.matrixWorld)
    const cx = Math.floor(at.x / cell)
    const cz = Math.floor(at.z / cell)
    // Shadow flags are baked per mesh, so they have to agree within a batch.
    const key = `${m.material.uuid}|${m.castShadow ? 1 : 0}|${m.receiveShadow ? 1 : 0}|${cx},${cz}`

    let b = batches.get(key)
    if (!b) {
      b = { mat: m.material, cast: m.castShadow, receive: m.receiveShadow, geos: [] }
      batches.set(key, b)
    }
    b.geos.push(copy)
    merged.push(m)
  })

  for (const b of batches.values()) {
    const geo = mergeGeometries(b.geos, false)
    // A batch that fails to merge (mismatched attributes that slipped through)
    // must not silently vanish — leave its sources in the tree instead.
    if (!geo) {
      for (const g of b.geos) g.dispose()
      continue
    }
    for (const g of b.geos) g.dispose()
    const mesh = new THREE.Mesh(geo, b.mat)
    mesh.castShadow = b.cast
    mesh.receiveShadow = b.receive
    root.add(mesh)
  }

  // Only now that every batch has merged is it safe to unhook the sources.
  for (const m of merged) {
    if (batches.size) m.removeFromParent()
  }
  // Groups left holding nothing still cost a traversal and a matrix update
  // every frame for the rest of the run.
  prune(root)

  let after = 0
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) after++
  })
  return { before, after }
}

/** Drop every descendant group that ended up with no renderable under it. */
function prune(root: THREE.Object3D) {
  const empty = (o: THREE.Object3D): boolean => {
    for (let i = o.children.length - 1; i >= 0; i--) {
      if (empty(o.children[i]!)) o.children[i]!.removeFromParent()
    }
    return o.children.length === 0 && !(o as THREE.Mesh).isMesh && !(o as THREE.Light).isLight
  }
  for (let i = root.children.length - 1; i >= 0; i--) {
    if (empty(root.children[i]!)) root.children[i]!.removeFromParent()
  }
}
