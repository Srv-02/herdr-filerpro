// Issue #14: macOS packages (.app, .pkg, .rtfd) are shown like files in a local tree on macOS and opened with `open`.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { BUNDLE_EXTENSIONS, isBundle, markBundles, treeDir, sortsAsFolder, bundleIcon } from "../mods/filer-pro/lib/bundles.js";
import { openBundle, OPEN_BUNDLE_SCRIPT } from "../mods/filer-pro/lib/open.js";
import { rowMenuItems, menuHeight } from "../mods/filer-pro/lib/menuitems.js";
import { visibleRows } from "../mods/filer-pro/lib/tree.js";
import { mkTmp } from "./tmp-helper.js";
import { existsSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");

const LOCAL_MAC = { on: null, platform: "macos" };

test("the package extensions are one constant: .app, .pkg and .rtfd", () => {
  assert.deepEqual([...BUNDLE_EXTENSIONS], ["app", "pkg", "rtfd"]);
  assert.ok(Object.isFrozen(BUNDLE_EXTENSIONS));
});

test("a folder ending in .app, .pkg or .rtfd is a package in a local tree on macOS, in any letter case", () => {
  for (const name of ["Example.app", "Example.APP", "Setup.pkg", "Setup.Pkg", "Notes.rtfd", "Notes.RTFD", "my.tool.app"]) {
    assert.equal(isBundle(name, LOCAL_MAC), true, name);
  }
});

test("developer packages and other folders stay folders", () => {
  for (const name of ["Example.xcodeproj", "Example.framework", "Example.bundle", "Example.plugin", "app", ".app", "Example.app.bak", "Exampleapp", "Example.apps"]) {
    assert.equal(isBundle(name, LOCAL_MAC), false, name);
  }
});

test("on a machine, on Windows, on Linux or without a known platform no folder is a package", () => {
  assert.equal(isBundle("Example.app", { on: "server", platform: "macos" }), false);
  assert.equal(isBundle("Example.app", { on: null, platform: "windows" }), false);
  assert.equal(isBundle("Example.app", { on: null, platform: "linux" }), false);
  assert.equal(isBundle("Example.app", { on: null, platform: undefined }), false);
});

test("markBundles flags only folders: a file named Example.app stays a file", () => {
  const entries = [{ name: "Example.app", dir: true }, { name: "Fake.app", dir: false }, { name: "src", dir: true }, { name: "Tool.xcodeproj", dir: true }];
  assert.deepEqual(markBundles(entries, LOCAL_MAC), [
    { name: "Example.app", dir: true, bundle: true }, { name: "Fake.app", dir: false }, { name: "src", dir: true }, { name: "Tool.xcodeproj", dir: true },
  ]);
  assert.deepEqual(markBundles(entries, { on: "server", platform: "macos" }), entries);
  assert.deepEqual(markBundles(entries, { on: null, platform: "linux" }), entries);
});

test("a package acts as a folder in the tree only while its contents are shown; it sorts among the files", () => {
  const app = { name: "Example.app", dir: true, bundle: true }, src = { name: "src", dir: true }, file = { name: "a.txt", dir: false };
  assert.equal(treeDir(app, "Example.app", new Set()), false);
  assert.equal(treeDir(app, "Example.app", new Set(["Example.app"])), true);
  assert.equal(treeDir(app, "Example.app", undefined), false);
  assert.equal(treeDir(src, "src", new Set()), true);
  assert.equal(treeDir(file, "a.txt", new Set(["a.txt"])), false);
  assert.equal(sortsAsFolder(app), false);
  assert.equal(sortsAsFolder(src), true);
  assert.equal(sortsAsFolder(file), false);
});

test("package icons come from the shipped set: app, package and document icons, light variants included", () => {
  assert.equal(bundleIcon("Example.app", true), "mods/filer-pro/icons/exe.svg");
  assert.equal(bundleIcon("Setup.PKG", true), "mods/filer-pro/icons/zip.svg");
  assert.equal(bundleIcon("Notes.rtfd", true), "mods/filer-pro/icons/word.svg");
  for (const name of ["Example.app", "Setup.pkg", "Notes.rtfd"]) {
    const p = bundleIcon(name, false);
    assert.match(p, /^mods\/filer-pro\/icons\/[a-z_-]+\.svg$/);
    assert.ok(existsSync(path.join(REPO, p)), `${p} exists`);
  }
});

test("visibleRows descends only where isDir says so", () => {
  const entries = new Map([["", [{ name: "Example.app", dir: true, bundle: true }, { name: "src", dir: true }]], ["Example.app", [{ name: "Contents", dir: true }]], ["src", [{ name: "a.js", dir: false }]]]);
  const folders = new Set(["Example.app", "src"]);
  assert.deepEqual(visibleRows(entries, folders).map((r) => r.path), ["Example.app", "Example.app/Contents", "src", "src/a.js"], "default: entry.dir");
  const closed = visibleRows(entries, folders, { isDir: (e, p) => treeDir(e, p, new Set()) }).map((r) => r.path);
  assert.deepEqual(closed, ["Example.app", "src", "src/a.js"]);
  const shown = visibleRows(entries, folders, { isDir: (e, p) => treeDir(e, p, new Set(["Example.app"])) }).map((r) => r.path);
  assert.deepEqual(shown, ["Example.app", "Example.app/Contents", "src", "src/a.js"]);
});

const on = { paste: { enabled: true, reason: null } };
const enabled = (items, action) => items.find((i) => i.action === action)?.enabled;

test("the row menu of a package: Open and Show Package Contents, the file-only entries stay dimmed", () => {
  const items = rowMenuItems({ ...on, isDir: true, bundle: true });
  const labels = items.filter((i) => !i.separator).map((i) => i.label);
  assert.deepEqual(labels.slice(0, 6), ["Open", "Open in Preview", "Open in Editor", "Edit in Terminal", "Show in Finder", "Show Package Contents"]);
  const pkg = items.find((i) => i.action === "package_contents");
  assert.equal(pkg.id, "filer-pro-menu-package-contents");
  assert.equal(enabled(items, "open"), true);
  assert.equal(enabled(items, "package_contents"), true);
  for (const a of ["open_preview", "open_editor", "edit_terminal"]) assert.equal(enabled(items, a), false, a);
  for (const a of ["reveal", "download", "copy", "cut", "copy_path", "rename", "delete"]) assert.equal(enabled(items, a), true, a);
  assert.equal(menuHeight(items), menuHeight(rowMenuItems(on)) + 28);
});

test("while its contents are shown the entry reads Hide Package Contents", () => {
  const items = rowMenuItems({ ...on, isDir: true, bundle: true, contents: true });
  assert.equal(items.find((i) => i.action === "package_contents").label, "Hide Package Contents");
});

test("folders, files and remote rows have no package entry", () => {
  for (const state of [{ ...on, isDir: true }, { ...on, isDir: false }, { ...on, isDir: true, bundle: true, remote: true }]) {
    assert.equal(rowMenuItems(state).some((i) => i.action === "package_contents"), false);
  }
  assert.equal(enabled(rowMenuItems({ ...on, isDir: true, bundle: true, remote: true }), "open"), false);
});

// openBundle runs the opener through OPEN_BUNDLE_SCRIPT for real; the opener is a recorder script.
const realExec = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, (err, stdout, stderr) => {
  if (err && err.code === "ENOENT") reject(err); else resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
}));
async function setup() {
  const dir = await fs.realpath(await mkTmp("bundle-"));
  const recorder = `${dir}/record.sh`, log = `${dir}/opened.log`;
  await fs.writeFile(recorder, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${log}"; done\n`, { mode: 0o755 });
  const toasts = [], calls = [];
  const exec = (cmd, args) => { calls.push([cmd, args]); return realExec(cmd, args); };
  const deps = { exec, notify: (n) => toasts.push(n), platform: { openArgs: (p) => [recorder, [p]] } };
  const opened = async () => (await fs.readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
  return { dir, toasts, deps, opened, calls, recorder };
}

test("openBundle opens a package folder with exactly the opener and its resolved path", async () => {
  const { dir, toasts, deps, opened, calls, recorder } = await setup();
  for (const name of ["Example.app", "Setup.PKG", "Notes.rtfd"]) await fs.mkdir(`${dir}/${name}`);
  for (const name of ["Example.app", "Setup.PKG", "Notes.rtfd"]) assert.deepEqual(await openBundle(`${dir}/${name}`, deps), { ok: true });
  assert.deepEqual(await opened(), [`${dir}/Example.app`, `${dir}/Setup.PKG`, `${dir}/Notes.rtfd`]);
  assert.deepEqual(toasts, []);
  assert.deepEqual(calls[0], ["sh", ["-c", OPEN_BUNDLE_SCRIPT, "sh", `${dir}/Example.app`, recorder]], "the path travels as an argument, never in the script");
  assert.doesNotMatch(OPEN_BUNDLE_SCRIPT, /xattr/, "quarantine is never removed");
});

test("openBundle uses the real macOS opener: open <path>", async () => {
  const calls = [];
  const exec = async (cmd, args) => { calls.push([cmd, args]); return { code: 0 }; };
  const { platform } = await import("../mods/filer-pro/lib/platform.js");
  await openBundle("/Users/example/Downloads/Example.app", { exec, notify: () => {}, platform });
  assert.deepEqual(calls, [["sh", ["-c", OPEN_BUNDLE_SCRIPT, "sh", "/Users/example/Downloads/Example.app", "open"]]]);
});

test("openBundle refuses a file, a missing path, another folder and a link that leads away from a package", async () => {
  const { dir, toasts, deps, opened } = await setup();
  await fs.writeFile(`${dir}/Fake.app`, "x");
  await fs.mkdir(`${dir}/Tool.xcodeproj`);
  await fs.mkdir(`${dir}/plain`);
  await fs.symlink(`${dir}/plain`, `${dir}/Link.app`);
  for (const name of ["Fake.app", "Missing.app", "Tool.xcodeproj", "Link.app"]) assert.equal((await openBundle(`${dir}/${name}`, deps)).ok, false, name);
  assert.deepEqual(await opened(), []);
  assert.equal(toasts.length, 4);
  assert.ok(toasts.every((t) => t.title === "Open" && t.level === "warning"));
  assert.match(toasts[1].body, /not found/);
  assert.ok(toasts.every((t) => t.body.includes(dir)), "the message names the path");
});

test("openBundle follows a link to a real package and opens the target", async () => {
  const { dir, deps, opened } = await setup();
  await fs.mkdir(`${dir}/Real.app`);
  await fs.symlink(`${dir}/Real.app`, `${dir}/Alias.app`);
  assert.equal((await openBundle(`${dir}/Alias.app`, deps)).ok, true);
  assert.deepEqual(await opened(), [`${dir}/Real.app`]);
});

