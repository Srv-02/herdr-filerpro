#!/bin/sh
# Renders an HTML card at 2x into a PNG with a transparent background, using headless Microsoft Edge.
# Usage: render.sh <card.html> <out.png> <width> <height>   (width and height in CSS pixels)
# EDGE overrides the browser binary (any Chromium-based browser works).
set -eu

if [ "$#" -ne 4 ]; then
  echo "usage: $0 <card.html> <out.png> <width> <height>" >&2
  exit 2
fi

EDGE="${EDGE:-/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge}"
HERE="$(cd "$(dirname "$0")" && pwd)"
# A throwaway profile next to this script, so the run never touches your browser profile.
PROFILE="$HERE/.edge-profile"
IN="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
OUT_DIR="$(cd "$(dirname "$2")" && pwd)"
OUT="$OUT_DIR/$(basename "$2")"

"$EDGE" --headless --disable-gpu --hide-scrollbars --user-data-dir="$PROFILE" \
  --force-device-scale-factor=2 --default-background-color=00000000 \
  --window-size="$3,$4" --screenshot="$OUT" "file://$IN" 2>/dev/null
echo "$OUT"
