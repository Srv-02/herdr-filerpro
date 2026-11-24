import { test } from "node:test";
import assert from "node:assert/strict";
import { rowMenuItems, rowMenuState, rootMenuItems, menuHeight, MENU_WIDTH } from "../mods/filer-pro/lib/menuitems.js";
const on = { paste: { enabled: true, reason: null } }, off = { paste: { enabled: false, reason: "Nothing to paste" } };
test("row menu of a file on a machine lists fifteen entries in five groups, Open first and Delete last", () => {
  const items = rowMenuItems({ ...on, remote: true });
  assert.deepEqual(items.filter((i) => !i.separator).map((i) => i.label), [
    "Open", "Open in Preview", "Open in Editor", "Edit in Terminal", "Show in Finder", "Select Files", "Download", "Download to…", "Copy", "Cut",
    "Copy Path", "Copy Relative Path", "Rename…", "Permissions…", "Delete…",
  ]);
  assert.deepEqual(items.map((i) => (i.separator ? "|" : i.action)), [
    "open", "open_preview", "open_editor", "edit_terminal", "reveal", "select_files", "|", "download", "download_to", "|", "copy", "cut", "|",
    "copy_path", "copy_relative_path", "|", "rename", "permissions", "delete",
  ]);
  assert.equal(items.find((i) => i.action === "open_preview").id, "filer-pro-menu-open-preview");
  assert.equal(items.find((i) => i.action === "copy_relative_path").id, "filer-pro-menu-copy-relative-path");
  assert.equal(items.find((i) => i.action === "cut").id, "filer-pro-menu-cut");
  assert.equal(items.find((i) => i.action === "open_editor").id, "filer-pro-menu-open-editor");
  assert.equal(items.find((i) => i.action === "edit_terminal").id, "filer-pro-menu-edit-terminal");
  assert.ok(items.filter((i) => !i.separator && i.action !== "reveal").every((i) => i.enabled === true));
});
test("#112 folder menu: New Folder… and Paste, then Show in Finder (local), Open in <editor> and Select Files, then Show Hidden Files; no Settings…", () => {
  const map = (items) => items.map((i) => (i.separator ? "|" : [i.id, i.label, i.action, i.enabled]));
  assert.deepEqual(map(rootMenuItems({ ...on, editor: "VS Code" })), [
    ["filer-pro-menu-new-folder", "New Folder…", "new_folder", true], ["filer-pro-menu-paste", "Paste", "paste", true], "|",
    ["filer-pro-menu-reveal", "Show in Finder", "reveal", true],
    ["filer-pro-menu-open-editor", "Open in VS Code", "open_editor", true],
    ["filer-pro-menu-select-files", "Select Files", "select_files", true], "|",
    ["filer-pro-menu-toggle-hidden", "Show Hidden Files", "toggle_hidden", true],
  ]);
  const dim = map(rootMenuItems({ ...on, editor: "VS Code", editorFolder: false }));
  assert.equal(dim[4][3], false);
  assert.equal(rootMenuItems({ ...on, remote: true }).some((i) => i.action === "reveal"), false, "no Show in Finder on a machine");
  assert.equal(rootMenuItems(on).some((i) => i.action === "settings"), false);
});

test("#112 Show Hidden Files is checked while hide_dotfiles is off", () => {
  const hidden = (state) => rootMenuItems({ ...on, ...state }).find((i) => i.action === "toggle_hidden");
  assert.equal(hidden({}).checked, true);
  assert.equal(hidden({ hideDotfiles: false }).checked, true);
  assert.equal(hidden({ hideDotfiles: true }).checked, false);
  assert.equal(rowMenuItems(on).some((i) => "checked" in i), false, "row entries are not checkable");
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
  assert.equal(rowMenuItems({ ...off, isDir: true }).find((i) => i.action === "paste").enabled, false);
  assert.equal(rowMenuItems(off).find((i) => i.action === "cut").enabled, true);
});
test("Open, Open in Preview, Open in Editor and Edit in Terminal are dimmed for a folder, Show in Finder and Copy Path stay enabled", () => {
  const dir = rowMenuItems({ ...on, isDir: true }), file = rowMenuItems({ ...on, isDir: false });
  const enabled = (items, action) => items.find((i) => i.action === action).enabled;
  for (const a of ["open", "open_preview", "open_editor", "edit_terminal"]) {
    assert.equal(enabled(dir, a), false);
    assert.equal(enabled(file, a), true);
  }
  for (const a of ["reveal", "copy_path", "copy_relative_path", "delete"]) assert.equal(enabled(dir, a), true);
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
test("menu height matches the item count (#112: file and folder, machine and local, single and several)", () => {
  assert.equal(menuHeight(rowMenuItems(on)), 397);
  assert.equal(menuHeight(rowMenuItems({ ...on, remote: true })), 460);
  assert.equal(menuHeight(rowMenuItems({ ...on, isDir: true })), 509, "a folder has Calculate Size (issue #58), Show as Root (issue #90), Paste and New Folder…");
  assert.equal(menuHeight(rowMenuItems({ ...on, isDir: true, remote: true })), 572);
  assert.equal(menuHeight(rowMenuItems({ ...on, count: 3 })), 201);
  assert.equal(menuHeight(rowMenuItems({ ...on, count: 3, remote: true })), 264);
  assert.equal(menuHeight(rootMenuItems(on)), 194);
  assert.equal(menuHeight(rootMenuItems({ ...on, remote: true })), 166);
  assert.equal(menuHeight(rootMenuItems({ ...on, remote: true, upload: true, uploadFolder: true })), 229);
  assert.equal(menuHeight(rootMenuItems({ ...on, editorFolder: false })), 194);
  assert.equal(menuHeight(rowMenuItems({ ...on, editorFile: false })), 397);
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
  assert.equal(menuHeight(rowMenuItems({ ...on, windows: true })), 397, "the height does not depend on it");
});

// Issue #58: Calculate Size on folders (packages too), with the result at the right of the entry.
test("Calculate Size is in the first group for folders and packages only, with its detail", () => {
  const folder = rowMenuItems({ ...on, isDir: true });
  assert.deepEqual(folder.slice(0, 8).map((i) => (i.separator ? "|" : i.action)), ["open", "open_preview", "open_editor", "edit_terminal", "reveal", "show_as_root", "calculate_size", "select_files"]);
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
    const want = remote ? AFTER_DOWNLOAD : AFTER_DOWNLOAD.slice(2), s = seq(items), i = remote ? s.indexOf("download") : s.indexOf("extract_here") - 1;
    assert.deepEqual(s.slice(i, i + want.length), want);
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

test("Select Files closes the first group of the row menu and follows Paste in the free area menu", () => {
  const actions = (items) => items.map((i) => (i.separator ? "|" : i.action));
  const folder = actions(rowMenuItems({ ...on, isDir: true }));
  assert.equal(folder[folder.indexOf("calculate_size") + 1], "select_files");
  assert.equal(folder[folder.indexOf("select_files") + 1], "|");
  const pkg = actions(rowMenuItems({ ...on, isDir: true, bundle: true }));
  assert.equal(pkg[pkg.indexOf("calculate_size") + 1], "select_files");
  assert.deepEqual(actions(rootMenuItems(on)), ["new_folder", "paste", "|", "reveal", "open_editor", "select_files", "|", "toggle_hidden"]);
  assert.equal(rowMenuItems(on).find((i) => i.action === "select_files").id, "filer-pro-menu-select-files");
  assert.equal(rowMenuItems(on).find((i) => i.action === "select_files").enabled, true);
});

test("no Select Files entry while the mode is on, and the menus shrink by one row", () => {
  for (const [items, off2] of [[rowMenuItems, {}], [rowMenuItems, { isDir: true }], [rootMenuItems, {}]]) {
    const with_ = items({ ...on, ...off2 }), without = items({ ...on, ...off2, selecting: true });
    assert.equal(without.some((i) => i.action === "select_files"), false);
    assert.equal(menuHeight(with_) - menuHeight(without), 28);
  }
  assert.equal(rowMenuState({ name: "a", selecting: true }).selecting, true);
  assert.equal(rowMenuState({ name: "a" }).selecting, false);
});
test("#99 several rows: the short menu with eight entries, labels carry the count", () => {
  const items = rowMenuItems({ ...on, count: 3, remote: true });
  assert.deepEqual(items.map((i) => (i.separator ? "|" : i.action)), [
    "download", "download_to", "|", "copy", "cut", "paste", "|", "copy_path", "|", "delete", "|", "clear_selection",
  ]);
  assert.deepEqual(items.filter((i) => !i.separator).map((i) => i.label), [
    "Download 3 Items", "Download 3 Items to…", "Copy 3 Items", "Cut 3 Items", "Paste", "Copy 3 Paths", "Delete 3 Items…", "Clear Selection",
  ]);
  assert.equal(items.at(-1).id, "filer-pro-menu-clear-selection");
  assert.equal(menuHeight(items), 264);
  assert.equal(rowMenuItems({ ...off, count: 3 }).find((i) => i.action === "paste").enabled, false);
  assert.equal(rowMenuItems({ ...on, count: 3 }).find((i) => i.action === "paste").enabled, true);
});
test("#99 a count of one or none gives today's menu; thousands are grouped", () => {
  assert.deepEqual(rowMenuItems({ ...on, count: 1 }), rowMenuItems(on));
  assert.equal(menuHeight(rowMenuItems({ ...on, count: 1 })), 397);
  assert.equal(rowMenuItems({ ...on, count: 1234, remote: true })[0].label, "Download 1,234 Items");
  assert.equal(rowMenuState({ name: "a", count: 3 }).count, 3);
  assert.equal(rowMenuState({ name: "a" }).count, 1);
  assert.equal(rowMenuState({ name: "a", count: 0 }).count, 1);
});

test("#27 #112 Upload File… only with upload, and only in the folder menu (top), heights", () => {
  const acts = (items) => items.filter((i) => !i.separator).map((i) => i.action);
  assert.equal(acts(rootMenuItems(on)).includes("upload"), false);
  for (const st of [{}, { isDir: true }, { remote: true }, { isDir: true, remote: true }, { count: 2, remote: true }]) {
    const row = acts(rowMenuItems({ ...on, ...st, upload: true, uploadFolder: true }));
    assert.equal(row.includes("upload") || row.includes("upload_folder"), false, JSON.stringify(st));
  }
  const root = rootMenuItems({ ...on, remote: true, upload: true });
  assert.deepEqual(seq(root).slice(0, 3), ["upload", "|", "new_folder"]);
  assert.equal(root[0].label, "Upload File…");
  assert.equal(menuHeight(rootMenuItems({ ...on, remote: true, upload: true })), 166 + 28 + 7);
});

test("#111 #112 Upload to / Download to This Mac after Download to… in the row menus, Upload Folder… in the folder menu", () => {
  const acts = (items) => items.filter((i) => !i.separator).map((i) => i.action);
  const st = { ...on, remote: true, upload: true, uploadFolder: true, downloadHere: true };
  const row = acts(rowMenuItems(st));
  assert.deepEqual(row.slice(row.indexOf("download_to"), row.indexOf("download_to") + 2), ["download_to", "download_here"]);
  assert.equal(rowMenuItems(st).find((i) => i.action === "download_here").label, "Download to This Mac");
  assert.equal(menuHeight(rowMenuItems(st)), 460 + 28);
  const multi = rowMenuItems({ ...st, count: 3 });
  assert.deepEqual(acts(multi).slice(0, 4), ["download", "download_to", "download_here", "copy"]);
  assert.equal(menuHeight(multi), 264 + 28);
  const local = { ...on, uploadTo: "box" };
  assert.deepEqual(seq(rowMenuItems(local)).slice(6, 9), ["|", "upload_to", "|"]);
  assert.equal(rowMenuItems(local).find((i) => i.action === "upload_to").label, "Upload to box");
  assert.deepEqual(seq(rowMenuItems({ ...local, count: 3 })).slice(0, 3), ["upload_to", "|", "copy"]);
  assert.deepEqual(acts(rootMenuItems(st)).slice(0, 3), ["upload", "upload_folder", "new_folder"]);
  assert.equal(rootMenuItems(st).find((i) => i.action === "upload_folder").label, "Upload Folder…");
  const none = acts(rowMenuItems(on));
  for (const a of ["upload_to", "download_here", "upload_folder"]) assert.equal(none.includes(a), false);
});

test("#112 row menus act on the row only: file/folder x machine/local x single/several", () => {
  const has = (state, a) => seq(rowMenuItems({ ...on, ...state })).includes(a);
  for (const remote of [false, true]) {
    for (const a of ["new_folder", "paste", "upload", "upload_folder"]) assert.equal(has({ remote, upload: true, uploadFolder: true }, a), false, `file ${remote} ${a}`);
    assert.equal(has({ remote, isDir: true }, "new_folder"), true);
    assert.equal(has({ remote, isDir: true }, "paste"), true);
    for (const a of ["download", "download_to"]) {
      assert.equal(has({ remote }, a), remote);
      assert.equal(has({ remote, isDir: true }, a), remote);
      assert.equal(has({ remote, count: 3 }, a), remote);
    }
  }
  for (const state of [{}, { isDir: true }, { count: 3 }, { remote: true }, { remote: true, count: 3 }, { name: "a.zip" }]) {
    const s = seq(rowMenuItems({ ...on, ...state }));
    assert.notEqual(s[0], "|"); assert.notEqual(s.at(-1), "|");
    assert.equal(s.some((x, k) => x === "|" && s[k + 1] === "|"), false, JSON.stringify(state));
  }
});
