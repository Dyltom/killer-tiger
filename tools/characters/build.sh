#!/bin/sh
# Rebuild the cast, end to end, into public/models.
#
# Usage:  build.sh [variant]
#
#   build.sh                 everything: five characters plus the animation library
#   build.sh villager_a      just that character (the animation library is shared,
#                            so it is rebuilt regardless — it costs six seconds)
#
# Nothing here is incremental. The whole build is about four minutes, dominated
# by MPFB's create_human at roughly five seconds a head, and a half-built cast is
# a worse thing to debug than a slow one.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="${OUT:-$DIR/build}"
SHIP="$DIR/../../public/models"
BLENDER="${BLENDER:-$HOME/Applications/Blender.app/Contents/MacOS/Blender}"
ONLY="$1"

[ -x "$BLENDER" ] || { echo "no Blender at $BLENDER (set BLENDER=)" >&2; exit 1; }
[ -x "$DIR/node_modules/.bin/gltf-transform" ] || { echo "run: npm install --prefix $DIR" >&2; exit 1; }

python3 "$DIR/fetch_assets.py"
sh "$DIR/fetch_bvh.sh"

# -b is headless, but Blender still writes its startup chatter to stdout, and the
# scripts' own progress lines are the only part worth reading.
#
# Via a log file rather than a pipe, because /bin/sh has no pipefail: piping
# straight into grep hides Blender's exit status behind grep's, and a gen.py that
# died on the first character then reads as a clean build that ships yesterday's
# glTF. The traceback is worth more than the filter, so on failure the whole log
# goes to the terminal.
run() {
    log="$OUT/.log"
    mkdir -p "$OUT"
    if "$BLENDER" -b --python "$1" -- "$2" "$3" ${4:+"$4"} >"$log" 2>&1; then
        grep -E '^(BUILT|CLIP|ANIMS|SIZE|CAST|RIG|WARN)' "$log" || true
    else
        echo "FAILED: $(basename "$1")" >&2
        cat "$log" >&2
        exit 1
    fi
}

echo "--- characters"
run "$DIR/gen.py" "$DIR/cast.json" "$OUT" "$ONLY"
echo "--- animation library"
run "$DIR/anim.py" "$DIR/clips.json" "$OUT"

echo "--- textures"
# Before meshopt, because gltf-transform's texture pass reads whatever is on disk
# and a 4096 skin is enough to make the webview's fetch give up mid-load.
python3 "$DIR/pack.py" "$OUT"/*/

echo "--- optimise"
sh "$DIR/optimise.sh" "$OUT" "$OUT/opt"

echo "--- ship"
mkdir -p "$SHIP"
cp "$OUT"/opt/*.glb "$SHIP/"
ls -l "$SHIP"

echo "--- credits"
python3 "$DIR/licenses.py" "$DIR/cast.json" >/dev/null
echo "all assets have a recorded license"
