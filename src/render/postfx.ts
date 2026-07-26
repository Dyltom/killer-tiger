/**
 * Post-processing chain.
 *
 *   scene ──► god rays ──► bloom ──► tone map ──► grade ──► SMAA ──► screen
 *
 * Everything up to the tone map runs in linear HDR (half-float), which is what
 * makes the bloom and the god rays pick up only genuinely bright pixels
 * instead of anything that happens to be pale.
 *
 * The chain is fill-bound rather than geometry-bound: its cost is a fixed number
 * of nanoseconds per pixel and it therefore scales with the square of the
 * device pixel ratio, which is why it is the part of the frame that falls over
 * first on a retina display. Both of the passes with real per-pixel work behind
 * them — the god rays' 28-tap radial trace and the bloom pyramid — are run at a
 * fraction of the frame's resolution and upsampled, because neither produces
 * anything a full-resolution buffer could represent that a half one cannot.
 *
 * The grade pass is where the film look comes from: split-toning, vignette,
 * chromatic aberration, grain and a light sharpen, plus the two gameplay hooks
 * (blood frenzy and near-death) that push the image without touching the HUD.
 */
import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js'
import { POST } from '../config'
import { sunScreenPosition } from './sky'

const FULLSCREEN_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`

/**
 * Ceiling on the HDR handed downstream. UnrealBloomPass does not subtract its
 * threshold — a pixel that passes goes into the blur pyramid at full value — so
 * the band around a low sun, which covers a big slice of the frame, gets smeared
 * over everything and comes back as a milky veil that buries the village. ACES
 * already maps 3.5 to ~0.95, so clamping here costs almost nothing on screen and
 * bounds what bloom can spread.
 */
const HDR_CEILING = 3.5

// --------------------------------------------------------------- god rays
/**
 * Radial blur of the bright parts of the frame, streaming away from the sun's
 * screen position (GPU Gems 3, "Volumetric Light Scattering as a Post-Process").
 *
 * There is no separate occlusion buffer: the scene's own depth already hides
 * the sky behind huts and trees, so the shafts break up against silhouettes
 * for free, which is the whole reason the effect sells.
 *
 * This is the trace half, and it runs at a fraction of the frame's resolution.
 * Twenty-eight taps per pixel over a full 4K-class frame is tens of millions of
 * texture fetches for something whose entire output is a soft radial smear —
 * there is nothing in a shaft of light that survives to a single pixel, so the
 * only thing full resolution buys is the bill.
 */
const GodRayTraceShader = {
  name: 'GodRayTrace',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uSun: { value: new THREE.Vector2(0.5, 0.5) },
    uStrength: { value: POST.godrayStrength },
    uDecay: { value: POST.godrayDecay },
    uAspect: { value: 1 },
  },
  vertexShader: FULLSCREEN_VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uSun;
    uniform float uStrength;
    uniform float uDecay;
    uniform float uAspect;
    varying vec2 vUv;

    const int SAMPLES = ${POST.godraySamples};
    const float DENSITY = 0.86;
    /**
     * The sky near a low sun is genuinely 10-30x white in linear HDR. Summing
     * raw samples therefore adds tens of units of light to every pixel and
     * blows the whole frame to paper. Two things keep it bounded: each sample
     * is clamped to a sane multiple of white before it is weighted, and the
     * accumulator is divided by the total weight so the result is an *average*
     * shaft brightness that uStrength scales linearly.
     */
    const float MAX_SAMPLE = 4.0;

    void main() {
      vec2 delta = ( vUv - uSun ) * ( DENSITY / float( SAMPLES ) );
      vec2 uv = vUv;
      float illum = 1.0;
      float wsum = 0.0;
      vec3 accum = vec3( 0.0 );

      for ( int i = 0; i < SAMPLES; i ++ ) {
        uv -= delta;
        vec3 s = texture2D( tDiffuse, clamp( uv, 0.0, 1.0 ) ).rgb;
        // Only near-blown pixels shed light; anything else just smears the
        // scene and looks like a dirty lens.
        float lum = dot( s, vec3( 0.2126, 0.7152, 0.0722 ) );
        s = min( s, vec3( MAX_SAMPLE ) ) * smoothstep( 1.0, 4.0, lum );
        accum += s * illum;
        wsum += illum;
        illum *= uDecay;
      }
      accum /= max( wsum, 1e-4 );

      // Fade out as the sun leaves the frame, or the shafts snap off abruptly.
      vec2 d = ( vUv - uSun ) * vec2( uAspect, 1.0 );
      float falloff = 1.0 - smoothstep( 0.15, 1.15, length( d ) );
      vec2 edge = smoothstep( vec2( -0.35 ), vec2( 0.12 ), uSun )
                * ( 1.0 - smoothstep( vec2( 0.88 ), vec2( 1.35 ), uSun ) );

      gl_FragColor = vec4( accum * uStrength * falloff * edge.x * edge.y, 1.0 );
    }
  `,
}

/**
 * ...and this is the half that has to run at full resolution: add the traced
 * shafts back over the sharp frame and apply the ceiling. Two fetches, and the
 * second of them is skipped outright when the sun is off screen — but the clamp
 * is not, because bloom needs the ceiling whether there are shafts or not.
 */
const GodRayCompositeShader = {
  name: 'GodRayComposite',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tRays: { value: null as THREE.Texture | null },
    uRays: { value: 0 },
  },
  vertexShader: FULLSCREEN_VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tRays;
    uniform float uRays;
    varying vec2 vUv;

    const float CEILING = ${HDR_CEILING.toFixed(1)};

    void main() {
      vec4 scene = texture2D( tDiffuse, vUv );
      vec3 col = scene.rgb;
      // Uniform branch: every pixel in the frame takes the same side of it, so
      // the fetch really is skipped rather than merely masked out.
      if ( uRays > 0.0 ) col += texture2D( tRays, vUv ).rgb;
      gl_FragColor = vec4( min( col, vec3( CEILING ) ), scene.a );
    }
  `,
}

/**
 * The two halves as one composer pass, with the small target between them.
 *
 * @param scale Resolution of the trace relative to the frame, per axis.
 */
class GodRayPass extends Pass {
  // Cloned, not shared: a ShaderMaterial built straight from a shader object
  // keeps a reference to that object's uniforms, so two passes from the same
  // definition would quietly write over each other.
  private traceMat = new THREE.ShaderMaterial({
    name: GodRayTraceShader.name,
    uniforms: THREE.UniformsUtils.clone(GodRayTraceShader.uniforms),
    vertexShader: GodRayTraceShader.vertexShader,
    fragmentShader: GodRayTraceShader.fragmentShader,
  })

  private compositeMat = new THREE.ShaderMaterial({
    name: GodRayCompositeShader.name,
    uniforms: THREE.UniformsUtils.clone(GodRayCompositeShader.uniforms),
    vertexShader: GodRayCompositeShader.vertexShader,
    fragmentShader: GodRayCompositeShader.fragmentShader,
  })

  /** The trace's uniforms — uSun, uStrength, uAspect are driven per frame. */
  readonly uniforms = this.traceMat.uniforms

  private trace = new FullScreenQuad(this.traceMat)
  private composite = new FullScreenQuad(this.compositeMat)
  private rays: THREE.WebGLRenderTarget

  constructor(width: number, height: number, private scale = 0.5) {
    super()
    // Half float to match the HDR chain: the shafts are summed from linear
    // values well above white, and an 8-bit target would band them.
    this.rays = new THREE.WebGLRenderTarget(
      Math.max(1, Math.round(width * scale)),
      Math.max(1, Math.round(height * scale)),
      { type: THREE.HalfFloatType, colorSpace: THREE.LinearSRGBColorSpace, depthBuffer: false },
    )
    this.compositeMat.uniforms.tRays!.value = this.rays.texture
  }

  override setSize(width: number, height: number) {
    this.rays.setSize(
      Math.max(1, Math.round(width * this.scale)),
      Math.max(1, Math.round(height * this.scale)),
    )
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ) {
    const on = this.uniforms.uStrength!.value > 0
    if (on) {
      this.uniforms.tDiffuse!.value = readBuffer.texture
      renderer.setRenderTarget(this.rays)
      this.trace.render(renderer)
    }

    this.compositeMat.uniforms.tDiffuse!.value = readBuffer.texture
    this.compositeMat.uniforms.uRays!.value = on ? 1 : 0
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer)
    if (this.clear) renderer.clear()
    this.composite.render(renderer)
  }

  override dispose() {
    this.rays.dispose()
    this.trace.dispose()
    this.composite.dispose()
    this.traceMat.dispose()
    this.compositeMat.dispose()
  }
}

// ------------------------------------------------------------------- grade
const GradeShader = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTexel: { value: new THREE.Vector2() },
    uTime: { value: 0 },
    /** 0..1 blood frenzy, 0..1 near-death, 0..1 nightfall. */
    uFrenzy: { value: 0 },
    uHurt: { value: 0 },
    uNight: { value: 0 },
    uVignette: { value: POST.vignette },
    uGrain: { value: POST.grain },
    uChroma: { value: POST.chromatic },
    uSaturation: { value: POST.saturation },
    uContrast: { value: POST.contrast },
    uSharpen: { value: POST.sharpen },
    uShadowTint: { value: new THREE.Color(POST.shadowTint) },
    uHighlightTint: { value: new THREE.Color(POST.highlightTint) },
    uToneStrength: { value: POST.toneStrength },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    uniform float uTime;
    uniform float uFrenzy;
    uniform float uHurt;
    uniform float uNight;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uChroma;
    uniform float uSaturation;
    uniform float uContrast;
    uniform float uSharpen;
    uniform vec3 uShadowTint;
    uniform vec3 uHighlightTint;
    uniform float uToneStrength;
    varying vec2 vUv;

    float luma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }

    float hash( vec2 p ) {
      return fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
    }

    void main() {
      vec2 centred = vUv - 0.5;
      float r2 = dot( centred, centred );

      // Chromatic aberration: zero in the middle, growing toward the corners
      // like a real lens. Frenzy cranks it hard.
      float ca = uChroma * ( 1.0 + uFrenzy * 7.0 ) * r2 * 4.0;
      vec3 col;
      col.r = texture2D( tDiffuse, vUv - centred * ca ).r;
      col.g = texture2D( tDiffuse, vUv ).g;
      col.b = texture2D( tDiffuse, vUv + centred * ca ).b;

      // Unsharp mask. Cheap four-tap; enough to put an edge back on fur and
      // thatch after the tone map softens everything.
      if ( uSharpen > 0.0 ) {
        vec3 blur = texture2D( tDiffuse, vUv + vec2( uTexel.x, 0.0 ) ).rgb
                  + texture2D( tDiffuse, vUv - vec2( uTexel.x, 0.0 ) ).rgb
                  + texture2D( tDiffuse, vUv + vec2( 0.0, uTexel.y ) ).rgb
                  + texture2D( tDiffuse, vUv - vec2( 0.0, uTexel.y ) ).rgb;
        col += ( col - blur * 0.25 ) * uSharpen;
      }

      col = max( col, 0.0 );

      // Split-tone: push shadows cool and highlights warm around the midpoint.
      float l = luma( col );
      vec3 tint = mix( uShadowTint, uHighlightTint, smoothstep( 0.12, 0.75, l ) );
      col = mix( col, col * tint * 2.0, uToneStrength );

      // Saturation, then contrast about mid-grey.
      col = mix( vec3( luma( col ) ), col, uSaturation );
      col = ( col - 0.5 ) * uContrast + 0.5;

      // Night eye. Adding more lights to the world can only ever fix the places
      // that have lamps in them; the other 95% of a 240 m plain is lit by the
      // moon and nothing else, and no amount of point lights reaches it. So the
      // dark is handled here instead, where it costs one pass and no shader
      // recompiles: the eye adapts rather than the world getting brighter.
      if ( uNight > 0.0 ) {
        // A gamma toe. An exponent below one lifts the shadows hard and leaves
        // white exactly where it was, so the moonlit ground comes up out of the
        // black without the sky or a campfire blowing out.
        vec3 lifted = pow( max( col, 0.0 ), vec3( 1.0 / ( 1.0 + uNight * 0.9 ) ) );
        col = mix( col, lifted, 0.85 );

        // Rods carry no colour, and they only carry anything at all below about
        // a tenth of daylight. Weighting the drain by how dim the pixel already
        // is means fire, lamps and lit doorways keep their warmth while the
        // hillside behind them goes to moonlight blue — which is the whole
        // reason this reads as an eye adapting instead of a blue filter.
        float nl = luma( col );
        float rods = uNight * ( 1.0 - smoothstep( 0.06, 0.42, nl ) );
        col = mix( col, vec3( nl ) * vec3( 0.70, 0.85, 1.16 ), rods * 0.55 );
      }

      // Frenzy: everything runs hot and red, and the world desaturates around it.
      if ( uFrenzy > 0.0 ) {
        vec3 hot = vec3( luma( col ) ) * vec3( 1.55, 0.42, 0.3 );
        col = mix( col, mix( col, hot, 0.72 ), uFrenzy );
      }
      // Near death: colour drains inward from the edges and the frame darkens.
      // Ramping the drain by screen radius rather than applying it flat is the
      // difference between tunnel vision and a monochrome filter — at full hurt
      // the old flat 0.75 turned the entire frame red-grey, which looks like a
      // broken render and, worse, makes the prey you are chasing unreadable
      // exactly when you most need to see it.
      if ( uHurt > 0.0 ) {
        // A heartbeat under the whole thing. It shares no state with the DOM
        // layer that pulses over the top — they only have to be the same
        // tempo, and drifting slightly apart reads as a pulse rather than as
        // one animation, which is the point.
        float beat = pow( max( sin( uTime * ( 5.4 + uHurt * 3.0 ) ), 0.0 ), 6.0 );
        float drain = uHurt * ( 0.26 + smoothstep( 0.03, 0.6, r2 ) * 0.7 );
        col = mix( col, vec3( luma( col ) ) * vec3( 1.02, 0.7, 0.66 ), drain );
        // Blood in the shadows, so even the lit centre of frame goes wrong.
        col = mix( col, col * vec3( 1.15, 0.62, 0.58 ), uHurt * 0.45 );
        // And a wash of arterial red on each beat, strongest at the edges.
        col += vec3( 0.16, 0.012, 0.02 ) * beat * uHurt * uHurt * ( 0.35 + r2 * 2.2 );
        col *= 1.0 - uHurt * 0.22;
      }

      // Vignette. Uses a smooth radial falloff rather than a hard ellipse so
      // it never shows a visible ring on a bright sky. It backs off at night:
      // darkening the corners of an already dark frame costs the player the
      // peripheral vision they need to spot a hunter, and buys nothing.
      float vig = 1.0 - uVignette * ( 1.0 - uNight * 0.55 ) * ( 1.0 + uHurt * 1.5 )
                * smoothstep( 0.12, 0.78, r2 );
      col *= vig;

      // Grain, scaled down in the highlights the way film actually behaves, and
      // up at night — a dark-adapted eye is a noisy one, and the grain is also
      // what keeps the lifted shadows from banding.
      float g = hash( vUv * 900.0 + fract( uTime ) * 137.0 ) - 0.5;
      col += g * uGrain * ( 1.0 + uNight * 1.2 ) * ( 1.0 - smoothstep( 0.35, 1.0, luma( col ) ) * 0.7 );

      gl_FragColor = vec4( clamp( col, 0.0, 1.0 ), 1.0 );
    }
  `,
}

/**
 * Resolution the bloom pyramid is built at, relative to the frame.
 *
 * UnrealBloomPass already halves what it is handed before it builds its mips,
 * so this is a quarter-resolution pyramid — and the blur levels are where all
 * the pass's cost is, since each one is a 9- to 13-tap separable kernel run
 * twice. At a bloom strength of 0.06 there is nothing in the result that a
 * quarter-resolution blur could not represent; the visible output is a soft
 * halo around the sun and the fires, and it is upsampled bilinearly anyway.
 */
const BLOOM_SCALE = 0.5

export class PostFX {
  readonly composer: EffectComposer
  readonly godrays: GodRayPass
  readonly grade: ShaderPass
  readonly bloom: UnrealBloomPass
  private smaa: SMAAPass
  private sunUv = new THREE.Vector2()
  private time = 0
  private godraysOn = true

  constructor(
    private renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    private sunDir: THREE.Vector3,
  ) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2())

    // Half-float so the HDR range survives all the way to the tone map.
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      colorSpace: THREE.LinearSRGBColorSpace,
      samples: 0,
      depthBuffer: true,
    })
    this.composer = new EffectComposer(renderer, target)

    this.composer.addPass(new RenderPass(scene, camera))

    this.godrays = new GodRayPass(size.x, size.y)
    this.composer.addPass(this.godrays)

    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(size.x * BLOOM_SCALE, size.y * BLOOM_SCALE),
      POST.bloomStrength,
      POST.bloomRadius,
      POST.bloomThreshold,
    )
    this.composer.addPass(this.bloom)

    // Tone map + transfer function. Everything after this point is display-referred.
    this.composer.addPass(new OutputPass())

    this.grade = new ShaderPass(GradeShader)
    this.composer.addPass(this.grade)

    // SMAA last so it antialiases the graded image, including the sharpen.
    this.smaa = new SMAAPass()
    this.composer.addPass(this.smaa)

    this.setSize(innerWidth, innerHeight)
  }

  /**
   * Switch passes on and off for the quality tier. Disabled passes stay in the
   * chain — a ShaderPass with `enabled = false` is skipped entirely, and keeping
   * it allocated means climbing back a tier costs nothing.
   */
  setQuality(p: { godrays: boolean; bloom: boolean; smaa: boolean }) {
    // The god-ray pass also owns the HDR ceiling that keeps bloom from veiling
    // the frame, so it stays enabled and just stops tracing when it is "off".
    this.godraysOn = p.godrays
    this.bloom.enabled = p.bloom
    this.smaa.enabled = p.smaa
  }

  setSize(w: number, h: number) {
    // The composer caches the pixel ratio it was built with, so a quality tier
    // change has to be pushed through here or the render targets stay at the
    // old resolution and the tier does nothing.
    this.composer.setPixelRatio(this.renderer.getPixelRatio())
    this.composer.setSize(w, h)
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2())
    // The composer has just sized every pass to the full frame, bloom included,
    // so its pyramid has to be put back down afterwards rather than before.
    this.bloom.setSize(size.x * BLOOM_SCALE, size.y * BLOOM_SCALE)
    this.grade.uniforms.uTexel!.value.set(1 / size.x, 1 / size.y)
    this.godrays.uniforms.uAspect!.value = w / h
  }

  /** @param frenzy 0..1 @param hurt 0..1 @param night 0..1, DayNight.darkness */
  render(dt: number, frenzy: number, hurt: number, night = 0) {
    this.time += dt

    const visible = sunScreenPosition(this.sunDir, this.camera, this.sunUv)
    this.godrays.uniforms.uSun!.value.copy(this.sunUv)
    this.godrays.uniforms.uStrength!.value = visible && this.godraysOn ? POST.godrayStrength : 0

    const g = this.grade.uniforms
    g.uTime!.value = this.time
    g.uFrenzy!.value = frenzy
    g.uHurt!.value = hurt
    // Kneed, not scaled: `darkness` still reads 0.18 with the sun 17 degrees up,
    // and the night eye was lifting and desaturating the morning because of it.
    // Above nightEyeFull the multiplier is exactly 1, so the night is unchanged.
    const dark = night * THREE.MathUtils.smoothstep(night, POST.nightEyeOnset, POST.nightEyeFull)
    g.uNight!.value = dark * POST.nightEye
    // Frenzy also blows the bloom out, which is what makes it read as a rush
    // rather than a colour filter.
    this.bloom.strength = POST.bloomStrength * (1 + frenzy * 1.6)

    this.composer.render(dt)
  }
}
