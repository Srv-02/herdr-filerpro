import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("the notices exist twice, are equal and complete", () => {
  const root = read("THIRD_PARTY_NOTICES.md");
  assert.equal(root, read("mods/filer-pro/THIRD_PARTY_NOTICES.md"));
  for (const h of ["## 4. herdr-files-plus by jjongkwann (MIT)", "## 5. beautiful-mermaid by Craft Docs (MIT)", "## 6. elkjs (EPL-2.0)", "## 7. entities (BSD-2-Clause)"])
    assert.ok(root.includes(h), h);
  assert.ok(root.includes("Copyright (c) 2026 jjongkwann") && root.includes("Eclipse Public License - v 2.0") && root.includes("Copyright (c) Felix Böhm"));
  assert.ok(root.includes("Copyright (c) 2026 Craft Docs"));
});

test("elkjs: all five changes are in the notices word for word, with links", () => {
  const root = read("THIRD_PARTY_NOTICES.md");
  for (const piece of [
    "_.toString=function(){return this.Ib()}",
    'Object.defineProperty(_,"toString",{value:function(){return this.Ib()},writable:true,configurable:true})',
    "    $wnd = self // web worker\\n",
    "if (!$wnd || !$wnd.Math) $wnd = globalThis;",
    "Hz=$wnd.setTimeout(Qz,10)",
    "Hz=-1",
    "$wnd.setTimeout(function(){throw a},0)",
    "void a",
    'src = "var setTimeout = function (fn) { fn(); return 0; };\\n" + src;',
    "https://github.com/kieler/elkjs", "0.11.1", "https://github.com/jjongkwann/herdr-files-plus/blob/b43c4e3/build/build.mjs",
  ]) assert.ok(root.includes(piece), piece);
});

test("adopted files carry the origin comment in their first line", () => {
  for (const f of ["mods/filer-pro/preview/index.js", "mods/filer-pro/preview/prepare.js", "mods/filer-pro/preview/mermaid.js", "mods/filer-pro/preview/diagrams.js", "mods/filer-pro/preview/strip.js", "mods/filer-pro/lib/langs.js", "mods/filer-pro/bin/render-mermaid.mjs"])
    assert.match(read(f).split("\n")[0], /Adapted from herdr-files-plus by jjongkwann \(https:\/\/github\.com\/jjongkwann\/herdr-files-plus, MIT\)/, f);
});

test("the bundle banner names the three licenses", () => {
  assert.match(read("mods/filer-pro/preview/mermaid.bundle.js").split("\n")[0], /beautiful-mermaid 1\.1\.3 \(MIT\) with elkjs \(EPL-2\.0\) and entities \(BSD-2-Clause\)/);
});

test("the README names credits, preview, turning off and removing", () => {
  const r = read("README.md");
  for (const s of ["herdr-files-plus", "jjongkwann", "## Preview", '"mermaid": false', '"preview": false', '"perf": true', "mods/filer-pro/preview/", "data/filer-pro/diagrams", "data/filer-pro/loads", "PDF", "osascript", "beautiful-mermaid", "elkjs", "entities"])
    assert.ok(r.includes(s), s);
});

test("the settings and edit glyphs are small Lucide SVGs in currentColor, each named in the notices", () => {
  const root = read("THIRD_PARTY_NOTICES.md");
  for (const name of ["settings", "check", "coffee", "external-link", "info", "loader-circle", "shield-exclamation-point", "github", "pencil", "undo-2", "redo-2", "circle-x", "save", "copy-plus", "refresh-cw", "chevron-left", "minus", "plus", "rectangle-vertical"]) {
    const svg = read(`mods/filer-pro/${name}.svg`);
    assert.ok(svg.length < 2048, `${name}: small`);
    assert.match(svg, /viewBox="0 0 24 24"/, name);
    assert.match(svg, /stroke="currentColor"/, name);
    assert.doesNotMatch(svg, /fill="#|<script|href=/i, name);
    assert.ok(root.includes(`mods/filer-pro/${name}.svg`), `${name} in the notices`);
  }
  assert.ok(root.includes("tag 0.544.0") && root.includes("Lucide Contributors 2025"), "the older tag of github.svg");
});
