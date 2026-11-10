// The screenshot hook (scripts/screenshots/demo-hook.mjs) patches a COPY of the mod for the demo instance. Its anchors are exact
// text of the mod, so a change of the mod can break it silently: this test applies it to a fresh copy of mods/filer-pro and fails
// when an anchor is gone. It also checks that the shipped mod itself carries no trace of the hook.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkTmpSync } from "./tmp-helper.js";

const root = path.resolve(import.meta.dirname, "..");
const mod = path.join(root, "mods/filer-pro");

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? jsFiles(p) : /\.m?js$/.test(e.name) ? [p] : [];
  });
}

test("the hook is not part of the shipped mod", () => {
  for (const f of jsFiles(mod)) {
    if (f.endsWith("mermaid.bundle.js")) continue;
    const text = fs.readFileSync(f, "utf8");
    assert.ok(!text.includes("demo-cmd.json") && !text.includes("demoPoll"), `${path.relative(root, f)} must not contain the screenshot hook`);
  }
});

test("demo-hook.mjs applies to the current mod and the result still parses", () => {
  const tmp = mkTmpSync("filerpro-hook-");
  try {
    const copy = path.join(tmp, "filer-pro");
    fs.cpSync(mod, copy, { recursive: true });
    const r = spawnSync("node", [path.join(root, "scripts/screenshots/demo-hook.mjs"), copy], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const main = fs.readFileSync(path.join(copy, "main.js"), "utf8");
    assert.ok(main.includes("demoPoll(cx)") && main.includes("demo-cmd.json"));
    for (const f of ["main.js", "ui/menu.js", "ui/settings.js"]) {
      const c = spawnSync("node", ["--check", "--input-type=module"], { input: fs.readFileSync(path.join(copy, f), "utf8"), encoding: "utf8" });
      assert.equal(c.status, 0, `${f}: ${c.stderr}`);
    }
    // the repo's mod is untouched by the run
    assert.ok(!fs.readFileSync(path.join(mod, "main.js"), "utf8").includes("demoPoll"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("demo-hook.mjs fails loudly when an anchor is missing", () => {
  const tmp = mkTmpSync("filerpro-hook-");
  try {
    const copy = path.join(tmp, "filer-pro");
    fs.cpSync(mod, copy, { recursive: true });
    const file = path.join(copy, "ui/menu.js");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('import { v_flex } from "gpui-base";', ""));
    const r = spawnSync("node", [path.join(root, "scripts/screenshots/demo-hook.mjs"), copy], { encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /anchor not found/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
