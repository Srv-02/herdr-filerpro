import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { splitMermaid, flattenSvg, hash, colorKey, colorsFor, FONT, RENDER_VERSION } from "../mods/filer-pro/preview/mermaid.js";
import { renderMermaidSVG } from "../mods/filer-pro/preview/mermaid.bundle.js";

test("splits mermaid fences out of markdown", () => {
  const md = "# T\n\ntext\n\n```mermaid\nflowchart LR\n A --> B\n```\n\nmore\n\n~~~mermaid\nsequenceDiagram\n A->>B: hi\n~~~\n";
  assert.deepEqual(splitMermaid(md).map(p => p.kind), ["markdown", "mermaid", "markdown", "mermaid"]);
  assert.equal(splitMermaid(md)[1].text, "flowchart LR\n A --> B");
});

test("keeps an unclosed mermaid fence as markdown", () => {
  assert.deepEqual(splitMermaid("a\n```mermaid\nflowchart LR\n A-->B\n").map(p => p.kind), ["markdown"]);
});

test("splits quickly with many unclosed fences", () => {
  const t = Date.now();
  splitMermaid("```mermaid\n".repeat(20000));
  assert.ok(Date.now() - t < 2000);
});

test("leaves diagram text that looks like CSS alone", () => {
  const svg = flattenSvg(renderMermaidSVG("flowchart LR\n A[\"var(--fg) and --x: 1\"] --> B", { bg: "#000000", fg: "#ffffff" }), "Arial");
  assert.match(svg, /var\(--fg\) and --x: 1/);
});

test("leaves other code fences alone", () => {
  assert.deepEqual(splitMermaid("```js\nx\n```\n").map(p => p.kind), ["markdown"]);
});

test("the unchanged bundle runs under Node and flattenSvg removes CSS variables and remote fonts", () => {
  const svg = flattenSvg(renderMermaidSVG("flowchart LR\n A --> B", { bg: "#000000", fg: "#ffffff", transparent: true }), FONT);
  assert.match(svg, /^<svg/);
  assert.doesNotMatch(svg, /var\(|color-mix|@import/);
});

test("bundle keeps the files-plus banner", () => {
  const first = fs.readFileSync(new URL("../mods/filer-pro/preview/mermaid.bundle.js", import.meta.url), "utf8").split("\n")[0];
  assert.equal(first, "// beautiful-mermaid 1.1.3 (MIT) with elkjs (EPL-2.0) and entities (BSD-2-Clause), bundled. Rebuild: node build/build.mjs");
});

test("hash is stable and base36", () => {
  assert.equal(hash("a"), hash("a"));
  assert.match(hash("flowchart"), /^[0-9a-z]+$/);
  assert.notEqual(hash("a"), hash("b"));
});

test("colorKey changes only with the six colors", () => {
  const t = { background: "#000", foreground: "#fff", dim: "#888", ansi4: "#00f", muted: "#999", border: "#333", ansi1: "#f00" };
  assert.equal(colorKey(t), colorKey({ ...t, ansi1: "#0f0" }));
  assert.notEqual(colorKey(t), colorKey({ ...t, dim: "#777" }));
  assert.deepEqual(colorsFor(t), { bg: "#000", fg: "#fff", line: "#888", accent: "#00f", muted: "#999", border: "#333" });
});

test("RENDER_VERSION is a positive integer", () => {
  assert.ok(Number.isInteger(RENDER_VERSION) && RENDER_VERSION >= 1);
});
