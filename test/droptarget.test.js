import { test } from "node:test";
import assert from "node:assert/strict";
import { dropTarget, dropRequest } from "../mods/filer-pro/lib/droptarget.js";

test("dropTarget: container, folder row, file row", () => {
  assert.equal(dropTarget("/r", null, false), "/r");
  assert.equal(dropTarget("/r", "a/b", true), "/r/a/b");
  assert.equal(dropTarget("/r", "a/c.md", false), "/r/a");
  assert.equal(dropTarget("/r", "c.md", false), "/r");
  assert.equal(dropTarget("/", "c.md", false), "/");
  assert.equal(dropTarget("/", "a", true), "/a");
});

test("dropRequest: upload for a machine, copy for the local tree", () => {
  const paths = ["/Users/m/a.txt"];
  assert.deepEqual(dropRequest({ on: "box", root: "/srv", rowPath: "in", rowIsDir: true, paths }),
    { action: "upload", machine: "box", paths, folder: "/srv/in" });
  assert.deepEqual(dropRequest({ on: null, root: "/Users/m/git/x", rowPath: "README.md", rowIsDir: false, paths }),
    { action: "copy", paths, folder: "/Users/m/git/x" });
});

test("dropRequest: nothing to do without root or paths", () => {
  assert.equal(dropRequest({ on: null, root: "/r", rowPath: null, rowIsDir: false, paths: [] }), null);
  assert.equal(dropRequest({ on: null, root: "/r", rowPath: null, rowIsDir: false, paths: undefined }), null);
  assert.equal(dropRequest({ on: null, root: undefined, rowPath: null, rowIsDir: false, paths: ["/a"] }), null);
});

test("uploadRequest: the drop request for the folder the menu names", async () => {
  const { uploadRequest } = await import("../mods/filer-pro/lib/droptarget.js");
  const paths = ["/Users/m/a.txt"];
  assert.deepEqual(uploadRequest({ on: "box", folder: "/srv/in", paths }), dropRequest({ on: "box", root: "/srv", rowPath: "in", rowIsDir: true, paths }));
  assert.deepEqual(uploadRequest({ on: null, folder: "/r", paths }), { action: "copy", paths, folder: "/r" });
  assert.equal(uploadRequest({ on: null, folder: "/r", paths: null }), null);
  assert.equal(uploadRequest({ on: null, folder: "/r", paths: [] }), null);
});
