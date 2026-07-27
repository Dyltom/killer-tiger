"""Retarget CMU mocap onto MPFB's cmu_mb rig.

MPFB's `cmu_mb` rig uses the CMU *bone names* but not the CMU *rest pose* — the
two skeletons disagree by 21 degrees at the median joint and 166 at the neck.
Copying local rotations across gives a person folded inside out. So every bone's
motion is taken as its deviation from its own rest pose, in world space, and
replayed as the same deviation from the target's rest pose:

    R(b)     = src_pose_world(b) @ src_rest_world(b)^-1     # what the bone did
    want(b)  = R(b) @ tgt_rest_world(b)                     # do it to our rest

which is then converted to Blender's pose basis analytically, parent first, so
nothing depends on a depsgraph round-trip per bone.

Root motion is discarded apart from the vertical bob. The game drives where a
villager *is*; the clip only says what their body is doing, and a clip with no
horizontal drift loops cleanly by construction.
"""
import bpy, sys, os, json, math, addon_utils
import numpy as np
from mathutils import Vector, Quaternion, Matrix

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rigfix

addon_utils.enable("bl_ext.user_default.mpfb", default_set=True, persistent=True)
from bl_ext.user_default.mpfb.services.humanservice import HumanService as H

# The BVH release calls the index-finger tip something else than the rig does.
ALIAS = {"LeftHandIndex1": "LeftHandFinger1", "RightHandIndex1": "RightHandFinger1"}
FPS = 30
SRC_FPS = 120
# The bones whose lowest point over a cycle defines where the ground is.
FOOT = ("LeftFoot", "LeftToeBase", "RightFoot", "RightToeBase")
# A bone's own axis. Blender points every bone down its local +Y.
BONE_Y = Vector((0, 1, 0))

# Replaying deviation-from-rest (see the module docstring) assumes the two rest
# poses are the same *pose*, differently expressed. Below the neck that holds.
# At the arms it does not, and the difference is not small. Per bone, the angle
# between the two rest *directions* — not orientations, because LeftUpLeg
# disagrees by 180 degrees of pure roll and 15 of direction and only the second
# one moves a vertex:
#
#     LeftHand 117.5   LeftFingerBase 76.9   LeftForeArm 59.7   LeftArm 48.8
#     LeftShoulder 32.9   Hips 21.4   Neck 17.2   LeftUpLeg 14.9   LeftLeg 14.1
#     LeftFoot 14.0   Spine 13.9   LowerBack 6.5   Head 2.8
#
# CMU rests in a T-pose: every arm bone points dead sideways, (1, 0, 0). MPFB's
# cmu_mb rests in an A-pose, upper arms 49 degrees below horizontal and forearms
# 60. So the performer's own arm swing was landing on top of the A-pose instead
# of replacing it, and the walk shipped with the upper arms driven 26 degrees
# into the ribs and the forearms horizontal across the belly — measured in the
# character's own frame, shoulders at x = -0.167 and +0.137 with the left hand
# at +0.105 and the right at -0.104, i.e. both hands past the midline and
# overlapping. Nothing about that reads as walking.
#
# Rotating the source's rest arms onto the target's before the deviation is
# taken cancels exactly that, and only that: these four bones then follow the
# performer's world direction outright, and every bone not named here keeps the
# behaviour that already looks right.
CALIBRATE = ("LeftArm", "LeftForeArm", "RightArm", "RightForeArm")

# The hand and the fingers take the forearm's correction instead of their own,
# because their source rest direction is not data. LeftFingerBase and LThumb are
# both `OFFSET 0 0 0` from LeftHand in the BVH, so the importer has no child
# position to aim LeftHand at and falls back to straight up — which is the whole
# of that 117.5 degrees. The wrist is straight in both rest poses, so whatever
# the forearm needed, the hand needs.
INHERIT = {"Hand": "ForeArm", "FingerBase": "ForeArm", "HandFinger1": "ForeArm"}


def calibrate(tgt_rest, src_rest):
    """The source's rest pose with its arms rotated onto the target's."""
    out = dict(src_rest)
    fix = {}
    for n in CALIBRATE:
        if n in tgt_rest and n in src_rest:
            sd = (src_rest[n] @ BONE_Y).normalized()
            td = (tgt_rest[n] @ BONE_Y).normalized()
            fix[n] = sd.rotation_difference(td).to_matrix()
    for side, thumb in (("Left", "LThumb"), ("Right", "RThumb")):
        arm = fix.get(side + "ForeArm")
        if arm is None:
            continue
        for suffix in INHERIT:
            fix[side + suffix] = arm
        fix[thumb] = arm
    for n, a in fix.items():
        if n in out:
            out[n] = a @ out[n]
    return out


def build_rig(macro):
    """A bare skeleton at the cast's average build — no mesh goes in this file."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bm = H.create_human(mask_helpers=True, detailed_helpers=True, extra_vertex_groups=False,
                        feet_on_ground=True, scale=0.1, macro_detail_dict=macro)
    rig = H.add_builtin_rig(bm, "cmu_mb", import_weights=True)
    # Must match the characters' rigs joint for joint, so it gets the same guard.
    rigfix.check(rig, bm)
    # Kept before the mesh goes: a clip's ground speed is only meaningful next to
    # the height of the body that walked it, and the skeleton alone cannot say
    # what that was — bone extents stop at the top of the head and start at the
    # ankle, not the floor.
    rig["mesh_height"] = bm.dimensions.z
    bpy.data.objects.remove(bm, do_unlink=True)
    rig.animation_data_create()
    return rig


def depth(bone):
    n = 0
    while bone.parent:
        bone, n = bone.parent, n + 1
    return n


def rest_height(arm):
    z = [b.matrix_local.to_translation().z for b in arm.data.bones]
    return max(z) - min(z)


def rest_world(arm):
    """Rotation-only rest orientation per bone, in the armature's own space."""
    return {b.name: b.matrix_local.to_3x3().normalized() for b in arm.data.bones}


def take_end(src):
    """The last frame this take actually has data for.

    Not `scene.frame_end`, which is what the BVH importer sets and which several
    imports into one session leave stale — it is assigned per import but a run of
    takes read back the *longest* one's length if any of them fails to shrink it.
    Sampling past a take's end does not error: Blender holds the final pose, so
    the tail of the window comes back as a run of byte-identical frames. That is
    invisible in the export and fatal in `find_loop`, which will take a perfect
    seam over a real one every time — it is how `wounded` shipped as a man
    standing rigidly still for a second and a quarter.
    """
    ad = src.animation_data
    if not ad or not ad.action:
        return bpy.context.scene.frame_end
    return int(ad.action.frame_range[1])


def sample(src, first, last, step):
    """Read the BVH's pose, frame by frame. One depsgraph update per frame."""
    names = [b.name for b in src.data.bones]
    frames, hips = [], []
    for f in range(first, last, step):
        bpy.context.scene.frame_set(f)
        frames.append({n: src.pose.bones[n].matrix.to_3x3().normalized() for n in names})
        hips.append(src.pose.bones["Hips"].matrix.to_translation().copy())
    return frames, hips


def features(frames, order):
    """Flatten each pose to a vector so two frames can be compared numerically."""
    out = []
    for fr in frames:
        v = []
        for n in order:
            q = fr[n].to_quaternion()
            if q.w < 0:            # q and -q are the same rotation; pick one
                q.negate()
            v += [q.w, q.x, q.y, q.z]
        out.append(v)
    return np.asarray(out, dtype=np.float32)


def find_loop(F, lo, hi):
    """Pick the window whose first and last pose — and pose *velocity* — agree.

    Matching position alone finds frames that look alike but are moving opposite
    ways, which pops on the wrap. Matching the derivative too is what makes a
    walk cycle actually cycle.

    The seam error is then divided by how far the pose travels *inside* the
    window, and that division is not a refinement — it is the whole thing. A
    performer standing still has a seam error of nothing at every period at once,
    so an absolute score makes stillness the global optimum of every take that
    contains any, and the takes that contain the most of it are exactly the ones
    a village needs: `flee` came back as a scared man rooted to the spot, and
    `sneak` and `chores` were both quieter than they should have been. What the
    ratio asks instead is the question worth asking — how good is this seam
    *relative to how much happens between its ends* — under which a still window
    scores infinitely badly rather than perfectly.
    """
    n = len(F)
    V = np.diff(F, axis=0, prepend=F[:1])
    # Cumulative pose travel, so any window's total motion is one subtraction.
    C = np.concatenate([[0.0], np.cumsum(np.linalg.norm(V, axis=1))])
    best, arg = None, (0, min(hi, n - 1))
    for p in range(lo, min(hi, n - 1) + 1):
        d = np.linalg.norm(F[:n - p] - F[p:], axis=1) + 3.0 * np.linalg.norm(V[:n - p] - V[p:], axis=1)
        moved = C[p:n] - C[:n - p]
        # Longer windows are mildly preferred: a 2-frame "cycle" matches perfectly
        # and animates nothing.
        cost = d / np.maximum(moved, 1e-4) / (p ** 0.35)
        s = int(cost.argmin())
        if best is None or float(cost[s]) < best:
            best, arg = float(cost[s]), (s, p)
    return arg


def facing(frames, src_rest):
    """The clip's average compass bearing, as a rotation that undoes it.

    Each take was captured with the performer walking off in whatever direction
    the volume allowed, and that bearing rides along in the hips. Left alone it
    means idle faces one way, walk another, and a villager spins on the spot the
    instant the game crossfades between them. Averaged as a vector rather than as
    an angle, so a clip that straddles due south does not average to due north.
    """
    inv = src_rest["Hips"].inverted()
    x = y = 0.0
    for fr in frames:
        v = (fr["Hips"] @ inv) @ Vector((1, 0, 0))
        x, y = x + v.x, y + v.y
    if abs(x) < 1e-9 and abs(y) < 1e-9:
        return Matrix.Identity(3)
    return Matrix.Rotation(-math.atan2(y, x), 3, "Z")


def retarget(rig, frames, hips, tgt_rest, src_rest, scale, action, root_motion):
    order = sorted((b.name for b in rig.data.bones), key=lambda n: depth(rig.data.bones[n]))
    parent = {b.name: (b.parent.name if b.parent else None) for b in rig.data.bones}
    rig.animation_data.action = action
    for pb in rig.pose.bones:
        pb.rotation_mode = "QUATERNION"

    # Only the root's basis actually changes: every child is keyed from a
    # parent-relative term, which a rotation applied to the whole body cancels out of.
    face = facing(frames, src_rest)
    hips_rest = rig.data.bones["Hips"].matrix_local.to_translation()
    for i, fr in enumerate(frames):
        want = {}
        for n in order:
            s = fr.get(n)
            if s is None:
                want[n] = tgt_rest[n]
                continue
            want[n] = face @ (s @ src_rest[n].inverted()) @ tgt_rest[n]

        for n in order:
            p = parent[n]
            if p is None:
                basis = tgt_rest[n].inverted() @ want[n]
            else:
                local_rest = tgt_rest[p].inverted() @ tgt_rest[n]
                basis = local_rest.inverted() @ (want[p].inverted() @ want[n])
            pb = rig.pose.bones[n]
            pb.rotation_quaternion = basis.to_quaternion()
            pb.keyframe_insert("rotation_quaternion", frame=i + 1)

        # Horizontal drift is the game's business, not the clip's. Keeping only
        # the vertical component preserves the bob of a footfall while leaving a
        # cycle that ends exactly where it started.
        #
        # That vertical is the source's *absolute* hip height, not its drift from
        # the first frame. Drift holds the hips at rest height, so a clip that
        # crouches keeps its pelvis up and lifts its feet off the ground instead —
        # which is what made every idle look like it was hovering.
        d = face @ (hips[i] * scale)
        world = Vector((0, 0, d.z - hips_rest.z))
        if root_motion:
            o = face @ (hips[0] * scale)
            world.x, world.y = d.x - o.x, d.y - o.y
        pb = rig.pose.bones["Hips"]
        pb.location = tgt_rest["Hips"].inverted() @ world
        pb.keyframe_insert("location", frame=i + 1)

    for fc in action.fcurves:
        for kp in fc.keyframe_points:
            kp.interpolation = "LINEAR"
    return ground(rig, action, tgt_rest, len(frames))


def ground(rig, action, tgt_rest, n):
    """Drop the clip so its lowest footfall stands on the same floor as the rest pose.

    Scaling the source's hip height across gets the crouch right but inherits
    whatever the capture volume called zero, which is not this skeleton's floor —
    the two performers' hips sit at different fractions of their own height. So
    measure where the feet actually end up and shift the whole clip by the error.
    One offset for the clip, never per frame: correcting each frame separately
    would flatten the bob and glue the feet to the floor through a run.
    """
    rest = min(min(b.head_local.z, b.tail_local.z) for b in rig.data.bones if b.name in FOOT)
    low = None
    for f in range(1, n + 1):
        bpy.context.scene.frame_set(f)
        bpy.context.view_layer.update()
        for name in FOOT:
            pb = rig.pose.bones[name]
            z = min(pb.head.z, pb.tail.z)
            low = z if low is None else min(low, z)

    shift = tgt_rest["Hips"].inverted() @ Vector((0, 0, rest - low))
    for fc in action.fcurves:
        if fc.data_path.endswith("].location"):
            for kp in fc.keyframe_points:
                kp.co.y += shift[fc.array_index]
                kp.handle_left.y += shift[fc.array_index]
                kp.handle_right.y += shift[fc.array_index]
    return rest - low


