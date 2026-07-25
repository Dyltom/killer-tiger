/**
 * Prey and predators-of-the-predator.
 *
 * Villagers wander, notice the tiger, and scatter screaming toward firelight.
 * Hunters patrol, close the distance, and shoot. Both share one body rig and
 * one state machine; the differences are in the config table and the brain.
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { HUMAN } from '../config'
import { clamp, damp, Rng } from '../engine/rng'
import { textures } from '../world/textures'
import { terrainHeight, World } from '../world/world'

export type HumanKind = 'villager' | 'hunter'
export type HumanState = 'wander' | 'suspicious' | 'flee' | 'hunt' | 'panic' | 'dead'

export interface ShotEvent {
  origin: THREE.Vector3
  dir: THREE.Vector3
  damage: number
  hit: boolean
}

// Darker than they look on a swatch. The sun is 3.3 intensity and the grade
// adds contrast on top, so anything above about 0xc08150 clips to featureless
// white the moment a villager steps out of shade.
const SKIN = [0x8d5a3b, 0xa4703f, 0x6b4229, 0x9c6a44, 0x5c3a24]
const SHIRT = [0x6d7b52, 0x8a5a3c, 0x4c5b6b, 0x7a6b4f, 0x9c8461, 0x5c4a3a]
const HUNTER_SHIRT = [0x3f4a35, 0x4a3f2f, 0x35404a]

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

  private target = new THREE.Vector3()
  private repathTimer = 0
  private fireTimer = 0
  private aimTimer = 0
  private stepPhase = 0
  private deathTimer = 0
  private hurtFlash = 0
  private rng: Rng

  /** Rig parts we animate. */
  private legL!: THREE.Mesh
  private legR!: THREE.Mesh
  private armL!: THREE.Mesh
  private armR!: THREE.Mesh
  private torso!: THREE.Mesh
  private head!: THREE.Mesh
  private rifle: THREE.Group | null = null
  private body = new THREE.Group()
  private mats: THREE.MeshStandardMaterial[] = []

  pendingShot: ShotEvent | null = null
  pendingShout = false
  screamed = false

  constructor(seed: number) {
    this.rng = new Rng(seed)
    this.buildRig()
    this.group.add(this.body)
  }

  // ----------------------------------------------------------------- rig
  /**
   * The rig is still exactly six meshes — torso, head, hair, two arms, two legs
   * — because with up to forty humans alive at once every extra mesh is another
   * forty draw calls. What changed is that each of those meshes is now several
   * primitives merged into one buffer rather than a single box, which costs
   * nothing at draw time and is the whole difference between a stack of cuboids
   * and something with shoulders, a jaw and knees.
   *
   * Pivots are unchanged: limbs still hang from their top vertex and the torso
   * and head still rotate about their centres, so the animation code below
   * drives this rig as it drove the old one.
   */
  private buildRig() {
    const tex = textures()
    const skin = new THREE.MeshStandardMaterial({ color: this.rng.pick(SKIN), roughness: 0.9 })
    const shirt = new THREE.MeshStandardMaterial({ map: tex.cloth, color: 0xffffff, roughness: 1 })
    const pants = new THREE.MeshStandardMaterial({ color: 0x3d3527, roughness: 1 })
    this.mats = [skin, shirt, pants]

    const scale = this.rng.range(0.94, 1.06)

    /** Tapered tube hanging *down* from `y`: it spans y - len to y. */
    const seg = (r0: number, r1: number, len: number, y: number, radial = 8) => {
      const g = new THREE.CylinderGeometry(r0, r1, len, radial)
      g.translate(0, y - len / 2, 0)
      return g
    }
    const ball = (r: number, y: number, x = 0, z = 0, sx = 1, sy = 1, sz = 1) => {
      const g = new THREE.SphereGeometry(r, 10, 8)
      g.scale(sx, sy, sz)
      g.translate(x, y, z)
      return g
    }
    const merged = (parts: THREE.BufferGeometry[]) => mergeGeometries(parts, false)!
    const sleeve = (x: number) => {
      const g = new THREE.CylinderGeometry(0.086, 0.074, 0.21, 10)
      g.translate(x, 0.14, 0)
      return g
    }

    // ---- torso: oval in section, wider at the shoulders than the waist.
    // Local origin sits at chest height; the mesh is parked at y 1.16 so the
    // body still spans roughly 0.85 to 1.47 as before.
    // seg() hangs downward, so the chest is anchored by its *top* at +0.24 —
    // level with the shoulder balls the arms swing from.
    this.torso = new THREE.Mesh(
      merged([
        seg(0.2, 0.155, 0.48, 0.24, 12).scale(1, 1, 0.62) as THREE.BufferGeometry,
        ball(0.17, -0.25, 0, 0, 1, 0.85, 0.66), // hips
        // A wrap over the hips. Without it the legs read as bare from the waist
        // down, which makes every villager look like they are in their
        // underwear. Kept short and a touch wider than the hips so a swinging
        // thigh doesn't punch through the static cloth.
        seg(0.2, 0.195, 0.26, -0.2).scale(1, 1, 0.72) as THREE.BufferGeometry,
        ball(0.085, 0.215, -0.19, 0, 1, 1, 0.85),
        ball(0.085, 0.215, 0.19, 0, 1, 1, 0.85),
        // Short sleeves. Built into the torso rather than into the arm so they
        // cost nothing: an arm split across two materials would be two draw
        // calls each, and at forty humans that is a hundred and sixty extra.
        // The arm swings inside the cuff, which is what a real sleeve does.
        sleeve(-0.205),
        sleeve(0.205),
      ]),
      shirt,
    )
    this.torso.position.y = 1.16
    this.body.add(this.torso)

    // ---- head, with the neck merged in so it tips with the head rather than
    // staying rigid while the skull swivels off it.
    this.head = new THREE.Mesh(
      merged([
        ball(0.115, 0, 0, 0, 1, 1.12, 1.04),
        ball(0.086, -0.055, 0, -0.018, 1, 0.82, 1),   // jaw
        ball(0.018, -0.014, 0, -0.108),               // nose
        ball(0.03, 0.005, -0.112, 0.008, 0.5, 1, 0.85),
        ball(0.03, 0.005, 0.112, 0.008, 0.5, 1, 0.85),
        seg(0.05, 0.058, 0.2, -0.1),                  // neck
      ]),
      skin,
    )
    this.head.position.y = 1.62
    this.body.add(this.head)

    // Skull cap rather than a slab on top — a hemisphere clipped at the brow.
    // Clipped at 0.42pi, not 0.6pi: past the equator it swallows the ears and
    // the temples and the head stops reading as hair at all, it reads as a
    // motorcycle helmet.
    const cap = new THREE.SphereGeometry(0.126, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.42)
    cap.scale(1, 1.12, 1.04)
    cap.translate(0, 0.008, 0.006)
    // Eyes ride on the hair mesh purely because it is already the right dark
    // brown — two dots is all it takes for a head to stop reading as an egg,
    // and it costs no extra draw call.
    const hairGeo = mergeGeometries([
      cap,
      // Occiput. Pushed back far enough to break the skull silhouette but not
      // so far that it reaches the brow: 0.122 - 0.04 = 0.082, comfortably
      // inside the 0.115 head, so nothing surfaces on the face.
      ball(0.122, -0.005, 0, 0.04, 1, 0.94, 1),
      ball(0.019, 0.005, -0.045, -0.1, 1, 0.8, 1),
      ball(0.019, 0.005, 0.045, -0.1, 1, 0.8, 1),
    ], false)!
    const hair = new THREE.Mesh(hairGeo, new THREE.MeshStandardMaterial({ color: 0x241a13, roughness: 1 }))
    // Child of the head, so it follows when the head pitches.
    this.head.add(hair)

    const mkLimb = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number) => {
      const m = new THREE.Mesh(geo, mat)
      m.position.set(x, y, 0)
      this.body.add(m)
      return m
    }

    // Upper arm, elbow, forearm, hand — 0.56 long overall, as the box was.
    const armGeo = () =>
      merged([
        seg(0.058, 0.05, 0.29, 0),
        ball(0.052, -0.29),
        seg(0.05, 0.038, 0.25, -0.29),
        ball(0.05, -0.56, 0, 0, 1, 1.2, 0.72),
      ])
    // Thigh, knee, shin, foot — 0.86 to the sole.
    const legGeo = () => {
      const foot = new THREE.BoxGeometry(0.1, 0.07, 0.21)
      foot.translate(0, -0.83, -0.05)
      return merged([
        seg(0.095, 0.075, 0.46, 0),
        ball(0.076, -0.46),
        seg(0.072, 0.052, 0.4, -0.46),
        foot,
      ])
    }

    // Hung from the shoulder balls at +-0.19, not from the old box's corners at
    // +-0.3 — out there they swung with a hand's width of daylight between arm
    // and body.
    this.armL = mkLimb(armGeo(), skin, -0.205, 1.375)
    this.armR = mkLimb(armGeo(), skin, 0.205, 1.375)
    this.legL = mkLimb(legGeo(), pants, -0.12, 0.86)
    this.legR = mkLimb(legGeo(), pants, 0.12, 0.86)

    this.body.scale.setScalar(scale)
    this.body.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true
        o.receiveShadow = true
      }
    })
  }

  // ------------------------------------------------------------- spawning
  spawn(kind: HumanKind, pos: THREE.Vector3, waveScale: number) {
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
    this.repathTimer = 0
    this.fireTimer = this.rng.range(0.4, 1.6)
    this.aimTimer = 0
    this.yaw = this.rng.range(0, Math.PI * 2)

    const cfg = kind === 'hunter' ? HUMAN.hunter : HUMAN.villager
    this.maxHealth = cfg.health * (1 + waveScale)
    this.health = this.maxHealth

    // Recolour so hunters read instantly as the dangerous ones.
    const shirt = this.mats[1]!
    shirt.color.setHex(kind === 'hunter' ? this.rng.pick(HUNTER_SHIRT) : this.rng.pick(SHIRT))
    shirt.emissive.setHex(0x000000)

    this.setRifleVisible(kind === 'hunter')
    this.group.visible = true
    this.body.rotation.set(0, 0, 0)
    this.body.position.set(0, 0, 0)
    this.syncTransform()
  }

  private setRifleVisible(on: boolean) {
    if (on && !this.rifle) {
      const g = new THREE.Group()
      const stock = new THREE.Mesh(
        new THREE.BoxGeometry(0.07, 0.09, 0.5),
        new THREE.MeshStandardMaterial({ color: 0x4a3220, roughness: 0.85 }),
      )
      const barrel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.022, 0.022, 0.72, 6),
        new THREE.MeshStandardMaterial({ color: 0x22242a, roughness: 0.45, metalness: 0.7 }),
      )
      barrel.rotation.x = Math.PI / 2
      barrel.position.z = -0.5
      g.add(stock, barrel)
      // Follows the arm in from 0.3 — the shoulders narrowed when the rig
      // stopped being a box.
      g.position.set(0.22, 1.3, -0.18)
      g.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = true })
      this.body.add(g)
      this.rifle = g
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
    return new THREE.Vector3(this.pos.x, this.pos.y + 1.2, this.pos.z)
  }

  // --------------------------------------------------------------- damage
  /** Returns true if this hit killed them. */
  hurt(amount: number, from: THREE.Vector3): boolean {
    if (!this.alive) return false
    this.health -= amount
    this.hurtFlash = 1
    this.alerted = true
    this.awareness = 1.4
    this.staggerTimer = Math.max(this.staggerTimer, 0.22)
    // Knock them back a touch so hits have weight.
    const dx = this.pos.x - from.x
    const dz = this.pos.z - from.z
    const l = Math.hypot(dx, dz) || 1
    this.vel.x += (dx / l) * 3.4
    this.vel.z += (dz / l) * 3.4
    if (this.health <= 0) {
      this.die()
      return true
    }
    if (this.kind === 'villager') this.state = 'flee'
    return false
  }

  private die() {
    this.alive = false
    this.state = 'dead'
    this.deathTimer = 0
    this.vel.set(0, 0, 0)
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
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 3)
    this.mats[1]!.emissive.setRGB(this.hurtFlash * 0.7, 0, 0)

    if (!this.alive) {
      this.updateDeath(dt)
      return
    }

    this.fearTimer = Math.max(0, this.fearTimer - dt)
    this.staggerTimer = Math.max(0, this.staggerTimer - dt)

    this.updatePerception(dt, tigerPos, tigerVisibility, tigerNoise, world)
    this.updateBrain(dt, tigerPos, world, waveScale)
    this.updateMotion(dt, world)
    this.animate(dt)
    this.syncTransform()
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

    if (this.fearTimer > 0) this.state = 'panic'
    else if (this.alerted) this.state = this.kind === 'hunter' ? 'hunt' : 'flee'
    else if (this.awareness > 0.35) this.state = 'suspicious'
    else if (this.state !== 'wander') this.state = 'wander'

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

  private animate(dt: number) {
    const speed = Math.hypot(this.vel.x, this.vel.z)
    this.stepPhase += dt * (3.2 + speed * 1.5)
    const amp = clamp(speed / 5, 0, 1) * 0.9

    this.legL.rotation.x = Math.sin(this.stepPhase) * amp
    this.legR.rotation.x = Math.sin(this.stepPhase + Math.PI) * amp

    if (this.kind === 'hunter' && (this.state === 'hunt' || this.aimTimer > 0.1)) {
      // Shouldered rifle pose. Positive rotation.x, not negative: the body
      // faces local -Z (see the sight vector in `sense`), and a limb hanging
      // down lands at z = -sin(x), so a negative angle throws the arms out
      // behind the back while the rifle stays out front.
      this.armR.rotation.x = 1.45
      this.armR.rotation.z = -0.1
      this.armL.rotation.x = 1.25
      this.armL.rotation.z = 0.35
      if (this.rifle) {
        this.rifle.rotation.set(-0.05, 0, 0)
        this.rifle.position.set(0.16, 1.42, -0.3)
      }
    } else {
      this.armL.rotation.x = Math.sin(this.stepPhase + Math.PI) * amp * 0.85
      this.armR.rotation.x = Math.sin(this.stepPhase) * amp * 0.85
      // Both cleared, not just the left: the pool recycles a dead hunter into a
      // villager, and a stale z leaves one arm cocked out for the rest of the run.
      this.armL.rotation.z = 0
      this.armR.rotation.z = 0
      if (this.rifle) {
        // Slung across the back, muzzle above the left shoulder. The old idle
        // parked it at the ribs with both arms hanging slack, so it read as a
        // stick skewering the chest. Carrying it in the hands isn't an option
        // either: the arms are single rigid meshes with no elbow, so a hand can
        // only ever sit 0.56 m dead in line with the shoulder and never lands
        // on the grip. A sling needs no hands, leaves the walk swing alone, and
        // the barrel over the shoulder still says "armed" from the front.
        this.rifle.rotation.set(1.25, 0.6, 0)
        this.rifle.position.set(0.05, 1.15, 0.17)
      }
    }

    // Arms up and flailing when terrified.
    if (this.state === 'panic' || (this.state === 'flee' && speed > 3)) {
      this.armL.rotation.x = 2.4 + Math.sin(this.stepPhase * 2.2) * 0.45
      this.armR.rotation.x = 2.4 + Math.sin(this.stepPhase * 2.2 + 1.7) * 0.45
      this.armL.rotation.z = 0.4
      this.armR.rotation.z = -0.4
    }

    // Lean into the run.
    this.torso.rotation.x = damp(this.torso.rotation.x, clamp(speed / 14, 0, 0.3), 6, dt)
    this.head.rotation.x = -this.torso.rotation.x
  }

  private updateDeath(dt: number) {
    this.deathTimer += dt
    // Topple over the first half-second, lie still, then sink into the dirt.
    const fall = clamp(this.deathTimer / 0.5, 0, 1)
    this.body.rotation.x = fall * (Math.PI / 2) * 0.98
    this.body.position.y = -fall * 0.15
    // Limbs go slack.
    const slack = 1 - fall
    this.legL.rotation.x *= slack
    this.legR.rotation.x *= slack
    this.armL.rotation.x = damp(this.armL.rotation.x, 0.6, 5, dt)
    this.armR.rotation.x = damp(this.armR.rotation.x, 0.6, 5, dt)

    if (this.deathTimer > HUMAN.corpseLife) {
      const sink = (this.deathTimer - HUMAN.corpseLife) / 2
      this.group.position.y = this.pos.y - sink * 2.2
      if (sink >= 1) this.group.visible = false
    } else {
      this.group.position.copy(this.pos)
    }
    this.group.rotation.y = this.yaw
  }

  /** True once the corpse has fully sunk and the slot can be reused. */
  get expired(): boolean {
    return !this.alive && this.deathTimer > HUMAN.corpseLife + 2
  }
}

function angleDamp(a: number, b: number, lambda: number, dt: number): number {
  let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI
  if (diff < -Math.PI) diff += Math.PI * 2
  return a + diff * (1 - Math.exp(-lambda * dt))
}
