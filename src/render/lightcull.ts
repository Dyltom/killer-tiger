/**
 * Skip the lighting maths for lights that are contributing exactly nothing.
 *
 * Three has no per-object or per-pixel light culling. Its fragment shader
 * unrolls a loop over every point light in the scene and calls `RE_Direct` on
 * each one unconditionally, so a lamp on the far side of the village is a full
 * GGX specular plus diffuse evaluation on every lit pixel in front of the
 * camera, forever, whether or not a single photon from it reaches anything.
 *
 * That is not a small tax here. The village's lamp pool is dealt to whichever
 * fires and doorways are nearest (see world/lamps.ts), but "nearest" on a 240 m
 * plain is still usually out of range: a lamp reaches 15 m and a fire 30. So
 * most of the pool is dark most of the time and was being paid for in full.
 * Measured on the worst case — wave 12, forty humans, at night on the High tier
 * — the four extra lights the tier affords cost 6.7 ms of an 18 ms frame. Night
 * ran at 56 fps where the same scene in daylight ran at 88.
 *
 * The fix is one `if`. Three already computes the answer and throws it away:
 *
 *   light.color *= getDistanceAttenuation( lightDistance, cutoff, decay );
 *   light.visible = ( light.color != vec3( 0.0 ) );
 *
 * and then never reads `visible` except to skip a shadow lookup. Guarding the
 * `RE_Direct` call with it is *exactly* value-preserving rather than an
 * approximation, which is the whole reason this is worth doing: past the
 * cutoff, `getDistanceAttenuation` multiplies by `pow2( saturate( 1 - pow4( d /
 * cutoff ) ) )`, and beyond `d = cutoff` the saturate clamps to zero, so the
 * attenuation is not small — it is the float zero. A light with zero colour
 * adds zero to `reflectedLight`. Skipping it cannot change a pixel.
 *
 * It is also why this is a shader edit and not a CPU one. The obvious CPU
 * version — set `light.visible = false` on lamps that are out of range — would
 * change the scene's light *count*, and three keys every material's program on
 * that, so each new count recompiles the world and stalls the frame for a few
 * hundred milliseconds. The count has to stay fixed; only the work has to go.
 *
 * The cost is branch divergence, and it is small because lights are spatially
 * coherent: a lamp's 15 m sphere covers a contiguous patch of the screen, so
 * almost every warp is either wholly inside it or wholly outside, and only the
 * few straddling the boundary pay for both sides.
 *
 * The same line appears three times in the chunk — once each for point, spot
 * and directional lights — and all three are guarded. For directional lights
 * `visible` is a compile-time-ish constant true, so the branch is uniform and
 * free; guarding it costs nothing and keeps the patch from depending on which
 * of the three occurrences is which.
 */
import * as THREE from 'three'

/**
 * The exact call three emits inside each light loop. Matched as a literal so
 * that a three upgrade which changes `RE_Direct`'s signature fails loudly here
 * rather than silently rendering the game at half speed again.
 */
const CALL =
  'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );'

/** Point, spot, directional. */
const EXPECTED = 3

let installed = false

/**
 * Rewrite `lights_fragment_begin`. Must run before the first material compiles
 * — three assembles a program's source once and caches it.
 */
export function installLightCulling() {
  if (installed) return
  installed = true

  const src = THREE.ShaderChunk.lights_fragment_begin
  const found = src.split(CALL).length - 1
  if (found !== EXPECTED) {
    // Better a warning and stock lighting than a shader that fails to compile.
    console.warn(
      `lightcull: expected ${EXPECTED} RE_Direct calls in lights_fragment_begin, found ${found}. ` +
        'Three has changed the chunk; leaving lighting unpatched.',
    )
    return
  }

  THREE.ShaderChunk.lights_fragment_begin = src.replaceAll(
    CALL,
    `if ( directLight.visible ) { ${CALL} }`,
  )
}
