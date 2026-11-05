import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Personal working paths: a home folder followed by "git/" (Linux or macOS).
// Invented example users (u, me, m, you, user, example) are allowed.
const PERSONAL = /\/(?:home|Users)\/(?!(?:u|me|m|you|user|example)\/)[A-Za-z0-9._-]+\/git\//;
// Local, untracked folders (see .gitignore) are not part of the published docs.
const SKIP = new Set(["node_modules", "tmp", "workbench", "build"]);

function markdownFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith(".") || SKIP.has(e.name)) return [];
    const p = join(dir, e.name);
    if (e.isDirectory()) return markdownFiles(p);
    return e.isFile() && e.name.endsWith(".md") ? [p] : [];
  });
}

test("markdown files contain no personal home paths", () => {
  const files = markdownFiles(root);
  assert.ok(files.some((f) => relative(root, f) === "README.md"), "README.md is checked");
  const hits = [];
  for (const f of files) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (PERSONAL.test(line)) hits.push(`${relative(root, f)}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, []);
});
