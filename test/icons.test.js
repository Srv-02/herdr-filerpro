import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { icon, BASE } from "../mods/filer-pro/lib/icons.js";

const svg = id => `${BASE}/icons/${id}.svg`;

test("folder: closed and open", () => {
  assert.equal(icon("src", true, false, true), svg("folder-src"));
  assert.equal(icon("src", true, true, true), svg("folder-src-open"));
  assert.equal(icon("node_modules", true, false, true), svg("folder-node"));
  assert.equal(icon("node_modules", true, true, true), svg("folder-node-open"));
  assert.equal(icon("a/b/SRC", true, false, true), svg("folder-src"));
});

test("folder: a dot prefix falls back to the name without the dot (.github)", () => {
  assert.equal(icon(".github", true, false, true), icon("github", true, false, true));
  assert.notEqual(icon(".github", true, false, true), svg("folder"));
});

test("folder: a path rule beats the name (.github/workflows)", () => {
  assert.equal(icon(".github/workflows", true, false, true), icon("github/workflows", true, false, true));
  assert.notEqual(icon(".github/workflows", true, false, true), icon("workflows", true, false, true));
});

test("folder: unknown gives the default, open with -open", () => {
  assert.equal(icon("zzz-unknown", true, false, true), svg("folder"));
  assert.equal(icon("zzz-unknown", true, true, true), svg("folder-open"));
});

test("file name beats extension", () => {
  assert.equal(icon("package.json", false, false, true), svg("nodejs"));
  assert.equal(icon("sub/Dockerfile", false, false, true), svg("docker"));
  assert.equal(icon("README.md", false, false, true), svg("readme"));
  assert.equal(icon("x/readme.md", false, false, true), svg("readme"));
  assert.equal(icon("notes.md", false, false, true), svg("markdown"));
});

test("longest extension wins (spec.ts before ts)", () => {
  assert.equal(icon("x.spec.ts", false, false, true), svg("test-ts"));
  assert.equal(icon("x.ts", false, false, true), svg("typescript"));
  assert.equal(icon("a/b/x.y.spec.ts", false, false, true), svg("test-ts"));
});

test("path rule for files", () => {
  assert.equal(icon("src/bashly-strings.yaml", false, false, true), svg("bashly-strings"));
  assert.notEqual(icon("src/bashly-strings.yaml", false, false, true), icon("bashly-strings.yaml", false, false, true));
});

test("light themes: light variant, dark ones keep the standard variant", () => {
  assert.equal(icon("vercel.json", false, false, false), svg("vercel_light"));
  assert.equal(icon("vercel.json", false, false, true), svg("vercel"));
  assert.equal(icon("package.json", false, false, false), svg("nodejs"));
});

test("unknown file gives the default", () => {
  assert.equal(icon("zzz.unknown-xyz", false, false, true), svg("file"));
  assert.equal(icon("no-extension-zzz", false, false, false), svg("file"));
});

test("the base path comes from the one constant", () => {
  assert.ok(icon("a.ts", false, false, true).startsWith(`${BASE}/`));
});

test("every returned SVG exists under mods/filer-pro/icons", () => {
  const sample = [
    ["src", true], ["node_modules", true], [".github", true], [".github/workflows", true], ["zzz", true],
    ["package.json", false], ["Dockerfile", false], ["README.md", false], ["x.spec.ts", false], ["x.ts", false],
    ["a.py", false], ["b.rs", false], ["c.go", false], ["d.png", false], ["e.sh", false], ["vercel.json", false],
    ["src/bashly-strings.yaml", false], ["zzz.unknown", false], ["LICENSE", false], [".gitignore", false],
  ];
  const root = path.resolve(import.meta.dirname, "../mods/filer-pro");
  for (const [p, dir] of sample) for (const open of dir ? [false, true] : [false]) for (const dark of [true, false]) {
    const rel = icon(p, dir, open, dark);
    assert.ok(rel.startsWith(`${BASE}/`), rel);
    const file = path.join(root, rel.slice(BASE.length + 1));
    assert.ok(fs.existsSync(file), `missing: ${rel} for ${p}`);
  }
});
