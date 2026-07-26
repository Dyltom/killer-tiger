/**
 * Contact shading — the dark patch the ground takes under a planted paw.
 *
 * This is the fix for the forepaws hovering, and no amount of work on the foot
 * itself substitutes for it: the viewmodel is a camera child that never reaches
 * the shadow map, so before this there was not one pixel in the render
 * connecting a foot to the dirt under it, and a foot with no contact cue reads
 * as floating however accurately it is placed.
 *
 * It used to be a soft-edged quad laid on the ground under each paw, and that
 * did not work — not because the quad was wrong but because it was *buried*. A
 * raycast straight down through a planted paw comes back with three tufts of
 * ground cover between 9 and 14 cm up before it ever reaches the terrain, so a
 * decal sitting 2 cm above the soil is behind the grass in every pixel the
 * player can see. Lifting it clear of the canopy would have parked the shadow
 * level with the top of the foot, and taking it off the depth buffer would have
 * painted it over the toes.
 *
 * So there is no decal. The occlusion is injected into the ground's own
 * materials instead, terrain and foliage alike, and each fragment darkens itself
 * by how close it is to a contact point. That gets it right by construction:
 * grass around the foot goes dark the way grass around a foot does, nothing
 * sorts against anything, and there is no surface for the effect to sit on top
 * of or slide against.
 *
 * The cost is one distance test per contact per ground fragment, which is
 * nothing, plus the requirement that every material meant to take it opts in.
 */
import * as THREE from 'three'

/** How many contact points the shader carries. Two forefeet. */
export const CONTACTS = 2

/** xyz — world-space contact point, w — strength, 0 for off. */
const points = [new THREE.Vector4(0, -1e4, 0, 0), new THREE.Vector4(0, -1e4, 0, 0)]
/** x — radius in metres, y — how far up a blade the darkening still reaches. */
const shapes = [new THREE.Vector2(0.3, 0.5), new THREE.Vector2(0.3, 0.5)]

// One uniform object shared by every material that opts in, so a frame's worth
// of contact bookkeeping is two vector writes rather than a walk over the
// scene's materials.
const uContact = { value: points }
const uContactShape = { value: shapes }

/**
 * Move one contact. `strength` at 0 switches it off entirely, which is what a
 * lifted foot does — a contact shadow that stays put while the foot rises is
 * worse than none at all, because it is the half of the cue that says the foot
 * is *touching*.
 */
export function setContact(
  i: number,
  x: number,
  y: number,
  z: number,
  strength: number,
  radius: number,
  reach: number,
) {
  points[i].set(x, y, z, strength)
  shapes[i].set(radius, reach)
}

/**
 * Let a material take contact shading. Chains onto whatever else has already
 * been injected, so it composes with wind, translucency and the distance fade.
 *
 * The world position is taken after `<project_vertex>` rather than from
 * `<worldpos_vertex>`: that chunk only exists when the material happens to need
 * it for shadows or environment mapping, and the position wanted here is the one
 * *after* the wind has bent the blade, so a stalk leaning into the foot picks up
 * the shade and one leaning out of it loses it.
 */
export function addContactShade(mat: THREE.Material) {
  const prev = mat.onBeforeCompile.bind(mat)

  mat.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer)
    shader.uniforms.uContact = uContact
    shader.uniforms.uContactShape = uContactShape

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        varying vec3 vContactW;
        `,
      )
      .replace(
        '#include <project_vertex>',
        /* glsl */ `
        #include <project_vertex>
        {
          vec4 contactP = vec4( transformed, 1.0 );
          #ifdef USE_INSTANCING
            contactP = instanceMatrix * contactP;
          #endif
          vContactW = ( modelMatrix * contactP ).xyz;
        }
        `,
      )

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        varying vec3 vContactW;
        uniform vec4 uContact[ ${CONTACTS} ];
        uniform vec2 uContactShape[ ${CONTACTS} ];
        `,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `
        #include <color_fragment>
        {
          float occ = 0.0;
          for ( int i = 0; i < ${CONTACTS}; i ++ ) {
            vec4 c = uContact[ i ];
            if ( c.w <= 0.0 ) continue;
            vec2 shape = uContactShape[ i ];
            // Dense out to a fifth of the radius and gone at the rim. Occlusion
            // under a foot is near-total right beneath the pads and finished
            // within a paw's width; a linear ramp reads as a painted grey disc.
            float d = distance( vContactW.xz, c.xz ) / max( shape.x, 1e-3 );
            float a = 1.0 - smoothstep( 0.45, 1.0, d );
            // And it climbs no higher than the tuft it is cast into. Without
            // this the whole blade goes dark to the tip and the field around
            // each foot reads as a hole rather than as shaded grass.
            a *= 1.0 - smoothstep( 0.0, shape.y, max( 0.0, vContactW.y - c.y ) );
            // max, not sum: two feet close together share one shadow, they do
            // not stack into a black one.
            occ = max( occ, a * c.w );
          }
          diffuseColor.rgb *= 1.0 - occ;
        }
        `,
      )
  }

  // Same job as tagProgram() in materials.ts, inlined to keep this module off
  // the import cycle materials.ts -> contact.ts would otherwise close.
  const key = mat.customProgramCacheKey.bind(mat)
  mat.customProgramCacheKey = () => `${key()}|contact`
}
