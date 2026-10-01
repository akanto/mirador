#!/bin/bash
# Renders the app icon set and the menu bar image from the SVGs in desktop/assets. Needs rsvg-convert (brew install librsvg).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p icon.iconset
for size in 16 32 128 256 512; do
  rsvg-convert -w "$size" -h "$size" assets/app-icon.svg -o "icon.iconset/icon_${size}x${size}.png"
  rsvg-convert -w $((size * 2)) -h $((size * 2)) assets/app-icon.svg -o "icon.iconset/icon_${size}x${size}@2x.png"
done
rsvg-convert -w 36 -h 36 assets/tray-icon.svg -o assets/tray-icon.png
