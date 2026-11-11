// Issue #21: what a click on a file or package row does (mods/filer-pro/lib/clicks.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileClick, folderClick } from "../mods/filer-pro/lib/clicks.js";

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

test("folderClick (#90): with the setting on, press 1 toggles, press 2 shows as root, press 3 does nothing", () => {
  assert.equal(folderClick({ click_count: 1 }, true), "toggle");
  assert.equal(folderClick({ click_count: 2 }, true), "root");
  assert.equal(folderClick({ click_count: 3 }, true), null);
  assert.equal(folderClick({}, true), "toggle", "an event without a count is one click");
});

test("folderClick (#90): with the setting off every press toggles", () => {
  for (const n of [1, 2, 3]) assert.equal(folderClick({ click_count: n }, false), "toggle");
});
