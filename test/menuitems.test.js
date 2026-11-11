import { test } from "node:test";
import assert from "node:assert/strict";
import { rowMenuItems, rootMenuItems, menuHeight, MENU_WIDTH } from "../mods/filer-pro/lib/menuitems.js";
const on = { paste: { enabled: true, reason: null } }, off = { paste: { enabled: false, reason: "Nothing to paste" } };
test("row menu lists sixteen entries in five groups, Open first and Delete last", () => {
  const items = rowMenuItems(on);
  assert.deepEqual(items.filter((i) => !i.separator).map((i) => i.label), [
    "Open", "Open in Preview", "Open in Editor", "Edit in Terminal", "Show in Finder", "Download", "Download to…", "Copy", "Cut", "Paste",
    "Copy Path", "Copy Relative Path", "New Folder…", "Rename…", "Permissions…", "Delete…",
  ]);
  assert.deepEqual(items.map((i) => (i.separator ? "|" : i.action)), [
    "open", "open_preview", "open_editor", "edit_terminal", "reveal", "|", "download", "download_to", "|", "copy", "cut", "paste", "|",
    "copy_path", "copy_relative_path", "|", "new_folder", "rename", "permissions", "delete",
  ]);
  assert.equal(items.find((i) => i.action === "open_preview").id, "filer-pro-menu-open-preview");
  assert.equal(items.find((i) => i.action === "copy_relative_path").id, "filer-pro-menu-copy-relative-path");
  assert.equal(items.find((i) => i.action === "cut").id, "filer-pro-menu-cut");
  assert.equal(items.find((i) => i.action === "open_editor").id, "filer-pro-menu-open-editor");
  assert.equal(items.find((i) => i.action === "edit_terminal").id, "filer-pro-menu-edit-terminal");
  assert.ok(items.filter((i) => !i.separator).every((i) => i.enabled === true));
});
test("root menu: Open in <editor> in its own group on top, then New Folder… and Paste, then Settings…", () => {
  const map = (items) => items.map((i) => (i.separator ? "|" : [i.id, i.label, i.action, i.enabled]));
  assert.deepEqual(map(rootMenuItems({ ...on, editor: "VS Code" })), [
    ["filer-pro-menu-open-editor", "Open in VS Code", "open_editor", true], "|",
    ["filer-pro-menu-new-folder", "New Folder…", "new_folder", true], ["filer-pro-menu-paste", "Paste", "paste", true], "|",
    ["filer-pro-menu-settings", "Settings…", "settings", true],
  ]);
  const dim = map(rootMenuItems({ ...on, editor: "VS Code", editorFolder: false }));
  assert.equal(dim[0][3], false);
  assert.deepEqual(dim.slice(1), map(rootMenuItems({ ...on, editor: "VS Code" })).slice(1));
});
test("the row entry names the configured editor", () => {
  const e = (state) => rowMenuItems(state)[2];
  assert.deepEqual([e({ ...on, editor: "VS Code" }).id, e({ ...on, editor: "VS Code" }).label], ["filer-pro-menu-open-editor", "Open in VS Code"]);
  assert.equal(e({ ...on, editor: "Sublime Text Development Build" }).label, "Open in Sublime Text Development Build");
  assert.equal(e(on).label, "Open in Editor");
});
test("Open in <editor> is dimmed when the editor cannot open the file there", () => {
  const e = (state) => rowMenuItems(state)[2].enabled;
  assert.equal(e({ ...on, editorFile: false }), false);
  assert.equal(e({ ...on, editorFile: true }), true);
  assert.equal(e(on), true);
  for (const editorFile of [false, true, undefined]) assert.equal(e({ ...on, isDir: true, editorFile }), false);
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
  assert.equal(menuHeight(rowMenuItems({ ...on, remote: true })), 488);
});
test("menu height matches the item count", () => {
  assert.equal(menuHeight(rowMenuItems(on)), 488);
  assert.equal(menuHeight(rowMenuItems({ ...on, isDir: true })), 544, "a folder has Calculate Size (issue #58) and Show as Root (issue #90)");
  assert.equal(menuHeight(rootMenuItems(on)), 138);
  assert.equal(menuHeight(rootMenuItems({ ...on, editorFolder: false })), 138);
  assert.equal(menuHeight(rowMenuItems({ ...on, editorFile: false })), 488);
  assert.equal(MENU_WIDTH, 200);
});

test("Permissions… sits between Rename… and Delete…, for files and folders, local and remote", () => {
  for (const state of [on, { ...on, isDir: true }, { ...on, remote: true }, { ...on, isDir: true, remote: true }, { ...on, isDir: true, bundle: true }]) {
    const items = rowMenuItems(state).filter((i) => !i.separator);
    const i = items.findIndex((x) => x.action === "permissions");
    assert.deepEqual(items.slice(i - 1, i + 2).map((x) => x.action), ["rename", "permissions", "delete"]);
    assert.equal(items[i].id, "filer-pro-menu-permissions");
    assert.equal(items[i].enabled, true);
  }
});

test("Permissions… is dimmed on this computer when it is Windows (no chmod there), not on a machine", () => {
  const enabled = (state) => rowMenuItems(state).find((i) => i.action === "permissions").enabled;
  assert.equal(enabled({ ...on, windows: true }), false);
  assert.equal(enabled({ ...on, windows: true, remote: true }), true);
  assert.equal(enabled({ ...on, windows: false }), true);
  assert.equal(menuHeight(rowMenuItems({ ...on, windows: true })), 488, "the height does not depend on it");
});

// Issue #58: Calculate Size on folders (packages too), with the result at the right of the entry.
test("Calculate Size is in the first group for folders and packages only, with its detail", () => {
  const folder = rowMenuItems({ ...on, isDir: true });
  assert.deepEqual(folder.slice(0, 8).map((i) => (i.separator ? "|" : i.action)), ["open", "open_preview", "open_editor", "edit_terminal", "reveal", "show_as_root", "calculate_size", "|"]);
  const calc = folder.find((i) => i.action === "calculate_size");
  assert.deepEqual([calc.id, calc.label, calc.enabled, calc.detail], ["filer-pro-menu-calculate-size", "Calculate Size", true, null]);
  assert.equal(rowMenuItems(on).some((i) => i.action === "calculate_size"), false, "not on a file");
  const pkg = rowMenuItems({ ...on, isDir: true, bundle: true });
  assert.deepEqual(pkg.slice(5, 7).map((i) => i.action), ["package_contents", "calculate_size"]);
  assert.equal(rowMenuItems({ ...on, isDir: true, size: "2.4 MB" }).find((i) => i.action === "calculate_size").detail, "2.4 MB");
  assert.equal(calc.title, null, "no tooltip without sizeTitle");
  const inc = rowMenuItems({ ...on, isDir: true, size: "~2.4 MB", sizeTitle: "Some folders could not be read" }).find((i) => i.action === "calculate_size");
  assert.deepEqual([inc.detail, inc.title], ["~2.4 MB", "Some folders could not be read"]);
  const running = rowMenuItems({ ...on, isDir: true, size: "…", sizing: true }).find((i) => i.action === "calculate_size");
  assert.deepEqual([running.enabled, running.detail], [false, "…"], "dimmed while it runs");
  assert.equal(rowMenuItems({ ...on, isDir: true, windows: true }).find((i) => i.action === "calculate_size").enabled, false, "no sh on local Windows");
  assert.equal(rowMenuItems({ ...on, isDir: true, windows: true, remote: true }).find((i) => i.action === "calculate_size").enabled, true);
});

// #57: Extract Here and Extract to "<name>/" for an archive file, their own group right after Download / Download to…
const seq = (items) => items.map((i) => (i.separator ? "|" : i.action));
const AFTER_DOWNLOAD = ["download", "download_to", "|", "extract_here", "extract_to", "|", "copy"];
test("extract entries: an archive gets its own group between Download and Copy, locally and on a machine", () => {
  for (const remote of [false, true]) {
    const items = rowMenuItems({ ...on, isDir: false, name: "photos.tar.gz", remote });
    const s = seq(items), i = s.indexOf("download");
    assert.deepEqual(s.slice(i, i + AFTER_DOWNLOAD.length), AFTER_DOWNLOAD);
    assert.equal(items.find((e) => e.action === "extract_here").label, "Extract Here");
    assert.equal(items.find((e) => e.action === "extract_to").label, 'Extract to "photos/"');
    assert.equal(items.find((e) => e.action === "extract_here").id, "filer-pro-menu-extract-here");
    assert.equal(items.find((e) => e.action === "extract_to").id, "filer-pro-menu-extract-to");
    assert.ok(items.filter((e) => e.action?.startsWith("extract")).every((e) => e.enabled === true));
  }
});
test("extract entries: not for a folder, a non-archive, no name or the local Windows side; a machine on Windows still gets them", () => {
  const has = (state) => seq(rowMenuItems({ ...on, ...state })).includes("extract_here");
  assert.equal(has({ isDir: true, name: "photos.zip" }), false);
  assert.equal(has({ isDir: false, name: "photos.txt" }), false);
  assert.equal(has({ isDir: false, name: "photos.gz.txt" }), false);
  assert.equal(has({ isDir: false }), false);
  assert.equal(has({ isDir: false, name: "a.zip", windows: true }), false);
  assert.equal(has({ isDir: false, name: "a.zip", windows: true, remote: true }), true);
  assert.equal(has({ isDir: false, name: "a.zip", windows: false }), true);
});
test("extract entries: the label cuts a long stem so it fits", () => {
  const label = (name) => rowMenuItems({ ...on, isDir: false, name }).find((e) => e.action === "extract_to").label;
  assert.equal(label("0123456789.zip"), 'Extract to "0123456789/"');
  assert.equal(label("photos-2024-07-camera.tar.xz"), 'Extract to "photos-20…/"');
});
test("extract entries: menuHeight counts two entries and one separator more", () => {
  const plain = menuHeight(rowMenuItems({ ...on, isDir: false, name: "a.txt" }));
  const arch = menuHeight(rowMenuItems({ ...on, isDir: false, name: "a.zip" }));
  assert.equal(arch - plain, 2 * 28 + 7);
});
