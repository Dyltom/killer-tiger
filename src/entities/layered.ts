/**
 * Collapse a character's submeshes into one draw call apiece.
 *
 * A MakeHuman export arrives as one mesh per garment — body, shirt, trousers,
 * shoes, hair, brows, eyes — and every one of them is a separate draw call
 * carrying a separate `MeshStandardMaterial`. At forty villagers that is around
 * 240 submissions and 240 materials in the colour pass, and both halves of that
 * were measured to cost about five milliseconds each on the worst frame in the
 * game (wave twelve, night, forty men):
 *
 *   - swapping every human onto one shared material, changing nothing else and
 *     leaving the call count alone, took CPU from 12.2 ms to 7.2;
 *   - hiding everything but the body mesh, which removed 289 calls, took it to
 *     6.75.
 *
 * The two overlap, because they are the same event: three re-uploads a
 * material's whole uniform block whenever the material changes between draws,
 * and with 240 distinct materials sharing one program that is every draw. So
 * fewer meshes buys both at once, and the win is the sum rather than the max.
 *
 * The only thing stopping the submeshes being merged is that they disagree
 * about their diffuse map. Everything else already matches — no normal,
 * roughness or AO maps anywhere in the cast, no vertex colours, the same
 * double-sided setting, metalness zero throughout — and `unify` in body.ts has
 * already put them on one skeleton in one coordinate space, which is the other
 * precondition. So the maps go into a `sampler2DArray` and each vertex carries
 * the layer it wants.
 *
 * An array rather than an atlas, deliberately. An atlas would need no shader at
 * all — scale and bias the UVs into a tile and merge — but a tile's mip chain
 * blends into its neighbours', so a villager's shirt starts bleeding skin into
 * itself at exactly the distances where most of the crowd lives. Array layers
 * mip independently, which makes the merge free of visual consequence rather
 * than a trade.
 *
 * Roughness, the alpha-test threshold and the specular intensity differ per
 * submesh too (skin 0.62/0.7, a suit 0.86/0.6, boots 0.60/0.9), so they ride
 * along as vertex attributes in the same `vec4` as the layer index. Attributes
 * rather than a uniform array on purpose: a `uniform float[N]` would be one more
 * block to re-upload per material, which is the cost this file exists to remove.
 *
 * Specular intensity is here because leaving it out was a visible loss rather
 * than a theoretical one. It arrives from `KHR_materials_specular` — which is
 * also why the whole cast loads as `MeshPhysicalMaterial` — and the merge takes
 * every uniform from the first mesh in the group. The eyes want 0.9 and the
 * eyebrows 0.4, and the brows sort first, so the merged eyes came out matte.
 */
import * as THREE from 'three'

/**
 * Layers of a texture array must all be one size, so the group's largest map
 * sets it and the smaller ones are upscaled to match.
 *
 * Capped because upscaling is the one way this can cost memory: the elder's
 * 512-pixel garments become 1024s and his group goes from 7 MB to 21. A cap
 * above the largest map in the cast would let a future 2048 skin quadruple
 * three garments alongside it.
 */
const LAYER_CAP = 1024

/** Attributes a skinned merge has to carry, and their item sizes. */
const ATTRS: [name: string, size: number][] = [
  ['position', 3], ['normal', 3], ['uv', 2], ['skinIndex', 4], ['skinWeight', 4],
]

/** What the merged geometry's material needs to know to shade it. */
interface Layered {
  readonly tex: THREE.DataArrayTexture
  /** Whether any layer discards, and so whether the shader needs the branch. */
  readonly cuts: boolean
  /**
   * The shadow material for this geometry, or null if nothing in it discards.
   *
   * One per geometry rather than per body: nothing in it varies between two men
   * wearing the same clothes. Bodies that carry a bone-atlas row do need one
   * each — see `applyLayerShadow` — and that turns out to cost nothing, which
   * is worth recording next to the header's five-millisecond figure for shared
   * materials. That was 240 materials on one program; at 80 the effect is gone
   * entirely (eighty distinct, eighty shared and one shared all measure the
   * same), so this is a tidiness rather than a saving.
   */
  readonly depth: THREE.MeshDepthMaterial | null
}

/**
 * Keyed on geometry rather than material because that is what survives.
 *
 * `SkeletonUtils.clone` shares geometry between every copy of a character, and
 * `makeBody` then clones the material per body so each can carry its own wound
 * uniforms — and `Material.copy` does not copy `onBeforeCompile`. So the shader
 * injection has to be re-applied to every clone, and the geometry is the thread
 * that leads from a cloned material back to the array texture it needs.
 */
const registry = new WeakMap<THREE.BufferGeometry, Layered>()

/** Draw an image into a square canvas of `size` and read it back as RGBA8. */
function resample(img: CanvasImageSource, size: number): Uint8ClampedArray {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('no 2d context')
  ctx.drawImage(img, 0, 0, size, size)
  return ctx.getImageData(0, 0, size, size).data
}

/**
 * Stack the group's diffuse maps into one array texture.
 *
 * `flipY` is off and the rows go in exactly as the canvas reads them out, top
 * first, which is what a glTF texture does too — the loader turns three's
 * default flip off for every image it imports, because glTF's UV origin is the
 * top left. Getting this backwards is not subtle; the faces come out upside
 * down.
 */
function buildArray(maps: THREE.Texture[]): THREE.DataArrayTexture {
  let size = 0
  for (const m of maps) {
    const img = m.image as { width: number; height: number }
    size = Math.max(size, img.width, img.height)
  }
  size = Math.min(size, LAYER_CAP)

  const layer = size * size * 4
  const data = new Uint8Array(layer * maps.length)
  for (let i = 0; i < maps.length; i++) {
    data.set(resample(maps[i]!.image as CanvasImageSource, size), i * layer)
  }

  const tex = new THREE.DataArrayTexture(data, size, size, maps.length)
  const first = maps[0]!
  tex.format = THREE.RGBAFormat
  tex.type = THREE.UnsignedByteType
  // sRGB so three asks for an SRGB8_ALPHA8 internal format and the hardware
  // decodes on sample, exactly as it does for the 2D maps being replaced.
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = first.wrapS
  tex.wrapT = first.wrapT
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = first.anisotropy
  tex.flipY = false
  tex.needsUpdate = true
  return tex
}

/**
 * The three `KHR_materials_specular` properties, readable off a material that
 * may not have them.
 *
 * `mergeable` accepts a plain `MeshStandardMaterial`, which carries none of
 * these; the defaults are the values the physical shader falls back to when
 * `USE_SPECULAR` is not defined, so a Standard group merges to the same picture
 * it had before.
 */
const WHITE = new THREE.Color(1, 1, 1)
type Spec = Partial<THREE.MeshPhysicalMaterial>
const ior = (m: THREE.Material) => (m as Spec).ior ?? 1.5
const tint = (m: THREE.Material) => (m as Spec).specularColor ?? WHITE
const gloss = (m: THREE.Material) => (m as Spec).specularIntensity ?? 1

/**
 * True if `m` can be folded in with the rest — same rig, same bind, and a
 * material that differs from its neighbours in nothing but its diffuse map.
 *
 * Everything refused here keeps its own mesh and renders exactly as it does
 * today, which is the point: this is an optimisation, and an asset it does not
 * understand should cost it the saving rather than the picture.
 */
function mergeable(m: THREE.SkinnedMesh, first: THREE.SkinnedMesh): boolean {
  const mat = m.material as THREE.MeshStandardMaterial
  const ref = first.material as THREE.MeshStandardMaterial
  if (!mat.isMeshStandardMaterial || !mat.map?.image) return false
  if (m.skeleton !== first.skeleton) return false
  if (!m.bindMatrix.equals(first.bindMatrix)) return false
  // The node transform, not `matrix`, which has not been updated yet at load.
  if (!m.position.equals(first.position) || !m.quaternion.equals(first.quaternion)) return false
  if (!m.scale.equals(first.scale)) return false
  if (mat.side !== ref.side || mat.transparent !== ref.transparent) return false
  if (mat.vertexColors || mat.metalness !== ref.metalness) return false
  // Specular *intensity* is per-layer below; the tint and the IOR that go with
  // it are not, so a group that disagreed on those would have to be refused.
  // Nothing in the cast does — every material is a white tint at IOR 1.5.
  if (ior(mat) !== ior(ref) || !tint(mat).equals(tint(ref))) return false
  if (mat.normalMap || mat.roughnessMap || mat.metalnessMap || mat.aoMap ||
      mat.alphaMap || mat.emissiveMap || mat.lightMap || mat.displacementMap) return false
  if (!mat.color.equals(ref.color)) return false
  for (const [name] of ATTRS) if (!m.geometry.getAttribute(name)) return false
  return true
}

/**
 * Merge `meshes` into a single SkinnedMesh, in place under their shared parent.
 *
 * `meshes[0]` sets the terms and anything that cannot meet them is dropped from
 * the merge and left as it is, so call this with the mesh you most want folded
 * in at the front. Returns the merged mesh, or null if fewer than two survived.
 *
 * Every attribute is rewritten as float32 rather than kept in the source's
 * quantized types, because the submeshes do not agree on those types: `unify`
 * has already replaced the garments' positions with float32 to escape a
 * clamping bug in the meshopt encoding, while the body mesh still holds int16.
 * Merging mixed types is not possible and picking the narrowest would put the
 * body back through the quantizer. The cost is about 64 bytes a vertex over
 * roughly 12,000 vertices a character — under 4 MB for the whole cast, paid
 * once and shared by every clone.
 */
export function mergeLayered(
  candidates: THREE.SkinnedMesh[],
  name: string,
): THREE.SkinnedMesh | null {
  if (candidates.length < 2) return null
  const first = candidates[0]!
  const parent = first.parent
  if (!parent) return null
  const meshes = candidates.filter(m => m.parent === parent && mergeable(m, first))
  if (meshes.length < 2) return null

  let verts = 0
  let indices = 0
  for (const m of meshes) {
    const g = m.geometry
    verts += g.getAttribute('position').count
    indices += g.index ? g.index.count : g.getAttribute('position').count
  }

  const out = new THREE.BufferGeometry()
  const cursor = { v: 0, i: 0 }
  const index = new Uint32Array(indices)
  const layer = new Float32Array(verts * 4)
  const dst = new Map<string, Float32Array>()
  for (const [attr, size] of ATTRS) dst.set(attr, new Float32Array(verts * size))

  const maps: THREE.Texture[] = []
  let cuts = false
  for (const m of meshes) {
    const g = m.geometry
    const mat = m.material as THREE.MeshStandardMaterial
    // Two submeshes painted from the same image share a layer. Nothing in the
    // cast does today; it costs one lookup to not depend on that.
    let li = maps.indexOf(mat.map!)
    if (li < 0) li = maps.push(mat.map!) - 1
    if (mat.alphaTest > 0) cuts = true

    const n = g.getAttribute('position').count
    for (const [attr, size] of ATTRS) {
      const src = g.getAttribute(attr)
      const buf = dst.get(attr)!
      // Through the accessors, not the raw array: they undo the meshopt
      // normalization, which differs per attribute and per submesh.
      for (let i = 0; i < n; i++) {
        const o = (cursor.v + i) * size
        buf[o] = src.getX(i)
        if (size > 1) buf[o + 1] = src.getY(i)
        if (size > 2) buf[o + 2] = src.getZ(i)
        if (size > 3) buf[o + 3] = src.getW(i)
      }
    }
    for (let i = 0; i < n; i++) {
      const o = (cursor.v + i) * 4
      layer[o] = li
      layer[o + 1] = mat.roughness
      layer[o + 2] = mat.alphaTest
      layer[o + 3] = gloss(mat)
    }

    const idx = g.index
    const count = idx ? idx.count : n
    for (let i = 0; i < count; i++) index[cursor.i + i] = (idx ? idx.getX(i) : i) + cursor.v
    cursor.v += n
    cursor.i += count
  }

  for (const [attr, size] of ATTRS) {
    out.setAttribute(attr, new THREE.BufferAttribute(dst.get(attr)!, size))
  }
  out.setAttribute('aLayer', new THREE.BufferAttribute(layer, 4))
  out.setIndex(new THREE.BufferAttribute(index, 1))

  const mat = (first.material as THREE.MeshStandardMaterial).clone()
  mat.name = name
  mat.map = null
  // The per-layer values live in the attribute; the uniform becomes a plain
  // multiplier over all of them, which is exactly how human.ts already drives
  // it — `soak` scales every material's roughness by the same factor as a man
  // bleeds out, and scaling one now covers the whole body.
  mat.roughness = 1
  // Same treatment, same reason: the shader multiplies the uniform by the
  // per-layer value, so one is the identity and anything driving the material as
  // a whole still works.
  if ('specularIntensity' in mat) (mat as THREE.MeshPhysicalMaterial).specularIntensity = 1
  // Zero because the threshold is per-layer, in `vLayer.z`, and the shadow pass
  // reads that same attribute through `layerDepth` below rather than through
  // three's derived depth material. A non-zero value here would only make three
  // define `USE_ALPHATEST` on a colour shader whose alpha test has already been
  // replaced.
  mat.alphaTest = 0

  const merged = new THREE.SkinnedMesh(out, mat)
  merged.name = name
  merged.bind(first.skeleton, first.bindMatrix)
  merged.position.copy(first.position)
  merged.quaternion.copy(first.quaternion)
  merged.scale.copy(first.scale)
  merged.castShadow = first.castShadow
  merged.receiveShadow = first.receiveShadow

  const tex = buildArray(maps)
  registry.set(out, { tex, cuts, depth: cuts ? layerDepth(tex) : null })
  for (const m of meshes) parent.remove(m)
  parent.add(merged)
  return merged
}

/**
 * The shadow-pass twin of the injection below: sample the array and discard.
 *
 * Without this a merged group cannot contain anything that alpha-tests. Three
 * derives a depth material from the colour one and gives it that material's
 * `map`, and a merged material has none — its texture is an array the depth
 * shader knows nothing about — so a merged hairline would go into the shadow
 * map as the full unclipped shell it is modelled on. That is what used to keep
 * the hair out of the merge and cost a draw call and a material per villager.
 *
 * The colour material's own `alphaTest` is not consulted here for the same
 * reason it is not consulted there: the threshold is per-layer, and the layer
 * a fragment belongs to is the only thing that knows it.
 *
 * Checked by rendering a body with this material in place of its colour one and
 * comparing silhouettes: eight angles round the head, not one pixel of
 * difference either way. The hunter loses ten thousand pixels if the threshold
 * is forced to 0.99, so the fetch and the UVs are live and not a discard that
 * never fires, and swapping in a discard-everything depth material moves 3.5%
 * of a lit frame, so this is the material the shadow pass actually reads.
 *
 * What was *not* observed is a visible defect from going without it. Letting
 * three derive the depth material instead — the unclipped shell — changed no
 * pixels at all at any camera tried, down to 0.8 m from the face. At a 2048 map
 * with `SHADOW.radius` of PCF over it, a few millimetres of fringe do not
 * survive. So the honest claim is that this is exactly right for free, not that
 * it rescued a shadow anyone would have seen.
 */
function layerDepth(tex: THREE.DataArrayTexture): THREE.MeshDepthMaterial {
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
  depth.onBeforeCompile = shader => {
    shader.uniforms.tLayers = { value: tex }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */ `
        #include <common>
        attribute vec4 aLayer;
        flat varying vec4 vLayer;
        varying vec2 vLayerUv;
      `)
      .replace('#include <begin_vertex>', /* glsl */ `
        #include <begin_vertex>
        vLayer = aLayer;
        vLayerUv = uv;
      `)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */ `
        #include <common>
        precision highp sampler2DArray;
        uniform sampler2DArray tLayers;
        flat varying vec4 vLayer;
        varying vec2 vLayerUv;
      `)
      // The `map_fragment` above this leaves `diffuseColor` at one, there being
      // no map, so the alpha the test wants has to come from the array here.
      .replace(
        '#include <alphatest_fragment>',
        'if ( texture( tLayers, vec3( vLayerUv, vLayer.x ) ).a < vLayer.z ) discard;',
      )
  }
  depth.customProgramCacheKey = () => 'layers-depth'
  return depth
}

/**
 * Teach a cloned material to read the array texture its geometry was merged
 * against. A no-op on anything that was not merged.
 *
 * Must run *before* `addWoundShading`, which chains onto `onBeforeCompile` by
 * calling whatever was there first: the diffuse sample belongs under the wound
 * colouring, not over it.
 *
 * One consequence worth naming, because it is a real if small difference
 * against the unmerged build. The wound shader makes a cut wet by writing
 * `roughnessFactor = mix( roughnessFactor, 0.25, wet )` immediately after
 * `roughnessmap_fragment`, and the per-layer multiply below lands after that
 * — so a wet wound on skin ends up at 0.25 x 0.62 rather than 0.25, and reads
 * very slightly glossier. Both patches anchor on the same include and the
 * later one always inserts nearer to it, so there is no ordering of the two
 * that puts the multiply first without one of them abandoning the anchor.
 */
export function applyLayers(mat: THREE.MeshStandardMaterial, geom: THREE.BufferGeometry) {
  const info = registry.get(geom)
  if (!info) return

  const prev = mat.onBeforeCompile.bind(mat)
  mat.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer)
    shader.uniforms.tLayers = { value: info.tex }

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */ `
        #include <common>
        attribute vec4 aLayer;
        flat varying vec4 vLayer;
        varying vec2 vLayerUv;
      `)
      // `uv` is declared unconditionally by three's vertex prefix, so this does
      // not need the material to carry a map to get at it — which is the whole
      // reason the merged material has none.
      .replace('#include <begin_vertex>', /* glsl */ `
        #include <begin_vertex>
        vLayer = aLayer;
        vLayerUv = uv;
      `)

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */ `
        #include <common>
        precision highp sampler2DArray;
        uniform sampler2DArray tLayers;
        flat varying vec4 vLayer;
        varying vec2 vLayerUv;
      `)
      // Replacing the include rather than appending to it: without a `map` there
      // is nothing in there to keep, and `diffuseColor` is already the material
      // colour times opacity at this point, which is what it multiplies.
      .replace(
        '#include <map_fragment>',
        'diffuseColor *= texture( tLayers, vec3( vLayerUv, vLayer.x ) );',
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor *= vLayer.y;',
      )
      // Re-derived rather than patched into the chunk: `specularIntensityFactor`
      // is local to it, and the two lines it feeds are wrapped in four nested
      // ifdefs. These are those lines with the uniform swapped for the attribute,
      // and `USE_SPECULAR` is exactly the condition under which the chunk ran
      // them, so a merged group that arrived as plain Standard skips this and
      // keeps three's fixed 0.04.
      .replace('#include <lights_physical_fragment>', /* glsl */ `
        #include <lights_physical_fragment>
        #ifdef USE_SPECULAR
          float layerSpec = specularIntensity * vLayer.w;
          material.specularF90 = mix( layerSpec, 1.0, metalnessFactor );
          material.specularColor = min(
            pow2( ( material.ior - 1.0 ) / ( material.ior + 1.0 ) ) * specularColor,
            vec3( 1.0 )
          ) * layerSpec;
          material.specularColorBlended =
            mix( material.specularColor, diffuseColor.rgb, metalnessFactor );
        #endif
      `)

    if (info.cuts) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <alphatest_fragment>',
        'if ( diffuseColor.a < vLayer.z ) discard;',
      )
    }
  }

  // Same reason wounds.ts does it: a merged material and an unmerged one can
  // agree on every parameter three hashes and be handed each other's program.
  const prevKey = mat.customProgramCacheKey.bind(mat)
  mat.customProgramCacheKey = () => `${prevKey()}|layers`
}

/**
 * Point a merged mesh's shadow at `layerDepth`. A no-op on anything that was
 * not merged, or merged out of parts none of which discard.
 *
 * Unlike `applyLayers` this is per-mesh rather than per-material, and by
 * default what it hands over is shared by every clone rather than cloned with
 * them. `own` builds a fresh one instead, for a body that has something of its
 * own to put in it — pose.ts needs a per-body uniform in the shadow shader, and
 * a shared material can only carry one body's value. Built rather than cloned
 * because `Material.copy` does not carry `onBeforeCompile`, which is where all
 * of `layerDepth` lives.
 */
export function applyLayerShadow(mesh: THREE.Mesh, own = false) {
  const info = registry.get(mesh.geometry)
  if (!info?.depth) return
  mesh.customDepthMaterial = own ? layerDepth(info.tex) : info.depth
}
