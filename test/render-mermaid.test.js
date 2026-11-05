import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { RENDER_VERSION, FONT } from "../mods/filer-pro/preview/mermaid.js";
import { mkTmp } from "./tmp-helper.js";

const REPO = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(REPO, "mods/filer-pro/bin/render-mermaid.mjs");
const run = (args, script = SCRIPT) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
const tmp = () => mkTmp("render-");
const gone = (p) => assert.rejects(fs.access(p));

test("renders to svg and json, deletes the source, prints nothing", async () => {
  const dir = await tmp();
  await fs.writeFile(`${dir}/a.x1.mmd`, "flowchart LR\n A --> B");
  const r = run([`${dir}/a.x1.mmd`, `${dir}/a`, JSON.stringify({ bg: "#000000", fg: "#ffffff" })]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  const meta = JSON.parse(await fs.readFile(`${dir}/a.json`, "utf8"));
  assert.ok(meta.width > 0 && meta.height > 0);
  const colors = { bg: "#000000", fg: "#ffffff" };
  assert.equal(meta.key, JSON.stringify([RENDER_VERSION, "flowchart LR\n A --> B", colors, FONT]), "the full cache key is stored for the mod to compare");
  const svg = await fs.readFile(`${dir}/a.svg`, "utf8");
  assert.match(svg, /^<svg/);
  assert.doesNotMatch(svg, /var\(|color-mix|@import/);
  await gone(`${dir}/a.x1.mmd`);
  assert.deepEqual((await fs.readdir(dir)).sort(), ["a.json", "a.svg"], "no .tmp files are left");
});

test("Mermaid error: exit 1, one line on stderr, no output files", async () => {
  const dir = await tmp();
  await fs.writeFile(`${dir}/b.mmd`, "notadiagram\n A -> B");
  const r = run([`${dir}/b.mmd`, `${dir}/b`, "{}"]);
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim().split("\n").length, 1);
  assert.ok(r.stderr.trim().length > 0);
  await gone(`${dir}/b.svg`);
  await gone(`${dir}/b.json`);
});

test("wrong usage and unreadable source", async () => {
  assert.equal(run([]).status, 1);
  assert.match(run([]).stderr, /^usage:/);
  const r = run(["/nonexistent/in.mmd", "/nonexistent/out", "{}"]);
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim().split("\n").length, 1);
  const dir = await tmp();
  await fs.writeFile(`${dir}/c.mmd`, "flowchart LR\n A --> B");
  assert.equal(run([`${dir}/c.mmd`, `${dir}/c`, "{not json"]).status, 1);
});

test("a missing bundle is reported in one line", async () => {
  const dir = await tmp();
  await fs.mkdir(`${dir}/m/bin`, { recursive: true });
  await fs.mkdir(`${dir}/m/preview`, { recursive: true });
  await fs.copyFile(SCRIPT, `${dir}/m/bin/render-mermaid.mjs`);
  await fs.copyFile(path.join(REPO, "mods/filer-pro/preview/mermaid.js"), `${dir}/m/preview/mermaid.js`);
  await fs.writeFile(`${dir}/d.mmd`, "flowchart LR\n A --> B");
  const r = run([`${dir}/d.mmd`, `${dir}/d`, "{}"], `${dir}/m/bin/render-mermaid.mjs`);
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), "mermaid.bundle.js missing");
});

test("a SVG with an image or an external reference is discarded", async () => {
  const dir = await tmp();
  // beautiful-mermaid has no image syntax; the check is exercised through its exported predicate.
  const { unsafeSvg } = await import("../mods/filer-pro/bin/render-mermaid.mjs");
  assert.equal(unsafeSvg('<svg><image href="https://example.com/x.png"/></svg>'), true);
  assert.equal(unsafeSvg('<svg><use href="https://example.com/x.svg#a"/></svg>'), true);
  assert.equal(unsafeSvg('<svg><use xlink:href="data:image/png;base64,AA"/></svg>'), true);
  assert.equal(unsafeSvg('<svg><rect style="fill:url(https://example.com/x)"/></svg>'), true);
  assert.equal(unsafeSvg('<svg><use href="#a"/><rect fill="url(#g)"/></svg>'), false);
  assert.ok(dir);
});

test("parallel renders of the same diagram never collide on the temp files", async () => {
  const dir = await tmp();
  const runs = [];
  for (let round = 0; round < 6; round++) {
    const group = [];
    for (let i = 0; i < 6; i++) {
      const input = `${dir}/p.${round}.${i}.mmd`;
      await fs.writeFile(input, "flowchart LR\n A --> B");
      group.push(new Promise((resolve) => {
        const child = spawn(process.execPath, [SCRIPT, input, `${dir}/p${round}`, "{}"]);
        let stderr = "";
        child.stderr.on("data", (d) => { stderr += d; });
        child.on("close", (code) => resolve({ code, stderr }));
      }));
    }
    runs.push(...await Promise.all(group));
  }
  const failed = runs.filter((r) => r.code !== 0);
  assert.deepEqual(failed, [], `${failed.length} of ${runs.length} runs failed`);
  assert.ok((await fs.readdir(dir)).every((n) => !n.endsWith(".tmp")));
});
