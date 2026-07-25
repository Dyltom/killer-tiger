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
import { DAY, SHADOW, SKY, WORLD } from '../config'
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
    u.cloudCoverage!.value = SKY.cloudCoverage
    u.cloudDensity!.value = SKY.cloudDensity
    u.cloudScale!.value = SKY.cloudScale
    u.cloudSpeed!.value = SKY.cloudDrift
    u.cloudElevation!.value = SKY.cloudElevation
    // See SKY.domeIntensity: the model's absolute radiance is far too hot to
    // composite against, so scale it at the point it is written.
    const mat = this.dome.material
    mat.uniforms.skyIntensity = { value: SKY.domeIntensity }
    mat.uniforms.nightZenith = { value: new THREE.Color(DAY.nightZenith) }
    mat.uniforms.nightHorizon = { value: new THREE.Color(DAY.nightHorizon) }
    mat.uniforms.cloudMoon = { value: new THREE.Color(SKY.cloudMoon) }
    mat.uniforms.cloudBright = { value: SKY.cloudBright }
    mat.uniforms.nightAmount = { value: 0 }
    mat.uniforms.sunGlow = { value: 1 }
    mat.fragmentShader = mat.fragmentShader
      .replace('void main() {', /* glsl */ `
        uniform float skyIntensity;
        uniform vec3 nightZenith;
        uniform vec3 nightHorizon;
        uniform vec3 cloudMoon;
        uniform float cloudBright;
        uniform float nightAmount;
        uniform float sunGlow;
        // How much cloud this pixel ended up with, carried out of the stock
        // cloud block below so the night gradient can be occluded by it.
        float gCloud;
        void main() {
          gCloud = 0.0;`)
      // See DayNight.sunGlow(). The Mie lobe is the only strongly
      // direction-dependent term in the model, so it is the one that reads as a
      // sun rather than as a sky — and because the model's sun is clamped just
      // under the horizon, its own fade freezes there and the lobe never went
      // out. Gating betaMTheta rather than mPhase keeps the two places Lin uses
      // it consistent, and leaves the broad Rayleigh remnant to light the night
      // horizon on its own.
      .replace(
        'vec3 betaMTheta = vBetaM * mPhase;',
        'vec3 betaMTheta = vBetaM * mPhase * sunGlow;',
      )
      // The stock shader projects the view ray onto a flat cloud plane by
      // dividing by direction.y, which goes to zero at the horizon — so the
      // noise coordinate goes to infinity there and `fract( sin( dot( huge,
      // ... ) ) )` runs out of mantissa. The horizon fade hides the result
      // either way, so this is insurance rather than a fix for anything
      // observed; it costs one instruction and caps the coordinate at a sane
      // value. 0.06 is about 3.5 degrees up, already inside the fade.
      .replace(
        'vec2 cloudUV = direction.xz / ( direction.y * elevation );',
        'vec2 cloudUV = direction.xz / ( max( direction.y, 0.06 ) * elevation );',
      )
      // Warp the noise lookup by a low-frequency sample of itself. Two octaves
      // of unwarped fbm on a flat plane read as a grid of soft blobs; pushing
      // the domain around bends the cell edges into something the wind has been
      // dragging, which is most of the difference between "noise" and "cloud".
      .replace('float cloudNoise = fbm( cloudUV * 1000.0 );', /* glsl */ `
        vec2 cq = cloudUV * 1000.0;
        vec2 cwarp = vec2( noise( cq * 0.5 + 11.3 ), noise( cq * 0.5 + 41.7 ) ) - 0.5;
        float cloudNoise = fbm( cq + cwarp * 1.4 );`)
      // The stock threshold is miscalibrated. This noise has a mean near 0.86
      // and a spread of about +/-0.07, so every coverage above roughly 0.2 puts
      // the entire dome over the threshold and the "clouds" become a flat grey
      // veil that just dims the sky — which is what an overcast-looking clear
      // day was. Renormalising onto 0..1 first makes cloudCoverage mean the
      // fraction of sky it says it does, and the narrower ramp gives the mask an
      // edge instead of a fifty-degree gradient.
      .replace(
        'float cloudMask = smoothstep( 1.0 - cloudCoverage, 1.0 - cloudCoverage + 0.3, cloudNoise );',
        /* glsl */ `
        float shaped = clamp( ( cloudNoise - 0.73 ) / 0.27, 0.0, 1.0 );
        float cloudMask = smoothstep( 1.0 - cloudCoverage, 1.0 - cloudCoverage + 0.2, shaped );`,
      )
      // See SKY.cloudBright: the stock constant leaves a lit cloud far darker
      // than the sky behind it, so cloud always subtracted light from the dome.
      //
      // The thickness term is the other half of it. We are underneath this deck,
      // so the fat middle of a cumulus is its shadowed base and the thin edges
      // are where the sun is coming through — without that gradient every cloud
      // is one flat value and the whole layer reads as cut paper.
      .replace('cloudColor *= vSunE * 0.00002;', /* glsl */ `
        cloudColor *= mix( 1.2, 0.4, smoothstep( 0.3, 0.95, shaped ) );
        cloudColor *= vSunE * cloudBright;`)
      // The stock shader multiplies cloud colour by the sun's intensity term,
      // which is zero once the sun is under the horizon — so without this the
      // night sky has black cumulus punched through the stars. Capture the mask
      // on the way past and give the cloud a moonlit floor.
      .replace('texColor = mix( texColor, cloudColor, cloudMask * cloudDensity );', /* glsl */ `
        gCloud = cloudMask * cloudDensity;
        cloudColor = max( cloudColor, cloudMoon * nightAmount );
        texColor = mix( texColor, cloudColor, gCloud );`)
      // See DAY.nightZenith: the scattering model bottoms out at black once the
      // sun is under the horizon, so the night sky is a gradient added on top
      // rather than anything the model produces. Cloud shades it — an overcast
      // patch is darker than clear sky and hides the stars behind it.
      .replace('gl_FragColor = vec4( texColor, 1.0 );', /* glsl */ `
        float upness = clamp( normalize( vWorldPosition ).y, 0.0, 1.0 );
        vec3 night = mix( nightHorizon, nightZenith, pow( upness, 0.55 ) );
        night = mix( night, night * 0.4 + cloudMoon * 0.5, gCloud );
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

  /** Half-width of the shadow box. Both fitShadow() and the texel snap need it. */
  private shadowExtent = 34
  /** How far up-sun the light sits from the box centre, derived by fitShadow(). */
  private shadowDist = 100

  private installLights() {
    const s = this.sun
    s.castShadow = true
    s.shadow.mapSize.set(2048, 2048)
    s.shadow.bias = SHADOW.bias
    s.shadow.normalBias = SHADOW.normalBias
    s.shadow.radius = SHADOW.radius
    // Provisional; the quality tier calls setShadowQuality() before the first
    // frame and re-fits at its own extent.
    this.fitShadow(this.shadowExtent)
    s.position.copy(this.sunDir).multiplyScalar(this.shadowDist)
    this.scene.add(s, s.target)

    // Sky/ground bounce on top of the IBL. The environment map handles most of
    // the ambient, but a hemisphere light is what keeps undersides from going
    // pure black on the low-end path where IBL intensity is dialled down.
    this.scene.add(this.bounce)
  }

  /**
   * Size the ortho box and bracket its depth range around it.
   *
   * The depth range is the whole point. `shadow.bias` is a fraction of
   * near..far, so a range chosen for the draw distance makes the bias worth
   * decimetres; a range that only just contains the box makes it worth
   * millimetres. Half the depth a caster can sit from the centre plane is the
   * box's half-diagonal (the sun can rake along either axis) plus the tallest
   * thing standing in it, and the light goes just outside that.
   */
  private fitShadow(extent: number) {
    this.shadowExtent = extent
    const halfDepth = extent * Math.SQRT2 + SHADOW.depthPad
    this.shadowDist = halfDepth + 8
    const c = this.sun.shadow.camera
    c.left = -extent; c.right = extent; c.top = extent; c.bottom = -extent
    c.near = 8
    c.far = this.shadowDist + halfDepth
    c.updateProjectionMatrix()
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
    this.fitShadow(extent)
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
    // The solar disc has to come out of the *bake*, and it is the single biggest
    // thing that was wrong with daylight in this game.
    //
    // Preetham draws the disc at sunE * 19000 — four orders of magnitude over the
    // sky around it — and PMREM prefilters that into the roughness-1 mip which
    // every diffuse surface reads as ambient. Measured at noon that was 8.5 units
    // of ground irradiance from the environment against 0.5 from the
    // DirectionalLight: sixteen times the key light, arriving from every direction
    // at once. Which is why the ground clipped to white all morning, why it got
    // worse toward midday and was fine at golden hour (the disc is extinguished at
    // a low sun) — and why the terrain lost its texture, since at a 5% key share
    // there was almost no directional light left for a normal map to shade
    // against. No exposure value can hold both ends of a 22x swing.
    //
    // The visible dome keeps its sun. Only the light bake loses it, and the energy
    // is back in DAY.phases' sunI where it can cast a shadow.
    const u = this.dome.material.uniforms
    const disc = u.showSunDisc!.value
    u.showSunDisc!.value = 0
    const previous = this.envTarget
    this.envTarget = this.pmrem.fromScene(this.envCapture, 0, 1, SKY.radius * 2)
    u.showSunDisc!.value = disc
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
    // Where the dome's sun is and whether it may be *seen* are two questions.
    // Both of these answer the second one from the true elevation, so the clamp
    // above can keep the model out of its black hole without also keeping a lit
    // sun on the horizon until dawn.
    u.showSunDisc!.value = this.day.sunDisc()
    u.sunGlow!.value = this.day.sunGlow()

    this.sun.color.copy(s.sun)
    // sunI is authored as ground irradiance, not as light intensity — the
    // elevation term is divided back out here. See DayNight.keyIntensity().
    this.sun.intensity = this.day.keyIntensity()
    this.bounce.color.copy(s.skyB)
    this.bounce.groundColor.copy(s.gndB)
    this.bounce.intensity = s.bounceI
    this.scene.environmentIntensity = s.env
    // See DayNight.nightSky: the darkness ramp on its own still had a sixth of
    // the night up at mid-morning, so the sky wore a navy veil and faint stars
    // with the sun well clear of the horizon.
    const night = this.day.nightSky
    this.starMat.uniforms.uAlpha!.value = night
    u.nightAmount!.value = night
    // The moon is the anti-solar point, so it is under the ground all day. Its
    // own horizon fade is what stops it being drawn there.
    ;(this.moon.material as THREE.ShaderMaterial).uniforms.uAlpha!.value = night * this.day.moonVisibility()

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
    // otherwise everything past one box-width from the village loses its
    // shadows. Snapped to whole shadow texels first: at 33 mm per texel the box
    // is small enough that an unsnapped centre re-rasterises every caster into
    // different texels every frame, and hard contact shadows crawl and shimmer
    // along their own edges as you walk. Snapping means walking slides the map
    // by whole texels, so an edge that is not moving in world space does not
    // move in the map either.
    const c = shadowCentre.set(viewer.x, 0, viewer.z)
    const f = this.sunDir
    // The same basis Object3D.lookAt() builds for the shadow camera: +Y up,
    // z pointing from the target back toward the light. Straight overhead the
    // cross product degenerates, so fall back to an arbitrary horizontal.
    if (Math.abs(f.y) > 0.999) lightRight.set(1, 0, 0)
    else lightRight.set(0, 1, 0).cross(f).normalize()
    lightUp.crossVectors(f, lightRight)
    const texel = (2 * this.shadowExtent) / this.sun.shadow.mapSize.x
    const u = Math.round(c.dot(lightRight) / texel) * texel
    const v = Math.round(c.dot(lightUp) / texel) * texel
    const w = c.dot(f)
    c.copy(lightRight).multiplyScalar(u).addScaledVector(lightUp, v).addScaledVector(f, w)

    this.sun.target.position.copy(c)
    this.sun.target.updateMatrixWorld()
    this.sun.position.copy(f).multiplyScalar(this.shadowDist).add(c)

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
const shadowCentre = new THREE.Vector3()
const lightRight = new THREE.Vector3()
const lightUp = new THREE.Vector3()

/**
 * Stars and moon sit on a sphere far outside the camera's 420 m far plane, so
 * their vertices would be clipped away entirely. Both vertex shaders push
 * gl_Position.z to w afterwards, which pins them to the far plane and sidesteps
 * the clip — the same trick three's own Sky uses.
 *
 * That pin is also what lets both of them depth-test, which they must. Additive
 * blending makes them transparent materials, and the transparent queue is drawn
 * after every opaque object in the world no matter what renderOrder says — so
 * with the test off, a moon behind a hut, a tree or the ground was drawn *over*
 * it. That is the "through the map" moon. Pinned, they land at depth 1.0, which
 * still passes on any pixel the world never wrote to, so the sky keeps them and
 * the world occludes them.
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
    // Explicit, and load-bearing: see PIN_TO_FAR.
    depthTest: true,
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
    // Explicit, and load-bearing: see PIN_TO_FAR.
    depthTest: true,
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
