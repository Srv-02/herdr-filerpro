import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../mods/filer-pro/lib/config.js";
import { numbers } from "../mods/filer-pro/lib/settings.js";

const home = () => "/home/u";
const appHome = () => "/home/u/.config/herdr-app";
const reader = (text) => async (p) => (p === "/home/u/.config/herdr-app/filer-pro.json" ? text : null);

test("tilde expands to home", async () => {
  assert.equal((await loadConfig(reader('{"download_folder":"~/x"}'), appHome, home)).download_folder, "/home/u/x");
});
test("absolute path stays", async () => {
  assert.equal((await loadConfig(reader('{"download_folder":"/data/in"}'), appHome, home)).download_folder, "/data/in");
});
test("missing file and broken JSON give the default", async () => {
  assert.equal((await loadConfig(reader(null), appHome, home)).download_folder, "/home/u/Downloads");
  assert.equal((await loadConfig(reader("{nope"), appHome, home)).download_folder, "/home/u/Downloads");
  assert.equal((await loadConfig(reader('{"download_folder":5}'), appHome, home)).download_folder, "/home/u/Downloads");
});
test("reader that rejects gives the default", async () => {
  assert.equal((await loadConfig(async () => { throw new Error("x"); }, appHome, home)).download_folder, "/home/u/Downloads");
});
test("preview, mermaid, perf with defaults and type checks", async () => {
  assert.deepEqual(await loadConfig(reader(null), appHome, home), {
    download_folder: "/home/u/Downloads", preview: true, mermaid: true, perf: false, update_check: true,
    terminal_editor: "vi", terminal_editors: [], gui_editor: "VS Code", gui_editors: [],
    node_path: "", svg_check: true, hide_system_files: true, hide_dotfiles: false, double_click_files: false, double_click_apps: true, extract_space_check: true, ...numbers(null), warn_cross_copy: true, show_sizes: true,
  });
  const c = await loadConfig(reader('{"preview":false,"mermaid":"no","perf":true}'), appHome, home);
  assert.deepEqual([c.preview, c.mermaid, c.perf], [false, true, true]);
});
test("a broken file leaves the switches at the default", async () => {
  const c = await loadConfig(reader("{nope"), appHome, home);
  assert.deepEqual([c.preview, c.mermaid, c.perf], [true, true, false]);
});

const load = (obj) => loadConfig(reader(JSON.stringify(obj)), appHome, home);

test("editor choices: shipped names are kept, unknown names and wrong types fall back to vi and VS Code", async () => {
  let c = await load({ terminal_editor: "helix", gui_editor: "Zed" });
  assert.deepEqual([c.terminal_editor, c.gui_editor], ["helix", "Zed"]);
  c = await load({ terminal_editor: "emacs", gui_editor: "Notepad" });
  assert.deepEqual([c.terminal_editor, c.gui_editor], ["vi", "VS Code"]);
  c = await load({ terminal_editor: 3, gui_editor: null, terminal_editors: "nvim", gui_editors: {} });
  assert.deepEqual([c.terminal_editor, c.gui_editor, c.terminal_editors, c.gui_editors], ["vi", "VS Code", [], []]);
  c = await load({ terminal_editor: " vim ", gui_editor: " Cursor " });
  assert.deepEqual([c.terminal_editor, c.gui_editor], ["vim", "Cursor"]);
});

test("custom terminal editors: valid entries kept (trimmed), broken ones dropped one by one, first name wins", async () => {
  const c = await load({
    terminal_editor: "nvim",
    terminal_editors: [
      { name: " nvim ", command: "nvim -u NONE" }, { name: "nvim", command: "other" }, { name: "", command: "x" },
      { name: "nocmd" }, { name: "blank", command: "  " }, { name: "quote", command: "ed 'x" }, "vi", null, { name: 5, command: "x" },
      { name: "vim", command: "vim -Nu NONE" },
    ],
  });
  assert.deepEqual(c.terminal_editors, [{ name: "nvim", command: "nvim -u NONE" }, { name: "vim", command: "vim -Nu NONE" }]);
  assert.equal(c.terminal_editor, "nvim");
});

test("custom GUI editors: local is required and must not use {target}, a broken remote becomes null", async () => {
  const c = await load({
    gui_editor: "Mine",
    gui_editors: [
      { name: "Mine", local: "myed {path}", remote: "myed --ssh {target} {path}" },
      { name: "LocalOnly", local: "lo {path}" },
      { name: "BadRemote", local: "br {path}", remote: "br 'x" },
      { name: "NoLocal", remote: "x {target}" },
      { name: "TargetLocal", local: "x {target} {path}" },
      { name: "", local: "x" },
    ],
  });
  assert.deepEqual(c.gui_editors, [
    { name: "Mine", local: "myed {path}", remote: "myed --ssh {target} {path}", remote_folder: null },
    { name: "LocalOnly", local: "lo {path}", remote: null, remote_folder: null },
    { name: "BadRemote", local: "br {path}", remote: null, remote_folder: null },
  ]);
  assert.equal(c.gui_editor, "Mine");
  assert.equal((await load({ gui_editor: "NoLocal", gui_editors: [{ name: "NoLocal", remote: "x" }] })).gui_editor, "VS Code");
});

test("templates without the file are dropped: a GUI template needs {path} or {path_uri}, a terminal command must not use {path}", async () => {
  const c = await load({
    terminal_editors: [{ name: "twice", command: "nvim {path}" }, { name: "ok", command: "nvim" }],
    gui_editors: [
      { name: "NoPath", local: "myed --new" },
      { name: "RemoteNoPath", local: "r {path}", remote: "r --ssh {target}" },
      { name: "Uri", local: "u file://{path_uri}", remote: "u ssh://{target}{path_uri}" },
    ],
  });
  assert.deepEqual(c.terminal_editors, [{ name: "ok", command: "nvim" }]);
  assert.deepEqual(c.gui_editors, [
    { name: "RemoteNoPath", local: "r {path}", remote: null, remote_folder: null },
    { name: "Uri", local: "u file://{path_uri}", remote: "u ssh://{target}{path_uri}", remote_folder: null },
  ]);
});

test("custom GUI editors: remote_folder is optional, trimmed, and a broken one becomes null alone", async () => {
  const c = await load({
    gui_editors: [
      { name: "Ok", local: "o {path}", remote: "o --ssh {target} {path}", remote_folder: " myed --ssh {target} --dir {path} " },
      { name: "Missing", local: "m {path}", remote: "m {target} {path}" },
      { name: "WrongType", local: "w {path}", remote: "w {target} {path}", remote_folder: 5 },
      { name: "Quote", local: "q {path}", remote: "q {target} {path}", remote_folder: "q 'x" },
      { name: "NoPath", local: "n {path}", remote: "n {target} {path}", remote_folder: "n --ssh {target}" },
    ],
  });
  assert.deepEqual(c.gui_editors.map((e) => [e.name, e.remote !== null, e.remote_folder]), [
    ["Ok", true, "myed --ssh {target} --dir {path}"], ["Missing", true, null], ["WrongType", true, null], ["Quote", true, null], ["NoPath", true, null],
  ]);
});

test("update_check is on by default and off only with false", async () => {
  assert.equal((await loadConfig(reader(null), appHome, home)).update_check, true);
  assert.equal((await loadConfig(reader("{nope"), appHome, home)).update_check, true);
  assert.equal((await loadConfig(reader('{"update_check":"no"}'), appHome, home)).update_check, true);
  assert.equal((await loadConfig(reader('{"update_check":false}'), appHome, home)).update_check, false);
});

test("settings dialog keys: numbers clamped or defaulted, node_path absolute or automatic, svg_check off only with false", async () => {
  let c = await load({ list_per_folder: 20000, tree_depth: "7", node_path: "/opt/n/node", svg_check: false });
  assert.deepEqual([c.list_per_folder, c.tree_depth, c.node_path, c.svg_check], [10000, 40, "/opt/n/node", false]);
  c = await load({ node_path: "node", svg_check: "no" });
  assert.deepEqual([c.node_path, c.svg_check], ["", true]);
  c = await load({ node_path: "  /usr/bin/node  " });
  assert.equal(c.node_path, "/usr/bin/node");
  c = await loadConfig(reader("{nope"), appHome, home);
  assert.deepEqual([c.list_total, c.svg_check, c.node_path], [5000, true, ""]);
});

test("hide_system_files is on and hide_dotfiles off by default; each changes only with a boolean (issue #17)", async () => {
  for (const text of [null, "{nope", '{"hide_system_files":"no","hide_dotfiles":1}']) {
    const c = await loadConfig(reader(text), appHome, home);
    assert.deepEqual([c.hide_system_files, c.hide_dotfiles], [true, false], String(text));
  }
  const c = await loadConfig(reader('{"hide_system_files":false,"hide_dotfiles":true}'), appHome, home);
  assert.deepEqual([c.hide_system_files, c.hide_dotfiles], [false, true]);
});

test("double_click_files is off and double_click_apps on by default; each changes only with a boolean (issue #21)", async () => {
  for (const text of [null, "{nope", '{"double_click_files":"yes","double_click_apps":0}']) {
    const c = await loadConfig(reader(text), appHome, home);
    assert.deepEqual([c.double_click_files, c.double_click_apps], [false, true], String(text));
  }
  const c = await loadConfig(reader('{"double_click_files":true,"double_click_apps":false}'), appHome, home);
  assert.deepEqual([c.double_click_files, c.double_click_apps], [true, false]);
});

test("warn_cross_copy: default on, a boolean in the file wins, other types fall back", async () => {
  assert.equal((await loadConfig(reader('{"warn_cross_copy":false}'), appHome, home)).warn_cross_copy, false);
  assert.equal((await loadConfig(reader('{"warn_cross_copy":"no"}'), appHome, home)).warn_cross_copy, true);
});

test("show_sizes is on by default and changes only with a boolean (issue #58, #73)", async () => {
  for (const text of [null, "{nope", '{"show_sizes":"yes"}', '{"show_sizes":1}']) assert.equal((await loadConfig(reader(text), appHome, home)).show_sizes, true, String(text));
  assert.equal((await loadConfig(reader('{"show_sizes":false}'), appHome, home)).show_sizes, false);
});
