// Issue #21: what a click on a file or package row does (mods/filer-pro/lib/clicks.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileClick, folderClick, modifierKey, rowClick } from "../mods/filer-pro/lib/clicks.js";

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

// Issue #98: which of the held modifiers a click carries, and what a row click does with them.
const ev = (mods = {}, n = 1) => ({
  modifiers: { shift: false, control: false, alt: false, platform: false, function: false, ...mods },
  click_count: n,
});
const o = { multi: true, selecting: false, toggleKey: "cmd", rangeKey: "shift", remoteBinary: false };
const CMD = { platform: true };
const SHIFT = { shift: true };
const OPT_CMD = { alt: true, platform: true };

test("modifierKey names the seven supported combinations; Ctrl, Fn and all three keys are other", () => {
  assert.equal(modifierKey(ev().modifiers), "none");
  assert.equal(modifierKey(ev(CMD).modifiers), "cmd");
  assert.equal(modifierKey(ev(SHIFT).modifiers), "shift");
  assert.equal(modifierKey(ev({ platform: true, shift: true }).modifiers), "cmd_shift");
  assert.equal(modifierKey(ev({ alt: true }).modifiers), "alt");
  assert.equal(modifierKey(ev({ alt: true, shift: true }).modifiers), "alt_shift");
  assert.equal(modifierKey(ev(OPT_CMD).modifiers), "cmd_alt");
  assert.equal(modifierKey(ev({ control: true }).modifiers), "other");
  assert.equal(modifierKey(ev({ function: true }).modifiers), "other");
  assert.equal(modifierKey(ev({ platform: true, alt: true, shift: true }).modifiers), "other");
  assert.equal(modifierKey(undefined), "none");
});

test("rowClick with multi_select off behaves as before: any Cmd reveals, except on a remote binary", () => {
  const off = { ...o, multi: false };
  assert.equal(rowClick(ev(), off), "row");
  assert.equal(rowClick(ev(CMD), off), "reveal");
  assert.equal(rowClick(ev({ platform: true, shift: true }), off), "reveal");
  assert.equal(rowClick(ev(CMD), { ...off, remoteBinary: true }), "row");
  assert.equal(rowClick(ev(SHIFT), off), "row");
});

test("rowClick with multi_select on: toggle and range clicks, Option+Cmd reveals", () => {
  assert.equal(rowClick(ev(CMD), o), "toggle");
  assert.equal(rowClick(ev(SHIFT), o), "range");
  assert.equal(rowClick(ev(OPT_CMD), o), "reveal");
  assert.equal(rowClick(ev(OPT_CMD), { ...o, remoteBinary: true }), "row");
  assert.equal(rowClick(ev(CMD), { ...o, remoteBinary: true }), "toggle");
  assert.equal(rowClick(ev(), o), "row");
  const cs = { ...o, toggleKey: "cmd_shift" };
  assert.equal(rowClick(ev(CMD), cs), "row");
  assert.equal(rowClick(ev({ platform: true, shift: true }), cs), "toggle");
});

test("rowClick in checkbox mode: plain click toggles, the range key ranges, the reveal shortcut reveals", () => {
  for (const multi of [false, true]) {
    const sel = { ...o, multi, selecting: true };
    assert.equal(rowClick(ev(), sel), "toggle");
    assert.equal(rowClick(ev(SHIFT), sel), "range");
    const reveal = multi ? OPT_CMD : CMD;
    assert.equal(rowClick(ev(reveal), sel), "reveal");
    assert.equal(rowClick(ev(reveal), { ...sel, remoteBinary: true }), "toggle");
  }
});

test("rowClick in checkbox mode: the reveal shortcut wins over a range key that shares it (2a)", () => {
  const sel = { ...o, multi: false, selecting: true, rangeKey: "cmd" };
  assert.equal(rowClick(ev(CMD), sel), "reveal");
});

test("rowClick: the second press of a double click never toggles or ranges again", () => {
  assert.equal(rowClick(ev(CMD, 2), o), null);
  assert.equal(rowClick(ev(SHIFT, 2), o), null);
  assert.equal(rowClick(ev({}, 2), { ...o, selecting: true }), null);
  assert.equal(rowClick(ev({}, 2), o), "row");
});
