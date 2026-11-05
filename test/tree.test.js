import { test } from "node:test";
import assert from "node:assert/strict";
import { pruneFolder, folderMissing, expandPath, visibleRows, ROW_H } from "../mods/filer-pro/lib/tree.js";

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
