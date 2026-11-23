import { test } from "node:test";
import assert from "node:assert/strict";
import { MOVE_MARK, moveDetail } from "../mods/filer-pro/lib/movetext.js";

test("MOVE_MARK is the scissors", () => assert.equal(MOVE_MARK, "✂"));
test("moveDetail: every phase for a remote and a local source", () => {
  const r = (state, x = {}) => ({ state, move: { srcOn: "host-a.example.com" }, ...x }), l = (state, x = {}) => ({ state, move: { srcOn: null }, ...x });
  assert.equal(moveDetail(r("running"), "1 MB / 2 MB"), "1 MB / 2 MB · then deletes the original on host-a.example.com");
  assert.equal(moveDetail(l("running"), "b"), "b · then moves the original to the Trash");
  assert.equal(moveDetail(r("verifying"), "b"), "Checking the copy…");
  assert.equal(moveDetail(r("deleting"), "b"), "Deleting the original on host-a.example.com…");
  assert.equal(moveDetail(l("deleting"), "b"), "Moving the original to the Trash…");
  assert.equal(moveDetail(r("done", { moved: true }), "2 MB"), "2 MB · Moved. The original on host-a.example.com is deleted.");
  assert.equal(moveDetail(l("done", { moved: true, trashed: true }), "2 MB"), "2 MB · Moved. The original is in the Trash.");
  assert.equal(moveDetail(r("done", { kept: "x" }), "2 MB"), "2 MB · Copied. The original is kept.");
  for (const s of ["failed", "cancelled"]) assert.equal(moveDetail(r(s), "base"), "base");
});
