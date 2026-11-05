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
console.log(`lint: ${checks.length - failed}/${checks.length} ok`);
process.exit(failed ? 1 : 0);
