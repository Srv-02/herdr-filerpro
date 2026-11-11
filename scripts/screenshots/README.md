# Screenshots

The README images in `screenshots/` are cards: crops of a running Herdr window, placed on a shared frame and gradient and rendered at 2x with a transparent outside. Everything shown comes from the made-up project in `demo/acme-app`, never from a real project.

## One command

```sh
scripts/screenshots/shoot.sh
```

`scripts/screenshots/shoot.sh browse extract` shoots only the named cards (preview, formats, browse, editors, extract, edit-terminal, pdf-fullscreen, settings, show-as-root); `CROP_ONLY=1` re-crops and renders from the raw shots in `tmp/shots-raw` without launching anything.

It prepares a separate Herdr instance, launches it once, sets every state without mouse or keyboard, takes the shots, quits the instance, crops them and renders all cards into `screenshots/`. Needs macOS, Herdr.app, Microsoft Edge (headless, no window), `node`, `zip` and `sips`. Look at every image before you commit it: no user name, no path outside `~/acme-app`.

What it never does: touch your own Herdr or its installed mod, use `osascript`, `open -a`, mouse or keyboard automation, or raise a window. The one focus change is macOS giving a new app instance the focus when it launches. The window must stay visible (a minimized window renders no frames for `herdr-app shot`).

## Files

- `shoot.sh`: the whole run (prepare, launch, drive, shoot, quit, clean, crop, render). The crop boxes are raw pixels of the default window (1280 x 820 points, panel 446 points wide, app zoom 1); it stops when the window has another size.
- `demo-instance.sh`: `prepare | start | space | quit | clean` for the separate instance. Its `HERDR_APP_HOME` is `tmp/shots-home` and its core session `filerpro-shots`. `prepare` copies `demo/acme-app` to `~/acme-app` (the pane header shows that path, and it refuses to overwrite an existing folder), generates `report.pdf`, `hero.png` and `release.zip` from `demo/gen/` (headless Edge, `zip`), copies the mod of this checkout and writes a layout with the panel shown. It also marks the welcome screen (`frame.welcomed` in `shared.json`) and the what's-new window (`last_run` in `update-notes.json`) as done, so a new instance opens no popup that would need a click.
- `demo-hook.mjs`: patches the instance's copy of the mod (never `mods/filer-pro`, never your installed mod) so the panel polls `$HERDR_APP_HOME/demo-cmd.json` and sets the state a click or hover would set, through the real code: expanded folders, Calculate Size, the row menu with one entry hovered, the Settings dialog scrolled to a section, the fullscreen PDF with two pages. It stops loudly when an anchor in the mod has moved; `test/screenshot-hook.test.js` applies it to the current mod on every `npm test`, and checks that the shipped mod has no trace of it.
- `render.sh`: renders a card into a PNG with headless Microsoft Edge (`EDGE=/path/to/browser` picks another Chromium-based browser).
- `cards/card.css`, `cards/*.html`: the shared frame and one card per image, each listing its crops and their positions in CSS pixels. The crops (`cards/*.png`) and the browser profile are ignored by git: they hold window content, only the finished card goes into `screenshots/`.
- `demo/acme-app/`, `demo/gen/`: the demo project and the sources of its generated binary files.

## By hand

Files open without mouse input through a request file: write `{"action":"open","path":"<absolute path>"}` to `$HERDR_APP_HOME/filer-pro/requests/<id>.json`, wait for `<id>.result.json` and run `herdr-app shot raw.png` (it saves the whole window at full pixel size, popups included). Keep raw shots in the ignored `tmp/`: they contain the sidebar with your checkout and branch name. For one card, crop the panel along its outer border (`sips -c <h> <w> --cropOffset <y> <x> raw.png --out cards/<name>.png`), then render:

```sh
scripts/screenshots/render.sh scripts/screenshots/cards/preview.html screenshots/preview.png 880 600
```

A panel cut off at the bottom gets the class `cut`, which draws its border again.
