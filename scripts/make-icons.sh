#!/usr/bin/env bash
# Rasterize assets/icon.svg -> the PWA / home-screen PNGs. icon.svg is the SINGLE SOURCE OF TRUTH:
# edit the SVG, rerun this, never hand-edit the PNGs. Needs rsvg-convert (librsvg); swap in
# `inkscape -w $s icon.svg -o …` or ImageMagick `convert -background none -resize ${s}x${s}` if you
# don't have it. RUN THIS FIRST on a fresh clone — the head + manifest reference these files.
#   180 = apple-touch-icon   192/512 = manifest icons (512 also does maskable)
set -euo pipefail
cd "$(dirname "$0")/../assets"
for s in 180 192 512; do
  rsvg-convert -w "$s" -h "$s" icon.svg -o "icon-$s.png"
done
echo "wrote assets/icon-{180,192,512}.png"
