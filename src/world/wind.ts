/**
 * Wind for instanced foliage.
 *
 * Injected into stock MeshStandardMaterials rather than implemented as a custom
 * shader, so grass and canopies still receive shadows, IBL and atmospheric fog.
 * Everything bends in object space before the instance matrix is applied, which
 * means a blade pivots about its own base no matter where it was scattered.
 *
 * Two frequencies are summed: a fast flutter and a slow gust that travels
 * across the map. The gust is what makes a field read as wind rather than as
 * every blade vibrating independently.
 */
import * as THREE from 'three'
import { tagProgram } from './materials'

/** Prevailing wind, normalised. Also used to angle the campfire smoke. */
export const WIND_DIR = new THREE.Vector2(0.86, 0.51).normalize()

const clocks: { value: number }[] = []

export interface WindOptions {
  /** Metres of sway at the very top of the geometry. */
  amplitude: number
  /** Height in local units that counts as "the top". */
  height: number
  /** Flutter rate. Small, stiff plants are faster. */
  speed?: number
  /** Extra bend applied only while a gust is passing. */
  gust?: number
}

/**
 * Adds wind to a material in place. Safe to call on a material used by an
 * InstancedMesh; per-instance phase comes from the instance's own translation.
 */
export function addWind(mat: THREE.Material, opts: WindOptions) {
  const { amplitude, height, speed = 1.9, gust = 0.85 } = opts
  const prev = mat.onBeforeCompile.bind(mat)

  mat.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer)
    shader.uniforms.uWindTime = { value: 0 }
    clocks.push(shader.uniforms.uWindTime as { value: number })

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        uniform float uWindTime;
        `,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        #include <begin_vertex>
        {
          // Instance origin in world space — the per-plant phase offset.
          #ifdef USE_INSTANCING
            vec3 windAnchor = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
          #else
            vec3 windAnchor = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
          #endif

          float phase = windAnchor.x * 0.42 + windAnchor.z * 0.31;

          // A slow front sweeping along the wind direction.
          float front = dot( windAnchor.xz, vec2( ${WIND_DIR.x.toFixed(4)}, ${WIND_DIR.y.toFixed(4)} ) );
          float gustAmt = sin( uWindTime * 0.42 - front * 0.035 ) * 0.5 + 0.5;
          gustAmt = gustAmt * gustAmt;

          float flutter = sin( uWindTime * ${speed.toFixed(3)} + phase )        * 0.6
                        + sin( uWindTime * ${(speed * 1.71).toFixed(3)} + phase * 1.9 ) * 0.4;

          // Bend grows with the square of height so the base stays planted.
          float h = clamp( transformed.y / ${height.toFixed(4)}, 0.0, 1.0 );
          h = h * h;

          float bend = flutter * ( 0.35 + gustAmt * ${gust.toFixed(3)} ) * ${amplitude.toFixed(4)} * h;
          transformed.x += bend * ${WIND_DIR.x.toFixed(4)};
          transformed.z += bend * ${WIND_DIR.y.toFixed(4)};
          // Tops dip slightly as they lean, which stops the sway looking like a shear.
          transformed.y -= abs( bend ) * 0.28;
        }
        `,
      )
  }

  tagProgram(mat, `wind:${amplitude}:${height}:${speed}:${gust}`)
}

/**
 * Shrink instances to nothing between `start` and `end` metres from the camera.
 * Cheaper than any kind of LOD bookkeeping and, for ground cover, it removes
 * the overdraw that actually costs — thousands of alpha-tested quads stacked
 * behind each other at the horizon.
 */
export function addDistanceFade(mat: THREE.Material, start: number, end: number) {
  const prev = mat.onBeforeCompile.bind(mat)

  mat.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer)
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      /* glsl */ `
      #include <begin_vertex>
      {
        #ifdef USE_INSTANCING
          vec3 fadeAnchor = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
        #else
          vec3 fadeAnchor = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
        #endif
        transformed *= 1.0 - smoothstep( ${start.toFixed(2)}, ${end.toFixed(2)}, distance( fadeAnchor, cameraPosition ) );
      }
      `,
    )
  }

  tagProgram(mat, `fade:${start}:${end}`)
}

/**
 * Cheap subsurface transmission for thin foliage.
 *
 * A leaf or a grass blade is one cell thick and most of what you see of one at
 * golden hour is sunlight coming *through* it, not off it. Without that the
 * whole backlit half of the field renders as near-black silhouettes, because a
 * surface whose normal points away from the sun gets nothing but ambient — and
 * "everything downsun is a black cut-out" is the clearest tell that a scene is
 * being lit by a games engine rather than by the sun.
 *
 * The term is a view-vs-light lobe: brightest when you are looking straight
 * down the direction the sunlight is travelling, which is exactly when a leaf
 * lights up. It is added to indirect diffuse rather than direct, deliberately —
 * routing it through the direct path would let the shadow map cancel it, and
 * the leaves that glow most are the ones shadowed by the canopy above them.
 *
 * `power` sets how tight the lobe is: low values wash the whole downsun half
 * of the field, high values keep the glow to the few degrees around the sun.
 */
export function addTranslucency(mat: THREE.Material, strength: number, power = 3.2) {
  const prev = mat.onBeforeCompile.bind(mat)

  mat.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer)
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_end>',
      /* glsl */ `
      #include <lights_fragment_end>
      #if ( NUM_DIR_LIGHTS > 0 )
      {
        // vViewPosition runs fragment -> camera; directionalLights[].direction
        // is the unit vector fragment -> light. Both are already in view space,
        // so no extra varyings are needed.
        float thru = max( 0.0, dot( normalize( vViewPosition ), -directionalLights[ 0 ].direction ) );
        thru = pow( thru, ${power.toFixed(2)} );
        reflectedLight.indirectDiffuse +=
          directionalLights[ 0 ].color * diffuseColor.rgb * thru * ${strength.toFixed(3)};
      }
      #endif
      `,
    )
  }

  tagProgram(mat, `sss:${strength}:${power}`)
}

/** Drive every wind material from the single game clock. */
export function updateWind(time: number) {
  for (const c of clocks) c.value = time
}
