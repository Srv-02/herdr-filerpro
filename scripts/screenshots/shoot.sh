#!/bin/bash
# Re-creates every README image end to end with one command: prepare the demo instance, launch it once, set each state through
# the demo hook (demo-hook.mjs, patched into the instance's copy of the mod only), take the shots with `herdr-app shot`, quit the
# instance, then crop and render the cards with headless Edge. No mouse, no keyboard, no focus change: the one focus the new
# window takes on launch is macOS's own. Needs: macOS, Herdr.app, Microsoft Edge, node, zip, sips. Usage: scripts/screenshots/shoot.sh
# The crop boxes below are raw pixels of the default window (1280 x 820 points at 2x, panel 446 points wide, app zoom 1).
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
S="$ROOT/scripts/screenshots"
RAW="$ROOT/tmp/shots-raw"
export DEMO_HOOK=1 HERDR_APP_HOME="$ROOT/tmp/shots-home" HC_SESSION=filerpro-shots
DEMO="${DEMO_DIR:-$HOME/acme-app}"
inst() { "$S/demo-instance.sh" "$@"; }
cleanup() { inst quit >/dev/null 2>&1 || true; inst clean >/dev/null 2>&1 || true; }
trap cleanup EXIT

# One hook command: the panel polls demo-cmd.json and runs it once per id.
n=0
cmd() { n=$((n + 1)); printf '{"id":"c%s",%s}' "$n" "$1" > "$HERDR_APP_HOME/demo-cmd.json"; sleep "${2:-2.5}"; }
# Open a file in the panel through a request file and wait for its answer.
openfile() {
  local id="r$RANDOM$n" dir="$HERDR_APP_HOME/filer-pro/requests"
  n=$((n + 1)); echo '{"action":"open","path":"'"$DEMO/$1"'"}' > "$dir/$id.json"
  for _ in $(seq 1 30); do [ -f "$dir/$id.result.json" ] && break; sleep 1; done
  grep -q '"ok": true' "$dir/$id.result.json" || { echo "open $1 failed" >&2; exit 1; }
  sleep "${2:-3}"
}
shot() { herdr-app shot "$RAW/$1.png" > /dev/null; }
closeall() { for _ in 1 2 3; do herdr-app do overlay.close > /dev/null; sleep 0.6; done; }

inst prepare
inst start
for _ in $(seq 1 40); do herdr-app status > /dev/null 2>&1 && break; sleep 1; done
sleep 4
inst space > /dev/null
sleep 5
herdr-app do layout.show '{"id":"panel"}' > /dev/null
sleep 4
[ -d "$HERDR_APP_HOME/filer-pro/requests" ] || { echo "the panel did not start" >&2; exit 1; }

# Files in the panel (preview.png, formats.png)
openfile README.md 7; shot readme
openfile docs/report.pdf 4; shot pdf
openfile index.html 3; shot html
openfile src/checkout.ts 3; shot ts
openfile assets/hero.png 3; shot png
# The PDF in full screen, two pages (pdf-fullscreen.png)
openfile docs/report.pdf 3
cmd '"op":"full","zoom":"page"' 14; shot pdffull; closeall
# Settings, scrolled to the top and to File list (settings.png)
cmd '"op":"settings","from":0' 4; shot settings-top; closeall
cmd '"op":"settings","from":9' 4; shot settings-bottom; closeall
# browse.png: the tree with sizes and a calculated folder, the row menu of a file
cmd '"op":"back"' 1
cmd '"op":"expand","paths":["assets","docs","src"]'
cmd '"op":"size","path":"docs"' 4
shot browse-tree
cmd '"op":"menu","path":"README.md","x":1000,"y":118' 1; shot browse-menu; closeall
# editors.png: src open, Open in VS Code hovered
cmd '"op":"collapse","paths":["assets","docs"]' 1; shot editors-tree
cmd '"op":"menu","path":".env.example","x":1000,"y":118,"hover":"filer-pro-menu-open-editor"' 1; shot editors-menu; closeall
# extract.png: an archive row, Extract to hovered
cmd '"op":"collapse","paths":["src"]'
cmd '"op":"expand","paths":["assets"]' 1; shot extract-tree
cmd '"op":"menu","path":"assets/release.zip","x":1000,"y":118,"hover":"filer-pro-menu-extract-to"' 1; shot extract-menu; closeall
# edit-terminal.png: the vi split and the row menu with Edit in Terminal hovered
cmd '"op":"collapse","paths":["assets","src"]'
herdr-app do terminal.open '{"argv":["vi","-n","+3",".env.example"],"folder":"'"$DEMO"'","place":"right"}' > /dev/null
sleep 4
cmd '"op":"row","path":".env.example"' 1
cmd '"op":"menu","path":".env.example","x":1130,"y":205,"hover":"filer-pro-menu-edit-terminal"' 2; shot edit-terminal
inst quit
echo "shots done, instance closed"

# Crop (raw pixels of the default window: 2560 x 1640)
C="$S/cards"
size="$(sips -g pixelWidth -g pixelHeight "$RAW/readme.png" | awk '/pixel/ {printf "%s ", $2}')"
[ "$size" = "2560 1640 " ] || { echo "unexpected window size $size: the crop boxes assume 2560 x 1640" >&2; exit 1; }
panel() { sips -c 1464 888 --cropOffset 102 1653 "$RAW/$1.png" --out "$C/$2.png" > /dev/null; }
box() { sips -c "$5" "$4" --cropOffset "$3" "$2" "$RAW/$1.png" --out "$C/$6.png" > /dev/null; }
panel readme preview-readme; panel pdf preview-pdf
panel html formats-html; panel ts formats-ts; panel png formats-png
panel browse-tree browse-tree; panel editors-tree editors-tree; panel extract-tree extract-tree
box browse-menu 236 2000 400 976 browse-menu
box editors-menu 236 2000 400 976 editors-menu
box extract-menu 236 2000 400 1102 extract-menu
box edit-terminal 102 1105 1436 1292 edit-terminal-window
box pdffull 83 179 2202 1475 pdf-fullscreen-window
box settings-top 116 660 1238 1408 settings-top
box settings-bottom 116 660 1238 1408 settings-bottom

# Render (headless Edge)
R="$S/render.sh"
"$R" "$C/preview.html" "$ROOT/screenshots/preview.png" 880 600 > /dev/null
"$R" "$C/formats.html" "$ROOT/screenshots/formats.png" 880 600 > /dev/null
"$R" "$C/browse.html" "$ROOT/screenshots/browse.png" 880 640 > /dev/null
"$R" "$C/editors.html" "$ROOT/screenshots/editors.png" 880 660 > /dev/null
"$R" "$C/extract.html" "$ROOT/screenshots/extract.png" 880 700 > /dev/null
"$R" "$C/edit-terminal.html" "$ROOT/screenshots/edit-terminal.png" 880 706 > /dev/null
"$R" "$C/pdf-fullscreen.html" "$ROOT/screenshots/pdf-fullscreen.png" 880 620 > /dev/null
"$R" "$C/settings.html" "$ROOT/screenshots/settings.png" 880 522 > /dev/null
echo "rendered into screenshots/. Look at every image before you commit it: no user name, no path outside ~/acme-app."
