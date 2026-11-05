import { test } from "node:test";
import assert from "node:assert/strict";
import { createBatch } from "../mods/filer-pro/lib/batch.js";

const f = (key, exists = true, extra = {}) => ({ key, name: key, isDir: false, exists, ...extra });
const d = (key, exists = true, extra = {}) => ({ key, name: key, isDir: true, exists, ...extra });

test("items without conflict need no question and get choice new", () => {
  const b = createBatch([f("a", false), d("b", false)]);
  assert.equal(b.next(), null);
  assert.equal(b.decision("a"), "new");
  assert.equal(b.decision("b"), "new");
});
test("three conflicts: keep_both for all answers every item", () => {
  const b = createBatch([f("a"), f("b"), f("c")]);
  assert.equal(b.next().key, "a");
  b.answer("keep_both", true);
  assert.equal(b.next(), null);
  for (const k of ["a", "b", "c"]) assert.equal(b.decision(k), "keep_both");
});
test("without apply to all each conflict is asked in turn", () => {
  const b = createBatch([f("a"), f("b")]);
  assert.equal(b.next().key, "a");
  b.answer("replace", false);
  assert.equal(b.next().key, "b");
  b.answer("cancel", false);
  assert.equal(b.next(), null);
  assert.equal(b.decision("a"), "replace");
  assert.equal(b.decision("b"), "cancel");
});
test("apply to all with merge: folders merge, the file stays open", () => {
  const b = createBatch([d("x"), f("y"), d("z")]);
  assert.equal(b.next().key, "x");
  b.answer("merge", true);
  assert.equal(b.decision("x"), "merge");
  assert.equal(b.decision("z"), "merge");
  assert.equal(b.decision("y"), undefined);
  assert.equal(b.next().key, "y");
});
test("merge answered for a file is stored as replace", () => {
  const b = createBatch([f("a"), f("b")]);
  b.answer("merge", false);
  assert.equal(b.decision("a"), "replace");
  b.answer("merge", true);
  assert.equal(b.decision("b"), "replace");
});
test("choices differ for files, folders and link warnings", () => {
  const b = createBatch([f("a"), d("b", true, { linkWarning: "w" })]);
  assert.deepEqual(b.choices(b.next()), ["transfer_anyway", "cancel"]);
  assert.deepEqual(b.choices(f("a")), ["replace", "keep_both", "cancel"]);
  assert.deepEqual(b.choices(d("b")), ["merge", "replace", "keep_both", "cancel"]);
});
test("link warnings are asked before conflicts; cancel ends the item", () => {
  const b = createBatch([d("a", true, { linkWarning: "w1" }), d("b", true, { linkWarning: "w2" }), f("c")]);
  assert.equal(b.next().key, "a");
  b.answer("transfer_anyway", false);
  assert.equal(b.next().key, "b");
  b.answer("cancel", false);
  assert.equal(b.decision("b"), "cancel");
  const n = b.next();
  assert.equal(n.key, "a");
  assert.deepEqual(b.choices(n), ["merge", "replace", "keep_both", "cancel"]);
  b.answer("merge", false);
  assert.equal(b.next().key, "c");
  b.answer("replace", false);
  assert.equal(b.next(), null);
  assert.equal(b.decision("a"), "merge");
});
test("link warning without conflict ends with new after transfer_anyway", () => {
  const b = createBatch([d("a", false, { linkWarning: "w" })]);
  b.answer("transfer_anyway", false);
  assert.equal(b.next(), null);
  assert.equal(b.decision("a"), "new");
});
test("preset answers links and conflicts up front", () => {
  const b = createBatch([d("a", true, { linkWarning: "w" }), f("b"), f("c", false)]);
  b.preset({ links: "transfer_anyway", conflict: "merge" });
  assert.equal(b.next(), null);
  assert.equal(b.decision("a"), "merge");
  assert.equal(b.decision("b"), "replace");
  assert.equal(b.decision("c"), "new");
  const c = createBatch([d("a", false, { linkWarning: "w" })]);
  c.preset({ links: "cancel" });
  assert.equal(c.decision("a"), "cancel");
  const e = createBatch([d("a", true, { linkWarning: "w" })]);
  e.preset({ conflict: "replace" });
  assert.equal(e.next().key, "a");
});
test("remaining counts the same kind still undecided", () => {
  const b = createBatch([f("a"), f("b"), d("c")]);
  assert.equal(b.remaining(b.next()), 2);
});

const blockedDir = (key, extra = {}) => d(key, false, { linkWarning: "loop", linkBlocked: true, ...extra });
test("blocked folder only offers ok; ok and any other answer cancel it", () => {
  for (const choice of ["ok", "cancel", "transfer_anyway"]) {
    const b = createBatch([blockedDir("a")]);
    assert.deepEqual(b.choices(b.next()), ["ok"]);
    b.answer(choice, false);
    assert.equal(b.next(), null);
    assert.equal(b.decision("a"), "cancel");
  }
});
test("apply to all keeps blocked and other link folders apart", () => {
  const b = createBatch([blockedDir("a"), d("b", false, { linkWarning: "w" }), blockedDir("c"), d("e", false, { linkWarning: "w" })]);
  assert.equal(b.next().key, "a");
  assert.equal(b.remaining(b.next()), 2);
  b.answer("ok", true);
  assert.equal(b.decision("a"), "cancel");
  assert.equal(b.decision("c"), "cancel");
  const n = b.next();
  assert.equal(n.key, "b");
  assert.deepEqual(b.choices(n), ["transfer_anyway", "cancel"]);
  assert.equal(b.remaining(n), 2);
  b.answer("transfer_anyway", true);
  assert.equal(b.next(), null);
  assert.equal(b.decision("b"), "new");
  assert.equal(b.decision("e"), "new");
  assert.equal(b.decision("c"), "cancel");
});
test("a transfer_anyway answer to all on normal folders never frees a blocked one", () => {
  const b = createBatch([d("b", false, { linkWarning: "w" }), blockedDir("a")]);
  b.answer("transfer_anyway", true);
  assert.equal(b.decision("b"), "new");
  assert.equal(b.decision("a"), undefined);
  assert.deepEqual(b.choices(b.next()), ["ok"]);
});
test("preset transfer_anyway never transfers a blocked folder", () => {
  const b = createBatch([blockedDir("a"), d("b", false, { linkWarning: "w" })]);
  b.preset({ links: "transfer_anyway" });
  assert.equal(b.next(), null);
  assert.equal(b.decision("a"), "cancel");
  assert.equal(b.decision("b"), "new");
});

test("a folder that cannot be merged (#46) is asked without Merge; Apply to all from a real folder still gives it merge", () => {
  const LINK = { mergeError: "Cannot merge a symlink into a folder: /x/link" };
  const b = createBatch([d("link", true, LINK), d("real")]);
  assert.deepEqual(b.choices(b.next()), ["replace", "keep_both", "cancel"]);
  assert.deepEqual(b.choices(d("real")), ["merge", "replace", "keep_both", "cancel"]);
  const c = createBatch([d("real"), d("link", true, LINK)]);
  c.answer("merge", true);
  assert.equal(c.decision("link"), "merge");
});

test("#54: Merge is offered only when source and target are folders", () => {
  assert.deepEqual(createBatch([d("a", true, { destIsDir: false })]).choices(d("a", true, { destIsDir: false })), ["replace", "keep_both", "cancel"]);
  assert.deepEqual(createBatch([d("a", true, { destIsDir: true })]).choices(d("a", true, { destIsDir: true })), ["merge", "replace", "keep_both", "cancel"]);
});

test("#54: Apply to all merge stores replace for a folder over a file and does not cross target kinds", () => {
  const b = createBatch([d("x", true, { destIsDir: true }), d("y", true, { destIsDir: false }), d("z", true, { destIsDir: true })]);
  assert.equal(b.next().key, "x");
  b.answer("merge", true);
  assert.equal(b.decision("x"), "merge");
  assert.equal(b.decision("z"), "merge");
  assert.equal(b.decision("y"), undefined);
  const c = createBatch([d("y", true, { destIsDir: false })]);
  c.preset({ conflict: "merge" });
  assert.equal(c.decision("y"), "replace");
});
