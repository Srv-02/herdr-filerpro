import { test } from "node:test";
import assert from "node:assert/strict";
import { conflictText, conflictHint } from "../mods/filer-pro/lib/conflicttext.js";
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
