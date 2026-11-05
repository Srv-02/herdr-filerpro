# Screenshots

The README images in `screenshots/` are cards: crops of the running Herdr window, placed on a shared frame and gradient and rendered at 2x with a transparent outside. Everything shown comes from the made-up project in `demo/acme-app`, never from a real project.

## Files

- `render.sh`: renders a card into a PNG with headless Microsoft Edge (`EDGE=/path/to/browser` picks another Chromium-based browser).
- `cards/card.css`: the shared frame, gradient, shadow and panel borders.
- `cards/*.html`: one card per image. Each lists its crops and their positions in CSS pixels.
- `demo/acme-app/`: the demo project the window shows.

Crops (`cards/*.png`) and the browser profile are ignored by git: they hold window content and only the finished card goes into `screenshots/`.

## Workflow

1. **Demo space.** Copy the demo project to a neutral folder (the pane header shows its path, for example `~/acme-app`), outside any git repository. Open it in a space with a neutral prompt, so no user or host name shows up:

   ```sh
   cp -R scripts/screenshots/demo/acme-app ~/acme-app
   herdr-app do space.new '{"name":"acme-app","folder":"'"$HOME"'/acme-app","tab":"acme-app",
     "argv":["env","BASH_SILENCE_DEPRECATION_WARNING=1","PS1=acme-app $ ","/bin/bash","--norc","--noprofile"]}'
   ```

   Then set up what the image shows. For `edit-terminal.png`: a vi split to the right (`-n` keeps the swap file out of the tree) and the Filer Pro panel:

   ```sh
   herdr-app do terminal.open '{"argv":["vi","-n","+3",".env.example"],"folder":"'"$HOME"'/acme-app","place":"right"}'
   herdr-app do layout.show '{"id":"panel"}'
   ```

   Keep the app zoom at 1, so one CSS pixel of the card is two pixels of the shot.

2. **Shot.** `herdr-app shot raw.png` saves the whole window at full pixel size. It contains the sidebar and every other space name, so keep it out of the repository (for example in the ignored `tmp/`) and delete it when done.

3. **Crop.** Cut each panel out along its outer border (any image tool, for example Pillow: `Image.open("raw.png").crop((left, top, right, bottom))`) and save it under the name the card expects in `cards/`. Look at every crop: no paths outside the demo folder, no user or host names, no window titles.

4. **Render.** Sizes in CSS pixels, the PNG comes out at twice that:

   ```sh
   scripts/screenshots/render.sh scripts/screenshots/cards/edit-terminal.html screenshots/edit-terminal.png 880 620
   scripts/screenshots/render.sh scripts/screenshots/cards/editors.html screenshots/editors.png 880 660
   scripts/screenshots/render.sh scripts/screenshots/cards/settings.html screenshots/settings.png 880 540
   ```

   A panel cut off at the bottom gets the class `cut`, which draws its border again. Open the result and check it once more before you commit it.

5. **Clean up.** Close the demo space (`herdr-app do space.close '{"id":"<space>","confirmed":true}'`), go back to your own space, delete the demo copy and the raw shot. Closing the space leaves the panel state of your other spaces and your settings as they were; `herdr-app status` shows zoom and focus.
