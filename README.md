# Filer Pro

![Filer Pro: the file panel for Herdr, local and remote](preview.png)

**A file panel for the [Herdr app](https://herdr.dev) that works the same on your Mac and on every machine you reach over SSH.**

<br>

<p align="center"><a href="https://www.buymeacoffee.com/michaelmayer"><img src="screenshots/bmc-button.png" alt="Buy me a coffee" height="64"></a></p>

<br>

## Install

In Herdr, ask your agent:

```text
Read ~/.config/herdr-app/AGENTS.md, then add this mod: https://github.com/Srv-02/herdr-filerpro/tree/main
```

Then click `Filer Pro` in the tab bar. To install by hand, see [Manual install](#manual-install).

## Features

### Follows your terminal

![File tree with git marks and the context menu open](screenshots/browse.png)

The tree shows the folder of the focused terminal, locally or on its machine. Right click for open, edit, download, copy, paste, rename and delete.

### Transfers you can trust

![A running transfer and the conflict dialog](screenshots/transfers.png)

Drop files from the Finder to upload, right click to download. Every transfer shows progress and can be cancelled, and nothing is overwritten without asking.

### Preview

![Markdown with a Mermaid diagram next to a PDF](screenshots/preview.png)

Markdown renders with Mermaid diagrams, PDF shows page by page. Remote content inside documents is never loaded. `←` goes back to the tree where you left it, with the file you just opened marked.

### Source, HTML and images

![HTML preview, source view with syntax colors and an image preview](screenshots/formats.png)

Code opens with syntax colors and line wrap, HTML and images open in place. One click goes fullscreen.

## Details

### Requirements

- Herdr app with its shipped `tabs` mod.
- macOS as the local side. Remote machines: Linux or macOS, added to Herdr as SSH machines with key based login.
- Optional: Node.js for Mermaid diagrams, macOS 15 or later for `Delete…` on local files.

### Manual install

1. Copy the mod folder. The folder must be named `filer-pro`.

   ```sh
   cp -R mods/filer-pro ~/.config/herdr-app/mods/filer-pro
   herdr-app check ~/.config/herdr-app/mods/filer-pro
   ```

2. Clone a layout (`herdr-app do layout.clone '{"name":"main","as":"my-layout"}'`) and in `~/.config/herdr-app/layouts/my-layout.json` replace the `tabs` block with:

   ```json
   { "id": "tab-bar", "type": "row", "size": { "px": 42 }, "resizable": false, "children": [
     { "id": "tabs", "type": "block", "content": { "mod": "tabs" }, "window_drag": true },
     { "id": "filer-pro-button", "type": "block", "content": { "mod": "filer-pro", "props": { "button": true } }, "size": { "px": 96 }, "window_drag": true }
   ] }
   ```

   Add the panel as the first child of `panel` > `panel-body`:

   ```json
   { "id": "filer-pro", "type": "block", "content": { "mod": "filer-pro" }, "size": { "weight": 1 }, "min": 120 }
   ```

3. Click `Filer Pro` in the tab bar. No `keys.json` entries are needed.

### Configuration

`~/.config/herdr-app/filer-pro.json`:

```json
{ "download_folder": "~/Downloads", "preview": true, "mermaid": true, "perf": false, "update_check": true }
```

`{ "preview": false }` turns the preview off (source view only), `{ "mermaid": false }` leaves Mermaid fences as code. `{ "perf": true }` writes render timings to `~/.config/herdr-app/data/filer-pro/perf.jsonl`. `{ "update_check": false }` turns the update check off (see [Updates](#updates)).

#### Editors

Right click a file for **Open in Editor** (a GUI editor) or **Edit in Terminal** (a terminal editor in a new split to the right, on the file's machine). Both are dimmed for folders.

```json
{
  "terminal_editor": "helix",
  "terminal_editors": [{ "name": "nvim", "command": "nvim -u NONE" }],
  "gui_editor": "Zed",
  "gui_editors": [{ "name": "Sublime", "local": "subl {path}" }]
}
```

- `terminal_editor`: one of `vi` (default), `vim`, `nano`, `micro`, `fresh`, `helix` (runs `hx`), or the name of an own entry.
- `terminal_editors`: own entries `{ "name", "command" }`. `command` is the program with its own arguments; the file path is added as the last argument. An own entry with a shipped name replaces it.
- `gui_editor`: one of `VS Code` (default), `Cursor`, `Zed`, or the name of an own entry.
- `gui_editors`: own entries `{ "name", "local", "remote" }`. `local` opens a file on this computer, `remote` (optional) a file on an SSH machine. Placeholders: `{path}` (absolute path on the file's machine), `{path_uri}` (the same path percent-encoded for a URI) and `{target}` (the machine's SSH target, `remote` only). Each template needs `{path}` or `{path_uri}`.

Commands and templates are split into words first (spaces separate, `'…'` and `"…"` group, no escapes), then the placeholders are filled in per word. No shell is involved, so any file name is safe. Unknown names and broken entries fall back to the default; nothing checks beforehand whether the editor is installed. A missing terminal editor shows the shell's "not found" in the new terminal, a failing GUI editor shows its error as a notice. Command line tools that are not on Herdr's `PATH` are also tried in `/opt/homebrew/bin`, `/usr/local/bin` and `~/.local/bin`.

Remote files: **Edit in Terminal** starts the editor in a split of the focused terminal (or a new tab of the active space) when the active space is on the file's machine; otherwise a notice asks you to switch to a space on that machine. **Open in Editor** uses the editor's own remote mode: VS Code and Cursor open `vscode-remote://ssh-remote+<target>/<path>` (needs the Remote - SSH extension), Zed opens `ssh://<target>/<path>` (Zed remote development). The editor connects by itself, so the SSH target must work from your editor too; ports belong in `~/.ssh/config` as a host alias.

To remove only the preview, delete `mods/filer-pro/preview/` from the installed mod. Files then open as source. The caches `data/filer-pro/diagrams/`, `data/filer-pro/images/` and `data/filer-pro/loads/` under `~/.config/herdr-app/` can go too.

### What it runs and touches

- **Programs:** `ssh` and `scp`, `hc`, `sh`, `cp`, `mv`, `git status` (read only), `open`, `xattr`, `pbcopy`, `/usr/bin/trash`, `osascript` (PDF pages through PDFKit), `node` (Mermaid), and the editors you configure (only when you pick Open in Editor or Edit in Terminal).
- **Files:** it lists and changes files wherever you browse and act, locally and on your machines. Its own data lives in `~/.config/herdr-app/filer-pro.json`, `~/.config/herdr-app/data/filer-pro/` and `~/.config/herdr-app/filer-pro/`.
- **Automation folder:** the mod watches `~/.config/herdr-app/filer-pro/requests/` for JSON requests (download, upload, copy, rename, delete and more). Anything that can write to that folder can drive the mod.
- **Network:** SSH to the machines you added to Herdr, and at most one request per day to GitHub for the update check (off with `"update_check": false`). Documents never load remote content.

### Updates

The installed version is in `mods/filer-pro/mod.json`. Once a day Filer Pro asks GitHub for its latest release (`api.github.com/repos/Srv-02/herdr-filerpro/releases/latest`). If it is newer, the panel header shows `● <version> available`, which opens the release page. Nothing is downloaded or installed; to update, install the new version as described above.

Privacy: the request goes to GitHub without any account or token and sends no data about you or your files, but GitHub sees your IP address. To turn it off, set `"update_check": false` in `~/.config/herdr-app/filer-pro.json`; then no request is made at all, and a hint already shown disappears within an hour.

### Removing

1. Remove `filer-pro` from `workspace.panels` in `~/.config/herdr-app/shared.json`.
2. Remove the two blocks from your layout.
3. Delete `~/.config/herdr-app/mods/filer-pro` and `~/.config/herdr-app/data/filer-pro`, optionally also `~/.config/herdr-app/filer-pro.json` and `~/.config/herdr-app/filer-pro/`.

### Development

```sh
npm test        # unit and integration tests (Node, no Herdr needed)
npm run lint    # syntax check of all scripts
```

Local side is macOS, remote side Linux or macOS. Platform specific code lives in `mods/filer-pro/lib/platform.js` and `mods/filer-pro/bin/transfer.sh`. [RECIPE.md](RECIPE.md) describes the mod as a brief to build it from scratch.

## Credits

Built on the Files mod of [Herdr](https://github.com/herdrdev/herdr-app) (Apache-2.0). Icons from [file-icons](https://github.com/cybertron288/herdr-mods) by cybertron288 and the [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) (MIT). Preview and Mermaid from [herdr-files-plus](https://github.com/jjongkwann/herdr-files-plus) by jjongkwann (MIT), with [beautiful-mermaid](https://github.com/lukilabs/beautiful-mermaid) (MIT), [elkjs](https://github.com/kieler/elkjs) (EPL-2.0) and [entities](https://github.com/fb55/entities) (BSD-2-Clause). Menu entries inspired by [herdr-files-open-with](https://github.com/tomislavpet/herdr-files-open-with) by tomislavpet. Details in `THIRD_PARTY_NOTICES.md`.

## License

MIT, see [LICENSE](LICENSE). Third party parts keep their own licenses.
