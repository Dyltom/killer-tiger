/**
 * One bone texture for the whole cast, uploaded once a frame.
 *
 * three gives every `Skeleton` a `DataTexture` of its own and asks for it to be
 * re-uploaded whenever the skeleton has moved, which for a crowd of animated
 * villagers is every skeleton every frame. On the worst frame in the game —
 * wave twelve, night, forty bodies, thirty of them on screen — that came to
 * 2.25 ms of a 15.5 ms frame, and it is the whole of what a body costs beyond
 * its pixels:
 *
 *   - replacing `Skeleton.update` with its matrix flatten alone, so that the
 *     poses are still computed but no upload is asked for, takes the frame from
 *     15.50 to 13.25 ms; removing the flatten as well leaves it at 13.38. The
 *     flatten is free and the upload is the entire cost.
 *   - it is not fill: ablating the humans saves the same 4.5 ms at 1.06 and at
 *     4.24 megapixels, and shrinking every body to a point saves nothing at all.
 *   - it is not triangles: drawing 2% of the indices, same calls and same
 *     skeletons, recovers 1.25 ms of a 5.75 ms total.
 *   - it is not the materials: eighty distinct `MeshPhysicalMaterial`s, eighty
 *     distinct `MeshBasicMaterial`s and one shared `MeshBasicMaterial` all
 *     measure the same. (Which is worth saying plainly, because the hair merge
 *     next door was a per-material uniform cost and this is not one.)
 *
 * Sharing the texture is most of it. On that frame, stock against this file and
 * back again: 18.8, 16.9, 20.7 ms one way and 12.2, 12.7, 13.4 then 13.1, 12.7,
 * 13.1 the other.
 *
 * The rest is the second page, and it is there for a reason the upload counts
 * do not predict. Cancelling the upload recovers about the same 1.1-2.2 ms
 * whether it is one texture or forty, and the size of it does not matter either
 * — one upload a frame costs 2.2 ms at 124 kB, 1.6 ms at 496 kB and 2.9 ms at
 * 1984 kB, sixteen times the bytes for no difference. Neither the calls nor the
 * transfer, then; what is left is writing into a texture the previous frame's
 * draws have not finished reading, and waiting for them. So the cast alternates
 * between two atlases: the frame that writes page A is drawn against page A
 * while the work still in flight refers to page B. Interleaved and rotated
 * against the same frame, single-page 11.9 and 13.7 ms became 10.7 and 11.8 —
 * within 0.3 ms of the floor set by cancelling the upload altogether (10.4 and
 * 11.5). Which leaves a few milliseconds of the end-to-end gap that the upload
 * ablations do not account for and that has not been narrowed further.
 *
 * Double-buffering is what the shared atlas makes affordable. Forty skeletons
 * could have been paired off too, but that is eighty textures and eighty
 * uploads to dodge one stall.
 *
 * The layout is what makes it need almost no shader. `getBoneMatrix( i )` reads
 * texel `4i`, wrapping at the texture's own width, so an atlas exactly
 * `4 * bones` texels wide puts each skeleton on its own row and turns "which
 * skeleton" into nothing more than an offset added to the bone index. One float
 * uniform per material, no change to the chunk that does the arithmetic, and
 * every body still shares one compiled program.
 *
 * What it costs: the flatten now runs for every body in the scene graph rather
 * than only for the ones that survived frustum culling, because the upload
 * happens before three has worked out what it is drawing and the shadow pass
 * wants poses for bodies the camera cannot see anyway. That is the free half of
 * the measurement above, and bodies hidden in the pool are skipped.
 */
import * as THREE from 'three'

/** Rows the atlas starts with. It doubles rather than turn a body away. */
const SEED_ROWS = 64

/**
 * Bones per skeleton, fixed by the first rig to register.
 *
 * The whole cast comes out of one MPFB2 pipeline and every character has the
 * same 31, so this is a uniform stride rather than a per-row offset table. A
 * rig that disagrees is refused rather than accommodated: it keeps three's
 * own bone texture and renders exactly as it does today.
 */
let stride = 0

/** One of the two atlases, with a pre-sliced view per row so `flush` allocates nothing. */
type Page = { tex: THREE.DataTexture; data: Float32Array; rows: Float32Array[] }
let pages: Page[] = []
/** Which page the next frame writes and draws against. */
let page = 0

const skeletons: THREE.Skeleton[] = []
/** The object whose visibility says whether a row is worth flattening. */
const roots: THREE.Object3D[] = []

const _offset = new THREE.Matrix4()
const noop = () => {}

function reallocate(rows: number) {
  const width = stride * 4
  const next = [0, 1].map(() => {
    const data = new Float32Array(width * rows * 4)
    const tex = new THREE.DataTexture(data, width, rows, THREE.RGBAFormat, THREE.FloatType)
    // Nearest and no mipmaps, as three's own `computeBoneTexture` leaves them.
    // `texelFetch` ignores filtering, but the texture still has to be complete.
    tex.needsUpdate = true
    return { tex, data, rows: [] as Float32Array[] }
  })
  for (const p of pages) p.tex.dispose()
  pages = next
  // Rows are only ever written whole, so nothing is carried over: a row that
  // matters is rewritten before it is next drawn, and one that does not is a
  // body the scene is not showing.
  for (let i = 0; i < skeletons.length; i++) point(skeletons[i]!, i)
}

/** Cut a skeleton's row out of both pages and aim it at the current one. */
function point(skel: THREE.Skeleton, row: number) {
  for (const p of pages) p.rows[row] = p.data.subarray(row * stride * 16, (row + 1) * stride * 16)
  skel.boneTexture = pages[page]!.tex
  skel.boneMatrices = pages[page]!.rows[row]!
}

/**
 * Give a skeleton a row, or null if this rig cannot have one.
 *
 * `root` is what gets tested for visibility each frame — pass the body's own
 * root, not the mesh, so that an avatar sitting unused in a pool slot costs
 * nothing.
 *
 * Call before the first frame: this replaces the skeleton's own texture, and
 * three allocates that lazily on first draw.
 */
export function registerPose(skel: THREE.Skeleton, root: THREE.Object3D): number | null {
  if (stride === 0) stride = skel.bones.length
  if (stride === 0 || skel.bones.length !== stride) return null

  const row = skeletons.length
  const height = pages[0]?.tex.image.height ?? 0
  if (row >= height) reallocate(height ? height * 2 : SEED_ROWS)
  skeletons.push(skel)
  roots.push(root)
  point(skel, row)
  // three calls this once per skeleton per frame, from inside the draw, and
  // every call would ask the shared texture for another upload. `flush` does
  // the same work for every row at once instead.
  skel.update = noop
  return row
}

/**
 * Fold the atlas offset into a material's bone lookup.
 *
 * Must be given every material the mesh can be drawn with, the custom depth
 * material included — a shadow pass reading row zero would pose the whole
 * village as whoever happens to be in it.
 */
export function applyPose(mat: THREE.Material, row: number) {
  const base = row * stride
  const prev = mat.onBeforeCompile.bind(mat)
  mat.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer)
    shader.uniforms.uBoneRow = { value: base }
    shader.vertexShader = shader.vertexShader
      .replace('#include <skinning_pars_vertex>', /* glsl */ `
        #include <skinning_pars_vertex>
        #ifdef USE_SKINNING
          uniform float uBoneRow;
        #endif
      `)
      // The chunk this replaces is these same four lines without the offset.
      // Kept under the same ifdef so a material that is not on a skinned mesh
      // still compiles to what it did before.
      .replace('#include <skinbase_vertex>', /* glsl */ `
        #ifdef USE_SKINNING
          mat4 boneMatX = getBoneMatrix( skinIndex.x + uBoneRow );
          mat4 boneMatY = getBoneMatrix( skinIndex.y + uBoneRow );
          mat4 boneMatZ = getBoneMatrix( skinIndex.z + uBoneRow );
          mat4 boneMatW = getBoneMatrix( skinIndex.w + uBoneRow );
        #endif
      `)
  }
  // The row is a uniform rather than a define, so every body still shares one
  // program — but a posed material and an unposed one must not be handed each
  // other's, and three hashes neither `onBeforeCompile` nor its uniforms.
  const prevKey = mat.customProgramCacheKey.bind(mat)
  mat.customProgramCacheKey = () => `${prevKey()}|pose`
}

/** True if `o` and every ancestor is visible, so three will reach it. */
function drawn(o: THREE.Object3D | null): boolean {
  for (; o; o = o.parent) if (!o.visible) return false
  return true
}

function flush() {
  const p = pages[page]
  if (!p) return
  page ^= 1
  for (let i = 0; i < skeletons.length; i++) {
    const skel = skeletons[i]!
    const out = p.rows[i]!
    skel.boneTexture = p.tex
    skel.boneMatrices = out
    if (!drawn(roots[i]!)) continue
    const bones = skel.bones
    const inverses = skel.boneInverses
    for (let b = 0; b < stride; b++) {
      _offset.multiplyMatrices(bones[b]!.matrixWorld, inverses[b]!)
      _offset.toArray(out, b * 16)
    }
  }
  p.tex.needsUpdate = true
}

/**
 * Drive the flush off the scene rather than off the game loop.
 *
 * `scene.onBeforeRender` is called by `WebGLRenderer.render` after
 * `scene.updateMatrixWorld` and before the shadow pass, which is the one moment
 * in the frame when every bone's world matrix is current and nothing has been
 * drawn with it yet. Hooking there rather than adding a call to the loop means
 * any path that renders this scene — the game, a bench, a screenshot — gets
 * correct poses without having to know this file exists.
 */
export function attachPose(scene: THREE.Scene) {
  const prev = scene.onBeforeRender.bind(scene)
  scene.onBeforeRender = (...args: Parameters<THREE.Object3D['onBeforeRender']>) => {
    prev(...args)
    flush()
  }
}
