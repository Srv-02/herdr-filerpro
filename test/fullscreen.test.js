import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("maximize.svg is a Lucide glyph beside folder.svg", () => {
  const svg = read("mods/filer-pro/maximize.svg");
  assert.ok(svg.length < 1024, "small");
  assert.match(svg, /viewBox="0 0 24 24"/);
  assert.match(svg, /stroke="currentColor"/);
  assert.doesNotMatch(svg, /fill="#/, "no fixed fill color");
});

test("notices name Lucide for the glyphs, ISC and the Feather part", () => {
  const root = read("THIRD_PARTY_NOTICES.md");
  for (const s of ["## 8. Lucide (ISC", "https://github.com/lucide-icons/lucide", "1.68.0", "mods/filer-pro/maximize.svg", "mods/filer-pro/chevron-down.svg", "mods/filer-pro/folder.svg",
    "Lucide Icons and Contributors", "Cole Bemis", "MIT"])
    assert.ok(root.includes(s), s);
});

test("main.js: the file overlay lives in the passive overlay branch (source guard)", () => {
  const main = read("mods/filer-pro/main.js");
  const init = main.indexOf("init(_props, cx) {"), start = main.indexOf("if (props()?.overlay) {", init);
  const end = main.indexOf("if (props()?.button)", start), jobs = main.indexOf("createJobs(", init);
  assert.ok(init >= 0 && start > init && end > start && jobs > end, "overlay branch comes first in init, before createJobs");
  const branch = main.slice(start, end);
  for (const s of ['view === "file"', "this.show("]) assert.ok(branch.includes(s), `overlay branch has ${s}`);
  for (const s of ["cx.timer.every(", "watchFolder(", "this.drive(", "nextCommand("]) assert.ok(!branch.includes(s), `overlay branch never calls ${s}`);
  assert.match(main, /drive\(cx\) \{\s*if \(props\(\)\?\.overlay\) return;/, "drive() returns for overlay copies");
  // The dialog as designed: mod name as a literal (a clone rewrites it), 86 % by 90 %.
  assert.match(main, /openOverlay\(\{\s*mod: "filer-pro",\s*props: \{\s*view: "file",[^}]*\},\s*kind: "dialog",\s*width: 0\.86,\s*height: 0\.9\s*\}\)/, "fullscreen openOverlay call");
});

test("main.js: the dialog closes with an Esc outline button (approved design, source guard)", () => {
  const main = read("mods/filer-pro/main.js"), i = main.indexOf('div().id("files-full-close")');
  assert.ok(i > 0, "the close button");
  const button = main.slice(i, main.indexOf('.child("Esc")', i) + 13);
  for (const s of [".border_1()", ".border_color(t.border)", ".h(22)", ".px(7)", ".rounded(6)", ".text_size(11)", '.tooltip("Close")', '.accessibility_label("Close")', "this.requestLeave(close, cx)", '.child("Esc")'])
    assert.ok(button.includes(s), s);
});
