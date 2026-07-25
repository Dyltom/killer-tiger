/**
 * The player: a first-person tiger.
 *
 * Owns movement + camera, and the viewmodel (two clawed forepaws that swipe
 * across the screen). Combat resolution lives in game.ts — this class only
 * reports "I swung, here is the moment and the arc".
 */
import * as THREE from 'three'
import { CAMERA, TIGER } from '../config'
import { clamp, damp } from '../engine/rng'
import { textures } from '../world/textures'
import { terrainHeight, World } from '../world/world'
import type { Input } from '../engine/input'

export type AttackKind = 'claw' | 'bite'

export interface AttackEvent {
  kind: AttackKind
  origin: THREE.Vector3
  dir: THREE.Vector3
  range: number
  arc: number
  damage: number
}

type PawState = 'idle' | 'swipeL' | 'swipeR' | 'bite'

/**
 * Rest pose of a forepaw in camera space. Every animation state offsets from
 * here, so it lived as the same four literals repeated across four methods and
 * moving the paws meant finding all eight copies.
 *
 * `y` is set against the bottom edge of the frame: the vertical FOV is fixed, so
 * at z the visible half-height is |z|*tan(fov/2), and anything below that is
 * gone regardless of how wide the window is. At z = -0.95 that edge is 0.77, and
 * -0.50 puts the paw about two thirds of the way down — low and well forward,
 * which is where a quadruped's forefeet actually are when you are looking out of
 * its skull. The old -0.36 at -0.84 held them up around chest height, and that
 * is what made them read as two arms carried in front rather than as legs the
 * animal is running on.
 */
const PAW = { x: 0.40, y: -0.50, z: -0.95, pitch: 0.42 }

/**
 * Where the foreleg is joined to the animal, in camera space: down, back and
 * outside the frame, roughly where a tiger's shoulder sits relative to its eye.
 *
 * The swipe used to be pure translation of the paw, which is why it read as a
 * striped sausage floating loose in the middle of the screen — nothing in the
 * animation kept the far end of the leg anchored to anything. Hanging both paws
 * off a pivot here and *rotating* it means the leg always radiates from the
 * corner of the frame, so it stays part of the body no matter where the paw is.
 *
 * Set wide, low and just behind the eye. A pivot close to the eye needs a large
 * rotation to put the paw on the reticle, and swinging that far drags the thick
 * end of the limb right past the lens — a metre of striped barrel across half
 * the screen. From out here the same reach costs about a third of the angle.
 */
const SHOULDER = { x: 0.52, y: -0.78, z: 0.35 }
/** Paw offset from its shoulder. Chosen so the rest pose is unchanged. */
const LOCAL = { x: PAW.x - SHOULDER.x, y: PAW.y - SHOULDER.y, z: PAW.z - SHOULDER.z }

/**
 * Fraction of the stride a forefoot spends on the ground. A running cat's foot
 * is planted for most of the cycle and whips forward in what's left; a sine wave
 * splits it evenly, which is why the old gait read as paddling at the air rather
 * than as feet driving against the ground.
 */
const STANCE = 0.62

/**
 * Where one forepaw is in its stride: +1 fully forward at the instant it plants,
 * falling linearly to -1 as it sweeps back under the chest at ground speed, then
 * whipping forward again through the swing phase.
 *
 * The stance half is deliberately linear — a foot in contact with the ground
 * travels backward at a constant rate, and easing it would be the paw sliding.
 * The swing half is smoothstepped so the whip doesn't snap at either end.
 */
function stride(phase: number): number {
  const c = phase - Math.floor(phase)
  if (c < STANCE) return 1 - 2 * (c / STANCE)
  const s = (c - STANCE) / (1 - STANCE)
  return -1 + 2 * (s * s * (3 - 2 * s))
}

/** How far off the ground the paw is, 0 through the whole stance phase. */
function lift(phase: number): number {
  const c = phase - Math.floor(phase)
  return c < STANCE ? 0 : Math.sin(((c - STANCE) / (1 - STANCE)) * Math.PI)
}

/** Fresh arterial blood, for whatever the claws have been in. */
const BLOOD = new THREE.Color(0x6d0a0c)
const lunge = new THREE.Vector3()
/** Axis a fresh CylinderGeometry runs along once its top is put at the origin. */
const DOWN = new THREE.Vector3(0, -1, 0)
/** Proximal cap of the foreleg mesh, in the paw group's own space. */
const ELBOW = new THREE.Vector3(0, -0.339, 0.419).multiplyScalar(0.62)
const elbowAt = new THREE.Vector3()

export class Tiger {
  /** Start out in the long grass at the treeline, facing the village. */
  readonly pos = new THREE.Vector3(0, 0, 56)
  readonly vel = new THREE.Vector3()
  yaw = 0
  pitch = 0

  health = TIGER.maxHealth
  stamina = TIGER.maxStamina
  rage = 0

  grounded = true
  crouching = false
  sprinting = false
  /** Set while the pounce arc is active — used for lunge kills and fall damage skip. */
  pouncing = false

  frenzy = 0
  speedMult = 1
  damageMult = 1
  damageTakenMult = 1

  private clawCd = 0
  private biteCd = 0
  roarCd = 0
  private sinceDamage = 99
  private sinceSprint = 99
  private bobPhase = 0
  private stepAccum = 0
  private landImpact = 0
  private camShake = 0
  private shakeTime = 0
  private recoilY = 0
  /** Counts down while a connecting blow holds the swipe still. */
  private hitStop = 0
  /** Kick along the look axis on contact — the arm stopping against a body. */
  private impact = 0
  private clawBlood = 0

  /** Viewmodel. */
  private vm = new THREE.Group()
  private pawL!: THREE.Group
  private pawR!: THREE.Group
  private shoulderL!: THREE.Group
  private shoulderR!: THREE.Group
  private armL!: THREE.Mesh
  private armR!: THREE.Mesh
  private pawState: PawState = 'idle'
  private pawT = 0
  private nextPawIsLeft = true
  private eyeY = TIGER.eyeHeight
  private clawMat!: THREE.MeshStandardMaterial

  /** Populated during update(); the game reads and clears these. */
  pendingAttack: AttackEvent | null = null
  footstepEvent = false
  landedEvent = false

  constructor(readonly camera: THREE.PerspectiveCamera, private world: World) {
    this.pos.y = terrainHeight(this.pos.x, this.pos.z)
    this.buildViewmodel()
    camera.add(this.vm)
  }

  // ---------------------------------------------------------- viewmodel
  private buildViewmodel() {
    const tex = textures()
    // The fur canvas is shared with the AI tigers, so the viewmodel takes its
    // own view of it to tile the stripes down at forepaw scale.
    const furMap = tex.fur!.clone()
    furMap.wrapS = furMap.wrapT = THREE.RepeatWrapping
    // Once around the leg, and only a little over half the stripe run down it,
    // so the eleven stripes in the canvas land as about six on the foreleg.
    furMap.repeat.set(1, 0.55)
    furMap.anisotropy = 8
    furMap.needsUpdate = true

    const furMat = new THREE.MeshStandardMaterial({
      map: furMap,
      roughness: 0.88,
      metalness: 0,
      // No normal map for the coat, but the albedo's own fur strokes make a
      // serviceable bump — enough to catch the low sun along the leg.
      bumpMap: furMap,
      bumpScale: 0.35,
    })
    const pawMap = furMap.clone()
    pawMap.repeat.set(1.7, 1.25)
    pawMap.needsUpdate = true
    const pawMat = new THREE.MeshStandardMaterial({
      map: pawMap, roughness: 0.88, metalness: 0, bumpMap: pawMap, bumpScale: 0.3,
    })
    // Kept on the instance so a hit can wet it with blood; the claws are the
    // only part of the viewmodel that carries any record of what you just did.
    this.clawMat = new THREE.MeshStandardMaterial({ color: 0xe8ddcd, roughness: 0.32, metalness: 0.04 })
    const clawMat = this.clawMat
    const padMat = new THREE.MeshStandardMaterial({ color: 0x2e1d18, roughness: 0.72 })

    const makePaw = (side: -1 | 1): THREE.Group => {
      const g = new THREE.Group()

      // Foreleg, running back and down from the wrist so its far end leaves the
      // frame through the bottom corner. It used to stand up off the paw the way
      // a leg does on a standing animal, which put the wide proximal end nearer
      // the eye than the paw — and since it was open-ended you spent the whole
      // game looking down the inside of a hollow striped cone with a small nub
      // of paw at the bottom. Capped now as well, so nothing can show a hole.
      //
      // Thinner than the paw is wide, and short. A foreleg is about six tenths
      // the width of the foot it carries, and the near end of it sits half the
      // distance from the eye that the paw does — so at equal radius it renders
      // twice the size and the paw becomes a nub on the end of a striped pipe.
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.125, 0.1, 0.52, 14), furMat)
      leg.position.set(0, -0.156, 0.234)
      leg.rotation.x = 2.35
      g.add(leg)

      // Wrist, filling the joint where the leg meets the paw.
      const wrist = new THREE.Mesh(new THREE.SphereGeometry(0.105, 12, 10), furMat)
      wrist.position.set(0, 0.035, 0.05)
      g.add(wrist)

      // Paw: a squashed dome with four toes on the front edge. The toes are the
      // whole read — a smooth ellipsoid is a mitten from any angle. Its own copy
      // of the fur map at a tighter repeat: at the leg's scale a single stripe
      // is wider than the whole foot, which flattens every toe into one flat
      // band of colour.
      // Both UV poles are rotated onto the left and right silhouette edges,
      // where they are seen almost edge-on. Every stripe on the fur map
      // converges at a pole, so leaving one pointing up paints a bullseye on
      // the top of the paw and leaving one pointing back paints it on the face
      // of the paw nearest the eye — the two spots you look at all game.
      const pawGeo = new THREE.SphereGeometry(0.17, 16, 14)
      pawGeo.rotateZ(Math.PI / 2)
      const paw = new THREE.Mesh(pawGeo, pawMat)
      paw.scale.set(1.15, 0.8, 1.25)
      g.add(paw)

      for (let i = 0; i < 4; i++) {
        const t = (i / 3 - 0.5) * 2 // -1..1
        // Outer toes sit slightly back, the way a splayed cat foot does.
        const back = Math.abs(t) * 0.028

        const toe = new THREE.Mesh(new THREE.SphereGeometry(0.064, 10, 8), pawMat)
        toe.scale.set(0.95, 0.8, 1.3)
        // Sat on the equator before, which is invisible: the camera looks *down*
        // onto the paw, so anything at or below the widest point of the dome is
        // hidden behind the dome's own horizon and the foot reads as a mitten.
        // Lifted a fifth of the way up the front face so all four break the top
        // silhouette as separate bumps.
        toe.position.set(t * 0.098 * side, 0.028, -0.185 + back)
        g.add(toe)

        // Claw: two tapered segments angled against each other so it hooks.
        const claw = new THREE.Group()
        const base = new THREE.Mesh(new THREE.ConeGeometry(0.021, 0.075, 7), clawMat)
        base.position.set(0, 0, -0.035)
        base.rotation.x = -1.9
        claw.add(base)
        const hook = new THREE.Mesh(new THREE.ConeGeometry(0.013, 0.075, 7), clawMat)
        hook.position.set(0, -0.018, -0.096)
        hook.rotation.x = -2.32
        claw.add(hook)
        claw.position.set(t * 0.098 * side, 0.006, -0.246 + back)
        claw.rotation.z = t * 0.32 * side
        g.add(claw)
      }

      // Heel pad, visible on the down-stroke of a swipe.
      const pad = new THREE.Mesh(new THREE.SphereGeometry(0.082, 10, 8), padMat)
      pad.scale.set(1.25, 0.42, 1.0)
      pad.position.set(0, -0.112, -0.03)
      g.add(pad)

      // Well under life-size. A full-scale foreleg swinging past the eye blots
      // out the target you are trying to hit, and at this framing the paws are
      // meant to sit in the corners rather than cover them.
      g.scale.setScalar(0.62)
      return g
    }

    this.pawL = makePaw(-1)
    this.pawR = makePaw(1)
    this.shoulderL = new THREE.Group()
    this.shoulderR = new THREE.Group()
    this.shoulderL.position.set(-SHOULDER.x, SHOULDER.y, SHOULDER.z)
    this.shoulderR.position.set(SHOULDER.x, SHOULDER.y, SHOULDER.z)
    this.shoulderL.add(this.pawL)
    this.shoulderR.add(this.pawR)

    // Upper arm, bridging the shoulder pivot to the top of the foreleg. Without
    // it the limb is just the foreleg, whose open end is hidden by the bottom of
    // the frame at rest and floats in clear air the moment a swipe lifts it —
    // which is exactly the striped sausage the strike used to read as. Unit
    // length, stretched and aimed every frame in updateArms(), because the far
    // end of the foreleg swings with the wrist and no fixed segment can follow.
    const armGeo = new THREE.CylinderGeometry(0.062, 0.092, 1, 12)
    armGeo.translate(0, -0.5, 0)
    // Its own view of the coat: the foreleg's repeat is set for a 0.5 m segment,
    // and reused over a metre of upper arm it smears into two cream bands.
    const armMap = furMap.clone()
    armMap.repeat.set(1, 1.05)
    armMap.offset.set(0, 0.3)
    armMap.needsUpdate = true
    const armMat = new THREE.MeshStandardMaterial({
      map: armMap, roughness: 0.88, metalness: 0, bumpMap: armMap, bumpScale: 0.35,
    })
    this.armL = new THREE.Mesh(armGeo, armMat)
    this.armR = new THREE.Mesh(armGeo, armMat)
    this.shoulderL.add(this.armL)
    this.shoulderR.add(this.armR)

    this.vm.add(this.shoulderL, this.shoulderR)
    // Viewmodel renders slightly in front of the world; keep it out of walls.
    this.vm.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.renderOrder = 10
        o.castShadow = false
        ;(o.material as THREE.Material).depthTest = true
      }
    })
    this.resetPaws()
  }

  private resetPaws() {
    this.shoulderL.rotation.set(0, 0, 0)
    this.shoulderR.rotation.set(0, 0, 0)
    this.pawL.position.set(-LOCAL.x, LOCAL.y, LOCAL.z)
    this.pawL.rotation.set(PAW.pitch, 0.32, 0.18)
    this.pawR.position.set(LOCAL.x, LOCAL.y, LOCAL.z)
    this.pawR.rotation.set(PAW.pitch, -0.32, -0.18)
    this.updateArms()
  }

  // ------------------------------------------------------------- combat
  get canClaw() { return this.clawCd <= 0 }
  get canBite() { return this.biteCd <= 0 }
  get canRoar() { return this.roarCd <= 0 }

  private startAttack(kind: AttackKind) {
    if (kind === 'claw') {
      this.clawCd = TIGER.clawCooldown
      this.pawState = this.nextPawIsLeft ? 'swipeL' : 'swipeR'
      this.nextPawIsLeft = !this.nextPawIsLeft
    } else {
      this.biteCd = TIGER.biteCooldown
      this.pawState = 'bite'
    }
    this.pawT = 0
  }

  /** Fired mid-animation so the swipe connects when it looks like it should. */
  private emitAttack(kind: AttackKind) {
    const dir = this.lookDir()
    const origin = this.eyePos()
    const base = kind === 'claw' ? TIGER.clawDamage : TIGER.biteDamage
    this.pendingAttack = {
      kind,
      origin,
      dir,
      range: kind === 'claw' ? TIGER.clawRange : TIGER.biteRange,
      arc: kind === 'claw' ? TIGER.clawArc : TIGER.biteArc,
      damage: base * this.damageMult * (this.frenzy > 0 ? TIGER.frenzyDamageMult : 1),
    }
  }

  /**
   * Told by the game what the swing actually did, on the frame it landed.
   *
   * Without this the viewmodel plays the same arc whether you opened a throat
   * or swiped at fog, which is exactly what "the hits don't connect" means: the
   * animation has no idea it touched anything. A connecting blow now stalls
   * mid-swing, drives the camera along the look axis, and leaves the claws wet.
   */
  onAttackResult(hit: boolean, killed: boolean) {
    if (!hit) return
    this.hitStop = killed ? TIGER.killStop : TIGER.hitStop
    this.impact = killed ? TIGER.hitJolt * 1.7 : TIGER.hitJolt
    this.clawBlood = 1
  }

  lookDir(target = new THREE.Vector3()): THREE.Vector3 {
    return target.set(
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch),
    )
  }

  eyePos(target = new THREE.Vector3()): THREE.Vector3 {
    return target.set(this.pos.x, this.pos.y + this.eyeY, this.pos.z)
  }

  // ------------------------------------------------------------- damage
  takeDamage(amount: number): boolean {
    const dmg = amount * this.damageTakenMult * (this.frenzy > 0 ? 0.75 : 1)
    this.health = Math.max(0, this.health - dmg)
    this.sinceDamage = 0
    this.shake(0.45)
    return this.health <= 0
  }

  heal(amount: number) {
    this.health = Math.min(TIGER.maxHealth, this.health + amount)
  }

  addRage(amount: number) {
    this.rage = Math.min(TIGER.maxRage, this.rage + amount)
  }

  shake(amount: number) {
    this.camShake = Math.min(1.4, this.camShake + amount)
  }

  startFrenzy(): boolean {
    if (this.rage < TIGER.maxRage) return false
    this.rage = 0
    this.frenzy = TIGER.frenzyDuration
    this.shake(0.7)
    return true
  }

  /** Noise the tiger is currently making — drives AI detection. */
  get noise(): number {
    const moving = Math.hypot(this.vel.x, this.vel.z)
    if (moving < 0.4) return 2
    if (this.crouching) return TIGER.noiseCrouch
    if (this.sprinting) return TIGER.noiseSprint
    return TIGER.noiseWalk
  }

  /** How visible the tiger is right now, 0..1. Grass + crouch hide you. */
  get visibility(): number {
    let v = 1
    if (this.crouching) v *= 0.55
    if (this.world.inGrass(this.pos.x, this.pos.z)) {
      v *= this.crouching ? TIGER.grassConcealment : 0.75
    }
    if (this.sprinting) v = Math.min(1, v * 1.6)
    return v
  }

  // ------------------------------------------------------------- update
  update(dt: number, input: Input, locked: boolean) {
    this.pendingAttack = null
    this.footstepEvent = false
    this.landedEvent = false

    if (locked) this.updateLook(input)
    this.updateTimers(dt)
    this.updateMovement(dt, input, locked)
    if (locked) this.updateActions(input)
    this.updateViewmodel(dt)
    this.updateCamera(dt)
  }

  private updateLook(input: Input) {
    this.yaw -= input.mouseDX * CAMERA.sensitivity
    this.pitch -= input.mouseDY * CAMERA.sensitivity
    this.pitch = clamp(this.pitch, -CAMERA.pitchLimit, CAMERA.pitchLimit)
  }

  private updateTimers(dt: number) {
    this.clawCd = Math.max(0, this.clawCd - dt)
    this.biteCd = Math.max(0, this.biteCd - dt)
    this.roarCd = Math.max(0, this.roarCd - dt)
    this.sinceDamage += dt
    this.sinceSprint += dt
    this.frenzy = Math.max(0, this.frenzy - dt)
    this.camShake = Math.max(0, this.camShake - dt * 2.4)
    this.shakeTime += dt
    this.recoilY = damp(this.recoilY, 0, 9, dt)
    this.landImpact = damp(this.landImpact, 0, 9, dt)
    this.hitStop = Math.max(0, this.hitStop - dt)
    this.impact = damp(this.impact, 0, 11, dt)

    if (this.clawBlood > 0) {
      this.clawBlood = Math.max(0, this.clawBlood - dt / TIGER.clawBloodTime)
      // Bone white when clean, wet arterial red when fresh, drying to brown.
      this.clawMat.color.setHex(0xe8ddcd).lerp(BLOOD, this.clawBlood * 0.92)
      this.clawMat.roughness = 0.32 - this.clawBlood * 0.22
    }

    if (this.sinceDamage > TIGER.regenDelay) {
      this.health = Math.min(TIGER.maxHealth, this.health + TIGER.healthRegen * dt)
    }
    if (this.sinceSprint > TIGER.staminaRegenDelay) {
      this.stamina = Math.min(TIGER.maxStamina, this.stamina + TIGER.staminaRegen * dt)
    }
    if (this.frenzy <= 0) {
      this.rage = Math.max(0, this.rage - TIGER.rageDecay * dt)
    }
  }

  private updateMovement(dt: number, input: Input, locked: boolean) {
    const axis = locked ? input.moveAxis() : { x: 0, z: 0 }
    const wantsSprint = locked && input.held('ShiftLeft') && this.stamina > 1 && axis.z > 0.1
    this.crouching = locked && (input.held('ControlLeft') || input.held('KeyC')) && this.grounded
    this.sprinting = wantsSprint && !this.crouching

    if (this.sprinting) {
      this.stamina = Math.max(0, this.stamina - TIGER.sprintDrain * dt)
      this.sinceSprint = 0
    }

    let target = TIGER.walkSpeed
    if (this.sprinting) target = TIGER.sprintSpeed
    else if (this.crouching) target = TIGER.crouchSpeed
    target *= this.speedMult * (this.frenzy > 0 ? TIGER.frenzySpeedMult : 1)

    // Desired velocity in world space from local input.
    const fwdX = -Math.sin(this.yaw)
    const fwdZ = -Math.cos(this.yaw)
    const rightX = Math.cos(this.yaw)
    const rightZ = -Math.sin(this.yaw)
    const wantX = (fwdX * axis.z + rightX * axis.x) * target
    const wantZ = (fwdZ * axis.z + rightZ * axis.x) * target

    const control = this.grounded ? 1 : TIGER.airControl
    const accel = TIGER.accel * control * dt
    this.vel.x += (wantX - this.vel.x) * Math.min(1, accel / Math.max(1, target))
    this.vel.z += (wantZ - this.vel.z) * Math.min(1, accel / Math.max(1, target))

    if (this.grounded && axis.x === 0 && axis.z === 0) {
      const f = Math.max(0, 1 - TIGER.friction * dt)
      this.vel.x *= f
      this.vel.z *= f
    }

    // Pounce.
    if (locked && input.pressed('Space') && this.grounded && this.stamina >= TIGER.pounceCost) {
      this.stamina -= TIGER.pounceCost
      this.sinceSprint = 0
      const dir = this.lookDir()
      const horiz = Math.hypot(dir.x, dir.z) || 1
      const moving = axis.z > 0.05 || axis.x !== 0 || true
      if (moving) {
        this.vel.x += (dir.x / horiz) * TIGER.pounceForward
        this.vel.z += (dir.z / horiz) * TIGER.pounceForward
      }
      this.vel.y = TIGER.pounceUp + Math.max(0, dir.y) * 5
      this.grounded = false
      this.pouncing = true
      this.recoilY = -0.09
    }

    // Gravity + integrate.
    if (!this.grounded) this.vel.y -= TIGER.gravity * dt
    this.pos.x += this.vel.x * dt
    this.pos.z += this.vel.z * dt
    this.pos.y += this.vel.y * dt

    // Static collision.
    const r = this.world.resolve(this.pos.x, this.pos.z, TIGER.radius, this.pos.y)
    if (r.hit) {
      // Kill velocity into the surface so we slide instead of sticking.
      const dx = r.x - this.pos.x
      const dz = r.z - this.pos.z
      const l = Math.hypot(dx, dz)
      if (l > 1e-5) {
        const nx = dx / l
        const nz = dz / l
        const into = this.vel.x * nx + this.vel.z * nz
        if (into < 0) {
          this.vel.x -= nx * into
          this.vel.z -= nz * into
        }
      }
      this.pos.x = r.x
      this.pos.z = r.z
    }

    // Ground.
    const gy = terrainHeight(this.pos.x, this.pos.z)
    if (this.pos.y <= gy) {
      if (!this.grounded) {
        this.landImpact = Math.min(0.4, Math.abs(this.vel.y) * 0.018)
        this.landedEvent = true
        this.pouncing = false
      }
      this.pos.y = gy
      this.vel.y = 0
      this.grounded = true
    } else if (this.pos.y > gy + 0.06) {
      this.grounded = false
    }

    // Footstep cadence scales with speed.
    const speed = Math.hypot(this.vel.x, this.vel.z)
    if (this.grounded && speed > 0.6) {
      this.stepAccum += speed * dt
      const stride = this.crouching ? 3.2 : 2.4
      if (this.stepAccum > stride) {
        this.stepAccum = 0
        this.footstepEvent = true
      }
      this.bobPhase += dt * CAMERA.bobFreq * (speed / TIGER.walkSpeed)
    } else {
      this.stepAccum = 0
      this.bobPhase = damp(this.bobPhase % (Math.PI * 2), 0, 3, dt)
    }
  }

  private updateActions(input: Input) {
    if (input.clickedPrimary() && this.canClaw) this.startAttack('claw')
    else if (input.clickedSecondary() && this.canBite) this.startAttack('bite')
  }

  private updateViewmodel(dt: number) {
    const speed = Math.hypot(this.vel.x, this.vel.z)

    if (this.pawState === 'idle') {
      // Bounding gait. The forelegs of a galloping cat reach together and land
      // together, so the two paws share a phase instead of alternating the way
      // a walking biped's arms do; the small offset between them is just enough
      // to stop them looking welded to each other.
      const ph = this.bobPhase / (Math.PI * 2)
      const amp = Math.min(1, speed / TIGER.sprintSpeed)
      const zBase = this.crouching ? LOCAL.z + 0.1 : LOCAL.z

      // `side` is -1 for the left leg throughout the viewmodel: LOCAL.x is
      // already negative, so positions multiply by it and the paw's own yaw and
      // roll negate it.
      for (const [paw, shoulder, side, phase] of [
        [this.pawL, this.shoulderL, -1, ph],
        [this.pawR, this.shoulderR, 1, ph + 0.08],
      ] as const) {
        const reach = stride(phase)
        const air = lift(phase)

        // The swing is biased forward: the pivot goes from level at the back of
        // the stride to -0.26 rad at the plant, rather than swinging symmetric
        // about rest. Rotating the leg *backward* past the shoulder would bring
        // the thick end of it up past the lens, and from a pivot this far behind
        // the eye a small forward angle is already a long stride at the foot.
        shoulder.rotation.set((-0.03 - reach * 0.23) * amp, 0, 0)
        // The last of the reach comes out of the leg rather than the shoulder,
        // which is what puts the paw far enough forward — and so far enough from
        // the lens — that the plant lands inside the bottom of the frame instead
        // of below it. Only on the reaching half; a foot dragging back doesn't
        // telescope.
        const extend = Math.max(0, reach) * 0.18 * amp
        paw.position.set(side * LOCAL.x, LOCAL.y + air * 0.05 * amp, zBase - extend)
        // Toe down into the plant, up through the swing.
        paw.rotation.set(PAW.pitch + reach * 0.3 * amp, -side * 0.32, -side * 0.18)
      }
      this.updateArms()
      return
    }

    const dur = this.pawState === 'bite' ? 0.4 : 0.34
    const prev = this.pawT
    // Hit-stop: the swing holds on the contact frame while the camera keeps
    // moving. Nothing else in the game pauses, so it costs a few frames of the
    // paw and buys the whole impression of hitting something solid.
    if (this.hitStop <= 0) this.pawT += dt
    const t = clamp(this.pawT / dur, 0, 1)
    // Contact is at the far end of the reach, not a third of the way in — the
    // damage used to land while the paw was still winding up behind the eye.
    const hitAt = 0.46
    if (prev / dur < hitAt && t >= hitAt) {
      this.emitAttack(this.pawState === 'bite' ? 'bite' : 'claw')
    }

    if (this.pawState === 'bite') {
      // Both forelegs swing up and in to clamp the body, then drag it down and
      // out of frame as the jaws close on the throat.
      const grab = clamp(t / 0.45, 0, 1)
      const drag = clamp((t - 0.45) / 0.55, 0, 1)
      const reach = Math.sin(grab * Math.PI * 0.5) * (1 - drag * 0.4)
      const pull = drag * drag

      // +X raises a forward-pointing leg; yaw toward the centre line closes the
      // two of them around the body.
      this.shoulderL.rotation.set(reach * 0.3 - pull * 0.52, -reach * 0.15, 0)
      this.shoulderR.rotation.set(reach * 0.3 - pull * 0.52, reach * 0.15, 0)
      this.pawL.position.set(-LOCAL.x, LOCAL.y, LOCAL.z - reach * 0.16)
      this.pawR.position.set(LOCAL.x, LOCAL.y, LOCAL.z - reach * 0.16)
      this.pawL.rotation.set(PAW.pitch - reach * 0.55, 0.32 - reach * 0.3, 0.18)
      this.pawR.rotation.set(PAW.pitch - reach * 0.55, -0.32 + reach * 0.3, -0.18)
      this.recoilY = -Math.sin(t * Math.PI) * 0.075
    } else {
      const left = this.pawState === 'swipeL'
      const shoulder = left ? this.shoulderL : this.shoulderR
      const paw = left ? this.pawL : this.pawR
      const otherShoulder = left ? this.shoulderR : this.shoulderL
      const other = left ? this.pawR : this.pawL
      const side = left ? -1 : 1

      // Three beats, all of them rotations of the shoulder. Cock the leg back
      // and outward, swing it up and across the centre of the frame — where the
      // reticle, and so the target, is — then let it carry through and drop.
      const wind = clamp(t / 0.26, 0, 1)
      const drive = clamp((t - 0.26) / 0.34, 0, 1)
      const follow = clamp((t - 0.6) / 0.4, 0, 1)
      const windE = Math.sin(wind * Math.PI * 0.5)
      // Ease-out, so the fastest part of the stroke is the moment of contact.
      const driveE = 1 - (1 - drive) * (1 - drive)

      // Angles are chosen so that at the contact frame (t = 0.46, driveE ≈ 0.83)
      // the paw sits on the centre line at about eye level — on the reticle, and
      // so on whatever the hit trace is about to pick.
      shoulder.rotation.set(
        // Pitch: drop and cock back, then lift the leg on the drive and let it
        // fall away through the follow-through. 0.34 rather than the old 0.53
        // because the rest pose is now much lower — the same lift from down
        // there would carry the paw up over the reticle and out of the top of
        // the frame instead of through it.
        -windE * 0.2 + driveE * 0.34 - follow * 0.38,
        // Yaw: out to its own side on the wind-up, then across the centre line.
        side * (driveE * 0.66 - follow * 0.4 - windE * 0.2),
        side * (windE * 0.2 - driveE * 0.5 + follow * 0.26),
      )
      // The reach out of the shoulder. This is most of what makes the blow land
      // in front of you rather than beside you: at the contact frame the leg is
      // 0.37 longer than at rest, which puts the paw roughly on the reticle at
      // 1.2 m — out where the hit trace actually is. A cat's swipe is not a
      // rigid lever; the whole leg lengthens into it.
      paw.position.set(side * LOCAL.x, LOCAL.y, LOCAL.z - driveE * 0.45 + follow * 0.16)
      // Turn the foot into the stroke as it goes, so the four claws lead it
      // rather than the camera watching the back of the paw go past. Offsets
      // from the rest yaw and roll rather than replacing them — the old form
      // negated both on frame one of the swing, so the paw snapped through 0.64
      // radians the instant you clicked.
      paw.rotation.set(
        PAW.pitch - driveE * 0.7,
        -side * (0.32 - driveE * 0.72),
        -side * (0.18 + driveE * 0.7),
      )
      // The other foreleg braces: a cat swiping shifts its weight onto it.
      otherShoulder.rotation.set(-driveE * 0.22, 0, 0)
      other.position.set(-side * LOCAL.x, LOCAL.y, LOCAL.z)
      other.rotation.set(PAW.pitch, side * 0.32, side * 0.18)

      this.recoilY = -driveE * 0.045 + follow * 0.02
    }

    if (t >= 1) {
      this.pawState = 'idle'
      this.resetPaws()
    }
    this.updateArms()
  }

  /** Stretch each upper arm from its shoulder to wherever the wrist ended up. */
  private updateArms() {
    for (const [paw, arm] of [[this.pawL, this.armL], [this.pawR, this.armR]] as const) {
      elbowAt.copy(ELBOW).applyEuler(paw.rotation).add(paw.position)
      const len = elbowAt.length()
      arm.quaternion.setFromUnitVectors(DOWN, elbowAt.divideScalar(len))
      // Overshoot slightly so the two caps overlap instead of meeting exactly,
      // which would show a seam the moment the joint bends.
      arm.scale.y = len + 0.05
    }
  }

  private updateCamera(dt: number) {
    const targetEye = this.crouching ? TIGER.crouchEyeHeight : TIGER.eyeHeight
    this.eyeY = damp(this.eyeY, targetEye, 12, dt)

    const speed = Math.hypot(this.vel.x, this.vel.z)
    const gait = (speed / TIGER.walkSpeed) * (this.grounded ? 1 : 0.2)

    // The bound. `sin` rectified and shaped: a long float at the top of the
    // stride, then a fast drop onto the forelegs. Squaring the fall is what
    // separates a bounding cat from a jogging human — the head hangs in the
    // air and then slams down, rather than tracing a smooth wave.
    const swing = Math.sin(this.bobPhase)
    const airborne = Math.max(0, swing)
    const bobY = (Math.pow(airborne, 0.6) - 0.35) * CAMERA.boundAmp * Math.min(gait, 1.8)
    // The nose drops through the landing half of the stride.
    const bobPitch = Math.min(0, swing) * CAMERA.boundPitch * Math.min(gait, 1.6)
    const bobX = Math.cos(this.bobPhase) * CAMERA.swayAmp * gait
    const bobRoll = Math.sin(this.bobPhase * 0.5) * CAMERA.boundRoll * Math.min(gait, 1.5)

    // Shake uses layered sines rather than random so it never jitters harshly.
    const s = this.camShake
    const st = this.shakeTime
    const shakeX = s * Math.sin(st * 47) * 0.16
    const shakeY = s * Math.sin(st * 61 + 1.3) * 0.16
    const shakeR = s * Math.sin(st * 39 + 2.1) * 0.05

    // A connecting blow shoves the whole head along the look axis, so the
    // impact is felt in the world rather than only in the arm.
    this.lookDir(lunge).multiplyScalar(this.impact)

    this.camera.position.set(
      this.pos.x + bobX * 0.35 + shakeX + lunge.x,
      this.pos.y + this.eyeY + bobY + this.recoilY - this.landImpact + shakeY + lunge.y,
      this.pos.z + shakeY * 0.2 + lunge.z,
    )
    this.camera.rotation.set(
      this.pitch + bobPitch + shakeY * 0.4 - this.impact * 2.2,
      this.yaw,
      bobX * 0.08 + bobRoll + shakeR,
      'YXZ',
    )

    // FOV punches out when you're moving fast or frenzied.
    let fov = CAMERA.fov
    if (this.frenzy > 0) fov = CAMERA.frenzyFov
    else if (this.sprinting) fov = CAMERA.sprintFov
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov = damp(this.camera.fov, fov, 6, dt)
      this.camera.updateProjectionMatrix()
    }
  }

  reset() {
    this.pos.set(0, 0, 56)
    this.pos.y = terrainHeight(this.pos.x, this.pos.z)
    this.vel.set(0, 0, 0)
    this.yaw = 0
    this.pitch = 0
    this.health = TIGER.maxHealth
    this.stamina = TIGER.maxStamina
    this.rage = 0
    this.frenzy = 0
    this.speedMult = 1
    this.damageMult = 1
    this.damageTakenMult = 1
    this.clawCd = this.biteCd = this.roarCd = 0
    this.camShake = 0
    this.hitStop = 0
    this.impact = 0
    this.clawBlood = 0
    this.clawMat.color.setHex(0xe8ddcd)
    this.clawMat.roughness = 0.32
    this.pawState = 'idle'
    this.resetPaws()
  }
}
