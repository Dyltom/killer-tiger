/**
 * Prey and predators-of-the-predator.
 *
 * Villagers wander, notice the tiger, and scatter screaming toward firelight.
 * Hunters patrol, close the distance, and shoot. Both share one body rig and
 * one state machine; the differences are in the config table and the brain.
 *
 * The body itself is authored rather than generated — five MakeHuman people and
 * a library of CMU motion capture, built by tools/characters and loaded by
 * body.ts. What lives here is everything that is not the body: perception, the
 * state machine, pathing, the huts, the damage, and the thin layer that decides
 * which clip a man in a given state should be playing.
 *
 * The procedural rig that used to be here got further than it had any right to
 * — a solved gait with a real duty factor, a fall that composed properly about
 * its topple axis — and it still lost, on faces. Nothing about a swept tube
 * makes a face. What survived the swap is everything that was never about the
 * mesh: the wound capsules, which are analytic and know only where the skin is;
 * the body-level flinch and topple, which act on a group and not on a joint; and
 * the pools, streaks and sprays, which the game reads off world positions.
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { HUMAN, HUT } from '../config'
import { clamp, damp, Rng } from '../engine/rng'
import { terrainHeight, World } from '../world/world'
import type { Hut } from '../world/village'
import {
  type Body, castReady, type ClipName, gaitPaces, HUNTER, makeBody, Motion, reach, toMesh, twist, VILLAGERS,
} from './body'
import {
  addWoundShading, clearWounds, createWoundSet, cutWound, extendRun, RUN_SLOTS, startRun,
} from './wounds'

export type HumanKind = 'villager' | 'hunter'
export type HumanState = 'wander' | 'suspicious' | 'flee' | 'hide' | 'hunt' | 'panic' | 'dead'

/**
 * What opened the wound. Claws rake and jaws puncture, and the two leave marks
 * a player can tell apart without ever being told to look — which is the point
 * of carrying the distinction this far down at all.
 */
export type BlowKind = 'claw' | 'bite'

export interface ShotEvent {
  origin: THREE.Vector3
  dir: THREE.Vector3
  damage: number
  hit: boolean
}
const UP = new THREE.Vector3(0, 1, 0)
const FWD = new THREE.Vector3()
const RIGHT = new THREE.Vector3()

/** Brass on the rifle's bolt. The only colour left that isn't in a texture. */
const BRASS = 0xa9853f

function slab(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d)
  g.translate(x, y, z)
  return g
}

/** One ring of the torso section: height, half-width, half-depth, fore-aft centre. */
type Ring = readonly [number, number, number, number]

// ------------------------------------------------------ torso profile
/**
 * The torso section, hips to the base of the neck, on a nominal 1.72 m man.
 *
 * Rings of [y, half-width, half-depth, fore-aft centre]. This used to be the
 * geometry — the surface was swept through it — and is now only a description
 * of one, kept because the damage still needs to know where the skin is. A claw
 * rake is laid out along the surface and a bite has to find a throat, and both
 * of those are questions about a section: the ribs are 16 cm from the spine
 * across and 11 cm through, the throat is 5, and a wound placed at a constant
 * radius lands inside one and beside the other.
 *
 * The authored bodies are not this table, of course. They are within a
 * centimetre or so of it through the trunk, which is the accuracy a capsule
 * with a soft edge needs, and `Body.scale` carries the difference in height.
 */
const TORSO: readonly Ring[] = [
  [0.772, 0.006, 0.006, 0.000],  // closed at the perineum, buried between the thighs
  [0.788, 0.052, 0.040, 0.004],
  [0.828, 0.108, 0.084, 0.012],
  [0.862, 0.136, 0.102, 0.016],
  [0.895, 0.150, 0.111, 0.018],  // widest at the hips
  [0.930, 0.153, 0.109, 0.010],
  [0.975, 0.148, 0.104, 0.002],
  [1.030, 0.140, 0.098, -0.004],
  [1.085, 0.133, 0.093, -0.008],  // waist
  [1.135, 0.137, 0.096, -0.008],
  [1.190, 0.147, 0.102, -0.006],
  [1.240, 0.156, 0.107, -0.002],
  [1.290, 0.161, 0.110, 0.002],  // widest at the ribs; 0.32 across, not 0.36 —
  [1.335, 0.157, 0.105, 0.008],  // at 0.36 the arms hang inside the ribcage
  [1.375, 0.138, 0.090, 0.012],
  [1.405, 0.108, 0.072, 0.014],
  [1.430, 0.048, 0.042, 0.014],  // inside the neck tube, so the rim never shows
]


export class Human {
  readonly group = new THREE.Group()
  readonly pos = new THREE.Vector3()
  readonly vel = new THREE.Vector3()
  kind: HumanKind = 'villager'
  state: HumanState = 'wander'
  health = 60
  maxHealth = 60
  alive = true
  yaw = 0

  /** Awareness of the tiger, 0..1. Crosses 1 -> the human is certain. */
  awareness = 0
  alerted = false
  /** Set by roar / a nearby kill. */
  fearTimer = 0
  staggerTimer = 0

  /**
   * The hut this one has claimed, and how far through using it they are.
   *
   * Stages, in order: 0 walking to the door from outside, 1 stepping through
   * it, 2 crossing the floor to the dark at the back, 3 cowering there facing
   * the only way in, 4 bolting back out. Holding a hut also holds a slot in its
   * `occupants` count, so it has to be given back on death and on respawn as
   * well as on the way out — a leaked slot is a hut nobody can ever use again.
   */
  private hideHut: Hut | null = null
  private hideStage = 0
  /** Stops the door search running every frame, and every flush every second. */
  private hideCooldown = 0
  /**
   * How long they will keep trying to reach the door before giving up on it.
   *
   * These men path by walking at the thing they want and being pushed out of
   * whatever they walk into, which is enough for open ground and not enough for
   * a doorway on the far side of somebody else's hut. Without a deadline, one
   * villager wedged against a wall holds a slot in that hut for the rest of the
   * round and stands there while the tiger eats him.
   */
  private hideTimeout = 0
  /** Rolled once per life. Some people run for a door; some just run. */
  private willHide = false

  private target = new THREE.Vector3()
  private repathTimer = 0
  private fireTimer = 0
  private aimTimer = 0
  private deathTimer = 0
  private hurtFlash = 0
  private rng: Rng

  /** Lean away from the last blow, in body-local x/z. Decays back to nothing. */
  private leanX = 0
  private leanZ = 0
  /** Which way the body falls when it dies, in body-local space. */
  private fallX = 1
  private fallZ = 0
  private bleedTimer = 0
  private bleedNext = 0
  private fed = false
  /** Where the last blow landed, in bind-pose body space. */
  private lastCut = new THREE.Vector3()

  /**
   * A per-death seed, one number per slack joint.
   *
   * The collapse is one clip, so without this every corpse in the village is
   * the same corpse — and a shared death pose is the loudest possible tell that
   * these are twenty models on repeat, louder than any two faces being alike.
   * What it drives is small: the rate the fall plays at, and a few degrees of
   * settle on the head and spine once the man has stopped moving.
   */
  private jitter: number[] = []
  /** Ground pools stamped so far, the cap, and the clock to the next one. */
  private poolCount = 0
  private poolMax = 4
  private poolNext = 0

  /** Pose blends, all damped so nothing snaps between stances. */
  private aimBlend = 0
  /** How far the head is turned toward whatever this man is watching. */
  private lookBlend = 0
  private readonly lookAt = new THREE.Vector3()

  /**
   * The authored body, and the bones the overlays address.
   *
   * Null until the first spawn: the pool is built in the Game constructor,
   * which runs while the .glb files are still in flight. `avatars` holds the
   * ones this slot has worn — at most two, since a slot's villager is fixed by
   * its seed and the only other thing it can come back as is a hunter — so
   * switching kind on respawn costs nothing after the first time.
   */
  private avatar: Body | null = null
  private motion: Motion | null = null
  private readonly avatars = new Map<string, Body>()
  /** Which of the four villager bodies this slot is, for its whole life. */
  private readonly villagerModel: string
  /** This body's height over the 1.72 m the damage code is authored against. */
  private scale = 1
  /** Natural travel speed of each locomotion clip on this body, in m/s. */
  private paces: Partial<Record<ClipName, number>> = {}
  /**
   * Whether this villager keeps himself busy when he has nothing to do.
   *
   * Fixed by seed rather than rolled per stop, so a man doesn't take up and
   * abandon a habit every time he finishes a walk. Two ambient stands is not
   * much variety, but split this way it at least holds still.
   */
  private readonly chores: boolean

  private rifle: THREE.Group | null = null
  private rifleMat: THREE.MeshStandardMaterial | null = null
  private body = new THREE.Group()
  /** Every material on this body, for the dissolve at the end of the corpse's life. */
  private mats: THREE.MeshStandardMaterial[] = []
  /** Their roughness before blood, so the wet sheen can be applied relative. */
  private rough: number[] = []
  /** Every capsule cut into this body. Handed straight to its two shaders. */
  private wounds = createWoundSet()
  /**
   * Where blood is still leaving from, in bind-pose body space, with the slot
   * holding the streak below it. Only as many as the shader has room for; past
   * that the oldest source stops growing, which nobody has ever noticed on a
   * body that by then is more red than not.
   */
  private runs: { x: number; y: number; z: number; slot: number; len: number }[] = []
  private runNext = 0

  pendingShot: ShotEvent | null = null
  pendingShout = false
  screamed = false
  /**
   * Behind a wall and thinking it is enough. The game reads this the instant
   * before a kill lands, because "dragged out of a hut" is worth saying and
   * worth more points than the same kill in the open.
   */
  get hiding() {
    const h = this.hideHut
    if (!h || this.state !== 'hide' || this.hideStage < 2) return false
    // Includes the ones who have already broken and are running for the door:
    // being flushed happens at `HUT.flushRadius`, which is further out than a
    // paw reaches, so every kill indoors is a kill on someone mid-bolt. What
    // decides it is whether they are still between the walls.
    const lz = (this.pos.x - h.x) * h.dx + (this.pos.z - h.z) * h.dz
    return lz < (h.kind === 'round' ? h.r : h.hd)
  }
  /** Set for one frame each time the corpse pumps out another gout of blood. */
  bleedPulse = false
  /** Where the last wound was opened, in world space. */
  readonly woundPos = new THREE.Vector3()
  /**
   * Set for one frame when the corpse has soaked enough ground to be worth a
   * decal. The game stamps it; the body only knows where and how big.
   */
  poolPulse = false
  readonly poolPos = new THREE.Vector3()
  poolScale = 1

  constructor(seed: number) {
    this.rng = new Rng(seed)
    // Fixed for the slot's whole life, not rolled per spawn. Two reasons: a
    // body is expensive enough that a slot should only ever hold one villager,
    // and a crowd where the same man keeps changing face as people die and
    // respawn is worse than a crowd of four faces.
    this.villagerModel = VILLAGERS[Math.floor(this.rng.next() * VILLAGERS.length) % VILLAGERS.length]!
    this.chores = this.rng.next() < 0.5
    this.group.add(this.body)
  }

  // ----------------------------------------------------------------- body
  /**
   * Put this slot in the body its kind calls for, building it if it is new.
   *
   * Called from `spawn`, not from the constructor: the pool is fifty-two
   * Humans built before the first frame, and the .glb files are still loading
   * then. A slot that spawns before the cast has arrived stays invisible for
   * that life, which cannot happen in practice — the loading screen waits on
   * the same LoadingManager — but is the only failure mode worth having.
   */
  private attach(kind: HumanKind): boolean {
    const name = kind === 'hunter' ? HUNTER : this.villagerModel
    let next = this.avatars.get(name) ?? null
    if (!next) {
      // The pool is built in Game's constructor, which runs while these files
      // are still in flight, so a slot asked to spawn early simply has no body
      // to wear. It reports that and stays dead, which game.ts treats as a free
      // slot — the wave that missed out gets its men on the next attempt.
      if (!castReady()) return false
      next = makeBody(name)
      if (!next) return false
      this.avatars.set(name, next)
      next.root.visible = false
      this.body.add(next.root)
      for (const m of next.materials) addWoundShading(m, this.wounds)
    }
    if (this.avatar === next) return true

    if (this.avatar) {
      this.avatar.root.visible = false
      this.motion?.stop()
    }
    next.root.visible = true
    this.avatar = next
    this.motion = new Motion(next.mixer)
    this.scale = next.scale
    this.paces = gaitPaces(next)
    this.mats = next.materials.slice()
    if (this.rifleMat) this.mats.push(this.rifleMat)
    this.rough = this.mats.map(m => m.roughness)
    return true
  }

  /**
   * A point on the body's surface, in bind-pose body space.
   *
   * `theta` turns around the body's axis from the direction the blow came from,
   * so a wound can be laid out as an arc across the man rather than as a set of
   * offsets that walk off him. Anything wide has to be built this way: a claw
   * rake spans a third of the way round the ribs, and if its far end is placed
   * on the tangent plane instead of the surface it ends up hanging seven
   * centimetres out in the air beside him.
   *
   * `bulge` pushes the point out past the skin, which is how a straight capsule
   * covers a curved arc. A chord across an arc sags inward and would leave the
   * middle of a rake unpainted; lifting both ends by 1/cos(half the arc) puts
   * the sag back on the surface, and the ends finish slightly proud, which only
   * narrows the mark where a claw is leaving the body anyway.
   */
  private surfaceAt(
    theta: number, y: number,
    nx: number, nz: number, ax: number, az: number,
    bulge: number, out: THREE.Vector3,
  ) {
    const c = Math.cos(theta)
    const s = Math.sin(theta)
    const dx = nx * c + ax * s
    const dz = nz * c + az * s
    const r = sectionR(y, dx, dz) * bulge
    out.set(dx * r, y, dz * r)
  }

  // ------------------------------------------------------------- spawning
  spawn(kind: HumanKind, pos: THREE.Vector3, waveScale: number) {
    if (!this.attach(kind)) {
      this.group.visible = false
      this.alive = false
      return
    }
    this.kind = kind
    this.pos.copy(pos)
    this.vel.set(0, 0, 0)
    this.alive = true
    this.state = 'wander'
    this.awareness = 0
    this.alerted = false
    this.fearTimer = 0
    this.staggerTimer = 0
    this.deathTimer = 0
    this.hurtFlash = 0
    this.screamed = false
    this.releaseHut()
    this.hideStage = 0
    this.hideCooldown = 0
    this.hideTimeout = 0
    this.willHide = kind === 'villager' && this.rng.chance(HUT.hideChance)
    this.repathTimer = 0
    this.fireTimer = this.rng.range(0.4, 1.6)
    this.aimTimer = 0
    this.aimBlend = 0
    this.lookBlend = 0
    this.yaw = this.rng.range(0, Math.PI * 2)

    const cfg = kind === 'hunter' ? HUMAN.hunter : HUMAN.villager
    this.maxHealth = cfg.health * (1 + waveScale)
    this.health = this.maxHealth

    this.leanX = this.leanZ = 0
    this.bleedTimer = 0
    this.fed = false

    // The pool recycles corpses, so every trace of the last life has to be
    // scrubbed: a slot that came back with someone else's blood still on it was
    // the giveaway that these are the same twenty bodies over and over.
    clearWounds(this.wounds)
    this.runs.length = 0
    this.runNext = 0
    for (let i = 0; i < this.mats.length; i++) {
      const m = this.mats[i]!
      m.roughness = this.rough[i]!
      m.emissive.setHex(0x000000)
      m.opacity = 1
      // Back out of the dissolve. Nothing in the cast is authored as blended —
      // the hair, brows and eyes are alpha-*tested*, which is an opaque draw
      // with a discard in it — so opaque is the right resting state for all of
      // them, and their own alphaTest is left alone.
      m.transparent = false
      m.depthWrite = true
    }

    this.setRifleVisible(kind === 'hunter')
    this.group.visible = true
    this.group.rotation.set(0, this.yaw, 0)
    this.group.position.copy(this.pos)
    this.body.rotation.set(0, 0, 0)
    this.body.position.set(0, 0, 0)
    this.motion?.play(kind === 'hunter' ? 'idle' : 'idle2', 0)
    this.syncTransform()
  }

  /**
   * The rifle, which is the last piece of geometry in this file.
   *
   * It stayed procedural because it is five boxes and a cylinder, because
   * nothing about a rifle needs a face, and because it is the one thing on a
   * hunter that has to be positioned by the game rather than by a clip. The
   * bandolier and slouch hat that used to come with it did not survive: both
   * were authored against the old body's proportions and both were rigid meshes
   * parented to bones that no longer exist in that pose. What identifies a
   * hunter now is that he is the one carrying this.
   */
  private setRifleVisible(on: boolean) {
    if (on && !this.rifle) {
      const g = new THREE.Group()
      // One vertex-coloured mesh: wood, steel and brass in a single call, so an
      // armed hunter costs one more draw than an unarmed one rather than three.
      const stock = slab(0.056, 0.082, 0.34, 0, 0, 0.16)
      const grip = slab(0.05, 0.13, 0.1, 0, -0.05, 0.02)
      const fore = slab(0.05, 0.06, 0.3, 0, 0.004, -0.2)
      const barrel = new THREE.CylinderGeometry(0.014, 0.012, 0.62, 6)
      barrel.rotateX(Math.PI / 2)
      barrel.translate(0, 0.026, -0.29)
      const bolt = new THREE.CylinderGeometry(0.011, 0.011, 0.09, 5)
      bolt.rotateZ(Math.PI / 2)
      bolt.translate(0.045, 0.02, -0.02)
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.55, metalness: 0.35,
      })
      const mesh = new THREE.Mesh(
        mergeGeometries([
          tintGeo(stock, 0x4a3220), tintGeo(grip, 0x4a3220), tintGeo(fore, 0x53381f),
          tintGeo(barrel, 0x22242a), tintGeo(bolt, BRASS),
        ], false)!,
        mat,
      )
      mesh.castShadow = true
      g.add(mesh)
      this.body.add(g)
      this.rifle = g
      this.rifleMat = mat
      // Joins the dissolve, so a dead hunter's rifle fades with him rather than
      // being left standing in the grass.
      this.mats.push(mat)
      this.rough.push(mat.roughness)
    }
    if (this.rifle) this.rifle.visible = on
  }

  private syncTransform() {
    this.group.position.copy(this.pos)
    this.group.rotation.y = this.yaw
  }

  get cfg() {
    return this.kind === 'hunter' ? HUMAN.hunter : HUMAN.villager
  }

  get chestPos(): THREE.Vector3 {
    return new THREE.Vector3(this.pos.x, this.pos.y + 1.245 * this.scale, this.pos.z)
  }

  // --------------------------------------------------------------- damage
  /** Returns true if this hit killed them. */
  hurt(amount: number, from: THREE.Vector3, blow: BlowKind = 'claw', at?: THREE.Vector3): boolean {
    if (!this.alive) return false
    this.health -= amount
    this.hurtFlash = 1
    this.alerted = true
    this.awareness = 1.4
    this.staggerTimer = Math.max(this.staggerTimer, 0.3)

    // Direction the blow came from, in world space and then in body-local — the
    // rig has to lean and fall away from it, not always forward.
    const dx = this.pos.x - from.x
    const dz = this.pos.z - from.z
    const l = Math.hypot(dx, dz) || 1
    const wx = dx / l
    const wz = dz / l
    // Body-local is the *inverse* of the group's yaw, and this used to build the
    // forward rotation instead: sin came out with the wrong sign, so fallZ was
    // negated and every body toppled toward whatever had just hit it. Front and
    // back are the one axis a viewer can read on a falling man, so the whole
    // topple was playing backwards.
    const c = Math.cos(this.yaw)
    const s = Math.sin(this.yaw)
    this.fallX = wx * c - wz * s
    this.fallZ = wx * s + wz * c
    // Whipped away from the impact hard enough to see, then damped out.
    this.leanX = clamp(this.leanX + this.fallZ * 0.85, -1, 1)
    this.leanZ = clamp(this.leanZ - this.fallX * 0.85, -1, 1)

    // Knocked back, harder the bigger the hit.
    const shove = 3.4 + Math.min(amount, 140) * 0.03
    this.vel.x += wx * shove
    this.vel.z += wz * shove

    // Torn open, and it stays torn.
    this.openWound(blow, at)

    if (this.health <= 0) {
      this.die(amount)
      return true
    }
    if (this.kind === 'villager') this.state = 'flee'
    return false
  }

  /**
   * Cut the shape of the blow into the body, wherever the blow landed.
   *
   * This replaced five red ellipsoids parented to the chest bone. Those never
   * had a chance: an ellipsoid centred just inside a surface is a sphere
   * sticking *out* of it, they scaled up from the bone's origin as the damage
   * grew so they climbed further off the ribs the worse things got, and being
   * in the same place on every body meant a man shot in the back grew a red
   * bubble on his front. It read exactly as what it was — beads glued on.
   *
   * A wound has no geometry of its own now. It is a handful of capsules handed
   * to the shader the body is already drawn with — see wounds.ts — so it
   * follows the silhouette because it is evaluated *on* the silhouette, it
   * skins along with the surface it is on, it cannot z-fight or float, and it
   * adds no draw call.
   *
   * Each kind of blow leaves its own signature. That is the part a player reads
   * without knowing they are reading it — a bite is not a smaller claw.
   *
   * All of it is laid out in the nominal 1.72 m body's space rather than in
   * world space, and that is not a convenience. The cast runs from 1.62 m to
   * 1.79 m, so a mark placed in world metres lands a centimetre or two off on a
   * short man — nothing on a hand-sized rake, everything on a bite, where the
   * jaw has to find a five-centimetre throat. Working in the frame TORSO
   * describes means the numbers below can be read straight off it, and they
   * are; `cut` and `mark` put them on the man actually wearing them.
   */
  private openWound(blow: BlowKind, at?: THREE.Vector3) {
    // Local direction to whatever did it. fallX/fallZ point *away* from it.
    const nx = -this.fallX
    const nz = -this.fallZ
    // Across the body, on the ground plane: the axis a swipe travels along and
    // a jaw closes across.
    const ax = -nz
    const az = nx

    // How high up the body it landed, in the body's own units. A tiger's paw
    // arrives wherever the swing was aimed; its jaws go for the throat, which
    // is why a bite is floored well above where the swipe that missed it was.
    let hy = clamp(at ? (at.y - this.pos.y) / this.scale : 1.28, 0.5, 1.66)
    if (blow === 'bite') hy = clamp(hy, 1.34, 1.56)
    // Out to the surface facing the blow, on the section that is actually there
    // at that height. A constant here cannot work: the ribs are 16 cm from the
    // spine across and 11 cm through, and the throat is 5 — work at the chest
    // radius and a bite lands in mid-air beside the neck, work at the throat
    // radius and a rake is buried inside the ribcage.
    const r = sectionR(hy, nx, nz)
    const cx = nx * r
    const cz = nz * r

    if (blow === 'claw') {
      // Three or four rakes, parallel, running diagonally across the body —
      // claws arrive as a set and they arrive at an angle. One capsule each,
      // which is the shape a drawn claw makes and the reason for capsules at
      // all: a rake is a line, and a line is two points and a radius.
      const rakes = 3 + (this.rng.chance(0.45) ? 1 : 0)
      // Between the claws of one paw. Measured along the skin, not in angle —
      // 4 cm is 4 cm whether it lands on a chest or a forearm.
      const gap = 0.043
      // Which way the paw was travelling. Both are equally likely and the
      // difference is obvious once there are two bodies next to each other.
      const lift = this.rng.chance(0.5) ? 1 : -1
      // Off the horizontal. A swipe that lands dead level reads as a printed
      // barcode; a tiger's arrives on the diagonal and drags as the man turns.
      const phi = lift * this.rng.range(0.5, 1.0)
      const cp = Math.cos(phi)
      const sp = Math.sin(phi)
      for (let k = 0; k < rakes; k++) {
        const off = (k - (rakes - 1) / 2) * gap + this.rng.range(-0.005, 0.005)
        // Uneven, because the outer claws of a paw never travel as far as the
        // middle ones and four identical strokes read as a stamp.
        const len = this.rng.range(0.17, 0.29)
        // Perpendicular offset for this claw, then half the stroke either way.
        const s0 = -cp * len * 0.5 - sp * off
        const u0 = -sp * len * 0.5 + cp * off
        const s1 = cp * len * 0.5 - sp * off
        const u1 = sp * len * 0.5 + cp * off
        // Arc length to angle. Half the arc sets how far the chord sags, and
        // therefore how far out both ends have to sit to put it back.
        const half = Math.abs(s1 - s0) * 0.5 / r
        const bulge = 1 / Math.max(0.6, Math.cos(half))
        this.surfaceAt(s0 / r, hy + u0, nx, nz, ax, az, bulge, WOUND_AT)
        this.surfaceAt(s1 / r, hy + u1, nx, nz, ax, az, bulge, RUN_AT)
        this.cut(WOUND_AT, RUN_AT, this.rng.range(0.009, 0.014), 1)
        // Blood leaves from the low end, whichever end that is.
        this.mark(u0 < u1 ? WOUND_AT : RUN_AT)
      }
    } else {
      // Two arcs, upper and lower jaw, closed on the throat. The noise on the
      // capsule edge does the punctures for free: at this radius it breaks the
      // arc into a row of deep bites with shallow ground between them, which is
      // what a set of canines leaves and what drawing four separate holes at
      // this scale would cost four more slots to say.
      // The gape between the jaws, and how far round the head is turned. Both
      // vary, because two bites that land in the same place on the same body
      // should not stack into one symmetrical brand.
      const gape = this.rng.range(0.045, 0.075)
      const tilt = this.rng.range(-0.25, 0.25)
      for (const jaw of [-1, 1]) {
        // The upper jaw reaches further round than the lower one — that is how
        // a skull is built, and it is the reason a bite mark is two arcs of
        // different length rather than a pair of brackets.
        const arc = jaw > 0 ? 0.92 : 0.7
        const bulge = 1 / Math.cos(arc * 0.5)
        const y = hy + jaw * gape
        this.surfaceAt(tilt - arc * 0.5, y - 0.008, nx, nz, ax, az, bulge, WOUND_AT)
        this.surfaceAt(tilt + arc * 0.5, y + 0.008, nx, nz, ax, az, bulge, RUN_AT)
        this.cut(WOUND_AT, RUN_AT, 0.021, 1)
      }
      // And the mess the jaw makes around what it closed on. Pulled in most of
      // the way to the axis and sized off the section, so it scales itself: on
      // a throat it swallows the whole neck, which is what a jaw closing round
      // one does, and on a chest the same sphere is still a hand's width short
      // of coming out of the back.
      const cr = sectionR(hy, nx, nz)
      WOUND_AT.set(nx * cr * 0.3, hy, nz * cr * 0.3)
      this.cut(WOUND_AT, WOUND_AT, cr * 0.95 + 0.04, 0.36)
      WOUND_AT.set(nx * cr, hy - 0.05, nz * cr)
      this.mark(WOUND_AT)
    }

    // Short, because it just happened. It grows on its own from here.
    this.bleedRun(0.09)

    // A light overall soak on top, so a man who has taken a lot is dressed in a
    // darker shirt than one who has taken a little. Deliberately weak — the
    // wounds carry the story now, and dyeing the whole garment on top of them
    // just flattens the contrast that makes them read.
    //
    // This used to be a lerp of the palette toward a dried-blood colour, which
    // worked when the palette *was* the surface. These bodies have authored
    // albedo maps and no palette to lerp, so the soak is a uniform the same two
    // shaders already carry the wounds in — see wounds.ts. Same look, and it no
    // longer costs a walk over every vertex on every hit.
    this.soak(clamp(1 - this.health / this.maxHealth, 0, 1))

    // Hand the spray back the place it should be leaving from. The blood the
    // game throws has to come off the opening, not out of the middle of the man
    // — it is the same point, and it is the difference between an arterial jet
    // and a red cloud with a villager standing in it.
    this.body.updateWorldMatrix(true, false)
    this.lastCut.set(cx, hy, cz)
    SOAK_AT.set(cx * this.scale, hy * this.scale, cz * this.scale)
    this.woundPos.copy(this.body.localToWorld(SOAK_AT))
  }

  /**
   * Blood on the whole body, and the wet sheen that goes with it.
   *
   * Wet is the one property that separates blood from a brown patch. Nothing
   * here can vary roughness per texel, but a badly cut man is mostly blood by
   * area, so pulling every material a fifth of the way toward a sheen is close
   * enough and costs one float each.
   */
  private soak(amount: number) {
    this.wounds.uSoak.value = Math.max(this.wounds.uSoak.value, amount * 0.5)
    for (let i = 0; i < this.mats.length; i++) {
      this.mats[i]!.roughness = this.rough[i]! * (1 - amount * 0.22)
    }
  }

  /**
   * One capsule, from the nominal body's frame into this one's.
   *
   * Both ends and the radius scale with the man's height, and x and z flip:
   * the assets face +Z and are turned half a turn to face the game's -Z, and
   * the shader reads the mesh's own untransformed positions. See body.ts.
   */
  private cut(a: THREE.Vector3, b: THREE.Vector3, r: number, depth: number) {
    const s = this.scale
    toMesh(CUT_A.copy(a), s)
    toMesh(CUT_B.copy(b), s)
    cutWound(this.wounds, CUT_A.x, CUT_A.y, CUT_A.z, CUT_B.x, CUT_B.y, CUT_B.z, r * s, depth)
  }

  /**
   * Register a place blood is leaving from, in the nominal body's space.
   *
   * Only a blow leaves one. If the run-down streaks registered as sources too,
   * each pass would seed the next one further down and the body would be solid
   * red inside a couple of seconds.
   */
  private mark(p: THREE.Vector3) {
    const s = this.scale
    toMesh(CUT_A.copy(p), s)
    const slot = startRun(this.wounds, CUT_A.x, CUT_A.y, CUT_A.z, this.rng.range(0.012, 0.019) * s)
    this.runs[this.runNext] = { x: p.x, y: p.y, z: p.z, slot, len: 0 }
    this.runNext = (this.runNext + 1) % RUN_SLOTS
  }

  /**
   * Let what has already been spilt run downhill.
   *
   * Blood that appears all at once and then holds still is paint. Calling this
   * again as they bleed out is what turns a set of cuts into a body that is
   * still losing blood: each pass drags the bottom of every run a little
   * further down, so the streaks lengthen over the seconds after the hit rather
   * than arriving finished.
   */
  private bleedRun(reach = 0.16) {
    for (const run of this.runs) {
      if (!run || reach <= run.len) continue
      run.len = reach
      const y = run.y - reach
      // Follow the body in. A man is wider at the chest than at the waist, so a
      // run that drops straight down in a straight line is off his surface
      // inside a hand's length and hanging in front of his belt. Closing it
      // toward the axis by however much the section has closed keeps it on him
      // — and because both radii are measured along the same direction, the
      // arbitrary length of that direction cancels out of the ratio.
      const k = sectionR(y, run.x, run.z) / Math.max(1e-4, sectionR(run.y, run.x, run.z))
      toMesh(CUT_A.set(run.x * k, y, run.z * k), this.scale)
      extendRun(this.wounds, run.slot, CUT_A.x, CUT_A.y, CUT_A.z, 0.46)
    }
  }

  private die(amount: number) {
    this.alive = false
    // Give the hut back before the state changes, or the slot is held by a
    // corpse until the pool recycles it.
    this.releaseHut()
    this.state = 'dead'
    this.deathTimer = 0
    this.vel.set(0, 0, 0)
    this.health = 0
    // Keep pumping for a couple of seconds. The game turns each pulse into a
    // spray, which is what an opened throat looks like and one burst does not.
    this.bleedTimer = HUMAN.bleedDuration
    this.bleedNext = 0
    this.poolNext = 0.5
    this.poolCount = 0
    this.poolMax = 4

    // The blow that killed him is not the blow that grazed him, and up to here
    // nothing has said so — `openWound` cuts the same three rakes whether the
    // man walks away from them or not, so a corpse was arriving on the ground
    // carrying a flesh wound. Flood the area round what landed last with one
    // wide capsule, shallow enough that it can only ever reach the staining end
    // of the ramp, and start the runs long instead of letting them crawl out of
    // him over the next two seconds. A man who is already dead is already
    // emptying; the streaks should be there when he lands, not catch him up.
    const c = this.lastCut
    CUT_C.set(c.x * 0.9, c.y - 0.09, c.z * 0.9)
    this.cut(c, CUT_C, 0.105, 0.34)
    this.mark(c)
    this.bleedRun(0.26)
    this.soak(0.55)

    // One seed per slack joint, drawn once. Two corpses with the same seed
    // would be the same corpse, and this pool is only twenty slots deep.
    this.jitter = []
    for (let i = 0; i < 6; i++) this.jitter.push(this.rng.range(-1, 1))

    // How they go down. A man whose heart stops folds where he stands; a man
    // hit by three hundred kilos of tiger leaves the ground, and the only lever
    // left over one authored fall is how fast it plays — 1.8 s for a man who
    // sagged, under a second for one who was knocked off his feet. The clip is
    // a slow, deliberate lowering (it is a get-up run backwards), so even the
    // gentle end of that is faster than it was captured.
    //
    // Tied to the clip's 4.6 s length, so retiming the clip retunes these.
    const force = clamp((amount - 30) / 90, 0, 1)
    this.motion?.play('collapse', 0.1, {
      once: true,
      rate: (2.6 + force * 2.2) * (1 + this.jitter[0]! * 0.08),
    })
    // The flinch lean was the last thing the live body had; the clip owns the
    // whole pose from here, and a leftover 20-degree tilt on the group above it
    // is a man falling over sideways off a ledge that isn't there.
    this.body.rotation.set(0, 0, 0)
    this.body.position.set(0, 0, 0)
    this.setRifleVisible(false)
  }

  // ---------------------------------------------------------------- feeding
  /** Can the tiger still get something out of this body? */
  get feedable(): boolean {
    return !this.alive && !this.fed && this.group.visible && this.deathTimer > 0.35
  }

  /** Consume the corpse. It collapses further and stops being worth anything. */
  feed() {
    this.fed = true
    // A fed-on body has been opened up, not tidily killed. Tear the torso from
    // several directions at once with something much blunter than a claw — a
    // carcass is not a set of neat lines, it is a hole — and then let all of it
    // run. The difference between a corpse and a carcass is that a carcass is
    // mostly blood.
    for (let i = 0; i < 4; i++) {
      const a = this.rng.range(0, Math.PI * 2)
      const y0 = this.rng.range(1.0, 1.42)
      const y1 = y0 + this.rng.range(-0.12, 0.12)
      const dx = Math.cos(a)
      const dz = Math.sin(a)
      const r0 = sectionR(y0, dx, dz) * 0.86
      const r1 = sectionR(y1, dx, dz) * 0.86
      WOUND_AT.set(dx * r0, y0, dz * r0)
      RUN_AT.set(dx * r1, y1, dz * r1)
      this.cut(WOUND_AT, RUN_AT, this.rng.range(0.055, 0.085), 1)
      WOUND_AT.set(dx * r0, Math.min(y0, y1), dz * r0)
      this.mark(WOUND_AT)
    }
    // Straight to full length. The tiger has been at this for a while; nothing
    // about it should look like it started a moment ago.
    this.bleedRun(0.42)
    this.soak(1)
    // And it goes on emptying onto the ground under it, further and wider than
    // a clean kill ever does.
    this.poolMax = 8
    this.poolNext = 0
    // Torn apart: sinks flatter and stops registering on the radar.
    this.deathTimer = Math.max(this.deathTimer, HUMAN.corpseLife * 0.72)
  }

  terrify(duration: number, stagger: number) {
    if (!this.alive) return
    this.fearTimer = Math.max(this.fearTimer, duration)
    this.staggerTimer = Math.max(this.staggerTimer, stagger)
    this.alerted = true
    this.awareness = 1.2
    this.state = 'panic'
  }

  alertTo(_tigerPos: THREE.Vector3) {
    if (!this.alive || this.alerted) return
    this.alerted = true
    this.awareness = Math.max(this.awareness, 1.0)
    this.state = this.kind === 'hunter' ? 'hunt' : 'flee'
  }

  // --------------------------------------------------------------- update
  update(
    dt: number,
    tigerPos: THREE.Vector3,
    tigerVisibility: number,
    tigerNoise: number,
    world: World,
    waveScale: number,
  ) {
    this.pendingShot = null
    this.pendingShout = false
    this.bleedPulse = false
    this.poolPulse = false
    // Eyes and eyebrows are two of this body's six draw calls, and the camera
    // rides the tiger, so the distance the AI already works in is the one that
    // decides whether they are worth submitting. See DETAIL in body.ts.
    this.avatar?.setDetail(this.group.position.distanceTo(tigerPos))
    // The hit tell used to be an emissive of 0.7 red over the whole body for a
    // third of a second, which lit a man from the inside: at night he was the
    // brightest object in the village, and by day he flushed scarlet head to
    // foot including his hat. Nothing about a man being clawed makes him glow.
    //
    // What is left has to be judged against these men rather than in the
    // abstract, because they are *dark*: dark skin, dark cloth, an albedo of
    // about 0.03 linear, which under village light leaves about 0.04 coming off
    // them. An emissive is added to that, so 0.13 is not a tint on a body, it is
    // three times the body, and every man who took a claw went uniformly the
    // colour of the glow from his hat to his sandals — which is most of what
    // "he goes weird and red when you hit him" was. Half of what he already
    // reflects, gone in a tenth of a second, is a flicker; anything more is a
    // repaint. The actual read comes from the wound that just opened and the
    // spray off it.
    const wasFlashing = this.hurtFlash > 0
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 6)
    if (wasFlashing) {
      const flash = this.hurtFlash * this.hurtFlash * 0.022
      for (const m of this.mats) m.emissive.setRGB(flash, flash * 0.22, flash * 0.16)
    }
    this.leanX = damp(this.leanX, 0, 7, dt)
    this.leanZ = damp(this.leanZ, 0, 7, dt)

    if (!this.alive) {
      this.updateDeath(dt)
      return
    }

    this.fearTimer = Math.max(0, this.fearTimer - dt)
    this.staggerTimer = Math.max(0, this.staggerTimer - dt)

    this.updatePerception(dt, tigerPos, tigerVisibility, tigerNoise, world)
    this.updateBrain(dt, tigerPos, world, waveScale)
    this.updateMotion(dt, world)
    this.lookAt.copy(tigerPos)
    // Placed before the pose, not after it: the aim solve reads bone world
    // matrices, and those hang off this group, so moving the man afterwards
    // would put his hands where he was standing last frame.
    this.syncTransform()
    this.animate(dt)
  }

  private updatePerception(
    dt: number,
    tigerPos: THREE.Vector3,
    visibility: number,
    noise: number,
    world: World,
  ) {
    const cfg = this.cfg
    const dx = tigerPos.x - this.pos.x
    const dz = tigerPos.z - this.pos.z
    const dist = Math.hypot(dx, dz)

    let gain = 0

    // Hearing: loud movement gives you away regardless of cover.
    if (dist < noise) gain += (1 - dist / noise) * 1.4

    // Sight: needs range, facing, line of sight, and the tiger not concealed.
    if (dist < cfg.sightRange * visibility + 3) {
      const fx = -Math.sin(this.yaw)
      const fz = -Math.cos(this.yaw)
      const dot = (dx * fx + dz * fz) / (dist || 1)
      const inFov = Math.acos(clamp(dot, -1, 1)) < cfg.sightFov
      if (inFov && !world.losBlocked(this.pos.x, this.pos.z, tigerPos.x, tigerPos.z)) {
        const closeness = 1 - dist / (cfg.sightRange || 1)
        gain += closeness * 2.6 * visibility
      }
    }

    if (gain > 0) {
      this.awareness = Math.min(1.6, this.awareness + (gain * dt) / HUMAN.alertTime)
    } else {
      this.awareness = Math.max(0, this.awareness - dt * 0.35)
      if (this.awareness <= 0.05) this.alerted = false
    }

    if (this.awareness >= 1 && !this.alerted) {
      this.alerted = true
      this.pendingShout = true
      if (!this.screamed) this.screamed = true
    }
  }

  private updateBrain(dt: number, tigerPos: THREE.Vector3, world: World, waveScale: number) {
    const cfg = this.cfg
    const dist = Math.hypot(tigerPos.x - this.pos.x, tigerPos.z - this.pos.z)
    this.repathTimer -= dt
    this.hideCooldown -= dt
    this.hideTimeout -= dt

    // Holding a hut outranks everything else. A roar is meant to scatter people
    // in the open; it is not meant to empty the huts, because emptying the huts
    // is what the tiger has to walk through a door to do.
    if (this.hideHut) this.state = 'hide'
    else if (this.fearTimer > 0) this.state = 'panic'
    else if (this.alerted) this.state = this.kind === 'hunter' ? 'hunt' : 'flee'
    else if (this.awareness > 0.35) this.state = 'suspicious'
    else if (this.state !== 'wander') this.state = 'wander'

    // Anyone already running and inclined to hide picks a door as soon as there
    // is one worth picking. Failing to find one is the expensive case, so it is
    // the one on a cooldown.
    if (
      this.willHide && !this.hideHut && this.hideCooldown <= 0 &&
      (this.state === 'flee' || this.state === 'panic')
    ) {
      if (this.claimHut(world, tigerPos)) this.state = 'hide'
    }

    switch (this.state) {
      case 'wander': {
        if (this.repathTimer <= 0) {
          this.repathTimer = this.rng.range(2.5, 6)
          this.target.copy(world.randomOpenPoint(4, 74, this.rng))
        }
        this.moveToward(this.target, cfg.wanderSpeed, dt)
        break
      }

      case 'suspicious': {
        // Stop, turn toward the noise, scan.
        this.vel.x = damp(this.vel.x, 0, 6, dt)
        this.vel.z = damp(this.vel.z, 0, 6, dt)
        this.faceToward(tigerPos, dt, 3.5)
        break
      }

      case 'flee': {
        // Run away from the tiger, biased toward firelight (villagers feel safe there).
        if (this.repathTimer <= 0) {
          this.repathTimer = 0.7
          const away = new THREE.Vector3(this.pos.x - tigerPos.x, 0, this.pos.z - tigerPos.z)
          if (away.lengthSq() < 0.01) away.set(1, 0, 0)
          away.normalize().multiplyScalar(22)
          let dest = new THREE.Vector3(this.pos.x + away.x, 0, this.pos.z + away.z)
          let bestFire: THREE.Vector3 | null = null
          let bestScore = -Infinity
          for (const f of world.campfires) {
            const dFire = Math.hypot(f.x - this.pos.x, f.z - this.pos.z)
            const fireFromTiger = Math.hypot(f.x - tigerPos.x, f.z - tigerPos.z)
            const score = fireFromTiger - dFire * 0.6
            if (score > bestScore) { bestScore = score; bestFire = f }
          }
          if (bestFire && bestScore > 8) dest = dest.lerp(bestFire, 0.55)
          this.target.set(dest.x, 0, dest.z)
        }
        this.moveToward(this.target, HUMAN.villager.fleeSpeed, dt)
        // Look back over the shoulder at what's chasing them.
        if (dist < 14) this.faceAwayFrom(tigerPos, dt, 7)
        break
      }

      case 'hide': {
        const hut = this.hideHut!

        // Never got there. Stop holding a door open for someone who cannot
        // reach it and go back to running like everybody else.
        if (this.hideStage < 2 && this.hideTimeout <= 0) {
          this.releaseHut()
          this.hideCooldown = 5
          this.state = this.fearTimer > 0 ? 'panic' : 'flee'
          break
        }

        // Flushed. Being cornered in a room with a tiger is worse than the open
        // ground they gave up to get here, and they work that out all at once.
        if (this.hideStage >= 2 && this.hideStage < 4) {
          const tdx = tigerPos.x - this.pos.x
          const tdz = tigerPos.z - this.pos.z
          if (tdx * tdx + tdz * tdz < HUT.flushRadius * HUT.flushRadius) {
            this.hideStage = 4
            this.fearTimer = Math.max(this.fearTimer, HUT.flushPanic)
            this.pendingShout = true
          }
        }

        // ...or the thing they were running from has gone, and they come out on
        // their own. Without this the village fills its huts once and the rest
        // of the round is played in an empty clearing.
        if (this.hideStage === 3 && !this.alerted && this.fearTimer <= 0 && dist > 24) {
          this.hideStage = 4
        }

        const way = this.hideStage <= 0 ? hut.out : this.hideStage >= 4 ? hut.out : this.hideStage === 1 ? hut.in : hut.hide
        const d = Math.hypot(way.x - this.pos.x, way.z - this.pos.z)

        if (this.hideStage === 3) {
          // Pressed into the dark at the back, watching the doorway, because
          // the doorway is the only thing that can happen to them now.
          this.vel.x = damp(this.vel.x, 0, 8, dt)
          this.vel.z = damp(this.vel.z, 0, 8, dt)
          this.faceToward(hut.out, dt, 4)
        } else {
          // No sprinting indoors: there is nowhere to sprint to, and a man at
          // full flee speed crosses one of these rooms in half a second.
          const indoors = this.hideStage >= 2
          this.moveToward(way, indoors ? HUT.insideSpeed : HUMAN.villager.fleeSpeed, dt)
        }

        if (this.hideStage < 3 && d < 0.55) this.hideStage++
        else if (this.hideStage === 4 && d < 0.9) {
          this.releaseHut()
          // Long enough that they run somewhere rather than straight back in.
          this.hideCooldown = HUT.flushPanic
          this.state = this.fearTimer > 0 ? 'panic' : 'wander'
          this.repathTimer = 0
        }
        break
      }

      case 'hunt': {
        const h = HUMAN.hunter
        this.faceToward(tigerPos, dt, 4.5)
        // Hold at a firing stand-off; close in if the tiger breaks away.
        const ideal = h.fireRange * 0.6
        if (dist > h.fireRange * 0.95) {
          this.moveToward(tigerPos, h.chaseSpeed, dt)
        } else if (dist < ideal * 0.5) {
          // Back off, keep the rifle useful.
          const away = new THREE.Vector3(this.pos.x - tigerPos.x, 0, this.pos.z - tigerPos.z).normalize()
          this.target.set(this.pos.x + away.x * 8, 0, this.pos.z + away.z * 8)
          this.moveToward(this.target, h.chaseSpeed * 0.8, dt)
        } else {
          this.vel.x = damp(this.vel.x, 0, 8, dt)
          this.vel.z = damp(this.vel.z, 0, 8, dt)
        }

        this.fireTimer -= dt
        const clear = !world.losBlocked(this.pos.x, this.pos.z, tigerPos.x, tigerPos.z)
        if (dist < h.fireRange && clear && this.staggerTimer <= 0) {
          this.aimTimer += dt
          if (this.fireTimer <= 0 && this.aimTimer >= h.aimTime) {
            this.fireTimer = h.fireInterval * this.rng.range(0.8, 1.25)
            this.aimTimer = 0
            this.fire(tigerPos, dist, waveScale)
          }
        } else {
          this.aimTimer = Math.max(0, this.aimTimer - dt * 2)
        }
        break
      }

      case 'panic': {
        // Blind terror: sprint in a wobbling line away from the tiger.
        if (this.repathTimer <= 0) {
          this.repathTimer = 0.45
          const a = Math.atan2(this.pos.z - tigerPos.z, this.pos.x - tigerPos.x) + this.rng.range(-0.9, 0.9)
          this.target.set(this.pos.x + Math.cos(a) * 18, 0, this.pos.z + Math.sin(a) * 18)
        }
        const panicSpeed = (this.kind === 'hunter' ? HUMAN.hunter.chaseSpeed : HUMAN.villager.fleeSpeed) * 1.12
        this.moveToward(this.target, this.staggerTimer > 0 ? 0.4 : panicSpeed, dt)
        break
      }

      default:
        break
    }
  }

  /**
   * Pick a door and take a slot behind it.
   *
   * The score is the walk to the doorstep plus a penalty for doors near the
   * tiger, so that a hut twenty metres off in clear air beats one ten metres
   * away that means running past the thing chasing you. Huts the tiger is
   * already standing on are out entirely — running into a room with a tiger in
   * it is not hiding, it is queueing.
   */
  private claimHut(world: World, tigerPos: THREE.Vector3): boolean {
    this.hideCooldown = 0.6
    let best: Hut | null = null
    let bestScore = Infinity
    for (const h of world.huts) {
      if (h.occupants >= h.capacity) continue
      const d = Math.hypot(h.out.x - this.pos.x, h.out.z - this.pos.z)
      if (d > HUT.seekRange) continue
      if (Math.hypot(h.x - tigerPos.x, h.z - tigerPos.z) < HUT.tigerClear) continue
      const doorFromTiger = Math.hypot(h.out.x - tigerPos.x, h.out.z - tigerPos.z)
      const score = d + Math.max(0, 26 - doorFromTiger) * 1.5
      if (score < bestScore) {
        bestScore = score
        best = h
      }
    }
    if (!best) return false
    best.occupants++
    this.hideHut = best
    this.hideStage = 0
    this.hideTimeout = 4 + bestScore / HUMAN.villager.fleeSpeed
    return true
  }

  /** Give the slot back. Safe to call on someone who never had one. */
  private releaseHut() {
    if (!this.hideHut) return
    this.hideHut.occupants = Math.max(0, this.hideHut.occupants - 1)
    this.hideHut = null
  }

  private fire(tigerPos: THREE.Vector3, dist: number, waveScale: number) {
    const h = HUMAN.hunter
    const origin = new THREE.Vector3(this.pos.x, this.pos.y + HUMAN.eyeHeight, this.pos.z)
    const dir = new THREE.Vector3(
      tigerPos.x - origin.x,
      tigerPos.y + 1.2 - origin.y,
      tigerPos.z - origin.z,
    ).normalize()

    // Aim error grows with range; a sprinting tiger is a harder target.
    const spread = h.spread * (1 + dist / h.fireRange)
    const miss = this.rng.next() < clamp(spread * 6, 0.08, 0.6)
    if (miss) {
      dir.x += this.rng.range(-spread, spread) * 5
      dir.y += this.rng.range(-spread, spread) * 3
      dir.z += this.rng.range(-spread, spread) * 5
      dir.normalize()
    }
    this.pendingShot = {
      origin,
      dir,
      damage: h.damage * (1 + waveScale),
      hit: !miss,
    }
    // Recoil kick on the rifle arm.
    this.staggerTimer = Math.max(this.staggerTimer, 0.12)
  }

  private moveToward(dest: THREE.Vector3, speed: number, dt: number) {
    if (this.staggerTimer > 0) speed *= 0.25
    // A man who has lost most of his blood does not run at his healthy speed. The
    // `wounded` clip staggers along at 0.8 m/s and playback rate is clamped, so
    // without this a half-dead villager at wander speed drags his feet across the
    // ground — and there is no reading of the situation where he ought to be
    // keeping up anyway.
    speed *= 1 - 0.45 * clamp(1 - this.health / this.maxHealth, 0, 1) ** 2
    const dx = dest.x - this.pos.x
    const dz = dest.z - this.pos.z
    const d = Math.hypot(dx, dz)
    if (d < 0.4) {
      this.vel.x = damp(this.vel.x, 0, 8, dt)
      this.vel.z = damp(this.vel.z, 0, 8, dt)
      return
    }
    const wantX = (dx / d) * speed
    const wantZ = (dz / d) * speed
    this.vel.x = damp(this.vel.x, wantX, 8, dt)
    this.vel.z = damp(this.vel.z, wantZ, 8, dt)
    if (this.state !== 'hunt') {
      const targetYaw = Math.atan2(-this.vel.x, -this.vel.z)
      this.yaw = angleDamp(this.yaw, targetYaw, 8, dt)
    }
  }

  private faceToward(p: THREE.Vector3, dt: number, rate: number) {
    const targetYaw = Math.atan2(-(p.x - this.pos.x), -(p.z - this.pos.z))
    this.yaw = angleDamp(this.yaw, targetYaw, rate, dt)
  }
  private faceAwayFrom(p: THREE.Vector3, dt: number, rate: number) {
    const targetYaw = Math.atan2(p.x - this.pos.x, p.z - this.pos.z)
    this.yaw = angleDamp(this.yaw, targetYaw, rate, dt)
  }

  private updateMotion(dt: number, world: World) {
    this.pos.x += this.vel.x * dt
    this.pos.z += this.vel.z * dt
    const r = world.resolve(this.pos.x, this.pos.z, HUMAN.radius, this.pos.y + 1)
    this.pos.x = r.x
    this.pos.z = r.z
    if (r.hit) {
      // Bumped a wall — repath next tick instead of grinding against it.
      this.repathTimer = Math.min(this.repathTimer, 0.15)
    }
    this.pos.y = terrainHeight(this.pos.x, this.pos.z)
  }

  // ------------------------------------------------------------ animation
  /**
   * Pick a clip, run it at the pace the man is actually travelling, and lay the
   * overlays on top.
   *
   * There used to be a solved gait here — feet pinned to the ground, pelvis
   * dropped to whatever height the reach allowed, hips and knees solved from
   * that. It was the right answer to the problem it had, which was that a
   * hand-authored walk on a procedural rig slides. Motion capture does not have
   * that problem, and it has the one thing the solver could never produce:
   * weight. What is left of the old reasoning is the pace matching, because
   * mocap slides too the moment you play a 1.9 m/s walk on a man moving at 1.2
   * — see `Motion.play`.
   *
   * Everything past the clip is an overlay, and overlays are world-axis
   * rotations rather than Euler channels. The old rig's bone axes were chosen
   * so `rotation.x` on an arm meant something; a mocap rig's are whatever the
   * solver landed on, so a head-turn written as `head.rotation.y` comes out as
   * a diagonal. See `twist` in body.ts.
   */
  private animate(dt: number) {
    const motion = this.motion
    const avatar = this.avatar
    if (!motion || !avatar) return

    const speed = Math.hypot(this.vel.x, this.vel.z)
    const hurt = clamp(1 - this.health / this.maxHealth, 0, 1)
    const aiming = this.kind === 'hunter' && (this.state === 'hunt' || this.aimTimer > 0.1)
    const terrified = this.state === 'panic' || (this.state === 'flee' && speed > 3)
    this.aimBlend = damp(this.aimBlend, aiming ? 1 : 0, 7, dt)
    // A man with a rifle up is looking down it, so the head-track goes away as
    // the aim comes in rather than fighting it.
    this.lookBlend = damp(this.lookBlend, this.alerted ? 1 - this.aimBlend : 0, 5, dt)

    let clip: ClipName
    if (speed > 0.4) {
      // Wounded outranks the rest, because a man limping is worth reading from
      // across the village and it is the tell that this one is nearly done. The
      // speed gate is the clip's own pace times the rate ceiling: past that it
      // cannot be played fast enough to keep its feet on the ground, and a bad
      // wound turning into a slide reads as a bug rather than as a wound.
      if (hurt > 0.55 && speed < 1.5) clip = 'wounded'
      else if (speed > 3.2) clip = 'run'
      else if (terrified) clip = 'flee'
      else if (this.kind === 'hunter' && this.alerted && speed < 1.4) clip = 'sneak'
      else clip = 'walk'
    } else if (terrified) {
      clip = 'flee'
    } else if (this.alerted || this.kind === 'hunter') {
      clip = 'idle'
    } else {
      // Two ambient stands, split by seed rather than rolled, so a man doesn't
      // change his habits every time he stops walking. Half the village is
      // busy with something; the other half is standing about.
      clip = this.chores ? 'chores' : 'idle2'
    }
    const pace = this.paces[clip]
    motion.play(clip, 0.24, {
      rate: pace ? clamp(speed / pace, 0.6, 1.7) : 1,
    })
    motion.update(dt)

    // ---- overlays, on top of whatever the clip just wrote.
    if (this.lookBlend > 0.01) this.poseLook(this.lookBlend)
    if (this.aimBlend > 0.01) this.poseAim(this.aimBlend)

    // The whipped-away lean from the last blow. Applied to the whole body
    // rather than the spine so the legs go with it — a struck man folds, he
    // doesn't bow politely from the waist. Shallower than it was, because the
    // clips now carry weight of their own and the two used to add up to a
    // stagger the size of a fall.
    this.body.rotation.x = this.leanX * 0.34
    this.body.rotation.z = this.leanZ * 0.34

    this.placeRifle()
  }

  /**
   * Head and neck turned onto whatever this man is watching.
   *
   * Split roughly a third to the neck and two thirds to the head: turning the
   * whole thing at the head is an owl, and turning it at the neck swings the
   * face off the shoulders. Clamped well inside a real range of motion, because
   * past that a man turns his body, and his body is the AI's business.
   */
  private poseLook(k: number) {
    const rig = this.avatar!.rig
    const dx = this.lookAt.x - this.pos.x
    const dz = this.lookAt.z - this.pos.z
    const flat = Math.hypot(dx, dz)
    let turn = Math.atan2(-dx, -dz) - this.yaw
    turn = ((turn + Math.PI * 3) % (Math.PI * 2)) - Math.PI
    turn = clamp(turn, -1.15, 1.15) * k
    // Down at a tiger, which is low: the eye line is about 1.5 m up and the
    // thing being watched is a metre off the ground and often much closer than
    // it is far, so this is a real angle and not a rounding error.
    const drop = clamp(
      Math.atan2((this.lookAt.y + 0.7) - (this.pos.y + 1.5 * this.scale), Math.max(flat, 0.4)),
      -0.55, 0.4,
    ) * k
    twist(rig.neck, UP, turn * 0.35)
    twist(rig.head, UP, turn * 0.65)
    RIGHT.set(Math.cos(this.yaw + turn), 0, -Math.sin(this.yaw + turn))
    twist(rig.head, RIGHT, drop)
  }

  /**
   * Rifle up: both hands on the weapon, solved rather than posed.
   *
   * The hands are put where the rifle is, not the other way round, which is the
   * opposite of what this used to do and is the only version that survives a
   * mocap clip underneath. An authored arm pose fights whatever the clip has
   * the shoulder doing; a target position does not care.
   */
  private poseAim(k: number) {
    const rig = this.avatar!.rig
    const s = this.scale
    // The bones are about to be read, and their world matrices are otherwise a
    // frame behind — which on an arm swinging through a walk cycle is visible.
    this.group.updateMatrixWorld(true)
    // Body-local, then out to the world, so the flinch lean carries the hands
    // with it instead of leaving them behind in the air. The grip is the same
    // point `placeRifle` puts the weapon at, so the two cannot drift apart; the
    // fore-end is measured up the barrel from it.
    this.body.localToWorld(GRIP.copy(AIMED_POS).multiplyScalar(s))
    this.body.localToWorld(FORE.set(0.015 * s, 1.405 * s, -0.475 * s))
    this.body.getWorldQuaternion(Q_AIM)
    // Where each elbow goes. The trigger elbow rides out and up off the ribs;
    // the support elbow tucks down under the fore-end. Get these the wrong way
    // round and the man is holding the rifle like a tray.
    POLE.set(1, 0.55, 0.1).applyQuaternion(Q_AIM)
    reach(rig.arms[1]!, GRIP, POLE, k)
    POLE.set(-0.35, -1, 0.1).applyQuaternion(Q_AIM)
    reach(rig.arms[0]!, FORE, POLE, k)
  }

  /**
   * Put the rifle where the hands are, or on the back when they are not on it.
   *
   * The aimed position is the same body-local line `poseAim` reached the hands
   * to, so the two cannot drift apart. Orientation comes from the aim rather
   * than from the wrist: a muzzle that followed the hand's roll would wander
   * off target every time the arm swung.
   */
  private placeRifle() {
    const rifle = this.rifle
    if (!rifle || !rifle.visible) return
    const k = this.aimBlend
    // Slung across the back is the resting place: a sling needs no hands, leaves
    // the walk alone, and still says "armed" from the front.
    rifle.position.lerpVectors(SLUNG_POS, AIMED_POS, k).multiplyScalar(this.scale)
    rifle.rotation.set(
      THREE.MathUtils.lerp(SLUNG_ROT.x, AIMED_ROT.x, k),
      THREE.MathUtils.lerp(SLUNG_ROT.y, AIMED_ROT.y, k),
      THREE.MathUtils.lerp(SLUNG_ROT.z, AIMED_ROT.z, k),
    )
  }

  private updateDeath(dt: number) {
    this.deathTimer += dt

    // Arterial pulses for the first couple of seconds. The game reads the flag
    // and sprays from woundPos; this only decides when.
    if (this.bleedTimer > 0) {
      this.bleedTimer -= dt
      this.bleedNext -= dt
      if (this.bleedNext <= 0) {
        this.bleedNext = HUMAN.bleedInterval
        this.bleedPulse = true
        this.woundPos.set(this.pos.x, this.pos.y + 0.9 - (1 - this.bleedTimer / HUMAN.bleedDuration) * 0.6, this.pos.z)
      }
    }

    const t = this.deathTimer

    // Blood keeps arriving after the fall — the streaks lengthen for as long as
    // there is pressure behind them, which is what stops the wounds reading as
    // a texture that was already on him when he died.
    if (this.bleedTimer > 0 && this.bleedPulse) {
      this.bleedRun(0.1 + (1 - this.bleedTimer / HUMAN.bleedDuration) * 0.34)
    }

    // ---- the fall, which is somebody else's work now.
    //
    // What used to be here was about a hundred and eighty lines: a buckle curve
    // and a topple curve deliberately offset from each other, a damped bounce on
    // the landing, a root height that had to rise as the body went flat because
    // the root sits between the feet, and then a slack pose that reasoned out —
    // per joint, per corpse — where the sky was, so that a knee folded away from
    // the ground instead of through it. All of it existed because there was no
    // fall to play. There is one now, performed by a person falling over, and it
    // is better than the arithmetic was at every one of those things at once.
    //
    // Two things the arithmetic had that the clip does not, and they are kept.
    // One is that a fall has a direction, which the clip cannot know. The other
    // is that the pool is fifty-two slots deep and every corpse in it is now
    // playing the same forty frames — so a settle goes on top, seeded per death.
    this.motion?.update(dt)

    // How far through the fall, for the ground conform and the pool gate. The
    // clip's own rate varies with how hard he was hit, so this is deliberately
    // slower than the fastest of them: it is a fade, not a cue.
    const eased = smooth01(clamp(t / 1.15, 0, 1))

    // A man goes down the way he was hit, not the way he happened to be facing.
    // The clip falls forward, so the body turns under it toward the blow — part
    // of the way, and only while he is still on his feet. Turning the whole way
    // would be a pivot, and a pivot is a decision; this is a stumble.
    if (t < 0.4) {
      let d = Math.atan2(-this.fallX, -this.fallZ) - this.yaw
      d = ((d + Math.PI * 3) % (Math.PI * 2)) - Math.PI
      this.yaw += clamp(d, -0.8, 0.8) * dt * 4
    }

    // ---- how this one settled.
    //
    // The head first and hardest: it is the heaviest thing on the softest joint,
    // so it is what keeps moving after the rest has stopped, and it is what the
    // eye goes to. Then a little through the spine, which is enough to break the
    // silhouette. Applied as world-axis twists on top of the clip rather than as
    // channel offsets, because the clip is still writing those channels — see
    // `twist` in body.ts. It comes in late, after the body is down, so it reads
    // as a corpse arranging itself rather than as a fall that was already wrong.
    const rig = this.avatar?.rig
    if (rig) {
      const j = this.jitter
      const settle = smooth01(clamp((t - 0.7) / 1.5, 0, 1))
      FWD.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw))
      RIGHT.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw))
      twist(rig.head, UP, j[1]! * 0.42 * settle)
      twist(rig.head, FWD, j[2]! * 0.36 * settle)
      twist(rig.neck, RIGHT, (0.1 + j[3]! * 0.16) * settle)
      twist(rig.spine, UP, j[4]! * 0.13 * settle)
      twist(rig.spine, FWD, j[5]! * 0.11 * settle)
    }

    // Lie *on* the ground, not standing upright through a slope. Two height
    // samples give the gradient; the corpse pitches and rolls onto it.
    const gx = terrainHeight(this.pos.x + 0.6, this.pos.z) - terrainHeight(this.pos.x - 0.6, this.pos.z)
    const gz = terrainHeight(this.pos.x, this.pos.z + 0.6) - terrainHeight(this.pos.x, this.pos.z - 0.6)
    this.group.rotation.set(clamp(gz / 1.2, -0.5, 0.5) * eased, this.yaw, -clamp(gx / 1.2, -0.5, 0.5) * eased, 'YXZ')
    this.group.position.copy(this.pos)

    // ---- what pools under it. Stamped from where the torso actually came to
    // rest rather than from where the feet were: the body travels most of its
    // own length going down, so a pool at `pos` is a pool beside the corpse.
    // It arrives late and grows, because that is how long a body takes to make
    // one and watching it spread is worth more than having it there on frame 1.
    if (this.poolCount < this.poolMax) {
      this.poolNext -= dt
      if (this.poolNext <= 0 && eased > 0.7) {
        this.poolNext = 1.7
        this.poolCount++
        // A frame stale — bone world matrices are refreshed at render — which
        // at the scale of a pool of blood is nothing.
        if (rig) rig.chest.getWorldPosition(this.poolPos)
        else this.poolPos.copy(this.pos)
        // The eighth stamp used to come out at 3.86, which the decal's own
        // 2–3.6x spread turned into a fourteen-metre disc of blood from one
        // man. A body empties about five litres; on packed dirt that is a metre
        // and a half of pool, not a tennis court. The ramp now ends a little
        // under one, and the widening still reads because it starts small.
        this.poolScale = 0.30 + this.poolCount * 0.075
        this.poolPulse = true
      }
    }

    // ---- and finally, out of the world.
    //
    // This used to drive the body 2.2 m straight down, and at any range you
    // could actually see it that is a lift descending, not a corpse decaying.
    // Fading it out over the same couple of seconds while it settles a few
    // centimetres into the dirt reads as the ground taking it back.
    if (t > HUMAN.corpseLife) {
      const gone = clamp((t - HUMAN.corpseLife) / 2, 0, 1)
      this.group.position.y = this.pos.y - gone * 0.18
      for (const m of this.mats) {
        if (!m.transparent) {
          m.transparent = true
          m.depthWrite = false
        }
        m.opacity = 1 - gone
      }
      if (gone >= 1) this.group.visible = false
    }
  }

  /** True once the corpse has fully sunk and the slot can be reused. */
  get expired(): boolean {
    return !this.alive && this.deathTimer > HUMAN.corpseLife + 2
  }
}

/**
 * Where the rifle rides when it isn't in the hands, and where it goes when it
 * is. Body-local, in the units of a 1.72 m man; scaled per character on use.
 */
const SLUNG_POS = new THREE.Vector3(0.05, 1.14, 0.19)
const SLUNG_ROT = new THREE.Euler(1.2, 0.62, 0)
const AIMED_POS = new THREE.Vector3(0.075, 1.365, -0.155)
const AIMED_ROT = new THREE.Euler(-0.04, 0.03, 0)

const SOAK_AT = new THREE.Vector3()
const WOUND_AT = new THREE.Vector3()
const RUN_AT = new THREE.Vector3()
const CUT_A = new THREE.Vector3()
const CUT_B = new THREE.Vector3()
const CUT_C = new THREE.Vector3()
const GRIP = new THREE.Vector3()
const FORE = new THREE.Vector3()
const POLE = new THREE.Vector3()
const Q_AIM = new THREE.Quaternion()

/**
 * How far the body's surface is from its vertical axis at height `y`, looking
 * along the horizontal unit direction (dx, dz). Bind pose, body units.
 *
 * The torso is the sweep in TORSO, so its rings answer this exactly: pick the
 * pair either side of `y`, lerp the half-width and half-depth, and solve the
 * ellipse for the radius in that direction. Above and below the sweep the body
 * is not a sweep at all, so those get the two numbers that matter — a throat is
 * thin and a skull is not — rather than an extrapolation off the end of a table
 * that would give a neck the width of a ribcage.
 */
function sectionR(y: number, dx: number, dz: number): number {
  let a: number
  let b: number
  const top = TORSO[TORSO.length - 1]!
  if (y >= top[0]) {
    // Neck to crown. Narrow through the throat, opening out into the head, and
    // the crossover is the jaw.
    a = b = y < 1.5 ? 0.052 : Math.min(0.098, 0.052 + (y - 1.5) * 0.6)
  } else if (y <= TORSO[0]![0]) {
    // A thigh, near enough — below the sweep there is no single trunk left.
    a = b = 0.085
  } else {
    let i = 1
    while (i < TORSO.length - 1 && TORSO[i]![0] < y) i++
    const lo = TORSO[i - 1]!
    const hi = TORSO[i]!
    const t = (y - lo[0]) / (hi[0] - lo[0])
    a = lo[1] + (hi[1] - lo[1]) * t
    b = lo[2] + (hi[2] - lo[2]) * t
  }
  // The ellipse x²/a² + z²/b² = 1 along (dx, dz).
  const q = (dx * dx) / (a * a) + (dz * dz) / (b * b)
  return q > 0 ? 1 / Math.sqrt(q) : a
}
/**
 * Bake a colour into a geometry's vertices, for the rigid props — rifle, kit,
 * hat. Wood, steel and brass in one buffer is one draw call instead of three.
 */
function tintGeo(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex)
  const n = g.attributes.position!.count
  const arr = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r
    arr[i * 3 + 1] = c.g
    arr[i * 3 + 2] = c.b
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3))
  return g
}

function smooth01(x: number): number {
  const c = x < 0 ? 0 : x > 1 ? 1 : x
  return c * c * (3 - 2 * c)
}

function angleDamp(a: number, b: number, lambda: number, dt: number): number {
  let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI
  if (diff < -Math.PI) diff += Math.PI * 2
  return a + diff * (1 - Math.exp(-lambda * dt))
}
