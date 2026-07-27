"""Headless villager generator: MPFB2 (CC0) -> rigged, dressed human -> glTF.

Usage:  blender -b --python gen.py -- <spec.json> <out_dir> [only_variant]

Three things here are load-bearing.

*Materials are rebuilt, not edited.* MPFB builds a node graph for offline
rendering — a diffuseIntensity mix, litsphere params, alpha blending on every
slot. The glTF exporter can only express `baseColorTexture x baseColorFactor`, so
anything chained past that mix is silently dropped, and Blender's HASHED blend
mode exports as alpha-BLEND, which in three.js means a transparent, unsorted
face you can see the eyeballs through. So each slot gets a fresh two-node
Principled graph with an explicit alpha mode. It also rescues the garments whose
supplied textures are 65% transparent — they render as nothing otherwise.

*Tints are baked into pixels.* Same reason: a multiply node does not survive the
export, so a tint is applied to the image datablock instead.

*The cast is built in one process.* create_human costs about five seconds, so a
spec holds a `base` and a list of `variants` that override it.
"""
import addon_utils, os, sys, json, copy, shutil, bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rigfix

addon_utils.enable("bl_ext.user_default.mpfb", default_set=True, persistent=True)
from bl_ext.user_default.mpfb.services.locationservice import LocationService as L
from bl_ext.user_default.mpfb.services.humanservice import HumanService as H

argv = sys.argv[sys.argv.index("--") + 1:]
spec = json.load(open(argv[0]))
out_dir = argv[1]
only = argv[2] if len(argv) > 2 else None
os.makedirs(out_dir, exist_ok=True)


def merge(base, over):
    out = copy.deepcopy(base)
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def bake_tint(img, rgb):
    """Multiply an image's colour in place, leaving alpha alone."""
    px = np.asarray(img.pixels, dtype=np.float32).reshape(-1, 4)
    px[:, :3] *= np.asarray(rgb, dtype=np.float32)
    img.pixels = px.ravel()
    img.pack()


# Normal, AO and spec maps live in the same material as the diffuse, and picking
# the wrong one paints a character in tangent-space purple.
NOT_ALBEDO = ("norm", "_ao", "-ao", "spec", "bump", "rough", "disp", "gloss")


def find_albedo(obj):
    """The image a garment's colour actually comes from."""
    imgs = []
    for ms in obj.material_slots:
        if not (ms.material and ms.material.use_nodes):
            continue
        nt = ms.material.node_tree
        # Follow the graph back from Base Color first — that is the author's own
        # answer, and it beats guessing from filenames.
        for n in nt.nodes:
            if n.type != "BSDF_PRINCIPLED":
                continue
            seen, stack = set(), [n.inputs["Base Color"]]
            while stack:
                sock = stack.pop()
                for link in (l for l in nt.links if l.to_socket is sock):
                    src = link.from_node
                    if src in seen:
                        continue
                    seen.add(src)
                    if src.type == "TEX_IMAGE" and src.image:
                        return src.image
                    stack.extend(src.inputs)
        imgs += [n.image for n in nt.nodes if n.type == "TEX_IMAGE" and n.image]

    plain = [i for i in imgs if not any(k in i.name.lower() for k in NOT_ALBEDO)]
    return (plain or imgs or [None])[0]


def fix_extremities(img, band=0.26, lo=1.0, hi=1.2):
    """Pull the hand and foot UV islands back to the body's own tone.

    Every skin MakeHuman ships paints the extremities with a pale, desaturated
    wash that does not match the limb it joins — on the dark maps the hands come
    out three stops light, on the light maps nearly white. It reads as surgical
    gloves at any distance where you can see a villager's arms at all.

    hm08 topology puts the same islands in the same place on every map, so the
    bottom strip is the hands and feet plus the calf tops. Pixels there brighter
    than the torso get scaled by the torso-to-wash ratio per channel, which fixes
    saturation as well as level; pixels already on tone are left alone, so a map
    without the flaw passes through unchanged.
    """
    w, h = img.size
    px = np.asarray(img.pixels, dtype=np.float32).reshape(h, w, 4)
    Y = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)

    # Blender's pixel rows run bottom-up, so the band is the *start* of the array
    # and the torso, which sits in the map's upper half, is the end of it.
    torso = px[int(0.45 * h):int(0.95 * h), int(0.20 * w):int(0.60 * w), :3]
    ref = torso.reshape(-1, 3).mean(0)
    ref_y = float(ref @ Y)
    if ref_y < 1e-3:
        return

    strip = px[:int(band * h), :, :3]
    m = np.clip((strip @ Y / ref_y - lo) / (hi - lo), 0.0, 1.0)
    if (m > 0.5).sum() < 64:
        return

    wash = strip[m > 0.5].mean(0)
    ratio = np.clip(ref / np.maximum(wash, 1e-4), 0.25, 1.75)
    strip *= 1.0 + m[..., None] * (ratio - 1.0)

    img.pixels = px.ravel()
    img.pack()


def normalise_albedo(img, target, rect=(0.20, 0.60, 0.45, 0.95)):
    """Scale a skin map down to a plausible diffuse albedo. Never brightens.

    MakeHuman paints its skins for its own renderer, which multiplies them by a
    diffuseIntensity term the glTF exporter cannot carry. Taken literally, a light
    torso is 0.72 linear — roughly white paper — so under this game's sun and ACES
    the parts angled at the sky clip out, and hands and faces go to chalk. Real
    skin sits nearer 0.3. Dark maps are already below target and pass through.
    """
    w, h = img.size
    px = np.asarray(img.pixels, dtype=np.float32).reshape(h, w, 4)
    x0, x1, y0, y1 = rect
    torso = px[int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w), :3]
    luma = float(torso.reshape(-1, 3).mean(0) @ np.array([0.2126, 0.7152, 0.0722]))
    if luma <= target:
        return 1.0
    px[..., :3] *= target / luma
    img.pixels = px.ravel()
    img.pack()
    return target / luma


def drop_trim(img):
    """Repaint a garment's contrast trim in the garment's own colour.

    female_casualsuit01 is an all-blue tee over stonewashed jeans with saturated
    orange piping down both shoulder seams and around each sleeve. Two warm lines
    on an otherwise entirely cool body are the loudest thing in the village, they
    fall exactly where a strap would, and the brief for this cast is plain
    clothes. Nothing else in that map has more red in it than blue, so `r > b`
    isolates the piping and nothing else; each such pixel is repainted in the
    mean colour of the pixels that are not, scaled to its own brightness so the
    seam keeps its shading instead of going flat.
    """
    px = np.asarray(img.pixels, dtype=np.float32).reshape(-1, 4)
    warm = px[:, 0] > px[:, 2]
    cool = ~warm & (px[:, 3] > 0.5)
    if not warm.any() or not cool.any():
        return 0
    w = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    mu = px[cool, :3].mean(0)
    hue = mu / max(float(mu @ w), 1e-4)
    px[warm, :3] = np.clip(hue * (px[warm, :3] @ w)[:, None], 0.0, 1.0)
    img.pixels = px.ravel()
    img.pack()
    return int(warm.sum())


def recolour(img, rgb):
    """Move an image's average colour *to* rgb, rather than multiplying by it.

    A tint cannot lighten. Asking for grey hair by tinting a dark brown card only
    gives darker brown. So the hue is replaced outright and only the card's
    relative brightness is kept: the mean luma is measured — weighted by alpha,
    since a hair card is mostly empty — and every pixel becomes the target scaled
    by how light it was. Scaling the three channels independently instead would
    divide by a near-black mean on a dark card and clip to whichever channel
    happened to dominate, which is how grey eyebrows came out ginger.
    """
    px = np.asarray(img.pixels, dtype=np.float32).reshape(-1, 4)
    a = px[:, 3]
    lum = px[:, :3] @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    mean = float((lum * a).sum()) / max(float(a.sum()), 1e-4)
    rel = (lum / max(mean, 1e-4))[:, None]
    px[:, :3] = np.clip(np.asarray(rgb, dtype=np.float32) * rel, 0.0, 1.0)
    img.pixels = px.ravel()
    img.pack()


def rebuild(obj, look, prefix):
    """Replace the asset's material with a clean, export-safe Principled graph."""
    tex_path, tint = look.get("tex"), look.get("tint")
    alpha = look.get("alpha", "opaque")

    src = find_albedo(obj)

    img = bpy.data.images.load(tex_path) if tex_path else src
    grey, trim = look.get("recolour"), look.get("drop_trim")
    if img is not None and (tint or grey or trim) and not tex_path:
        img = img.copy()
        img.name = f"{obj.name}_tinted"
        if trim:
            print(f"  trim {obj.name}: {drop_trim(img)} px repainted")
        if grey:
            recolour(img, grey)
        elif tint:
            bake_tint(img, tint)
    if img is not None and look.get("skin_fix"):
        fix_extremities(img)
        if look.get("albedo"):
            print(f"  albedo {obj.name}: x{normalise_albedo(img, look['albedo']):.2f}")

    m = bpy.data.materials.new(f"{prefix}_{obj.name.split('.')[-1]}")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    bsdf.inputs["Roughness"].default_value = look.get("rough", 0.85)
    bsdf.inputs["Metallic"].default_value = 0.0
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = look.get("spec", 0.4)

    if img is not None:
        tn = nt.nodes.new("ShaderNodeTexImage")
        tn.image = img
        tn.location = (-400, 0)
        nt.links.new(tn.outputs["Color"], bsdf.inputs["Base Color"])
        if alpha == "clip":
            nt.links.new(tn.outputs["Alpha"], bsdf.inputs["Alpha"])
    else:
        bsdf.inputs["Base Color"].default_value = (*look.get("colour", (0.5, 0.5, 0.5)), 1)

    # Hair and brows are alpha cards and must stay cut out. Everything else is
    # solid, and saying so is what keeps the face from being see-through.
    if alpha == "clip":
        m.blend_method = "CLIP"
        m.alpha_threshold = look.get("cutoff", 0.5)
    else:
        m.blend_method = "OPAQUE"

    obj.data.materials.clear()
    obj.data.materials.append(m)
    return m.name


def build(v, out_dir):
    name = v["name"]
    bpy.ops.wm.read_factory_settings(use_empty=True)

    # detailed_helpers is what creates the "joint-*" vertex groups that the rig
    # fits its bones to. It costs nothing in the export — the helper geometry is
    # masked away later either way — and without it every bone lands at the
    # position authored in the rig JSON instead of on this body. See rigfix.
    bm = H.create_human(mask_helpers=True, detailed_helpers=True,
                        extra_vertex_groups=False, feet_on_ground=True,
                        scale=0.1, macro_detail_dict=v["macro"])
    H.set_character_skin(L.get_user_data(v["skin"]), bm, skin_type="MAKESKIN")

    # The rig goes on before a single garment does. add_mhclo_asset looks for a
    # skeleton among the basemesh's relatives and only skins the garment if it
    # finds one; with no rig yet it silently parents the mesh to the body instead.
    # That looks identical at rest and then leaves a rigid shell of clothes
    # standing still while the body inside them walks off.
    rig = H.add_builtin_rig(bm, v.get("rig", "cmu_mb"), import_weights=True)
    rigfix.check(rig, bm)

    worn = {"body": bm}
    # "_"-prefixed keys are cast.json's own commentary, and one written a level
    # too deep is a string where a (path, kind) pair belongs.
    for slot, (rel, kind) in ((k, x) for k, x in v["wear"].items()
                              if not k.startswith("_")):
        worn[slot] = H.add_mhclo_asset(L.get_user_data(rel), bm,
                                       asset_type=kind, subdiv_levels=0)

    # An outer garment has to sit outside the one underneath it, or the inner
    # cloth surfaces through the hip as pale blotches you cannot texture away.
    # A loose kurta is puffy in life anyway, so this costs nothing.
    for slot, d in v.get("inflate", {}).items():
        o = worn.get(slot)
        if not o:
            continue
        # d is metres, so divide out the object scale before moving local verts.
        step = d / max(o.matrix_world.to_scale().x, 1e-6)
        for vert in o.data.vertices:
            vert.co += vert.normal * step

    masked = {}
    for slot, look in v["look"].items():
        if slot in worn:
            mat = rebuild(worn[slot], look, name)
            if look.get("alpha") == "clip":
                masked[mat] = look.get("cutoff", 0.5)

    # Apply the MASK modifiers here rather than passing export_apply to the
    # exporter, which refuses to evaluate modifiers on a mesh it is also exporting
    # shape keys for. The masks are what delete the helper geometry and the skin
    # hidden under clothes, so this is worth about a third of the triangle count.
    for o in [x for x in bpy.data.objects if x.type == "MESH"]:
        bpy.context.view_layer.objects.active = o
        # MPFB drives the macro shape through shape keys, and a mesh with shape
        # keys refuses every modifier_apply. The mix is the shape we want anyway,
        # and morphs are not exported, so bake it into the base mesh.
        if o.data.shape_keys:
            bpy.ops.object.shape_key_remove(all=True, apply_mix=True)
        for m in [x for x in o.modifiers if x.type != "ARMATURE"]:
            bpy.ops.object.modifier_apply(modifier=m.name)

    # MakeHuman hands out a uniformly dense mesh — as many triangles on the inside
    # of a trouser leg as on a face — so the cast is decimated to crowd size. It
    # happens here, per object, and not in the glTF-Transform pass afterwards,
    # because a whole-file simplify also welds the hair: hair and eyebrows are thin
    # alpha-masked cards stacked a millimetre apart, and collapsing them fuses the
    # cards into a solid shell with ruined UVs. That shipped once as a villager
    # whose face was an opaque black mass. Anything cut out of an alpha map is left
    # off the budget list on purpose.
    #
    # The budget is a triangle count and not a ratio, because the wardrobe is not
    # uniformly dense: male_casualsuit01 is 16k triangles and Cortu's cargo pants
    # are 400, and one flat ratio either leaves the suit fat or shreds the trousers
    # into a bag. A mesh already inside its budget is left alone.
    #
    # After the masks, not before: the mask is what deletes the helper geometry and
    # the skin under the clothes, and on the base mesh that is most of it. Measured
    # before, the ratio would be computed against triangles that no longer exist and
    # the body would come out at a third of its budget.
    for slot, budget in v.get("decimate", {}).items():
        o = worn.get(slot)
        if o is None:
            continue
        o.data.calc_loop_triangles()
        have = len(o.data.loop_triangles)
        if have <= budget:
            continue
        bpy.context.view_layer.objects.active = o
        d = o.modifiers.new("dec", "DECIMATE")
        d.ratio = budget / have
        bpy.ops.object.modifier_apply(modifier=d.name)

    tris = 0
    for o in bpy.data.objects:
        if o.type == "MESH":
            o.data.calc_loop_triangles()
            tris += len(o.data.loop_triangles)

    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out_dir, name + ".blend"))

    # Wiped, not merged: the export folder is keyed by name, so a variant that
    # changes skin leaves the old 4 MB diffuse behind to be shipped forever.
    sep = os.path.join(out_dir, name)
    shutil.rmtree(sep, ignore_errors=True)
    os.makedirs(sep)
    gltf = os.path.join(sep, name + ".gltf")
    bpy.ops.export_scene.gltf(filepath=gltf, export_format="GLTF_SEPARATE",
                              use_selection=False, export_apply=False,
                              export_skins=True, export_yup=True,
                              export_image_format="AUTO", export_animations=False,
                              export_morph=False)

    # Blender 4.5 no longer round-trips CLIP through the exporter — every alpha
    # slot lands as BLEND, which in three.js means unsorted transparency and a
    # face you can see the eyeballs through. The cutoffs are known here, so the
    # material table is corrected in place.
    doc = json.load(open(gltf))
    for mat in doc.get("materials", []):
        cutoff = masked.get(mat["name"])
        if cutoff is not None:
            mat["alphaMode"] = "MASK"
            mat["alphaCutoff"] = cutoff
        else:
            mat.pop("alphaMode", None)
    json.dump(doc, open(gltf, "w"))

    kib = sum(os.path.getsize(os.path.join(sep, f))
              for f in os.listdir(sep)) // 1024
    print(f"BUILT {name:14s} {tris:6d} tris  {len(rig.data.bones)} bones  "
          f"{kib:5d} KiB  masked={len(masked)}  worn={len(worn)}")
    return {"name": name, "tris": tris, "kib": kib}


built = []
for over in spec["variants"]:
    v = merge(spec["base"], over)
    if only and v["name"] != only:
        continue
    built.append(build(v, out_dir))

json.dump(built, open(os.path.join(out_dir, "cast.json"), "w"), indent=2)
print("CAST", json.dumps(built))
