# Filer Pro guide

Everything Filer Pro does, in detail. For the overview, see the [README](../README.md).

## Contents

- [Requirements](#requirements)
- [Install](#install): [Manual install](#manual-install)
- [The file tree](#the-file-tree): [Git marks](#git-marks), [File sizes](#file-sizes), [Navigating above the terminal's folder](#navigating-above-the-terminals-folder), [Show as Root](#show-as-root), [Local folder below](#local-folder-below), [Staying current](#staying-current)
- [Preview](#preview): [Markdown, Mermaid and PDF](#markdown-mermaid-and-pdf), [Source, HTML and images](#source-html-and-images), [Files that are not text](#files-that-are-not-text), [Archives and Office files](#archives-and-office-files), [Links in terminals](#links-in-terminals)
- [Extracting archives](#extracting-archives)
- [Editing plain text](#editing-plain-text): [Edit mode](#edit-mode), [Which files can be edited](#which-files-can-be-edited), [Saving](#saving), [Files that grow past 1 MiB](#files-that-grow-past-1-mib)
- [Editors](#editors): [Choosing and adding editors](#choosing-and-adding-editors), [How editor commands run](#how-editor-commands-run), [Remote files](#remote-files)
- [Transfers](#transfers): [Copy between machines](#copy-between-machines), [Move between machines](#move-between-machines)
- [Permissions](#permissions)
- [Settings](#settings): [Settings dialog](#settings-dialog), [Saving settings](#saving-settings), [Config file](#config-file), [All settings](#all-settings), [SVG check](#svg-check)
- [Updates](#updates): [Privacy](#privacy)
- [What it runs and touches](#what-it-runs-and-touches)
- [Removing](#removing)
- [Development](#development)

## Requirements

- Herdr app 0.1.17 or newer, with its shipped `tabs` mod.
- macOS as the local side. Remote machines: Linux or macOS, added to Herdr as SSH machines with key based login.
- Optional: Node.js for Mermaid diagrams, macOS 15 or later for `Delete…` on local files, a Herdr release newer than 0.1.17 with `pickFiles` for **Upload File…**.

## Install

In Herdr, ask your agent:

```text
Read ~/.config/herdr-app/AGENTS.md, then add this mod: https://github.com/Srv-02/herdr-filerpro/tree/main
```

Then click `Filer Pro` in the tab bar. To update, install the new version the same way (see [Updates](#updates)).

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

## The file tree

The tree shows the folder of the focused terminal, locally or on its machine.

- **Header:** the title, the shown folder's name, **Refresh all trees**, **Show This Mac** (the lower tree) and the gear for Settings. These never move.
- **Location line:** above every tree, also without the lower tree. It shows the place (a server icon and the machine name, or a laptop icon and **This Mac**), the folder, then Go to `/`, **Back to the terminal's folder** (upper tree only), Up and **Folder actions** (`…`). The path is cut first when the panel is narrow; the icons never wrap.
- **Folder actions:** the `…` button, or a right click in the free area below the tree, opens the menu for the folder the tree shows: **Upload File…** and **Upload Folder…** (machine trees), **New Folder…**, **Paste**, **Show in Finder** (trees on this computer), **Open in &lt;editor&gt;**, **Select Files** and **Show Hidden Files**.
- **Show Hidden Files:** checked while hidden files show. A click flips **Hide hidden files** (`hide_dotfiles`), saves it like the Settings dialog and reloads all trees.
- **Row menu:** right click for open, edit, calculate size, show as root (folders), download (machine trees only), extract (archives only, locally and on machines), copy, paste and new folder (folder rows, inside that folder), rename, permissions and delete. It acts on the row only: no Upload entries, and on this computer no Download or Download to….
- **Apps and packages:** apps and other macOS packages show as files. A double click starts them, and Show Package Contents looks inside.
- **Select several rows:** pick **Select Files** in a row menu or in the free area menu. Every row then shows a checkbox. A click on a row toggles it, a click on the arrow still opens and closes a folder, and **Done** in the selection bar ends the mode and clears the selection. **Select Files** on a row adds that row to a selection that already exists. The entry is also in the menu while **Select several files with Cmd and Shift** is off, and it is hidden while the mode runs.
- **Select with Cmd and Shift:** turn on **Select several files with Cmd and Shift** in Settings (File list). **Cmd+click** then adds or removes a file or folder and **Shift+click** selects every visible row from the last added row to the clicked one. A second Shift+click moves only the end of the range. A double click does not toggle twice. You can pick other clicks in Settings. Without a usable last row (none yet, or hidden by a collapse) Shift+click works like Cmd+click.
- **The selection bar:** below the tree, above the transfers, it shows `<n> selected`, the buttons Download, Copy, Cut and Delete, and **Clear**, or **Done** in the checkbox mode. The buttons are dimmed while nothing is selected. A right click on a selected row opens a short menu with the actions for all selected rows and **Clear Selection**. It stays while the selection is not empty.
- **Ending a selection:** a plain click on a row clears it and opens the row as usual. A click in the free area clears it, and so does a right click on a row outside the selection. In the checkbox mode none of these clear it. Switching the terminal and back keeps the selection. Rows that you delete or rename outside the panel, or that a collapsed folder hides, leave it. Keyboard selection is not supported yet.
- **Show in Finder with the switch on:** Cmd+click is then the selection click, so Show in Finder needs **Option+Cmd+click**. The right-click menu entry works either way.
- **System and hidden files:** system files like `.DS_Store` stay out of the way, and hidden files can go too (`hide_system_files`, `hide_dotfiles` in [All settings](#all-settings)).
- **No permission:** a folder you may not read or search shows the row "No permission to list this folder" below it instead of looking empty.

### Git marks

- Git marks (`M`, `A`, `U`, `D`) are shown for the folder you are looking at, also when it is reached through a symbolic link, and for a folder inside a repository.
- Paths of the repository outside that folder are not shown.
- When the shown folder is a subfolder of a repository, the repository's `.git` above it is watched as well (locally), so marks follow `git add`, `git commit`, `git reset` and `git restore --staged` within about a second.

### File sizes

With **Show file sizes** on (Settings, File list; on by default):

- Each file shows its size right-aligned next to the name, in decimal units like the Finder (1 kB = 1000 bytes, up to PB).
- A symbolic link shows the size of the link itself.
- The sizes come with the listing, from one batched `stat` per folder in the same command, so they follow the same reloads and cost no extra round trip on a machine. Off, the listing runs no `stat`.

**Calculate Size** for folders:

- Folders show `—` until you pick **Calculate Size** in their row menu. This also holds for apps and other packages, which show no size before.
- It adds up all files below, without following links. The result shows in the size column and at the right of the menu entry until **Refresh** or the next Calculate Size.
- A calculated folder size carries `~` (`~2.4 MB`) because it is approximate: hard links, sparse files and files that change while counting make it so.
- When a subfolder could not be read, the size shows the same way with the tooltip "Some folders could not be read", in the column and on the menu entry.
- A folder that takes longer than 120 seconds shows "Too large to calculate", and the count is stopped on the machine as well.
- The same unknown sum applies to transfers, see [Copy between machines](#copy-between-machines).
- On Windows (this computer) Calculate Size is dimmed.

### Navigating above the terminal's folder

Three icons in the location line take you above the terminal's folder without leaving the terminal. They never move.

| Icon | Where | What it does |
|---|---|---|
| **Go to /** | the slash, first of the three | Jumps straight to `/` |
| **Back to the terminal's folder** | the folder tree icon between the slash and Up | Shows the folder the terminal is in now. Always there, dimmed while the tree shows the terminal's folder |
| **Up one level** | the bent arrow right of the folder name | Each click shows the parent folder |

- The location line shows the path of the shown folder (from `~` on this computer, cut at the front when the panel is narrow).
- The tree stays where you navigated, also when you `cd` in the terminal, until you click **Back to the terminal's folder**.
- The navigated folder belongs to the terminal you navigated from: another terminal shows its own folder, and switching back shows the navigated one again.
- Expanded folders and the open file are kept where they lie inside the new folder.
- On a machine the new folder is listed with the same commands as before.
- `/` and the folders above your home folder are not watched for changes (a watch there would wake for every change on the disk): use **Refresh** there.

### Show as Root

- To show only one folder, right click it and pick **Show as Root**, or double-click it.
- **Up one level** and **Back to the terminal's folder** lead back.
- A single click still opens and closes a folder.
- **Show folders as root with a double click** (Settings, File list) turns the double click off.

### Local folder below

The button left of the gear in the header (**Show This Mac**) opens a second tree under the first one, on this computer. It works with a local terminal too. The first tree keeps following the terminal. The lower tree is always this computer and does not follow the focus. One lower tree serves all spaces and panel copies.

- **Start folder:** it opens in the folder you set as **Start folder for This Mac** in Settings (Downloads). Empty means your home folder. If you change the setting later, the lower tree goes back to the new start folder, also after you navigated it. Up, Go to `/`, **Show as Root** and a double click on a folder move it, and it keeps that folder after a restart.
- **Same rules:** both trees have the same rows, menus, sizes, git marks and selection. A selection is in one tree at a time: a click in the other tree clears it, and a selection that returns with a terminal switch gives way to the lower tree's, and one selection bar sits under both trees.
- **Between the trees:** **Copy** (or **Cut**) in one tree and **Paste** in a folder of the other moves files between this computer and a machine without the Finder, or between two folders on this computer.
- **Location lines:** each tree has its own line (see [The file tree](#the-file-tree)) with its own Go to `/`, Up and **Folder actions**. **Back to the terminal's folder** is only in the upper line. Both lines have the same height, text size and icon size. The lower line ends in a **×** (tooltip **Hide This Mac**) that hides the lower tree, like the header button. **Refresh all trees** in the header reloads both.
- **The divider:** drag it to resize. Each tree stays at least 120 px high. The sizes, the shown state and the folder are remembered.
- **Open files:** a file opens in the viewer as before and hides both trees. `←` brings both back at their scroll positions. A file you opened from the lower tree stays open when the terminal moves to another folder or machine.

### Staying current

The tree and the open file stay current without polling.

**On this computer** they follow file system events:

- When an agent or another editor changes the open file, the view updates in place.
- Only changes Filer Pro can show trigger a reload (entries of the shown folder and of expanded folders, the open file, the git index, `HEAD` and refs), at most once per second.
- Writes in collapsed folders, caches below a home folder or hidden entries while hidden files are hidden cost nothing.
- An expanded folder that is a symbolic link to another folder inside the shown folder follows changes too.
- The target of a link that points outside the shown folder is not watched: a change there shows on **Refresh** or after your next action.

**On an SSH machine** Filer Pro sends no commands while you just look:

- The tree and the open file reload after your own actions in Filer Pro, when you switch to another terminal or folder, and on **Refresh** (the circular arrows in the header).
- A file you click is always read fresh.
- A change made on the machine by something else shows at the next of these.

**Both:**

- Unsaved edits are never replaced by a reload; saving then checks for the outside change as usual.
- If you want a timer anyway, set **Look for changes every** (`refresh_seconds`) in Settings. A value already saved in `filer-pro.json` (for example the old default 10) keeps polling until you set it to 0.
- Hand edits of `filer-pro.json` apply on **Refresh** or after saving Settings.

## Preview

### Markdown, Mermaid and PDF

- Markdown renders with Mermaid diagrams.
- PDF shows page by page (Previous and Next buttons in the header) and always fits the panel width.
- In full screen you choose Single page or Two pages (the cover alone) and Page, Width or 100 %, or zoom from 50 to 300 % (buttons, cmd-+ / cmd-- / cmd-0 or + / - / 0, cmd + scroll wheel).
- Remote content inside documents is never loaded.
- `←` goes back to the tree where you left it, with the file you just opened marked.

### Source, HTML and images

- Code opens with syntax colors and line wrap.
- HTML and images open in place.
- One click goes fullscreen.

### Files that are not text

Files that are not text say why instead of a generic error:

- "File larger than 1 MiB (3.4 MB)"
- "UTF-16 file"
- "Binary file · no text preview"
- "No read permission"
- "This file is no longer available"
- "No search permission on its folder · cannot show this file", when the file cannot be reached because a folder above it cannot be searched

More details:

- **Other encodings:** a text file in another encoding than UTF-8 (Latin-1 and the like) is shown anyway, with a replacement character (�) for each byte that is not UTF-8, and cannot be edited in the panel.
- **On this computer** a normal preview costs nothing extra: the reason is looked up only after the read failed.
- **On an SSH machine** one bounded command reads the file and its edit check together: a text file is transferred once, and a file above 1 MiB is not transferred at all.

### Archives and Office files

Archives (`zip`, `gz`, `tgz`, `bz2`, `xz`, `zst`, `7z`, `rar`, `tar`) and Office or OpenDocument files (`doc`, `docx`, `xls`, `xlsx`, `ppt`, `pptx`, `odt`, `ods`, `odp`) are never read as text.

- **On this computer** a click shows the message with an **Open** button, and a double click starts the default app (a single click starts it when **Open apps with a double click** is off).
- A file that only turns out to be binary after the read shows the same message and button.
- **On an SSH machine** a click never downloads or opens anything: the message shows at once without a read and without a button. **Open** and **Download** in the right-click menu stay available, and so does Cmd+click for other files (not for these types; Option+Cmd+click with **Select several files with Cmd and Shift** on).

### Links in terminals

Needs Herdr app 0.1.17 or later (terminal link handlers). Older versions ignore it.

- Cmd+click (Ctrl+click on other systems) on a path to an image, PDF, Markdown or HTML file in a terminal shows it in the Filer Pro panel instead of the system app. The panel opens if it is hidden.
- A Cmd+click on a terminal link always opens the file in the upper tree, also when the lower tree is shown.
- Paths a coding agent prints work as they are: absolute, relative to the terminal's folder, `~/…`, `file://` links, and with a `:line:column` suffix.
- It works for terminals on your machines too: the file opens from that machine, where the system app could not reach it.
- A file below the folder the panel shows opens there; any other file opens with its folder as the root, as with [Show as Root](#show-as-root).
- Unsaved changes in the open file keep it open; a toast says so.
- Other files, folders and URLs keep the usual Cmd+click. To give these files back to the system app, remove `filer-pro` from `link_handlers` in your layout (Herdr adds it there the first time).

## Extracting archives

- The right-click menu extracts `zip`, `tar` (also `tar.gz`, `tgz`, `tar.bz2`, `tar.xz`, `tar.zst`) and single compressed files (`gz`, `bz2`, `xz`, `zst`).
- **Extract Here** extracts next to the archive, **Extract to "name/"** into a folder named like the archive.
- `7z` and `rar` are not extracted.
- With **Check free space before extracting** on (`extract_space_check`, the default), Filer Pro stops before extracting when the result would not fit, see [All settings](#all-settings).
- Where it runs, what it refuses and which tools it needs: see **Extracting** in [What it runs and touches](#what-it-runs-and-touches).

## Editing plain text

Small edits happen right in the source view, locally and on your machines.

### Edit mode

- **Edit** (the pencil) in the header switches the view to edit mode.
- **Undo**, **Redo**, **Cancel**, **Save** and **Save a Copy…** appear next to it as icons (curved arrows, a crossed circle, a disk and a copy symbol; hover one for its name).
- A `●` before the file name marks unsaved changes.
- The line below the text shows encoding, line endings and permissions, for example `UTF-8 · LF · 600`.
- In the fullscreen view `Cmd+S`, `Cmd+Z` and `Cmd+Shift+Z` work too; the small view in the panel has buttons only.
- Going back, closing the fullscreen view or switching edit mode off with unsaved changes asks Save, Discard or Cancel first.

### Which files can be edited

Only files that can be written back byte for byte are editable. Edit is dimmed, with the reason in its tooltip, for:

- UTF-16, UTF-8 with BOM and any other encoding than clean UTF-8
- mixed or CR-only line endings
- binary files
- files over 1 MiB
- files whose view is cut at `source_max_chars`
- symbolic links, folders and packages
- files without write permission or on read-only volumes
- files in folders everyone may write to (without the sticky bit)
- local files on Windows

For those, use Edit in Terminal.

### Saving

- Saving checks first that the file is still exactly what was opened. If anything else changed it meanwhile, the save is refused and your text stays in the editor (use Save a Copy…).
- The file is then overwritten in place, so its permissions, owner, hard links and extended attributes stay as they are.
- Line endings (LF or CRLF) and a missing final newline are kept.
- Save a Copy… never replaces an existing file.

### Files that grow past 1 MiB

An edit may make a file larger than 1 MiB, and saving it works.

- Filer Pro cannot read such a file back, so it checks the saved file by size and SHA-256 checksum instead of comparing its bytes.
- It keeps the saved text for the rest of the session: you can go on editing and saving it, also after closing the fullscreen view (the panel then shows the saved text and Edit continues from it).
- A change of its permissions still decides whether Edit is allowed.
- Once something else changes the file, or you open it again later, it shows `File larger than 1 MiB` like any other large file.
- If the file was deleted meanwhile it shows `This file is no longer available` instead, and if its folder lost search permission it shows `No search permission on its folder · cannot show this file`.

## Editors

Right click a file to open it in VS Code, Cursor or Zed, or to edit it in vi, nano or helix in a split next to your terminal. It works for files on your SSH machines too, and you can add your own editors.

- **Open in &lt;editor&gt;** opens the file in a GUI editor, for example **Open in VS Code**; the name follows the editor you picked.
- **Edit in Terminal** opens a terminal editor in a new split to the right, on the file's machine.
- Both are dimmed for folders.
- **Folder actions** (`…` in the location line) and a right click in the free area below the tree have the same **Open in &lt;editor&gt;** entry, which opens the shown folder (also after Up or Go to /), locally and on SSH machines.

### Choosing and adding editors

Settings picks among the shipped editors and your own entries. Own entries go into `~/.config/herdr-app/filer-pro.json` (Settings has no form for them) and show up in Settings after you reopen it. An entry with a problem (see [How editor commands run](#how-editor-commands-run)) is left out of the list.

```json
{
  "terminal_editor": "helix",
  "terminal_editors": [{ "name": "nvim", "command": "nvim -u NONE" }],
  "gui_editor": "Zed",
  "gui_editors": [{ "name": "Sublime", "local": "subl {path}" }]
}
```

| Key | Value |
|---|---|
| `terminal_editor` | One of `vi` (default), `vim`, `nano`, `micro`, `fresh`, `helix` (runs `hx`), or the name of an own entry |
| `terminal_editors` | Own entries `{ "name", "command" }`. `command` is the program with its own arguments; the file path is added as the last argument. An own entry with a shipped name replaces it |
| `gui_editor` | One of `VS Code` (default), `Cursor`, `Zed`, or the name of an own entry |
| `gui_editors` | Own entries `{ "name", "local", "remote", "remote_folder" }`, see below |

`gui_editors` entries:

- `local` opens a file or folder on this computer.
- `remote` (optional) opens a file on an SSH machine. Without `remote` the row entry is dimmed on a machine.
- `remote_folder` (optional) opens a folder on an SSH machine, with the same placeholders as `remote`. Without `remote_folder` the free-area entry is dimmed on a machine.
- An own entry replaces a shipped one of the same name as a whole, so a `VS Code` entry of your own has no `remote_folder` unless you add it.
- Placeholders: `{path}` (absolute path on the file's machine), `{path_uri}` (the same path percent-encoded for a URI) and `{target}` (the machine's SSH target, for `remote` and `remote_folder` only).
- Each template needs `{path}` or `{path_uri}`.

### How editor commands run

- Commands and templates are split into words first (spaces separate, `'…'` and `"…"` group, no escapes), then the placeholders are filled in per word.
- No shell is involved, so any file name is safe.
- Unknown names and broken entries fall back to the default; nothing checks beforehand whether the editor is installed.
- A missing terminal editor shows the shell's "not found" in the new terminal, a failing GUI editor shows its error as a notice.
- Command line tools that are not on Herdr's `PATH` are also tried in `/opt/homebrew/bin`, `/usr/local/bin` and `~/.local/bin`.

### Remote files

- **Edit in Terminal** starts the editor in a split of the focused terminal (or a new tab of the active space) when the active space is on the file's machine; otherwise a notice asks you to switch to a space on that machine.
- **Open in &lt;editor&gt;** uses the editor's own remote mode:

  | Editor | Opens | Needs |
  |---|---|---|
  | VS Code, Cursor | `vscode-remote://ssh-remote+<target>/<path>`; a folder from the free area opens with `--folder-uri vscode-remote://ssh-remote+<target>/<path>` | the Remote - SSH extension |
  | Zed | `ssh://<target>/<path>` for files and folders | Zed remote development |

- The editor connects by itself, so the SSH target must work from your editor too; ports belong in `~/.ssh/config` as a host alias.

## Transfers

- **Drag out:** rows are drag sources for terminals only (`drag_paths`). Dropping a row into a terminal pastes its path; a remote row keeps its machine. Dropping onto the Finder or onto the other tree cancels in Herdr 0.1.17 and 0.1.18. Between the trees use **Upload to <machine>** (lower tree), **Download to This Mac** (upper machine tree) or Copy and Paste. A selected row drags the whole selection of its tree. A drop of local files from the Finder on a tree uploads (machine tree) or copies (This Mac tree). Rows show no drop highlight.
- Drop files from the Finder to upload, right click to download. **Upload File…** and **Upload Folder…** in the Folder actions and free-area menu (on top) open the picker and send the chosen files or the folder like a drop, into the folder the tree shows. They show in machine trees only (a local tree would only copy). **Upload File…** needs a Herdr version with `pickFiles` (newer than 0.1.17). In the This Mac tree, **Upload to <machine>** (row and selection menu, only while the upper tree shows a machine) uploads into the folder the upper tree shows. In the upper machine tree, **Download to This Mac** (row and selection menu, only while the This Mac tree is shown) downloads into the folder the lower tree shows. Every row shows its full name as a tooltip after the pointer rests 0.5 s.
- Every transfer shows progress and can be cancelled.
- **Cut** on one side and **Paste** on the other moves: see [Move between machines](#move-between-machines).
- Nothing is overwritten without asking.
- **Several rows at once:** select rows, then right click one of them or use the selection bar. **Download**, **Copy**, **Cut**, **Paste**, **Copy Paths** and **Delete** act on every selected row in one step. A folder and a file inside it count once, as the folder. A conflict is asked once with **Apply to all**. A move of several items never offers **Merge**. **Delete** asks once and lists the names. On a machine a delete stops after 120 s.
- Timeouts and how long finished transfers stay visible: **Transfers & connections** in [All settings](#all-settings).

### Copy between machines

- Copy on one machine and Paste on another copies between the two machines through this computer (`scp -3`): the data travels over your connection twice, and the two machines need no access to each other.
- A short warning names both machines and the amount first. **Don't show again** in it, or **Warn before copying between machines** in Settings, turns it off.
- When a folder to copy could not be read completely (or counting took too long), the warning before a copy between machines leaves out the size of the batch and the job shows no percentage.

### Move between machines

- Cut on this computer or on a machine, Paste on the other side (or on a third machine): Filer Pro copies first, checks the copy, and only then deletes the original.
- **Warn before cutting between machines** in Settings (default on) turns this dialog off. Then a cut between machines starts at once, also when the original is deleted for good; the copy is still checked before the delete, and all refusals stay.
- A dialog asks before each paste: **Move from `host-a` to this computer?** An original on a machine is deleted for good (no Trash), the dialog says so in red and the **Move** button is red. A local original goes to the Trash on this computer. **Cancel** starts nothing.
- The check compares files, folders, bytes and the newest change of the original before and after the copy. Up to 1 GB it also compares a SHA-256 of the content, which needs `sha256sum`, `shasum` or `sha256` on both sides. Larger items count files, folders and bytes only.
- Every other ending keeps the original and says why in a `Copied, source kept` toast: the copy failed, was cancelled or stalled, the check failed or timed out, the original changed during the copy, a delete guard refused, or Herdr was restarted. The Cut stays, so the item can be pasted again. Only a moved item leaves the Cut.
- A move never offers **Merge**. **Replace** and **Keep both** work as for a copy.
- A target that is the original's own folder, or a folder inside the original, is refused. This also catches two machine names that reach the same folder.
- Two machine names for one SSH host move on that host, without a copy. If Filer Pro cannot tell whether two machines are the same, the paste is refused.
- A Cut remembers the folder the tree showed. A Cut made without it (older entries) cannot move to another side: Cut it again.
- The transfers bar marks a move with `✂` and names the phase: `Checking the copy…`, `Deleting the original…`. **✕** during the check keeps the original.

## Permissions

**Permissions…** in the row menu (files and folders, on this computer and on a machine; dimmed on Windows) shows the mode as an Owner / Group / Others by Read / Write / Execute matrix and as an octal field (3 or 4 digits, `644` or `2755`), kept in sync both ways.

- **Owner and group** are shown, never changed (no `chown`, no `chgrp`).
- **Special bits:** setuid, setgid and sticky are chips next to the octal field. Click one to set or clear the bit (the same as typing the 4 digit mode), with a warning.
- **Warnings while you edit:** there is no second confirmation step. Under the fields the dialog shows, and updates as you click or type, everything worth knowing before you apply:
  - a world writable result
  - removing your own read or write permission (for a folder also execute)
  - a change of a special bit
  - for **Apply to enclosed items**, what happens to the files and folders inside plus the number of entries inside the folder (counted up to 10,000, then "more than 10,000"; "many items" if counting fails)
- **Apply** runs `chmod` at once and closes the dialog. An open file the change covers (the entry itself, its folder, or a folder above it with Apply to enclosed items) checks again at once whether it can be edited.
- **Only your own entries:** the dialog is read only, with the note "Not the owner, permissions cannot be changed", unless you own the entry or are root. No `sudo`, no password prompt. Anything else the system refuses (a locked file, a protected volume) is shown as its message when you apply.
- **Symbolic links:** a link is never changed, not itself and not through the link. The dialog shows the permissions of the link's target, read only, with a note. A path that turns into a link between opening the dialog and applying is refused too.
- **Apply to enclosed items:** for a folder, `chmod` runs on the folder and everything inside it with exactly the same mode, like `chmod -R 644` would. So a folder mode without execute makes the folders inside unenterable, and an execute bit makes files executable; the dialog says so. Links inside are skipped and never followed. Protected paths (the root, your home folder, the shown folder, top level and system folders) are refused, as for Delete. macOS packages count as folders.
- **After the change** the mode is read back. Which special bits a system keeps differs by OS and file system (Linux drops setgid on a file when you are not in its group; macOS on APFS keeps the sticky bit on a file set by its owner), so the dialog never assumes: if the system set something else than asked, a warning notice shows both modes.
- **Safety:** paths and modes are passed to `sh` as arguments, never put into a command string; the mode is always sent with five digits so GNU `chmod` also clears special bits of a folder.

## Settings

### Settings dialog

Most settings can be changed in **Settings**, without a restart. Open it with the gear in the panel header while no file is open.

The dialog shows, in this order:

| Section | Contents |
|---|---|
| **Updates** | The installed version, **Check now**, and the switch for the automatic check |
| **Downloads** | The folder, with **Choose…** for the system folder picker |
| **Editors** | Pick the GUI and the terminal editor. Own editors are added in the config file (see [Editors](#editors)) and appear here after reopening Settings |
| **File list** | The switches **Hide system files**, **Hide hidden files**, **Show file sizes**, **Open files with a double click**, **Open apps with a double click**, **Show folders as root with a double click**, **Select several files with Cmd and Shift**, **Click to add or remove a file**, **Click to select a range** and **Check free space before extracting**. The two click pickers are dimmed while **Select several files with Cmd and Shift** is off, and the two picks must differ. While hidden files are hidden, **Hide system files** shows on and cannot be switched |
| **Preview** | **Show previews**, **Draw diagrams** |
| **Security** | The SVG check, see [SVG check](#svg-check) |
| **Advanced** | Closed at first. Every limit, timeout and connection setting (and the warning before a copy between machines) in three groups: **File list limits**, **Preview limits** and **Transfers & connections** |

`perf` and the own editor lists (`terminal_editors`, `gui_editors`) are config file only.

### Saving settings

- Each field is checked when you leave it and again on Save. Nothing is written until every field is valid, and a wrong field in Advanced opens it.
- Saving changes only the keys you edited: it reads the file again, applies your changes, and writes only if nobody changed the file in between (else it reads it again and retries).
- Keys it does not know stay as they are.
- A file that is not valid JSON is never overwritten; fix or remove it first.
- Changes apply within a second, without a restart (only `perf` needs one).
- What turning `update_check` off or on again does is described in [Updates](#updates).

### Config file

All settings live in `~/.config/herdr-app/filer-pro.json`:

```json
{ "download_folder": "~/Downloads", "preview": true, "mermaid": true, "perf": false, "update_check": true }
```

- `{ "preview": false }` turns the preview off (source view only).
- `{ "mermaid": false }` leaves Mermaid fences as code.
- `{ "perf": true }` writes render timings to `~/.config/herdr-app/data/filer-pro/perf.jsonl`.
- `{ "update_check": false }` turns the update check off (see [Updates](#updates)).
- A missing key means its default.
- In the file, a number of the wrong type (or with a fraction) means the default, a whole number out of range the nearest bound.

### All settings

| Key | In Settings | Default | Range | What it does |
|---|---|---|---|---|
| `update_check` | Updates: Check for updates automatically | `true` | `true` / `false` | Daily update check |
| `download_folder` | Downloads: Download folder | `~/Downloads` | not empty | Where downloads go |
| `local_tree_folder` | Downloads: Start folder for This Mac | empty | empty or a folder | Where the lower tree opens; empty uses your home folder |
| `terminal_editor`, `terminal_editors`, `gui_editor`, `gui_editors` | Editors: Open in Editor, Edit in Terminal (the lists: config file only) | see [Editors](#editors) | | Edit in Terminal, Open in &lt;editor&gt; |
| `hide_system_files` | File list: Hide system files | `true` | `true` / `false` | Hide OS clutter: `.DS_Store`, `._*`, `.Spotlight-V100`, `.Trashes`, `.fseventsd`, `.TemporaryItems`, `.DocumentRevisions-V100`, `.apdisk`, `Icon\r`, `Thumbs.db`, `desktop.ini` (the last two in any case). Hidden entries do not count against the list limits; copy, move and delete of a folder still include them |
| `hide_dotfiles` | File list: Hide hidden files | `false` | `true` / `false` | Hide every file and folder whose name starts with a dot; while on, system files are hidden too, whatever `hide_system_files` says |
| `show_sizes` | File list: Show file sizes | `true` | `true` / `false` | Show the size of each file next to its name; folders show one (`~`) after **Calculate Size** in the row menu. Off: the listing runs no `stat` |
| `double_click_files` | File list: Open files with a double click | `false` | `true` / `false` | Open a file with a double click; a single click then only marks it. Folders open and close with a single click either way |
| `double_click_apps` | File list: Open apps with a double click | `true` | `true` / `false` | Start a local macOS package (`.app`, `.pkg`, `.rtfd`) or open a local archive or Office file with the default app with a double click; a single click then only marks it. Off: a single click starts it |
| `double_click_folders` | File list: Show folders as root with a double click | `true` | `true` / `false` | Show a folder as the tree's root with a double click, as Show as Root in its row menu does. Off: a double click opens and closes it again |
| `multi_select` | File list: Select several files with Cmd and Shift | `false` | `true` / `false` | Cmd+click adds or removes a file, Shift+click selects everything in between. Show in Finder then needs Option+Cmd+click or the right-click menu. **Select Files** in the row menu works either way |
| `select_toggle_click` | File list: Click to add or remove a file | `cmd` | `cmd`, `shift`, `cmd_shift`, `alt`, `alt_shift` | The click that adds or removes a row while `multi_select` is on. `alt` is Option. It must differ from `select_range_click`, otherwise both fall back to the defaults |
| `select_range_click` | File list: Click to select a range | `shift` | `cmd`, `shift`, `cmd_shift`, `alt`, `alt_shift` | The click that selects every visible row from the last added row to this one while `multi_select` is on |
| `extract_space_check` | File list: Check free space before extracting | `true` | `true` / `false` | Look into the archive and the free space of its folder before extracting and stop when it would not fit: a tar's size usually comes from the listing that is read anyway, a zip's from its directory, a single compressed file takes one extra pass. Off: skip that look |
| `preview` | Preview: Show previews | `true` | `true` / `false` | Preview Markdown, HTML, images and PDFs |
| `mermaid` | Preview: Draw diagrams | `true` | `true` / `false` | Draw Mermaid diagrams |
| `svg_check` | Security: Check SVG images before showing them | `true` | `true` / `false` | Check SVG files before drawing them (see [SVG check](#svg-check)) |
| `list_per_folder` | Advanced, File list limits: Files shown per folder | `500` | 10–10,000 | Entries shown per folder |
| `list_total` | Advanced, File list limits: Files shown in total | `5000` | 100–20,000 | Entries shown in the whole tree |
| `tree_depth` | Advanced, File list limits: Deepest folder level | `40` | 1–200 | Deepest folder level shown |
| `refresh_seconds` | Advanced, File list limits: Look for changes every | `0` (off) | 0 or 2–3,600 s | Periodic reload of the tree and the open file. Off by default: no timer and, on an SSH machine, no commands while idle. The tree and the open file still reload on file system events (this computer), after your own actions, on a folder or terminal switch and on **Refresh**. A reload never overlaps another one; on a slow machine extra triggers wait and run once |
| `preview_max_chars` | Advanced, Preview limits: Longest formatted preview | `200000` | 10,000–2,000,000 | Characters of a Markdown or HTML preview |
| `source_max_chars` | Advanced, Preview limits: Longest plain text view | `400000` | 10,000–5,000,000 | Characters of the source view, the rest is cut |
| `image_max_mb` | Advanced, Preview limits: Show images right away up to | `20` | 1–500 MB | Larger images show a Load button (SVGs: no preview) |
| `pdf_local_max_mb` | Advanced, Preview limits: Show PDFs on this Mac right away up to | `100` | 1–2,000 MB | Larger local PDFs show a Load button |
| `pdf_remote_max_mb` | Advanced, Preview limits: Show PDFs on SSH machines right away up to | `20` | 1–500 MB | Larger PDFs on a machine show a Load button |
| `image_cache_mb` | Advanced, Preview limits: Disk space for the image cache | `50` | 10–5,000 MB | Size of the image and PDF page cache |
| `max_diagrams` | Advanced, Preview limits: Diagrams per file | `20` | 1–100 | Mermaid diagrams drawn per file |
| `max_diagram_chars` | Advanced, Preview limits: Largest diagram | `20000` | 1,000–200,000 | Characters per Mermaid diagram |
| `node_path` | Advanced, Preview limits: Node.js for diagrams | `""` | empty or an absolute path | Node for Mermaid; empty tries `node`, `/opt/homebrew/bin/node`, `/usr/local/bin/node` |
| `ssh_connect_timeout` | Advanced, Transfers & connections: Give up connecting after | `15` | 1–300 s | SSH `ConnectTimeout` for transfers and previews |
| `ssh_alive_interval` | Advanced, Transfers & connections: Check the connection every | `15` | 1–300 s | SSH `ServerAliveInterval` for transfers and previews |
| `ssh_alive_count` | Advanced, Transfers & connections: Drop the connection after | `4` | 1–100 | SSH `ServerAliveCountMax` for transfers and previews |
| `stall_seconds` | Advanced, Transfers & connections: Stop a stuck transfer after | `120` | 10–3,600 s | A transfer whose temp file does not grow this long is stopped as stalled |
| `keep_done_seconds` | Advanced, Transfers & connections: Keep finished transfers visible for | `10` | 0–3,600 s | How long finished transfers stay in the transfers bar |
| `warn_cross_copy` | Advanced, Transfers & connections: Warn before copying between machines | `true` | `true` / `false` | Ask once per paste before the data of a copy between two machines travels through this computer; **Don't show again** in the warning sets it to `false` |
| `warn_cross_move` | Advanced, Transfers & connections: Warn before cutting between machines | `true` | `true` / `false` | Ask before a cut file is moved to or from another machine; `false` skips the Move dialog in every case, also for the permanent delete on a machine (the copy is still verified before the original goes) |
| `perf` | config file only | `false` | `true` / `false` | Render timings in `perf.jsonl` (takes effect after a restart) |

- The SSH settings apply to transfers (download, upload, copy on a machine, copy between machines, Load) and to the preview's copy of images and PDFs from a machine (that copy also stops after 30 s).
- Fixed and not configurable: the 100-megapixel limit for images, the 30 s limit per Mermaid render, and internal timers.

### SVG check

`svg_check` is a security boundary.

- **On (default):** an SVG is drawn only if it cannot set its own size through CSS or load more than itself (no external style sheets, entities, `foreignObject`, XHTML, or CSS that sets a size or pulls in a URL), and only up to the first 64 KiB, which are checked.
- **Off:** every SVG with a readable size is drawn. A crafted SVG can then load external content or inject code, and can set its own size in CSS past the 100-megapixel limit. Turning it off is at your own risk.

## Updates

- The installed version is in `mods/filer-pro/mod.json` and shown at the top of Settings.
- Once a day Filer Pro asks GitHub for its latest release (`api.github.com/repos/Srv-02/herdr-filerpro/releases/latest`). If it is newer, the panel header shows `● <version> available`, which opens the release page.
- **Check now** in Settings asks at once and shows the answer there: up to date (with the time of the last check), a newer version with a link to its release page, or that GitHub could not be reached.
- Nothing is downloaded or installed. To update, install the new version as described in [Install](#install).

### Privacy

- The request goes to GitHub without any account or token and sends no data about you or your files, but GitHub sees your IP address.
- To turn the daily check off, switch off **Check for updates automatically** in Settings, or set `"update_check": false` in `~/.config/herdr-app/filer-pro.json`. Then no request is made unless you click **Check now**, and a hint already shown disappears within a second.
- If you turn it on again, the first automatic check can take up to an hour, because the update pass runs at most hourly; **Check now** asks at once.

## What it runs and touches

### Programs

| Programs | Used for |
|---|---|
| `ssh`, `scp` | `scp -3` for a copy between two machines, through this computer |
| `hc`, `sh`, `cp`, `mv` | |
| `stat`, `find`, `sleep`, `kill` | Permissions, editing and sizes; `sleep` and `kill` stop a size count at its limit |
| `xargs` | File sizes |
| `chmod`, `id`, `wc` | Permissions |
| `git status` | Read only |
| `head`, `base64`, `tr`, `mktemp`, `cat`, `dirname`, `awk`, `sha256sum` (or `shasum`, or `openssl`) | Editing |
| `open`, `xattr`, `pbcopy`, `/usr/bin/trash` | |
| `tar`, `unzip` (or `bsdtar` for a zip when `unzip` is missing), `gzip`, `bzip2`, `xz`, `zstd`, `df` | Extract; `gzip`, `bzip2`, `xz` and `zstd` for single compressed files and compressed tars |
| `osascript` | PDF pages through PDFKit |
| `node` | Mermaid |
| The editors you configure | Only when you pick Open in &lt;editor&gt; or Edit in Terminal |

### Files

- It lists and changes files wherever you browse and act, locally and on your machines.
- Its own data lives in `~/.config/herdr-app/filer-pro.json`, `~/.config/herdr-app/data/filer-pro/` and `~/.config/herdr-app/filer-pro/`.
- Editing adds a private folder `~/.cache/filer-pro/edit/` on the machine of the file (upload and backup while a save runs, normally empty afterwards).
- Unsaved text is kept in the private folder `~/.config/herdr-app/filer-pro/unsaved/` (0700) until it is saved or discarded.

### Extracting

- Runs on the machine that holds the archive, into a hidden work folder next to it, and moves the result in place when it is complete; the archive is never changed.
- An archive with an absolute path, a `..` component or a member written through a link is refused before anything is written.
- An archive that lists more than 200,000 entries is refused as well: its listing is checked in small steps so the panel stays responsive, and a bigger one would take too long.
- Encrypted zips are refused.
- A missing tool is named in the error (for example "zstd is not installed on this computer").
- Links inside an archive are extracted as links (a warning names how many point outside the extracted files).

### Automation folder

The mod watches `~/.config/herdr-app/filer-pro/requests/` for JSON requests (download, upload, copy, rename, delete and more). `download` and `delete` take a list in `paths` instead of `path`, and `clip` takes `items` (`[{ "path": "/srv/a", "is_dir": false }]`) instead of `path`; a request with a single `path` works as before. A move preset `"conflict": "merge"` now cancels the item (it used to replace it). Anything that can write to that folder can drive the mod.

### Network

- SSH to the machines you added to Herdr.
- At most one request per day to GitHub for the update check (off with `"update_check": false`), plus one for each click on **Check now** in Settings.
- Documents never load remote content. This holds for SVG images only while `svg_check` is on (whether Herdr's image renderer fetches external references of an unchecked SVG is not verified).

## Removing

1. Remove `filer-pro` from `workspace.panels` in `~/.config/herdr-app/shared.json`.
2. Remove the two blocks from your layout.
3. Delete `~/.config/herdr-app/mods/filer-pro` and `~/.config/herdr-app/data/filer-pro`, optionally also `~/.config/herdr-app/filer-pro.json` and `~/.config/herdr-app/filer-pro/`.

To remove only the preview, delete `mods/filer-pro/preview/` from the installed mod. Files then open as source. The caches `data/filer-pro/diagrams/`, `data/filer-pro/images/` and `data/filer-pro/loads/` under `~/.config/herdr-app/` can go too.

## Development

```sh
npm test        # unit and integration tests (Node, no Herdr needed)
npm run lint    # syntax check of all scripts
npm run bench   # wall-clock benchmarks and the QuickJS budget tests (need herdr-app; timing-dependent, not part of npm test)
```

- Local side is macOS, remote side Linux or macOS.
- Platform specific code lives in `mods/filer-pro/lib/platform.js` and `mods/filer-pro/bin/transfer.sh`.
- [RECIPE.md](../RECIPE.md) describes the mod as a brief to build it from scratch.
- [scripts/screenshots](../scripts/screenshots/README.md) holds the pipeline and demo project behind the README images.
