import { test } from "node:test";
import assert from "node:assert/strict";
import { withPanel } from "../mods/filer-pro/lib/panels.js";

test("null starts from the default panels", () => {
  assert.deepEqual(withPanel(null, "filer-pro"), ["files", "changes", "filer-pro"]);
  assert.deepEqual(withPanel(undefined, "filer-pro"), ["files", "changes", "filer-pro"]);
});
test("an existing list gets the id appended", () => {
  assert.deepEqual(withPanel(["files"], "filer-pro"), ["files", "filer-pro"]);
});
test("idempotent: a listed id returns the same list", () => {
  const list = ["files", "filer-pro"];
  assert.equal(withPanel(list, "filer-pro"), list);
  assert.deepEqual(withPanel(withPanel(null, "filer-pro"), "filer-pro"), ["files", "changes", "filer-pro"]);
});
test("does not mutate the input", () => {
  const list = ["files"];
  withPanel(list, "filer-pro");
  assert.deepEqual(list, ["files"]);
});
test("a non-array value falls back to the defaults", () => {
  assert.deepEqual(withPanel("files", "filer-pro"), ["files", "changes", "filer-pro"]);
});

import { panelShown } from "../mods/filer-pro/lib/panels.js";

const column = (children, panelHidden = false) => ({ id: "root", children: [{ id: "panel", hidden: panelHidden, children: [{ id: "panel-body", type: "column", children }] }] });
const stack = (active, children, panelHidden = false) => ({ id: "root", children: [{ id: "panel", hidden: panelHidden, children: [{ id: "panel-body", type: "stack", active, children }] }] });

test("panelShown: column shows a visible child, not a hidden one", () => {
  assert.equal(panelShown(column([{ id: "files" }, { id: "filer-pro" }]), "filer-pro"), true);
  assert.equal(panelShown(column([{ id: "filer-pro", hidden: true }]), "filer-pro"), false);
  assert.equal(panelShown(column([{ id: "files" }]), "filer-pro"), false);
});
test("panelShown: stack shows only the active child", () => {
  const kids = [{ id: "files" }, { id: "filer-pro" }];
  assert.equal(panelShown(stack("filer-pro", kids), "filer-pro"), true);
  assert.equal(panelShown(stack("files", kids), "filer-pro"), false);
  assert.equal(panelShown(stack("filer-pro", [{ id: "files" }]), "filer-pro"), false);
});
test("panelShown: hidden panel shows nothing", () => {
  assert.equal(panelShown(column([{ id: "filer-pro" }], true), "filer-pro"), false);
  assert.equal(panelShown(stack("filer-pro", [{ id: "filer-pro" }], true), "filer-pro"), false);
});
test("panelShown: missing panel, panel-body or layout", () => {
  assert.equal(panelShown({ id: "root", children: [{ id: "panel" }] }, "filer-pro"), false);
  assert.equal(panelShown({ id: "root", children: [] }, "filer-pro"), false);
  assert.equal(panelShown(null, "filer-pro"), false);
});

import { withoutLegacy } from "../mods/filer-pro/lib/panels.js";

const legacyRoot = { id: "root", children: [{ id: "panel", children: [{ id: "panel-body", type: "column", children: [{ id: "fileshare" }] }] }] };
const cleanRoot = column([{ id: "filer-pro" }]);

test("withoutLegacy: listed legacy id without a layout block is removed", () => {
  assert.deepEqual(withoutLegacy(["files", "fileshare", "filer-pro"], cleanRoot), ["files", "filer-pro"]);
});
test("withoutLegacy: file-pro entry without a layout block is removed, with its block it stays", () => {
  assert.deepEqual(withoutLegacy(["files", "file-pro", "filer-pro"], cleanRoot), ["files", "filer-pro"]);
  const list = ["files", "file-pro"];
  assert.equal(withoutLegacy(list, column([{ id: "file-pro" }])), list);
});
test("withoutLegacy: a legacy block in the layout keeps the entry (same reference)", () => {
  const list = ["files", "fileshare", "filer-pro"];
  assert.equal(withoutLegacy(list, legacyRoot), list);
});
test("withoutLegacy: absent legacy id returns the same reference", () => {
  const list = ["files", "filer-pro"];
  assert.equal(withoutLegacy(list, cleanRoot), list);
});
test("withoutLegacy: does not mutate the input and accepts a custom id", () => {
  const list = ["files", "old"];
  assert.deepEqual(withoutLegacy(list, cleanRoot, "old"), ["files"]);
  assert.deepEqual(list, ["files", "old"]);
});
test("withoutLegacy: a non-array value is returned unchanged", () => {
  assert.equal(withoutLegacy(null, cleanRoot), null);
});
