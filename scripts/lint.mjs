import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

function jsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return p.includes("check-preview") && ["preview", "lib"].includes(e.name) ? [] : jsFiles(p);
    return e.isFile() && /\.(m?js)$/.test(e.name) && e.name !== "mermaid.bundle.js" ? [p] : [];
  });
}

const checks = [
  ...[...jsFiles(path.join(root, "mods/filer-pro")), ...jsFiles(path.join(root, "test")), ...jsFiles(path.join(root, "scripts"))].map((f) => ["node", ["--check", f], f]),
];
const script = path.join(root, "mods/filer-pro/bin/transfer.sh");
if (fs.existsSync(script)) checks.push(["sh", ["-n", script], script]);

let failed = 0;
for (const [cmd, args, file] of checks) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) {
    failed++;
    console.error(`FAIL ${path.relative(root, file)}\n${r.stderr || r.error || ""}`);
  }
}

// herdr runs the mod on QuickJS-ng without Intl: toLocaleString gives plain digits there. Use group() from
// lib/numbers.js. jsFiles already leaves out the vendored mermaid.bundle.js.
const modFiles = jsFiles(path.join(root, "mods/filer-pro"));
for (const file of modFiles) {
  const hits = fs.readFileSync(file, "utf8").split("\n").flatMap((line, i) => (/\btoLocaleString\b/.test(line) ? [i + 1] : []));
  if (hits.length) {
    failed++;
    console.error(`FAIL ${path.relative(root, file)}:${hits.join(",")}: toLocaleString (no Intl in herdr), use group() from lib/numbers.js`);
  }
}
const total = checks.length + modFiles.length;
console.log(`lint: ${total - failed}/${total} ok`);
process.exit(failed ? 1 : 0);
