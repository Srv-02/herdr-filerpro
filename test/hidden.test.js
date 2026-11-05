// Issue #17: hiding system files and hidden (dot) files in the file list. The names are a fixed constant
// (lib/hidden.js); the listing script and the Windows listing filter with it, so hidden entries never count
// against the list limits. The shell side is run for real with sh, the PowerShell side with pwsh when it is installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SYSTEM_FILES, isSystemFile, isHidden, hiddenPath, hideArgs, SYSTEM_CASE, psHideFilter } from "../mods/filer-pro/lib/hidden.js";
import { LIST_SCRIPT, psListCommand } from "../mods/filer-pro/lib/tree.js";
import { mkTmpSync } from "./tmp-helper.js";

const BOTH = { hide_system_files: true, hide_dotfiles: true };
const SYSTEM = { hide_system_files: true, hide_dotfiles: false };
const NONE = { hide_system_files: false, hide_dotfiles: false };
const DOTS = { hide_system_files: false, hide_dotfiles: true };

// Names that are clutter, and look-alikes that are not.
const CLUTTER = [".DS_Store", "._report.pdf", "._", ".Spotlight-V100", ".Trashes", ".fseventsd", ".TemporaryItems", ".DocumentRevisions-V100", ".apdisk", "Icon\r",
  "Thumbs.db", "thumbs.db", "THUMBS.DB", "desktop.ini", "Desktop.ini"];
const KEPT = [".ds_store", "DS_Store", "Icon", "Icon\r.txt", "Thumbs.db.bak", "my desktop.ini", ".env", ".gitignore", "a.txt", "_x", ".Trashes2", "x._y"];

test("SYSTEM_FILES: the fixed list of the issue, frozen, only plain characters", () => {
  assert.deepEqual([...SYSTEM_FILES.exact], [".DS_Store", ".Spotlight-V100", ".Trashes", ".fseventsd", ".TemporaryItems", ".DocumentRevisions-V100", ".apdisk", "Icon\r"]);
  assert.deepEqual([...SYSTEM_FILES.prefixes], ["._"]);
  assert.deepEqual([...SYSTEM_FILES.anyCase], ["Thumbs.db", "desktop.ini"]);
  assert.ok(Object.isFrozen(SYSTEM_FILES) && Object.isFrozen(SYSTEM_FILES.exact) && Object.isFrozen(SYSTEM_FILES.prefixes) && Object.isFrozen(SYSTEM_FILES.anyCase));
  // Nothing a shell or PowerShell could read as code: the patterns are built from these names.
  for (const n of [...SYSTEM_FILES.exact, ...SYSTEM_FILES.prefixes, ...SYSTEM_FILES.anyCase]) assert.match(n, /^[A-Za-z0-9._\-\r]+$/, JSON.stringify(n));
});

test("isSystemFile: macOS names match exactly, the Windows ones in any case", () => {
  for (const n of CLUTTER) assert.equal(isSystemFile(n), true, JSON.stringify(n));
  for (const n of KEPT) assert.equal(isSystemFile(n), false, JSON.stringify(n));
});

test("isHidden: each switch alone, both, none; .git is not this module's business", () => {
  assert.equal(isHidden(".DS_Store", SYSTEM), true);
  assert.equal(isHidden(".env", SYSTEM), false);
  assert.equal(isHidden("Thumbs.db", DOTS), false);
  assert.equal(isHidden(".env", DOTS), true);
  assert.equal(isHidden(".DS_Store", DOTS), true, "a dot name is hidden by the dot switch alone");
  assert.equal(isHidden("Thumbs.db", BOTH), true);
  for (const n of [...CLUTTER, ...KEPT]) assert.equal(isHidden(n, NONE), false, JSON.stringify(n));
  assert.equal(isHidden("a.txt", BOTH), false);
  assert.equal(isHidden(".env", undefined), false, "no settings: nothing hidden");
});

test("hiddenPath: a path is hidden when any of its folders or its name is", () => {
  assert.equal(hiddenPath(".github/workflows", DOTS), true);
  assert.equal(hiddenPath("src/.cache/x", DOTS), true);
  assert.equal(hiddenPath("src/.cache/x", SYSTEM), false);
  assert.equal(hiddenPath("disk/.Spotlight-V100/Store", SYSTEM), true);
  assert.equal(hiddenPath("src/lib", BOTH), false);
  assert.equal(hiddenPath("", BOTH), false, "the shown root itself is never hidden");
});

test("hideArgs: the two switches as the fixed words 1 and 0, never a config value", () => {
  assert.deepEqual(hideArgs(BOTH), ["1", "1"]);
  assert.deepEqual(hideArgs(NONE), ["0", "0"]);
  assert.deepEqual(hideArgs({ hide_system_files: "rm -rf /", hide_dotfiles: 1 }), ["0", "0"], "only true counts");
  assert.deepEqual(hideArgs(undefined), ["0", "0"]);
});

test("SYSTEM_CASE: a case pattern with only quoted names, brackets and the carriage return variable", () => {
  assert.equal(SYSTEM_CASE, '".DS_Store"|".Spotlight-V100"|".Trashes"|".fseventsd"|".TemporaryItems"|".DocumentRevisions-V100"|".apdisk"|"Icon$cr"|"._"*|[Tt][Hh][Uu][Mm][Bb][Ss]"."[Dd][Bb]|[Dd][Ee][Ss][Kk][Tt][Oo][Pp]"."[Ii][Nn][Ii]');
  assert.ok(LIST_SCRIPT.includes(SYSTEM_CASE));
  assert.ok(!/[\r\n]/.test(LIST_SCRIPT), "the script holds no raw control character (it travels over ssh)");
});

// Runs the listing script on `dir` and returns the names it printed.
const list = (dir, limit, flags) => {
  const r = spawnSync("sh", ["-c", LIST_SCRIPT, "files", dir, String(limit), ...(flags ? hideArgs(flags) : [])], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const f = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < f.length; i += 2) out.push(f[i + 1]);
  return out.sort();
};

test("LIST_SCRIPT: every clutter name is hidden only with the system switch, look-alikes stay (one folder per name: APFS ignores case)", () => {
  const root = mkTmpSync("filer-pro-hidden-");
  [...CLUTTER, ...KEPT].forEach((name, i) => {
    const d = path.join(root, String(i));
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, name), "");
    assert.deepEqual(list(d, 500, SYSTEM), CLUTTER.includes(name) ? [] : [name], `system: ${JSON.stringify(name)}`);
    assert.deepEqual(list(d, 500, NONE), [name], `none: ${JSON.stringify(name)}`);
    assert.deepEqual(list(d, 500), [name], `no switch words (older callers): ${JSON.stringify(name)}`);
  });
});

test("LIST_SCRIPT: the dot switch hides dot files and dot folders, .git stays out in every case", () => {
  const d = mkTmpSync("filer-pro-hidden-");
  for (const n of [".env", ".gitignore", "a.txt", "..b", "Thumbs.db"]) fs.writeFileSync(path.join(d, n), "");
  for (const n of [".github", ".git", "src"]) fs.mkdirSync(path.join(d, n));
  assert.deepEqual(list(d, 500, DOTS), ["Thumbs.db", "a.txt", "src"]);
  assert.deepEqual(list(d, 500, BOTH), ["a.txt", "src"]);
  assert.deepEqual(list(d, 500, NONE), ["..b", ".env", ".github", ".gitignore", "Thumbs.db", "a.txt", "src"]);
});

test("LIST_SCRIPT: hidden entries do not use up the per-folder limit", () => {
  const d = mkTmpSync("filer-pro-hidden-");
  for (let i = 0; i < 15; i++) fs.writeFileSync(path.join(d, `._f${i}`), "");
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(d, `f${i}`), "");
  assert.equal(list(d, 10, SYSTEM).length, 5, "all five real files, the folder is not cut");
  assert.equal(list(d, 10, NONE).length, 11, "without the switch: cut, one past the limit");
});

test("psHideFilter: nothing when both switches are off, else a Where-Object built from the constant", () => {
  assert.equal(psHideFilter(NONE), "");
  assert.equal(psHideFilter(undefined), "");
  assert.match(psHideFilter(DOTS), /StartsWith\('\.'/);
  assert.doesNotMatch(psHideFilter(DOTS), /DS_Store/);
  const sys = psHideFilter(SYSTEM);
  assert.match(sys, /-ccontains/);
  assert.ok(sys.includes("('Icon' + [char]13)"));
  assert.ok(sys.includes("@('Thumbs.db', 'desktop.ini') -contains"));
  const cmd = psListCommand("C:\\x", 20, SYSTEM);
  assert.ok(cmd.indexOf(sys) > cmd.indexOf("Where-Object Name -ne '.git'") && cmd.indexOf(sys) < cmd.indexOf("Select-Object -First 21"), "filtered before the limit");
  assert.equal(psListCommand("C:\\x", 20), psListCommand("C:\\x", 20, NONE), "no switches: the listing as before");
});

const pwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "1"], { encoding: "utf8" }).status === 0;
test("psListCommand: pwsh hides the same names as the shell script", { skip: !pwsh && "pwsh not installed" }, () => {
  const root = mkTmpSync("filer-pro-hidden-ps-");
  // One pwsh for many listings (it starts slowly): each listing's JSON, then a line "--".
  const run = (dirs, flags, limit = 500) => {
    const r = spawnSync("pwsh", ["-NoProfile", "-Command", dirs.map((d) => `${psListCommand(d, limit, flags)}; Write-Output '--'`).join("\n")], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.split(/^--$/m).slice(0, dirs.length).map((part) => {
      const out = JSON.parse(part.trim() || "[]");
      return (Array.isArray(out) ? out : [out]).map((e) => e.name).sort();
    });
  };
  const names = [...CLUTTER, ...KEPT], dirs = names.map((name, i) => {
    const d = path.join(root, String(i));
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, name), "");
    return d;
  });
  const sys = run(dirs, SYSTEM), dots = run(dirs, DOTS);
  names.forEach((name, i) => {
    assert.deepEqual(sys[i], CLUTTER.includes(name) ? [] : [name], `system: ${JSON.stringify(name)}`);
    assert.deepEqual(dots[i], name.startsWith(".") ? [] : [name], `dots: ${JSON.stringify(name)}`);
  });
  const d = path.join(root, "limit");
  fs.mkdirSync(d);
  for (let i = 0; i < 15; i++) fs.writeFileSync(path.join(d, `._f${i}`), "");
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(d, `f${i}`), "");
  assert.equal(run([d], SYSTEM, 10)[0].length, 5);
});
