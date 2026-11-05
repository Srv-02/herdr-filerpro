import { test } from "node:test";
import assert from "node:assert/strict";
import { rowMenuItems, rootMenuItems, menuHeight, MENU_WIDTH } from "../mods/filer-pro/lib/menuitems.js";
const on = { paste: { enabled: true, reason: null } }, off = { paste: { enabled: false, reason: "Nothing to paste" } };
test("row menu lists fifteen entries in five groups, Open first and Delete last", () => {
  const items = rowMenuItems(on);
  assert.deepEqual(items.filter((i) => !i.separator).map((i) => i.label), [
    "Open", "Open in Preview", "Open in Editor", "Edit in Terminal", "Show in Finder", "Download", "Download to…", "Copy", "Cut", "Paste",
    "Copy Path", "Copy Relative Path", "New Folder…", "Rename…", "Delete…",
  ]);
  assert.deepEqual(items.map((i) => (i.separator ? "|" : i.action)), [
    "open", "open_preview", "open_editor", "edit_terminal", "reveal", "|", "download", "download_to", "|", "copy", "cut", "paste", "|",
    "copy_path", "copy_relative_path", "|", "new_folder", "rename", "delete",
  ]);
  assert.equal(items.find((i) => i.action === "open_preview").id, "filer-pro-menu-open-preview");
  assert.equal(items.find((i) => i.action === "copy_relative_path").id, "filer-pro-menu-copy-relative-path");
  assert.equal(items.find((i) => i.action === "cut").id, "filer-pro-menu-cut");
  assert.equal(items.find((i) => i.action === "open_editor").id, "filer-pro-menu-open-editor");
  assert.equal(items.find((i) => i.action === "edit_terminal").id, "filer-pro-menu-edit-terminal");
  assert.ok(items.filter((i) => !i.separator).every((i) => i.enabled === true));
});
test("root menu has New Folder and Paste only", () => {
  assert.deepEqual(rootMenuItems(on).map((i) => [i.id, i.label, i.action, i.enabled]), [["filer-pro-menu-new-folder", "New Folder…", "new_folder", true], ["filer-pro-menu-paste", "Paste", "paste", true]]);
});
test("paste in the root menu is dimmed without clipboard", () => {
  assert.equal(rootMenuItems(off).find((i) => i.action === "paste").enabled, false);
  assert.equal(rowMenuItems(off).find((i) => i.action === "paste").enabled, false);
  assert.equal(rowMenuItems(off).find((i) => i.action === "cut").enabled, true);
});
test("Open, Open in Preview, Open in Editor and Edit in Terminal are dimmed for a folder, Show in Finder and Copy Path stay enabled", () => {
  const dir = rowMenuItems({ ...on, isDir: true }), file = rowMenuItems({ ...on, isDir: false });
  const enabled = (items, action) => items.find((i) => i.action === action).enabled;
  for (const a of ["open", "open_preview", "open_editor", "edit_terminal"]) {
    assert.equal(enabled(dir, a), false);
    assert.equal(enabled(file, a), true);
  }
  for (const a of ["reveal", "copy_path", "copy_relative_path", "download", "delete"]) assert.equal(enabled(dir, a), true);
  assert.equal(enabled(file, "open"), true);
  assert.equal(enabled(file, "open_preview"), true);
  assert.equal(enabled(rowMenuItems(on), "open"), true); // isDir absent: a file
});
test("Show in Finder is dimmed on a machine for files and folders, Open and Open in Preview stay as they are", () => {
  const enabled = (items, action) => items.find((i) => i.action === action).enabled;
  for (const isDir of [false, true]) {
    const remote = rowMenuItems({ ...on, isDir, remote: true });
    assert.equal(enabled(remote, "reveal"), false);
    assert.equal(enabled(remote, "open"), !isDir);
    assert.equal(enabled(remote, "open_preview"), !isDir);
    assert.equal(enabled(remote, "open_editor"), !isDir);
    assert.equal(enabled(remote, "edit_terminal"), !isDir);
    for (const a of ["download", "copy_path", "copy_relative_path", "delete"]) assert.equal(enabled(remote, a), true);
    assert.equal(enabled(rowMenuItems({ ...on, isDir, remote: false }), "reveal"), true);
  }
  assert.equal(enabled(rowMenuItems(on), "reveal"), true); // remote absent: local
  assert.equal(menuHeight(rowMenuItems({ ...on, remote: true })), 460);
});
test("menu height matches the item count", () => {
  assert.equal(menuHeight(rowMenuItems(on)), 460);
  assert.equal(menuHeight(rowMenuItems({ ...on, isDir: true })), 460);
  assert.equal(menuHeight(rootMenuItems(on)), 68);
  assert.equal(MENU_WIDTH, 200);
});
