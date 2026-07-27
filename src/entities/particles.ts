/**
 * One pooled Points system for every burst effect: blood, dust, sparks, gore.
 * Additive off, vertex-coloured, gravity-affected, no allocation per burst.
 */
import * as THREE from 'three'
import { atmosphere } from '../render/atmosphere'
import { textures } from '../world/textures'
import { WIND_DIR } from '../world/wind'
import { terrainHeight } from '../world/world'

const MAX = 1400

/**
 * Continuous smoke columns share the burst pool, so the whole village together
 * has to stay a small fraction of the 1400 slots: at this rate and a ~5 s life,
 * five fires hold about 70 slots between them.
 */
const SMOKE_RATE = 2.5

interface SmokeSource { x: number; y: number; z: number; acc: number }
const smokeSources: SmokeSource[] = []

/** Register a standing smoke column, e.g. above a campfire. World coordinates. */
export function addSmokeSource(x: number, y: number, z: number) {
  smokeSources.push({ x, y, z, acc: Math.random() })
}

/**
 * Scene depth for the soft fade, provided by the post chain. Optional: without
 * it the material compiles without SOFT_DEPTH and particles keep hard edges.
 * Registered through module state because the particle system and the post
 * chain are constructed by different owners in either order.
 */
let sceneDepth: { tex: THREE.Texture; near: number; far: number } | null = null
let softMat: THREE.ShaderMaterial | null = null

export function setSceneDepth(tex: THREE.Texture, near: number, far: number) {
  sceneDepth = { tex, near, far }
  if (softMat) applySoftDepth(softMat)
}

function applySoftDepth(mat: THREE.ShaderMaterial) {
  if (!sceneDepth) return
  mat.uniforms.uDepth!.value = sceneDepth.tex
  ;(mat.uniforms.uNearFar!.value as THREE.Vector2).set(sceneDepth.near, sceneDepth.far)
  mat.defines = { ...mat.defines, SOFT_DEPTH: '' }
  mat.needsUpdate = true
}

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
  private alpha = new Float32Array(MAX)
  /** Per-particle ceiling on alpha — smoke is translucent from birth. */
  private baseAlpha = new Float32Array(MAX)
  private cursor = 0
  /** Accumulated from dt, so it tracks the clock updateWind() is fed. */
  private time = 0

  constructor(scene: THREE.Scene) {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3))
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1))
    this.geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1))

    const mat = new THREE.ShaderMaterial({
      // The shared soft sprite, rather than the smoothstep disc this used to
      // draw. A hand-rolled falloff gives every particle the same flat edge
      // profile; the sprite has a hot core and a long tail, which is what makes
      // a blood spray look wet and an ember look like it is glowing.
      // Fogged, like everything else in the world. These are the only sprites
      // in the game that were not: a spray thrown at thirty metres came out as
      // crisp arterial red dots in front of terrain the haze had washed to grey,
      // which is exactly the read of a particle system sitting on top of a
      // scene rather than in it. The chunks are the game's own height-fog
      // override, so the four extra uniforms have to be supplied by hand — a
      // raw ShaderMaterial gets nothing from ShaderLib.
      uniforms: {
        uMap: { value: textures().spark },
        // Inert until the post chain hands over a depth texture — see
        // setSceneDepth(); the shader only references them under SOFT_DEPTH.
        uDepth: { value: null },
        uNearFar: { value: new THREE.Vector2(0.1, 1000) },
        ...THREE.UniformsLib.fog,
        fogSunDir: { value: atmosphere.sunDir },
        fogSunColor: { value: atmosphere.sunColor },
        fogAwayColor: { value: atmosphere.awayColor },
        fogParams: { value: atmosphere.params },
      },
      fog: true,
      vertexShader: /* glsl */ `
        #include <fog_pars_vertex>
        attribute float size;
        attribute float alpha;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vViewZ;
        void main() {
          vColor = color;
          vAlpha = alpha;
          // Named for the fog chunk, which reads mvPosition and nothing else.
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          // size is a diameter in metres. 700 is half the viewport height
          // divided by tan(fov/2) at the shipping 75 degree FOV, so a 0.1 m
          // droplet four metres out covers about 17 px — the number it would
          // cover if it were real geometry. Clamped because an unbounded
          // perspective size turns one droplet near the eye into a full-screen
          // disc.
          gl_PointSize = clamp(size * (700.0 / -mvPosition.z), 1.0, 90.0);
          vViewZ = -mvPosition.z;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vViewZ;
        #include <packing>
        #ifdef SOFT_DEPTH
        uniform sampler2D uDepth;
        uniform vec2 uNearFar;
        #endif
        #include <fog_pars_fragment>
        void main() {
          float a = texture2D(uMap, gl_PointCoord).a * vAlpha;
          #ifdef SOFT_DEPTH
          {
            // uDepth is a copy blitted after the previous frame's scene pass:
            // WebGL forbids sampling a depth attachment of the framebuffer
            // being drawn, so the fade runs one frame behind. texelFetch needs
            // no resolution uniform.
            float d = texelFetch(uDepth, ivec2(gl_FragCoord.xy), 0).r;
            float sceneZ = -perspectiveDepthToViewZ(d, uNearFar.x, uNearFar.y);
            a *= clamp((sceneZ - vViewZ) * 2.5, 0.0, 1.0);
          }
          #endif
          if (a < 0.02) discard;
          gl_FragColor = vec4(vColor, a);
          #include <fog_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      vertexColors: true,
    })

    softMat = mat
    applySoftDepth(mat)

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
    s: number, life: number, grav: number, a = 1,
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
    this.alpha[i] = a
    this.baseAlpha[i] = a
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
        0.055 + Math.random() * 0.1, 0.85 + Math.random() * 0.7, 20,
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
        0.08 + Math.random() * 0.1, 1.1 + Math.random(), 22,
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
        0.22 + Math.random() * 0.36, 0.55 + Math.random() * 0.5, 2.2,
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
        0.025 + Math.random() * 0.04, 0.3 + Math.random() * 0.3, 14,
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
        0.1 + Math.random() * 0.14, 0.1 + Math.random() * 0.1, 1,
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
        0.05 + Math.random() * 0.08, 0.5 + Math.random() * 0.5, -1.5,
      )
    }
  }

  /** One puff of smoke off a registered source, angled by the current gust. */
  private emitSmoke(s: SmokeSource) {
    // Gust constants (0.42 rate, 0.035 front wavelength) must match wind.ts,
    // so a column leans hardest on the same phase the grass bends on.
    const front = s.x * WIND_DIR.x + s.z * WIND_DIR.y
    let gust = Math.sin(this.time * 0.42 - front * 0.035) * 0.5 + 0.5
    gust *= gust
    const drift = 0.35 + gust * 1.1
    const grey = 0.3 + Math.random() * 0.1
    this.emit(
      s.x + (Math.random() - 0.5) * 0.3, s.y, s.z + (Math.random() - 0.5) * 0.3,
      WIND_DIR.x * drift + (Math.random() - 0.5) * 0.25,
      0.85 + Math.random() * 0.4,
      WIND_DIR.y * drift + (Math.random() - 0.5) * 0.25,
      grey, grey, grey * 1.06,
      // Negative gravity is buoyancy — the column keeps accelerating gently
      // upward for its whole life instead of coasting to a stop.
      0.9 + Math.random() * 0.8, 4.5 + Math.random() * 2, -0.16,
      0.3,
    )
  }

  update(dt: number) {
    this.time += dt

    for (const s of smokeSources) {
      s.acc += dt * SMOKE_RATE
      // Bounded per source, so a stalled tab's huge dt cannot flood the pool.
      let burst = 4
      while (s.acc >= 1 && burst-- > 0) {
        s.acc -= 1
        this.emitSmoke(s)
      }
      s.acc = Math.min(s.acc, 1)
    }

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

      // Shrink out over the tail of the lifetime, and fade with it. Shrinking
      // alone makes particles vanish as hard little dots; fading is what lets
      // dust and smoke dissolve.
      const t = this.life[i]! / this.maxLife[i]!
      this.size[i]! *= t < 0.35 ? 1 - dt * 4 : 1
      this.alpha[i] = this.baseAlpha[i]! * (t < 0.45 ? t / 0.45 : 1)

      if (this.life[i]! <= 0) {
        pos[i3 + 1] = -1000
        this.size[i] = 0
        this.alpha[i] = 0
      }
    }
    if (dirty) {
      this.geo.attributes.position!.needsUpdate = true
      this.geo.attributes.color!.needsUpdate = true
      this.geo.attributes.size!.needsUpdate = true
      this.geo.attributes.alpha!.needsUpdate = true
    }
  }
}
