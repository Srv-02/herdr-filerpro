// Issue #21: what a click on a file or package row does (mods/filer-pro/lib/clicks.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileClick } from "../mods/filer-pro/lib/clicks.js";

test("fileClick with a double click: one press marks, the second press opens, a third does nothing", () => {
  assert.equal(fileClick({ click_count: 1 }, true), "select");
  assert.equal(fileClick({ click_count: 2 }, true), "open");
  assert.equal(fileClick({ click_count: 3 }, true), null);
  assert.equal(fileClick({}, true), "select", "an event without a count is one click");
  assert.equal(fileClick(undefined, true), "select");
});

test("fileClick with a single click: the first press opens, the rest of a double or triple click does nothing", () => {
  assert.equal(fileClick({ click_count: 1 }, false), "open");
  assert.equal(fileClick({ click_count: 2 }, false), null);
  assert.equal(fileClick({ click_count: 3 }, false), null);
  assert.equal(fileClick({}, false), "open");
});
