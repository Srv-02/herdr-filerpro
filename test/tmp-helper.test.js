// Issue #47: throwaway data stays below the gitignored tmp/ of the repo, never in the system temp
// (/tmp, $TMPDIR) and never next to or above the checkout.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { TMP, mkTmp, mkTmpSync } from "./tmp-helper.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const SELF = new Set([path.join(ROOT, "test", "tmp-helper.js"), path.join(ROOT, "test", "tmp-helper.test.js")]);

function testFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return p.includes("check-preview") && ["preview", "lib"].includes(e.name) ? [] : testFiles(p);
    return e.isFile() && /\.m?js$/.test(e.name) && !SELF.has(p) ? [p] : [];
  });
}

const FORBIDDEN = [
  [/\bos\.tmpdir\b|\btmpdir\(\)/, "os.tmpdir()"],
  [/\bTMPDIR\b/, "$TMPDIR"],
  [/\bmkdtemp(Sync)?\b/, "mkdtemp directly"],
];
// path.resolve/join(import.meta.dirname, "<literal>", ...) that lands outside the repo
const FROM_HERE = /path\.(?:resolve|join)\(\s*import\.meta\.dirname\s*((?:,\s*(["'])[^"']*\2\s*)+)\)/g;
const outside = (file, args) => {
  const parts = [...args.matchAll(/(["'])([^"']*)\1/g)].map((m) => m[2]);
  const rel = path.relative(ROOT, path.resolve(path.dirname(file), ...parts));
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
};

test("no test takes a scratch folder from the system temp or outside the repo (#47)", () => {
  const hits = [];
  for (const f of testFiles(path.join(ROOT, "test"))) {
    fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      const at = `${path.relative(ROOT, f)}:${i + 1}`;
      for (const [re, what] of FORBIDDEN) if (re.test(line)) hits.push(`${at} uses ${what}`);
      for (const m of line.matchAll(FROM_HERE)) if (outside(f, m[1])) hits.push(`${at} uses a path outside the repo`);
    });
  }
  assert.deepEqual(hits, [], "use mkTmp/mkTmpSync from test/tmp-helper.js");
});

test("mkTmp and mkTmpSync make fresh folders below tmp/ of the repo", async () => {
  assert.equal(TMP, path.join(ROOT, "tmp"));
  const a = mkTmpSync("helper-"), b = await mkTmp("helper-");
  for (const d of [a, b]) {
    assert.equal(path.dirname(d), TMP, d);
    assert.match(path.basename(d), /^helper-.{6}$/);
    assert.equal(fs.statSync(d).isDirectory(), true);
  }
  assert.notEqual(a, b);
});
