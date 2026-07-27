#!/bin/sh
# Squeeze the built characters down to crowd size.
#
# Usage:  optimise.sh <src-dir> <dst-dir>
#
# This is about download and VRAM, not triangle throughput: five villagers at
# 1.7 MB apiece is 8.5 MB of glTF before the player sees anything. What is left
# here is meshopt quantisation, which is where most of that megabyte goes.
#
# Triangles are not what the crowd costs. Measured in the game, the frame is
# bound on draw call submission at about 14 us a call, and a character is six
# separate meshes — body, top, trousers, shoes, hair, eyes — so forty villagers
# are two hundred and forty submissions for 780k triangles the GPU eats without
# noticing. The thing worth optimising in this pipeline is the *number of
# meshes* per character, not the size of them.
#
# Deliberately off:
#   --simplify         it welds. Hair and eyebrows are thin alpha-masked cards
#                      stacked a millimetre apart, and collapsing a hair mesh by
#                      60% fuses the cards into a solid shell with ruined UVs —
#                      which shipped, once, as a villager whose face was an
#                      opaque black mass. Decimation happens in gen.py instead,
#                      per object, where the hair can be left out of it.
#   --flatten/--join   would collapse the node hierarchy the skin binds to, and
#                      cannot merge these meshes anyway: six meshes, six
#                      materials, no two alike.
#   --palette          only merges untextured materials. Every one of ours has
#                      a texture, so it would do nothing but cost a pass.
set -e
SRC="$1"
DST="$2"
CLI="$(dirname "$0")/node_modules/.bin/gltf-transform"
mkdir -p "$DST"

for dir in "$SRC"/*/; do
    name=$(basename "$dir")
    src=$(ls "$dir"/*.gltf 2>/dev/null | head -1) || continue
    [ -n "$src" ] || continue
    # The animation library is a bare skeleton, with no textures to compress.
    if [ "$name" = "anims" ]; then
        "$CLI" optimize "$src" "$DST/$name.glb" \
            --compress meshopt --simplify false --texture-compress false \
            --flatten false --join false --instance false --palette false >/dev/null
    else
        "$CLI" optimize "$src" "$DST/$name.glb" \
            --compress meshopt --simplify false \
            --texture-compress webp --texture-size 1024 \
            --flatten false --join false --instance false --palette false >/dev/null
    fi
    before=$(du -k "$dir" | tail -1 | cut -f1)
    after=$(du -k "$DST/$name.glb" | tail -1 | cut -f1)
    printf 'OPT %-16s %6s KiB -> %6s KiB\n' "$name" "$before" "$after"
done
