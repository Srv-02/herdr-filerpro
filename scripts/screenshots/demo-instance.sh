#!/bin/sh
# A separate Herdr instance for the README screenshots, so the demo never runs in your own Herdr: own HERDR_APP_HOME (below tmp/ of
# this checkout, gitignored) and own core session (HC_SESSION). shoot.sh drives it end to end; the steps are here for manual use.
# Usage: scripts/screenshots/demo-instance.sh prepare|start|space|quit|clean
#   prepare: copy the demo project to ~/acme-app (refuses to overwrite) and generate its PDF, PNG and ZIP; copy the mod of this
#            checkout into the instance home (with DEMO_HOOK=1 patched by demo-hook.mjs, in that copy only) and write the layout
#   start:   launch the window (macOS gives a new instance the focus once; nothing here raises or focuses it afterwards)
#   space:   open the demo space with a neutral prompt        quit: close the instance and stop its core session
#   clean:   delete ~/acme-app, the instance home and the core session state
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export HERDR_APP_HOME="$ROOT/tmp/shots-home"
export HC_SESSION=filerpro-shots
# The pane header shows this folder: ~/acme-app keeps the checkout path out of the images.
DEMO="${DEMO_DIR:-$HOME/acme-app}"
APP="${HERDR_APP:-/Applications/Herdr.app/Contents/MacOS/Herdr}"
EDGE="${EDGE:-/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge}"
GEN="$ROOT/scripts/screenshots/demo/gen"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/herdr-core/$HC_SESSION"

# Headless Edge only: no window. The profile is thrown away.
edge() { "$EDGE" --headless --disable-gpu --hide-scrollbars --user-data-dir="$ROOT/tmp/shots-edge" "$@" 2>/dev/null; }

prepare() {
  [ ! -e "$DEMO" ] || { echo "$DEMO exists: remove it first (or set DEMO_DIR)" >&2; exit 1; }
  rm -rf "$HERDR_APP_HOME" "$STATE"
  mkdir -p "$HERDR_APP_HOME/mods" "$HERDR_APP_HOME/layouts" "$ROOT/tmp/shots-raw"
  cp -R "$ROOT/scripts/screenshots/demo/acme-app" "$DEMO"
  mkdir -p "$DEMO/assets" "$DEMO/docs"
  edge --window-size=640,360 --screenshot="$DEMO/assets/hero.png" "file://$GEN/hero.html"
  edge --no-pdf-header-footer --print-to-pdf="$DEMO/docs/report.pdf" "file://$GEN/report.html"
  rm -rf "$ROOT/tmp/shots-edge"
  (cd "$DEMO" && zip -qr assets/release.zip docs/setup.md src/index.ts)
  echo "$DEMO" > "$HERDR_APP_HOME/created-demo" # clean deletes the demo folder only when this run created it
  cp -R "$ROOT/mods/filer-pro" "$HERDR_APP_HOME/mods/filer-pro"
  # DEMO_HOOK=1 patches only this copy so menus, hover, Settings and the fullscreen view can be set without mouse input.
  [ "${DEMO_HOOK:-0}" != 1 ] || node "$ROOT/scripts/screenshots/demo-hook.mjs" "$HERDR_APP_HOME/mods/filer-pro"
  # The default layout of your Herdr with the panel as the first child of panel-body, shown from the start.
  node -e '
    const fs = require("fs"), home = process.env.HERDR_APP_HOME;
    const src = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const find = (n, id) => n.id === id ? n : (n.children || []).map((c) => find(c, id)).find(Boolean);
    const panel = find(src, "panel"), body = find(src, "panel-body");
    delete panel.hidden;
    panel.size.px = Number(process.env.PANEL_PX || 446);
    body.active = "filer-pro";
    body.children.unshift({ id: "filer-pro", type: "block", content: { mod: "filer-pro" } });
    fs.writeFileSync(home + "/layouts/demo.json", JSON.stringify(src, null, 2));
    // A new instance opens the welcome screen (shared "frame.welcomed" unset) and the what-is-new window (update-notes.json
    // last_run older than the app): pre-seed both as done so no popup needs a click.
    fs.writeFileSync(home + "/shared.json", JSON.stringify({ layout: "demo", "frame.welcomed": "finished" }));
    fs.writeFileSync(home + "/update-notes.json", JSON.stringify({ last_run: process.argv[2], presented: [] }));
  ' "${DEFAULT_LAYOUT:-$HOME/.config/herdr-app/layouts/main.json}" "$("${HERDR_APP_CLI:-herdr-app}" --version | awk '{print $NF}')"
}

case "${1:-}" in
  prepare) prepare ;;
  start) nohup "$APP" > "$ROOT/tmp/shots-app.log" 2>&1 & echo "started; HERDR_APP_HOME=$HERDR_APP_HOME HC_SESSION=$HC_SESSION" ;;
  space) herdr-app do space.new '{"name":"acme-app","folder":"'"$DEMO"'","tab":"acme-app","argv":["env","BASH_SILENCE_DEPRECATION_WARNING=1","PS1=acme-app $ ","/bin/bash","--norc","--noprofile"]}' ;;
  quit) herdr-app do app.quit || true; sleep 2; hc server stop || true ;;
  clean) { [ "$(cat "$HERDR_APP_HOME/created-demo" 2>/dev/null)" != "$DEMO" ] || rm -rf "$DEMO"; }; rm -rf "$HERDR_APP_HOME" "$STATE" "$ROOT/tmp/shots-edge" ;;
  *) echo "usage: $0 prepare|start|space|quit|clean" >&2; exit 2 ;;
esac
