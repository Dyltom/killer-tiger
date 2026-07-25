/**
 * World pickups. Kills drop meat; the village scatters relics and herbs.
 * Adding a new one is a single entry in PICKUP_TYPES.
 */
import * as THREE from 'three'
import { PICKUP } from '../config'
import { terrainHeight } from '../world/world'

export type PickupId = 'meat' | 'adrenaline' | 'ironClaws' | 'ironHide' | 'relic' | 'rageIdol'

export interface PickupDef {
  id: PickupId
  label: string
  color: number
  /** Radius of the glow halo. */
  glow: number
  build: () => THREE.Object3D
}

const mat = (color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...opts })

export const PICKUP_TYPES: Record<PickupId, PickupDef> = {
  meat: {
    id: 'meat',
    label: 'Fresh Meat',
    color: 0xb1343a,
    glow: 0.9,
    build: () => {
      const g = new THREE.Group()
      const flesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.28, 0), mat(0x9d2b30, { flatShading: true }))
      flesh.scale.set(1.2, 0.7, 0.9)
      const bone = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.05, 0.52, 6),
        mat(0xe8dcc4, { roughness: 0.85 }),
      )
      bone.rotation.z = Math.PI / 2
      g.add(flesh, bone)
      return g
    },
  },
  adrenaline: {
    id: 'adrenaline',
    label: 'Adrenaline Herb',
    color: 0x5ce07a,
    glow: 1.1,
    build: () => {
      const g = new THREE.Group()
      for (let i = 0; i < 5; i++) {
        const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.42, 4), mat(0x4fc76c, { flatShading: true }))
        const a = (i / 5) * Math.PI * 2
        leaf.position.set(Math.cos(a) * 0.08, 0.2, Math.sin(a) * 0.08)
        leaf.rotation.set(Math.cos(a) * 0.4, 0, Math.sin(a) * -0.4)
        g.add(leaf)
      }
      return g
    },
  },
  ironClaws: {
    id: 'ironClaws',
    label: 'Iron Claws',
    color: 0xd8dde6,
    glow: 1.1,
    build: () => {
      const g = new THREE.Group()
      for (let i = 0; i < 3; i++) {
        const claw = new THREE.Mesh(
          new THREE.ConeGeometry(0.05, 0.44, 5),
          mat(0xc9d1dc, { metalness: 0.85, roughness: 0.25 }),
        )
        claw.position.set((i - 1) * 0.14, 0.2, 0)
        claw.rotation.z = (i - 1) * 0.28
        g.add(claw)
      }
      return g
    },
  },
  ironHide: {
    id: 'ironHide',
    label: 'Iron Hide',
    color: 0x8fb8ff,
    glow: 1.1,
    build: () => {
      const g = new THREE.Group()
      const shell = new THREE.Mesh(
        new THREE.SphereGeometry(0.3, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
        mat(0x7a95c4, { metalness: 0.6, roughness: 0.35, side: THREE.DoubleSide }),
      )
      shell.position.y = 0.16
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.035, 6, 20), mat(0xb9c9e8, { metalness: 0.7 }))
      rim.rotation.x = Math.PI / 2
      rim.position.y = 0.16
      g.add(shell, rim)
      return g
    },
  },
  relic: {
    id: 'relic',
    label: 'Gold Relic',
    color: 0xffc94a,
    glow: 1.3,
    build: () => {
      const g = new THREE.Group()
      const body = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.26, 0),
        mat(0xffc030, { metalness: 0.95, roughness: 0.18, emissive: 0x3a2600 }),
      )
      body.position.y = 0.26
      g.add(body)
      return g
    },
  },
  rageIdol: {
    id: 'rageIdol',
    label: 'Blood Idol',
    color: 0xff5a1f,
    glow: 1.5,
    build: () => {
      const g = new THREE.Group()
      const idol = new THREE.Mesh(
        new THREE.TetrahedronGeometry(0.32, 0),
        mat(0xd23a12, { emissive: 0x511405, roughness: 0.5 }),
      )
      idol.position.y = 0.28
      g.add(idol)
      return g
    },
  },
}

export class Pickup {
  readonly group = new THREE.Group()
  id: PickupId = 'meat'
  active = false
  age = 0
  private spin = 0
  private halo: THREE.Mesh
  private beam: THREE.Mesh
  private glow = 1
  private models = new Map<PickupId, THREE.Object3D>()
  /** Emissive materials of the active model, retinted on spawn. */
  private emissives: THREE.MeshStandardMaterial[] = []

  constructor() {
    // Additive, not a PointLight. Every live PointLight changes the scene's
    // light count, and three keys its shader programs on that count — so a
    // pickup spawning or expiring recompiled every material in the world and
    // stalled the frame. An additive shell reads the same at a fraction of the
    // cost and costs nothing to switch on and off.
    this.halo = new THREE.Mesh(
      new THREE.SphereGeometry(0.42, 10, 8),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
      }),
    )
    this.halo.position.y = 0.24
    this.group.add(this.halo)

    // A soft shaft standing on the drop, so a pickup in long grass still reads
    // from across the plain — the job the point light's falloff used to do.
    this.beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.5, 3.2, 8, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.075,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    )
    this.beam.position.y = 1.6
    this.group.add(this.beam)

    // Build every model once; show only the active one.
    for (const def of Object.values(PICKUP_TYPES)) {
      const m = def.build()
      m.visible = false
      m.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = true })
      this.models.set(def.id, m)
      this.group.add(m)
    }
    this.group.visible = false
  }

  spawn(id: PickupId, x: number, z: number) {
    this.id = id
    this.active = true
    this.age = 0
    this.spin = Math.random() * Math.PI * 2
    const def = PICKUP_TYPES[id]
    for (const [key, m] of this.models) m.visible = key === id
    ;(this.halo.material as THREE.MeshBasicMaterial).color.setHex(def.color)
    ;(this.beam.material as THREE.MeshBasicMaterial).color.setHex(def.color)
    this.glow = def.glow

    // Bloom is what sells the glow, so the model itself has to be over 1.0 in
    // HDR. Collected here so the pulse below only walks a short list.
    this.emissives.length = 0
    this.models.get(id)?.traverse((o) => {
      if (o instanceof THREE.Mesh && o.material instanceof THREE.MeshStandardMaterial) {
        o.material.emissive.setHex(def.color)
        this.emissives.push(o.material)
      }
    })
    this.group.position.set(x, terrainHeight(x, z), z)
    this.group.visible = true
  }

  despawn() {
    this.active = false
    this.group.visible = false
  }

  update(dt: number, time: number) {
    if (!this.active) return
    this.age += dt
    this.spin += dt * PICKUP.spinSpeed
    const model = this.models.get(this.id)
    if (model) {
      model.rotation.y = this.spin
      model.position.y = Math.sin(time * PICKUP.bobSpeed + this.spin) * PICKUP.bobHeight + PICKUP.bobHeight
    }
    const pulse = 0.5 + Math.sin(time * 3 + this.spin) * 0.5
    ;(this.halo.material as THREE.MeshBasicMaterial).opacity = (0.2 + pulse * 0.16) * this.glow
    ;(this.beam.material as THREE.MeshBasicMaterial).opacity = (0.05 + pulse * 0.035) * this.glow
    const e = (0.55 + pulse * 0.45) * this.glow
    for (const m of this.emissives) m.emissiveIntensity = e
    // Blink out over the final three seconds so its loss is never a surprise.
    const left = PICKUP.lifetime - this.age
    if (left < 3) this.group.visible = Math.sin(this.age * 22) > -0.3
    if (this.age > PICKUP.lifetime) this.despawn()
  }
}
