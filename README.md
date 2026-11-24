# Filer Pro

![Filer Pro: the file panel for Herdr, local and remote](preview.png)

**A file panel for the [Herdr app](https://herdr.dev) that works the same on your Mac and on every machine you reach over SSH.**

- **Follows your terminal:** the tree shows the folder of the focused terminal, local or remote.
- **Previews almost anything:** Markdown with Mermaid diagrams, PDF, code, HTML and images, also in full screen.
- **Edits in place:** quick fixes right in the panel, or one click to your editor.
- **Two trees:** your terminal's folder on top, This Mac below.
- **Moves files between your Mac and your machines:** upload, download, copy and move, also from one SSH machine to another.
- **Quiet on SSH machines:** no commands sent while you just look.

<br>

<p align="center"><a href="https://www.buymeacoffee.com/michaelmayer"><img src="screenshots/bmc-button.png" alt="Buy me a coffee" height="64"></a></p>

<br>

## Install

In Herdr, ask your agent:

```text
Read ~/.config/herdr-app/AGENTS.md, then add this mod: https://github.com/Srv-02/herdr-filerpro/tree/main
```

Then click `Filer Pro` in the tab bar.

- **Needs** Herdr on macOS. SSH machines can run Linux or macOS.
- **Update:** the header shows `● <version> available` when a new release is out; install it the same way.
- **By hand, removing, requirements:** see the [guide](docs/GUIDE.md#install).

## Features

### Browse

- **Your terminal's folder:** `cd` in the terminal, and the tree follows.
- **Location line:** where you are, Go to `/`, Up one level and one click back to the terminal's folder.
- **Sizes and git marks:** file sizes next to each name, Calculate Size for folders, `M` `A` `U` `D` from git.
- **Always current:** follows file system events on this Mac, no polling.

![The file tree with sizes, a calculated folder size and the row menu of a file](screenshots/browse.png)

### Folder actions

- **The `…` in the location line**, or a right click below the tree: Upload File… and Upload Folder… on machines, New Folder…, Paste, Show in Finder, Open in your editor, Select Files.
- **Show Hidden Files** with one click.
- **Row menus act on the row** they belong to.

![The Folder actions of a machine tree with Upload File…, Upload Folder… and Show Hidden Files](screenshots/folder-actions.png)

### This Mac below

- **A second tree** on this computer under the terminal's tree: **Show This Mac** in the header, `×` to close.
- **Starts in your home folder,** or in the start folder you set in Settings.
- **Between the trees:** Download to This Mac, Upload to `<machine>`, or Copy and Paste.
- **Drag the divider** to share the height.

![A machine tree on devbox above This Mac, with Download to This Mac in the row menu](screenshots/machine.png)

### Select several

- **Select Files** in a menu puts a checkbox on every row.
- **Cmd+click and Shift+click** with the switch in Settings.
- **One step for all:** Download, Copy, Cut, Paste, Copy Paths or Delete, from the selection bar or a right click.

![Three files checked, the selection bar and the menu for all of them](screenshots/select.png)

### Show as Root

- **Focus on one folder:** pick **Show as Root** in its row menu, or double-click it.
- **One click back:** Up one level or Back to the terminal's folder.

![The row menu of a folder with Show as Root](screenshots/show-as-root.png)

### Preview

- **Markdown** with Mermaid diagrams.
- **PDF** page by page, in full screen also as a two page spread, zoom 50–300 %.
- **Safe:** remote content inside documents is never loaded.
- **Cmd+click** an image, PDF, Markdown or HTML path in a terminal, also on a remote machine, to see it here (Herdr app 0.1.17 or later).

![Markdown with a Mermaid diagram next to a PDF](screenshots/preview.png)

![A PDF in full screen as a two page spread, with the single and two page switch, the Page, Width and 100 % presets and the zoom buttons](screenshots/pdf-fullscreen.png)

### Code, HTML and images

- **Code** with syntax colors and line wrap.
- **HTML and images** in place, one click to full screen.
- **Clear reasons** when a file can't be shown: binary, too large, no permission.

![HTML preview, source view with syntax colors and an image preview](screenshots/formats.png)

### Edit

- **Right in the panel:** small edits in the source view, locally and on your machines.
- **Undo, Redo, Save, Save a Copy…**, with `●` for unsaved changes.
- **Safe saves:** a save is refused if the file changed meanwhile; permissions, owner and line endings stay.

### Editors

- **Open in VS Code, Cursor or Zed**, also for files on SSH machines.
- **Edit in Terminal** with vi, nano or helix, in a split next to your terminal.
- **Bring your own:** add more editors in the config file ([how](docs/GUIDE.md#editors)).

![Context menu with Open in VS Code and Edit in Terminal](screenshots/editors.png)

![Edit in Terminal picked in the context menu, and the file open in vi in a split](screenshots/edit-terminal.png)

### Transfers

- **Upload:** drop files from the Finder, or Upload File… and Upload Folder… in the Folder actions of a machine tree.
- **Download:** right click a row on a machine, or Download to This Mac into the lower tree.
- **Move:** Cut on one side, Paste on the other, between this computer and a machine or between two machines. The original goes only after the copy checks out.
- **Machine to machine:** Copy on one, Paste on the other, through this computer.
- **Drag a row into a terminal** to paste its path.
- **Progress and cancel** for every transfer, nothing overwritten without asking.

![A running transfer and the conflict dialog](screenshots/transfers.png)

### Archives

- **Extract Here** or **Extract to "name/"** from the row menu, locally and on machines.
- **zip, tar and compressed tars** (gz, bz2, xz, zst), and single compressed files.
- **Safe:** the archive is never changed; absolute paths and `..` are refused before anything is written.

![The row menu of an archive with Extract Here and Extract to "release/"](screenshots/extract.png)

### Permissions

- **Matrix and octal:** Owner / Group / Others by Read / Write / Execute, in sync with the octal field.
- **Warnings while you edit:** world writable, losing your own access, special bits, changes inside a folder.
- **Only your own entries:** no `sudo`, no `chown`, links never changed.

### Settings

- **One dialog:** the gear in the panel header, changes apply without a restart.
- **Your way:** one click or two for files and apps, and what the tree hides.
- **Update check:** once a day, one switch turns it off.

![The settings dialog: Updates, Downloads and Editors on the left, the File list switches including Show file sizes on the right](screenshots/settings.png)

Every key, default and limit: [Settings in the guide](docs/GUIDE.md#settings).

## Documentation

- **[Guide](docs/GUIDE.md):** every feature, setting and limit in detail.
- **[What it runs and touches](docs/GUIDE.md#what-it-runs-and-touches):** programs, files and network access.
- **[RECIPE.md](RECIPE.md):** the mod as a brief to build it from scratch.
- **[Development](docs/GUIDE.md#development):** tests, lint and benchmarks.

## Credits

- Built on the Files mod of [Herdr](https://github.com/herdrdev/herdr-app) (Apache-2.0).
- Icons from [file-icons](https://github.com/cybertron288/herdr-mods) by cybertron288 and the [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) (MIT).
- Preview and Mermaid from [herdr-files-plus](https://github.com/jjongkwann/herdr-files-plus) by jjongkwann (MIT), with [beautiful-mermaid](https://github.com/lukilabs/beautiful-mermaid) (MIT), [elkjs](https://github.com/kieler/elkjs) (EPL-2.0) and [entities](https://github.com/fb55/entities) (BSD-2-Clause).
- Menu entries inspired by [herdr-files-open-with](https://github.com/tomislavpet/herdr-files-open-with) by tomislavpet.

Details in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT, see [LICENSE](LICENSE). Third party parts keep their own licenses.
