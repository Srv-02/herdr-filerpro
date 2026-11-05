// Runs `herdr-app check` on the preview harness. A mod may not import files outside its own folder, so the
// harness (test/check-preview/main.js) gets copies of mods/filer-pro/preview, mods/filer-pro/lib and mods/filer-pro/icons.js first (gitignored).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const target = path.join(root, "test/check-preview");
for (const name of ["preview", "lib", "icons.js"]) {
  fs.rmSync(path.join(target, name), { recursive: true, force: true });
  fs.cpSync(path.join(root, "mods/filer-pro", name), path.join(target, name), { recursive: true });
}
const r = spawnSync("herdr-app", ["check", target], { stdio: "inherit" });
process.exit(r.status ?? 1);
