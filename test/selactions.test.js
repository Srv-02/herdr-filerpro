import { test } from "node:test";
import assert from "node:assert/strict";
import { selectionRequest, pathsText, barLabel } from "../mods/filer-pro/lib/selactions.js";

const items = [{ path: "/srv/a b", isDir: false }, { path: "/srv/d", isDir: true }];

test("#99 download: a machine gets paths and dest_dir, this computer a copy request with folder", () => {
  assert.deepEqual(selectionRequest("download", { on: "box", root: "/srv", items }), { action: "download", machine: "box", paths: ["/srv/a b", "/srv/d"] });
  assert.deepEqual(selectionRequest("download_to", { on: "box", root: "/srv", items, dest: "/Users/example/x" }), { action: "download", machine: "box", paths: ["/srv/a b", "/srv/d"], dest_dir: "/Users/example/x" });
  assert.deepEqual(selectionRequest("download", { on: null, root: "/srv", items }), { action: "copy", paths: ["/srv/a b", "/srv/d"] });
  assert.deepEqual(selectionRequest("download_to", { on: null, root: "/srv", items, dest: "/Users/example/x" }), { action: "copy", paths: ["/srv/a b", "/srv/d"], folder: "/Users/example/x" });
});
test("#99 copy and cut: one clip request with the list", () => {
  const list = [{ path: "/srv/a b", is_dir: false }, { path: "/srv/d", is_dir: true }];
  assert.deepEqual(selectionRequest("copy", { on: "box", root: "/srv", items }), { action: "clip", machine: "box", items: list, root: "/srv" });
  assert.deepEqual(selectionRequest("cut", { on: null, root: "/srv", items }), { action: "clip", items: list, cut: true, root: "/srv" });
});
test("#99 delete: paths and root", () => {
  assert.deepEqual(selectionRequest("delete", { on: "box", root: "/srv", items }), { action: "delete", machine: "box", paths: ["/srv/a b", "/srv/d"], root: "/srv" });
  assert.deepEqual(selectionRequest("delete", { on: null, root: "/srv", items }), { action: "delete", paths: ["/srv/a b", "/srv/d"], root: "/srv" });
});
test("#99 no items or an unknown action give null", () => {
  assert.equal(selectionRequest("copy", { on: null, root: "/", items: [] }), null);
  assert.equal(selectionRequest("copy", { on: null, root: "/" }), null);
  assert.equal(selectionRequest("rename", { on: null, root: "/", items }), null);
});
test("#99 pathsText: shell-quoted paths, one per line", () => {
  assert.equal(pathsText([{ path: "/srv/a b" }, { path: "/srv/it's" }, { path: "/srv/plain" }]), `'/srv/a b'\n'/srv/it'\\''s'\n/srv/plain`);
});
test("#99 barLabel: counts, grouped thousands, the plain verb without a selection", () => {
  assert.deepEqual(["download", "copy", "cut", "delete"].map((a) => barLabel(a, 3)), ["Download 3 Items", "Copy 3 Items", "Cut 3 Items", "Delete 3 Items…"]);
  assert.equal(barLabel("download", 1), "Download 1 Item");
  assert.equal(barLabel("copy", 1234), "Copy 1,234 Items");
  assert.deepEqual(["download", "copy", "cut", "delete"].map((a) => barLabel(a, 0)), ["Download", "Copy", "Cut", "Delete…"]);
});
