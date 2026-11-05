import { test } from "node:test";
import assert from "node:assert/strict";
import { langOf, extOf, previewKind } from "../mods/filer-pro/lib/langs.js";

test("langOf knows extensions, names and the fallback", () => {
  assert.equal(langOf("a/b.ts"), "js");
  assert.equal(langOf("Makefile"), "make");
  assert.equal(langOf("x/.zshrc"), "zsh");
  assert.equal(langOf("c.H"), "c");
  assert.equal(langOf("conf.yml"), "yaml");
  assert.equal(langOf("x.unknownext"), "unknownext");
  assert.equal(langOf("README"), "txt");
});
test("previewKind", () => {
  assert.equal(previewKind("doc.MD"), "markdown");
  assert.equal(previewKind("a.markdown"), "markdown");
  assert.equal(previewKind("a/index.htm"), "html");
  assert.equal(previewKind("a.txt"), null);
  assert.equal(previewKind("dir.v2/file"), null);
  for (const f of ["a.PNG", "b.jpg", "c.jpeg", "d.gif", "e.webp", "f.svg", "g.ICO"]) assert.equal(previewKind(f), "image", f);
  assert.equal(previewKind("g.bmp"), null);
  assert.equal(previewKind("h.PDF"), "pdf");
});
test("mdx and xhtml have no preview", () => {
  assert.equal(previewKind("a.mdx"), null);
  assert.equal(previewKind("a.xhtml"), null);
});
test("extOf takes only the base name", () => {
  assert.equal(extOf("dir.v2/file"), "");
  assert.equal(extOf("a.tar.GZ"), "gz");
});
