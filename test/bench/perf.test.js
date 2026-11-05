// Wall-clock benchmarks of the pure preview functions (V8 on the Mac). Run with `npm run bench`, not with `npm test`:
// timings depend on the machine and must not make the unit tests flaky.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { splitMermaid, flattenSvg } from "../../mods/filer-pro/preview/mermaid.js";
import { stripMarkdownImages, stripHtmlResources } from "../../mods/filer-pro/preview/strip.js";
import { renderMermaidSVG } from "../../mods/filer-pro/preview/mermaid.bundle.js";
import { LINKS_SCRIPT, parseLinks } from "../../mods/filer-pro/lib/links.js";
import { perfFixture } from "../../scripts/make-perf-fixture.mjs";
import { mkTmp } from "../tmp-helper.js";

const REPO = path.resolve(import.meta.dirname, "../..");
const time = (fn) => { const t = performance.now(); fn(); return performance.now() - t; };
const chain = (n) => "flowchart LR\n" + Array.from({ length: n - 1 }, (_, i) => `  A${i}[n${i}] --> A${i + 1}[n${i + 1}]`).join("\n");

test("fixture has 200,000 characters and 20 fences", () => {
  const md = perfFixture();
  assert.equal(md.length, 200000);
  assert.equal(splitMermaid(md).filter((p) => p.kind === "mermaid").length, 20);
});

test("splitMermaid on 400k characters with 100 fences < 50 ms", (t) => {
  const md = ("```mermaid\nflowchart LR\n A-->B\n```\n" + "text line\n".repeat(400)).repeat(100).slice(0, 400000);
  const ms = time(() => splitMermaid(md));
  t.diagnostic(`splitMermaid ${ms.toFixed(1)} ms`);
  assert.ok(ms < 50, `${ms.toFixed(1)} ms`);
});

test("strip on 400k characters < 50 ms each", (t) => {
  const html = "<p>text</p>".repeat(36000), md = "text ![a](b) `c` <img src=x>\n".repeat(13000);
  for (const [name, fn, input] of [["html", stripHtmlResources, html], ["md", stripMarkdownImages, md]]) {
    const ms = time(() => fn(input));
    t.diagnostic(`strip ${name} ${ms.toFixed(1)} ms`);
    assert.ok(ms < 50, `${name} ${ms.toFixed(1)} ms`);
  }
});

test("flattenSvg on a 120-node flowchart < 20 ms", (t) => {
  const svg = renderMermaidSVG(chain(120), { bg: "#000000", fg: "#ffffff" });
  flattenSvg(svg, "Arial");
  const ms = time(() => flattenSvg(svg, "Arial"));
  t.diagnostic(`flattenSvg ${ms.toFixed(1)} ms`);
  assert.ok(ms < 20, `${ms.toFixed(1)} ms`);
});

test("render-mermaid.mjs end to end, 30 nodes < 2000 ms", async (ctx) => {
  const dir = await mkTmp("bench-");
  await fs.writeFile(`${dir}/a.mmd`, chain(30));
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [path.join(REPO, "mods/filer-pro/bin/render-mermaid.mjs"), `${dir}/a.mmd`, `${dir}/a`, "{}"], { encoding: "utf8" });
  const ms = performance.now() - t0;
  ctx.diagnostic(`render-mermaid end to end ${ms.toFixed(0)} ms`);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(ms < 2000, `${ms.toFixed(0)} ms`);
});

test("links scan of 3000 harmless links < 5000 ms", async (ctx) => {
  const dir = await mkTmp("bench-");
  try {
    await fs.mkdir(path.join(dir, "sub"));
    await fs.writeFile(path.join(dir, "sub", "a.txt"), "x");
    for (let i = 0; i < 3000; i++) await fs.symlink("sub/a.txt", path.join(dir, `l${i}`));
    const t0 = performance.now();
    const r = spawnSync("sh", ["-c", LINKS_SCRIPT, "links", dir], { encoding: "utf8" });
    const ms = performance.now() - t0;
    ctx.diagnostic(`links scan ${ms.toFixed(0)} ms`);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(parseLinks(r.stdout), { risky: [], total: 0, outside: 0, loop: 0 });
    assert.ok(ms < 5000, `${ms.toFixed(0)} ms`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
