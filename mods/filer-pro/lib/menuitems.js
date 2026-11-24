// Entries of the two right-click menus (row and free area). Pure: mods/filer-pro/ui/menu.js only draws them.
import { archiveOf, extractToLabel } from "./archives.js";
import { group } from "./numbers.js";
export const MENU_WIDTH = 200;
const ITEM_H = 28, SEPARATOR_H = 7, PADDING = 8, RESERVE = 4;

const SEPARATOR = { separator: true };
const openIn = (editor) => `Open in ${editor || "Editor"}`;
const entry = (action, label, enabled = true) => ({ id: `filer-pro-menu-${action.replace(/_/g, "-")}`, label, action, enabled });

// state: { selecting? (the Select Files mode is on: no Select Files entry), paste: { enabled, reason }, editor?, editorFile?, editorFolder?, isDir?, name?, remote?, bundle?, contents? } (isDir: the row is a folder, Open, Open in Preview,
// Open in <editor> and Edit in Terminal are dimmed; editor: the name of the configured GUI editor (label "Open in <editor>", "Open in Editor"
// without a name; ui/menu.js cuts a long one), editorFile false: it has no remote template, the row entry is dimmed on a machine, editorFolder
// false: no remote_folder, the free-area entry is dimmed on a machine; name: the file name, an archive (lib/archives.js) gets Extract Here and Extract to "<name>/"
// below Download, not on a local Windows side; remote: the row is on a machine, Show in Finder is dimmed because it would download first;
// bundle: a local macOS package (lib/bundles.js), a folder that Open starts like the Finder does, with the entry
// Show Package Contents, or Hide Package Contents while contents is true; a folder that is not a package gets Show as Root (issue #90) in its place; windows: this computer is Windows, where Permissions… is
// dimmed because there is no chmod; on a machine it works; size: the text at the right of Calculate Size on a folder
// (lib/sizes.js sizeDetail), sizeTitle: its tooltip (lib/sizes.js sizeNote, set when the sum is incomplete), sizing: that calculation runs, the entry is dimmed; dimmed on local Windows too, no sh there)
// upload (#27): the host offers pickFiles, the entry Upload File… shows (Folder actions and free area only, #112); hideDotfiles: the setting hide_dotfiles (Show Hidden Files unchecked).
// count (>= 2, #99): several rows are selected, the short menu with the actions that apply to all of them.
// Row menus act on the row only (#112): no Upload entries, New Folder… and Paste only on a folder row (they act inside it),
// Download and Download to… only on a machine (on this computer they were only a local copy).
export function rowMenuItems(state) {
  if (state.count >= 2) return multiMenuItems(state);
  const file = state.isDir !== true;
  const local = state.remote !== true;
  const bundle = state.bundle === true && local;
  const archive = file && !(state.windows === true && local) ? archiveOf(state.name) : null;
  return tidy([
    entry("open", "Open", file || bundle),
    entry("open_preview", "Open in Preview", file),
    entry("open_editor", openIn(state.editor), file && state.editorFile !== false),
    entry("edit_terminal", "Edit in Terminal", file),
    entry("reveal", "Show in Finder", local),
    ...(bundle ? [entry("package_contents", state.contents === true ? "Hide Package Contents" : "Show Package Contents")] : []),
    ...(file || bundle ? [] : [entry("show_as_root", "Show as Root")]),
    ...(file ? [] : [{ ...entry("calculate_size", "Calculate Size", state.sizing !== true && (state.windows !== true || !local)), detail: state.size ?? null, title: state.sizeTitle ?? null }]),
    ...(state.selecting === true ? [] : [entry("select_files", "Select Files")]),
    SEPARATOR,
    ...downloadEntries(state, ""),
    ...transferEntries(state),
    SEPARATOR,
    ...(archive ? [entry("extract_here", "Extract Here"), entry("extract_to", extractToLabel(archive.stem)), SEPARATOR] : []),
    entry("copy", "Copy"),
    entry("cut", "Cut"),
    ...(file ? [] : [entry("paste", "Paste", state.paste.enabled)]),
    SEPARATOR,
    entry("copy_path", "Copy Path"),
    entry("copy_relative_path", "Copy Relative Path"),
    SEPARATOR,
    ...(file ? [] : [entry("new_folder", "New Folder…")]),
    entry("rename", "Rename…"),
    entry("permissions", "Permissions…", state.windows !== true || !local),
    entry("delete", "Delete…"),
  ]);
}

// Download and Download to… for one row (n "") or several (n: the grouped count), only on a machine.
const downloadEntries = (state, n) => (state.remote === true
  ? [entry("download", n ? `Download ${n} Items` : "Download"), entry("download_to", n ? `Download ${n} Items to…` : "Download to…")] : []);

// No separator at the start or end, and none twice in a row: groups that lost all their entries leave no gap.
const tidy = (items) => items.filter((i, k, all) => !i.separator || (k > 0 && k < all.length - 1 && !all[k + 1].separator));

// Between the trees (#111): uploadTo names the upper tree's machine (shown in the lower tree), downloadHere: the lower tree is shown (upper machine tree).
const transferEntries = (state) => [
  ...(typeof state.uploadTo === "string" && state.uploadTo ? [entry("upload_to", `Upload to ${state.uploadTo}`)] : []),
  ...(state.downloadHere === true ? [entry("download_here", "Download to This Mac")] : []),
];

// What a tree's menus show of the transfers: Upload File… and Upload Folder… only on a machine tree (a local copy was confusing;
// since #112 only in the Folder actions and free-area menus),
// Upload to <machine> in the lower tree while the upper one shows a machine, Download to This Mac in a machine tree while the lower one is shown.
export function transferState({ machine, pickFiles, peerMachine, lowerShown }) {
  return { upload: Boolean(machine) && pickFiles === true, uploadFolder: Boolean(machine), uploadTo: !machine && peerMachine ? peerMachine : null, downloadHere: Boolean(machine) && lowerShown === true };
}

function multiMenuItems(state) {
  const n = group(state.count);
  return tidy([
    ...downloadEntries(state, n),
    ...transferEntries(state),
    SEPARATOR,
    entry("copy", `Copy ${n} Items`),
    entry("cut", `Cut ${n} Items`),
    entry("paste", "Paste", state.paste.enabled),
    SEPARATOR,
    entry("copy_path", `Copy ${n} Paths`),
    SEPARATOR,
    entry("delete", `Delete ${n} Items…`),
    SEPARATOR,
    entry("clear_selection", "Clear Selection"),
  ]);
}

// The row's part of that state, built the same way where the popup is sized (the row's right click in main.js) and where
// it is drawn (the popup copy): sized from a state without remote and windows, a local Windows archive row left an
// empty strip where Extract Here and Extract to are not shown (follow-up to #68).
export function rowMenuState({ name, isDir, machine, platform, bundle, contents, selecting, count }) {
  return { count: Number.isInteger(count) && count >= 2 ? count : 1, isDir: isDir === true, name: typeof name === "string" ? name : "", remote: Boolean(machine), windows: platform === "windows", bundle: bundle === true, contents: contents === true, selecting: selecting === true };
}

// The menu for the folder a tree shows (#112): the Folder actions button of its location line and a right click in the free
// area. Show in Finder only on this computer; Show Hidden Files (checked while hide_dotfiles is off) flips that setting.
export function rootMenuItems(state) {
  return tidy([
    ...(state.upload === true ? [entry("upload", "Upload File…")] : []), ...(state.uploadFolder === true ? [entry("upload_folder", "Upload Folder…")] : []), SEPARATOR,
    entry("new_folder", "New Folder…"), entry("paste", "Paste", state.paste.enabled), SEPARATOR,
    ...(state.remote === true ? [] : [entry("reveal", "Show in Finder")]), entry("open_editor", openIn(state.editor), state.editorFolder !== false),
    ...(state.selecting === true ? [] : [entry("select_files", "Select Files")]), SEPARATOR,
    { ...entry("toggle_hidden", "Show Hidden Files"), checked: state.hideDotfiles !== true },
  ]);
}

export function menuHeight(items) {
  return items.reduce((h, i) => h + (i.separator ? SEPARATOR_H : ITEM_H), PADDING + RESERVE);
}
