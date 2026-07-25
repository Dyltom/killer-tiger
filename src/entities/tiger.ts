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

  /** Viewmodel. */
  private vm = new THREE.Group()
  private pawL!: THREE.Group
  private pawR!: THREE.Group
  private pawState: PawState = 'idle'
  private pawT = 0
  private nextPawIsLeft = true
  private eyeY = TIGER.eyeHeight

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
    const furMat = new THREE.MeshStandardMaterial({ map: tex.fur, roughness: 0.85 })
    const clawMat = new THREE.MeshStandardMaterial({ color: 0xf2e9dc, roughness: 0.4, metalness: 0.05 })

    const makePaw = (side: -1 | 1): THREE.Group => {
      const g = new THREE.Group()

      // Foreleg, angled in from the screen edge.
      const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.115, 0.42, 4, 10), furMat)
      leg.position.set(0, 0.2, 0.14)
      leg.rotation.x = 0.5
      g.add(leg)

      // Paw pad.
      const paw = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10), furMat)
      paw.scale.set(1.15, 0.82, 1.25)
      g.add(paw)

      // Four claws fanned across the front of the paw.
      for (let i = 0; i < 4; i++) {
        const claw = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.135, 6), clawMat)
        const t = (i / 3 - 0.5) * 2 // -1..1
        claw.position.set(t * 0.085 * side, -0.03, -0.14)
        claw.rotation.x = -1.9
        claw.rotation.z = t * 0.35 * side
        g.add(claw)
      }

      // Slightly under life-size: a full-scale foreleg swinging past the eye
      // blots out the target you're trying to hit.
      g.scale.setScalar(0.78)
      return g
    }

    this.pawL = makePaw(-1)
    this.pawR = makePaw(1)
    this.vm.add(this.pawL, this.pawR)
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
    this.pawL.position.set(-0.42, -0.44, -0.72)
    this.pawL.rotation.set(0.22, 0.32, 0.18)
    this.pawR.position.set(0.42, -0.44, -0.72)
    this.pawR.rotation.set(0.22, -0.32, -0.18)
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
      // Gentle running paw pump; scales with speed so sprinting reads as a gallop.
      const t = this.bobPhase
      const amp = Math.min(1, speed / TIGER.sprintSpeed)
      const yL = -0.44 + Math.sin(t) * 0.1 * amp
      const yR = -0.44 + Math.sin(t + Math.PI) * 0.1 * amp
      const zBase = this.crouching ? -0.62 : -0.72
      this.pawL.position.set(-0.42, yL, zBase + Math.cos(t) * 0.07 * amp)
      this.pawR.position.set(0.42, yR, zBase + Math.cos(t + Math.PI) * 0.07 * amp)
      this.pawL.rotation.set(0.22 + Math.sin(t) * 0.15 * amp, 0.32, 0.18)
      this.pawR.rotation.set(0.22 + Math.sin(t + Math.PI) * 0.15 * amp, -0.32, -0.18)
      return
    }

    const dur = this.pawState === 'bite' ? 0.4 : 0.3
    const prev = this.pawT
    this.pawT += dt
    const t = clamp(this.pawT / dur, 0, 1)
    // Damage lands a third of the way through the swing.
    const hitAt = 0.34
    if (prev / dur < hitAt && t >= hitAt) {
      this.emitAttack(this.pawState === 'bite' ? 'bite' : 'claw')
    }

    if (this.pawState === 'bite') {
      // Both paws yank down and out of frame as the jaws close in.
      const e = Math.sin(t * Math.PI)
      this.pawL.position.set(-0.42 - e * 0.2, -0.44 - e * 0.5, -0.72 + e * 0.35)
      this.pawR.position.set(0.42 + e * 0.2, -0.44 - e * 0.5, -0.72 + e * 0.35)
      this.recoilY = -e * 0.075
    } else {
      const left = this.pawState === 'swipeL'
      const paw = left ? this.pawL : this.pawR
      const side = left ? -1 : 1
      // Wind-up then a fast arc across the middle of the screen.
      const e = t < 0.3 ? -(t / 0.3) * 0.35 : (t - 0.3) / 0.7
      paw.position.set(
        side * 0.42 - side * e * 0.95,
        -0.44 + Math.sin(clamp(e, 0, 1) * Math.PI) * 0.34,
        -0.72 - Math.sin(clamp(e, 0, 1) * Math.PI) * 0.32,
      )
      paw.rotation.set(0.22 - e * 0.5, side * 0.32 + e * side * 1.5, side * 0.18 - e * side * 1.9)
      this.recoilY = -Math.sin(clamp(e, 0, 1) * Math.PI) * 0.03
    }

    if (t >= 1) {
      this.pawState = 'idle'
      this.resetPaws()
    }
  }

  private updateCamera(dt: number) {
    const targetEye = this.crouching ? TIGER.crouchEyeHeight : TIGER.eyeHeight
    this.eyeY = damp(this.eyeY, targetEye, 12, dt)

    const speed = Math.hypot(this.vel.x, this.vel.z)
    const bobAmt = (speed / TIGER.walkSpeed) * CAMERA.bobAmp * (this.grounded ? 1 : 0.2)
    const bobY = Math.sin(this.bobPhase * 2) * bobAmt
    const bobX = Math.cos(this.bobPhase) * CAMERA.swayAmp * (speed / TIGER.walkSpeed)

    // Shake uses layered sines rather than random so it never jitters harshly.
    const s = this.camShake
    const st = this.shakeTime
    const shakeX = s * Math.sin(st * 47) * 0.16
    const shakeY = s * Math.sin(st * 61 + 1.3) * 0.16
    const shakeR = s * Math.sin(st * 39 + 2.1) * 0.05

    this.camera.position.set(
      this.pos.x + bobX * 0.35 + shakeX,
      this.pos.y + this.eyeY + bobY + this.recoilY - this.landImpact + shakeY,
      this.pos.z + shakeY * 0.2,
    )
    this.camera.rotation.set(this.pitch + shakeY * 0.4, this.yaw, bobX * 0.08 + shakeR, 'YXZ')

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
    this.pawState = 'idle'
    this.resetPaws()
  }
}
