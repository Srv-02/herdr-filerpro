import { test } from "node:test";
import assert from "node:assert/strict";
import { TREE_FIELDS, createTree, pinnedContext, readLocalTree, writeLocalTree, startFolder } from "../mods/filer-pro/lib/treestate.js";

test("createTree gives empty, independent state per call", () => {
  const a = createTree("follow"), b = createTree("follow");
  assert.notEqual(a.folders, b.folders);
  assert.equal(a.entries.size, 0);
  assert.equal(a.id, "follow");
  for (const k of TREE_FIELDS) assert.ok(Object.hasOwn(a, k), k);
  assert.ok(a.selected instanceof Set);
});

test("pinnedContext is fixed, local and keyed by its root", () => {
  assert.deepEqual(pinnedContext("/Users/example/Downloads"), { key: "pinned:/Users/example/Downloads", cwd: "/Users/example/Downloads", on: null, fixed: true, tree: "pinned" });
});

test("readLocalTree drops wrong types", () => {
  assert.deepEqual(readLocalTree(null), { shown: false, root: null, sizes: null, seed: null });
  assert.deepEqual(readLocalTree({ shown: "yes", root: "rel/x", sizes: [1] }), { shown: false, root: null, sizes: null, seed: null });
  assert.deepEqual(readLocalTree({ shown: true, root: "/x", sizes: [300, 200] }), { shown: true, root: "/x", sizes: [300, 200], seed: null });
  assert.equal(readLocalTree({ sizes: [0, 5] }).sizes, null);
  assert.equal(readLocalTree({ sizes: [NaN, 5] }).sizes, null);
});

test("writeLocalTree keeps the reference when nothing changes", () => {
  const s = readLocalTree({ shown: true, root: "/x" });
  assert.equal(writeLocalTree(s, { shown: true }), s);
  assert.deepEqual(writeLocalTree(s, { root: "/y" }), { shown: true, root: "/y", sizes: null, seed: null });
  const z = readLocalTree({ sizes: [1, 2] });
  assert.equal(writeLocalTree(z, { sizes: [1, 2] }), z);
});

test("startFolder prefers local_tree_folder", () => {
  assert.equal(startFolder({ local_tree_folder: "/a", download_folder: "/b" }), "/a");
  assert.equal(startFolder({ local_tree_folder: "", download_folder: "/b" }), "/b");
  assert.equal(startFolder({}), null);
});
