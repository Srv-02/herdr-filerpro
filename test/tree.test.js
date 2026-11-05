import { test } from "node:test";
import assert from "node:assert/strict";
import { pruneFolder, folderMissing, expandPath, visibleRows, ROW_H, LIST_SCRIPT, psListCommand, limitText } from "../mods/filer-pro/lib/tree.js";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkTmpSync } from "./tmp-helper.js";
import { withoutIntl } from "./no-intl.js";

test("pruneFolder drops a vanished folder and everything below it, nothing else", () => {
  const folders = new Set(["a", "a/b", "a/b/c", "ab", "d"]);
  const entries = new Map([["", [1]], ["a", [2]], ["a/b", [3]], ["a/b/c", [4]], ["ab", [5]], ["d", [6]]]);
  pruneFolder(folders, entries, "a");
  assert.deepEqual([...folders].sort(), ["ab", "d"]);
  assert.deepEqual([...entries.keys()].sort(), ["", "ab", "d"]); // "ab" is not below "a"
});

test("pruneFolder on an unknown path changes nothing", () => {
  const folders = new Set(["a"]);
  const entries = new Map([["a", [1]]]);
  pruneFolder(folders, entries, "zzz");
  assert.deepEqual([...folders], ["a"]);
  assert.deepEqual([...entries.keys()], ["a"]);
});

test("folderMissing: a failed listing without any message means the folder is gone", () => {
  assert.equal(folderMissing({ code: 1, stdout: "", stderr: "" }), true);
  assert.equal(folderMissing({ code: 1, stdout: "", stderr: "  \n" }), true);
  assert.equal(folderMissing({ code: 255, stdout: "", stderr: "ssh: Could not resolve hostname box" }), false);
  assert.equal(folderMissing({ code: 0, stdout: "", stderr: "" }), false);
});

test("expandPath: the folder to open after a new folder, relative to the shown root", () => {
  assert.equal(expandPath({ machine: null, folder: "/r/a/b" }, "/r", null), "a/b");
  assert.equal(expandPath({ machine: "box", folder: "/r/a" }, "/r", "box"), "a");
  assert.equal(expandPath({ machine: undefined, folder: "/r/a" }, "/r/", null), "a");
  assert.equal(expandPath({ machine: null, folder: "/r" }, "/r", null), null, "the root is always open");
  assert.equal(expandPath({ machine: "box", folder: "/r/a" }, "/r", null), null, "other machine");
  assert.equal(expandPath({ machine: null, folder: "/rx/a" }, "/r", null), null, "sibling with a longer name");
  assert.equal(expandPath({ machine: null, folder: "/other/a" }, "/r", null), null);
  assert.equal(expandPath(undefined, "/r", null), null);
  assert.equal(expandPath({ machine: null, folder: "/r/a" }, undefined, null), null);
});

const dir = (name) => ({ name, dir: true }), file = (name) => ({ name, dir: false });

test("visibleRows: tree order, only open folders are descended into", () => {
  const entries = new Map([["", [dir("a"), dir("b"), file("z.txt")]], ["a", [dir("c"), file("x.png")]], ["a/c", [file("y.md")]], ["b", [file("hidden")]]]);
  const rows = visibleRows(entries, new Set(["a", "a/c"]));
  assert.deepEqual(rows.map((r) => [r.path, r.depth]), [["a", 0], ["a/c", 1], ["a/c/y.md", 2], ["a/x.png", 1], ["b", 0], ["z.txt", 0]]);
  assert.equal(rows[0].entry, entries.get("")[0], "the entry object itself is handed out");
});

test("visibleRows: an open folder without loaded entries adds no rows", () => {
  assert.deepEqual(visibleRows(new Map([["", [dir("a")]]]), new Set(["a"])).map((r) => r.path), ["a"]);
  assert.deepEqual(visibleRows(new Map(), new Set()), []);
});

test("visibleRows: stops at the total limit", () => {
  const entries = new Map([["", [dir("a"), file("b"), file("c")]], ["a", [file("1"), file("2")]]]);
  assert.deepEqual(visibleRows(entries, new Set(["a"]), { limit: 3 }).map((r) => r.path), ["a", "a/1", "a/2"]);
  assert.equal(visibleRows(entries, new Set(["a"])).length, 5, "default limit 5000");
});

test("visibleRows: folders deeper than maxDepth are not descended into", () => {
  const entries = new Map(), folders = new Set();
  let prefix = "";
  for (let i = 0; i < 45; i++) {
    entries.set(prefix, [dir("d")]);
    prefix = prefix ? `${prefix}/d` : "d";
    folders.add(prefix);
  }
  const rows = visibleRows(entries, folders);
  assert.equal(rows.length, 41, "depths 0..40 as in rows(): a call deeper than 40 returns at once");
  assert.equal(rows.at(-1).depth, 40);
  assert.equal(visibleRows(entries, folders, { maxDepth: 2 }).length, 3);
});

test("ROW_H is the 28px row height of the tree", () => {
  assert.equal(ROW_H, 28);
});

test("LIST_SCRIPT stops one entry past the per-folder limit given as $2", () => {
  const d = mkTmpSync("filer-pro-list-");
  try {
    for (let i = 0; i < 15; i++) fs.writeFileSync(path.join(d, `f${i}`), "");
    const count = (limit) => spawnSync("sh", ["-c", LIST_SCRIPT, "files", d, String(limit)], { encoding: "utf8" }).stdout.split("\0").filter(Boolean).length / 2;
    assert.equal(count(10), 11);
    assert.equal(count(500), 15);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("psListCommand asks for one entry past the limit and quotes the path", () => {
  const cmd = psListCommand("C:\\it's", 500);
  assert.match(cmd, /Select-Object -First 501 /);
  assert.ok(cmd.endsWith("'C:\\it''s'"));
  assert.match(psListCommand("C:\\x", 20), /-First 21 /);
});

test("limitText names the configured numbers, also without Intl (herdr's engine)", async () => {
  await withoutIntl(() => {
    assert.equal(limitText(500, 5000), "File list limited to 500 entries per folder and 5,000 total");
    assert.equal(limitText(1200, 20000), "File list limited to 1,200 entries per folder and 20,000 total");
  });
});
