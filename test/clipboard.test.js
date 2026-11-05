import { test } from "node:test";
import assert from "node:assert/strict";
import { clipEntry, pastePlan, pasteState } from "../mods/filer-pro/lib/clipboard.js";

const L = clipEntry({ on: null, path: "/Users/m/a.txt", isDir: false, at: 1 });
const R = clipEntry({ on: "box", path: "/srv/d", isDir: true, at: 2 });

test("clipEntry normalizes machine and isDir", () => {
  assert.deepEqual(L, { machine: null, path: "/Users/m/a.txt", isDir: false, at: 1 });
  assert.deepEqual(clipEntry({ on: undefined, path: "/p", isDir: "yes", at: 3 }), { machine: null, path: "/p", isDir: false, at: 3 });
});
test("pastePlan picks the direction from source and target side", () => {
  assert.deepEqual(pastePlan(L, { on: null, folder: "/Users/m/git" }), { direction: "local", machine: null, src: "/Users/m/a.txt", destDir: "/Users/m/git" });
  assert.deepEqual(pastePlan(R, { on: "box", folder: "/srv/in" }), { direction: "remote", machine: "box", src: "/srv/d", destDir: "/srv/in" });
  assert.deepEqual(pastePlan(R, { on: null, folder: "/Users/m/Downloads" }), { direction: "down", machine: "box", src: "/srv/d", destDir: "/Users/m/Downloads" });
  assert.deepEqual(pastePlan(L, { on: "box", folder: "/srv/in" }), { direction: "up", machine: "box", src: "/Users/m/a.txt", destDir: "/srv/in" });
  assert.deepEqual(pastePlan(R, { on: "other", folder: "/srv" }), { error: "Paste between two machines is not supported" });
  assert.deepEqual(pastePlan(null, { on: null, folder: "/x" }), { error: "Nothing to paste" });
  assert.deepEqual(pastePlan({}, { on: null, folder: "/x" }), { error: "Nothing to paste" });
});
test("pasteState mirrors pastePlan for the menu", () => {
  assert.deepEqual(pasteState(null, null), { enabled: false, reason: "Nothing to paste" });
  assert.deepEqual(pasteState(R, "other"), { enabled: false, reason: "Paste between two machines is not supported" });
  assert.deepEqual(pasteState(R, "box"), { enabled: true, reason: null });
  assert.deepEqual(pasteState(L, "box"), { enabled: true, reason: null });
});

const C = clipEntry({ on: "box", path: "/srv/d/a.txt", isDir: false, at: 3, cut: true });
const LC = clipEntry({ on: null, path: "/Users/me/a", isDir: true, at: 1, cut: true });
test("clip with cut sets the mark, a later copy clears it", () => {
  assert.deepEqual(C, { machine: "box", path: "/srv/d/a.txt", isDir: false, at: 3, cut: true });
  assert.deepEqual(clipEntry({ on: "box", path: "/srv/d/a.txt", isDir: false, at: 4 }), { machine: "box", path: "/srv/d/a.txt", isDir: false, at: 4 });
  assert.equal("cut" in clipEntry({ on: null, path: "/p", isDir: false, at: 1, cut: "yes" }), false);
});
test("legacy clipboard without cut is copy", () => {
  assert.deepEqual(pastePlan({ machine: "box", path: "/srv/a", isDir: false, at: 1 }, { on: null, folder: "/Users/me/Downloads" }), { direction: "down", machine: "box", src: "/srv/a", destDir: "/Users/me/Downloads" });
});
test("cut gives a move plan only within one machine", () => {
  assert.deepEqual(pastePlan(C, { on: "box", folder: "/srv/in" }), { direction: "remote", machine: "box", src: "/srv/d/a.txt", destDir: "/srv/in", move: true });
  assert.deepEqual(pastePlan(LC, { on: null, folder: "/Users/me/git" }), { direction: "local", machine: null, src: "/Users/me/a", destDir: "/Users/me/git", move: true });
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
