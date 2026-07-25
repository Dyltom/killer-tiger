/**
 * The sky, over a whole day.
 *
 * Three's Sky is a Preetham atmospheric-scattering model with a drifting cloud
 * layer, which gives a physically-shaped horizon gradient for free: the deep
 * blue zenith, the orange band, and the hot Mie lobe around the sun all fall
 * out of the sun elevation rather than being hand-picked colours.
 *
 * DayNight owns the clock and the palette; this owns the objects that palette
 * is written into — the dome, the key light, the stars and the environment map.
 * The environment map is the only expensive one, so it is re-baked on sun
 * movement rather than on time, and reuses one generator for the session.
 */
import * as THREE from 'three'
import { Sky as SkyDome } from 'three/examples/jsm/objects/Sky.js'
import { DAY, SKY, WORLD } from '../config'
import { atmosphere } from './atmosphere'
import { DayNight } from './daynight'

export class Sky {
  readonly day = new DayNight()
  /**
   * Direction to whatever is lighting the scene — sun by day, moon by night.
   * God rays and the haze tint both key off this, so it has to be the visible
   * body rather than the astronomical sun.
   */
  readonly sunDir: THREE.Vector3

  private dome: SkyDome
  private stars: THREE.Points
  private starMat: THREE.ShaderMaterial
  private moon: THREE.Points
  private time = 0

  constructor(private scene: THREE.Scene) {
    this.sunDir = this.day.keyDir

    this.dome = new SkyDome()
    this.dome.scale.setScalar(SKY.radius)
    const u = this.dome.material.uniforms
    u.cloudCoverage!.value = 0.44
    u.cloudDensity!.value = 0.55
    u.cloudScale!.value = 0.00016
    u.cloudSpeed!.value = SKY.cloudDrift
    u.cloudElevation!.value = 0.62
    // See SKY.domeIntensity: the model's absolute radiance is far too hot to
    // composite against, so scale it at the point it is written.
    const mat = this.dome.material
    mat.uniforms.skyIntensity = { value: SKY.domeIntensity }
    mat.uniforms.nightZenith = { value: new THREE.Color(DAY.nightZenith) }
    mat.uniforms.nightHorizon = { value: new THREE.Color(DAY.nightHorizon) }
    mat.uniforms.nightAmount = { value: 0 }
    mat.fragmentShader = mat.fragmentShader
      .replace('void main() {', /* glsl */ `
        uniform float skyIntensity;
        uniform vec3 nightZenith;
        uniform vec3 nightHorizon;
        uniform float nightAmount;
        void main() {`)
      // See DAY.nightZenith: the scattering model bottoms out at black once the
      // sun is under the horizon, so the night sky is a gradient added on top
      // rather than anything the model produces.
      .replace('gl_FragColor = vec4( texColor, 1.0 );', /* glsl */ `
        float upness = clamp( normalize( vWorldPosition ).y, 0.0, 1.0 );
        vec3 night = mix( nightHorizon, nightZenith, pow( upness, 0.55 ) );
        gl_FragColor = vec4( texColor * skyIntensity + night * nightAmount, 1.0 );`)
    // The dome writes linear HDR; the composer's OutputPass owns tone mapping
    // and the transfer function. Leaving this on double-tone-maps the sky.
    mat.toneMapped = false
    this.dome.frustumCulled = false
    this.dome.renderOrder = -1000
    scene.add(this.dome)

    const stars = buildStars()
    this.stars = stars.points
    this.starMat = stars.material
    this.moon = buildMoon()
    scene.add(this.stars, this.moon)

    this.installLights()
    this.applyState()
  }

  // ------------------------------------------------------------------ light
  readonly sun = new THREE.DirectionalLight(SKY.sunLight, SKY.sunIntensity)
  private bounce = new THREE.HemisphereLight(SKY.skyBounce, SKY.groundBounce, SKY.bounceIntensity)

  private installLights() {
    const s = this.sun
    // Shadow-caster distance is a compromise: far enough that the treeline
    // still casts, near enough that 2k of shadow map has usable texel density.
    const dist = 150
    s.position.copy(this.sunDir).multiplyScalar(dist)
    s.castShadow = true
    s.shadow.mapSize.set(2048, 2048)
    const c = s.shadow.camera
    c.left = -90; c.right = 90; c.top = 90; c.bottom = -90
    c.near = 1; c.far = dist * 2.4
    s.shadow.bias = -0.0006
    s.shadow.normalBias = 0.05
    // A low sun rakes across the terrain, so shadows are long and their edges
    // are the main thing selling the time of day. Soften them a little.
    s.shadow.radius = 2.2
    this.scene.add(s, s.target)

    // Sky/ground bounce on top of the IBL. The environment map handles most of
    // the ambient, but a hemisphere light is what keeps undersides from going
    // pure black on the low-end path where IBL intensity is dialled down.
    this.scene.add(this.bounce)
  }

  /**
   * Resize the shadow map and pull its frustum in for the quality tier. The old
   * map has to be disposed by hand or the driver keeps both alive; three then
   * reallocates at the new size on the next shadow render.
   */
  setShadowQuality(size: number, extent: number) {
    const s = this.sun
    if (s.shadow.mapSize.x !== size) {
      s.shadow.mapSize.set(size, size)
      s.shadow.map?.dispose()
      s.shadow.map = null
    }
    const c = s.shadow.camera
    c.left = -extent; c.right = extent; c.top = extent; c.bottom = -extent
    c.updateProjectionMatrix()
  }

  // -------------------------------------------------------------------- IBL
  private pmrem: THREE.PMREMGenerator | null = null
  private envTarget: THREE.WebGLRenderTarget | null = null
  private envCapture: THREE.Scene | null = null
  private bakedAt = Infinity

  /**
   * Prefilter the dome into a radiance map. Must run once after the renderer
   * exists and before the first frame; after that it is refreshed from
   * update() whenever the sun has moved far enough to matter.
   */
  buildEnvironment(renderer: THREE.WebGLRenderer) {
    this.pmrem = new THREE.PMREMGenerator(renderer)
    this.pmrem.compileEquirectangularShader()

    // fromScene() renders a cube from the origin, so the dome has to be in a
    // scene of its own — anything else in the world would bake into the IBL.
    this.envCapture = new THREE.Scene()
    const clone = this.dome.clone()
    clone.material = this.dome.material // shared: same uniforms, same look
    this.envCapture.add(clone)

    this.bakeEnvironment()
  }

  private bakeEnvironment() {
    if (!this.pmrem || !this.envCapture) return
    const previous = this.envTarget
    this.envTarget = this.pmrem.fromScene(this.envCapture, 0, 1, SKY.radius * 2)
    this.scene.environment = this.envTarget.texture
    // Disposing after the swap, so the scene is never pointing at a freed texture.
    previous?.dispose()
    this.bakedAt = this.day.state.elevation
  }

  // ------------------------------------------------------------------ frame
  /** Push the current palette into the dome, the lights and the fog uniforms. */
  private applyState() {
    const s = this.day.state
    const u = this.dome.material.uniforms
    u.turbidity!.value = s.turbidity
    u.rayleigh!.value = s.rayleigh
    u.mieCoefficient!.value = s.mie
    u.mieDirectionalG!.value = SKY.mieDirectionalG
    u.skyIntensity!.value = s.dome
    // The dome follows the true sun, held just under the horizon after dusk;
    // everything else follows whichever body is actually giving light.
    domeSun.setFromSphericalCoords(
      SKY.radius * 0.9,
      THREE.MathUtils.degToRad(90 - this.day.domeElevation()),
      // setFromSphericalCoords puts theta on the x/z plane as (sin, cos).
      Math.atan2(this.day.sunDir.x, this.day.sunDir.z),
    )
    u.sunPosition!.value.copy(domeSun)

    this.sun.color.copy(s.sun)
    this.sun.intensity = s.sunI
    this.bounce.color.copy(s.skyB)
    this.bounce.groundColor.copy(s.gndB)
    this.bounce.intensity = s.bounceI
    this.scene.environmentIntensity = s.env
    this.starMat.uniforms.uAlpha!.value = s.stars
    u.nightAmount!.value = s.stars
    ;(this.moon.material as THREE.ShaderMaterial).uniforms.uAlpha!.value = s.stars

    // Shared by reference with every fog-enabled material in the scene.
    this.day.keyDir.toArray(atmosphere.sunDir)
    s.fogSun.toArray(atmosphere.sunColor)
    s.fogAway.toArray(atmosphere.awayColor)
    atmosphere.params[0] = s.density
  }

  update(dt: number, viewer: THREE.Vector3) {
    this.time += dt
    this.day.advance(dt)
    this.applyState()

    this.dome.material.uniforms.time!.value = this.time
    // Sky and stars ride with the player so the horizon never runs away.
    this.dome.position.set(viewer.x, 0, viewer.z)
    this.stars.position.set(viewer.x, 0, viewer.z)
    // The moon is the anti-solar point at night, so it rises as the sun sets
    // and is always opposite whatever the golden hour was.
    this.moon.position.set(viewer.x, 0, viewer.z)
    moonAt.copy(this.day.sunDir).negate().multiplyScalar(STAR_RADIUS)
    this.moon.geometry.attributes.position!.setXYZ(0, moonAt.x, moonAt.y, moonAt.z)
    this.moon.geometry.attributes.position!.needsUpdate = true

    // Keep the shadow frustum centred on the player instead of the origin —
    // otherwise everything past ~95 m from the village loses its shadows.
    this.sun.target.position.set(viewer.x, 0, viewer.z)
    this.sun.target.updateMatrixWorld()
    this.sun.position.copy(this.sunDir).multiplyScalar(150).add(this.sun.target.position)

    // A PMREM bake is several milliseconds, so it happens on sun *movement*.
    // Over a full cycle that is about thirty bakes rather than forty thousand.
    if (Math.abs(this.day.state.elevation - this.bakedAt) > DAY.envStepDegrees) this.bakeEnvironment()
  }

  /** Ambient light level, 0..1. Gameplay uses it: prey see less in the dark. */
  get daylight(): number {
    return THREE.MathUtils.clamp((this.day.state.elevation + 8) / 20, 0, 1)
  }
}

const domeSun = new THREE.Vector3()
const moonAt = new THREE.Vector3()

/**
 * Stars and moon sit on a sphere far outside the camera's 420 m far plane, so
 * their vertices would be clipped away entirely. Both vertex shaders push
 * gl_Position.z to w afterwards, which pins them to the far plane and sidesteps
 * the clip — the same trick three's own Sky uses.
 */
const STAR_RADIUS = SKY.radius * 0.85
const PIN_TO_FAR = 'gl_Position.z = gl_Position.w;'

/**
 * Faint stars over the whole upper hemisphere. Their brightness is a uniform so
 * the whole field can fade in at dusk without rebuilding the geometry.
 */
function buildStars(): { points: THREE.Points; material: THREE.ShaderMaterial } {
  const count = 900
  const pos = new Float32Array(count * 3)
  const alpha = new Float32Array(count)
  const r = STAR_RADIUS

  for (let i = 0; i < count; i++) {
    // Uniform on the upper hemisphere.
    const u = Math.random()
    const phi = Math.acos(1 - u * 0.96)
    const theta = Math.random() * Math.PI * 2
    const d = new THREE.Vector3(
      Math.sin(phi) * Math.cos(theta),
      Math.cos(phi),
      Math.sin(phi) * Math.sin(theta),
    )
    // Thin them out toward the horizon, where the haze would swallow them.
    const high = THREE.MathUtils.smoothstep(d.y, 0.02, 0.5)
    pos[i * 3] = d.x * r
    pos[i * 3 + 1] = d.y * r
    pos[i * 3 + 2] = d.z * r
    alpha[i] = high * (0.25 + Math.random() * 0.75)
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1))

  const material = new THREE.ShaderMaterial({
    uniforms: { uAlpha: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute float alpha;
      uniform float uAlpha;
      varying float vAlpha;
      void main() {
        vAlpha = alpha * uAlpha;
        vec4 mv = modelViewMatrix * vec4( position, 1.0 );
        gl_PointSize = 1.6 + alpha * 2.6 * uAlpha;
        gl_Position = projectionMatrix * mv;
        ${PIN_TO_FAR}
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      void main() {
        float d = length( gl_PointCoord - 0.5 );
        float a = smoothstep( 0.5, 0.1, d ) * vAlpha;
        if ( a < 0.01 ) discard;
        gl_FragColor = vec4( vec3( 0.85, 0.9, 1.0 ) * a * 0.9, 1.0 );
      }
    `,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    transparent: true,
    toneMapped: false,
  })

  const points = new THREE.Points(geo, material)
  points.renderOrder = -999
  points.frustumCulled = false
  return { points, material }
}

/**
 * The moon: one point, sized in pixels, shaded as a lit disc with a wide halo.
 * A single splat rather than a mesh because it never needs to be more than a
 * few dozen pixels across, and this way it costs one vertex.
 */
function buildMoon(): THREE.Points {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3))
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), SKY.radius)

  const material = new THREE.ShaderMaterial({
    uniforms: { uAlpha: { value: 0 }, uSize: { value: DAY.moonSize } },
    vertexShader: /* glsl */ `
      uniform float uSize;
      uniform float uAlpha;
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        ${PIN_TO_FAR}
        gl_PointSize = uSize * ${DAY.moonGlow.toFixed(2)};
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uAlpha;
      void main() {
        vec2 p = gl_PointCoord - 0.5;
        float d = length( p ) * ${DAY.moonGlow.toFixed(2)};
        // Hard-ish disc, then a broad falloff for the halo the haze would give it.
        float disc = smoothstep( 0.5, 0.44, d );
        float halo = pow( max( 1.0 - d * 0.55, 0.0 ), 4.0 ) * 0.5;
        // A faint terminator so it reads as a sphere, not a sticker.
        float lit = 0.72 + 0.28 * smoothstep( -0.45, 0.35, -p.x - p.y * 0.35 );
        vec3 col = vec3( 0.86, 0.9, 1.0 ) * ( disc * lit * 2.2 + halo );
        float a = clamp( disc + halo, 0.0, 1.0 ) * uAlpha;
        if ( a < 0.004 ) discard;
        gl_FragColor = vec4( col * uAlpha, 1.0 );
      }
    `,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    transparent: true,
    toneMapped: false,
  })

  const moon = new THREE.Points(geo, material)
  moon.renderOrder = -998
  moon.frustumCulled = false
  return moon
}

/**
 * Sun position in normalised screen space (0..1), plus whether it is in front
 * of the camera at all. The god-ray pass needs both.
 */
export function sunScreenPosition(
  sunDir: THREE.Vector3,
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector2,
): boolean {
  const p = sunDir.clone().multiplyScalar(WORLD.radius * 8).add(camera.position)
  const view = p.clone().applyMatrix4(camera.matrixWorldInverse)
  if (view.z > -0.001) return false // behind the camera
  p.project(camera)
  target.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5)
  return true
}
