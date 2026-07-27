/**
 * Post-processing chain.
 *
 *   scene ─┬─────────────────────────────────────────┐
 *          ├─► god rays (½) ─┬──────────────────────►├─► tone map + grade ─► FXAA ─► screen
 *                            └─► bloom pyramid (¼) ─►┘
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
 * The other half of the cost is not per-pixel at all. Every pass is a render
 * target bind, and on a tile-based GPU that is a full load and store of the
 * attachment whether the shader does anything or not — measured at 2.5 ms a
 * frame with *nothing in the scene*, and unchanged by halving the resolution.
 * So the chain is built to be short rather than to be modular: the god-ray
 * composite, the HDR ceiling, the bloom composite, the tone map, the transfer
 * function and the grade are one shader and one pass, not six. Nine renders a
 * frame with everything on, four with bloom and antialiasing off.
 *
 * The grade is where the film look comes from: split-toning, vignette,
 * chromatic aberration, grain and a light sharpen, plus the two gameplay hooks
 * (blood frenzy and near-death) that push the image without touching the HUD.
 */
import * as THREE from 'three'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js'
import { POST } from '../config'
import { setSceneDepth } from '../entities/particles'
import { sunScreenPosition } from './sky'

const FULLSCREEN_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`

/**
 * Ceiling on the HDR handed to the bloom. A pixel that passes the threshold
 * goes into the blur pyramid at full value — and the band around a low sun,
 * which covers a big slice of the frame, would otherwise get smeared over
 * everything and come back as a milky veil that buries the village. ACES
 * already maps 3.5 to ~0.95, so clamping costs almost nothing on screen and
 * bounds what bloom can spread.
 */
const HDR_CEILING = 3.5

/** Levels in the bloom pyramid, the first at a quarter of the frame per axis. */
const BLOOM_LEVELS = 3
const BLOOM_SCALE = 0.25

/** Half-float, no depth: what every intermediate in the HDR half of the chain is. */
function hdrTarget(w: number, h: number) {
  return new THREE.WebGLRenderTarget(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), {
    type: THREE.HalfFloatType,
    colorSpace: THREE.LinearSRGBColorSpace,
    depthBuffer: false,
  })
}

/** Full-screen materials never test or write depth; saying so avoids a clear. */
/**
 * `toneMapped: false` is load-bearing, and its absence cost the whole picture.
 *
 * three compiles a separate program per material *per destination*, because
 * `outputColorSpace` and `toneMapping` are both part of the program cache key
 * and both are forced off when the destination is a render target. So a
 * material that only ever draws into a target gets one prefix, and the moment
 * the same material draws to the canvas it gets a second, different one — with
 * `<tonemapping_pars_fragment>` prepended, which declares `RRTAndODTFit`. The
 * grade shader below declares its own, copied from that very chunk. Duplicate
 * definition, link failure, `useProgram` on a dead program: GL_INVALID_OPERATION
 * and a black canvas.
 *
 * That is why the black screen only appeared on Low. Every other tier ends on
 * FXAA, so the grade only ever drew into `gradeRT` and compiled the harmless
 * variant; `smaa: false` sends it to the canvas, where it compiles the broken
 * one. Verified by removing the cause and watching the symptom go: renaming the
 * function alone renders the frame, restoring the name blacks it again.
 *
 * The error *is* reported, once, on the compile — but a program is cached
 * forever after, so it scrolls past at the instant the tier first drops and
 * every subsequent black frame is silent. A tier sweep that samples the canvas
 * sees the failure with no error beside it.
 *
 * These materials all tone map themselves, or deliberately don't; none of them
 * wants three's chunk. Switching it off is both what they mean and what keeps
 * the two prefixes identical, so the canvas can never get a program the render
 * target never proved.
 */
function screenMaterial(fragmentShader: string, uniforms: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })
}

// --------------------------------------------------------------- god rays
/**
 * Radial blur of the bright parts of the frame, streaming away from the sun's
 * screen position (GPU Gems 3, "Volumetric Light Scattering as a Post-Process").
 *
 * There is no separate occlusion buffer: the scene's own depth already hides
 * the sky behind huts and trees, so the shafts break up against silhouettes
 * for free, which is the whole reason the effect sells.
 *
 * This is the whole of it — the trace, at a fraction of the frame's resolution.
 * Twenty-eight taps per pixel over a full 4K-class frame is tens of millions of
 * texture fetches for something whose entire output is a soft radial smear, and
 * adding the result back over the sharp frame is two instructions the final
 * pass does on its way past.
 */
const GOD_RAY_FRAG = /* glsl */ `
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
`

// ------------------------------------------------------------------ bloom
/**
 * First rung of the pyramid: everything the bloom will ever be made of.
 *
 * It reads the scene *and* the shafts, applies the ceiling, subtracts the
 * threshold with a soft knee, and downsamples — four jobs in the one fetch of
 * the full-resolution buffer the bloom is allowed. Subtracting the threshold
 * rather than gating on it is the difference between a halo that grows out of a
 * highlight and one that switches on: UnrealBloomPass gates, which is why its
 * output has to be kept at a strength low enough to hide the step.
 */
const BLOOM_PREFILTER_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform sampler2D tRays;
  uniform vec2 uTexel;
  uniform float uRays;
  uniform float uThreshold;
  varying vec2 vUv;

  const float CEILING = ${HDR_CEILING.toFixed(1)};

  vec3 fetch( vec2 uv ) {
    vec3 c = texture2D( tDiffuse, uv ).rgb;
    // Uniform branch: every pixel in the frame takes the same side of it, so
    // the fetch really is skipped rather than merely masked out.
    if ( uRays > 0.0 ) c += texture2D( tRays, uv ).rgb;
    return min( c, vec3( CEILING ) );
  }

  void main() {
    // Four bilinear taps on the diagonals is a 4x4 box for the price of four
    // fetches, which is what keeps a quarter-resolution downsample from
    // shimmering as the camera turns.
    vec3 c = fetch( vUv + uTexel * vec2(  1.0,  1.0 ) )
           + fetch( vUv + uTexel * vec2( -1.0,  1.0 ) )
           + fetch( vUv + uTexel * vec2(  1.0, -1.0 ) )
           + fetch( vUv + uTexel * vec2( -1.0, -1.0 ) );
    c *= 0.25;

    // Soft knee: nothing below the threshold, a quadratic ramp across the half
    // stop above it, linear after that.
    float lum = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
    float knee = uThreshold * 0.5;
    float soft = clamp( lum - uThreshold + knee, 0.0, 2.0 * knee );
    soft = soft * soft / ( 4.0 * knee + 1e-5 );
    float contrib = max( soft, lum - uThreshold ) / max( lum, 1e-5 );

    gl_FragColor = vec4( c * contrib, 1.0 );
  }
`

/** Plain 4-tap box downsample for the rungs below the first. */
const BLOOM_DOWN_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2 uTexel;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D( tDiffuse, vUv + uTexel * vec2(  1.0,  1.0 ) ).rgb
           + texture2D( tDiffuse, vUv + uTexel * vec2( -1.0,  1.0 ) ).rgb
           + texture2D( tDiffuse, vUv + uTexel * vec2(  1.0, -1.0 ) ).rgb
           + texture2D( tDiffuse, vUv + uTexel * vec2( -1.0, -1.0 ) ).rgb;
    gl_FragColor = vec4( c * 0.25, 1.0 );
  }
`

/**
 * Nine-tap tent upsample, blended additively onto the rung above.
 *
 * The tent is what turns a stack of box-filtered mips into something with no
 * visible blockiness in it; `uRadius` widens the kernel past one texel, which is
 * the only knob the bloom's spread has.
 */
const BLOOM_UP_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2 uTexel;
  uniform float uRadius;
  varying vec2 vUv;
  void main() {
    vec2 o = uTexel * uRadius;
    vec3 c = texture2D( tDiffuse, vUv + vec2( -o.x,  o.y ) ).rgb
           + texture2D( tDiffuse, vUv + vec2(  0.0,  o.y ) ).rgb * 2.0
           + texture2D( tDiffuse, vUv + vec2(  o.x,  o.y ) ).rgb
           + texture2D( tDiffuse, vUv + vec2( -o.x,  0.0 ) ).rgb * 2.0
           + texture2D( tDiffuse, vUv ).rgb * 4.0
           + texture2D( tDiffuse, vUv + vec2(  o.x,  0.0 ) ).rgb * 2.0
           + texture2D( tDiffuse, vUv + vec2( -o.x, -o.y ) ).rgb
           + texture2D( tDiffuse, vUv + vec2(  0.0, -o.y ) ).rgb * 2.0
           + texture2D( tDiffuse, vUv + vec2(  o.x, -o.y ) ).rgb;
    gl_FragColor = vec4( c * ( 1.0 / 16.0 ), 1.0 );
  }
`

// ------------------------------------------------------------------- grade
/**
 * The one full-resolution pass in the chain, and everything that has to happen
 * at full resolution is in it: the shafts and the bloom added back, the ceiling,
 * the tone map, the transfer function, and the grade itself.
 *
 * The tone map and the transfer function are ports of three's own ACESFilmic
 * and sRGB OETF rather than anything new — the renderer only applies its
 * `toneMapping` and `outputColorSpace` when it is drawing to the canvas, and
 * this chain never lets it, so what would have been three's OutputPass is these
 * twenty lines instead of another target bind.
 */
const GRADE_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform sampler2D tRays;
  uniform sampler2D tBloom;
  uniform vec2 uTexel;
  uniform float uRays;
  uniform float uBloom;
  uniform float uExposure;
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

  const float CEILING = ${HDR_CEILING.toFixed(1)};

  float luma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }

  float hash( vec2 p ) {
    return fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
  }

  // ---- three.js ACESFilmicToneMapping, verbatim. Verbatim includes the name,
  // which collides with the real chunk if three ever prepends it — see
  // screenMaterial() for the black screen that caused and what stops it.
  vec3 RRTAndODTFit( vec3 v ) {
    vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
    vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
    return a / b;
  }
  vec3 acesFilmic( vec3 color ) {
    const mat3 ACESInputMat = mat3(
      vec3( 0.59719, 0.07600, 0.02840 ),
      vec3( 0.35458, 0.90834, 0.13383 ),
      vec3( 0.04823, 0.01566, 0.83777 )
    );
    const mat3 ACESOutputMat = mat3(
      vec3(  1.60475, -0.10208, -0.00327 ),
      vec3( -0.53108,  1.10813, -0.07276 ),
      vec3( -0.07367, -0.00605,  1.07602 )
    );
    color *= uExposure / 0.6;
    color = ACESInputMat * color;
    color = RRTAndODTFit( color );
    color = ACESOutputMat * color;
    return clamp( color, 0.0, 1.0 );
  }

  // ---- three.js sRGBTransferOETF, verbatim.
  vec3 encodeSRGB( vec3 v ) {
    return mix(
      pow( v, vec3( 0.41666 ) ) * 1.055 - vec3( 0.055 ),
      v * 12.92,
      vec3( lessThanEqual( v, vec3( 0.0031308 ) ) )
    );
  }

  /** Scene + shafts, ceilinged. The chromatic aberration needs it three times. */
  vec3 hdrAt( vec2 uv ) {
    vec3 c = texture2D( tDiffuse, uv ).rgb;
    if ( uRays > 0.0 ) c += texture2D( tRays, uv ).rgb;
    return min( c, vec3( CEILING ) );
  }

  void main() {
    vec2 centred = vUv - 0.5;
    float r2 = dot( centred, centred );

    // Chromatic aberration: zero in the middle, growing toward the corners
    // like a real lens. Frenzy cranks it hard. Done in HDR, before the tone
    // map, which is where a lens would do it.
    float ca = uChroma * ( 1.0 + uFrenzy * 7.0 ) * r2 * 4.0;
    vec3 hdr;
    hdr.r = hdrAt( vUv - centred * ca ).r;
    hdr.g = hdrAt( vUv ).g;
    hdr.b = hdrAt( vUv + centred * ca ).b;

    if ( uBloom > 0.0 ) hdr += texture2D( tBloom, vUv ).rgb * uBloom;

    vec3 col = encodeSRGB( acesFilmic( hdr ) );

    // Unsharp mask. Cheap four-tap; enough to put an edge back on fur and
    // thatch after the tone map softens everything. It runs on the tone-mapped
    // image, so the taps are cheap fetches of the same HDR buffer put through
    // the curve — the alternative is a second full-resolution target.
    if ( uSharpen > 0.0 ) {
      vec3 blur = encodeSRGB( acesFilmic( hdrAt( vUv + vec2( uTexel.x, 0.0 ) ) ) )
                + encodeSRGB( acesFilmic( hdrAt( vUv - vec2( uTexel.x, 0.0 ) ) ) )
                + encodeSRGB( acesFilmic( hdrAt( vUv + vec2( 0.0, uTexel.y ) ) ) )
                + encodeSRGB( acesFilmic( hdrAt( vUv - vec2( 0.0, uTexel.y ) ) ) );
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

    // The grain fades to nothing in the highlights, so a smooth bright
    // gradient — the sky around a low sun, the night dome — still quantises
    // to visible 8-bit bands. A half-LSB of interleaved-gradient noise is
    // below the threshold of visibility everywhere but under the bands.
    float ign = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
    col += ( ign - 0.5 ) / 255.0;

    gl_FragColor = vec4( clamp( col, 0.0, 1.0 ), 1.0 );
  }
`

export class PostFX {
  /** Linear HDR, with depth — what the scene itself is drawn into. */
  private sceneRT: THREE.WebGLRenderTarget
  private raysRT: THREE.WebGLRenderTarget
  private bloomRT: THREE.WebGLRenderTarget[] = []
  /** Graded LDR, only allocated because FXAA needs somewhere to read from. */
  private gradeRT: THREE.WebGLRenderTarget

  /**
   * Scene depth for the particles' soft fade. WebGL forbids sampling a texture
   * attached to the framebuffer being drawn, so the scene target keeps its
   * depth renderbuffer and the depth is blitted out here after the scene pass;
   * the particles therefore read depth that is one frame old. A blit is a raw
   * copy, not a full-screen pass — no shader, no extra target bind in the chain.
   */
  private depthRT: THREE.WebGLRenderTarget
  private depthReady = false

  private rayMat: THREE.ShaderMaterial
  private prefilterMat: THREE.ShaderMaterial
  private downMat: THREE.ShaderMaterial
  private upMat: THREE.ShaderMaterial
  private gradeMat: THREE.ShaderMaterial
  private fxaaMat: THREE.ShaderMaterial
  private quad: FullScreenQuad

  private sunUv = new THREE.Vector2()
  private size = new THREE.Vector2()
  private time = 0
  private godraysOn = true
  private bloomOn = true
  private aaOn = true

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    private sunDir: THREE.Vector3,
  ) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2())

    this.sceneRT = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      colorSpace: THREE.LinearSRGBColorSpace,
      samples: 0,
      depthBuffer: true,
    })
    // Depth-only in intent; the unused colour attachment is the price of a
    // stock WebGLRenderTarget. UnsignedIntType keeps the texture's internal
    // format identical to the scene target's renderbuffer — blitFramebuffer
    // requires the depth formats to match exactly.
    this.depthRT = new THREE.WebGLRenderTarget(size.x, size.y, {
      depthBuffer: true,
      depthTexture: new THREE.DepthTexture(size.x, size.y, THREE.UnsignedIntType),
    })
    setSceneDepth(this.depthRT.depthTexture!, camera.near, camera.far)

    this.raysRT = hdrTarget(size.x * 0.5, size.y * 0.5)
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const s = BLOOM_SCALE / 2 ** i
      this.bloomRT.push(hdrTarget(size.x * s, size.y * s))
    }
    // 8-bit is the right storage for a graded, display-referred image, and it
    // halves what FXAA has to read.
    this.gradeRT = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.UnsignedByteType,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: false,
    })

    this.rayMat = screenMaterial(GOD_RAY_FRAG, {
      tDiffuse: { value: this.sceneRT.texture },
      uSun: { value: new THREE.Vector2(0.5, 0.5) },
      uStrength: { value: POST.godrayStrength },
      uDecay: { value: POST.godrayDecay },
      uAspect: { value: 1 },
    })
    this.prefilterMat = screenMaterial(BLOOM_PREFILTER_FRAG, {
      tDiffuse: { value: this.sceneRT.texture },
      tRays: { value: this.raysRT.texture },
      uTexel: { value: new THREE.Vector2() },
      uRays: { value: 0 },
      uThreshold: { value: POST.bloomThreshold },
    })
    this.downMat = screenMaterial(BLOOM_DOWN_FRAG, {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2() },
    })
    this.upMat = screenMaterial(BLOOM_UP_FRAG, {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uRadius: { value: 1 + POST.bloomRadius * 2 },
    })
    // Additive, so an upsample lands on the rung above without a ping-pong.
    this.upMat.blending = THREE.AdditiveBlending

    this.gradeMat = screenMaterial(GRADE_FRAG, {
      tDiffuse: { value: this.sceneRT.texture },
      tRays: { value: this.raysRT.texture },
      tBloom: { value: this.bloomRT[0]!.texture },
      uTexel: { value: new THREE.Vector2() },
      uRays: { value: 0 },
      uBloom: { value: POST.bloomStrength },
      uExposure: { value: POST.exposure },
      uTime: { value: 0 },
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
    })

    this.fxaaMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(FXAAShader.uniforms),
      vertexShader: FXAAShader.vertexShader,
      fragmentShader: FXAAShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
    this.fxaaMat.uniforms.tDiffuse!.value = this.gradeRT.texture

    this.quad = new FullScreenQuad(this.gradeMat)
    this.setSize(innerWidth, innerHeight)
  }

  /**
   * Switch stages on and off for the quality tier. Nothing is deallocated:
   * climbing back a tier has to cost nothing, and a render target that is not
   * bound costs nothing to keep.
   */
  setQuality(p: { godrays: boolean; bloom: boolean; smaa: boolean }) {
    this.godraysOn = p.godrays
    this.bloomOn = p.bloom
    this.aaOn = p.smaa
  }

  setSize(w: number, h: number) {
    this.renderer.getDrawingBufferSize(this.size)
    const { x, y } = this.size
    this.sceneRT.setSize(x, y)
    this.depthRT.setSize(x, y)
    // Resizing reallocates the framebuffer, so the copy must re-bind it first.
    this.depthReady = false
    this.gradeRT.setSize(x, y)
    this.raysRT.setSize(Math.max(1, Math.round(x * 0.5)), Math.max(1, Math.round(y * 0.5)))
    for (let i = 0; i < this.bloomRT.length; i++) {
      const s = BLOOM_SCALE / 2 ** i
      this.bloomRT[i]!.setSize(Math.max(1, Math.round(x * s)), Math.max(1, Math.round(y * s)))
    }
    this.gradeMat.uniforms.uTexel!.value.set(1 / x, 1 / y)
    this.fxaaMat.uniforms.resolution!.value.set(1 / x, 1 / y)
    this.rayMat.uniforms.uAspect!.value = w / h
  }

  /**
   * Bind a target and draw one full-screen triangle pair through `mat`.
   *
   * `accumulate` is not optional decoration. FullScreenQuad.render() goes
   * through renderer.render(), which honours `autoClear` and therefore clears
   * the target it was just handed — so a pass that blends onto what is already
   * there has to turn that off, or the blend has nothing to blend with and the
   * additive upsample below silently reduces to "the last rung, alone".
   */
  private blit(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null, accumulate = false) {
    const r = this.renderer
    this.quad.material = mat
    r.setRenderTarget(target)
    const previous = r.autoClear
    r.autoClear = !accumulate
    this.quad.render(r)
    r.autoClear = previous
  }

  /** See depthRT: the copy has to happen outside the scene pass. */
  private copySceneDepth() {
    const r = this.renderer
    if (!this.depthReady) {
      // A target's GL framebuffer only exists once it has been bound.
      r.setRenderTarget(this.depthRT)
      this.depthReady = true
    }
    const gl = r.getContext() as WebGL2RenderingContext
    type FbProps = { __webglFramebuffer?: WebGLFramebuffer }
    const src = (r.properties.get(this.sceneRT) as FbProps).__webglFramebuffer
    const dst = (r.properties.get(this.depthRT) as FbProps).__webglFramebuffer
    if (!src || !dst) return
    // Bound through three's state cache, so its own bookkeeping stays valid.
    r.state.bindFramebuffer(gl.READ_FRAMEBUFFER, src)
    r.state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst)
    gl.blitFramebuffer(
      0, 0, this.size.x, this.size.y,
      0, 0, this.size.x, this.size.y,
      gl.DEPTH_BUFFER_BIT, gl.NEAREST,
    )
  }

  /** @param frenzy 0..1 @param hurt 0..1 @param night 0..1, DayNight.darkness */
  render(dt: number, frenzy: number, hurt: number, night = 0) {
    this.time += dt
    const r = this.renderer

    // ---- the scene, into linear HDR. The renderer only tone maps and encodes
    // when it is drawing to the canvas, so what lands here is untouched light.
    r.setRenderTarget(this.sceneRT)
    r.render(this.scene, this.camera)
    this.copySceneDepth()

    // ---- shafts, at half resolution, only when the sun is actually on screen.
    const rays = sunScreenPosition(this.sunDir, this.camera, this.sunUv) && this.godraysOn
    if (rays) {
      this.rayMat.uniforms.uSun!.value.copy(this.sunUv)
      this.blit(this.rayMat, this.raysRT)
    }
    const rayFlag = rays ? 1 : 0
    this.prefilterMat.uniforms.uRays!.value = rayFlag
    this.gradeMat.uniforms.uRays!.value = rayFlag

    // ---- bloom pyramid: prefilter down to a quarter, two more rungs below
    // that, then tent-upsample back with additive blending.
    if (this.bloomOn) {
      const first = this.bloomRT[0]!
      this.prefilterMat.uniforms.uTexel!.value.set(1 / this.size.x, 1 / this.size.y)
      this.blit(this.prefilterMat, first)

      for (let i = 1; i < this.bloomRT.length; i++) {
        const src = this.bloomRT[i - 1]!
        this.downMat.uniforms.tDiffuse!.value = src.texture
        this.downMat.uniforms.uTexel!.value.set(1 / src.width, 1 / src.height)
        this.blit(this.downMat, this.bloomRT[i]!)
      }
      for (let i = this.bloomRT.length - 1; i > 0; i--) {
        const src = this.bloomRT[i]!
        this.upMat.uniforms.tDiffuse!.value = src.texture
        this.upMat.uniforms.uTexel!.value.set(1 / src.width, 1 / src.height)
        this.blit(this.upMat, this.bloomRT[i - 1]!, true)
      }
    }

    // ---- tone map, transfer function and grade, in one.
    const g = this.gradeMat.uniforms
    g.uTime!.value = this.time
    g.uFrenzy!.value = frenzy
    g.uHurt!.value = hurt
    g.uExposure!.value = r.toneMappingExposure
    // Frenzy also blows the bloom out, which is what makes it read as a rush
    // rather than a colour filter.
    g.uBloom!.value = this.bloomOn ? POST.bloomStrength * (1 + frenzy * 1.6) : 0
    // Kneed, not scaled: `darkness` still reads 0.18 with the sun 17 degrees up,
    // and the night eye was lifting and desaturating the morning because of it.
    // Above nightEyeFull the multiplier is exactly 1, so the night is unchanged.
    const dark = night * THREE.MathUtils.smoothstep(night, POST.nightEyeOnset, POST.nightEyeFull)
    g.uNight!.value = dark * POST.nightEye

    if (this.aaOn) {
      this.blit(this.gradeMat, this.gradeRT)
      this.blit(this.fxaaMat, null)
    } else {
      this.blit(this.gradeMat, null)
    }
    r.setRenderTarget(null)
  }

  dispose() {
    this.sceneRT.dispose()
    this.depthRT.dispose()
    this.raysRT.dispose()
    this.gradeRT.dispose()
    for (const t of this.bloomRT) t.dispose()
    for (const m of [this.rayMat, this.prefilterMat, this.downMat, this.upMat, this.gradeMat, this.fxaaMat]) {
      m.dispose()
    }
    this.quad.dispose()
  }
}
