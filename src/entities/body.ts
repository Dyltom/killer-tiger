/**
 * The authored cast: five MakeHuman bodies and the mocap library they share.
 *
 * Everything here replaces what `Human` used to build for itself — a skeleton
 * of boxes and swept tubes, dressed by procedure, walked by a hand-written gait
 * solver. That system was good at the things procedure is good at (fifty-two
 * bodies with no two alike, wounds cut anywhere on the surface, a fall that is
 * different every time) and could not get past the one thing it was bad at,
 * which is faces. See tools/characters for how these are built.
 *
 * Two things about the assets that the rest of the game has to know:
 *
 * *They face +Z.* MakeHuman's basemesh faces -Y in Blender, which comes out of
 * the glTF exporter as +Z, and the game's convention is -Z. Rather than rotate
 * the asset — which would put every wound coordinate in a frame nothing else
 * uses — the mesh is parented under a group turned half a turn. Body space is
 * then exactly what it always was; only the wound capsules, which the shader
 * reads out of the mesh's own `position` attribute, need converting, and that
 * is what `toMesh` is for.
 *
 * *One skeleton drives all of them.* Every character carries the same 31 CMU
 * bone names, and three.js binds animation tracks to bones by name, so
 * `anims.glb` is loaded once and its clips are played on any body.
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { clamp } from '../engine/rng'
import { loadingManager } from '../world/materials'
import { applyLayers, mergeLayered } from './layered'

/** Villager bodies, picked round-robin by slot so a crowd is not one man. */
export const VILLAGERS = ['villager_a', 'villager_b', 'villager_elder', 'villager_woman'] as const
export const HUNTER = 'hunter'
const FILES = [...VILLAGERS, HUNTER]

/**
 * The clips, and the height the wound placement was authored against.
 *
 * `sectionR` and every hard-coded y in the damage code describe a 1.72 m man,
 * which is what the procedural body was. These five are not all that tall — the
 * elder is 1.62 — so their wounds are placed in units of their own height.
 */
const NOMINAL_HEIGHT = 1.72

export type ClipName =
  | 'idle' | 'idle2' | 'walk' | 'run' | 'sneak' | 'chores' | 'wounded' | 'flee' | 'collapse'

/** The handful of bones anything outside the mixer ever addresses. */
export interface Rig {
  hips: THREE.Bone
  spine: THREE.Bone
  chest: THREE.Bone
  neck: THREE.Bone
  head: THREE.Bone
  /** Index 0 is the left arm, 1 the right — the order the old rig used. */
  arms: { upper: THREE.Bone; fore: THREE.Bone; hand: THREE.Bone }[]
}

export interface Body {
  /** Turned to face -Z. Parent this, not the meshes. */
  readonly root: THREE.Group
  readonly rig: Rig
  readonly meshes: THREE.SkinnedMesh[]
  readonly materials: THREE.MeshStandardMaterial[]
  readonly mixer: THREE.AnimationMixer
  /** This body's height over the height the damage code assumes. */
  readonly scale: number
  /**
   * Show only the detail this body is close enough to be worth.
   *
   * `d` is metres from the camera. See DETAIL and the note above it — this is
   * two draw calls a head, and at wave twelve there are forty heads.
   */
  setDetail(d: number): void
}

/**
 * Meshes that stop being worth a draw call once the body is a few metres away.
 *
 * The eyes and the eyebrows are 172 and 192 triangles, which is nothing, and —
 * merged together by `collapse` below — one of the three draw calls a character
 * costs, which is not. Draw call submission is the dominant term in this frame,
 * measured at about 19 µs each in Safari against 0.7 ms per million triangles.
 *
 * Fifteen metres because that is comfortably past the range at which an eye is
 * more than one pixel: the head is about 22 cm, so at 15 m it spans roughly 30
 * px of a 1920-wide frame and an iris is under two. Everything the player is
 * actually looking at while mauling somebody is inside 5 m and keeps its face.
 *
 * The hair is deliberately not on this list even though it is 5,352 triangles.
 * It is a silhouette, and a villager who goes bald at fifteen metres is the
 * kind of pop that is far more visible than the thing it saves.
 */
const DETAIL = /eyebrow|low-poly|^HumanDetail$/
const DETAIL_RANGE = 15

/** MakeHuman's name for the basemesh. Garments are `Human<garment>`. */
const BASEMESH = 'Human'
/** What `collapse` calls the merged eyes-and-brows. Matched by DETAIL above. */
const DETAILMESH = 'HumanDetail'

const scenes = new Map<string, THREE.Group>()
let clips: THREE.AnimationClip[] = []
let ready = false

/**
 * How far two inverse-bind matrices may drift and still count as the same.
 *
 * The matrices being compared are built from the same rest pose by the same
 * exporter and stored as float32, so agreement is to about 1e-7 and the
 * disagreement this guards against is structural — a submesh bound to a
 * genuinely different pose, which would be off by whole centimetres.
 */
const BIND_EPS = 1e-4

/**
 * The one matrix by which `other` disagrees with `base` about the bind pose, or
 * null if the disagreement is not a single scale-and-offset.
 *
 * Skinning sends a vertex to `sum_i w_i * M_i * A_i * p`, where `M_i` is bone
 * i's world matrix and `A_i` its inverse bind. Rebinding a mesh from inverses
 * `A` to inverses `B` therefore needs a `p'` with `B_i p' = A_i p` for every
 * bone at once, which has the solution `p' = B_i^-1 A_i p` — useful only if
 * `B_i^-1 A_i` is the *same* matrix for every i. Then it is a plain change of
 * coordinates on the mesh and the skinning result is unchanged. Verified
 * numerically against the loaded assets, not just argued: the skinned position
 * of a sample vertex before and after comes out bit-identical.
 *
 * It is the same matrix here, and the reason is mundane. These glbs are meshopt
 * -quantized, so every submesh's positions are stored as int16 normalized into
 * [-1, 1] and the dequantization — a scale and an offset, nothing else — is
 * folded into that submesh's inverse binds rather than applied to the vertices.
 * A shirt therefore lives at 0.44x in a frame of its own. That is a constant per
 * submesh by construction, which is exactly the condition. Checked per bone.
 *
 * Also checked: that the 3x3 really is a positive multiple of the identity.
 * Dequantization cannot produce anything else, and it is what lets the caller
 * leave the normals alone — a uniform scale does not turn a normal. Anything
 * with a rotation or a shear in it is some other phenomenon and is refused
 * rather than handled on a guess.
 */
function rebase(base: THREE.Skeleton, other: THREE.Skeleton): THREE.Matrix4 | null {
  const inv = base.boneInverses
  const own = other.boneInverses
  if (inv.length !== own.length || inv.length === 0) return null
  const d = new THREE.Matrix4().copy(inv[0]!).invert().multiply(own[0]!)
  const probe = new THREE.Matrix4()
  for (let i = 1; i < inv.length; i++) {
    probe.copy(inv[i]!).invert().multiply(own[i]!)
    for (let e = 0; e < 16; e++) {
      if (Math.abs(probe.elements[e]! - d.elements[e]!) > BIND_EPS) return null
    }
  }
  return scaleAndShift(d) ? d : null
}

/**
 * True if `m` is a positive uniform scale and a translation, and nothing else.
 *
 * Both matrices this file derives are that by construction — they come out of a
 * quantizer, which cannot turn or shear anything — and checking rather than
 * assuming is what lets both callers leave the normals alone. Anything with a
 * rotation in it is some other phenomenon and gets refused rather than handled
 * on a guess.
 */
function scaleAndShift(m: THREE.Matrix4): boolean {
  const e = m.elements
  const s = e[0]!
  if (!(s > 0)) return false
  // Column-major: 0/5/10 are the diagonal, 1/2/4/6/8/9 the rest of the 3x3.
  if (Math.abs(e[5]! - s) > BIND_EPS || Math.abs(e[10]! - s) > BIND_EPS) return false
  for (const off of [1, 2, 4, 6, 8, 9]) if (Math.abs(e[off]!) > BIND_EPS) return false
  return true
}

/**
 * The transform that turns a submesh's stored coordinates into metres, or null
 * if the asset does not admit one.
 *
 * gltfpack stores positions as int16 normalized into [-1, 1] — each submesh
 * scaled to its own longest axis, so a shirt, a shoe and a body are all
 * nominally the same size — and folds the dequantization into the skin's
 * inverse bind matrices instead of into the vertices. Skinning therefore comes
 * out in metres and everything renders correctly, while the `position`
 * attribute itself holds numbers with no physical meaning.
 *
 * That is fatal for one thing in this game. The wound shader reads `position`
 * directly, because bind-pose coordinates are what welds a cut to the skin it
 * was opened on, and it is handed capsules in metres by human.ts — a rake
 * across the chest at y = 1.28. The body's stored y runs -0.76 to 0.76. Every
 * capsule the game has ever opened on the authored cast has been outside the
 * mesh's own bounding box, so no villager has ever visibly bled. The
 * procedural body this cast replaced stored metres and did not have the
 * problem, which is why the shader was written to assume them.
 *
 * The map is recovered from the skeleton rather than guessed. In the bind pose
 * skinning collapses to `Q = bindMatrixInverse * M_i * A_i * bindMatrix` for
 * every bone i at once, so evaluating that on a freshly loaded glTF — where
 * the nodes are still in their rest pose and no mixer has run — gives Q
 * directly, and its agreement across all thirty-one bones is simultaneously
 * the proof that rest and bind are the same pose here. Measured spread over
 * the cast: 2e-7. Anything that disagrees by more returns null and keeps the
 * coordinates it has.
 */
function dequantize(mesh: THREE.SkinnedMesh): THREE.Matrix4 | null {
  const sk = mesh.skeleton
  if (sk.bones.length === 0 || sk.bones.length !== sk.boneInverses.length) return null
  const back = new THREE.Matrix4().copy(mesh.bindMatrix).invert()
  const q = new THREE.Matrix4()
  const probe = new THREE.Matrix4()
  for (let i = 0; i < sk.bones.length; i++) {
    probe.copy(back)
      .multiply(sk.bones[i]!.matrixWorld)
      .multiply(sk.boneInverses[i]!)
      .multiply(mesh.bindMatrix)
    if (i === 0) {
      q.copy(probe)
      continue
    }
    for (let e = 0; e < 16; e++) {
      if (Math.abs(probe.elements[e]! - q.elements[e]!) > BIND_EPS) return null
    }
  }
  return scaleAndShift(q) ? q : null
}

/**
 * Rewrite a geometry's positions through `d`, as float.
 *
 * Not `BufferGeometry.applyMatrix4`, and the difference is the whole reason this
 * function exists. That method writes the transformed values back through
 * `BufferAttribute.setXYZ`, which for a *normalized integer* attribute
 * re-quantizes — and clamps. These positions are int16 normalized into [-1, 1]
 * and the dequantizing transform takes them well outside it (a shoe's vertices
 * land near -2.2), so every one of them saturated at -1 and the character came
 * apart into metre-long shards radiating from the origin. Silently, with no
 * warning and no error: the geometry is still a valid mesh, just not that mesh.
 *
 * So the attribute is replaced with an un-quantized float32 one rather than
 * written back in place. `fromBufferAttribute` reads through the normalization,
 * so the values going in are the real ones. The cost is the point of
 * quantization given back — roughly six bytes a vertex over the whole cast,
 * about 1 MB — and it is paid once per glb for every clone.
 *
 * Normals are deliberately untouched. `d` is a uniform scale plus a translation
 * — `scaleAndShift` refuses anything else, for both callers — which leaves every
 * normal exactly where it was, and running them through the same round trip
 * would only cost them a requantization to int8 they have no reason to pay.
 */
function bakePositions(geom: THREE.BufferGeometry, d: THREE.Matrix4) {
  const src = geom.getAttribute('position')
  const out = new Float32Array(src.count * 3)
  const v = new THREE.Vector3()
  for (let i = 0; i < src.count; i++) {
    v.fromBufferAttribute(src, i).applyMatrix4(d).toArray(out, i * 3)
  }
  geom.setAttribute('position', new THREE.BufferAttribute(out, 3))
  geom.boundingBox = null
  geom.boundingSphere = null
}

/**
 * Put every one of a character's submeshes in the body's coordinate space and
 * on the body's skeleton.
 *
 * Two things come out of the exporter per-submesh that should be per-character.
 *
 * *A skeleton each.* Six meshes means six `Skeleton` objects over the same
 * thirty-one bones, and three updates a skeleton once per frame per object:
 * thirty-one matrix multiplies and a bone-texture upload, six times over, for
 * six identical answers. Across forty villagers that was 262 skeletons and 262
 * texture uploads a frame.
 *
 * *A coordinate space each.* Only the body mesh is stored in the frame the rest
 * of the game calls body space; a shirt is at 0.44x and a pair of boots at
 * 0.32x, each with its own origin, and the inverse binds undo it during
 * skinning. Anything that reads the untransformed `position` attribute is
 * therefore reading a different space per submesh — which is precisely what the
 * wound shader does. Afterwards every submesh's coordinates go through the one
 * map `sum_i w_i * M_i * A_base_i`, the body's own, so the frame that shader
 * reads is consistent across a character. It is still not metres, though;
 * `remetre` runs next and finishes that half.
 *
 * Baking the difference into the vertices fixes both at once, because it is the
 * same difference. Run once per loaded glb, before anything is cloned: the
 * clones share these buffers, so the cost is paid once for the whole cast.
 *
 * A submesh whose disagreement is not a single scale-and-offset keeps its own
 * skeleton and is left alone. That is the correct outcome rather than a failure
 * — it renders exactly as it does today, and only forfeits the saving.
 */
/** The scene's skinned meshes, gathered by the node they hang off. */
function byRig(scene: THREE.Object3D): Map<THREE.Object3D, THREE.SkinnedMesh[]> {
  const rigs = new Map<THREE.Object3D, THREE.SkinnedMesh[]>()
  scene.traverse(o => {
    const m = o as THREE.SkinnedMesh
    if (!m.isSkinnedMesh || !m.parent) return
    let list = rigs.get(m.parent)
    if (!list) rigs.set(m.parent, (list = []))
    list.push(m)
  })
  return rigs
}

function unify(scene: THREE.Object3D) {
  for (const meshes of byRig(scene).values()) {
    if (meshes.length < 2) continue
    // The body is the base, not merely the first one traversed: it is the space
    // the wound coordinates and every hard-coded height in the damage code are
    // written in, so it is the one space that must come out unchanged. MakeHuman
    // names the basemesh `Human` and every garment `Human<something>`.
    const base = (meshes.find(m => m.name === BASEMESH) ?? meshes[0]!).skeleton
    for (const m of meshes) {
      if (m.skeleton === base) continue
      const d = rebase(base, m.skeleton)
      if (!d) continue
      bakePositions(m.geometry, d)
      m.bind(base, m.bindMatrix)
    }
  }
}

/**
 * Move a character's vertices out of gltfpack's quantized frame and into
 * metres, without moving the character.
 *
 * `dequantize` explains where the quantized frame comes from and why the wound
 * shader cannot live with it. Undoing it is a two-sided edit, because the
 * skeleton is currently carrying the correction: multiply every vertex by `Q`
 * and divide it back out of the inverse binds, and skinning lands in exactly
 * the same place while `position` finally means something.
 *
 * The divide is not `A_i * Q^-1` in general. Three skins as
 * `bindMatrixInverse * sum_i w_i (M_i A_i) * bindMatrix * p`, so the `Q` that
 * reaches the vertices is conjugated by the bind matrix and the compensation
 * has to be conjugated the same way: `A_i' = A_i * (BM * Q^-1 * BM^-1)`. It
 * reduces to `A_i * Q^-1` for the identity bind matrix these assets actually
 * have, but writing the reduced form would be a trap for the first asset that
 * does not.
 *
 * Correcting the inverse binds rather than splitting `bindMatrix` from
 * `bindMatrixInverse` is what keeps those two each other's inverse, which three
 * assumes in `getVertexPosition` and therefore in raycasting. The cost is that
 * every mesh sharing the skeleton has to be baked together and has to agree
 * about the bind matrix — checked, and the whole rig is skipped if it does not.
 *
 * Runs after `unify`, on the shared skeleton it produces, and before anything
 * is cloned. A rig that fails any check keeps the coordinates it has and
 * renders exactly as it does today.
 */
function remetre(scene: THREE.Object3D) {
  // `dequantize` reads bone world matrices, and nothing has forced them yet.
  scene.updateMatrixWorld(true)
  const done = new Set<THREE.BufferGeometry>()
  for (const meshes of byRig(scene).values()) {
    const body = meshes.find(m => m.name === BASEMESH) ?? meshes[0]
    if (!body) continue
    const group = meshes.filter(m => m.skeleton === body.skeleton)
    if (group.some(m => !m.bindMatrix.equals(body.bindMatrix))) continue
    const q = dequantize(body)
    if (!q) continue

    const bind = body.bindMatrix
    const k = new THREE.Matrix4()
      .copy(bind)
      .multiply(new THREE.Matrix4().copy(q).invert())
      .multiply(new THREE.Matrix4().copy(bind).invert())
    for (const m of group) {
      if (done.has(m.geometry)) continue
      done.add(m.geometry)
      bakePositions(m.geometry, q)
    }
    for (const inverse of body.skeleton.boneInverses) inverse.multiply(k)
  }
}

/**
 * Fold each character's submeshes down into two meshes and two materials.
 *
 * See layered.ts for the mechanism and the measurements. The policy is here
 * because it is about what these particular assets are, and it splits three
 * ways:
 *
 * *The solid group* — the body and everything it is wearing that does not
 * discard — becomes one mesh, and keeps the basemesh's name so that everything
 * downstream which looks for `Human` still finds the body's skeleton and the
 * body's coordinate space.
 *
 * *The eyes and the brows* become a second, because they alpha-test and want a
 * threshold the body must not have, and because they are the pair that
 * `setDetail` switches off at fifteen metres — merged, that is one draw call
 * saved rather than two, and it stays a clean thing to hide.
 *
 * *The hair* is left alone. It is the one submesh that alpha-tests and is never
 * culled, so folding it into either group would either put a discard on the
 * whole body or make the detail mesh unhideable.
 *
 * The merged brows and eyes stop casting shadows, which is not free but is very
 * nearly so. Three builds its shadow depth material from the colour material's
 * `map`, and the merged one has none — its texture is an array the depth shader
 * knows nothing about — so an alpha-tested brow would go into the shadow map as
 * the full unclipped strip it is modelled on. Rather than teach the depth pass
 * about layers for the sake of a 2 mm feature that is inside the head or flat
 * against a brow ridge, and which is hidden entirely past fifteen metres, they
 * are taken out of it.
 */
function collapse(scene: THREE.Object3D) {
  for (const meshes of byRig(scene).values()) {
    const detail = meshes.filter(m => DETAIL.test(m.name))
    const solid = meshes.filter(
      m => !DETAIL.test(m.name) && (m.material as THREE.Material).alphaTest === 0,
    )
    // Body first: `mergeLayered` takes its terms from the head of the list, and
    // the body is the mesh whose space and skeleton the merge has to come out in.
    solid.sort((a, b) => (a.name === BASEMESH ? -1 : b.name === BASEMESH ? 1 : 0))
    mergeLayered(solid, BASEMESH)
    const merged = mergeLayered(detail, DETAILMESH)
    if (merged) merged.castShadow = false
  }
}

/**
 * Kick the load off at import time.
 *
 * Deliberately not awaited by anything: the GLTFLoader is handed the same
 * LoadingManager as the terrain textures, so the loading screen main.ts puts up
 * already waits for these, and the pool of Humans is built long before the
 * first frame is drawn. Anything that runs earlier than the load simply has no
 * body yet, which `Body`-less code paths handle by staying invisible.
 */
const loader = new GLTFLoader(loadingManager)
loader.setMeshoptDecoder(MeshoptDecoder)

let pending = FILES.length + 1
const done = () => {
  if (--pending === 0) ready = true
}

for (const name of FILES) {
  loader.load(`models/${name}.glb`, gltf => {
    // Before anything is cloned: the clones share these vertex buffers, so the
    // rebake and the merge are paid once per character rather than once per
    // villager. `collapse` needs `unify` to have run — it can only merge
    // submeshes that already agree on a skeleton and a coordinate space.
    unify(gltf.scene)
    remetre(gltf.scene)
    collapse(gltf.scene)
    scenes.set(name, gltf.scene)
    done()
  }, undefined, err => {
    console.error('[cast] failed to load', name, err)
    done()
  })
}
loader.load('models/anims.glb', gltf => {
  clips = gltf.animations
  done()
}, undefined, err => {
  console.error('[cast] failed to load the animation library', err)
  done()
})

export function castReady(): boolean {
  return ready && scenes.size === FILES.length && clips.length > 0
}

/**
 * A fresh, independently posable copy.
 *
 * SkeletonUtils.clone is what makes this affordable: it duplicates the node
 * hierarchy and the Skeleton but shares the geometry and the textures, so forty
 * villagers cost forty skeletons and one set of buffers. Materials are cloned
 * per body because each one carries its own wound uniforms.
 */
export function makeBody(name: string): Body | null {
  const src = scenes.get(name)
  if (!src || clips.length === 0) return null

  const model = cloneSkinned(src) as THREE.Group
  const root = new THREE.Group()
  // The half turn that puts the asset in the game's frame. See the header.
  model.rotation.y = Math.PI
  root.add(model)

  const meshes: THREE.SkinnedMesh[] = []
  const detail: THREE.SkinnedMesh[] = []
  const materials: THREE.MeshStandardMaterial[] = []
  const bones = new Map<string, THREE.Bone>()
  model.traverse(o => {
    if ((o as THREE.Bone).isBone) bones.set(o.name, o as THREE.Bone)
    const m = o as THREE.SkinnedMesh
    if (!m.isSkinnedMesh) return
    // Everything but the merged brows and eyes, which have no `map` for three
    // to build a depth material's discard out of. See `collapse`.
    m.castShadow = m.name !== DETAILMESH
    m.receiveShadow = true
    // Cull against a pose-independent sphere rather than not culling at all.
    //
    // Left to itself three calls SkinnedMesh.computeBoundingSphere on the first
    // frame a body is tested, which walks the vertices in whatever pose that
    // frame happened to catch and then caches the answer forever. A sphere
    // measured mid-stride and reused for a man who later sprints, falls and
    // lies down culls him while he is on screen, which is why this used to be
    // switched off entirely — and switching it off meant all forty villagers
    // were submitted every frame no matter where the camera pointed.
    //
    // A fixed sphere has neither problem. 2.2 m about hip height covers every
    // clip in the library including the collapse, where a body ends up lying
    // its own length from the origin it is still parented to. Being generous
    // costs only the odd character culled a frame late.
    m.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 2.2)
    m.frustumCulled = true
    const mat = (m.material as THREE.MeshStandardMaterial).clone()
    // `Material.copy` does not carry `onBeforeCompile`, so a merged mesh's
    // clone arrives knowing nothing about the texture array its vertices index
    // into. Re-injected here, and before human.ts adds the wound shading —
    // that chains onto whatever it finds, and the diffuse sample has to be
    // underneath the blood rather than over it.
    applyLayers(mat, m.geometry)
    m.material = mat
    meshes.push(m)
    if (DETAIL.test(m.name)) detail.push(m)
    materials.push(mat)
  })

  // Re-share the skeleton on the clone. `unify` put the source's submeshes on
  // one Skeleton, but SkeletonUtils.clone calls `skeleton.clone()` per skinned
  // mesh regardless, so a freshly cloned body arrives holding six copies of it
  // again. They are equivalent copies — same bones, same inverses — so the
  // sharing is restored by assignment, and the geometry is already in the one
  // space from the source rebake.
  const shared = (meshes.find(m => m.name === BASEMESH) ?? meshes[0])?.skeleton
  if (shared) for (const m of meshes) if (m.skeleton !== shared) m.bind(shared, m.bindMatrix)

  const bone = (n: string) => bones.get(n)!
  const arm = (s: 'Left' | 'Right') => ({
    upper: bone(`${s}Arm`), fore: bone(`${s}ForeArm`), hand: bone(`${s}Hand`),
  })
  const rig: Rig = {
    hips: bone('Hips'),
    spine: bone('LowerBack'),
    chest: bone('Spine1'),
    neck: bone('Neck'),
    head: bone('Head'),
    arms: [arm('Left'), arm('Right')],
  }

  // Measured, not tabulated: the cast.json heights are macro slider values, not
  // metres, and the elder is 6 cm shorter than the spec implies once his age
  // morph has finished with him.
  const box = new THREE.Box3().setFromObject(model)

  let detailed = true
  return {
    root,
    rig,
    meshes,
    materials,
    mixer: new THREE.AnimationMixer(model),
    scale: (box.max.y - box.min.y) / NOMINAL_HEIGHT,
    setDetail(d: number) {
      const on = d < DETAIL_RANGE
      if (on === detailed) return
      detailed = on
      for (const m of detail) m.visible = on
    },
  }
}

/**
 * How fast each clip travels over the ground on this body, in metres per second.
 *
 * Not measurable here, and that is the point: retarget.py throws the clips'
 * horizontal drift away on purpose, because a clip that walks itself forward
 * fights the AI for control of where the man is. So the pace is measured at build
 * time, where the drift still exists, and shipped in the glTF as an `extras` on
 * each animation — three.js hands those back as `clip.userData`. `anim.py` prints
 * the same numbers, so what the game plays back at is what the build reported.
 *
 * The value is normalised to a 1.72 m body, so a character's own height scales it:
 * all five are driven by the same rotations, and a stride under those conditions
 * goes with leg length, which goes with height. Clips with no meaningful pace —
 * every idle, and the collapse — report near zero and are dropped, which leaves
 * them playing at their authored rate.
 */
export function gaitPaces(body: Body): Partial<Record<ClipName, number>> {
  const out: Partial<Record<ClipName, number>> = {}
  for (const c of clips) {
    const pace = c.userData?.pace
    if (typeof pace === 'number' && pace > 0.3) out[c.name as ClipName] = pace * body.scale
  }
  return out
}

const byName = new Map<string, THREE.AnimationClip>()
export function clip(name: ClipName): THREE.AnimationClip | null {
  if (byName.size !== clips.length) {
    byName.clear()
    for (const c of clips) byName.set(c.name, c)
  }
  return byName.get(name) ?? null
}

/**
 * A point in body space, expressed in the mesh's own frame.
 *
 * Half a turn about Y is all that separates them, which negates x and z; the
 * height scale then puts a wound authored for a 1.72 m man on the man actually
 * wearing it. Wounds are the only thing that needs this, because they are the
 * only thing the shader reads out of the untransformed `position` attribute.
 */
export function toMesh(out: THREE.Vector3, scale: number): THREE.Vector3 {
  return out.set(-out.x * scale, out.y * scale, -out.z * scale)
}

/**
 * One clip at a time, crossfaded.
 *
 * Nothing here blends two gaits together by weight: the library has a walk and
 * a run rather than a parameterised locomotion tree, so the honest thing is to
 * pick one and fade. What keeps that from reading as a snap is that the clips
 * were all grounded and de-yawed at build time, so the pose either side of a
 * crossfade differs in gait and not in where the man is standing or which way
 * he is pointing.
 */
export class Motion {
  private action: THREE.AnimationAction | null = null
  private current: ClipName | null = null
  private readonly cache = new Map<ClipName, THREE.AnimationAction>()

  constructor(private readonly mixer: THREE.AnimationMixer) {}

  get playing(): ClipName | null {
    return this.current
  }

  /** True once a one-shot has reached its last frame and stopped. */
  get finished(): boolean {
    return this.action !== null && !this.action.isRunning()
  }

  /**
   * `rate` scales playback, which is how a walk cycle stays on the ground.
   *
   * The clip walks at whatever pace the performer walked; the game moves a
   * villager at whatever pace the AI asked for. Playing the two independently is
   * the foot-skate you see in every game that does not bother, and a cycle whose
   * stride length is known can simply be run at speed/stride instead.
   */
  play(name: ClipName, fade = 0.22, opts: { once?: boolean; rate?: number } = {}) {
    let next = this.cache.get(name)
    if (!next) {
      const c = clip(name)
      if (!c) return
      next = this.mixer.clipAction(c)
      this.cache.set(name, next)
    }
    next.timeScale = opts.rate ?? 1

    if (this.current === name) return
    next.reset()
    next.enabled = true
    next.setEffectiveWeight(1)
    if (opts.once) {
      next.setLoop(THREE.LoopOnce, 1)
      next.clampWhenFinished = true
    } else {
      next.setLoop(THREE.LoopRepeat, Infinity)
      next.clampWhenFinished = false
    }
    if (this.action && fade > 0) next.crossFadeFrom(this.action, fade, false)
    next.play()
    this.action = next
    this.current = name
  }

  update(dt: number) {
    this.mixer.update(dt)
  }

  /** Back to nothing, for a pool slot about to be somebody else. */
  stop() {
    this.mixer.stopAllAction()
    this.cache.clear()
    this.action = null
    this.current = null
  }
}

const qWorld = new THREE.Quaternion()
const qWant = new THREE.Quaternion()
const vAxis = new THREE.Vector3()

/**
 * Turn a bone about a world-space axis, on top of whatever the clip did.
 *
 * The overlays the game needs — a head that tracks the tiger, a body that
 * flinches from a blow — used to be written straight onto Euler channels,
 * which worked because the old rig's bones were authored with their axes
 * chosen to make exactly that readable. A mocap rig's are not: `rotation.x` on
 * `LeftArm` is some diagonal nobody picked on purpose. So the rotation is
 * specified where it is meaningful, in the world, and converted into the bone's
 * parent frame here.
 */
export function twist(bone: THREE.Bone, axis: THREE.Vector3, angle: number) {
  if (angle === 0) return
  const parent = bone.parent
  if (parent) {
    parent.getWorldQuaternion(qWorld)
    vAxis.copy(axis).applyQuaternion(qWorld.invert())
  } else {
    vAxis.copy(axis)
  }
  qWant.setFromAxisAngle(vAxis.normalize(), angle)
  bone.quaternion.premultiply(qWant)
}

const qDelta = new THREE.Quaternion()
const qBlend = new THREE.Quaternion()
const qParent = new THREE.Quaternion()
const vFrom = new THREE.Vector3()
const vTo = new THREE.Vector3()
const vRoot = new THREE.Vector3()
const vMid = new THREE.Vector3()
const vTip = new THREE.Vector3()
const vElbow = new THREE.Vector3()
const vBend = new THREE.Vector3()

/** Swing a bone so that its world direction `from` ends up pointing along `to`. */
function swing(bone: THREE.Bone, from: THREE.Vector3, to: THREE.Vector3, k: number) {
  qDelta.setFromUnitVectors(from, to)
  if (k < 1) qDelta.copy(qBlend.identity().slerp(qDelta, k))
  const parent = bone.parent
  if (!parent) {
    bone.quaternion.premultiply(qDelta)
    return
  }
  // The delta is a rotation of the bone's *world* orientation, and the bone
  // stores a rotation in its parent's frame: Qw = Qp·Qb, so Qb' = Qp⁻¹·D·Qp·Qb.
  parent.getWorldQuaternion(qParent)
  qBlend.copy(qParent).invert().multiply(qDelta).multiply(qParent)
  bone.quaternion.premultiply(qBlend)
}

/**
 * Two-bone IK: put the hand on a world-space point, elbow toward `pole`.
 *
 * Used for one thing — the hunter's hands on his rifle — and written as IK
 * rather than as a pose because there is a mocap clip running underneath. An
 * authored arm pose has to be blended against whatever the clip's shoulder is
 * doing and loses; a target position is indifferent to it.
 *
 * The bone lengths are read out of the current world matrices instead of being
 * tabulated, because the five characters are five different sizes and none of
 * them is the one this was tuned on.
 *
 * `k` fades the whole thing in, which is what makes the rifle come up smoothly
 * instead of snapping to the shoulder the frame the hunter decides to shoot.
 */
export function reach(
  arm: { upper: THREE.Bone; fore: THREE.Bone; hand: THREE.Bone },
  target: THREE.Vector3,
  pole: THREE.Vector3,
  k: number,
) {
  // One update walks the whole chain, ancestors included.
  arm.hand.updateWorldMatrix(true, false)
  vRoot.setFromMatrixPosition(arm.upper.matrixWorld)
  vMid.setFromMatrixPosition(arm.fore.matrixWorld)
  vTip.setFromMatrixPosition(arm.hand.matrixWorld)
  const l1 = vRoot.distanceTo(vMid)
  const l2 = vMid.distanceTo(vTip)
  if (l1 < 1e-4 || l2 < 1e-4) return

  vTo.subVectors(target, vRoot)
  // Short of a straight arm and clear of a folded one: at either limit the
  // triangle degenerates and the elbow's plane stops being defined.
  const d = clamp(vTo.length(), Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3)
  if (vTo.lengthSq() < 1e-8) return
  vTo.normalize()

  // The elbow sits off the shoulder-to-hand line by the angle the law of
  // cosines gives, in the plane that line makes with the pole.
  const cos = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1)
  const off = Math.acos(cos)
  vBend.copy(pole).addScaledVector(vTo, -pole.dot(vTo))
  if (vBend.lengthSq() < 1e-8) vBend.set(vTo.z, vTo.x, vTo.y)
  vBend.normalize()
  vElbow.copy(vRoot)
    .addScaledVector(vTo, l1 * Math.cos(off))
    .addScaledVector(vBend, l1 * Math.sin(off))

  vFrom.subVectors(vMid, vRoot).normalize()
  vTo.subVectors(vElbow, vRoot).normalize()
  swing(arm.upper, vFrom, vTo, k)

  // Re-read: the shoulder just moved, so the forearm's own frame did too.
  arm.hand.updateWorldMatrix(true, false)
  vMid.setFromMatrixPosition(arm.fore.matrixWorld)
  vTip.setFromMatrixPosition(arm.hand.matrixWorld)
  vFrom.subVectors(vTip, vMid).normalize()
  vTo.subVectors(target, vMid)
  if (vTo.lengthSq() < 1e-8) return
  swing(arm.fore, vFrom, vTo.normalize(), k)
}
