"""Guard against a rig that does not fit the body it is skinned to.

MPFB locates almost every joint from a named helper cube, which is a vertex group
on the base mesh called "joint-something". Those groups only exist if the human
was created with `detailed_helpers=True`. Without them every bone silently falls
back to the position authored in the rig JSON — a neutral body centred on the
navel — so the whole skeleton ends up about 0.9 m below the mesh, with the head
bone at hip height and the feet under the floor.

That is invisible in any still image, because skinning is relative to the bind
pose and the bind pose cancels the error exactly. It only appears the first frame
a bone rotates, when the mesh tears itself apart around pivots that are nowhere
near the geometry they move. It cost an afternoon, so the pipeline now asserts
that the rig and the mesh occupy the same space before anything is exported.
"""

# A bone longer than this fraction of the body is not a bone, it is a bug: the
# longest real one here is the thigh at about a quarter of standing height.
SANE = 0.30
# How far outside the mesh a joint may sit, as a fraction of standing height.
# Every joint is inside the body by construction, so this only has to allow for
# the mesh bounds being measured at rest; the failure it catches puts joints half
# a body length away.
SLACK = 0.05


def check(rig, mesh):
    """Raise unless every joint lies inside the mesh it deforms."""
    co = [mesh.matrix_world @ v.co for v in mesh.data.vertices]
    lo = [min(c[i] for c in co) for i in range(3)]
    hi = [max(c[i] for c in co) for i in range(3)]
    height = hi[2] - lo[2]
    margin = SLACK * height

    stray = []
    for b in rig.data.bones:
        p = rig.matrix_world @ b.head_local
        out = max(max(lo[i] - p[i], p[i] - hi[i]) for i in range(3))
        if out > margin:
            stray.append((b.name, round(out / height, 3)))
    if stray:
        raise RuntimeError(
            f"{rig.name} does not fit {mesh.name}: joints outside the body by "
            f"this fraction of its height: {sorted(stray, key=lambda s: -s[1])[:6]}. "
            "Was the human created with detailed_helpers=True?")

    long = [(b.name, round(b.length / height, 3))
            for b in rig.data.bones if b.length > SANE * height]
    if long:
        raise RuntimeError(f"{rig.name} has out-of-scale bones: {long}")
    return height
