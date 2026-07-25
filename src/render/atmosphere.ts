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
 * All parameters are baked into the GLSL as literals rather than uniforms. The
 * time of day never changes at runtime, and three deep-clones uniform values
 * per material, so a shared uniform object would not have propagated anyway.
 */
import * as THREE from 'three'
import { FOG, SKY } from '../config'

/** World-space unit vector pointing from the scene toward the sun. */
export function sunDirection(target = new THREE.Vector3()): THREE.Vector3 {
  const phi = THREE.MathUtils.degToRad(90 - SKY.sunElevation)
  const theta = THREE.MathUtils.degToRad(SKY.sunAzimuth)
  return target.setFromSphericalCoords(1, phi, theta)
}

/** Fixed-point GLSL literal. Plain `toString` can emit `1e-7`, which is not valid GLSL. */
const f = (n: number) => n.toFixed(6)

/** `vec3(r, g, b)` in linear space, which is what the fog chunk operates in. */
function linearVec3(hex: number): string {
  const c = new THREE.Color(hex).convertSRGBToLinear()
  return `vec3(${f(c.r)}, ${f(c.g)}, ${f(c.b)})`
}

let installed = false

/**
 * Must be called before any material is compiled. Idempotent so a hot reload
 * doesn't stack overrides.
 */
export function installAtmosphericFog() {
  if (installed) return
  installed = true

  const sun = sunDirection()

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
      const float B = ${f(FOG.heightFalloff)};
      const float D = ${f(FOG.density)};
      float baseline = D * exp( - max( cameraPosition.y - ${f(0)}, -40.0 ) * B );
      float ry = fogDir.y;
      float optical = abs( ry ) < 1e-3
        ? baseline * fogDist
        : baseline * ( 1.0 - exp( - fogDist * ry * B ) ) / ( ry * B );
      float fogFactor = 1.0 - exp( - max( optical, 0.0 ) );

      // Nothing should ever be a fully crisp silhouette at the far plane, or
      // the boundary cliffs pop against the sky.
      fogFactor = max( fogFactor, smoothstep( ${f(FOG.maxDistance * 0.45)}, ${f(FOG.maxDistance)}, fogDist ) * ${f(FOG.farFloor)} );

      // Warm looking into the sun, cool away from it. The tight lobe is the
      // scattering hotspot; the wide one keeps the whole sunward half warm.
      float sunAmt = max( dot( fogDir, vec3(${f(sun.x)}, ${f(sun.y)}, ${f(sun.z)}) ), 0.0 );
      vec3 fogCol = mix( ${linearVec3(FOG.awayColor)}, ${linearVec3(FOG.sunColor)}, pow( sunAmt, 5.0 ) );
      fogCol = mix( fogCol, ${linearVec3(FOG.sunColor)} * 0.72, pow( sunAmt, 1.6 ) * 0.38 );

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
