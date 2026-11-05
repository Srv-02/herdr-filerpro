import { test } from "node:test";
import assert from "node:assert/strict";
import { pruneFolder, folderMissing, expandPath } from "../mods/filer-pro/lib/tree.js";

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
