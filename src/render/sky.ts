/**
 * The dusk sky.
 *
 * Three's Sky is a Preetham atmospheric-scattering model with a drifting cloud
 * layer, which gives a physically-shaped horizon gradient for free: the deep
 * blue zenith, the orange band, and the hot Mie lobe around the sun all fall
 * out of the sun elevation rather than being hand-picked colours.
 *
 * The same dome is prefiltered into an environment map, so every material in
 * the scene picks up its ambient light from the actual sky it is standing
 * under instead of from a flat AmbientLight.
 */
import * as THREE from 'three'
import { Sky as SkyDome } from 'three/examples/jsm/objects/Sky.js'
import { SKY, WORLD } from '../config'
import { sunDirection } from './atmosphere'

export class Sky {
  readonly sunDir = sunDirection()
  /** Where the sun sits in world space. Drives the shadow camera and god rays. */
  readonly sunPos = new THREE.Vector3()

  private dome: SkyDome
  private stars: THREE.Points
  private time = 0

  constructor(private scene: THREE.Scene) {
    this.sunPos.copy(this.sunDir).multiplyScalar(SKY.radius * 0.9)

    this.dome = new SkyDome()
    this.dome.scale.setScalar(SKY.radius)
    const u = this.dome.material.uniforms
    u.turbidity!.value = SKY.turbidity
    u.rayleigh!.value = SKY.rayleigh
    u.mieCoefficient!.value = SKY.mieCoefficient
    u.mieDirectionalG!.value = SKY.mieDirectionalG
    u.sunPosition!.value.copy(this.sunPos)
    u.cloudCoverage!.value = 0.44
    u.cloudDensity!.value = 0.55
    u.cloudScale!.value = 0.00016
    u.cloudSpeed!.value = SKY.cloudDrift
    u.cloudElevation!.value = 0.62
    // See SKY.domeIntensity: the model's absolute radiance is far too hot to
    // composite against, so scale it at the point it is written.
    const mat = this.dome.material
    mat.uniforms.skyIntensity = { value: SKY.domeIntensity }
    mat.fragmentShader = mat.fragmentShader
      .replace('void main() {', 'uniform float skyIntensity;\nvoid main() {')
      .replace('gl_FragColor = vec4( texColor, 1.0 );', 'gl_FragColor = vec4( texColor * skyIntensity, 1.0 );')
    // The dome writes linear HDR; the composer's OutputPass owns tone mapping
    // and the transfer function. Leaving this on double-tone-maps the sky.
    mat.toneMapped = false
    this.dome.frustumCulled = false
    this.dome.renderOrder = -1000
    scene.add(this.dome)

    this.stars = buildStars(this.sunDir)
    scene.add(this.stars)

    this.installLights()
  }

  // ------------------------------------------------------------------ light
  readonly sun = new THREE.DirectionalLight(SKY.sunLight, SKY.sunIntensity)

  private installLights() {
    const s = this.sun
    // Shadow-caster distance is a compromise: far enough that the treeline
    // still casts, near enough that 2k of shadow map has usable texel density.
    const dist = 150
    s.position.copy(this.sunDir).multiplyScalar(dist)
    s.castShadow = true
    s.shadow.mapSize.set(4096, 4096)
    const c = s.shadow.camera
    c.left = -95; c.right = 95; c.top = 95; c.bottom = -95
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
    this.scene.add(new THREE.HemisphereLight(SKY.skyBounce, SKY.groundBounce, SKY.bounceIntensity))
  }

  // -------------------------------------------------------------------- IBL
  /**
   * Prefilter the dome into a radiance map. Must run after the renderer exists
   * and before the first frame; the result is static for the whole session.
   */
  buildEnvironment(renderer: THREE.WebGLRenderer) {
    const pmrem = new THREE.PMREMGenerator(renderer)
    pmrem.compileEquirectangularShader()

    // fromScene() renders a cube from the origin, so the dome has to be in a
    // scene of its own — anything else in the world would bake into the IBL.
    const capture = new THREE.Scene()
    const clone = this.dome.clone()
    clone.material = this.dome.material // shared: same uniforms, same look
    capture.add(clone)

    const target = pmrem.fromScene(capture, 0, 1, SKY.radius * 2)
    this.scene.environment = target.texture
    this.scene.environmentIntensity = SKY.envIntensity
    pmrem.dispose()
  }

  // ------------------------------------------------------------------ frame
  update(dt: number, viewer: THREE.Vector3) {
    this.time += dt
    this.dome.material.uniforms.time!.value = this.time
    // Sky and stars ride with the player so the horizon never runs away.
    this.dome.position.set(viewer.x, 0, viewer.z)
    this.stars.position.set(viewer.x, 0, viewer.z)

    // Keep the shadow frustum centred on the player instead of the origin —
    // otherwise everything past ~95 m from the village loses its shadows.
    this.sun.target.position.set(viewer.x, 0, viewer.z)
    this.sun.target.updateMatrixWorld()
    this.sun.position.copy(this.sunDir).multiplyScalar(150).add(this.sun.target.position)
  }
}

/**
 * Faint stars, brightest in the anti-solar half of the sky. At this sun
 * elevation only the darkest quarter of the dome is dim enough to show them,
 * so they read as a subtle grain rather than a night sky.
 */
function buildStars(sunDir: THREE.Vector3): THREE.Points {
  const count = 900
  const pos = new Float32Array(count * 3)
  const alpha = new Float32Array(count)
  const r = SKY.radius * 0.85
  let written = 0

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
    // Wash out anywhere near the sun or the bright horizon band.
    const away = (1 - Math.max(0, d.dot(sunDir))) * 0.5 + 0.5
    const high = THREE.MathUtils.smoothstep(d.y, 0.12, 0.75)
    const a = away * high * (0.25 + Math.random() * 0.75)
    if (a < 0.06) continue
    pos[written * 3] = d.x * r
    pos[written * 3 + 1] = d.y * r
    pos[written * 3 + 2] = d.z * r
    alpha[written] = a
    written++
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, written * 3), 3))
  geo.setAttribute('alpha', new THREE.BufferAttribute(alpha.subarray(0, written), 1))

  const mat = new THREE.ShaderMaterial({
    uniforms: {},
    vertexShader: /* glsl */ `
      attribute float alpha;
      varying float vAlpha;
      void main() {
        vAlpha = alpha;
        vec4 mv = modelViewMatrix * vec4( position, 1.0 );
        gl_PointSize = 1.0 + alpha * 2.2;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      void main() {
        float d = length( gl_PointCoord - 0.5 );
        float a = smoothstep( 0.5, 0.1, d ) * vAlpha;
        if ( a < 0.01 ) discard;
        gl_FragColor = vec4( vec3( 0.85, 0.9, 1.0 ) * a * 0.55, 1.0 );
      }
    `,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    transparent: true,
    toneMapped: false,
  })

  const points = new THREE.Points(geo, mat)
  points.renderOrder = -999
  points.frustumCulled = false
  return points
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
