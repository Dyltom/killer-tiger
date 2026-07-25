/**
 * PBR materials built from the Poly Haven CC0 sets in public/assets/textures.
 *
 * Each set is three files: albedo, an OpenGL-convention tangent normal map, and
 * an ARM pack (ambient occlusion in R, roughness in G, metalness in B) — which
 * is exactly the channel layout three's aoMap/roughnessMap/metalnessMap already
 * read, so one texture drives all three.
 *
 * The terrain gets a custom shader on top of MeshStandardMaterial: two material
 * layers blended by slope, noise and distance from the village, each sampled at
 * two frequencies to break up the tiling. Injecting into the standard material
 * rather than writing one from scratch keeps shadows, IBL and the atmospheric
 * fog working without reimplementing any of it.
 */
import * as THREE from 'three'
import { WORLD } from '../config'

export interface PbrSet {
  map: THREE.Texture
  normalMap: THREE.Texture
  /** AO (R) / roughness (G) / metalness (B). */
  armMap: THREE.Texture
}

const BASE = 'assets/textures'

export const loadingManager = new THREE.LoadingManager()
const loader = new THREE.TextureLoader(loadingManager)

function loadSet(slug: string, repeat: number, anisotropy: number): PbrSet {
  const get = (suffix: string, srgb: boolean) => {
    const t = loader.load(`${BASE}/${slug}_${suffix}.webp`)
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.repeat.setScalar(repeat)
    t.anisotropy = anisotropy
    // Only albedo is colour data. Tagging a normal or ARM map as sRGB puts a
    // gamma curve through numbers that are supposed to be linear, which shows
    // up as normals that are too weak and roughness that is far too low.
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
    return t
  }
  return { map: get('diff', true), normalMap: get('nor', false), armMap: get('arm', false) }
}

let sets: Record<string, PbrSet> | null = null

/** Anisotropy is clamped to what the GPU actually supports at first call. */
let maxAniso = 8

export function initMaterials(renderer: THREE.WebGLRenderer) {
  maxAniso = Math.min(16, renderer.capabilities.getMaxAnisotropy())
  sets = {
    grass: loadSet('aerial_grass_rock', 1, maxAniso),
    dirt: loadSet('dry_ground_rocks', 1, maxAniso),
    bark: loadSet('bark_brown_02', 1, maxAniso),
    rock: loadSet('rock_wall_02', 1, maxAniso),
    clay: loadSet('patterned_clay_wall', 1, maxAniso),
    thatch: loadSet('reed_roof_04', 1, maxAniso),
  }
}

export function pbr(name: keyof NonNullable<typeof sets>): PbrSet {
  if (!sets) throw new Error('initMaterials() must run before materials are built')
  return sets[name]!
}

interface SurfaceOptions {
  repeat?: [number, number]
  color?: number
  roughness?: number
  normalScale?: number
  aoIntensity?: number
  flatShading?: boolean
}

/**
 * A standard surface from one PBR set. `repeat` is per-material, so the same
 * texture can tile at different densities on a hut wall and a fence post
 * without cloning the underlying image.
 */
export function surface(name: string, opts: SurfaceOptions = {}): THREE.MeshStandardMaterial {
  const set = pbr(name as never)
  const [rx, ry] = opts.repeat ?? [1, 1]

  // Textures are shared across materials, so a per-material repeat needs its
  // own Texture view. clone() shares the underlying image data.
  const clone = (t: THREE.Texture, srgb: boolean) => {
    const c = t.clone()
    c.wrapS = c.wrapT = THREE.RepeatWrapping
    c.repeat.set(rx, ry)
    c.anisotropy = maxAniso
    c.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
    c.needsUpdate = true
    return c
  }

  const arm = clone(set.armMap, false)
  return new THREE.MeshStandardMaterial({
    map: clone(set.map, true),
    normalMap: clone(set.normalMap, false),
    normalScale: new THREE.Vector2(opts.normalScale ?? 1, opts.normalScale ?? 1),
    aoMap: arm,
    aoMapIntensity: opts.aoIntensity ?? 1,
    roughnessMap: arm,
    roughness: opts.roughness ?? 1,
    metalness: 0,
    color: opts.color ?? 0xffffff,
    flatShading: opts.flatShading ?? false,
  })
}

/**
 * Distinguish two materials that share a class and defines but have different
 * injected GLSL. Without this three hands back whichever program it compiled
 * first — so every wind material in the scene would inherit the amplitude of
 * the first one compiled.
 */
export function tagProgram(mat: THREE.Material, tag: string) {
  const prev = mat.customProgramCacheKey.bind(mat)
  mat.customProgramCacheKey = () => `${prev()}|${tag}`
}

// ------------------------------------------------------------------ terrain
/** Tiles across the whole terrain for the close-up detail layer. */
const DETAIL_TILES = 90
/** ...and for the macro layer that breaks up its repetition. */
const MACRO_TILES = 5.5

/**
 * Terrain material. `size` is the full edge length of the terrain plane, which
 * the shader needs to turn the plane's 0..1 UV back into world coordinates.
 */
export function terrainMaterial(size: number): THREE.MeshStandardMaterial {
  const grass = pbr('grass')
  const dirt = pbr('dirt')

  const mat = new THREE.MeshStandardMaterial({
    // These four exist to make three define USE_MAP / USE_NORMALMAP /
    // USE_ROUGHNESSMAP / USE_AOMAP so the chunks below have somewhere to hook
    // into. Every one of them is replaced by the injected code.
    map: grass.map,
    normalMap: grass.normalMap,
    aoMap: grass.armMap,
    roughnessMap: grass.armMap,
    roughness: 1,
    metalness: 0,
  })

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.tGrassD = { value: grass.map }
    shader.uniforms.tGrassN = { value: grass.normalMap }
    shader.uniforms.tGrassA = { value: grass.armMap }
    shader.uniforms.tDirtD = { value: dirt.map }
    shader.uniforms.tDirtN = { value: dirt.normalMap }
    shader.uniforms.tDirtA = { value: dirt.armMap }
    shader.uniforms.uTerrainSize = { value: size }

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        varying vec3 vTerrainW;
        varying vec3 vTerrainN;
        `,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        #include <begin_vertex>
        vTerrainW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
        // The terrain mesh is axis-aligned and unrotated, so its object-space
        // normal is already the world normal.
        vTerrainN = normal;
        `,
      )

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        uniform sampler2D tGrassD, tGrassN, tGrassA;
        uniform sampler2D tDirtD, tDirtN, tDirtA;
        uniform float uTerrainSize;
        varying vec3 vTerrainW;
        varying vec3 vTerrainN;

        float terrHash( vec2 p ) {
          return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
        }
        float terrNoise( vec2 p ) {
          vec2 i = floor( p ), f = fract( p );
          f = f * f * ( 3.0 - 2.0 * f );
          return mix( mix( terrHash( i ), terrHash( i + vec2( 1, 0 ) ), f.x ),
                      mix( terrHash( i + vec2( 0, 1 ) ), terrHash( i + vec2( 1, 1 ) ), f.x ), f.y );
        }
        float terrFbm( vec2 p ) {
          float v = 0.0, a = 0.5;
          for ( int i = 0; i < 4; i ++ ) { v += a * terrNoise( p ); p *= 2.03; a *= 0.5; }
          return v;
        }

        // How much of this pixel is bare dirt rather than grass.
        float terrainDirtWeight() {
          float d = length( vTerrainW.xz );
          // The village is trodden bare, and it fades out into the grass.
          float village = 1.0 - smoothstep( 24.0, 44.0, d );
          // Anything steep sheds its topsoil.
          float slope = smoothstep( 0.14, 0.40, 1.0 - clamp( vTerrainN.y, 0.0, 1.0 ) );
          // Plus large dry patches so the plain isn't a uniform green. Kept
          // sparse: when most of the plain is bare, every grass tuft standing on
          // it reads as an individually placed prop instead of a sward.
          // ('patch' is a reserved word in GLSL ES 3.0 — do not rename this to it.)
          float dry = smoothstep( 0.54, 0.80, terrFbm( vTerrainW.xz * 0.021 ) );
          return clamp( village * 1.2 + slope + dry * 0.7, 0.0, 1.0 );
        }
        `,
      )
      // Albedo: two layers, each sampled at a detail and a macro frequency.
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        vec2 tUv = vMapUv * ${DETAIL_TILES.toFixed(1)};
        vec2 tUvMacro = vMapUv * ${MACRO_TILES.toFixed(1)};
        float dirtW = terrainDirtWeight();

        vec3 grassC = texture2D( tGrassD, tUv ).rgb;
        vec3 dirtC  = texture2D( tDirtD,  tUv ).rgb;

        // Macro variation. Modulating the detail layer by a very low-frequency
        // sample of the same image is what stops a 90x tiled texture from
        // reading as a grid; without it the repeat is obvious at 30 m out.
        float gm = dot( texture2D( tGrassD, tUvMacro ).rgb, vec3( 0.3333 ) );
        float dm = dot( texture2D( tDirtD,  tUvMacro ).rgb, vec3( 0.3333 ) );
        grassC *= mix( 0.68, 1.34, gm );
        dirtC  *= mix( 0.74, 1.28, dm );

        vec4 sampledDiffuseColor = vec4( mix( grassC, dirtC, dirtW ), 1.0 );
        diffuseColor *= sampledDiffuseColor;
        `,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
        vec3 mapN = mix(
          texture2D( tGrassN, tUv ).xyz,
          texture2D( tDirtN,  tUv ).xyz,
          dirtW
        ) * 2.0 - 1.0;
        // Flatten the normal with distance: past ~50 m the bumps are smaller
        // than a pixel and only produce shimmer.
        float nFade = 1.0 - smoothstep( 30.0, 90.0, length( vTerrainW - cameraPosition ) ) * 0.8;
        mapN.xy *= normalScale * nFade;
        normal = normalize( tbn * mapN );
        `,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
        float roughnessFactor = roughness * mix(
          texture2D( tGrassA, tUv ).g,
          texture2D( tDirtA,  tUv ).g,
          dirtW
        );
        `,
      )
      .replace(
        '#include <aomap_fragment>',
        /* glsl */ `
        float ambientOcclusion = mix(
          texture2D( tGrassA, tUv ).r,
          texture2D( tDirtA,  tUv ).r,
          dirtW
        );
        ambientOcclusion = ( ambientOcclusion - 1.0 ) * aoMapIntensity + 1.0;
        reflectedLight.indirectDiffuse *= ambientOcclusion;
        #if defined( USE_ENVMAP ) && defined( STANDARD )
          float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
          reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
        #endif
        `,
      )
  }

  // Any change to the injected source needs a distinct cache key or three will
  // hand back the program it compiled for a different terrain size.
  mat.customProgramCacheKey = () => `terrain:${size}`
  return mat
}

/** Terrain plane edge length, exported so world.ts and the shader agree. */
export const TERRAIN_SIZE = WORLD.radius * 2
