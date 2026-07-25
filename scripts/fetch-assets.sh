#!/usr/bin/env bash
# Fetch the CC0 PBR texture sets from Poly Haven into public/assets/textures/
# and recompress them to WebP. The .webp output is committed; this script only
# needs re-running to change the material list. Every asset is CC0 (public
# domain) — see CREDITS.md.
#
# Each material ships three files:
#   <name>_diff.webp   albedo
#   <name>_nor.webp    OpenGL-convention tangent normal map
#   <name>_arm.webp    ambient-occlusion (R) / roughness (G) / metalness (B)
#
# Requires: curl, cwebp (brew install webp).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/public/assets/textures"
CDN="https://dl.polyhaven.org/file/ph-assets/Textures/jpg"

mkdir -p "$OUT"

# slug:resolution — resolution is higher for the two terrain materials because
# they cover the most screen area.
MATERIALS=(
  "aerial_grass_rock:2k"
  "dry_ground_rocks:2k"
  "bark_brown_02:1k"
  "rock_wall_02:1k"
  "patterned_clay_wall:1k"
  "reed_roof_04:1k"
)

# Normal maps need more bits than albedo — banding in a normal map shows up as
# visible facets under a moving light, where the same artefact in albedo is
# invisible. Everything is capped at 1024px: past that the extra detail is
# smaller than a pixel at the distances this game renders at.
get() { # url dest-basename quality
  local dest="$OUT/$2.webp"
  if [ -s "$dest" ]; then echo "  have $2.webp"; return; fi
  curl -fsSL --retry 3 -o "$TMP/raw.jpg" "$1"
  cwebp -quiet -q "$3" -resize 1024 0 "$TMP/raw.jpg" -o "$dest"
  echo "  got  $2.webp ($(du -h "$dest" | cut -f1))"
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for entry in "${MATERIALS[@]}"; do
  slug="${entry%%:*}"
  res="${entry##*:}"
  echo "$slug ($res)"
  get "$CDN/$res/$slug/${slug}_diff_$res.jpg" "${slug}_diff" 84
  get "$CDN/$res/$slug/${slug}_nor_gl_$res.jpg" "${slug}_nor" 92
  get "$CDN/$res/$slug/${slug}_arm_$res.jpg" "${slug}_arm" 84
done

echo
echo "total: $(du -sh "$OUT" | cut -f1) in $OUT"
