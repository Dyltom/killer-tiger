/**
 * Aerial perspective.
 *
 * Three's stock fog is a single flat colour applied by distance. That reads as
 * a grey wash and flattens the whole scene. This replaces it with fog that is
 *
 *   - height-attenuated, so it pools in the valley and thins as you look up, and
 *   - view-direction tinted, so looking into the low sun gives a hot orange haze
 *     while looking away gives cool blue.
 *
 * Overriding the ShaderChunk is the only practical way to apply this to every
 * stock MeshStandardMaterial at once — patching materials individually would
 * mean remembering to do it for every mesh anyone ever adds.
 *
 * The sun direction and the two haze colours change all day, so they have to be
 * uniforms. Three deep-clones uniform *values* per material, which normally
 * means a shared object doesn't stay shared — but cloneUniforms only clones
 * three's own types and real Arrays, so a Float32Array value is copied by
 * reference and every material ends up pointing at the same three floats.
 * Writing into it once a frame therefore updates the whole scene, with no
 * per-material bookkeeping and no recompiles.
 */
import * as THREE from 'three'
import { FOG, SKY } from '../config'

/** World-space unit vector pointing from the scene toward the sun. */
export function sunDirection(target = new THREE.Vector3()): THREE.Vector3 {
  const phi = THREE.MathUtils.degToRad(90 - SKY.sunElevation)
  const theta = THREE.MathUtils.degToRad(SKY.sunAzimuth)
  return target.setFromSphericalCoords(1, phi, theta)
}

/**
 * Live atmosphere state, shared by reference with every fog-enabled material.
 * Written by DayNight; read by the fog chunk below.
 */
export const atmosphere = {
  sunDir: new Float32Array([0, 0.18, -0.98]),
  /** Linear-space haze colour looking into the sun... */
  sunColor: new Float32Array(3),
  /** ...and looking away from it. */
  awayColor: new Float32Array(3),
  /** x: density, y: height falloff, z: far-plane haze floor. */
  params: new Float32Array([FOG.density, FOG.heightFalloff, FOG.farFloor]),
}

const FOG_UNIFORMS = {
  fogSunDir: { value: atmosphere.sunDir },
  fogSunColor: { value: atmosphere.sunColor },
  fogAwayColor: { value: atmosphere.awayColor },
  fogParams: { value: atmosphere.params },
}

function toLinear(hex: number, out: Float32Array) {
  const c = new THREE.Color(hex).convertSRGBToLinear()
  out[0] = c.r; out[1] = c.g; out[2] = c.b
}

/** Fixed-point GLSL literal. Plain `toString` can emit `1e-7`, which is not valid GLSL. */
const f = (n: number) => n.toFixed(6)

let installed = false

/**
 * Must be called before any material is compiled. Idempotent so a hot reload
 * doesn't stack overrides.
 */
export function installAtmosphericFog() {
  if (installed) return
  installed = true

  toLinear(FOG.sunColor, atmosphere.sunColor)
  toLinear(FOG.awayColor, atmosphere.awayColor)
  sunDirection().toArray(atmosphere.sunDir)

  // Every built-in material's uniform set is cloned from ShaderLib the first
  // time it compiles, so the four extra uniforms have to be in there before any
  // material is built. Only fog-enabled shaders declare them.
  for (const key of Object.keys(THREE.ShaderLib)) {
    const u = THREE.ShaderLib[key as keyof typeof THREE.ShaderLib]!.uniforms as Record<string, unknown>
    if ('fogColor' in u) Object.assign(u, FOG_UNIFORMS)
  }

  THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
    #ifdef USE_FOG
      varying float vFogDepth;
      varying vec3 vFogWorld;
    #endif
  `

  // Mirrors what three's own <worldpos_vertex> does, but unconditionally —
  // that chunk only defines worldPosition when lighting happens to need it.
  THREE.ShaderChunk.fog_vertex = /* glsl */ `
    #ifdef USE_FOG
      vFogDepth = - mvPosition.z;
      vec4 fogWorld = vec4( transformed, 1.0 );
      #ifdef USE_INSTANCING
        fogWorld = instanceMatrix * fogWorld;
      #endif
      vFogWorld = ( modelMatrix * fogWorld ).xyz;
    #endif
  `

  THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
    #ifdef USE_FOG
      uniform vec3 fogColor;
      uniform float fogDensity;
      uniform vec3 fogSunDir;
      uniform vec3 fogSunColor;
      uniform vec3 fogAwayColor;
      uniform vec3 fogParams;
      varying float vFogDepth;
      varying vec3 vFogWorld;
    #endif
  `

  THREE.ShaderChunk.fog_fragment = /* glsl */ `
    #ifdef USE_FOG
    {
      vec3 fogRay = vFogWorld - cameraPosition;
      float fogDist = max( length( fogRay ), 1e-4 );
      vec3 fogDir = fogRay / fogDist;

      // Analytic integral of exp(-height * b) density along the view ray
      // (Quilez). The near-horizontal case is split out because the closed
      // form divides by the ray's vertical component.
      float B = fogParams.y;
      float D = fogParams.x;
      float baseline = D * exp( - max( cameraPosition.y, -40.0 ) * B );
      float ry = fogDir.y;
      float optical = abs( ry ) < 1e-3
        ? baseline * fogDist
        : baseline * ( 1.0 - exp( - fogDist * ry * B ) ) / ( ry * B );
      float fogFactor = 1.0 - exp( - max( optical, 0.0 ) );

      // Nothing should ever be a fully crisp silhouette at the far plane, or
      // the boundary cliffs pop against the sky.
      fogFactor = max( fogFactor, smoothstep( ${f(FOG.maxDistance * 0.45)}, ${f(FOG.maxDistance)}, fogDist ) * fogParams.z );

      // Warm looking into the sun, cool away from it. The tight lobe is the
      // scattering hotspot; the wide one keeps the whole sunward half warm.
      float sunAmt = max( dot( fogDir, fogSunDir ), 0.0 );
      vec3 fogCol = mix( fogAwayColor, fogSunColor, pow( sunAmt, 5.0 ) );
      fogCol = mix( fogCol, fogSunColor * 0.72, pow( sunAmt, 1.6 ) * 0.38 );

      gl_FragColor.rgb = mix( gl_FragColor.rgb, fogCol, clamp( fogFactor, 0.0, 1.0 ) );
    }
    #endif
  `
}

/**
 * scene.fog only exists to make three define USE_FOG and supply the uniforms
 * the chunk declares; the override ignores its colour and density.
 */
export function makeFog(): THREE.FogExp2 {
  return new THREE.FogExp2(FOG.awayColor, FOG.density)
}
