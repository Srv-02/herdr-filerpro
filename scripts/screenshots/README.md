# Screenshots

The README images in `screenshots/` are cards: crops of the running Herdr window, placed on a shared frame and gradient and rendered at 2x with a transparent outside. Everything shown comes from the made-up project in `demo/acme-app`, never from a real project.

## Files

- `render.sh`: renders a card into a PNG with headless Microsoft Edge (`EDGE=/path/to/browser` picks another Chromium-based browser).
- `cards/card.css`: the shared frame, gradient, shadow and panel borders.
- `cards/*.html`: one card per image. Each lists its crops and their positions in CSS pixels.
- `demo/acme-app/`: the demo project the window shows.

Crops (`cards/*.png`) and the browser profile are ignored by git: they hold window content and only the finished card goes into `screenshots/`.

## Workflow

1. **Demo instance.** Never build the demo in your own Herdr. `demo-instance.sh` prepares a separate instance with its own `HERDR_APP_HOME` and core session (`HC_SESSION`), the home in the ignored `tmp/` of this checkout: a copy of `demo/acme-app` at `~/acme-app` (the pane header shows its path; `prepare` refuses to overwrite an existing folder), the mod from this checkout and your default layout with the Filer Pro panel shown. Its window must be visible (a minimized window renders no frames for `herdr-app shot`), and a new instance takes the focus once on launch; nothing in the script raises or focuses it afterwards.

   ```sh
   scripts/screenshots/demo-instance.sh prepare
   scripts/screenshots/demo-instance.sh start
   export HERDR_APP_HOME="$PWD/tmp/76-home" HC_SESSION=filerpro-shots   # for herdr-app and hc in your shell
   scripts/screenshots/demo-instance.sh space    # the demo space with a neutral prompt
   ```

   For `edit-terminal.png`: a vi split to the right (`-n` keeps the swap file out of the tree) and the Filer Pro panel:

   ```sh
   herdr-app do terminal.open '{"argv":["vi","-n","+3",".env.example"],"folder":"'"$HOME"'/acme-app","place":"right"}'
   ```

   Keep the app zoom at 1, so one CSS pixel of the card is two pixels of the shot.

2. **Shot.** `herdr-app shot raw.png` saves the whole window at full pixel size, popups included. It contains the sidebar (the space shows your checkout and branch name), so keep it in the ignored `tmp/` and delete it when done. Files open without any mouse input through a request file: write `{"action":"open","path":"<absolute path>"}` to `$HERDR_APP_HOME/filer-pro/requests/<id>.json`, wait for `<id>.result.json` and shoot (this is how `preview.png` and `formats.png` are made).

   A menu in its hover state, the fullscreen PDF view and the Settings dialog need a click, so they are shot by hand: open the menu, rest the pointer on the entry, and run `herdr-app shot` (or Cmd+Shift+4, then Space on the window).

3. **Crop.** Cut each panel out along its outer border (any image tool, for example Pillow: `Image.open("raw.png").crop((left, top, right, bottom))`) and save it under the name the card expects in `cards/`. Look at every crop: no paths outside the demo folder, no user or host names, no window titles.

4. **Render.** Sizes in CSS pixels, the PNG comes out at twice that:

   ```sh
   scripts/screenshots/render.sh scripts/screenshots/cards/preview.html screenshots/preview.png 880 600
   scripts/screenshots/render.sh scripts/screenshots/cards/formats.html screenshots/formats.png 880 600
   scripts/screenshots/render.sh scripts/screenshots/cards/edit-terminal.html screenshots/edit-terminal.png 880 651
   scripts/screenshots/render.sh scripts/screenshots/cards/editors.html screenshots/editors.png 880 660
   scripts/screenshots/render.sh scripts/screenshots/cards/settings.html screenshots/settings.png 880 646
   ```

   A panel cut off at the bottom gets the class `cut`, which draws its border again. A crop wider than the card (as in `edit-terminal.html`) is scaled to the card width; end it between two text lines. Open the result and check it once more before you commit it.

5. **Clean up.** `scripts/screenshots/demo-instance.sh quit` closes the demo instance and stops its core session; `ps` then shows no process of it. `scripts/screenshots/demo-instance.sh clean` deletes `~/acme-app` and the instance home; delete the raw shots too. Your own Herdr, its settings and spaces were never touched.
