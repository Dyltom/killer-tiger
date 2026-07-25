/**
 * One pooled Points system for every burst effect: blood, dust, sparks, gore.
 * Additive off, vertex-coloured, gravity-affected, no allocation per burst.
 */
import * as THREE from 'three'
import { terrainHeight } from '../world/world'

const MAX = 1400

export class Particles {
  private geo = new THREE.BufferGeometry()
  private points: THREE.Points
  private pos = new Float32Array(MAX * 3)
  private col = new Float32Array(MAX * 3)
  private size = new Float32Array(MAX)
  private vel = new Float32Array(MAX * 3)
  private life = new Float32Array(MAX)
  private maxLife = new Float32Array(MAX)
  private gravity = new Float32Array(MAX)
  private cursor = 0

  constructor(scene: THREE.Scene) {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3))
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1))

    const mat = new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: /* glsl */ `
        attribute float size;
        varying vec3 vColor;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          // Clamped: an unbounded perspective size turns a single blood droplet
          // a metre from the eye into a screen-filling disc.
          gl_PointSize = clamp(size * (300.0 / -mv.z), 1.0, 64.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.18, length(d));
          if (a < 0.02) discard;
          gl_FragColor = vec4(vColor, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      vertexColors: true,
    })

    this.points = new THREE.Points(this.geo, mat)
    this.points.frustumCulled = false
    // Park unused particles far below the world.
    for (let i = 0; i < MAX; i++) this.pos[i * 3 + 1] = -1000
    scene.add(this.points)
  }

  private emit(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    r: number, g: number, b: number,
    s: number, life: number, grav: number,
  ) {
    const i = this.cursor
    this.cursor = (this.cursor + 1) % MAX
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz
    this.col[i * 3] = r; this.col[i * 3 + 1] = g; this.col[i * 3 + 2] = b
    this.size[i] = s
    this.life[i] = life
    this.maxLife[i] = life
    this.gravity[i] = grav
  }

  /** Arterial spray in a cone along `dir`. */
  blood(p: THREE.Vector3, dir: THREE.Vector3, amount = 26, power = 1) {
    for (let i = 0; i < amount; i++) {
      const spread = 0.75
      const vx = dir.x * power * 6 + (Math.random() - 0.5) * spread * 9
      const vy = dir.y * power * 4 + Math.random() * 5.5 + 1
      const vz = dir.z * power * 6 + (Math.random() - 0.5) * spread * 9
      const dark = 0.45 + Math.random() * 0.5
      this.emit(
        p.x, p.y, p.z, vx, vy, vz,
        0.62 * dark, 0.045 * dark, 0.06 * dark,
        4 + Math.random() * 7, 0.85 + Math.random() * 0.7, 20,
      )
    }
  }

  /** Chunky gore for kills — bigger, slower, redder. */
  gore(p: THREE.Vector3, amount = 18) {
    for (let i = 0; i < amount; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = 2 + Math.random() * 6
      this.emit(
        p.x, p.y, p.z,
        Math.cos(a) * sp, 3 + Math.random() * 6, Math.sin(a) * sp,
        0.35 + Math.random() * 0.25, 0.03, 0.05,
        7 + Math.random() * 9, 1.1 + Math.random(), 22,
      )
    }
  }

  dust(p: THREE.Vector3, amount = 14, tint = 0.42) {
    for (let i = 0; i < amount; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = 1 + Math.random() * 3.5
      this.emit(
        p.x, p.y + 0.05, p.z,
        Math.cos(a) * sp, Math.random() * 1.6, Math.sin(a) * sp,
        tint, tint * 0.92, tint * 0.7,
        6 + Math.random() * 10, 0.55 + Math.random() * 0.5, 2.2,
      )
    }
  }

  sparks(p: THREE.Vector3, amount = 10) {
    for (let i = 0; i < amount; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = 2 + Math.random() * 8
      this.emit(
        p.x, p.y, p.z,
        Math.cos(a) * sp, Math.random() * 5, Math.sin(a) * sp,
        1, 0.72, 0.24,
        2 + Math.random() * 4, 0.3 + Math.random() * 0.3, 14,
      )
    }
  }

  muzzle(p: THREE.Vector3, dir: THREE.Vector3) {
    for (let i = 0; i < 9; i++) {
      this.emit(
        p.x, p.y, p.z,
        dir.x * (6 + Math.random() * 10) + (Math.random() - 0.5) * 3,
        dir.y * 6 + (Math.random() - 0.5) * 3,
        dir.z * (6 + Math.random() * 10) + (Math.random() - 0.5) * 3,
        1, 0.85, 0.42,
        5 + Math.random() * 7, 0.1 + Math.random() * 0.1, 1,
      )
    }
  }

  /** Rising embers / pickup pop. */
  pop(p: THREE.Vector3, r: number, g: number, b: number, amount = 20) {
    for (let i = 0; i < amount; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = 1 + Math.random() * 3
      this.emit(
        p.x, p.y, p.z,
        Math.cos(a) * sp, 2 + Math.random() * 4, Math.sin(a) * sp,
        r, g, b,
        4 + Math.random() * 6, 0.5 + Math.random() * 0.5, -1.5,
      )
    }
  }

  update(dt: number) {
    const pos = this.pos
    const vel = this.vel
    let dirty = false
    for (let i = 0; i < MAX; i++) {
      if (this.life[i]! <= 0) continue
      dirty = true
      this.life[i]! -= dt
      const i3 = i * 3
      vel[i3 + 1]! -= this.gravity[i]! * dt
      pos[i3]! += vel[i3]! * dt
      pos[i3 + 1]! += vel[i3 + 1]! * dt
      pos[i3 + 2]! += vel[i3 + 2]! * dt

      // Splat and stick when it hits dirt.
      const gy = terrainHeight(pos[i3]!, pos[i3 + 2]!)
      if (pos[i3 + 1]! < gy + 0.02) {
        pos[i3 + 1] = gy + 0.02
        vel[i3] = vel[i3 + 1] = vel[i3 + 2] = 0
        this.life[i] = Math.min(this.life[i]!, 0.25)
      }

      // Shrink out over the tail of the lifetime.
      const t = this.life[i]! / this.maxLife[i]!
      this.size[i]! *= t < 0.35 ? 1 - dt * 4 : 1

      if (this.life[i]! <= 0) {
        pos[i3 + 1] = -1000
        this.size[i] = 0
      }
    }
    if (dirty) {
      this.geo.attributes.position!.needsUpdate = true
      this.geo.attributes.color!.needsUpdate = true
      this.geo.attributes.size!.needsUpdate = true
    }
  }
}
