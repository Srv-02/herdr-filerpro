// Issue #98: which tree rows are selected (mods/filer-pro/lib/selection.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { toggle, range, applyClick, clearSelection, collapse, prune } from "../mods/filer-pro/lib/selection.js";

const S = (...a) => new Set(a);
const sorted = (s) => [...s].sort();

test("toggle adds a missing path, removes a present one and never mutates the input", () => {
  const a = S("x");
  const b = toggle(a, "y");
  assert.deepEqual(sorted(b), ["x", "y"]);
  assert.deepEqual(sorted(a), ["x"]);
  assert.deepEqual(sorted(toggle(b, "x")), ["y"]);
  assert.deepEqual(sorted(b), ["x", "y"]);
});

test("range is inclusive, works in both directions and falls back to the clicked path", () => {
  const order = ["a", "b", "c", "d"];
  assert.deepEqual(range(order, "b", "d"), ["b", "c", "d"]);
  assert.deepEqual(range(order, "d", "b"), ["b", "c", "d"]);
  assert.deepEqual(range(order, "zz", "d"), ["d"]);
  assert.deepEqual(range(order, "b", "zz"), ["zz"]);
});

test("applyClick toggle sets anchor and base; a second toggle removes the row but keeps the anchor", () => {
  const empty = clearSelection();
  const one = applyClick(empty, "toggle", "b", ["a", "b"]);
  assert.deepEqual(sorted(one.selected), ["b"]);
  assert.equal(one.anchor, "b");
  assert.deepEqual(sorted(one.base), ["b"]);
  const two = applyClick(one, "toggle", "b", ["a", "b"]);
  assert.equal(two.selected.size, 0);
  assert.equal(two.anchor, "b");
  assert.equal(two.base.size, 0);
});

test("applyClick range keeps the toggled rows, moves only the end and keeps the anchor", () => {
  const order = ["a", "b", "c", "d", "e"];
  let st = applyClick(clearSelection(), "toggle", "a", order);
  st = applyClick(st, "toggle", "c", order);
  assert.deepEqual(sorted(st.base), ["a", "c"]);
  st = applyClick(st, "range", "e", order);
  assert.deepEqual(sorted(st.selected), ["a", "c", "d", "e"]);
  st = applyClick(st, "range", "d", order);
  assert.deepEqual(sorted(st.selected), ["a", "c", "d"]);
  assert.equal(st.anchor, "c");
});

test("applyClick range upwards", () => {
  const order = ["a", "b", "c", "d"];
  let st = applyClick(clearSelection(), "toggle", "c", order);
  st = applyClick(st, "range", "a", order);
  assert.deepEqual(sorted(st.selected), ["a", "b", "c"]);
});

test("applyClick range without an anchor acts as a toggle", () => {
  const st = applyClick(clearSelection(), "range", "b", ["a", "b"]);
  assert.deepEqual(sorted(st.selected), ["b"]);
  assert.equal(st.anchor, "b");
});

test("applyClick range with an anchor that is not in order acts as a toggle", () => {
  let st = applyClick(clearSelection(), "toggle", "src/x", ["src", "src/x", "z"]);
  st = applyClick(st, "range", "z", ["src", "z"]);
  assert.equal(st.anchor, "z");
  assert.ok(st.selected.has("z"));
  assert.ok(st.selected.has("src/x"), "a toggle keeps the rest of the selection");
});

test("a collapsed folder counts as one row", () => {
  const order = ["docs", "src", "z.txt"];
  let st = applyClick(clearSelection(), "toggle", "docs", order);
  st = applyClick(st, "range", "z.txt", order);
  assert.deepEqual(sorted(st.selected), ["docs", "src", "z.txt"]);
  assert.ok(![...st.selected].some((p) => p.startsWith("src/")));
});

test("applyClick range never brings back base paths that left order (amendment 1a)", () => {
  let st = applyClick(clearSelection(), "toggle", "a", ["a", "src", "src/x.js", "b"]);
  st = applyClick(st, "toggle", "src/x.js", ["a", "src", "src/x.js", "b"]);
  st = applyClick(st, "toggle", "a", ["a", "src", "b"]);
  st = applyClick(st, "range", "b", ["a", "src", "b"]);
  assert.ok(!st.selected.has("src/x.js"));
  assert.deepEqual(sorted(st.selected), ["a", "b", "src"]);
});

test("collapse drops every path with an ancestor in the list", () => {
  assert.deepEqual(collapse(["src", "src/a.js", "b", "srcx"]), ["src", "b", "srcx"]);
});

test("prune keeps only paths that still exist as non-note entries", () => {
  const entries = new Map([
    ["", [{ name: "src", dir: true }, { name: "a.txt" }, { note: true, name: "gone.txt" }]],
    ["src", [{ name: "x.js" }]],
  ]);
  const out = prune(S("a.txt", "gone.txt", "src/x.js", "src/y.js", "other/z"), entries);
  assert.deepEqual(sorted(out), ["a.txt", "src/x.js"]);
});
