import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after } from "node:test";
import { joinPath } from "../mods/filer-pro/lib/names.js";
import { mkTmp, mkTmpSync } from "./tmp-helper.js";
import {
  validateName, renameCheck, normalizePath, guardVerdict, parseGuard, createFileOps, successToast,
  GUARD_SCRIPT, RENAME_SCRIPT, REMOVE_SCRIPT, CONFIRM_SCRIPT, MKDIR_SCRIPT, SAME_FN,
} from "../mods/filer-pro/lib/fileops.js";

test("validateName", () => {
  assert.equal(validateName("report.pdf"), null);
  assert.equal(validateName(""), "Enter a name");
  assert.equal(validateName("   "), "Enter a name");
  assert.equal(validateName("a/b"), 'A name cannot contain "/"');
  assert.equal(validateName("."), '"." and ".." are not allowed');
  assert.equal(validateName(".."), '"." and ".." are not allowed');
  assert.equal(validateName(".env"), null);
  assert.equal(validateName("-x"), null);
  for (const bad of ["a\nb", "foo\n", "\tx", "a\x7fb", "a\x1bb"]) assert.equal(validateName(bad), "Names with control characters are not supported", JSON.stringify(bad));
});

test("renameCheck", () => {
  assert.equal(renameCheck("b.txt", "a.txt"), null);
  assert.equal(renameCheck("a.txt", "a.txt"), "The name is unchanged");
  assert.equal(renameCheck("", "a.txt"), "Enter a name");
});

test("normalizePath strips trailing slashes only", () => {
  assert.equal(normalizePath("/a/b/"), "/a/b");
  assert.equal(normalizePath("/a/b///"), "/a/b");
  assert.equal(normalizePath("/"), "/");
  assert.equal(normalizePath("///"), "/");
  assert.equal(normalizePath("/Users//m"), "/Users//m");
});

// info: what GUARD_SCRIPT reports about the physical file system (parent, root and home resolved with
// cd -P / pwd -P; coversHome / coversRoot: "y" when the entry is that folder or one above it, by -ef).
const info = (over = {}) => ({ exists: true, type: "f", parent: "/Users/m/git/x", root: "/Users/m/git/x", home: "/Users/m", coversHome: "n", coversRoot: "n", system: "n", ...over });
const verdict = (path, over = {}, opts = {}) => guardVerdict({ path, info: info(over), rootPath: "/Users/m/git/x", on: null, verb: "delete", ...opts });

test("guardVerdict lets an ordinary entry below the shown folder pass", () => {
  assert.equal(verdict("/Users/m/git/x/a.txt"), null);
  assert.equal(verdict("/Users/m/git/x/sub/a.txt", { parent: "/Users/m/git/x/sub" }), null);
  assert.equal(verdict("/Users/m/git/xy", { parent: "/Users/m/git" }), null); // sibling with a longer name
});

const SPELLING = 'Path must not contain ".", ".." or "//"';

test("guardVerdict refuses relative paths, the file system root, and every ., .. or empty component", () => {
  assert.equal(verdict("relative"), "path must be absolute");
  assert.equal(verdict("/"), "Refusing to delete the root folder");
  for (const p of ["/a/b/..", "/a/b/.", "/a/../b", "/a/./b", "/a//b", "//a/b", "/Users/m/git/x/l/../../m"]) {
    assert.equal(verdict(p, { parent: "/a/b" }), SPELLING, p);
    assert.equal(verdict(p, { parent: "/a/b" }, { verb: "rename" }), SPELLING, p);
  }
});

test("guardVerdict: home, the shown folder and everything above them come from the file system (-ef), not from spelling", () => {
  assert.equal(verdict("/Users/m", { parent: "/Users", coversHome: "y" }), "Refusing to delete the home folder");
  assert.equal(verdict("/anything", { parent: "/x", coversHome: "y" }), "Refusing to delete the home folder"); // whatever the spelling
  assert.equal(verdict("/Users/m/git", { parent: "/Users/m", coversRoot: "y" }), "Refusing to delete the shown folder");
  assert.equal(verdict("/anything", { parent: "/x", coversRoot: "y" }), "Refusing to delete the shown folder");
  assert.equal(verdict("/Users/m/git/x/a", { coversHome: "?" }), "Could not check the path"); // a folder above could not be entered
  assert.equal(verdict("/Users/m/git/x/a", { coversRoot: "?" }), "Could not check the path");
  assert.equal(verdict("/Users/m/git/x/a", { coversHome: undefined }), "Could not check the path"); // missing field: closed
  assert.equal(verdict("/USERS/m", { parent: "/USERS" }, { on: "mac" }), null); // the string alone decides nothing
});

test("guardVerdict refuses every entry directly below /, whatever is shown and whoever runs it", () => {
  for (const p of ["/usr", "/etc", "/home", "/Users", "/Volumes", "/tmp"]) {
    assert.equal(verdict(p, { parent: "/" }), "Refusing to delete a top-level folder", p);
    assert.equal(verdict(p, { parent: "/" }, { verb: "rename" }), "Refusing to rename this folder", p);
  }
  assert.equal(verdict("/srv/link-to-usr", { parent: "/" }), "Refusing to delete a top-level folder"); // the physical parent counts
  assert.equal(verdict("/srv/x", { parent: "/srv" }), null);
});

test("guardVerdict reports what it cannot resolve instead of guessing", () => {
  assert.equal(verdict("/gone/a", { parent: "" }), "No such file or folder: /gone/a");
  assert.equal(verdict("/Users/m/git/x/a", { exists: false }), "No such file or folder: /Users/m/git/x/a");
  assert.equal(verdict("/Users/m/git/x/a", { root: "" }), "No such file or folder: /Users/m/git/x");
  assert.equal(verdict("/Users/m/git/x/a", { home: "" }), "Cannot determine the home folder");
});

test("guardVerdict with verb move says Refusing to move this folder", () => {
  const mv = (p, over = {}) => verdict(p, over, { verb: "move" });
  assert.equal(mv("/"), "Refusing to move this folder");
  assert.equal(mv("/Users/m", { parent: "/Users", coversHome: "y" }), "Refusing to move this folder");
  assert.equal(mv("/Users/m/git", { parent: "/Users/m", coversRoot: "y" }), "Refusing to move this folder");
  assert.equal(mv("/usr", { parent: "/" }), "Refusing to move this folder");
  assert.equal(mv("/private/var", { parent: "/private", system: "y" }), "Refusing to move this folder");
  assert.equal(mv("/Users/m/git/x/a.txt"), null);
  assert.equal(typeof SAME_FN, "string");
});

test("rename verb gives one message for every refusal", () => {
  const r = (path, over) => verdict(path, over, { verb: "rename" });
  assert.equal(r("/", {}), "Refusing to rename this folder");
  assert.equal(r("/Users/m", { parent: "/Users", coversHome: "y" }), "Refusing to rename this folder");
  assert.equal(r("/Users/m/git/x", { parent: "/Users/m/git", coversRoot: "y" }), "Refusing to rename this folder");
  assert.equal(r("/Users/m/git/x/a.txt"), null);
});

// ---- the scripts against the real file system (only inside throw-away folders)
const scratch = [];
after(() => { for (const d of scratch) fs.rmSync(d, { recursive: true, force: true }); });
// realpath: the checkout itself may sit below a link.
function tmp() {
  const d = fs.realpathSync(mkTmpSync("fileops-"));
  scratch.push(d);
  return d;
}
const sh = (script, args, env = {}) => spawnSync("sh", ["-c", script, "x", ...args], { encoding: "utf8", env: { ...process.env, ...env } });
const caseInsensitive = (d) => { fs.writeFileSync(`${d}/CaseProbe`, ""); return fs.existsSync(`${d}/caseprobe`); };

test("RENAME_SCRIPT: renames, refuses an existing target, moves a link and not its target", () => {
  const d = tmp();
  fs.writeFileSync(`${d}/a.txt`, "a");
  fs.writeFileSync(`${d}/b.txt`, "b");
  assert.equal(sh(RENAME_SCRIPT, [`${d}/a.txt`, `${d}/b.txt`, "0", `${d}/a.txt`]).status, 4);
  assert.equal(fs.readFileSync(`${d}/a.txt`, "utf8"), "a");
  assert.equal(fs.readFileSync(`${d}/b.txt`, "utf8"), "b");
  assert.equal(sh(RENAME_SCRIPT, [`${d}/nope`, `${d}/c.txt`, "0", `${d}/nope`]).status, 3);
  assert.equal(sh(RENAME_SCRIPT, [`${d}/a.txt`, `${d}/c.txt`, "0", `${d}/a.txt`]).status, 0);
  assert.deepEqual(fs.readdirSync(d).sort(), ["b.txt", "c.txt"]);
  fs.symlinkSync("/etc/hosts", `${d}/link`);
  assert.equal(sh(RENAME_SCRIPT, [`${d}/link`, `${d}/link2`, "0", `${d}/link`]).status, 0);
  assert.equal(fs.readlinkSync(`${d}/link2`), "/etc/hosts");
});

test("RENAME_SCRIPT: a dangling link at the target counts as existing", () => {
  const d = tmp();
  fs.writeFileSync(`${d}/a.txt`, "a");
  fs.symlinkSync(`${d}/gone`, `${d}/dead`);
  assert.equal(sh(RENAME_SCRIPT, [`${d}/a.txt`, `${d}/dead`, "0", `${d}/a.txt`]).status, 4);
  assert.equal(fs.existsSync(`${d}/a.txt`), true);
});

test("RENAME_SCRIPT: caseOnly=1 never lets a different existing target through", () => {
  const d = tmp();
  fs.writeFileSync(`${d}/a.txt`, "a");
  fs.writeFileSync(`${d}/b.txt`, "b");
  assert.equal(sh(RENAME_SCRIPT, [`${d}/a.txt`, `${d}/b.txt`, "1", `${d}/a.txt`]).status, 4);
  assert.equal(fs.readFileSync(`${d}/a.txt`, "utf8"), "a");
  assert.equal(fs.readFileSync(`${d}/b.txt`, "utf8"), "b");
  fs.symlinkSync("a.txt", `${d}/lnk`);
  assert.equal(sh(RENAME_SCRIPT, [`${d}/lnk`, `${d}/a.txt`, "1", `${d}/lnk`]).status, 4); // a link is never "the same file"
  assert.equal(sh(RENAME_SCRIPT, [`${d}/a.txt`, `${d}/lnk`, "1", `${d}/a.txt`]).status, 4);
});

test("RENAME_SCRIPT: caseOnly=1 renames the same file to another spelling (case-insensitive volumes)", (t) => {
  const d = tmp();
  if (!caseInsensitive(d)) return t.skip("this file system tells README.md from readme.md");
  fs.writeFileSync(`${d}/readme.md`, "r");
  assert.equal(sh(RENAME_SCRIPT, [`${d}/readme.md`, `${d}/README.md`, "0", `${d}/readme.md`]).status, 4); // without the flag it refuses
  assert.equal(sh(RENAME_SCRIPT, [`${d}/readme.md`, `${d}/README.md`, "1", `${d}/readme.md`]).status, 0);
  assert.ok(fs.readdirSync(d).includes("README.md"));
  assert.equal(fs.readFileSync(`${d}/README.md`, "utf8"), "r");
});

// A target that appears between the check and mv: an mv on PATH that first creates it, then runs the real one.
function racingMv(d) {
  const bin = `${d}/bin`;
  fs.mkdirSync(bin);
  const real = fs.existsSync("/bin/mv") ? "/bin/mv" : "/usr/bin/mv";
  fs.writeFileSync(`${bin}/mv`, `#!/bin/sh\ncase " $* " in *" --version "*) exec ${real} "$@" ;; esac\nfor last; do :; done\nprintf other > "$last"\nexec ${real} "$@"\n`, { mode: 0o755 });
  return { PATH: `${bin}:${process.env.PATH}` };
}

test("RENAME_SCRIPT: a target that appears after the check is never overwritten (mv -n) and reported", () => {
  const d = tmp();
  fs.writeFileSync(`${d}/a.txt`, "a");
  const r = sh(RENAME_SCRIPT, [`${d}/a.txt`, `${d}/b.txt`, "0", `${d}/a.txt`], racingMv(d));
  assert.equal(r.status, 4, r.stderr);
  assert.equal(fs.readFileSync(`${d}/b.txt`, "utf8"), "other");
  assert.equal(fs.readFileSync(`${d}/a.txt`, "utf8"), "a");
});

// A folder that appears at the target between the check and mv: mv -n would move the source into it.
function racingMvDir(d) {
  const bin = `${d}/bin`;
  fs.mkdirSync(bin);
  const real = fs.existsSync("/bin/mv") ? "/bin/mv" : "/usr/bin/mv";
  fs.writeFileSync(`${bin}/mv`, `#!/bin/sh\ncase " $* " in *" --version "*) exec ${real} "$@" ;; esac\n[ -e "${d}/raced" ] || { : > "${d}/raced"; for last; do :; done; mkdir "$last"; }\nexec ${real} "$@"\n`, { mode: 0o755 });
  return { PATH: `${bin}:${process.env.PATH}` };
}

test("RENAME_SCRIPT: a folder that appears at the target after the check never swallows the source", () => {
  const d = tmp();
  fs.writeFileSync(`${d}/a.txt`, "a");
  const r = sh(RENAME_SCRIPT, [`${d}/a.txt`, `${d}/b`, "0", `${d}/a.txt`], racingMvDir(d));
  assert.equal(r.status, 4, r.stderr);
  assert.equal(fs.readFileSync(`${d}/a.txt`, "utf8"), "a");
  assert.deepEqual(fs.readdirSync(`${d}/b`), []);
});

// Folders appear at the target and then, while the item is moved back, at the source: the move back lands the
// item inside the new source folder. The message must name where it really is. The fake mv refuses --version
// like BSD mv, so the script never adds -T (GNU mv would not move into the folder at all) on any platform.
function racingMvBoth(d) {
  const bin = `${d}/bin`;
  fs.mkdirSync(bin);
  const real = fs.existsSync("/bin/mv") ? "/bin/mv" : "/usr/bin/mv";
  fs.writeFileSync(`${bin}/mv`, `#!/bin/sh\ncase " $* " in *" --version "*) exit 1 ;; esac\nfor last; do :; done\nn=0; while [ -e "${d}/raced$n" ]; do n=$((n + 1)); done\n[ $n -lt 2 ] && { : > "${d}/raced$n"; mkdir "$last"; }\nexec ${real} "$@"\n`, { mode: 0o755 });
  return { PATH: `${bin}:${process.env.PATH}` };
}

test("RENAME_SCRIPT: when the move back fails too, the message names where the item really is", () => {
  const d = tmp();
  fs.writeFileSync(`${d}/a.txt`, "a");
  const r = sh(RENAME_SCRIPT, [`${d}/a.txt`, `${d}/b`, "0", `${d}/a.txt`], racingMvBoth(d));
  assert.equal(r.status, 1, r.stderr);
  assert.equal(fs.readFileSync(`${d}/a.txt/a.txt`, "utf8"), "a"); // the item is below the source folder
  assert.match(r.stderr, new RegExp(`now in: ${(d + "/a.txt/a.txt").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("RENAME_SCRIPT: a folder holding an entry of its own name is renamed normally", () => {
  const d = tmp();
  fs.mkdirSync(`${d}/foo/foo`, { recursive: true });
  fs.writeFileSync(`${d}/foo/foo/x`, "x");
  const r = sh(RENAME_SCRIPT, [`${d}/foo`, `${d}/bar`, "0", `${d}/foo`]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(`${d}/bar/foo/x`, "utf8"), "x");
  assert.equal(fs.existsSync(`${d}/foo`), false);
});

test("RENAME_SCRIPT: fails when the source is still there or the target missing after mv", () => {
  const d = tmp();
  fs.writeFileSync(`${d}/a.txt`, "a");
  fs.mkdirSync(`${d}/bin`);
  fs.writeFileSync(`${d}/bin/mv`, "#!/bin/sh\nexit 0\n", { mode: 0o755 }); // claims success, does nothing
  const r = sh(RENAME_SCRIPT, [`${d}/a.txt`, `${d}/b.txt`, "0", `${d}/a.txt`], { PATH: `${d}/bin:${process.env.PATH}` });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Could not rename/);
});

test("RENAME_SCRIPT: relative paths and a trailing slash are refused", () => {
  const d = tmp();
  fs.mkdirSync(`${d}/real`);
  fs.symlinkSync(`${d}/real`, `${d}/link`);
  assert.equal(sh(RENAME_SCRIPT, [`${d}/link/`, `${d}/other`, "0", `${d}/link/`]).status, 2);
  assert.equal(sh(RENAME_SCRIPT, ["link", `${d}/other`, "0", "link"]).status, 2);
  for (const bad of [`${d}/link/../real`, `${d}/./real`, `${d}//real`]) {
    assert.equal(sh(RENAME_SCRIPT, [bad, `${d}/other`, "0", bad]).status, 2, bad);
    assert.equal(sh(RENAME_SCRIPT, [`${d}/real`, bad.replace("real", "other"), "0", `${d}/real`]).status, 2, bad);
  }
  assert.equal(fs.existsSync(`${d}/real`), true);
});

test("REMOVE_SCRIPT: removes files and folders, a link only as link", () => {
  const d = tmp();
  fs.mkdirSync(`${d}/target`);
  fs.writeFileSync(`${d}/target/keep.txt`, "k");
  fs.symlinkSync(`${d}/target`, `${d}/link`);
  fs.symlinkSync(`${d}/target/keep.txt`, `${d}/flink`);
  assert.equal(sh(REMOVE_SCRIPT, [`${d}/link`, `${d}/link`]).status, 0);
  assert.equal(sh(REMOVE_SCRIPT, [`${d}/flink`, `${d}/flink`]).status, 0);
  assert.deepEqual(fs.readdirSync(d), ["target"]);
  assert.equal(fs.readFileSync(`${d}/target/keep.txt`, "utf8"), "k");
  fs.mkdirSync(`${d}/target/sub`);
  assert.equal(sh(REMOVE_SCRIPT, [`${d}/target`, `${d}/target`]).status, 0);
  assert.deepEqual(fs.readdirSync(d), []);
});

test("REMOVE_SCRIPT: refuses before touching anything: trailing slash on a link, relative, root, . and ..", () => {
  const d = tmp();
  fs.mkdirSync(`${d}/target`);
  fs.writeFileSync(`${d}/target/keep.txt`, "k");
  fs.symlinkSync(`${d}/target`, `${d}/link`);
  for (const bad of [`${d}/link/`, "link", "relative/x", "", "/", `${d}/target/..`, `${d}/target/.`,
    `${d}/target/../target`, `${d}/./target`, `${d}//target`]) {
    const r = sh(REMOVE_SCRIPT, [bad, bad]);
    assert.equal(r.status, 2, `refused: ${JSON.stringify(bad)}`);
  }
  assert.equal(fs.readFileSync(`${d}/target/keep.txt`, "utf8"), "k");
  assert.equal(fs.lstatSync(`${d}/link`).isSymbolicLink(), true);
});

test("REMOVE_SCRIPT: fails loudly when something stays", (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip("root can delete everything");
  const d = tmp();
  fs.mkdirSync(`${d}/locked/inner`, { recursive: true });
  fs.writeFileSync(`${d}/locked/inner/f`, "f");
  fs.chmodSync(`${d}/locked/inner`, 0o555);
  t.after(() => fs.chmodSync(`${d}/locked/inner`, 0o755));
  const r = sh(REMOVE_SCRIPT, [`${d}/locked`, `${d}/locked`]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Could not delete/);
});

// A folder d with a mount at d/mnt (only in the fake tables), keep.txt beside it and a sibling dd.
function mountTree() {
  const d = tmp();
  fs.mkdirSync(`${d}/d/mnt`, { recursive: true });
  fs.writeFileSync(`${d}/d/keep.txt`, "k");
  fs.writeFileSync(`${d}/d/mnt/inside`, "i");
  fs.mkdirSync(`${d}/dd`);
  fs.writeFileSync(`${d}/dd/f`, "f");
  return d;
}
// mountinfo line (Linux): field 5 is the mount point, spaces and backslashes octal-escaped as the kernel does.
const infoLine = (mp) => `36 35 98:0 / ${mp} rw,relatime shared:1 - ext4 /dev/sdb1 rw\n`;
const bsdLine = (mp) => `/dev/disk9s1 on ${mp} (hfs, local, nodev, nosuid, nobrowse)\n`;
const intact = (d) => fs.existsSync(`${d}/d/keep.txt`) && fs.existsSync(`${d}/d/mnt/inside`);
const MOUNTED = /^Refusing to delete, a file system is mounted at: /m;

test("REMOVE_SCRIPT: refuses a folder with a mount on or below it, by /proc/self/mountinfo (fake table)", () => {
  const d = mountTree();
  fs.writeFileSync(`${d}/info.txt`, infoLine(`${d}/d/mnt`));
  let r = sh(REMOVE_SCRIPT, [`${d}/d`, `${d}/d`, `${d}/info.txt`, ""]);
  assert.equal(r.status, 6, r.stderr);
  assert.match(r.stderr, MOUNTED);
  assert.ok(r.stderr.includes(`${d}/d/mnt`));
  assert.ok(intact(d));
  r = sh(REMOVE_SCRIPT, [`${d}/d/mnt`, `${d}/d/mnt`, `${d}/info.txt`, ""]);
  assert.equal(r.status, 6, r.stderr);
  assert.ok(fs.existsSync(`${d}/d/mnt/inside`));
  r = sh(REMOVE_SCRIPT, [`${d}/dd`, `${d}/dd`, `${d}/info.txt`, ""]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(`${d}/dd`), false);
  assert.ok(intact(d));
});

test("REMOVE_SCRIPT: compares the target in mountinfo spelling (\\040, \\134, \\011, \\012)", (t) => {
  const d = tmp();
  if (/[ \\\t\n]/.test(d)) return t.skip("temp folder has special characters itself");
  const names = ["a b", "c\\d", "t\tb", "n\nl"];
  for (const n of names) {
    fs.mkdirSync(`${d}/${n}/m`, { recursive: true });
    fs.writeFileSync(`${d}/${n}/m/inside`, "i");
  }
  fs.writeFileSync(`${d}/info.txt`,
    infoLine(`${d}/a\\040b/m`) + infoLine(`${d}/c\\134d/m`) + infoLine(`${d}/t\\011b/m`) + infoLine(`${d}/n\\012l/m`));
  for (const n of names) {
    const r = sh(REMOVE_SCRIPT, [`${d}/${n}`, `${d}/${n}`, `${d}/info.txt`, ""]);
    assert.equal(r.status, 6, `${JSON.stringify(n)}: ${r.stderr}`);
    assert.match(r.stderr, MOUNTED);
    assert.ok(fs.existsSync(`${d}/${n}/m/inside`));
  }
});

test("REMOVE_SCRIPT: refuses by the mount output on macOS/BSD (fake table)", () => {
  const d = mountTree();
  const auto = "map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)\n";
  fs.writeFileSync(`${d}/bsd.txt`, auto + bsdLine(`${d}/d/mnt`) + bsdLine(`${d}/d/b (1)`));
  let r = sh(REMOVE_SCRIPT, [`${d}/d`, `${d}/d`, "/nonexistent", `${d}/bsd.txt`]);
  assert.equal(r.status, 6, r.stderr);
  assert.match(r.stderr, MOUNTED);
  assert.ok(intact(d));
  // only a mount point that itself holds " (": the last " (" ends the point
  const d3 = mountTree();
  fs.mkdirSync(`${d3}/d/b (1)`);
  fs.writeFileSync(`${d3}/bsd.txt`, bsdLine(`${d3}/d/b (1)`));
  r = sh(REMOVE_SCRIPT, [`${d3}/d`, `${d3}/d`, "/nonexistent", `${d3}/bsd.txt`]);
  assert.equal(r.status, 6, r.stderr);
  assert.ok(intact(d3));
  r = sh(REMOVE_SCRIPT, [`${d}/d/mnt`, `${d}/d/mnt`, "/nonexistent", `${d}/bsd.txt`]);
  assert.equal(r.status, 6, r.stderr);
  assert.ok(fs.existsSync(`${d}/d/mnt/inside`));
  r = sh(REMOVE_SCRIPT, [`${d}/dd`, `${d}/dd`, "/nonexistent", `${d}/bsd.txt`]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(`${d}/dd`), false);
});

test("REMOVE_SCRIPT: mountinfo wins over mount output; without a readable table it deletes as before", () => {
  const d = mountTree();
  fs.writeFileSync(`${d}/info.txt`, infoLine("/mnt/elsewhere"));
  fs.writeFileSync(`${d}/bsd.txt`, bsdLine(`${d}/d/mnt`));
  let r = sh(REMOVE_SCRIPT, [`${d}/d`, `${d}/d`, `${d}/info.txt`, `${d}/bsd.txt`]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(`${d}/d`), false);
  const d2 = mountTree();
  r = sh(REMOVE_SCRIPT, [`${d2}/d`, `${d2}/d`, "/nonexistent", "/nonexistent2"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(`${d2}/d`), false);
});

test("REMOVE_SCRIPT: a link is deleted as the link, its target is not checked for mounts", () => {
  const d = mountTree();
  fs.symlinkSync(`${d}/d`, `${d}/lnk`);
  fs.writeFileSync(`${d}/info.txt`, infoLine(`${d}/d/mnt`));
  fs.writeFileSync(`${d}/bsd.txt`, bsdLine(`${d}/d/mnt`));
  let r = sh(REMOVE_SCRIPT, [`${d}/lnk`, `${d}/lnk`, `${d}/info.txt`, ""]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.lstatSync(`${d}/lnk`, { throwIfNoEntry: false }), undefined);
  assert.ok(intact(d));
  fs.symlinkSync(`${d}/d`, `${d}/lnk`);
  r = sh(REMOVE_SCRIPT, [`${d}/lnk`, `${d}/lnk`, "/nonexistent", `${d}/bsd.txt`]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.lstatSync(`${d}/lnk`, { throwIfNoEntry: false }), undefined);
  assert.ok(intact(d));
});

test("REMOVE_SCRIPT: an NFC path still finds the mount in the stored NFD folder (#31)", async (t) => {
  const d = fs.realpathSync(await mkTmp("rm-nfd-"));
  const NFD = "cafe\u0301", NFC = "caf\u00e9";
  fs.mkdirSync(`${d}/${NFD}/mnt`, { recursive: true }); fs.writeFileSync(`${d}/${NFD}/mnt/inside`, "i");
  if (!fs.existsSync(`${d}/${NFC}`)) return t.skip("the file system here tells Unicode normal forms apart");
  fs.writeFileSync(`${d}/info.txt`, infoLine(`${d}/${NFD}/mnt`));
  fs.writeFileSync(`${d}/bsd.txt`, bsdLine(`${d}/${NFD}/mnt`));
  for (const shell of ["sh", ...(spawnSync("dash", ["-c", ":"]).status === 0 ? ["dash"] : [])]) {
    for (const tables of [[`${d}/info.txt`, ""], ["/nonexistent", `${d}/bsd.txt`]]) {
      const r = spawnSync(shell, ["-c", REMOVE_SCRIPT, "x", `${d}/${NFC}`, `${d}/${NFC}`, ...tables], { encoding: "utf8" });
      assert.equal(r.status, 6, `${shell}: ${r.stderr}`);
      assert.match(r.stderr, MOUNTED);
    }
  }
  assert.equal(fs.readFileSync(`${d}/${NFD}/mnt/inside`, "utf8"), "i");
});

test("REMOVE_SCRIPT: a mounted image below the folder stays untouched (hdiutil, macOS)", (t) => {
  if (process.platform !== "darwin") return t.skip("hdiutil is macOS only");
  const d = tmp(), mnt = `${d}/sub/mnt`;
  fs.mkdirSync(mnt, { recursive: true });
  fs.writeFileSync(`${d}/sub/keep.txt`, "k");
  const run = (args) => spawnSync("hdiutil", args, { encoding: "utf8" });
  if (run(["create", "-size", "1m", "-fs", "HFS+", "-volname", "probe", "-quiet", `${d}/img.dmg`]).status !== 0) return t.skip("hdiutil create failed");
  // Registered before attach: an attach that fails after mounting must not leave the image mounted.
  t.after(() => {
    if (!spawnSync("mount", { encoding: "utf8" }).stdout.includes(` on ${mnt} (`)) return;
    const r = run(["detach", mnt, "-quiet", "-force"]);
    if (r.status !== 0) { scratch.splice(scratch.indexOf(d), 1); throw new Error(`detach failed, folder kept: ${d}`); }
  });
  assert.equal(run(["attach", "-nobrowse", "-quiet", "-mountpoint", mnt, `${d}/img.dmg`]).status, 0, "hdiutil attach failed");
  fs.writeFileSync(`${mnt}/inside`, "i");
  const r = sh(REMOVE_SCRIPT, [`${d}/sub`, `${d}/sub`]); // production form: the real `mount` is read
  assert.equal(r.status, 6, r.stderr);
  assert.match(r.stderr, MOUNTED);
  assert.equal(fs.readFileSync(`${mnt}/inside`, "utf8"), "i");
  assert.equal(fs.readFileSync(`${d}/sub/keep.txt`, "utf8"), "k");
});

// Guard: the verdict from the real file system. HOME points at a throw-away home folder.
function realVerdict(d, p, { root, verb = "delete", home = `${d}/Users/m` } = {}) {
  const np = normalizePath(p);
  const r = sh(GUARD_SCRIPT, [np, root], { HOME: home });
  assert.equal(r.status, 0, r.stderr);
  return guardVerdict({ path: np, info: parseGuard(r.stdout), rootPath: root, on: null, verb });
}
function guardTree() {
  const d = tmp();
  fs.mkdirSync(`${d}/Users/m/proj/sub`, { recursive: true });
  fs.writeFileSync(`${d}/Users/m/proj/a.txt`, "a");
  fs.writeFileSync(`${d}/Users/m/proj/sub/b.txt`, "b");
  fs.mkdirSync(`${d}/a/b`, { recursive: true });
  fs.symlinkSync(`${d}/Users/m/proj`, `${d}/viaLink`);
  return d;
}

test("GUARD_SCRIPT: parseGuard reads what the script reports", () => {
  const d = guardTree();
  const r = sh(GUARD_SCRIPT, [`${d}/Users/m/proj/a.txt`, `${d}/Users/m/proj`], { HOME: `${d}/Users/m` });
  assert.deepEqual(parseGuard(r.stdout), { exists: true, type: "f", parent: `${d}/Users/m/proj`, root: `${d}/Users/m/proj`, home: `${d}/Users/m`, coversHome: "n", coversRoot: "n", rootEntry: false, system: "n" });
  const gone = sh(GUARD_SCRIPT, [`${d}/nope/x`, `${d}/Users/m/proj`], { HOME: `${d}/Users/m` });
  assert.equal(parseGuard(gone.stdout).parent, "");
  assert.equal(parseGuard(gone.stdout).exists, false);
});

test("GUARD_SCRIPT: ordinary entries pass, home, the shown folder and everything above are refused", () => {
  const d = guardTree(), root = `${d}/Users/m/proj`;
  assert.equal(realVerdict(d, `${root}/a.txt`, { root }), null);
  assert.equal(realVerdict(d, `${root}/sub/b.txt`, { root }), null);
  assert.equal(realVerdict(d, `${root}/sub`, { root }), null);
  assert.equal(realVerdict(d, root, { root }), "Refusing to delete the shown folder");
  assert.equal(realVerdict(d, `${d}/Users/m`, { root }), "Refusing to delete the home folder");
  assert.equal(realVerdict(d, `${d}/Users`, { root }), "Refusing to delete the home folder"); // /Users above home
  assert.equal(realVerdict(d, d, { root }), "Refusing to delete the home folder"); // far above
  assert.equal(realVerdict(d, "/", { root }), "Refusing to delete the root folder");
});

test("GUARD_SCRIPT: spellings cannot hide a path: .., ., // are refused, links in the parent resolve", () => {
  const d = guardTree(), root = `${d}/Users/m/proj`;
  for (const p of [`${d}/a/b/..`, `${d}/a/./b`, `${d}/Users//m`, `${d}/Users/./m`, `${d}/Users/m/../m`, `${d}/Users/m/proj/../proj`]) {
    assert.equal(realVerdict(d, p, { root }), SPELLING, p);
  }
  assert.equal(realVerdict(d, `${d}/viaLink/a.txt`, { root }), null); // below the shown folder, reached through a link
  assert.equal(realVerdict(d, `${d}/viaLink/sub`, { root: `${d}/viaLink/sub` }), "Refusing to delete the shown folder"); // root spelled via the link
  // ".." after a link: the kernel walks up from the link's target, a logical cd from the link's own
  // folder. The spelling is refused outright; the script itself also resolves physically (next test).
  assert.equal(realVerdict(d, `${d}/viaLink/../proj`, { root }), SPELLING);
});

// The attack: a link /srv/x/l -> <home>, path /srv/x/l/../../Users. A logical cd sees /srv/Users,
// rm walks the link and reaches the folder above home. Same with the folder above the shown one.
function linkTree() {
  const d = guardTree();
  fs.mkdirSync(`${d}/srv/x`, { recursive: true });
  fs.symlinkSync(`${d}/Users/m`, `${d}/srv/x/l`); // l -> home
  fs.symlinkSync(`${d}/Users/m/proj/sub`, `${d}/srv/x/r`); // r -> a folder below the shown one
  return d;
}

test("GUARD_SCRIPT: .. behind a link is resolved physically, as rm would walk it", () => {
  const d = linkTree(), env = { HOME: `${d}/Users/m` };
  const above = parseGuard(sh(GUARD_SCRIPT, [`${d}/srv/x/l/../../Users`, `${d}/srv/x`], env).stdout);
  assert.equal(above.exists, true);
  assert.equal(above.parent, d); // physical: <home>/.. /.. = d, not d/srv
  const rootParent = parseGuard(sh(GUARD_SCRIPT, [`${d}/srv/x/r/../../proj`, `${d}/Users/m/proj/sub`], env).stdout);
  assert.equal(rootParent.parent, `${d}/Users/m`);
});

test("GUARD_SCRIPT: a link plus .. never reaches the folder above home or above the shown folder", () => {
  const d = linkTree();
  assert.equal(realVerdict(d, `${d}/srv/x/l/../../Users`, { root: `${d}/srv/x` }), SPELLING);
  assert.equal(realVerdict(d, `${d}/srv/x/l/../../Users`, { root: `${d}/srv/x`, verb: "rename" }), SPELLING);
  assert.equal(realVerdict(d, `${d}/srv/x/r/../../proj`, { root: `${d}/Users/m/proj/sub` }), SPELLING);
  // the verdict on what the script reports, even if a spelling slipped past the component check
  const env = { HOME: `${d}/Users/m` };
  const info = parseGuard(sh(GUARD_SCRIPT, [`${d}/srv/x/l/../../Users`, `${d}/srv/x`], env).stdout);
  assert.equal(guardVerdict({ path: `${d}/srv/Users`, info, rootPath: `${d}/srv/x`, on: "box", verb: "delete" }), "Refusing to delete the home folder");
});

test("check, remove and rename hand rm, mv and trash the checked physical path, never the input", async () => {
  const d = guardTree(), root = `${d}/Users/m/proj`;
  const { ops, mutating } = recorder({ env: { HOME: `${d}/Users/m` } });
  assert.deepEqual(await ops.check({ on: null, path: `${d}/viaLink/a.txt`, root }), { ok: true, path: `${root}/a.txt`, name: "a.txt", isDir: false });
  assert.equal((await ops.remove({ on: null, path: `${d}/viaLink/a.txt`, root })).ok, true);
  assert.deepEqual(mutating().at(-1).args, ["-s", "-v", `${root}/a.txt`]);
  assert.equal((await ops.rename({ on: null, path: `${d}/viaLink/sub`, root, name: "sub2" })).ok, true);
  assert.deepEqual(mutating().at(-1).args.slice(3), [`${root}/sub`, `${root}/sub2`, "0", `${d}/viaLink/sub`]);
  const remote = recorder({ guard: fakeGuard(guardInfo({ 2: "/home/u/tmp/in" })) });
  assert.equal((await remote.ops.remove({ on: "box", path: "/home/u/link/a", root: "/home/u/tmp" })).ok, true);
  assert.deepEqual(remote.mutating().at(-1).args.slice(3), ["/home/u/tmp/in/a", "/home/u/link/a"]);
});

test("GUARD_SCRIPT: folders above home and the shown folder are found by -ef, also spelled in other case", (t) => {
  const d = guardTree(), root = `${d}/Users/m/proj`;
  if (!caseInsensitive(d)) return t.skip("this file system tells Users from USERS");
  // pwd -P keeps the spelling it is given (/USERS stays /USERS): only -ef sees it is the same folder.
  const remote = (p, home) => {
    const out = sh(GUARD_SCRIPT, [p, root], { HOME: home });
    return guardVerdict({ path: p, info: parseGuard(out.stdout), rootPath: root, on: "mac", verb: "delete" });
  };
  assert.equal(remote(`${d}/Users`, `${d}/USERS/m`), "Refusing to delete the home folder");
  assert.equal(remote(`${d}/USERS`, `${d}/Users/m`), "Refusing to delete the home folder");
  assert.equal(remote(`${d}/Users/M`, `${d}/Users/m`), "Refusing to delete the home folder");
  assert.equal(remote(`${d}/Users/m/PROJ`, `${d}/a`), "Refusing to delete the shown folder"); // home elsewhere
});

test("GUARD_SCRIPT: a folder above that cannot be listed does not stop the walk", (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip("root enters every folder");
  const d = guardTree(), root = `${d}/Users/m/proj`;
  fs.mkdirSync(`${d}/locked/in`, { recursive: true });
  fs.writeFileSync(`${d}/locked/in/f`, "f");
  fs.chmodSync(`${d}/locked`, 0o311); // can be entered, not listed
  t.after(() => fs.chmodSync(`${d}/locked`, 0o755));
  const out = parseGuard(sh(GUARD_SCRIPT, [`${d}/locked/in/f`, root], { HOME: `${d}/Users/m` }).stdout);
  assert.equal(out.coversHome, "n");
});

test("GUARD_SCRIPT: real top-level folders are refused although they are above neither home nor the shown folder", () => {
  const d = guardTree(), root = `${d}/Users/m/proj`;
  for (const p of ["/usr", "/etc", "/tmp"]) {
    if (!fs.existsSync(p)) continue;
    assert.equal(realVerdict(d, p, { root }), "Refusing to delete a top-level folder", p);
    assert.equal(realVerdict(d, p, { root, verb: "rename" }), "Refusing to rename this folder", p);
  }
});

// Only names that do not exist: should the refusal ever break, rm and mv find nothing to act on.
test("REMOVE_SCRIPT and RENAME_SCRIPT refuse an entry directly below /", () => {
  const top = `/filer-pro-test-no-such-entry-${process.pid}`;
  assert.equal(fs.existsSync(top), false);
  assert.equal(sh(REMOVE_SCRIPT, [top, top]).status, 2);
  assert.equal(sh(RENAME_SCRIPT, [top, `${top}-2`, "0", top]).status, 2);
  const d = tmp();
  assert.equal(sh(RENAME_SCRIPT, [`${d}/nope`, top, "0", `${d}/nope`]).status, 2);
});

test("GUARD_SCRIPT: the shown folder itself is refused also when it is a link", () => {
  const d = guardTree();
  fs.symlinkSync(`${d}/Users/m/proj`, `${d}/rootLink`);
  fs.symlinkSync(d, `${d}/a/up`); // another spelling of the folder the link sits in
  const root = `${d}/rootLink`;
  assert.equal(realVerdict(d, root, { root }), "Refusing to delete the shown folder");
  assert.equal(realVerdict(d, `${root}/`, { root }), "Refusing to delete the shown folder");
  assert.equal(realVerdict(d, root, { root, verb: "rename" }), "Refusing to rename this folder");
  assert.equal(realVerdict(d, `${d}/a/up/rootLink`, { root }), "Refusing to delete the shown folder");
  assert.equal(realVerdict(d, `${root}/a.txt`, { root }), null);
});

test("remove and rename never reach rm or mv for a shown folder that is a link", async () => {
  const d = guardTree();
  fs.symlinkSync(`${d}/Users/m/proj`, `${d}/rootLink`);
  const { ops, mutating } = recorder({ env: { HOME: `${d}/Users/m` } });
  assert.equal((await ops.remove({ on: null, path: `${d}/rootLink`, root: `${d}/rootLink/` })).error, "Refusing to delete the shown folder");
  assert.equal((await ops.rename({ on: null, path: `${d}/rootLink`, root: `${d}/rootLink`, name: "x" })).error, "Refusing to rename this folder");
  assert.equal(mutating().length, 0);
  assert.equal(fs.lstatSync(`${d}/rootLink`).isSymbolicLink(), true);
});

test("GUARD_SCRIPT: a missing parent or missing entry is reported, not guessed", () => {
  const d = guardTree(), root = `${d}/Users/m/proj`;
  assert.match(realVerdict(d, `${d}/nope/x`, { root }), /^No such file or folder/);
  assert.match(realVerdict(d, `${root}/gone.txt`, { root }), /^No such file or folder/);
  assert.match(realVerdict(d, `${root}/a.txt`, { root: `${d}/nope` }), /^No such file or folder/);
});

test("GUARD_SCRIPT: rename uses the same ground with its own message", () => {
  const d = guardTree(), root = `${d}/Users/m/proj`;
  assert.equal(realVerdict(d, `${root}/a.txt`, { root, verb: "rename" }), null);
  assert.equal(realVerdict(d, `${d}/Users/m`, { root, verb: "rename" }), "Refusing to rename this folder");
  assert.equal(realVerdict(d, root, { root, verb: "rename" }), "Refusing to rename this folder");
  assert.equal(realVerdict(d, "/", { root, verb: "rename" }), "Refusing to rename this folder");
});

test("GUARD_SCRIPT: the real home folder and the folder above it are refused (nothing is deleted)", () => {
  const home = os.homedir();
  const r = (p) => {
    const np = normalizePath(p);
    const out = sh(GUARD_SCRIPT, [np, `${home}/some-project`], { HOME: home });
    return guardVerdict({ path: np, info: parseGuard(out.stdout), rootPath: `${home}/some-project`, on: null, verb: "delete" });
  };
  assert.equal(r(home), "Refusing to delete the home folder");
  assert.equal(r(`${home}/`), "Refusing to delete the home folder");
  assert.equal(r(path.dirname(home)), "Refusing to delete the home folder"); // /Users or /home
  assert.equal(r("/"), "Refusing to delete the root folder");
});

// ---- createFileOps: the guard runs for real, everything else is recorded and never executed
function recorder(over = {}) {
  const calls = [];
  const exec = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, on: opts.on ?? null });
    if (args?.[1] === GUARD_SCRIPT && over.guard) return over.guard(args.slice(3), opts.on ?? null);
    if (args?.[1] === GUARD_SCRIPT) return { ...sh(GUARD_SCRIPT, args.slice(3), over.env ?? {}), code: 0 };
    if (args?.[1] === CONFIRM_SCRIPT) return opts.on ? { code: 0, stdout: "", stderr: "" } : { code: sh(CONFIRM_SCRIPT, args.slice(3)).status, stdout: "", stderr: "" };
    if (over.answer) { const a = over.answer(cmd, args, opts.on ?? null); if (a !== undefined) return a; }
    return { code: 0, stdout: "", stderr: "" };
  };
  const mutating = () => calls.filter((c) => c.args?.[1] !== GUARD_SCRIPT && c.args?.[1] !== CONFIRM_SCRIPT);
  return { calls, mutating, ops: createFileOps({ exec }) };
}
// fields: exists, type, parent, root, home, coversHome, coversRoot
const guardInfo = (over = {}) => ["y", "f", "/home/u/tmp", "/home/u/tmp", "/home/u", "n", "n", "n", "n"].map((v, i) => over[i] ?? v);
const fakeGuard = (fields) => () => ({ code: 0, stdout: fields.map((x) => `${x}\0`).join(""), stderr: "" });

test("remove: no root, no deletion", async () => {
  const d = guardTree();
  const { ops, mutating } = recorder({ env: { HOME: `${d}/Users/m` } });
  assert.deepEqual(await ops.remove({ on: null, path: `${d}/Users/m/proj/a.txt` }), { ok: false, error: "root is required" });
  assert.equal(mutating().length, 0);
});

test("remove: every refusal happens before the delete command is even built", async () => {
  const d = guardTree(), root = `${d}/Users/m/proj`;
  const { ops, mutating } = recorder({ env: { HOME: `${d}/Users/m` } });
  for (const p of ["/", d, `${d}/Users`, `${d}/Users/m`, `${d}/Users//m`, root, `${root}/`, `${d}/a/b/..`, `${root}/../proj/a.txt`, "relative", `${root}/gone`]) {
    const r = await ops.remove({ on: null, path: p, root });
    assert.equal(r.ok, false, p);
  }
  assert.equal(mutating().length, 0, "trash/rm must not have been called");
  assert.equal(fs.existsSync(`${root}/a.txt`), true);
});

test("remove: remote refusals (/home, home, shown folder) never reach rm", async () => {
  const { ops, mutating } = recorder({ guard: (a) => fakeGuard(guardInfo(a[0] === "/home" ? { 2: "/", 5: "y" } : a[0] === "/home/u" ? { 2: "/home", 5: "y" } : a[0] === "/home/u/tmp" ? { 2: "/home/u", 6: "y" } : {}))() });
  assert.equal((await ops.remove({ on: "box", path: "/home", root: "/home/u/tmp" })).error, "Refusing to delete the home folder");
  assert.equal((await ops.remove({ on: "box", path: "/home/u", root: "/home/u/tmp" })).error, "Refusing to delete the home folder");
  assert.equal((await ops.remove({ on: "box", path: "/home/u/tmp", root: "/home/u/tmp" })).error, "Refusing to delete the shown folder");
  assert.equal(mutating().length, 0);
});

test("remove: an unreadable guard answer stops the deletion", async () => {
  const { ops, mutating } = recorder({ guard: () => ({ code: 1, stdout: "", stderr: "boom" }) });
  assert.equal((await ops.remove({ on: "box", path: "/srv/x/a", root: "/srv/x" })).ok, false);
  const rej = recorder({ guard: () => { throw new Error('`herdr.exec`: unknown machine "box"'); } });
  assert.deepEqual(await rej.ops.remove({ on: "box", path: "/srv/x/a", root: "/srv/x" }), { ok: false, error: "Unknown machine: box" });
  assert.equal(mutating().length + rej.mutating().length, 0);
});

test("remove local: /usr/bin/trash gets -s -v and the absolute path, trash_path comes from its Moved line", async () => {
  const d = guardTree(), root = `${d}/Users/m/proj`;
  const { ops, mutating } = recorder({
    env: { HOME: `${d}/Users/m` },
    answer: (cmd, args) => cmd === "/usr/bin/trash" ? { code: 0, stdout: `# Moved "${args[2]}" to "/Users/x/.Trash/a.txt"\n`, stderr: "" } : undefined,
  });
  const r = await ops.remove({ on: null, path: `${root}/a.txt/`, root });
  assert.deepEqual(r, { ok: true, trashed: true, trash_path: "/Users/x/.Trash/a.txt", name: "a.txt", isDir: false });
  assert.deepEqual(mutating().map((c) => [c.cmd, c.args, c.on]), [["/usr/bin/trash", ["-s", "-v", `${root}/a.txt`], null]]);
});

test("remove local: a link to a folder is trashed as the link, spelled without the trailing slash", async () => {
  const d = guardTree(), root = `${d}/Users/m`;
  fs.symlinkSync(`${d}/a`, `${root}/proj/dirlink`);
  const { ops, mutating } = recorder({ env: { HOME: root } });
  const r = await ops.remove({ on: null, path: `${root}/proj/dirlink/`, root: `${root}/proj` });
  assert.equal(r.ok, true);
  assert.equal(r.isDir, false);
  assert.deepEqual(mutating()[0].args, ["-s", "-v", `${root}/proj/dirlink`]);
});

test("remove local: no trash tool gives the macOS 15 message, a failing trash is explained", async () => {
  const d = guardTree(), root = `${d}/Users/m/proj`, env = { HOME: `${d}/Users/m` };
  const none = recorder({ env, answer: (cmd) => { if (cmd === "/usr/bin/trash") throw new Error("spawn /usr/bin/trash ENOENT"); } });
  assert.deepEqual(await none.ops.remove({ on: null, path: `${root}/a.txt`, root }), { ok: false, error: "Moving to the Trash needs macOS 15 or later" });
  const blocked = recorder({ env, answer: (cmd) => cmd === "/usr/bin/trash" ? { code: 5, stdout: "", stderr: "Error: Operation not permitted" } : undefined });
  assert.match((await blocked.ops.remove({ on: null, path: `${root}/a.txt`, root })).error, /^Not permitted: macOS privacy settings/);
});

test("remove remote: REMOVE_SCRIPT on the machine, no trash", async () => {
  const { ops, mutating } = recorder({ guard: fakeGuard(guardInfo({ 1: "d" })) });
  assert.deepEqual(await ops.remove({ on: "box", path: "/home/u/tmp/d/", root: "/home/u/tmp" }), { ok: true, trashed: false, name: "d", isDir: true });
  assert.deepEqual(mutating().map((c) => [c.cmd, c.args, c.on]), [["sh", ["-c", REMOVE_SCRIPT, "x", "/home/u/tmp/d", "/home/u/tmp/d"], "box"]]);
  const bad = recorder({ guard: fakeGuard(guardInfo()), answer: () => ({ code: 1, stdout: "", stderr: "Could not delete: /home/u/tmp/f\n" }) });
  assert.deepEqual(await bad.ops.remove({ on: "box", path: "/home/u/tmp/f", root: "/home/u/tmp" }), { ok: false, error: "Could not delete: /home/u/tmp/f" });
});

// A folder "foo<newline>" next to "foo": $(...) drops trailing newlines, so a careless capture of the
// physical parent would turn foo<newline>/x into foo/x and hit the neighbour.
function newlineTree() {
  const d = guardTree(), root = `${d}/Users/m/proj`;
  fs.mkdirSync(`${root}/foo\n`);
  fs.mkdirSync(`${root}/foo`);
  fs.writeFileSync(`${root}/foo\n/x`, "nl");
  fs.writeFileSync(`${root}/foo/x`, "neighbour");
  return { d, root };
}

test("delete and rename refuse paths and names with control characters", async () => {
  const { d, root } = newlineTree();
  const { ops, mutating } = recorder({ env: { HOME: `${d}/Users/m` } });
  const msg = "Names with control characters are not supported";
  assert.deepEqual(await ops.check({ on: null, path: `${root}/foo\n/x`, root }), { ok: false, error: msg });
  assert.deepEqual(await ops.remove({ on: null, path: `${root}/foo\n/x`, root }), { ok: false, error: msg });
  assert.deepEqual(await ops.remove({ on: "box", path: `${root}/foo\n`, root }), { ok: false, error: msg });
  assert.deepEqual(await ops.rename({ on: null, path: `${root}/foo\n/x`, root, name: "y" }), { ok: false, error: msg });
  assert.deepEqual(await ops.rename({ on: null, path: `${root}/foo/x`, root, name: "y\n" }), { ok: false, error: msg });
  assert.equal(mutating().length, 0);
  assert.equal(fs.readFileSync(`${root}/foo/x`, "utf8"), "neighbour");
});

test("GUARD_SCRIPT keeps a trailing newline in the physical parent, root and home", () => {
  const { d, root } = newlineTree();
  fs.mkdirSync(`${d}/home\n`);
  const out = parseGuard(sh(GUARD_SCRIPT, [`${root}/foo\n/x`, `${root}/foo\n`], { HOME: `${d}/home\n` }).stdout);
  assert.equal(out.parent, `${root}/foo\n`);
  assert.equal(out.root, `${root}/foo\n`);
  assert.equal(out.home, `${d}/home\n`);
});

test("CONFIRM_SCRIPT: the physical path must be the same entry as the input, a link as the link", () => {
  const { d, root } = newlineTree();
  assert.equal(sh(CONFIRM_SCRIPT, [`${root}/foo\n/x`, `${root}/foo\n/x`]).status, 0);
  assert.notEqual(sh(CONFIRM_SCRIPT, [`${root}/foo/x`, `${root}/foo\n/x`]).status, 0); // the neighbour is never taken
  assert.equal(sh(CONFIRM_SCRIPT, [`${root}/a.txt`, `${d}/viaLink/a.txt`]).status, 0);
  fs.symlinkSync(`${root}/a.txt`, `${root}/lnk`);
  assert.equal(sh(CONFIRM_SCRIPT, [`${root}/lnk`, `${d}/viaLink/lnk`]).status, 0);
  assert.notEqual(sh(CONFIRM_SCRIPT, [`${root}/a.txt`, `${root}/lnk`]).status, 0); // -ef would follow the link
  assert.notEqual(sh(CONFIRM_SCRIPT, [`${root}/lnk`, `${root}/a.txt`]).status, 0);
  assert.notEqual(sh(CONFIRM_SCRIPT, [`${root}/gone`, `${root}/gone`]).status, 0);
});

test("REMOVE_SCRIPT and RENAME_SCRIPT confirm the physical path against the input before rm and mv", () => {
  const { root } = newlineTree();
  assert.notEqual(sh(REMOVE_SCRIPT, [`${root}/foo/x`, `${root}/foo\n/x`]).status, 0);
  assert.notEqual(sh(RENAME_SCRIPT, [`${root}/foo/x`, `${root}/foo/y`, "0", `${root}/foo\n/x`]).status, 0);
  assert.equal(fs.readFileSync(`${root}/foo/x`, "utf8"), "neighbour");
  assert.equal(sh(RENAME_SCRIPT, [`${root}/foo\n/x`, `${root}/foo\n/y`, "0", `${root}/foo\n/x`]).status, 0);
  assert.equal(sh(REMOVE_SCRIPT, [`${root}/foo\n/y`, `${root}/foo\n/y`]).status, 0);
  assert.equal(fs.readFileSync(`${root}/foo/x`, "utf8"), "neighbour");
  assert.deepEqual(fs.readdirSync(`${root}/foo\n`), []);
});

test("remove and rename hand the input along for the confirmation", async () => {
  const d = guardTree(), root = `${d}/Users/m/proj`;
  const { ops, calls } = recorder({ env: { HOME: `${d}/Users/m` } });
  await ops.remove({ on: null, path: `${d}/viaLink/a.txt`, root });
  assert.deepEqual(calls.find((c) => c.args?.[1] === CONFIRM_SCRIPT).args.slice(3), [`${root}/a.txt`, `${d}/viaLink/a.txt`]);
  const remote = recorder({ guard: fakeGuard(guardInfo({ 2: "/home/u/tmp/in" })) });
  await remote.ops.remove({ on: "box", path: "/home/u/link/a", root: "/home/u/tmp" });
  await remote.ops.rename({ on: "box", path: "/home/u/link/a", root: "/home/u/tmp", name: "b" });
  assert.deepEqual(remote.mutating().map((c) => c.args.slice(3)), [["/home/u/tmp/in/a", "/home/u/link/a"], ["/home/u/tmp/in/a", "/home/u/tmp/in/b", "0", "/home/u/link/a"]]);
});

test("check: returns name and type without deleting", async () => {
  const { ops, mutating } = recorder({ guard: fakeGuard(guardInfo({ 1: "d" })) });
  assert.deepEqual(await ops.check({ on: "box", path: "/home/u/tmp/d", root: "/home/u/tmp" }), { ok: true, path: "/home/u/tmp/d", name: "d", isDir: true });
  assert.equal(mutating().length, 0);
});

test("rename: validates, guards, builds the destination, passes caseOnly locally only", async () => {
  const d = guardTree(), root = `${d}/Users/m/proj`, env = { HOME: `${d}/Users/m` };
  const { ops, mutating } = recorder({ env });
  assert.deepEqual(await ops.rename({ on: null, path: `${root}/a.txt`, root, name: "b/c" }), { ok: false, error: 'A name cannot contain "/"' });
  assert.deepEqual(await ops.rename({ on: null, path: `${root}/a.txt`, root, name: "a.txt" }), { ok: false, error: "The name is unchanged" });
  assert.deepEqual(await ops.rename({ on: null, path: `${root}/a.txt`, name: "x" }), { ok: false, error: "root is required" });
  assert.deepEqual(await ops.rename({ on: null, path: "/", root, name: "x" }), { ok: false, error: "Refusing to rename this folder" });
  assert.deepEqual(await ops.rename({ on: null, path: `${d}/Users/m`, root, name: "x" }), { ok: false, error: "Refusing to rename this folder" });
  assert.deepEqual(await ops.rename({ on: null, path: root, root, name: "x" }), { ok: false, error: "Refusing to rename this folder" });
  assert.equal(mutating().length, 0);
  assert.deepEqual(await ops.rename({ on: null, path: `${root}/readme.md/`, root, name: "README.md" }), { ok: false, error: `No such file or folder: ${root}/readme.md` });
  fs.writeFileSync(`${root}/readme.md`, "r");
  assert.deepEqual(await ops.rename({ on: null, path: `${root}/readme.md`, root, name: "README.md" }), { ok: true, path: `${root}/README.md` });
  assert.deepEqual(mutating().at(-1).args.slice(2), ["x", `${root}/readme.md`, `${root}/README.md`, "1", `${root}/readme.md`]);
  assert.deepEqual(await ops.rename({ on: null, path: `${root}/a.txt`, root, name: "z.txt" }), { ok: true, path: `${root}/z.txt` });
  assert.equal(mutating().at(-1).args.at(-2), "0");
});

test("rename remote: the machine runs it, a change of letter case only is flagged for the script's -ef check", async () => {
  const { ops, mutating } = recorder({ guard: fakeGuard(guardInfo({ 2: "/home/u/tmp/in" })) });
  assert.deepEqual(await ops.rename({ on: "box", path: "/home/u/tmp/in/a.txt/", root: "/home/u/tmp", name: "A.txt" }), { ok: true, path: "/home/u/tmp/in/A.txt" });
  const c = mutating()[0];
  assert.deepEqual(c.args.slice(2), ["x", "/home/u/tmp/in/a.txt", "/home/u/tmp/in/A.txt", "1", "/home/u/tmp/in/a.txt"]);
  assert.equal(c.on, "box");
  assert.equal((await ops.rename({ on: "box", path: "/home/u/tmp/in/a.txt", root: "/home/u/tmp", name: "b.txt" })).ok, true);
  assert.equal(mutating().at(-1).args.at(-2), "0");
});

test("RENAME_SCRIPT: caseOnly=1 without an existing target still never overwrites (mv -n)", () => {
  const d = tmp();
  fs.writeFileSync(`${d}/a.txt`, "a");
  const r = sh(RENAME_SCRIPT, [`${d}/a.txt`, `${d}/b.txt`, "1", `${d}/a.txt`], racingMv(d));
  assert.equal(r.status, 4, r.stderr);
  assert.equal(fs.readFileSync(`${d}/b.txt`, "utf8"), "other");
  assert.equal(fs.readFileSync(`${d}/a.txt`, "utf8"), "a");
});

test("rename: exit codes become messages", async () => {
  const mk = (code, stderr = "") => recorder({ guard: fakeGuard(guardInfo()), answer: () => ({ code, stdout: "", stderr }) }).ops;
  const args = { on: "box", path: "/home/u/tmp/a.txt", root: "/home/u/tmp", name: "b.txt" };
  assert.deepEqual(await mk(4).rename(args), { ok: false, error: '"b.txt" already exists' });
  assert.deepEqual(await mk(3).rename(args), { ok: false, error: "No such file or folder: /home/u/tmp/a.txt" });
  assert.deepEqual(await mk(1, "mv: rename: Permission denied\r\n").rename(args), { ok: false, error: "mv: rename: Permission denied" });
});

test("successToast", () => {
  assert.deepEqual(successToast({ action: "rename", path: "/Users/m/a.txt", name: "b.txt" }, { ok: true, path: "/Users/m/b.txt" }), { title: "Renamed", body: "a.txt → b.txt", level: "success" });
  assert.deepEqual(successToast({ action: "delete", path: "/Users/m/a.txt" }, { ok: true, trashed: true, name: "a.txt" }), { title: "Moved to Trash", body: "a.txt", level: "success" });
  assert.deepEqual(successToast({ action: "delete", machine: "box", path: "/srv/d" }, { ok: true, trashed: false, name: "d" }), { title: "Deleted", body: "d on box", level: "success" });
  assert.equal(successToast({ action: "rename" }, { ok: false, error: "x" }), null);
  assert.equal(successToast({ action: "clip" }, { ok: true }), null);
  assert.equal(successToast({ action: "paste" }, { ok: true, jobs: [] }), null);
});

// ---- mkdir: real file system, but only in throwaway folders below tmp/ of the repo
const mkdirScratch = () => mkTmpSync("mkdir-");
const localExec = async (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};
const mkdirOps = () => createFileOps({ exec: localExec });

test("mkdir: creates the folder in the parent and answers its path", async () => {
  const d = mkdirScratch();
  const r = await mkdirOps().mkdir({ on: null, path: d, name: "New Folder" });
  assert.deepEqual(r, { ok: true, path: `${fs.realpathSync(d)}/New Folder` });
  assert.equal(fs.statSync(`${d}/New Folder`).isDirectory(), true);
});

test("mkdir: names with spaces, a leading dash and umlauts", async () => {
  const d = mkdirScratch();
  for (const name of ["a b  c", "-rf", "--help", "Übergrößen äöü", ".hidden", "x*?[y"]) {
    const r = await mkdirOps().mkdir({ on: null, path: d, name });
    assert.equal(r.ok, true, name);
    assert.equal(fs.statSync(`${d}/${name}`).isDirectory(), true, name);
  }
  assert.equal(fs.readdirSync(d).length, 6);
});

test("mkdir: an existing file or folder is never touched", async () => {
  const d = mkdirScratch();
  fs.writeFileSync(`${d}/f.txt`, "keep");
  fs.mkdirSync(`${d}/dir`); fs.writeFileSync(`${d}/dir/in.txt`, "inside");
  fs.symlinkSync(`${d}/nowhere`, `${d}/deadlink`);
  assert.deepEqual(await mkdirOps().mkdir({ on: null, path: d, name: "f.txt" }), { ok: false, error: 'An item named "f.txt" already exists' });
  assert.deepEqual(await mkdirOps().mkdir({ on: null, path: d, name: "dir" }), { ok: false, error: 'An item named "dir" already exists' });
  assert.deepEqual(await mkdirOps().mkdir({ on: null, path: d, name: "deadlink" }), { ok: false, error: 'An item named "deadlink" already exists' });
  assert.equal(fs.readFileSync(`${d}/f.txt`, "utf8"), "keep");
  assert.equal(fs.readFileSync(`${d}/dir/in.txt`, "utf8"), "inside");
});

test("mkdir: a missing parent or a parent that is a file creates nothing", async () => {
  const d = mkdirScratch();
  fs.writeFileSync(`${d}/f.txt`, "x");
  const gone = await mkdirOps().mkdir({ on: null, path: `${d}/missing`, name: "n" });
  assert.deepEqual(gone, { ok: false, error: `No such folder: ${d}/missing` });
  assert.equal(fs.existsSync(`${d}/missing`), false, "no -p");
  const file = await mkdirOps().mkdir({ on: null, path: `${d}/f.txt`, name: "n" });
  assert.deepEqual(file, { ok: false, error: `No such folder: ${d}/f.txt` });
  assert.deepEqual(fs.readdirSync(d), ["f.txt"]);
});

test("mkdir: a parent that is a link lands in the link target", async () => {
  const d = mkdirScratch();
  fs.mkdirSync(`${d}/real`); fs.symlinkSync(`${d}/real`, `${d}/link`);
  const r = await mkdirOps().mkdir({ on: null, path: `${d}/link`, name: "n" });
  assert.deepEqual(r, { ok: true, path: `${fs.realpathSync(d)}/real/n` });
});

test("mkdir: invalid names and paths are refused before any command runs", async () => {
  const calls = [];
  const ops = createFileOps({ exec: async (...a) => (calls.push(a), { code: 0, stdout: "", stderr: "" }) });
  const cases = [
    [{ path: "/nonexistent-mkdir-test", name: "" }, "Enter a name"],
    [{ path: "/nonexistent-mkdir-test", name: "a/b" }, 'A name cannot contain "/"'],
    [{ path: "/nonexistent-mkdir-test", name: "." }, '"." and ".." are not allowed'],
    [{ path: "/nonexistent-mkdir-test", name: ".." }, '"." and ".." are not allowed'],
    [{ path: "/nonexistent-mkdir-test", name: "a\nb" }, "Names with control characters are not supported"],
    [{ path: "relative", name: "n" }, "path must be absolute"],
    [{ path: "/nonexistent-mkdir-test/a\nb", name: "n" }, "Names with control characters are not supported"],
  ];
  for (const [args, error] of cases) assert.deepEqual(await ops.mkdir({ on: null, ...args }), { ok: false, error }, JSON.stringify(args));
  assert.equal(calls.length, 0);
});

test("mkdir: the script itself refuses a bad name or parent (exit 2)", () => {
  const d = mkdirScratch();
  for (const [parent, name] of [[d, "a/b"], [d, ""], [d, "."], [d, ".."], ["rel", "n"], ["", "n"]]) {
    const r = sh(MKDIR_SCRIPT, [parent, name]);
    assert.equal(r.status, 2, `${parent} ${name}`);
  }
  assert.deepEqual(fs.readdirSync(d), []);
});

test("mkdir: remote runs through exec with the machine and paths as arguments only", async () => {
  const calls = [];
  const ops = createFileOps({ exec: async (cmd, args, opts) => (calls.push({ cmd, args, on: opts.on }), { code: 0, stdout: "/srv/a b/-n", stderr: "" }) });
  const r = await ops.mkdir({ on: "box", path: "/srv/a b", name: "-n" });
  assert.deepEqual(r, { ok: true, path: "/srv/a b/-n" });
  assert.deepEqual(calls, [{ cmd: "sh", args: ["-c", MKDIR_SCRIPT, "x", "/srv/a b", "-n"], on: "box" }]);
});

test("successToast: mkdir", () => {
  assert.deepEqual(successToast({ action: "mkdir" }, { ok: true, path: "/a/b" }), { title: "Folder created", body: "b", level: "success" });
});

test("the shown folder as a link is refused in every spelling: NFD for NFC, other letter case, local and remote", async (t) => {
  const d = guardTree();
  if (!caseInsensitive(d)) return t.skip("this file system tells the spellings apart");
  const nfc = "Ünter-Proj".normalize("NFC"), nfd = nfc.normalize("NFD");
  fs.symlinkSync(`${d}/Users/m/proj`, `${d}/${nfc}`);
  if (!fs.existsSync(`${d}/${nfd}`)) return t.skip("this file system tells NFC from NFD");
  const root = `${d}/${nfc}`;
  const { ops, mutating } = recorder({ env: { HOME: `${d}/Users/m` } });
  for (const on of [null, "mac"]) {
    for (const p of [`${d}/${nfd}`, `${d}/${nfc.toUpperCase()}`, `${d}/${nfd.toLowerCase()}`]) {
      assert.equal((await ops.remove({ on, path: p, root })).error, "Refusing to delete the shown folder", `${on} ${p}`);
      assert.equal((await ops.rename({ on, path: p, root, name: "x" })).error, "Refusing to rename this folder", `${on} ${p}`);
    }
  }
  assert.equal(mutating().length, 0);
  assert.equal(fs.lstatSync(root).isSymbolicLink(), true);
});

test("guardVerdict refuses a system folder the script reports, and closes on an unknown answer", () => {
  assert.equal(verdict("/usr/local/lib", { parent: "/usr/local", system: "y" }), "Refusing to delete a system folder");
  assert.equal(verdict("/usr/local/lib", { parent: "/usr/local", system: "y" }, { verb: "rename" }), "Refusing to rename this folder");
  assert.equal(verdict("/Users/m/git/x/a", { system: "?" }), "Could not check the path");
  assert.equal(verdict("/Users/m/git/x/a", { system: undefined }), "Could not check the path");
});

// A fake system below a throw-away folder: GUARD_SCRIPT gets its base as 4th argument (empty in production),
// so no test asks about the real /usr, /System or /Volumes.
function systemTree() {
  const b = tmp();
  for (const dir of ["System/Volumes/Data/x", "private/var/folders/t", "private/etc/ssh", "private/tmp/t", "Users/Shared/f", "Users/m/proj",
    "Library/x", "Applications/A.app", "Volumes/USB/data", "opt/app", "srv/www", "root/x", "boot/x", "usr/lib/x", "usr/local/bin", "etc/ssh", "lib64/x", "sbin/x"]) fs.mkdirSync(`${b}/${dir}`, { recursive: true });
  fs.symlinkSync(b, `${b}/Volumes/HD`); // like /Volumes/Macintosh HD -> /
  fs.symlinkSync(`${b}/private/var`, `${b}/var`); // macOS: /var -> /private/var, protected as a level only
  fs.symlinkSync(`${b}/System`, `${b}/Users/m/alias`); // another spelling of System
  fs.symlinkSync(`${b}/usr/lib`, `${b}/Users/m/proj/libs`); // a link to a system folder
  return b;
}
const systemField = (b, p) => {
  const r = sh(GUARD_SCRIPT, [p, `${b}/Users/m/proj`, "0", b], { HOME: `${b}/Users/m` });
  assert.equal(r.status, 0, r.stderr);
  return parseGuard(r.stdout).system;
};

test("GUARD_SCRIPT: system folders and everything above them are refused by -ef, /usr and /etc with all below", () => {
  const b = systemTree();
  for (const rel of ["System", "System/Volumes", "System/Volumes/Data", "private", "private/var", "private/etc", "private/tmp", "Users/Shared", "Users",
    "Library", "Applications", "Volumes", "Volumes/USB", "Volumes/HD", "opt", "srv", "root", "boot", "lib64", "sbin", "var",
    "usr", "usr/lib", "usr/lib/x", "usr/local/bin", "etc", "etc/ssh", "Users/m/alias/Volumes", "Users/m/alias/Volumes/Data"]) {
    assert.equal(systemField(b, `${b}/${rel}`), "y", rel);
  }
});

// A hung network mount in /Volumes blocks every stat of its entry: only a path directly in /Volumes may look there.
test("GUARD_SCRIPT: the entries of /Volumes are only looked at for a path directly in /Volumes", () => {
  const b = systemTree();
  const trace = (p) => spawnSync("sh", ["-x", "-c", GUARD_SCRIPT, "x", p, `${b}/Users/m/proj`, "0", b], { env: { ...process.env, HOME: `${b}/Users/m` }, encoding: "utf8" }).stderr;
  assert.doesNotMatch(trace(`${b}/Users/m/proj/new.txt`), /Volumes\/USB/);
  assert.doesNotMatch(trace(`${b}/Library/x`), /Volumes\/USB/);
  assert.match(trace(`${b}/Volumes/USB`), /Volumes\/USB/);
});

test("GUARD_SCRIPT: below the level-only system folders, and a link to one, stay allowed", () => {
  const b = systemTree();
  for (const rel of ["System/Volumes/Data/x", "private/var/folders", "private/var/folders/t", "var/folders/t", "private/etc/ssh", "private/tmp/t", "Users/Shared/f",
    "Library/x", "Applications/A.app", "Volumes/USB/data", "opt/app", "srv/www", "root/x", "Users/m/proj/libs"]) {
    assert.equal(systemField(b, `${b}/${rel}`), "n", rel);
  }
});

test("remove and rename never reach rm or mv for a system folder", async () => {
  const { ops, mutating } = recorder({ guard: fakeGuard(guardInfo({ 2: "/usr/local", 8: "y" })) });
  assert.equal((await ops.remove({ on: "box", path: "/usr/local/lib", root: "/home/u/tmp" })).error, "Refusing to delete a system folder");
  assert.equal((await ops.rename({ on: "box", path: "/usr/local/lib", root: "/home/u/tmp", name: "x" })).error, "Refusing to rename this folder");
  assert.equal(mutating().length, 0);
});

test("rename remote on a Mac: readme.md -> README.md renames instead of saying it exists", async (t) => {
  const d = guardTree(), root = `${d}/Users/m/proj`;
  if (!caseInsensitive(d)) return t.skip("this file system tells README.md from readme.md");
  fs.writeFileSync(`${root}/readme.md`, "r");
  // The machine "mac" is this computer: every script runs for real, inside d only.
  const exec = async (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, HOME: `${d}/Users/m` } });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const ops = createFileOps({ exec });
  assert.deepEqual(await ops.rename({ on: "mac", path: `${root}/readme.md`, root, name: "README.md" }), { ok: true, path: `${root}/README.md` });
  assert.ok(fs.readdirSync(root).includes("README.md"));
  assert.equal(fs.readFileSync(`${root}/README.md`, "utf8"), "r");
});

test("delete and rename below the root folder / (issue #14)", () => {
  const p = joinPath("/", "home/u/a.txt");
  assert.equal(p, "/home/u/a.txt");
  assert.equal(guardVerdict({ path: p, info: { exists: true, parent: "/home/u", root: "/", home: "/home/u", coversHome: "n", coversRoot: "n", rootEntry: false, system: "n" }, rootPath: "/", on: "box", verb: "delete" }), null);
  assert.equal(guardVerdict({ path: `/${p}`, info: {}, rootPath: "/", on: "box", verb: "delete" }), 'Path must not contain ".", ".." or "//"');
});

// ---- Empty stderr (#34): every operation names what failed, never "Transfer failed" or an empty text.
test("empty stderr gives the text of the operation", async () => {
  const empty = () => ({ code: 1, stdout: "", stderr: "" });
  const g = recorder({ guard: empty });
  assert.deepEqual(await g.ops.remove({ on: "box", path: "/home/u/tmp/f", root: "/home/u/tmp" }), { ok: false, error: "Could not check the path" });
  const rm = recorder({ guard: fakeGuard(guardInfo()), answer: empty });
  assert.deepEqual(await rm.ops.remove({ on: "box", path: "/home/u/tmp/f", root: "/home/u/tmp" }), { ok: false, error: "Could not delete" });
  const rn = recorder({ guard: fakeGuard(guardInfo()), answer: empty });
  assert.deepEqual(await rn.ops.rename({ on: "box", path: "/home/u/tmp/f", root: "/home/u/tmp", name: "g" }), { ok: false, error: "Could not rename" });
  const mk = recorder({ answer: empty });
  assert.deepEqual(await mk.ops.mkdir({ on: "box", path: "/home/u/tmp", name: "n" }), { ok: false, error: "Could not create the folder" });
  const d = guardTree(), root = `${d}/Users/m/proj`;
  const tr = recorder({ env: { HOME: `${d}/Users/m` }, answer: (cmd) => (cmd === "/usr/bin/trash" ? empty() : undefined) });
  assert.deepEqual(await tr.ops.remove({ on: null, path: `${root}/a.txt`, root }), { ok: false, error: "Could not move to the Trash" });
});
