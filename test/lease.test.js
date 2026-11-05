import { test } from "node:test";
import assert from "node:assert/strict";
import { leaseNext, staleLegacyKeys } from "../mods/filer-pro/lib/lease.js";

test("no lease: take over and write", () => {
  assert.deepEqual(leaseNext(null, "me", 100), { owner: "me", at: 100, mine: true, write: true });
});
test("own lease: not rewritten before 5 s, renewed from 5 s", () => {
  assert.deepEqual(leaseNext({ owner: "me", at: 1000 }, "me", 5999), { owner: "me", at: 1000, mine: true, write: false });
  assert.deepEqual(leaseNext({ owner: "me", at: 1000 }, "me", 6000), { owner: "me", at: 6000, mine: true, write: true });
});
test("foreign lease: kept at 14999 ms, taken over at 15001 ms", () => {
  assert.deepEqual(leaseNext({ owner: "o", at: 1000 }, "me", 15999), { owner: "o", at: 1000, mine: false, write: false });
  assert.deepEqual(leaseNext({ owner: "o", at: 1000 }, "me", 16001), { owner: "me", at: 16001, mine: true, write: true });
});
test("legacy keys: only those holding a value are returned", () => {
  const store = { "fileshare.jobs": {}, "fileshare.lease": null, "filer-pro.jobs": {}, "file-pro.show": 1, "file-pro.lease": null };
  assert.deepEqual(staleLegacyKeys((k) => store[k]), ["fileshare.jobs", "file-pro.show"]);
  assert.deepEqual(staleLegacyKeys(() => undefined), []);
});
