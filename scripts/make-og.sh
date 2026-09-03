#!/usr/bin/env bash
# Rasterize the share-card SVG -> PNG (1200x630). The OG image MUST be a raster served at an
# ABSOLUTE https URL (iMessage/WhatsApp/Slack reject relative paths and won't render SVG), and must
# be compressed — this script hard-fails if the card lands over MAX_BYTES (below), a margin under
# WhatsApp's ~300 KB scrape cutoff, since a too-big card previews as a grey box. Edit assets/og.svg,
# rerun this. If the card has live <text>, the font must be installed locally or it falls back to a
# stock serif in the render.
set -euo pipefail
cd "$(dirname "$0")/../assets"
svg="${1:-og.svg}"
png="${svg%.svg}.png"
if command -v rsvg-convert >/dev/null; then
  rsvg-convert -w 1200 -h 630 "$svg" -o "$png"
else
  for c in chromium chromium-browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
    command -v "$c" >/dev/null 2>&1 || [ -x "$c" ] || continue
    "$c" --headless --no-sandbox --hide-scrollbars --force-device-scale-factor=1 \
         --window-size=1200,630 --screenshot="$png" "file://$PWD/$svg" 2>/dev/null
    break
  done
fi
# Compress: palette-quantize to shave the file — scrapers skip an oversized card. pngquant preferred;
# oxipng is a lossless fallback. Neither installed → the size gate below still runs and will fail loud.
if command -v pngquant >/dev/null; then
  pngquant --force --skip-if-larger --output "$png" "$png" 2>/dev/null || true
elif command -v oxipng >/dev/null; then
  oxipng -o4 --quiet "$png" 2>/dev/null || true
fi

# Hard gate. A share card too big to scrape previews as a silent grey box, so FAIL instead of shipping
# it. MAX_BYTES keeps a margin under WhatsApp's ~300 KB cutoff (keep in sync with scripts/og-lint.py).
MAX_BYTES=250000
bytes=$(wc -c < "$png" | tr -d ' ')
if [ "$bytes" -gt "$MAX_BYTES" ]; then
  echo "ERROR: assets/$png is $bytes bytes (> $MAX_BYTES). Install pngquant, simplify $svg, or shrink the palette." >&2
  exit 1
fi
echo "wrote assets/$png ($bytes bytes)"
