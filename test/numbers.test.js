import { test } from "node:test";
import assert from "node:assert/strict";
import { group } from "../mods/filer-pro/lib/numbers.js";
import { withoutIntl } from "./no-intl.js";

test("group: thousands with commas, without Intl", async () => {
  await withoutIntl(() => {
    assert.equal(typeof Intl, "undefined");
    assert.deepEqual([0, 10, 999, 1000, 10000, 2000000].map(group), ["0", "10", "999", "1,000", "10,000", "2,000,000"]);
  });
});

test("withoutIntl puts Intl and toLocaleString back", async () => {
  await withoutIntl(() => assert.equal((5000).toLocaleString("en-US"), "5000"));
  assert.equal(typeof Intl, "object");
  assert.equal((5000).toLocaleString("en-US"), "5,000");
});
