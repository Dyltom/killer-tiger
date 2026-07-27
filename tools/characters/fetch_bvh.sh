#!/bin/sh
# Download the CMU mocap takes clips.json asks for.
#
# Usage:  fetch_bvh.sh [clips.json]
#
# CMU Graphics Lab Motion Capture Database (mocap.cs.cmu.edu), created with
# funding from NSF EIA-0196217 and free for all use including commercial. The
# BVH conversion is B. Hahne's (cgspeed); mirrored here because the original
# cgspeed archive has moved twice and the mirror is a plain file per take.
#
# Not committed: nine takes is ~5 MB of ASCII to carry forever for a build step
# that runs about twice a year. The takes are immutable, so the URL is as good
# as the file.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
CLIPS="${1:-$DIR/clips.json}"
OUT="$DIR/bvh"
MIRROR="https://raw.githubusercontent.com/una-dinosauria/cmu-mocap/master/data"

mkdir -p "$OUT"
# Read the list from clips.json rather than repeating it: a clip swapped in the
# spec should not need a second edit here to be fetchable.
python3 -c 'import json,sys
for c in json.load(open(sys.argv[1]))["clips"]: print(c["bvh"])' "$CLIPS" \
| sort -u | while read -r f; do
    if [ -s "$OUT/$f" ]; then
        printf 'HAVE  %s\n' "$f"
        continue
    fi
    subj="${f%%_*}"
    curl -fsSL -o "$OUT/$f" "$MIRROR/$subj/$f"
    printf 'GET   %-12s %s KiB\n' "$f" "$(( $(wc -c < "$OUT/$f") / 1024 ))"
done
