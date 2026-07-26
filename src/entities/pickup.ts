/**
 * World pickups. Kills drop meat; the village scatters relics and herbs.
 * Adding a new one is a single entry in PICKUP_TYPES.
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
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

/**
 * An accent material: this one, and only this one, takes the pickup's tint and
 * pulses with it.
 *
 * Glowing every material of a model was a mistake worth writing down. Emissive
 * plus bloom saturates instantly, so a fully-emissive pickup renders as a white
 * blob with no shading, no colour and no silhouette — the models all looked
 * identical from five metres. One bright part against unlit ones is what makes
 * the shape readable and the colour survive the bloom pass.
 */
const glowMat = (color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) => {
  const m = mat(color, opts)
  m.userData.accent = true
  return m
}

/**
 * One mesh per material, not one per part.
 *
 * Only the active model of a pickup is visible, so its part count is its draw
 * count — five loose cones for a herb was five draw calls each, times seven
 * pickups on the ground. Merging by material lets these silhouettes get more
 * detailed while costing less than they did.
 *
 * Everything is de-indexed first: mergeGeometries silently returns null on a
 * mixed set, and three's polyhedra (Icosahedron, Tetrahedron) come non-indexed
 * while its lathes and boxes come indexed. The extra vertices are irrelevant at
 * these part counts.
 */
const lump = (parts: THREE.BufferGeometry[], material: THREE.Material): THREE.Mesh =>
  new THREE.Mesh(mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)), false)!, material)

/** Positioned primitive helpers; every model is built out of these. */
function at(g: THREE.BufferGeometry, x: number, y: number, z = 0, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
  if (rx) g.rotateX(rx)
  if (ry) g.rotateY(ry)
  if (rz) g.rotateZ(rz)
  g.translate(x, y, z)
  return g
}

/**
 * The shaft standing on a drop.
 *
 * A plain additive cylinder gives itself away: it has two hard vertical edges
 * where the tube ends, and light does not have edges. Fading by how square-on
 * the surface is to the eye takes those edges off, and costs one dot product.
 */
function buildBeam(): THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> {
  const geo = new THREE.CylinderGeometry(0.26, 0.66, BEAM_H, 14, 1, true)
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0xffffff) },
      uAlpha: { value: 0.3 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vV;
      varying float vY;
      void main() {
        vN = normalMatrix * normal;
        vec4 mv = modelViewMatrix * vec4( position, 1.0 );
        vV = -mv.xyz;
        vY = position.y / ${BEAM_H_GLSL} + 0.5;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uAlpha;
      varying vec3 vN;
      varying vec3 vV;
      varying float vY;
      void main() {
        // Two falloffs, both steep. Anything gentler and the tube renders as a
        // flat card of colour with a visible rectangular outline — the cylinder
        // has to give out well before it reaches its own edges.
        float up = pow( max( 1.0 - vY, 0.0 ), 1.6 );
        float edge = pow( abs( dot( normalize( vN ), normalize( vV ) ) ), 1.8 );
        float a = up * edge * uAlpha;
        if ( a < 0.002 ) discard;
        gl_FragColor = vec4( uColor * a, 1.0 );
      }
    `,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    side: THREE.DoubleSide,
    toneMapped: false,
  })
  return new THREE.Mesh(geo, material)
}

/** Bright at the ring's mid-radius, out to nothing at both edges. */
function fadeRing(g: THREE.BufferGeometry, inner: number, outer: number) {
  const pos = g.attributes.position!
  const col = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getZ(i))
    const t = (r - inner) / (outer - inner)
    const v = Math.sin(THREE.MathUtils.clamp(t, 0, 1) * Math.PI) ** 0.7
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = v
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
}

let glowTex: THREE.Texture | null = null

/** One shared radial-falloff sprite, built once and tinted per pickup. */
function glowTexture(): THREE.Texture {
  if (glowTex) return glowTex
  const size = 128
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  // Squared falloff rather than linear: a linear ramp still reads as a disc
  // with a visible boundary once bloom widens it.
  for (let i = 0; i <= 10; i++) {
    const t = i / 10
    g.addColorStop(t, `rgba(255,255,255,${((1 - t) ** 2.2).toFixed(3)})`)
  }
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  glowTex = new THREE.CanvasTexture(c)
  glowTex.colorSpace = THREE.SRGBColorSpace
  return glowTex
}

const BEAM_H = 4.2
const BEAM_H_GLSL = '4.2'

const MOTE_COUNT = 14

/**
 * Motes orbiting the drop. The orbit, the bob and the twinkle all live in the
 * vertex shader off one clock uniform, so the whole swarm is one draw call and
 * the CPU never touches the buffer after it is built.
 */
function buildMotes(): THREE.Points {
  const pos = new Float32Array(MOTE_COUNT * 3)
  const phase = new Float32Array(MOTE_COUNT)
  for (let i = 0; i < MOTE_COUNT; i++) {
    const a = (i / MOTE_COUNT) * Math.PI * 2
    const r = 0.5 + (i % 3) * 0.16
    pos[i * 3] = Math.cos(a) * r
    pos[i * 3 + 1] = 0.1 + (i % 5) * 0.13
    pos[i * 3 + 2] = Math.sin(a) * r
    phase[i] = i / MOTE_COUNT
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1))
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.4, 0), 1.4)

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0xffffff) },
      uTime: { value: 0 },
      uAlpha: { value: 1 },
    },
    vertexShader: /* glsl */ `
      attribute float aPhase;
      uniform float uTime;
      varying float vA;
      void main() {
        float t = uTime + aPhase * 6.2831;
        float a = uTime * 0.8 + aPhase * 6.2831;
        float r = length( position.xz );
        vec3 p = vec3( cos( a ) * r, position.y + sin( t * 1.6 ) * 0.16, sin( a ) * r );
        vec4 mv = modelViewMatrix * vec4( p, 1.0 );
        gl_PointSize = 42.0 / max( -mv.z, 0.4 );
        vA = 0.35 + 0.65 * ( 0.5 + 0.5 * sin( t * 2.4 ) );
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uAlpha;
      varying float vA;
      void main() {
        float d = length( gl_PointCoord - 0.5 );
        float a = smoothstep( 0.5, 0.05, d ) * vA * uAlpha;
        if ( a < 0.01 ) discard;
        gl_FragColor = vec4( uColor * a, 1.0 );
      }
    `,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    toneMapped: false,
  })

  const points = new THREE.Points(geo, material)
  points.renderOrder = 3
  return points
}

export const PICKUP_TYPES: Record<PickupId, PickupDef> = {
  meat: {
    id: 'meat',
    label: 'Fresh Meat',
    color: 0xb1343a,
    glow: 0.9,
    build: () => {
      const g = new THREE.Group()
      // A haunch on the bone, tilted so the femur crosses the silhouette
      // diagonally. Detail 1 rather than 0: a bare icosahedron read as a pitched
      // tent, and one subdivision is the difference between a tent and a joint
      // of meat for twenty extra triangles.
      const big = new THREE.IcosahedronGeometry(0.26, 1)
      big.scale(1.3, 0.86, 0.92)
      const small = new THREE.IcosahedronGeometry(0.15, 1)
      small.scale(1.15, 0.95, 1)
      g.add(lump([
        at(big, 0.02, 0.26, 0, 0, 0, 0.22),
        at(small, -0.19, 0.19, 0.04, 0, 0, 0.22),
      ], mat(0x7d1f24, { roughness: 0.45, flatShading: true })))
      const shaft = new THREE.CylinderGeometry(0.042, 0.042, 0.78, 6)
      g.add(lump([
        at(shaft, 0, 0.25, 0, 0, 0, Math.PI / 2 - 0.22),
        at(new THREE.SphereGeometry(0.085, 8, 6), 0.4, 0.34),
        at(new THREE.SphereGeometry(0.075, 8, 6), -0.38, 0.16),
      ], glowMat(0xd8ccb2, { roughness: 0.8 })))
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
      const leaves: THREE.BufferGeometry[] = []
      const pods: THREE.BufferGeometry[] = []
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2
        const lean = 0.34 + (i % 2) * 0.16
        const leaf = new THREE.ConeGeometry(0.075, 0.5 + (i % 2) * 0.1, 4)
        leaves.push(at(leaf, Math.cos(a) * 0.09, 0.24, Math.sin(a) * 0.09,
          Math.sin(a) * lean, 0, -Math.cos(a) * lean))
        // Seed heads on the outer leaves. These take the emissive tint, so the
        // herb has a couple of bright points instead of glowing all over like a
        // lamp — a plant that is lit reads better than a plant made of light.
        if (i % 2 === 0) {
          pods.push(at(new THREE.SphereGeometry(0.055, 7, 6), Math.cos(a) * 0.2, 0.45, Math.sin(a) * 0.2))
        }
      }
      g.add(lump(leaves, mat(0x3f9e55, { flatShading: true })))
      g.add(lump(pods, glowMat(0x7ff09a, { roughness: 0.4 })))
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
      // Three talons hooking up off a leather knuckle pad. The first two passes
      // both failed the same way — a flat torus with small arcs above read as a
      // doughnut, then as a coffee mug — because the base outweighed the claws.
      // The talons have to be the tallest and widest thing in the shape.
      const pad = new THREE.SphereGeometry(0.12, 10, 6)
      pad.scale(1.5, 0.55, 0.9)
      g.add(lump([at(pad, 0, 0.06)], mat(0x503722, { roughness: 0.85 })))

      const claws: THREE.BufferGeometry[] = []
      for (let i = 0; i < 3; i++) {
        const r = 0.42 - Math.abs(i - 1) * 0.07
        // Each talon is a quarter torus swept into the ZY plane: it leaves the
        // pad pointing back, rises, and hooks forward. Splayed on Y so they fan
        // like a paw rather than standing as three parallel bars.
        const arc = new THREE.TorusGeometry(r, 0.042, 6, 12, Math.PI * 0.55)
        arc.rotateY(Math.PI / 2)
        claws.push(at(arc, (i - 1) * 0.13, 0.05, r, -0.3, (i - 1) * 0.42))
        const tip = new THREE.ConeGeometry(0.038, 0.13, 6)
        tip.rotateX(Math.PI / 2)
        claws.push(at(tip, (i - 1) * 0.13, 0.05 + r * 0.93, r * 0.34 + 0.06, -0.3, (i - 1) * 0.42))
      }
      g.add(lump(claws, glowMat(0xc4cddb, { metalness: 0.9, roughness: 0.2 })))
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
      const shell = new THREE.SphereGeometry(0.31, 12, 7, 0, Math.PI * 2, 0, Math.PI / 2)
      const studs: THREE.BufferGeometry[] = []
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2
        studs.push(at(new THREE.SphereGeometry(0.042, 6, 5), Math.cos(a) * 0.22, 0.29, Math.sin(a) * 0.22))
      }
      g.add(lump([at(shell, 0, 0.16), ...studs], mat(0x6a83ad, { metalness: 0.65, roughness: 0.32 })))
      const rim = new THREE.TorusGeometry(0.31, 0.038, 6, 18)
      const boss = new THREE.SphereGeometry(0.075, 8, 6)
      g.add(lump([at(rim, 0, 0.16, 0, Math.PI / 2), at(boss, 0, 0.44)],
        glowMat(0x9fb2d4, { metalness: 0.75, roughness: 0.25 })))
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
      // A little cast figure on a stepped plinth. Silhouette matters more than
      // detail here: this has to be identifiable as loot from thirty metres.
      const plinth = new THREE.CylinderGeometry(0.2, 0.24, 0.1, 8)
      const step = new THREE.CylinderGeometry(0.14, 0.18, 0.07, 8)
      const torso = new THREE.CylinderGeometry(0.06, 0.11, 0.24, 7)
      const headBall = new THREE.SphereGeometry(0.07, 8, 6)
      const crown = new THREE.ConeGeometry(0.09, 0.13, 7)
      const arms = new THREE.BoxGeometry(0.3, 0.035, 0.05)
      g.add(lump([
        at(plinth, 0, 0.05), at(step, 0, 0.14), at(torso, 0, 0.3),
        at(headBall, 0, 0.47), at(crown, 0, 0.58), at(arms, 0, 0.36, 0, 0, 0, -0.35),
      ], glowMat(0xe8a828, { metalness: 0.95, roughness: 0.2 })))
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
      // Horned skull on a spike. Short stubby horns made this read as a mallet,
      // so each one is two cones at different angles — the kink is what says
      // horn, and it is cheaper than a swept tube.
      const skull = new THREE.IcosahedronGeometry(0.18, 0)
      skull.scale(1, 1.05, 1.2)
      const muzzle = new THREE.ConeGeometry(0.1, 0.28, 6)
      const post = new THREE.CylinderGeometry(0.045, 0.065, 0.34, 6)
      const horns: THREE.BufferGeometry[] = []
      for (const side of [-1, 1]) {
        const base = new THREE.ConeGeometry(0.058, 0.26, 6)
        horns.push(at(base, side * 0.15, 0.57, 0, 0, 0, -side * 0.95))
        const tip = new THREE.ConeGeometry(0.032, 0.2, 6)
        horns.push(at(tip, side * 0.29, 0.71, 0, 0, 0, -side * 0.32))
      }
      g.add(lump([
        at(post, 0, 0.17), at(skull, 0, 0.45),
        at(muzzle, 0, 0.42, -0.2, -Math.PI / 2), ...horns,
      ], glowMat(0xb8321a, { roughness: 0.5, flatShading: true })))
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
  private halo: THREE.Sprite
  private beam: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>
  private ring: THREE.Mesh
  private motes: THREE.Points
  private moteMat: THREE.ShaderMaterial
  private glow = 1
  private models = new Map<PickupId, THREE.Object3D>()
  /** Emissive materials of the active model, retinted on spawn. */
  private emissives: THREE.MeshStandardMaterial[] = []

  constructor() {
    // Additive, not a PointLight. Every live PointLight changes the scene's
    // light count, and three keys its shader programs on that count — so a
    // pickup spawning or expiring recompiled every material in the world and
    // stalled the frame. A billboarded glow reads the same at a fraction of the
    // cost and costs nothing to switch on and off.
    //
    // A sprite, not a sphere: an additive shell has a hard silhouette where it
    // ends, so every pickup wore a visible glass bubble. A radial falloff has no
    // edge to see.
    this.halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(),
      color: 0xffffff,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      // Additive layers must not be fogged. Fog mixes toward the fog colour,
      // which on an additive pass means distance makes the halo brighter
      // instead of dimmer — the drop across the plain glows harder than the
      // one at your feet. They fade correctly on their own, because the thing
      // they're drawn over is already fogged.
      fog: false,
    }))
    this.halo.scale.setScalar(1.5)
    this.halo.position.y = 0.32
    this.group.add(this.halo)

    // A soft shaft standing on the drop, so a pickup in long grass still reads
    // from across the plain — the job the point light's falloff used to do.
    // The vertex gradient is what stops it looking like a plastic tube: without
    // it the cylinder ends in a hard ring three metres up, which is the one
    // thing a shaft of light never does.
    this.beam = buildBeam()
    this.beam.position.y = BEAM_H / 2
    this.group.add(this.beam)

    // A ring burnt into the ground under it. Two jobs: it plants the drop on
    // the terrain instead of leaving it hovering over grass with no contact,
    // and it is the only part of a pickup you can still see when the item
    // itself is behind a rock.
    const ringGeo = new THREE.RingGeometry(0.34, 0.92, 26, 1)
    ringGeo.rotateX(-Math.PI / 2)
    fadeRing(ringGeo, 0.34, 0.92)
    this.ring = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        vertexColors: true,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
        fog: false,
      }),
    )
    this.ring.position.y = 0.03
    this.ring.renderOrder = 2
    this.group.add(this.ring)

    // Motes circling the drop — the thing that reads as "this is worth walking
    // over to" at a distance where the model is four pixels wide.
    this.motes = buildMotes()
    this.moteMat = this.motes.material as THREE.ShaderMaterial
    this.group.add(this.motes)

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
    this.halo.material.color.setHex(def.color)
    this.beam.material.uniforms.uColor!.value.setHex(def.color)
    ;(this.ring.material as THREE.MeshBasicMaterial).color.setHex(def.color)
    this.moteMat.uniforms.uColor!.value.setHex(def.color)
    this.glow = def.glow

    // Only the accent lump takes the tint; see glowMat. Collected here so the
    // pulse below walks two materials rather than the whole model.
    this.emissives.length = 0
    this.models.get(id)?.traverse((o) => {
      if (o instanceof THREE.Mesh && o.material instanceof THREE.MeshStandardMaterial
        && o.material.userData.accent) {
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
    this.halo.material.opacity = (0.26 + pulse * 0.2) * this.glow
    this.beam.material.uniforms.uAlpha!.value = (0.34 + pulse * 0.14) * this.glow
    ;(this.ring.material as THREE.MeshBasicMaterial).opacity = (0.34 + pulse * 0.22) * this.glow
    this.moteMat.uniforms.uTime!.value = time + this.spin
    this.moteMat.uniforms.uAlpha!.value = this.glow * 0.7
    const e = (0.3 + pulse * 0.3) * this.glow
    for (const m of this.emissives) m.emissiveIntensity = e
    // Blink out over the final three seconds so its loss is never a surprise.
    const left = PICKUP.lifetime - this.age
    if (left < 3) this.group.visible = Math.sin(this.age * 22) > -0.3
    if (this.age > PICKUP.lifetime) this.despawn()
  }
}
