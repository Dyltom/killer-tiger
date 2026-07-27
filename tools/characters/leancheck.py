"""Is the hunch in the retarget, or in the actor?

Usage:  blender -b --python leancheck.py -- <clips.json>

Every clip came out of the cast pitched forward, which is either a residual rest
pose error in the retarget or simply how the performer moved. Measuring the angle
of the hips-to-head line against vertical, on the source and on the retargeted
rig at the same frame, answers it in one number per clip.
"""
import bpy, sys, os, json, math
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from retarget import (ALIAS, SRC_FPS, build_rig, rest_height, rest_world,
                      retarget, sample)

argv = sys.argv[sys.argv.index("--") + 1:]
spec = json.load(open(argv[0]))
base = os.path.dirname(os.path.abspath(argv[0]))
UP = Vector((0, 0, 1))


def lean(a, b):
    v = (b - a).normalized()
    return math.degrees(math.acos(max(-1.0, min(1.0, v.dot(UP)))))


rig = build_rig(spec["macro"])
tgt_rest = rest_world(rig)

for clip in spec["clips"]:
    before = set(bpy.data.objects)
    bpy.ops.import_anim.bvh(filepath=os.path.join(base, "bvh", clip["bvh"]),
                            global_scale=1.0, rotate_mode="NATIVE", use_fps_scale=False,
                            update_scene_fps=False, update_scene_duration=True)
    src = [o for o in bpy.data.objects if o not in before and o.type == "ARMATURE"][0]
    for b in src.data.bones:
        if b.name in ALIAS:
            b.name = ALIAS[b.name]

    f = int(clip.get("from", 0) * SRC_FPS) + 60
    frames, hips = sample(src, f, f + 1, 1)
    # Read the source here, while the scene is still on frame f. Stepping to
    # frame 1 to evaluate the retargeted rig would drag the BVH back to its
    # calibration pose too, which is how this first reported an identical 5.5
    # degrees for every clip of the same subject.
    s = lean(src.pose.bones["Hips"].matrix.to_translation(),
             src.pose.bones["Head"].matrix.to_translation())

    action = bpy.data.actions.new("lean_" + clip["name"])
    retarget(rig, frames, hips, tgt_rest, rest_world(src),
             rest_height(rig) / max(rest_height(src), 1e-6), action, False)
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()

    t = lean(rig.pose.bones["Hips"].matrix.to_translation(),
             rig.pose.bones["Head"].matrix.to_translation())
    print(f"LEAN {clip['name']:10s} source={s:6.1f}  ours={t:6.1f}  delta={t - s:+6.1f}")

    bpy.data.actions.remove(src.animation_data.action)
    bpy.data.actions.remove(action)
    bpy.data.objects.remove(src, do_unlink=True)
