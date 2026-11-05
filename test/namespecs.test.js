import { test } from "node:test";
import assert from "node:assert/strict";
import { renameSpec, newFolderSpec } from "../mods/filer-pro/lib/namespecs.js";

test("newFolderSpec: prefilled, fully selected, any valid name passes", () => {
  const s = newFolderSpec();
  assert.equal(s.title, "New Folder");
  assert.equal(s.value, "New Folder");
  assert.equal(s.selectEnd, "New Folder".length);
  assert.equal(s.check("New Folder"), null);
  assert.equal(s.check("Übung 2"), null);
  assert.equal(s.check(""), "Enter a name");
  assert.equal(s.check("a/b"), 'A name cannot contain "/"');
  assert.equal(s.check(".."), '"." and ".." are not allowed');
  assert.equal(s.check("a\nb"), "Names with control characters are not supported");
});

test("renameSpec: stem selected, unchanged name is refused", () => {
  const s = renameSpec({ name: "report.pdf", isDir: false });
  assert.equal(s.title, "Rename");
  assert.equal(s.selectEnd, "report".length);
  assert.equal(s.check("report.pdf"), "The name is unchanged");
  assert.equal(s.check("b.pdf"), null);
  assert.equal(renameSpec({ name: "src.d", isDir: true }).selectEnd, 5);
});
