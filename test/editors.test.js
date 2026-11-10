import { test } from "node:test";
import assert from "node:assert/strict";
import {
  splitCommand, pathUri, expandTemplate, terminalArgv, guiArgv, editorMenu, TERMINAL_EDITORS, GUI_EDITORS,
} from "../mods/filer-pro/lib/editors.js";

const NASTY = [
  "/home/u/my file.txt", "/home/u/it's \"quoted\".md", "/home/u/$HOME.txt", "/home/u/`whoami`.sh",
  "/home/u/-rf", "/home/u/Ünïcödé 日本.txt", "/home/u/a\nb.txt", "/home/u/{target}.txt", "/home/u/100% #1?.txt",
];

test("splitCommand splits on whitespace and groups quotes, without a shell", () => {
  assert.deepEqual(splitCommand("vi"), ["vi"]);
  assert.deepEqual(splitCommand("  nvim   -u NONE  "), ["nvim", "-u", "NONE"]);
  assert.deepEqual(splitCommand("\"/Applications/My Editor.app/bin/ed\" --wait {path}"), ["/Applications/My Editor.app/bin/ed", "--wait", "{path}"]);
  assert.deepEqual(splitCommand("ed '$HOME' a\"b c\"d"), ["ed", "$HOME", "ab cd"]);
  assert.deepEqual(splitCommand("ed ''"), ["ed", ""]);
  assert.deepEqual(splitCommand("a\tb\nc"), ["a", "b", "c"]);
});
test("splitCommand rejects empty text, unbalanced quotes and non-strings", () => {
  for (const bad of ["", "   ", "ed 'open", "ed \"open", null, 5, undefined, ["vi"]]) assert.equal(splitCommand(bad), null, String(bad));
});

test("pathUri percent-encodes every segment and keeps the slashes", () => {
  assert.equal(pathUri("/home/u/a.txt"), "/home/u/a.txt");
  assert.equal(pathUri("/home/u/my file #1?.txt"), "/home/u/my%20file%20%231%3F.txt");
  assert.equal(pathUri("/data/100%.txt"), "/data/100%25.txt");
  assert.equal(pathUri("/data/Ü.txt"), "/data/%C3%9C.txt");
  assert.equal(pathUri("/data/a+b&c=d;e,f@g:h~i_j-k.l!m'n(o)p*q"), "/data/a%2Bb%26c%3Dd%3Be%2Cf%40g%3Ah~i_j-k.l%21m%27n%28o%29p%2Aq");
  assert.equal(pathUri("/a\nb"), "/a%0Ab");
  assert.equal(decodeURIComponent(pathUri("/x/日本 語")), "/x/日本 語");
});

test("expandTemplate substitutes placeholders per argv element and in one pass", () => {
  const vars = { path: "/home/u/{target} x.txt", path_uri: pathUri("/home/u/{target} x.txt"), target: "me@box" };
  assert.deepEqual(expandTemplate(["code", "--file-uri", "vscode-remote://ssh-remote+{target}{path_uri}"], vars),
    ["code", "--file-uri", "vscode-remote://ssh-remote+me@box/home/u/%7Btarget%7D%20x.txt"]);
  assert.deepEqual(expandTemplate(["ed", "{path}", "{other}", "{{path}}"], vars), ["ed", "/home/u/{target} x.txt", "{other}", "{/home/u/{target} x.txt}"]);
});

test("terminalArgv puts the path as its own last element, unchanged for every nasty name", () => {
  for (const path of NASTY) {
    assert.deepEqual(terminalArgv("vi", path), ["vi", path]);
    assert.deepEqual(terminalArgv("nvim -u NONE", path), ["nvim", "-u", "NONE", path]);
  }
  assert.deepEqual(terminalArgv("vi", "-rf"), ["vi", "./-rf"]); // guard only: the menu always passes absolute paths
  assert.equal(terminalArgv("ed 'x", "/a"), null);
});

test("shipped terminal editors: vi first, helix runs hx", () => {
  assert.deepEqual(TERMINAL_EDITORS.map((e) => [e.name, e.command]), [["vi", "vi"], ["vim", "vim"], ["nano", "nano"], ["micro", "micro"], ["fresh", "fresh"], ["helix", "hx"]]);
});

test("guiArgv: shipped editors locally and remotely, path never split", () => {
  const byName = Object.fromEntries(GUI_EDITORS.map((e) => [e.name, e]));
  assert.deepEqual(Object.keys(byName), ["VS Code", "Cursor", "Zed"]);
  const path = "/home/u/my file #1?.txt";
  assert.deepEqual(guiArgv(byName["VS Code"], { path, target: null }), { argv: ["code", path] });
  assert.deepEqual(guiArgv(byName["VS Code"], { path, target: "me@box" }), { argv: ["code", "--file-uri", "vscode-remote://ssh-remote+me@box/home/u/my%20file%20%231%3F.txt"] });
  assert.deepEqual(guiArgv(byName.Cursor, { path, target: "box" }), { argv: ["cursor", "--file-uri", "vscode-remote://ssh-remote+box/home/u/my%20file%20%231%3F.txt"] });
  assert.deepEqual(guiArgv(byName.Zed, { path, target: "me@box" }), { argv: ["zed", "ssh://me@box/home/u/my%20file%20%231%3F.txt"] });
  assert.deepEqual(guiArgv(byName.Zed, { path, target: null }), { argv: ["zed", path] });
});

test("guiArgv: custom templates with {path} and {target}; a missing remote template is an error", () => {
  const custom = { name: "Mine", local: "myed --new {path}", remote: "myed --ssh {target} {path}" };
  assert.deepEqual(guiArgv(custom, { path: "/a b/$c", target: null }), { argv: ["myed", "--new", "/a b/$c"] });
  assert.deepEqual(guiArgv(custom, { path: "/a b/$c", target: "u@h" }), { argv: ["myed", "--ssh", "u@h", "/a b/$c"] });
  assert.match(guiArgv({ name: "Mine", local: "myed {path}", remote: null }, { path: "/a", target: "h" }).error, /Mine.*remote/);
});

test("guiArgv refuses an SSH target that cannot stand in a URI or argv word (space, slash, empty)", () => {
  const vs = GUI_EDITORS[0];
  for (const target of ["ssh me@box", "box/x", "a\tb", ""]) assert.match(guiArgv(vs, { path: "/a", target }).error, /SSH target/, target);
  assert.deepEqual(guiArgv(vs, { path: "/a", target: "me@box.example.com" }).argv.at(-1), "vscode-remote://ssh-remote+me@box.example.com/a");
});

import { pickEditor, terminalPlan } from "../mods/filer-pro/lib/editors.js";

test("pickEditor: own entries first, then shipped, else the default", () => {
  const own = [{ name: "vim", command: "vim -Nu NONE" }, { name: "nvim", command: "nvim" }];
  assert.deepEqual(pickEditor("vim", own, TERMINAL_EDITORS, "vi"), { name: "vim", command: "vim -Nu NONE" });
  assert.deepEqual(pickEditor("nvim", own, TERMINAL_EDITORS, "vi"), { name: "nvim", command: "nvim" });
  assert.deepEqual(pickEditor("helix", own, TERMINAL_EDITORS, "vi"), { name: "helix", command: "hx" });
  assert.deepEqual(pickEditor("gone", [], TERMINAL_EDITORS, "vi"), { name: "vi", command: "vi" });
  assert.equal(pickEditor(undefined, undefined, GUI_EDITORS, "VS Code").name, "VS Code");
});

const argv = ["vi", "/srv/a b.txt"], folder = "/srv";
const local = { id: "s1", active: true, machine: null }, box = { id: "s2", active: false, machine: "box" };
const box2 = { id: "s3", active: false, machine: "box" };

test("terminalPlan: a focused pane in the active space on the row's machine splits right first, a new tab there is the fallback", () => {
  assert.deepEqual(terminalPlan({ focused: { pane: "p1" }, spaces: [local, box], machine: null, argv, folder }), [
    ["terminal.open", { argv, folder, place: "right" }],
    ["tab.new", { space: "s1", folder, argv }],
  ]);
  assert.deepEqual(terminalPlan({ focused: { pane: "p1" }, spaces: [{ ...local, active: false }, { ...box, active: true }], machine: "box", argv, folder }), [
    ["terminal.open", { argv, folder, place: "right" }],
    ["tab.new", { space: "s2", folder, argv }],
  ]);
});

test("terminalPlan: no focused terminal pane (layout terminal or mod pane) goes straight to a new tab, never place right", () => {
  for (const focused of [{ pane: null, terminal: "t1" }, { pane: null }, null, undefined]) {
    assert.deepEqual(terminalPlan({ focused, spaces: [local, box], machine: null, argv, folder }), [["tab.new", { space: "s1", folder, argv }]]);
    assert.deepEqual(terminalPlan({ focused, spaces: [{ ...local, active: false }, { ...box, active: true }], machine: "box", argv, folder }), [["tab.new", { space: "s2", folder, argv }]]);
  }
});

test("terminalPlan: an active space on another machine gives an empty plan, never a split or a tab on the wrong machine", () => {
  // Row from box (e.g. a layout terminal on box is focused), active space local: no split, and no tab in a hidden space.
  assert.deepEqual(terminalPlan({ focused: { pane: "p1" }, spaces: [local, box, box2], machine: "box", argv, folder }), []);
  assert.deepEqual(terminalPlan({ focused: { pane: null, terminal: "box/t1" }, spaces: [local, box], machine: "box", argv, folder }), []);
  // Local row, active space on box.
  assert.deepEqual(terminalPlan({ focused: { pane: "p1" }, spaces: [{ ...box, active: true }, { id: "s9", active: false }], machine: null, argv, folder }), []);
  // No active space, no spaces at all.
  assert.deepEqual(terminalPlan({ focused: { pane: "p1" }, spaces: [{ ...local, active: false }], machine: null, argv, folder }), []);
  assert.deepEqual(terminalPlan({ focused: { pane: "p1" }, spaces: undefined, machine: null, argv, folder }), []);
});

test("terminalPlan: a missing, undefined or empty machine all mean this computer", () => {
  assert.equal(terminalPlan({ focused: { pane: "p1" }, spaces: [{ id: "s8", active: true, machine: "" }], machine: undefined, argv, folder })[0][0], "terminal.open");
  assert.equal(terminalPlan({ focused: { pane: "p1" }, spaces: [{ id: "s8", active: true }], machine: null, argv, folder })[0][0], "terminal.open");
});

test("shipped editors open a folder on a machine with remote_folder", () => {
  const byName = Object.fromEntries(GUI_EDITORS.map((e) => [e.name, e]));
  const path = "/srv/my app";
  assert.deepEqual(guiArgv(byName["VS Code"], { path, target: "me@box", folder: true }), { argv: ["code", "--folder-uri", "vscode-remote://ssh-remote+me@box/srv/my%20app"] });
  assert.deepEqual(guiArgv(byName.Cursor, { path, target: "me@box", folder: true }), { argv: ["cursor", "--folder-uri", "vscode-remote://ssh-remote+me@box/srv/my%20app"] });
  assert.deepEqual(guiArgv(byName.Zed, { path, target: "me@box", folder: true }), { argv: ["zed", "ssh://me@box/srv/my%20app"] });
  assert.deepEqual(guiArgv(byName["VS Code"], { path: "/", target: "me@box", folder: true }), { argv: ["code", "--folder-uri", "vscode-remote://ssh-remote+me@box/"] });
  assert.deepEqual(guiArgv(byName["VS Code"], { path, target: null, folder: true }), { argv: ["code", "/srv/my app"] });
});

test("guiArgv: a missing remote_folder is an error that names the key", () => {
  const mine = { name: "Mine", local: "myed {path}", remote: "myed --ssh {target} {path}", remote_folder: null };
  assert.match(guiArgv(mine, { path: "/x", target: "box", folder: true }).error, /Mine.*remote_folder/);
  assert.deepEqual(guiArgv(mine, { path: "/x", target: "box", folder: false }), { argv: ["myed", "--ssh", "box", "/x"] });
});

test("editorMenu: the name and which remote templates the chosen editor has", () => {
  const both = { name: "VS Code", remote: true, remoteFolder: true };
  assert.deepEqual(editorMenu(null), both);
  assert.deepEqual(editorMenu({}), both);
  assert.deepEqual(editorMenu({ gui_editor: "Zed" }), { name: "Zed", remote: true, remoteFolder: true });
  assert.deepEqual(editorMenu({ gui_editor: "Sublime Text", gui_editors: [{ name: "Sublime Text", local: "subl {path}", remote: null, remote_folder: null }] }), { name: "Sublime Text", remote: false, remoteFolder: false });
  assert.deepEqual(editorMenu({ gui_editor: "Mine", gui_editors: [{ name: "Mine", local: "m {path}", remote: "m {target} {path}" }] }), { name: "Mine", remote: true, remoteFolder: false });
  assert.deepEqual(editorMenu({ gui_editor: "Nope" }), both);
});
