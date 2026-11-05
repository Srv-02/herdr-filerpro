// Entries of the two right-click menus (row and free area). Pure: mods/filer-pro/ui/menu.js only draws them.
export const MENU_WIDTH = 200;
const ITEM_H = 28, SEPARATOR_H = 7, PADDING = 8, RESERVE = 4;

const SEPARATOR = { separator: true };
const entry = (action, label, enabled = true) => ({ id: `filer-pro-menu-${action.replace(/_/g, "-")}`, label, action, enabled });

// state: { paste: { enabled, reason }, isDir?, remote? } (isDir: the row is a folder, Open, Open in Preview,
// Open in Editor and Edit in Terminal are dimmed; remote: the row is on a machine, Show in Finder is dimmed because it would download first)
export function rowMenuItems(state) {
  const file = state.isDir !== true;
  const local = state.remote !== true;
  return [
    entry("open", "Open", file),
    entry("open_preview", "Open in Preview", file),
    entry("open_editor", "Open in Editor", file),
    entry("edit_terminal", "Edit in Terminal", file),
    entry("reveal", "Show in Finder", local),
    SEPARATOR,
    entry("download", "Download"),
    entry("download_to", "Download to…"),
    SEPARATOR,
    entry("copy", "Copy"),
    entry("cut", "Cut"),
    entry("paste", "Paste", state.paste.enabled),
    SEPARATOR,
    entry("copy_path", "Copy Path"),
    entry("copy_relative_path", "Copy Relative Path"),
    SEPARATOR,
    entry("new_folder", "New Folder…"),
    entry("rename", "Rename…"),
    entry("delete", "Delete…"),
  ];
}

export function rootMenuItems(state) {
  return [entry("new_folder", "New Folder…"), entry("paste", "Paste", state.paste.enabled)];
}

export function menuHeight(items) {
  return items.reduce((h, i) => h + (i.separator ? SEPARATOR_H : ITEM_H), PADDING + RESERVE);
}
