/**
 * Wounds, cut into the shading of a body rather than modelled on top of it.
 *
 * The bodies used to carry five red ellipsoids parented to the chest bone,
 * hidden until something opened them and then scaled up as the damage grew.
 * That could not have worked: an ellipsoid centred near a surface is a ball
 * sticking out of it, scaling it up pushed it further off the ribs the worse
 * the damage got, and it sat in the same five places on every body — so a man
 * clawed across the back grew red bubbles on his front. It read as exactly what
 * it was, beads glued on.
 *
 * The obvious replacement is to paint the damage into the vertex colours the
 * body is already coloured from. That is most of the way there and it is free,
 * but it cannot be sharp: the torso is a twelve-sided sweep, so its vertices
 * are eight centimetres apart across the chest, and anything smaller than that
 * comes out as a soft airbrushed blush spanning a whole quad. A rake is a
 * three-millimetre line. Nothing at vertex resolution can draw one.
 *
 * So the wound lives in the fragment shader, and the body's geometry never
 * learns about it at all. Each one is a capsule in bind-pose space — a segment
 * and a radius, which is the shape a claw draws and, end to end, the shape a
 * puncture draws too — and every fragment asks how deep inside any of them it
 * is. That buys, in order of how much it matters:
 *
 *   - edges as sharp as the screen, at any range, on any body size;
 *   - a shape that follows the surface exactly, because it is evaluated on the
 *     surface, so nothing can float, z-fight, or clip through a shoulder;
 *   - bind-pose coordinates, so a wound is welded to the skin it was opened on
 *     and travels with the bone under it for free;
 *   - a per-fragment wetness, which is the one cue that separates blood from a
 *     brown patch and which no amount of vertex colour can express.
 *
 * The cost is a dozen point-to-segment distances per fragment on the humans
 * only, and it is bounded by a uniform loop count, so an unhurt villager pays
 * for one comparison and nothing else.
 */
import * as THREE from 'three'

/**
 * How many capsules a body can carry at once, and how they are divided.
 *
 * A claw hit spends three or four (one per rake) and a bite spends three (two
 * jaw arcs and the crush between them), so eight holds the last two wounds in
 * full detail. Older ones are evicted, and what they leave behind is the
 * overall soak in the vertex colours, which is monotonic and never evicts.
 * Between the two, a man who has taken six hits reads as darker all over with
 * his two most recent wounds legible on him — which is the right way round,
 * because the newest damage is the damage the player just did.
 *
 * The runs of blood underneath get their own four at the top of the range
 * rather than competing for the same ring. They have to be written to again
 * and again as the body empties, and a shared ring would eventually hand a
 * run's slot to a fresh cut and then keep dragging that cut down the body.
 */
const CUT_SLOTS = 8
export const RUN_SLOTS = 4
export const WOUND_SLOTS = CUT_SLOTS + RUN_SLOTS

/**
 * Blood, darkest last. See the ramp in the shader for why the order matters.
 *
 * All three are far darker than the colour anybody reaches for when asked to
 * name blood. Scarlet is what it looks like on a white bathroom tile under a
 * bathroom light; on a body outdoors it is a deep oxidised maroon, and putting
 * saturated red on a man makes him look painted rather than cut. The wet stop
 * in particular has to stay dark — its job is done by the roughness drop under
 * it, not by its brightness, and the two together read as fluid where either
 * one alone reads as a colour.
 */
const STAIN = new THREE.Color(0x2b0906)
const WET = new THREE.Color(0x4e120e)
const GASH = new THREE.Color(0x140404)
const uRamp = { value: [STAIN, WET, GASH] }

export interface WoundSet {
  /** xyz — one end of the capsule in bind-pose body space, w — its radius. */
  readonly a: THREE.Vector4[]
  /** xyz — the other end, w — how deep it cuts, 0..1. */
  readonly b: THREE.Vector4[]
  /** Shared with every material on the body, so one write covers all of them. */
  readonly uA: { value: THREE.Vector4[] }
  readonly uB: { value: THREE.Vector4[] }
  /** How far up the array the shader has to look. Zero on an unhurt body. */
  readonly uCount: { value: number }
  cuts: number
  runs: number
}

export function createWoundSet(): WoundSet {
  const a: THREE.Vector4[] = []
  const b: THREE.Vector4[] = []
  for (let i = 0; i < WOUND_SLOTS; i++) {
    a.push(new THREE.Vector4(0, 0, 0, 0.01))
    b.push(new THREE.Vector4(0, 0, 0, 0))
  }
  return { a, b, uA: { value: a }, uB: { value: b }, uCount: { value: 0 }, cuts: 0, runs: 0 }
}

function write(
  set: WoundSet, i: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  radius: number, depth: number,
) {
  set.a[i]!.set(ax, ay, az, radius)
  set.b[i]!.set(bx, by, bz, depth)
  set.uCount.value = Math.max(set.uCount.value, i + 1)
}

/** Open one capsule where something went in. Oldest cut is evicted. */
export function cutWound(
  set: WoundSet,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  radius: number,
  depth: number,
) {
  write(set, set.cuts, ax, ay, az, bx, by, bz, radius, depth)
  set.cuts = (set.cuts + 1) % CUT_SLOTS
}

/**
 * Start a run of blood, and return the slot holding it.
 *
 * Worth handing back, unlike a cut: a run is a capsule whose lower end keeps
 * being pushed further down as the body empties, so every pass after the first
 * is a rewrite of a slot already spent rather than another one taken.
 */
export function startRun(
  set: WoundSet,
  x: number, y: number, z: number,
  radius: number,
): number {
  const i = CUT_SLOTS + set.runs
  set.runs = (set.runs + 1) % RUN_SLOTS
  write(set, i, x, y, z, x, y, z, radius, 0)
  return i
}

/** Drag a run further down the body. */
export function extendRun(
  set: WoundSet, slot: number,
  bx: number, by: number, bz: number,
  depth: number,
) {
  set.b[slot]!.set(bx, by, bz, depth)
}

export function clearWounds(set: WoundSet) {
  for (const v of set.b) v.w = 0
  set.uCount.value = 0
  set.cuts = 0
  set.runs = 0
}

/**
 * Let a material carry wounds. Chains onto anything already injected.
 *
 * `position` in the vertex shader is the bind pose — three skins into
 * `transformed` and leaves the attribute alone — so the varying needed here is
 * free, and it is the frame a wound has to be fixed in. Doing this in world
 * space instead would leave every cut hanging in the air the moment the body
 * walked out of it.
 */
export function addWoundShading(mat: THREE.Material, set: WoundSet) {
  const prev = mat.onBeforeCompile.bind(mat)

  mat.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer)
    shader.uniforms.uWoundA = set.uA
    shader.uniforms.uWoundB = set.uB
    shader.uniforms.uWoundCount = set.uCount
    shader.uniforms.uWoundRamp = uRamp

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWoundP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWoundP = position;')

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        varying vec3 vWoundP;
        uniform vec4 uWoundA[ ${WOUND_SLOTS} ];
        uniform vec4 uWoundB[ ${WOUND_SLOTS} ];
        uniform int uWoundCount;
        uniform vec3 uWoundRamp[ 3 ];

        float woundHash( vec3 p ) {
          p = fract( p * 0.3183099 + vec3( 0.71, 0.113, 0.419 ) );
          p *= 17.0;
          return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
        }
        float woundNoise( vec3 p ) {
          vec3 i = floor( p );
          vec3 f = fract( p );
          f = f * f * ( 3.0 - 2.0 * f );
          return mix(
            mix( mix( woundHash( i ), woundHash( i + vec3( 1, 0, 0 ) ), f.x ),
                 mix( woundHash( i + vec3( 0, 1, 0 ) ), woundHash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
            mix( mix( woundHash( i + vec3( 0, 0, 1 ) ), woundHash( i + vec3( 1, 0, 1 ) ), f.x ),
                 mix( woundHash( i + vec3( 0, 1, 1 ) ), woundHash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
        }
        `,
      )
      // After <color_fragment>, so this lands on top of both the cloth weave and
      // the vertex colours rather than under either.
      .replace(
        '#include <color_fragment>',
        /* glsl */ `
        #include <color_fragment>
        float woundAmt = 0.0;
        for ( int i = 0; i < ${WOUND_SLOTS}; i ++ ) {
          if ( i >= uWoundCount ) break;
          vec4 wa = uWoundA[ i ];
          vec4 wb = uWoundB[ i ];
          if ( wb.w <= 0.0 ) continue;
          vec3 ab = wb.xyz - wa.xyz;
          vec3 ap = vWoundP - wa.xyz;
          float t = clamp( dot( ap, ab ) / max( dot( ab, ab ), 1e-6 ), 0.0, 1.0 );
          float len = length( ab );
          vec3 dir = ab / max( len, 1e-6 );

          // A blood edge is never a circle, and the swing on this is deliberately
          // wide enough to pinch the capsule off entirely where the noise runs
          // low. That is what buys the punctures: a jaw arc drawn as one smooth
          // capsule is a lozenge painted on a chest, and the same capsule
          // strangled at three or four points along its length is a row of fang
          // holes with torn ground between them — without spending a slot, or a
          // parameter, on saying so.
          //
          // But the swell has to run *along* the cut. Sampled isotropically it
          // has the same wavelength across the capsule as it does down it, which
          // means the two lips of a 2 cm rake wander independently and the whole
          // thing comes out as a scribble rather than a stroke. One dimension of
          // noise, indexed by distance along the segment, and it varies the way a
          // claw varies: deeper here, shallower there, both edges together.
          //
          // How hard it swells is read off the capsule's own width, which is the
          // only thing here that knows what opened it. A claw is a narrow capsule
          // and wants a continuous stroke that merely thickens and thins — pinch
          // one of those off and the rake comes apart into a row of dots. A jaw
          // arc is a wide one and wants the opposite: strangled hard enough to
          // break, because a smooth arc is a lozenge painted on a chest and the
          // same arc broken at six points is a row of fang holes with torn ground
          // between them, bought without a slot or a parameter saying so.
          float rough = smoothstep( 0.010, 0.024, wa.w );
          float lobe = mix(
            woundNoise( vWoundP * 26.0 ),
            woundNoise( dir * 9.0 + t * len * ( 34.0 + 60.0 * rough ) ),
            smoothstep( 0.012, 0.05, len ) );
          // On top of that, a fine tear on the lip itself, so the edge is ragged
          // at a scale well under the width and never reads as a drawn line.
          float edge = woundNoise( vWoundP * 85.0 );
          float r = wa.w * ( 0.78 - 0.30 * rough
                             + lobe * ( 0.40 + 0.85 * rough )
                             + edge * 0.14 );
          // And teeth are evenly spaced, which is the one thing noise will not
          // give you at any amplitude. A jaw leaves a row of holes at intervals,
          // so the interval is a cosine — phase-jittered off the noise so two
          // bites on one man cannot line up into a print, squared so the gaps
          // between teeth are narrow and the holes are broad, and weighted by the
          // same width test, which leaves a claw's stroke alone.
          r *= 1.0 - 0.8 * rough
                   * pow( 0.5 + 0.5 * cos( t * len * 240.0 + lobe * 7.0 ), 2.0 );
          // Claws go in and come out. A stroke with a round cap at each end is a
          // dash; tapering both ends to nothing is what makes it a rake. Only for
          // capsules long enough to have ends — a puncture is all cap.
          r *= mix( 1.0, sqrt( max( 0.0, 1.0 - pow( abs( t * 2.0 - 1.0 ), 3.0 ) ) ),
                    smoothstep( 0.02, 0.09, len ) );
          float d = length( ap - ab * t );
          // Depth into the capsule, and it has to keep climbing all the way to
          // the middle. A smoothstep here looks like the right tool and is a
          // trap: it saturates short of the centre, so the whole inner half of
          // every cut sits at exactly 1.0, lands on one stop of the ramp, and
          // comes out as a flat disc of that colour with the rest of the ramp
          // squeezed into a ring around it. The gamma gives the same soft outer
          // tail without the plateau — full depth is reached at the centre line
          // and nowhere else.
          float f = 1.0 - d / max( r, 1e-4 );
          float core = pow( clamp( f, 0.0, 1.0 ), 0.55 );
          // And a soak well past the lip, because cloth wicks and skin bruises,
          // and a cut that stops dead at its own edge is a decal. It reaches five
          // times the width of what opened it, which is what makes any of this
          // legible from across a clearing: a 1 cm rake is a couple of pixels at
          // twenty metres and antialiasing eats it, while the hand-sized stain
          // around it survives to any range. Capped low, so however wide it
          // spreads it can only just reach the bottom of the blood ramp.
          float halo = 0.44 * pow( clamp( 1.0 - d / max( r * 5.0, 1e-4 ), 0.0, 1.0 ), 1.7 );
          woundAmt = max( woundAmt, wb.w * max( core, halo ) );
        }
        if ( woundAmt > 0.0 ) {
          // Soak first, and *relative to whatever is underneath*. An absolute
          // colour cannot do this job: these men wear a near-black shirt, so a
          // fixed dark stain is invisible on it and only the one bright stop in
          // the middle of the ramp ever showed — which drew every cut as a red
          // wire loop round a hole the colour of the shirt. Multiplying the
          // garment down and adding the stain to it reads as soaked on anything,
          // dark or light, because it is darker than its surroundings by
          // construction.
          vec3 soaked = diffuseColor.rgb * 0.30 + uWoundRamp[ 0 ];
          // Then the ramp, and the reason it ends dark. A wound is a hole with a
          // wet lip: the fluid filling it is the brightest thing on the body
          // because it is a specular surface, and the opening itself returns
          // almost nothing because it is a cavity. So the wet stop has to own the
          // *body* of the cut and the dark stop only the last of it — a hairline
          // down the deepest part. Give the dark stop the interior instead and
          // the bright stop is left tracing the rim, which is a sticker.
          diffuseColor.rgb = woundAmt < 0.32
            ? mix( diffuseColor.rgb, soaked, woundAmt / 0.32 )
            : woundAmt < 0.84
              ? mix( soaked, uWoundRamp[ 1 ], ( woundAmt - 0.32 ) / 0.52 )
              : mix( uWoundRamp[ 1 ], uWoundRamp[ 2 ], ( woundAmt - 0.84 ) / 0.16 );
          // Last, break the fill up. Everything above lands one colour per depth,
          // and a wound whose interior is a single flat value is a shape someone
          // filled in — it is most of why blood on bare skin reads as poster
          // paint however carefully the colour was chosen. Blood is clotted here
          // and thin there, and a little multiplicative mottle inside the cut is
          // enough to say so.
          diffuseColor.rgb *= 1.0 + ( woundNoise( vWoundP * 70.0 ) - 0.5 )
                                    * 0.7 * smoothstep( 0.1, 0.45, woundAmt );
        }
        `,
      )
      // Wet, and only in a band. This is the cue that does the most work of
      // anything here — matte dark red on a body is dirt, and the same colour
      // with a highlight sliding over it as the body turns is blood — but it
      // has to stop before the opening. A cavity is the one part of a wound
      // that is *not* shiny: it is a hole, it traps every bounce that goes into
      // it, and giving it a specular makes the whole thing read as a wet decal
      // laid over the skin rather than a way into the body. Glossy rim, matte
      // hole, and the eye reads depth that the geometry does not have.
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
        #include <roughnessmap_fragment>
        float woundWet = smoothstep( 0.22, 0.55, woundAmt ) * ( 1.0 - 0.7 * smoothstep( 0.84, 1.0, woundAmt ) );
        roughnessFactor = mix( roughnessFactor, 0.25, woundWet );
        `,
      )
  }
  // Without this, a material that carries wounds and one that does not can hash
  // to the same program — every other parameter is identical — and three hands
  // the second one the first one's shader. Chained, because whatever else has
  // patched this material has the same problem and got there first.
  const prevKey = mat.customProgramCacheKey.bind(mat)
  mat.customProgramCacheKey = () => `${prevKey()}|wound`
}
