// Entries of the two right-click menus (row and free area). Pure: mods/filer-pro/ui/menu.js only draws them.
import { archiveOf, extractToLabel } from "./archives.js";
export const MENU_WIDTH = 200;
const ITEM_H = 28, SEPARATOR_H = 7, PADDING = 8, RESERVE = 4;

const SEPARATOR = { separator: true };
const entry = (action, label, enabled = true) => ({ id: `filer-pro-menu-${action.replace(/_/g, "-")}`, label, action, enabled });

// state: { paste: { enabled, reason }, isDir?, name?, remote?, bundle?, contents? } (isDir: the row is a folder, Open, Open in Preview,
// Open in Editor and Edit in Terminal are dimmed; name: the file name, an archive (lib/archives.js) gets Extract Here and Extract to "<name>/"
// below Download, not on a local Windows side; remote: the row is on a machine, Show in Finder is dimmed because it would download first;
// bundle: a local macOS package (lib/bundles.js), a folder that Open starts like the Finder does, with the entry
// Show Package Contents, or Hide Package Contents while contents is true; windows: this computer is Windows, where Permissions… is
// dimmed because there is no chmod; on a machine it works; size: the text at the right of Calculate Size on a folder
// (lib/sizes.js sizeDetail), sizeTitle: its tooltip (lib/sizes.js sizeNote, set when the sum is incomplete), sizing: that calculation runs, the entry is dimmed; dimmed on local Windows too, no sh there)
export function rowMenuItems(state) {
  const file = state.isDir !== true;
  const local = state.remote !== true;
  const bundle = state.bundle === true && local;
  const archive = file && !(state.windows === true && local) ? archiveOf(state.name) : null;
  return [
    entry("open", "Open", file || bundle),
    entry("open_preview", "Open in Preview", file),
    entry("open_editor", "Open in Editor", file),
    entry("edit_terminal", "Edit in Terminal", file),
    entry("reveal", "Show in Finder", local),
    ...(bundle ? [entry("package_contents", state.contents === true ? "Hide Package Contents" : "Show Package Contents")] : []),
    ...(file ? [] : [{ ...entry("calculate_size", "Calculate Size", state.sizing !== true && (state.windows !== true || !local)), detail: state.size ?? null, title: state.sizeTitle ?? null }]),
    SEPARATOR,
    entry("download", "Download"),
    entry("download_to", "Download to…"),
    SEPARATOR,
    ...(archive ? [entry("extract_here", "Extract Here"), entry("extract_to", extractToLabel(archive.stem)), SEPARATOR] : []),
    entry("copy", "Copy"),
    entry("cut", "Cut"),
    entry("paste", "Paste", state.paste.enabled),
    SEPARATOR,
    entry("copy_path", "Copy Path"),
    entry("copy_relative_path", "Copy Relative Path"),
    SEPARATOR,
    entry("new_folder", "New Folder…"),
    entry("rename", "Rename…"),
    entry("permissions", "Permissions…", state.windows !== true || !local),
    entry("delete", "Delete…"),
  ];
}

// The row's part of that state, built the same way where the popup is sized (the row's right click in main.js) and where
// it is drawn (the popup copy): sized from a state without remote and windows, a local Windows archive row left an
// empty strip where Extract Here and Extract to are not shown (follow-up to #68).
export function rowMenuState({ name, isDir, machine, platform, bundle, contents }) {
  return { isDir: isDir === true, name: typeof name === "string" ? name : "", remote: Boolean(machine), windows: platform === "windows", bundle: bundle === true, contents: contents === true };
}

export function rootMenuItems(state) {
  return [entry("new_folder", "New Folder…"), entry("paste", "Paste", state.paste.enabled), SEPARATOR, entry("settings", "Settings…")];
}

export function menuHeight(items) {
  return items.reduce((h, i) => h + (i.separator ? SEPARATOR_H : ITEM_H), PADDING + RESERVE);
}
