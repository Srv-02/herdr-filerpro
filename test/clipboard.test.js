import { test } from "node:test";
import assert from "node:assert/strict";
import { clipEntry, clipItems, sameClip, pastePlan, pasteState } from "../mods/filer-pro/lib/clipboard.js";

const L = clipEntry({ on: null, items: [{ path: "/Users/m/a.txt", isDir: false }], at: 1 });
const R = clipEntry({ on: "box", items: [{ path: "/srv/d", isDir: true }], at: 2 });

test("clipEntry normalizes machine and isDir", () => {
  assert.deepEqual(L, { machine: null, items: [{ path: "/Users/m/a.txt", isDir: false }], at: 1 });
  assert.deepEqual(clipEntry({ on: undefined, items: [{ path: "/p", isDir: "yes" }], at: 3 }), { machine: null, items: [{ path: "/p", isDir: false }], at: 3 });
});
test("pastePlan picks the direction from source and target side", () => {
  assert.deepEqual(pastePlan(L, { on: null, folder: "/Users/m/git" }), { direction: "local", machine: null, srcs: ["/Users/m/a.txt"], destDir: "/Users/m/git" });
  assert.deepEqual(pastePlan(R, { on: "box", folder: "/srv/in" }), { direction: "remote", machine: "box", srcs: ["/srv/d"], destDir: "/srv/in" });
  assert.deepEqual(pastePlan(R, { on: null, folder: "/Users/m/Downloads" }), { direction: "down", machine: "box", srcs: ["/srv/d"], destDir: "/Users/m/Downloads" });
  assert.deepEqual(pastePlan(L, { on: "box", folder: "/srv/in" }), { direction: "up", machine: "box", srcs: ["/Users/m/a.txt"], destDir: "/srv/in" });
  assert.deepEqual(pastePlan(R, { on: "other", folder: "/srv" }), { direction: "cross", from: "box", machine: "other", srcs: ["/srv/d"], destDir: "/srv" });
  assert.deepEqual(pastePlan(null, { on: null, folder: "/x" }), { error: "Nothing to paste" });
  assert.deepEqual(pastePlan({}, { on: null, folder: "/x" }), { error: "Nothing to paste" });
});
test("pasteState mirrors pastePlan for the menu", () => {
  assert.deepEqual(pasteState(null, null), { enabled: false, reason: "Nothing to paste" });
  assert.deepEqual(pasteState(R, "other"), { enabled: true, reason: null });
  assert.deepEqual(pasteState(R, "box"), { enabled: true, reason: null });
  assert.deepEqual(pasteState(L, "box"), { enabled: true, reason: null });
});

const C = clipEntry({ on: "box", items: [{ path: "/srv/d/a.txt", isDir: false }], at: 3, cut: true });
const LC = clipEntry({ on: null, items: [{ path: "/Users/me/a", isDir: true }], at: 1, cut: true });
test("clip with cut sets the mark, a later copy clears it", () => {
  assert.deepEqual(C, { machine: "box", items: [{ path: "/srv/d/a.txt", isDir: false }], at: 3, cut: true });
  assert.deepEqual(clipEntry({ on: "box", items: [{ path: "/srv/d/a.txt", isDir: false }], at: 4 }), { machine: "box", items: [{ path: "/srv/d/a.txt", isDir: false }], at: 4 });
  assert.equal("cut" in clipEntry({ on: null, items: [{ path: "/p", isDir: false }], at: 1, cut: "yes" }), false);
});
test("legacy clipboard without cut is copy", () => {
  assert.deepEqual(pastePlan({ machine: "box", path: "/srv/a", isDir: false, at: 1 }, { on: null, folder: "/Users/me/Downloads" }), { direction: "down", machine: "box", srcs: ["/srv/a"], destDir: "/Users/me/Downloads" });
});
test("cut gives a move plan only within one machine", () => {
  assert.deepEqual(pastePlan(C, { on: "box", folder: "/srv/in" }), { direction: "remote", machine: "box", srcs: ["/srv/d/a.txt"], destDir: "/srv/in", move: true });
  assert.deepEqual(pastePlan(LC, { on: null, folder: "/Users/me/git" }), { direction: "local", machine: null, srcs: ["/Users/me/a"], destDir: "/Users/me/git", move: true });
  for (const [clip, on] of [[C, null], [C, "other"], [LC, "box"]]) assert.deepEqual(pastePlan(clip, { on, folder: "/x" }), { error: "Cut and Paste work only within one machine" });
});
test("cut then paste on another machine is dimmed", () => {
  assert.deepEqual(pasteState(C, null), { enabled: false, reason: "Cut and Paste work only within one machine" });
  assert.deepEqual(pasteState(C, "other"), { enabled: false, reason: "Cut and Paste work only within one machine" });
  assert.deepEqual(pasteState(C, "box"), { enabled: true, reason: null });
});
test("cut then paste into the own folder is dimmed, copy is not", () => {
  assert.deepEqual(pasteState(C, "box", "/srv/d"), { enabled: false, reason: "Already in this folder" });
  assert.deepEqual(pasteState(C, "box", "/srv/d/"), { enabled: false, reason: "Already in this folder" });
  assert.deepEqual(pasteState(C, "box", "/srv/d/sub"), { enabled: true, reason: null });
  assert.deepEqual(pasteState(R, "box", "/srv"), { enabled: true, reason: null });
});
test("a copy across two machines is a cross plan, the target machine is machine", () => {
  assert.deepEqual(pastePlan(clipEntry({ on: "a", items: [{ path: "/s/x", isDir: false }], at: 1 }), { on: "b", folder: "/d" }), { direction: "cross", from: "a", machine: "b", srcs: ["/s/x"], destDir: "/d" });
  assert.deepEqual(pastePlan(R, { on: "box", folder: "/d" }).direction, "remote");
});
test("pasteState: Copy a to b is enabled, Cut a to b is not", () => {
  const a = clipEntry({ on: "a", items: [{ path: "/s/x", isDir: false }], at: 1 });
  assert.deepEqual(pasteState(a, "b", "/d"), { enabled: true, reason: null });
  assert.deepEqual(pasteState({ ...a, cut: true }, "b", "/d"), { enabled: false, reason: "Cut and Paste work only within one machine" });
});

// ---- #99: the clipboard holds a list
const OLD = { machine: "box", path: "/srv/d", isDir: true, at: 2 };
test("#99 clipItems reads a list and an old single entry", () => {
  assert.deepEqual(clipItems(OLD), [{ path: "/srv/d", isDir: true }]);
  assert.deepEqual(clipItems({ items: [{ path: "/a", isDir: false }, { path: "", isDir: true }, { isDir: true }, { path: "/b", isDir: true }] }), [{ path: "/a", isDir: false }, { path: "/b", isDir: true }]);
  assert.deepEqual(clipItems(null), []);
  assert.deepEqual(clipItems({}), []);
  assert.deepEqual(clipItems({ items: [] }), []);
});
test("#99 an old entry plans like the same list of one", () => {
  const list = clipEntry({ on: "box", items: [{ path: "/srv/d", isDir: true }], at: 2 });
  for (const [on, folder] of [["box", "/srv/in"], [null, "/Users/m/Downloads"], ["other", "/srv"]]) assert.deepEqual(pastePlan(OLD, { on, folder }), pastePlan(list, { on, folder }));
  assert.deepEqual(pasteState({ ...OLD, cut: true }, "box", "/srv"), pasteState({ ...list, cut: true }, "box", "/srv"));
});
test("#99 pastePlan lists every source in order; an empty list has nothing to paste", () => {
  const two = clipEntry({ on: null, items: [{ path: "/Users/m/b", isDir: false }, { path: "/Users/m/a", isDir: true }], at: 1 });
  assert.deepEqual(pastePlan(two, { on: null, folder: "/d" }).srcs, ["/Users/m/b", "/Users/m/a"]);
  assert.deepEqual(pastePlan({ ...two, cut: true }, { on: null, folder: "/d" }), { direction: "local", machine: null, srcs: ["/Users/m/b", "/Users/m/a"], destDir: "/d", move: true });
  assert.deepEqual(pastePlan({ machine: null, items: [], at: 1 }, { on: null, folder: "/d" }), { error: "Nothing to paste" });
});
test("#99 pasteState dims a Cut only when every item is already in the folder", () => {
  const cut = (...paths) => clipEntry({ on: "box", items: paths.map((path) => ({ path, isDir: false })), at: 1, cut: true });
  assert.deepEqual(pasteState(cut("/srv/in/a", "/srv/b"), "box", "/srv/in"), { enabled: true, reason: null });
  assert.deepEqual(pasteState(cut("/srv/in/a", "/srv/in/b"), "box", "/srv/in"), { enabled: false, reason: "Already in this folder" });
});
test("#99 sameClip compares machine, time and item paths", () => {
  const a = clipEntry({ on: "box", items: [{ path: "/a", isDir: false }], at: 1 });
  assert.equal(sameClip(a, clipEntry({ on: "box", items: [{ path: "/a", isDir: false }], at: 1 })), true);
  assert.equal(sameClip(a, clipEntry({ on: "box", items: [{ path: "/b", isDir: false }], at: 1 })), false);
  assert.equal(sameClip(a, clipEntry({ on: "box", items: [{ path: "/a", isDir: false }], at: 2 })), false);
  assert.equal(sameClip(a, clipEntry({ on: null, items: [{ path: "/a", isDir: false }], at: 1 })), false);
  assert.equal(sameClip({ machine: "box", path: "/a", isDir: false, at: 1 }, a), true, "an old entry reads as a list of one");
  assert.equal(sameClip(a, null), false);
  assert.equal(sameClip(null, null), false);
});
