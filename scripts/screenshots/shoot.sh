#!/bin/bash
# Re-creates every README image end to end with one command: prepare the demo instance, launch it once, set each state through
# the demo hook (demo-hook.mjs, patched into the instance's copy of the mod only), take the shots with `herdr-app shot`, quit the
# instance, then crop and render the cards with headless Edge. No mouse, no keyboard, no focus change: the one focus the new
# window takes on launch is macOS's own. Needs: macOS, Herdr.app, Microsoft Edge, node, zip, sips. Usage: scripts/screenshots/shoot.sh
# CROP_ONLY=1 skips the instance and re-crops and renders from the raw shots in tmp/shots-raw.
# Usage: shoot.sh [card ...]   (preview formats browse editors extract edit-terminal pdf-fullscreen settings show-as-root select
#                              machine folder-actions transfers hero; none = all)
# machine, folder-actions, transfers and hero need DEMO_MACHINE=<ssh target> (a Linux or macOS host you reach with ssh): it shows as "devbox",
# with the demo project in /tmp/acme-app there (see demo-instance.sh machine). Without it, both cards are skipped.
# The crop boxes below are raw pixels of the default window (1280 x 820 points at 2x, panel 446 points wide, app zoom 1).
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
S="$ROOT/scripts/screenshots"
RAW="$ROOT/tmp/shots-raw"
export DEMO_HOOK=1 HERDR_APP_HOME="$ROOT/tmp/shots-home" HC_SESSION=filerpro-shots
DEMO="${DEMO_DIR:-$HOME/acme-app}"
want() { [ $# -eq 0 ] && return 0; for w in "$@"; do [ "$w" = "$CARD" ] && return 0; done; return 1; }
ONLY="$*"
w() { CARD="$1"; want $ONLY; }
inst() { "$S/demo-instance.sh" "$@"; }
cleanup() { inst quit >/dev/null 2>&1 || true; inst clean >/dev/null 2>&1 || true; }
[ "${CROP_ONLY:-0}" = 1 ] || trap cleanup EXIT

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
# A popup's place in window points of the default window; Z=2 when the window is 2560 x 1640 points at app zoom 2 (see below).
Z=1
at() { printf '"x":%s,"y":%s' $(($1 * Z)) $(($2 * Z)); }
closeall() { for _ in 1 2 3; do herdr-app do overlay.close > /dev/null; sleep 0.6; done; }

if [ "${CROP_ONLY:-0}" != 1 ]; then
inst prepare
inst start
for _ in $(seq 1 40); do herdr-app status > /dev/null 2>&1 && break; sleep 1; done
sleep 4
# On a display without Retina scaling the window shoots at 1280 x 820 pixels. Then the instance restarts with a window of
# 2560 x 1640 points and app zoom 2: the panel lands on the same pixels as at 2x (the boxes below stay valid).
herdr-app shot "$RAW/probe.png" > /dev/null
if [ "$(sips -g pixelWidth "$RAW/probe.png" | awk '/pixelWidth/ {print $2}')" = 1280 ]; then
  herdr-app do app.quit > /dev/null || true; sleep 3
  node -e '
    const fs = require("fs"), h = process.env.HERDR_APP_HOME;
    const w = JSON.parse(fs.readFileSync(h + "/window.json", "utf8")); w.bounds = [w.bounds[0], 100, 2560, 1640];
    fs.writeFileSync(h + "/window.json", JSON.stringify(w));
    const s = JSON.parse(fs.readFileSync(h + "/settings.json", "utf8")); s.zoom = 2;
    fs.writeFileSync(h + "/settings.json", JSON.stringify(s));'
  inst start
  for _ in $(seq 1 40); do herdr-app status > /dev/null 2>&1 && break; sleep 1; done
  sleep 4
  Z=2
fi
rm -f "$RAW/probe.png"
inst space > /dev/null
sleep 5
herdr-app do layout.show '{"id":"panel"}' > /dev/null
sleep 4
[ -d "$HERDR_APP_HOME/filer-pro/requests" ] || { echo "the panel did not start" >&2; exit 1; }

# Files in the panel (preview.png, formats.png). At app zoom 2 the web views (Markdown, Mermaid, PDF, HTML) draw at the wrong scale.
if { w preview || w formats; } && [ "$Z" = 2 ]; then echo "preview, formats: skipped (the file views draw at the wrong scale at app zoom 2; shoot them on a Retina display)" >&2; fi
if { w preview || w formats; } && [ "$Z" = 1 ]; then
openfile README.md 7; shot readme
openfile docs/report.pdf 4; shot pdf
openfile index.html 3; shot html
openfile src/checkout.ts 3; shot ts
openfile assets/hero.png 3; shot png
fi
if w pdf-fullscreen && [ "$Z" = 2 ]; then echo "pdf-fullscreen: skipped (the fullscreen view does not fit at app zoom 2; shoot it on a Retina display)" >&2; fi
if w pdf-fullscreen && [ "$Z" = 1 ]; then
# The PDF in full screen, two pages (pdf-fullscreen.png)
openfile docs/report.pdf 3
cmd '"op":"full","zoom":"page"' 14; shot pdffull; closeall
fi
if w settings; then
# Settings, scrolled to the top and to File list (settings.png)
cmd '"op":"settings","from":0' 4; shot settings-top; closeall
cmd '"op":"settings","from":9' 4; shot settings-bottom; closeall
fi
if w browse || w editors || w extract || w edit-terminal || w show-as-root; then
# browse.png: the tree with sizes and a calculated folder, the row menu of a file
cmd '"op":"back"' 1
cmd '"op":"expand","paths":["assets","docs","src"]'
cmd '"op":"size","path":"docs"' 4
shot browse-tree
cmd '"op":"menu","path":"README.md",'"$(at 1000 118)"'' 1; shot browse-menu; closeall
# editors.png: src open, Open in VS Code hovered
cmd '"op":"collapse","paths":["assets","docs"]' 1; shot editors-tree
cmd '"op":"menu","path":".env.example",'"$(at 1000 118)"',"hover":"filer-pro-menu-open-editor"' 1; shot editors-menu; closeall
# extract.png: an archive row, Extract to hovered
cmd '"op":"collapse","paths":["src"]'
cmd '"op":"expand","paths":["assets"]' 1; shot extract-tree
cmd '"op":"menu","path":"assets/release.zip",'"$(at 1000 118)"',"hover":"filer-pro-menu-extract-to"' 1; shot extract-menu; closeall
# show-as-root.png: a folder row, Show as Root hovered
cmd '"op":"collapse","paths":["assets"]'
cmd '"op":"expand","paths":["docs"]' 1; shot root-tree
cmd '"op":"menu","path":"src",'"$(at 1000 118)"',"hover":"filer-pro-menu-show-as-root"' 1; shot root-menu; closeall
# edit-terminal.png: the vi split and the row menu with Edit in Terminal hovered
cmd '"op":"collapse","paths":["assets","src"]'
herdr-app do terminal.open '{"argv":["vi","-n","+3",".env.example"],"folder":"'"$DEMO"'","place":"right"}' > /dev/null
sleep 4
cmd '"op":"row","path":".env.example"' 1
cmd '"op":"menu","path":".env.example",'"$(at 1130 205)"',"hover":"filer-pro-menu-edit-terminal"' 2; shot edit-terminal
fi
if w select; then
# select.png: three files picked in the checkbox mode, the selection bar and the short menu for all of them
closeall
cmd '"op":"row"' 0.5
cmd '"op":"collapse","paths":["assets","docs"]' 1
cmd '"op":"expand","paths":["src"]' 1
cmd '"op":"select","paths":["src/api.ts","src/app.tsx","src/checkout.ts"],"boxes":true' 2; shot select-tree
cmd '"op":"menu","path":"src/app.tsx",'"$(at 1000 118)"',"hover":"filer-pro-menu-copy"' 1; shot select-menu; closeall
cmd '"op":"select","paths":[]' 1
fi
M=0; { w machine || w folder-actions || w transfers || w hero; } && M=1
if [ "$M" = 1 ] && [ -z "${DEMO_MACHINE:-}" ]; then echo "machine, folder-actions, transfers, hero: skipped (set DEMO_MACHINE)" >&2; fi
if [ "$M" = 1 ] && [ -n "${DEMO_MACHINE:-}" ]; then
# machine.png: a terminal on devbox, its tree above and This Mac below (~/acme-app), the row menu with Download to This Mac
inst machine
out="$(herdr-app do space.new '{"name":"acme-app","machine":"devbox","folder":"/tmp/acme-app","tab":"acme-app","argv":["env","PS1=acme-app $ ","/bin/bash","--norc","--noprofile"]}' 2>&1)" || { echo "space on devbox failed: $out" >&2; exit 1; }
sleep 6
herdr-app do layout.show '{"id":"panel"}' > /dev/null # a new space starts without the panel
sleep 8
cmd '"op":"localtree","shown":true,"root":"'"$DEMO"'"' 6
cmd '"op":"expand","paths":["docs"]' 4
cmd '"op":"expand","paths":["src"],"tree":"pinned"' 3
shot machine-tree
cmd '"op":"menu","path":"docs/report.pdf",'"$(at 1000 118)"',"hover":"filer-pro-menu-download-here"' 1; shot machine-menu; closeall
# folder-actions.png: the Folder actions of the devbox tree, Upload Folder… hovered
cmd '"op":"rootmenu",'"$(at 1000 118)"',"hover":"filer-pro-menu-upload-folder"' 1; shot folder-menu; closeall
# hero (preview.png): two files of devbox selected, the menu for both with Download to This Mac
cmd '"op":"expand","paths":["docs"]' 3 # again: the first expand is lost when the machine lists slowly
cmd '"op":"select","paths":["docs/report.pdf","docs/setup.md"]' 2; shot hero-tree
cmd '"op":"menu","path":"docs/report.pdf",'"$(at 1000 118)"',"hover":"filer-pro-menu-download-here"' 1; shot hero-menu; closeall
cmd '"op":"select","paths":[]' 1
# transfers.png: a download from devbox in the transfers bar (shown only, nothing runs) and the conflict dialog
cmd '"op":"jobs","jobs":{"demo1":{"id":"demo1","name":"site-backup.tar","direction":"down","machine":"devbox","state":"running","bytes":3400000000,"total":13000000000,"rate":598000000,"percent":26,"startedAt":1}}' 2
shot transfers-tree
cmd '"op":"conflict","item":{"name":"report.pdf","isDir":false,"destIsDir":false,"direction":"down","machine":"devbox"}' 2; shot transfers-dialog; closeall
fi
inst quit
echo "shots done, instance closed"
fi

# Crop (raw pixels of the default window: 2560 x 1640)
C="$S/cards"
first="$(ls "$RAW"/*.png | head -1)"
size="$(sips -g pixelWidth -g pixelHeight "$first" | awk '/pixel/ {printf "%s ", $2}')"
[ "$size" = "2560 1640 " ] || { echo "unexpected window size $size: the crop boxes assume 2560 x 1640" >&2; exit 1; }
panel() { sips -c 1464 888 --cropOffset 102 1653 "$RAW/$1.png" --out "$C/$2.png" > /dev/null; }
# box <raw> <y> <x> <width> <height> <out>
box() { sips -c "$5" "$4" --cropOffset "$2" "$3" "$RAW/$1.png" --out "$C/$6.png" > /dev/null; }
R="$S/render.sh"
if w preview && [ -f "$RAW/readme.png" ]; then panel readme preview-readme; panel pdf preview-pdf; "$R" "$C/preview.html" "$ROOT/screenshots/preview.png" 880 600 > /dev/null; fi
if w formats && [ -f "$RAW/html.png" ]; then panel html formats-html; panel ts formats-ts; panel png formats-png; "$R" "$C/formats.html" "$ROOT/screenshots/formats.png" 880 600 > /dev/null; fi
if w browse; then
  panel browse-tree browse-tree; box browse-menu 236 2000 400 794 browse-menu
  "$R" "$C/browse.html" "$ROOT/screenshots/browse.png" 880 640 > /dev/null
fi
if w editors; then
  panel editors-tree editors-tree; box editors-menu 236 2000 400 794 editors-menu
  "$R" "$C/editors.html" "$ROOT/screenshots/editors.png" 880 660 > /dev/null
fi
if w extract; then
  panel extract-tree extract-tree; box extract-menu 236 2000 400 920 extract-menu
  "$R" "$C/extract.html" "$ROOT/screenshots/extract.png" 880 700 > /dev/null
fi
if w show-as-root; then
  panel root-tree root-tree; box root-menu 236 2000 400 1018 root-menu
  "$R" "$C/show-as-root.html" "$ROOT/screenshots/show-as-root.png" 880 640 > /dev/null
fi
if w edit-terminal; then
  box edit-terminal 102 1105 1436 1292 edit-terminal-window
  "$R" "$C/edit-terminal.html" "$ROOT/screenshots/edit-terminal.png" 880 706 > /dev/null
fi
if w pdf-fullscreen && [ -f "$RAW/pdffull.png" ]; then
  box pdffull 83 179 2202 1475 pdf-fullscreen-window
  "$R" "$C/pdf-fullscreen.html" "$ROOT/screenshots/pdf-fullscreen.png" 880 620 > /dev/null
fi
if w settings; then
  box settings-top 116 660 1238 1408 settings-top; box settings-bottom 116 660 1238 1408 settings-bottom
  "$R" "$C/settings.html" "$ROOT/screenshots/settings.png" 880 522 > /dev/null
fi
if w select; then
  panel select-tree select-tree; box select-menu 236 2000 400 394 select-menu
  "$R" "$C/select.html" "$ROOT/screenshots/select.png" 880 792 > /dev/null
fi
if w machine && [ -f "$RAW/machine-tree.png" ]; then
  panel machine-tree machine-tree; box machine-menu 236 2000 400 976 machine-menu
  "$R" "$C/machine.html" "$ROOT/screenshots/machine.png" 880 792 > /dev/null
fi
if w folder-actions && [ -f "$RAW/folder-menu.png" ]; then
  panel machine-tree folder-tree; box folder-menu 236 2000 400 450 folder-menu
  "$R" "$C/folder-actions.html" "$ROOT/screenshots/folder-actions.png" 880 640 > /dev/null
fi
if w hero && [ -f "$RAW/hero-tree.png" ]; then
  panel hero-tree hero-tree; box hero-menu 236 2000 400 584 hero-menu
  "$R" "$C/hero.html" "$ROOT/preview.png" 1022 572 > /dev/null
fi
if w transfers && [ -f "$RAW/transfers-tree.png" ]; then
  panel transfers-tree transfers-tree; box transfers-dialog 580 840 880 480 transfers-dialog
  "$R" "$C/transfers.html" "$ROOT/screenshots/transfers.png" 880 792 > /dev/null
fi
echo "rendered into screenshots/. Look at every image before you commit it: no user name, no path outside ~/acme-app."
