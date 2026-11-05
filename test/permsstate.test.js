// lib/permsstate.js: the state behind the Permissions dialog (pure): checkboxes and the octal field in sync both ways,
// read only cases, when Apply is possible and the notes shown live under the fields.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPermsState, loaded, failed, toggleBit, setText, setRecursive, canApply, notes, counted, needsCount, readOnlyReason } from "../mods/filer-pro/lib/permsstate.js";

const probe = (over = {}) => ({ type: "f", mode: 0o644, uid: "501", gid: "20", user: "alice", group: "staff", me: "501", isDir: false, isLink: false, owned: true, ...over });
const ready = (over = {}, spec = {}) => loaded(createPermsState({ name: "a.txt", isDir: false, ...spec }), probe(over));

test("a new state is loading and cannot be applied", () => {
  const s = createPermsState({ name: "a.txt", isDir: false });
  assert.equal(s.phase, "loading");
  assert.equal(canApply(s), false);
  assert.equal("stage" in s, false, "there is no confirmation step");
});

test("loaded: mode, octal text and owner are taken from the probe", () => {
  const s = ready();
  assert.equal(s.phase, "ready");
  assert.equal(s.mode, 0o644);
  assert.equal(s.original, 0o644);
  assert.equal(s.text, "644");
  assert.equal(s.readOnly, null);
  assert.equal(s.owner, "alice");
  assert.equal(s.group, "staff");
});

test("failed: the message is kept and nothing can be applied", () => {
  const s = failed(createPermsState({ name: "a", isDir: false }), "No such file or folder: /x");
  assert.equal(s.phase, "error");
  assert.equal(s.error, "No such file or folder: /x");
  assert.equal(canApply(s), false);
});

test("a checkbox changes the octal text, the octal text changes the checkboxes", () => {
  const s = ready();
  toggleBit(s, "group", "w");
  assert.equal(s.mode, 0o664);
  assert.equal(s.text, "664");
  setText(s, "600");
  assert.equal(s.mode, 0o600);
  assert.equal(s.textError, null);
  setText(s, "2755");
  assert.equal(s.mode, 0o2755);
  toggleBit(s, "others", "w");
  assert.equal(s.text, "2757", "special bits stay, the text gets 4 digits");
});

test("an invalid octal text keeps the last good mode, shows an error and blocks Apply until it is fixed", () => {
  const s = ready();
  setText(s, "6");
  assert.equal(s.mode, 0o644);
  assert.match(s.textError, /octal/);
  setText(s, "658");
  assert.ok(s.textError);
  setText(s, "u+x");
  assert.ok(s.textError);
  assert.equal(canApply(s), false);
  setText(s, "640");
  assert.equal(s.textError, null);
  assert.equal(canApply(s), true);
  toggleBit(s, "owner", "x");
  assert.equal(s.text, "740", "a checkbox replaces a wrong text");
  setText(s, "9");
  toggleBit(s, "owner", "x");
  assert.equal(s.textError, null);
});

test("Apply needs a change, or the recursive box for a folder", () => {
  const s = ready();
  assert.equal(canApply(s), false);
  toggleBit(s, "others", "r");
  assert.equal(canApply(s), true);
  toggleBit(s, "others", "r");
  assert.equal(canApply(s), false, "changed back");
  const d = ready({ type: "d", isDir: true, mode: 0o755 }, { isDir: true });
  setRecursive(d, true);
  assert.equal(d.recursive, true);
  assert.equal(canApply(d), true);
  const f = ready();
  setRecursive(f, true);
  assert.equal(f.recursive, false, "only a folder has the box");
});

test("not the owner: read only with the reason, nothing can be changed or applied", () => {
  const s = ready({ uid: "0", owned: false, me: "501" });
  assert.equal(s.readOnly, "Not the owner, permissions cannot be changed");
  toggleBit(s, "others", "w");
  setText(s, "777");
  setRecursive(s, true);
  assert.equal(s.mode, 0o644);
  assert.equal(s.text, "644");
  assert.equal(s.recursive, false);
  assert.equal(canApply(s), false);
});

test("a symbolic link: the target's permissions, read only, with the reason", () => {
  const s = ready({ type: "l", isLink: true });
  assert.match(s.readOnly, /symbolic link/i);
  assert.match(s.readOnly, /target/);
  assert.equal(canApply(s), false);
  assert.equal(readOnlyReason(probe({ type: "l", isLink: true, owned: false })), s.readOnly, "the link comes first");
});

test("busy blocks Apply and changes", () => {
  const s = ready();
  toggleBit(s, "others", "r");
  s.busy = true;
  assert.equal(canApply(s), false);
});

const texts = (s) => notes(s).map((n) => n.text);
const levels = (s) => notes(s).map((n) => n.level);

test("notes: never empty; no change, or the change without warnings, as a quiet summary", () => {
  assert.deepEqual(notes(createPermsState({ name: "a", isDir: false })), [{ level: "info", text: "Reading permissions…" }]);
  const s = ready();
  assert.deepEqual(notes(s), [{ level: "info", text: "No changes." }]);
  toggleBit(s, "others", "r");
  assert.deepEqual(notes(s), [{ level: "ok", text: "644 → 640, no warnings." }]);
});

test("notes: warnings appear and go away live while the mode is edited", () => {
  const s = ready();
  setText(s, "666");
  assert.deepEqual(levels(s), ["warning"]);
  assert.match(texts(s)[0], /World writable/);
  toggleBit(s, "others", "w");
  assert.deepEqual(levels(s), ["ok"], "the warning is gone with the bit");
  setText(s, "044");
  assert.ok(texts(s).some((x) => /your own read and write permission/.test(x)));
  setText(s, "4644");
  assert.ok(texts(s).some((x) => /sets setuid/.test(x)));
});

test("notes: a file that already is world writable warns before anything is edited", () => {
  const s = ready({ mode: 0o666 });
  assert.deepEqual(levels(s), ["warning"]);
});

test("notes: Apply to enclosed items shows the count of the entries inside, counting first", () => {
  const d = ready({ type: "d", isDir: true, mode: 0o755 }, { isDir: true });
  setRecursive(d, true);
  assert.equal(needsCount(d), true);
  d.counting = true;
  assert.equal(needsCount(d), false, "one count at a time");
  assert.ok(texts(d).includes("Counting the items inside…"));
  counted(d, 3);
  assert.equal(needsCount(d), false, "counted once per dialog");
  assert.deepEqual(levels(d), ["warning", "info"]);
  assert.match(texts(d)[0], /Files inside become executable/);
  assert.equal(texts(d)[1], "Also sets this mode on 3 items inside (links are skipped).");
  counted(d, 10001);
  assert.match(texts(d)[1], /more than 10,000 items/);
  counted(d, null);
  assert.match(texts(d)[1], /many items/);
  setRecursive(d, false);
  assert.deepEqual(levels(d), ["info"], "unticked: nothing about the inside");
});

test("notes: blocking messages come first; read only shows only its reason", () => {
  const s = ready();
  setText(s, "66");
  assert.equal(levels(s)[0], "error");
  assert.match(texts(s)[0], /octal/);
  const r = ready({ uid: "0", owned: false, me: "501", mode: 0o666 });
  assert.deepEqual(notes(r), [{ level: "note", text: "Not the owner, permissions cannot be changed" }]);
  assert.deepEqual(notes(failed(createPermsState({ name: "a", isDir: false }), "No such file or folder: /x")), [{ level: "error", text: "No such file or folder: /x" }]);
  const e = ready();
  toggleBit(e, "others", "r");
  e.error = "Permission denied";
  assert.deepEqual(notes(e)[0], { level: "error", text: "Permission denied" });
  toggleBit(e, "others", "r");
  assert.equal(e.error, null, "an edit replaces the message of a refused apply");
});
