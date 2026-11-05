import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { prepare } from "../mods/filer-pro/preview/prepare.js";
import { createDiagrams } from "../mods/filer-pro/preview/diagrams.js";
import { mkTmp } from "./tmp-helper.js";

const REPO = path.resolve(import.meta.dirname, "..");
const theme = { background: "#101010", foreground: "#eeeeee", dim: "#888888", ansi4: "#3366ff", muted: "#999999", border: "#333333" };

// The real script and the real cache logic against an app folder in tmp/, with a real child process.
test("prepare, createDiagrams and render-mermaid.mjs work together; a second run is a cache hit", async () => {
  const app = await mkTmp("app-");
  await fs.mkdir(`${app}/mods/filer-pro`, { recursive: true });
  await fs.cp(path.join(REPO, "mods/filer-pro/bin"), `${app}/mods/filer-pro/bin`, { recursive: true });
  await fs.cp(path.join(REPO, "mods/filer-pro/preview"), `${app}/mods/filer-pro/preview`, { recursive: true });
  let execs = 0;
  const exec = (cmd, args) => new Promise((resolve, reject) => {
    execs++;
    execFile(cmd === "node" ? process.execPath : cmd, args, (err, stdout, stderr) => {
      if (err && err.code === "ENOENT") reject(err); else resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
  });
  const deps = { exec, readTextFile: (p) => fs.readFile(p, "utf8").catch(() => null), writeFile: fs.writeFile, mkdir: fs.mkdir, appHome: () => app, now: Date.now };
  const doc = prepare("# T\n\n```mermaid\nflowchart LR\n A --> B\n```\n\n```mermaid\nnotadiagram\n```\n", { kind: "markdown", mermaid: true });
  await createDiagrams(deps).renderAll(doc.parts, theme, () => true, () => {});
  const [ok, bad] = doc.parts.filter((p) => p.kind === "mermaid");
  assert.ok(ok.diagram.path && ok.diagram.width > 0, JSON.stringify(ok.diagram));
  assert.match(await fs.readFile(`${app}/${ok.diagram.path}`, "utf8"), /^<svg/);
  assert.ok(bad.diagram.error, "an unknown diagram type is reported");
  const before = execs;
  const again = prepare("```mermaid\nflowchart LR\n A --> B\n```\n", { kind: "markdown", mermaid: true });
  await createDiagrams(deps).renderAll(again.parts, theme, () => true, () => {});
  assert.equal(execs, before, "a fresh instance finds the diagram in the cache without starting node");
  assert.deepEqual(again.parts[0].diagram, ok.diagram);
  const left = (await fs.readdir(`${app}/data/filer-pro/diagrams`)).filter((n) => n.endsWith(".mmd") || n.endsWith(".tmp"));
  assert.deepEqual(left, []);
});
