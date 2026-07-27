"""Find the upright, low-motion stretches of a mocap take.

Usage:  blender -b --python scan.py -- <file.bvh> [<file.bvh> ...]

A 30-second "Idle" is not 30 seconds of idling. The performer slouches, shifts
weight, wanders, and waits to be told the take is over, and picking a window by
eye out of a single rendered frame is how the cast ended up crouched. So measure
the take instead: for each second, the torso's lean off vertical, the hips'
height as a fraction of the skeleton, and how much the pose is moving. An idle
wants low lean, high hips and low motion; a sneak wants the opposite.
"""
import bpy, sys, os, math
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from retarget import ALIAS, SRC_FPS

UP = Vector((0, 0, 1))
WIN = 1.0  # seconds per reported bucket


def scan(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_anim.bvh(filepath=path, global_scale=1.0, rotate_mode="NATIVE",
                            use_fps_scale=False, update_scene_fps=False,
                            update_scene_duration=True)
    src = [o for o in bpy.data.objects if o.type == "ARMATURE"][0]
    for b in src.data.bones:
        if b.name in ALIAS:
            b.name = ALIAS[b.name]

    z = [b.matrix_local.to_translation().z for b in src.data.bones]
    span = max(max(z) - min(z), 1e-6)
    names = [b.name for b in src.data.bones]

    # The take is in CMU's units; a body height converts them into something a
    # game speed can be compared against. `span` is that height, near enough.
    scale = 1.72 / span

    last = bpy.context.scene.frame_end
    step = SRC_FPS // 6                      # six samples a second is plenty
    rows, prev, prevxy = [], None, None
    for f in range(1, last, step):
        bpy.context.scene.frame_set(f)
        hip = src.pose.bones["Hips"].matrix.to_translation()
        head = src.pose.bones["Head"].matrix.to_translation()
        v = (head - hip).normalized()
        lean = math.degrees(math.acos(max(-1.0, min(1.0, v.dot(UP)))))
        pose = [src.pose.bones[n].matrix.to_quaternion() for n in names]
        move = 0.0 if prev is None else sum(
            abs(a.rotation_difference(b).angle) for a, b in zip(prev, pose))
        # How fast the performer is actually going over the ground. Without this
        # column a "Scared" take reads as a fine flee — low lean, plenty of
        # motion — while the performer stands rooted to the spot flapping his
        # arms, and the loop finder is delighted to pick that. Three of the
        # cast's clips were chosen that way and every one of them slid.
        xy = Vector((hip.x, hip.y))
        travel = 0.0 if prevxy is None else (xy - prevxy).length * scale * (SRC_FPS / step)
        prevxy = xy
        prev = pose
        rows.append((f / SRC_FPS, lean, hip.z / span, math.degrees(move), travel))

    per = max(1, int(WIN * 6))
    print(f"\n=== {os.path.basename(path)}  {last / SRC_FPS:.1f}s ===")
    print("  t   lean  hip%  motion   m/s")
    for i in range(0, len(rows) - per, per):
        w = rows[i:i + per]
        print(f"{w[0][0]:5.1f} {sum(r[1] for r in w) / per:5.1f} "
              f"{100 * sum(r[2] for r in w) / per:5.1f} "
              f"{sum(r[3] for r in w) / per:7.1f} "
              f"{sum(r[4] for r in w) / per:5.2f}")


for p in sys.argv[sys.argv.index("--") + 1:]:
    scan(p if os.path.isabs(p) else os.path.join(os.path.dirname(__file__), "bvh", p))
