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
 * The eyes and the eyebrows are 172 and 192 triangles, which is nothing, and
 * two of the six draw calls a character costs, which is not. Draw call
 * submission is the dominant term in this frame — measured at about 5.6 µs
 * each in Safari, against 0.7 ms per million triangles — so those two meshes
 * are a third of the crowd's cost for two per cent of its geometry.
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
const DETAIL = /eyebrow|low-poly/i
const DETAIL_RANGE = 15

const scenes = new Map<string, THREE.Group>()
let clips: THREE.AnimationClip[] = []
let ready = false

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
    m.castShadow = true
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
    m.material = mat
    meshes.push(m)
    if (DETAIL.test(m.name)) detail.push(m)
    materials.push(mat)
  })

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
