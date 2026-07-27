"""CMU mocap -> a shared glTF animation library for the killer-tiger cast.

Usage:  blender -b --python anim.py -- <clips.json> <out_dir>

One file, one skeleton, no mesh. three.js binds animation tracks to bones by
name, and all five characters carry the same 31 names, so a single library drives
the whole cast instead of five copies of the same eight clips. The retarget
itself lives in retarget.py, which is importable so it can be measured.
"""
import bpy, sys, os, json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from retarget import (ALIAS, FPS, SRC_FPS, build_rig, calibrate, features, find_loop,
                      rest_height, rest_world, retarget, sample, take_end)

argv = sys.argv[sys.argv.index("--") + 1:]
spec = json.load(open(argv[0]))
out_dir = argv[1]
os.makedirs(out_dir, exist_ok=True)

rig = build_rig(spec["macro"])
tgt_rest = rest_world(rig)
built = []

# Paces are reported for a 1.72 m body — the height the game's wound placement and
# scale factors are all authored against — so the runtime can scale one number by
# a character's own height and be done. This rig is whatever the cast's average
# macro comes out as, which is close to but not exactly that.
NOMINAL_HEIGHT = 1.72
norm = NOMINAL_HEIGHT / max(rig["mesh_height"], 1e-6)
print(f"RIG height={rig['mesh_height']:.3f}m  pace scale={norm:.4f}")

for clip in spec["clips"]:
    path = os.path.join(os.path.dirname(os.path.abspath(argv[0])), "bvh", clip["bvh"])
    before = set(bpy.data.objects)
    bpy.ops.import_anim.bvh(filepath=path, global_scale=1.0, rotate_mode="NATIVE",
                            use_fps_scale=False, update_scene_fps=False,
                            update_scene_duration=True)
    src = [o for o in bpy.data.objects if o not in before and o.type == "ARMATURE"][0]
    for b in src.data.bones:
        if b.name in ALIAS:
            b.name = ALIAS[b.name]
    src_rest = calibrate(tgt_rest, rest_world(src))

    # The BVH is in CMU's own units. Rather than trust a magic constant, compare
    # the two skeletons' rest heights — *not* their hip heights, because a BVH
    # root sits at the origin and carries its elevation in the motion channels,
    # which makes that ratio 55000 and launches the character into orbit.
    scale = rest_height(rig) / max(rest_height(src), 1e-6)

    step = SRC_FPS // FPS
    last = take_end(src)
    scan_lo = int(clip.get("from", 0) * SRC_FPS)
    scan_hi = min(last, scan_lo + int(clip.get("scan", 14) * SRC_FPS))
    frames, hips = sample(src, scan_lo + 1, scan_hi, step)

    if clip.get("reverse"):
        frames, hips = frames[::-1], hips[::-1]

    if clip.get("loop"):
        F = features(frames, sorted(f for f in frames[0]))
        lo = max(2, int(clip["loop"][0] * FPS))
        hi = max(lo + 1, int(clip["loop"][1] * FPS))
        s, p = find_loop(F, lo, hi)
        frames, hips = frames[s:s + p + 1], hips[s:s + p + 1]
        note = f"loop {p / FPS:.2f}s @ {s / FPS:.2f}s"
    else:
        a = int(clip.get("trim", [0, 99])[0] * FPS)
        b = int(clip.get("trim", [0, 99])[1] * FPS)
        frames, hips = frames[a:b], hips[a:b]
        note = f"cut {len(frames) / FPS:.2f}s"

    action = bpy.data.actions.new(clip["name"])
    action.use_fake_user = True
    shift = retarget(rig, frames, hips, tgt_rest, src_rest, scale, action,
                     clip.get("root_motion", False))
    # The BVH import leaves its own action behind, and ACTIONS export mode walks
    # bpy.data.actions rather than the scene — so the raw 139_02 et al. would ship
    # alongside the retargeted clips.
    if src.animation_data and src.animation_data.action:
        bpy.data.actions.remove(src.animation_data.action)
    bpy.data.objects.remove(src, do_unlink=True)
    # How fast the performer was travelling over the window that was kept. The
    # clip itself will not say — the horizontal drift is discarded on the way out
    # — so it is measured here, where the drift still exists, and shipped in the
    # glTF for the game to play the cycle back at.
    #
    # Two numbers, because they fail differently. `pace` is net displacement over
    # the window, which for a window that is one whole gait cycle is the true
    # ground speed and is not inflated by the hips swinging side to side. `path`
    # is the distance the hips actually travelled, which is what catches the
    # failure this build could not previously see: three clips shipped as
    # performers moving on the spot, and a stationary flail has a low pace and a
    # low path, while a real stride has both.
    k = scale * norm / max(len(frames) / FPS, 1e-6)
    pace = (hips[-1] - hips[0]).to_2d().length * k
    path = sum((hips[i] - hips[i - 1]).to_2d().length for i in range(1, len(hips))) * k
    print(f"CLIP {clip['name']:14s} {len(frames):4d} f  {len(frames)/FPS:5.2f}s  "
          f"{note}  scale={scale:.4f}  ground={shift:+.3f}m  "
          f"pace={pace:4.2f}  path={path:4.2f} m/s")
    built.append({"name": clip["name"], "frames": len(frames), "sec": len(frames) / FPS,
                  "pace": round(pace, 3), "path": round(path, 3)})

rig.animation_data.action = None
bpy.context.scene.render.fps = FPS
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out_dir, "anims.blend"))

sep = os.path.join(out_dir, "anims")
os.makedirs(sep, exist_ok=True)
gltf = os.path.join(sep, "anims.gltf")
bpy.ops.export_scene.gltf(filepath=gltf, export_format="GLTF_SEPARATE", use_selection=False,
                          export_apply=False, export_skins=True, export_yup=True,
                          export_animations=True, export_animation_mode="ACTIONS",
                          export_bake_animation=False, export_optimize_animation_size=True,
                          # Without this the exporter emits all three TRS channels for
                          # all 31 bones regardless, so two thirds of every clip is a
                          # constant scale of 1 and a translation that never moves.
                          export_optimize_animation_keep_anim_armature=False,
                          export_morph=False, export_materials="NONE")
doc = json.load(open(gltf))
# The measured pace, carried in the file beside the clip it describes. It has to
# travel somehow: the runtime cannot recover it, because the horizontal drift that
# defines it was deliberately thrown away on the way in. Patched into the exported
# JSON rather than left to Blender's custom-property export, which is a different
# code path per version; glTF-Transform preserves `extras` through the optimise
# pass and three.js hands them back as `clip.userData`.
pace = {b["name"]: b["pace"] for b in built}
for a in doc.get("animations", []):
    if a.get("name") in pace:
        a.setdefault("extras", {})["pace"] = pace[a["name"]]
json.dump(doc, open(gltf, "w"))
print("ANIMS", json.dumps([a.get("name") for a in doc.get("animations", [])]))
print("SIZE", sum(os.path.getsize(os.path.join(sep, f)) for f in os.listdir(sep)) // 1024, "KiB")
json.dump(built, open(os.path.join(out_dir, "clips.json"), "w"), indent=2)
