import { test } from "node:test";
import assert from "node:assert/strict";
import { conflictText, conflictHint, crossTitle, crossText, CROSS_DONT_SHOW, deleteText } from "../mods/filer-pro/lib/conflicttext.js";
import { handleRequest } from "../mods/filer-pro/lib/requests.js";

const f = (o = {}) => ({ name: "a.txt", isDir: false, ...o });
const d = (o = {}) => f({ name: "docs", isDir: true, ...o });

test("local file replace goes to the Trash (copy, paste, download)", () => {
  for (const direction of ["local", "down"]) {
    assert.equal(conflictHint(f({ direction, machine: direction === "down" ? "box" : null })), "Replace moves the existing file to the Trash.");
  }
});

test("remote file replace deletes permanently and names the machine (upload, copy on the machine)", () => {
  for (const direction of ["up", "remote"]) {
    assert.equal(conflictHint(f({ direction, machine: "box" })), "Replace deletes the existing file on box permanently.");
  }
});

test("folder: Merge overwrites files with the same name, locally and on a machine", () => {
  assert.equal(conflictHint(d({ direction: "local", machine: null })),
    "Replace moves the existing folder to the Trash. Merge overwrites files with the same name.");
  assert.equal(conflictHint(d({ direction: "up", machine: "box" })),
    "Replace deletes the existing folder on box permanently. Merge overwrites files with the same name.");
  assert.equal(conflictHint(d({ direction: "down", machine: "box" })),
    "Replace moves the existing folder to the Trash. Merge overwrites files with the same name.");
});

test("move: no Merge, kind from the target, Trash locally and permanent on the machine", () => {
  assert.equal(conflictHint(d({ action: "move", destIsDir: false, direction: "local", machine: null })), "Replace moves the existing file to the Trash.");
  assert.equal(conflictHint(f({ action: "move", destIsDir: true, direction: "remote", machine: "box" })), "Replace deletes the existing folder on box permanently.");
});

test("conflictText keeps the sentence and appends the hint", () => {
  assert.equal(conflictText(f({ direction: "up", machine: "box" })),
    'A file named "a.txt" already exists in the target folder. Replace deletes the existing file on box permanently.');
});

test("an upload puts direction and machine into the dialog item", async () => {
  const asked = [];
  const deps = {
    jobs: { inspect: async () => ({ name: "a.txt", isDir: false, exists: true, linkWarning: null }), start: async () => ({ id: "j1" }) },
    ask: async (p) => (asked.push(p), { choice: "replace" }),
    newBatchId: () => "b1", getShared: () => null, setShared: () => {}, loadConfig: async () => ({ download_folder: "/d" }),
  };
  await handleRequest({ action: "upload", machine: "box", paths: ["/Users/me/a.txt"], folder: "/srv/in" }, deps);
  assert.match(conflictText(asked[0].item), /Replace deletes the existing file on box permanently\./);
});

test("a folder that cannot be merged (#46): the hint says so instead of the Merge sentence", () => {
  assert.equal(conflictHint(d({ direction: "local", machine: null, mergeError: "Cannot merge a symlink into a folder: /x/docs" })),
    "Replace moves the existing folder to the Trash. A symlink cannot be merged.");
  assert.equal(conflictHint(d({ direction: "remote", machine: "box", mergeError: "Cannot merge a symlink into a folder: /x/docs" })),
    "Replace deletes the existing folder on box permanently. A symlink cannot be merged.");
});

test("#54: a copy names the kind of the target, not of the source", () => {
  assert.equal(conflictHint(f({ direction: "remote", machine: "box", destIsDir: true })),
    "Replace deletes the existing folder on box permanently.");
  assert.equal(conflictText(f({ direction: "local", machine: null, destIsDir: true })),
    'A folder named "a.txt" already exists in the target folder. Replace moves the existing folder to the Trash.');
});

test("#54: a folder over a file offers no Merge in the hint", () => {
  assert.equal(conflictHint(d({ direction: "up", machine: "box", destIsDir: false })),
    "Replace deletes the existing file on box permanently.");
  assert.equal(conflictHint(d({ direction: "local", machine: null, destIsDir: true })),
    "Replace moves the existing folder to the Trash. Merge overwrites files with the same name.");
});

test("cross: the warning names both machines by their herdr names, the amount, and this computer (approved design)", () => {
  assert.equal(crossTitle({ from: "build-box", machine: "web-01" }), "Copy from build-box to web-01?");
  assert.equal(crossText({ from: "build-box", machine: "web-01", count: 3, size: 48_100_000 }),
    "3 items, 48 MB. The data travels through this computer: build-box → this computer → web-01. Slower than a direct copy, and it uses this computer's connection twice.");
  // One entry, size unknown (null or slow): no size, never "this Mac".
  const one = crossText({ from: "a", machine: "b", count: 1, size: null });
  assert.equal(one, "1 item. The data travels through this computer: a → this computer → b. Slower than a direct copy, and it uses this computer's connection twice.");
  assert.equal(crossText({ from: "a", machine: "b" }), one);
  assert.doesNotMatch(one, /Mac/);
  assert.equal(CROSS_DONT_SHOW, "Don't show again");
});

test("cross: Replace deletes on the target machine", () => {
  assert.equal(conflictHint(f({ direction: "cross", from: "a", machine: "b" })), "Replace deletes the existing file on b permanently.");
});

test("#99 deleteText: one item keeps today's texts", () => {
  assert.deepEqual(deleteText({ name: "a.txt", isDir: false, path: "/Users/m/a.txt", machine: null, trash: true }),
    { title: "Delete file?", body: 'Move "a.txt" to the Trash?', lines: ["/Users/m/a.txt"] });
  assert.deepEqual(deleteText({ name: "d", isDir: true, path: "/srv/d", machine: "box", trash: false }),
    { title: "Delete folder?", body: 'Delete "d" on box? This cannot be undone.', lines: ["/srv/d"] });
});
test("#99 deleteText: several items list the names, at most what the item carries, then and N more", () => {
  const names = ["a", "b", "c", "d", "e"];
  assert.deepEqual(deleteText({ count: 7, names, more: 2, trash: true, machine: null }),
    { title: "Delete 7 items?", body: "Move 7 items to the Trash?", lines: [...names, "and 2 more"] });
  assert.deepEqual(deleteText({ count: 3, names: ["a", "b", "c"], more: 0, trash: false, machine: "box" }),
    { title: "Delete 3 items?", body: "Delete 3 items on box? This cannot be undone.", lines: ["a", "b", "c"] });
  assert.equal(deleteText({ count: 1200, names: [], more: 1200, trash: true }).title, "Delete 1,200 items?");
});

// ---- #100: move
import { moveTitle, moveText, moveNote } from "../mods/filer-pro/lib/conflicttext.js";
const A = "host-a.example.com", B = "host-b.example.com";
test("moveTitle names both sides with this computer for the local one", () => {
  assert.equal(moveTitle({ from: A, machine: null }), `Move from ${A} to this computer?`);
  assert.equal(moveTitle({ from: null, machine: A }), `Move from this computer to ${A}?`);
  assert.equal(moveTitle({ from: A, machine: B }), `Move from ${A} to ${B}?`);
});
test("moveText: down, up and cross for one item and for three", () => {
  const f = { size: 48_000_000, isDir: false };
  assert.equal(moveText({ ...f, from: A, machine: null, direction: "down", count: 1 }), `1 file, 48 MB. Filer Pro copies it to this computer, checks that the copy is complete, and only then deletes the original on ${A}.`);
  assert.equal(moveText({ ...f, isDir: true, from: A, machine: null, direction: "down", count: 1 }).startsWith("1 folder, 48 MB."), true);
  assert.equal(moveText({ ...f, from: A, machine: null, direction: "down", count: 3 }), `3 items, 48 MB. Filer Pro copies them to this computer, checks that the copies are complete, and only then deletes the originals on ${A}.`);
  assert.equal(moveText({ ...f, from: null, machine: A, direction: "up", count: 1 }), `1 file, 48 MB. Filer Pro copies it to ${A}, checks that the copy is complete, and then moves the original to the Trash on this computer.`);
  assert.equal(moveText({ ...f, from: null, machine: A, direction: "up", count: 3 }), `3 items, 48 MB. Filer Pro copies them to ${A}, checks that the copies are complete, and then moves the originals to the Trash on this computer.`);
  assert.equal(moveText({ ...f, from: A, machine: B, direction: "cross", count: 1 }), `1 file, 48 MB. The data travels through this computer. Filer Pro checks the copy on ${B}, then deletes the original on ${A}.`);
  assert.equal(moveText({ ...f, from: A, machine: B, direction: "cross", count: 3 }), `3 items, 48 MB. The data travels through this computer. Filer Pro checks the copies on ${B}, then deletes the originals on ${A}.`);
  assert.equal(moveText({ isDir: false, from: A, machine: null, direction: "down", count: 1, size: null }).startsWith("1 file. "), true);
});
test("moveNote: permanent on a machine, Trash locally", () => {
  assert.equal(moveNote({ from: A, count: 1 }), `The original on ${A} is deleted permanently. It does not go to a Trash.`);
  assert.equal(moveNote({ from: A, count: 3 }), `The originals on ${A} are deleted permanently. They do not go to a Trash.`);
  assert.equal(moveNote({ from: null, count: 1 }), "You can put the original back from the Trash.");
  assert.equal(moveNote({ from: null, count: 2 }), "You can put the originals back from the Trash.");
});
