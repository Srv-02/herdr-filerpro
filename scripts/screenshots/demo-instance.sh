#!/bin/sh
# Prepares (and with "start" launches) a separate Herdr instance for the README screenshots, so the demo never runs in
# your own Herdr: own HERDR_APP_HOME and own core session (HC_SESSION), both below tmp/ of this checkout (gitignored).
# Usage: scripts/screenshots/demo-instance.sh prepare|start|space|quit|clean
#   prepare: demo folder, mod and layout; start: launch the window; space: open the demo space in it; quit: close it and stop its core
# The window of a new instance takes the focus once on launch (macOS); nothing here raises or focuses it afterwards.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export HERDR_APP_HOME="$ROOT/tmp/76-home"
export HC_SESSION=filerpro-shots
# The pane header shows this folder: ~/acme-app keeps the checkout path out of the images.
DEMO="${DEMO_DIR:-$HOME/acme-app}"
APP="${HERDR_APP:-/Applications/Herdr.app/Contents/MacOS/Herdr}"

prepare() {
  [ ! -e "$DEMO" ] || { echo "$DEMO exists: remove it first (or set DEMO_DIR)" >&2; exit 1; }
  rm -rf "$HERDR_APP_HOME"
  mkdir -p "$HERDR_APP_HOME/mods" "$HERDR_APP_HOME/layouts" "$ROOT/tmp/76-raw"
  cp -R "$ROOT/mods/filer-pro" "$HERDR_APP_HOME/mods/filer-pro"
  cp -R "$ROOT/scripts/screenshots/demo/acme-app" "$DEMO"
  # The default layout of your Herdr with the panel as the first child of panel-body, shown from the start.
  node -e '
    const fs = require("fs"), home = process.env.HERDR_APP_HOME;
    const src = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const find = (n, id) => n.id === id ? n : (n.children || []).map((c) => find(c, id)).find(Boolean);
    const panel = find(src, "panel"), body = find(src, "panel-body");
    delete panel.hidden;
    body.active = "filer-pro";
    body.children.unshift({ id: "filer-pro", type: "block", content: { mod: "filer-pro" } });
    fs.writeFileSync(home + "/layouts/demo.json", JSON.stringify(src, null, 2));
    fs.writeFileSync(home + "/shared.json", JSON.stringify({ layout: "demo" }));
  ' "${DEFAULT_LAYOUT:-$HOME/.config/herdr-app/layouts/main.json}"
}

case "${1:-}" in
  prepare) prepare ;;
  start) nohup "$APP" > "$ROOT/tmp/76-app.log" 2>&1 & echo "started; HERDR_APP_HOME=$HERDR_APP_HOME HC_SESSION=$HC_SESSION" ;;
  space) herdr-app do space.new '{"name":"acme-app","folder":"'"$DEMO"'","tab":"acme-app","argv":["env","BASH_SILENCE_DEPRECATION_WARNING=1","PS1=acme-app $ ","/bin/bash","--norc","--noprofile"]}' ;;
  quit) herdr-app do app.quit || true; sleep 2; hc server stop || true ;;
  clean) rm -rf "$DEMO" "$HERDR_APP_HOME" ;;
  *) echo "usage: $0 prepare|start|space|quit|clean" >&2; exit 2 ;;
esac
