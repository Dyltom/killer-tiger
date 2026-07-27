#!/usr/bin/env python3
"""Shrink a GLTF_SEPARATE character's textures and rewrite its image URIs.

Blender exports MPFB's source art at full authoring size — a 4096 skin diffuse is
3.5 MB of PNG, and the pair of them is enough to make the webview's fetch give up
mid-load ("TypeError: Load failed"), which reads as a broken model. Nothing in
this game shows a villager larger than a few hundred pixels tall, so the art is
resized by role and re-encoded as lossy WebP with alpha kept.

Usage: pack.py <dir-with-gltf> [<dir> ...]
"""
import json
import os
import subprocess
import sys

# by role, longest edge. A villager is never more than a few hundred px tall —
# except during a kill, which happens at arm's length and is the shot the game is
# about.
#
# Hair is the exception to "small is fine". It is the one alpha-clipped surface on
# a villager, and a clip is a hard yes/no per texel, so halving a hair map turns
# the hairline from wisps into a staircase. Ordered most specific first, because
# every one of these files is also called something_diffuse and a generic rule
# placed above the roles silently answers for all of them.
SIZE = [
    ("eyebrow", 256), ("eye", 256),
    ("short", 1024), ("bob", 1024), ("ponytail", 1024),   # hair
    ("braid", 1024), ("afro", 1024), ("long", 1024),
    ("_diffuse", 1024),   # skin and cloth
]
DEFAULT = 512
QUALITY = 88

# Chest prints to paint out, as fractions of the texture: (texture, dst x, dst y,
# size, src x, src y). MakeHuman's female casual t-shirt has the MakeHuman logo
# silkscreened onto the back panel, which is CC0 and perfectly legal to ship and
# still reads as somebody else's branding on a villager's shirt. Patched by copying
# a clean square of the same panel over it rather than by flood-filling, because
# the fabric has a weave and a flat blue disc is more obvious than the logo was.
SCRUB = [("female_casualsuit01", 0.720, 0.150, 0.155, 0.560, 0.150)]


def target(name):
    for key, px in SIZE:
        if key in name:
            return px
    return DEFAULT


def run(*cmd):
    subprocess.run(cmd, check=True, capture_output=True)


def scrub(path, stem):
    """Copy a clean patch over any branding this texture is known to carry."""
    for key, dx, dy, s, sx, sy in SCRUB:
        if key not in stem:
            continue
        w = int(subprocess.run(["magick", "identify", "-format", "%w", path],
                               check=True, capture_output=True, text=True).stdout)
        n = max(2, round(s * w))
        run("magick", path,
            "(", "+clone", "-crop", f"{n}x{n}+{round(sx * w)}+{round(sy * w)}", "+repage", ")",
            "-geometry", f"+{round(dx * w)}+{round(dy * w)}", "-composite", path)


def pack(d):
    # The build directory also holds the optimised .glb output, and a shell glob
    # of */ hands that over too.
    gltf_path = next((os.path.join(d, f) for f in os.listdir(d)
                      if f.endswith(".gltf")), None)
    if gltf_path is None:
        return
    g = json.load(open(gltf_path))
    before = after = 0
    for img in g.get("images", []):
        uri = img.get("uri")
        if not uri or uri.endswith(".webp"):
            continue
        src = os.path.join(d, uri)
        stem = os.path.splitext(uri)[0]
        px = target(stem)
        tmp = os.path.join(d, stem + ".resized.png")
        dst = os.path.join(d, stem + ".webp")
        scrub(src, stem)
        run("magick", src, "-resize", f"{px}x{px}>", "-strip", tmp)
        run("cwebp", "-quiet", "-q", str(QUALITY), "-alpha_q", "100", tmp, "-o", dst)
        before += os.path.getsize(src)
        after += os.path.getsize(dst)
        os.remove(tmp)
        os.remove(src)
        img["uri"] = os.path.basename(dst)
        img["mimeType"] = "image/webp"
    # No EXT_texture_webp needed: these images are referenced by URI, so the
    # browser sniffs the encoding itself. Declaring the extension as *required*
    # would only give a conforming loader a reason to refuse the file.
    json.dump(g, open(gltf_path, "w"))
    total = sum(os.path.getsize(os.path.join(d, f)) for f in os.listdir(d))
    print(f"PACKED {os.path.basename(d.rstrip('/')):18s} textures {before // 1024:5d}K -> "
          f"{after // 1024:4d}K   folder {total // 1024:5d}K")


for d in sys.argv[1:]:
    pack(d)
