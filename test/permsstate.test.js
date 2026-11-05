// lib/permsstate.js: the state behind the Permissions dialog (pure): checkboxes and the octal field in sync both ways,
// read only cases, when Apply is possible and what the confirmation shows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPermsState, loaded, failed, toggleBit, setText, setRecursive, canApply, review, readOnlyReason } from "../mods/filer-pro/lib/permsstate.js";

const probe = (over = {}) => ({ type: "f", mode: 0o644, uid: "501", gid: "20", user: "alice", group: "staff", me: "501", isDir: false, isLink: false, owned: true, ...over });
const ready = (over = {}, spec = {}) => loaded(createPermsState({ name: "a.txt", isDir: false, ...spec }), probe(over));

test("a new state is loading and cannot be applied", () => {
  const s = createPermsState({ name: "a.txt", isDir: false });
  assert.equal(s.phase, "loading");
  assert.equal(canApply(s), false);
  assert.equal(s.stage, "edit");
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

test("review: old and new mode and the warnings", () => {
  const s = ready();
  setText(s, "666");
  assert.deepEqual(review(s, null).change, "644 → 666");
  assert.ok(review(s, null).warnings.some((w) => /world writable/.test(w)));
  const d = ready({ type: "d", isDir: true, mode: 0o755 }, { isDir: true });
  toggleBit(d, "others", "x");
  setRecursive(d, true);
  const r = review(d, 12);
  assert.equal(r.change, "755 → 754");
  assert.ok(r.warnings.some((w) => /12 items/.test(w)));
  assert.ok(review(d, null).warnings.some((w) => /many items/.test(w)));
  const plain = ready();
  toggleBit(plain, "others", "r");
  assert.deepEqual(review(plain, null).warnings, []);
});
