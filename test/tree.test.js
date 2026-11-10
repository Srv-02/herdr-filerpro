import { test } from "node:test";
import assert from "node:assert/strict";
import { pruneFolder, folderMissing, expandPath, visibleRows, ROW_H, LIST_SCRIPT, psListCommand, parseListing, psEntries, limitText } from "../mods/filer-pro/lib/tree.js";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkTmpSync } from "./tmp-helper.js";
import { withoutIntl } from "./no-intl.js";

test("pruneFolder drops a vanished folder and everything below it, nothing else", () => {
  const folders = new Set(["a", "a/b", "a/b/c", "ab", "d"]);
  const entries = new Map([["", [1]], ["a", [2]], ["a/b", [3]], ["a/b/c", [4]], ["ab", [5]], ["d", [6]]]);
  pruneFolder(folders, entries, "a");
  assert.deepEqual([...folders].sort(), ["ab", "d"]);
  assert.deepEqual([...entries.keys()].sort(), ["", "ab", "d"]); // "ab" is not below "a"
});

test("pruneFolder on an unknown path changes nothing", () => {
  const folders = new Set(["a"]);
  const entries = new Map([["a", [1]]]);
  pruneFolder(folders, entries, "zzz");
  assert.deepEqual([...folders], ["a"]);
  assert.deepEqual([...entries.keys()], ["a"]);
});

test("folderMissing: a failed listing without any message means the folder is gone", () => {
  assert.equal(folderMissing({ code: 1, stdout: "", stderr: "" }), true);
  assert.equal(folderMissing({ code: 1, stdout: "", stderr: "  \n" }), true);
  assert.equal(folderMissing({ code: 255, stdout: "", stderr: "ssh: Could not resolve hostname box" }), false);
  assert.equal(folderMissing({ code: 0, stdout: "", stderr: "" }), false);
});

test("expandPath: the folder to open after a new folder, relative to the shown root", () => {
  assert.equal(expandPath({ machine: null, folder: "/r/a/b" }, "/r", null), "a/b");
  assert.equal(expandPath({ machine: "box", folder: "/r/a" }, "/r", "box"), "a");
  assert.equal(expandPath({ machine: undefined, folder: "/r/a" }, "/r/", null), "a");
  assert.equal(expandPath({ machine: null, folder: "/r" }, "/r", null), null, "the root is always open");
  assert.equal(expandPath({ machine: "box", folder: "/r/a" }, "/r", null), null, "other machine");
  assert.equal(expandPath({ machine: null, folder: "/rx/a" }, "/r", null), null, "sibling with a longer name");
  assert.equal(expandPath({ machine: null, folder: "/other/a" }, "/r", null), null);
  assert.equal(expandPath(undefined, "/r", null), null);
  assert.equal(expandPath({ machine: null, folder: "/r/a" }, undefined, null), null);
});

const dir = (name) => ({ name, dir: true }), file = (name) => ({ name, dir: false });

test("visibleRows: tree order, only open folders are descended into", () => {
  const entries = new Map([["", [dir("a"), dir("b"), file("z.txt")]], ["a", [dir("c"), file("x.png")]], ["a/c", [file("y.md")]], ["b", [file("hidden")]]]);
  const rows = visibleRows(entries, new Set(["a", "a/c"]));
  assert.deepEqual(rows.map((r) => [r.path, r.depth]), [["a", 0], ["a/c", 1], ["a/c/y.md", 2], ["a/x.png", 1], ["b", 0], ["z.txt", 0]]);
  assert.equal(rows[0].entry, entries.get("")[0], "the entry object itself is handed out");
});

test("visibleRows: an open folder without loaded entries adds no rows", () => {
  assert.deepEqual(visibleRows(new Map([["", [dir("a")]]]), new Set(["a"])).map((r) => r.path), ["a"]);
  assert.deepEqual(visibleRows(new Map(), new Set()), []);
});

test("visibleRows: stops at the total limit", () => {
  const entries = new Map([["", [dir("a"), file("b"), file("c")]], ["a", [file("1"), file("2")]]]);
  assert.deepEqual(visibleRows(entries, new Set(["a"]), { limit: 3 }).map((r) => r.path), ["a", "a/1", "a/2"]);
  assert.equal(visibleRows(entries, new Set(["a"])).length, 5, "default limit 5000");
});

test("visibleRows: folders deeper than maxDepth are not descended into", () => {
  const entries = new Map(), folders = new Set();
  let prefix = "";
  for (let i = 0; i < 45; i++) {
    entries.set(prefix, [dir("d")]);
    prefix = prefix ? `${prefix}/d` : "d";
    folders.add(prefix);
  }
  const rows = visibleRows(entries, folders);
  assert.equal(rows.length, 41, "depths 0..40 as in rows(): a call deeper than 40 returns at once");
  assert.equal(rows.at(-1).depth, 40);
  assert.equal(visibleRows(entries, folders, { maxDepth: 2 }).length, 3);
});

test("ROW_H is the 28px row height of the tree", () => {
  assert.equal(ROW_H, 28);
});

test("LIST_SCRIPT stops one entry past the per-folder limit given as $2", () => {
  const d = mkTmpSync("filer-pro-list-");
  try {
    for (let i = 0; i < 15; i++) fs.writeFileSync(path.join(d, `f${i}`), "");
    const count = (limit) => spawnSync("sh", ["-c", LIST_SCRIPT, "files", d, String(limit)], { encoding: "utf8" }).stdout.split("\0").filter(Boolean).length / 2;
    assert.equal(count(10), 11);
    assert.equal(count(500), 15);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("psListCommand asks for one entry past the limit and quotes the path", () => {
  const cmd = psListCommand("C:\\it's", 500);
  assert.match(cmd, /Select-Object -First 501 /);
  assert.ok(cmd.endsWith("'C:\\it''s'"));
  assert.match(psListCommand("C:\\x", 20), /-First 21 /);
});

test("limitText names the configured numbers, also without Intl (herdr's engine)", async () => {
  await withoutIntl(() => {
    assert.equal(limitText(500, 5000), "File list limited to 500 entries per folder and 5,000 total");
    assert.equal(limitText(1200, 20000), "File list limited to 1,200 entries per folder and 20,000 total");
  });
});

// Issue #58: file sizes from one batched stat in the same sh -c as the listing.
function sizeFixture() {
  const d = mkTmpSync("filer-pro-sizes-");
  fs.writeFileSync(path.join(d, "a b.txt"), "hello");
  fs.writeFileSync(path.join(d, "-lead"), "x".repeat(1500));
  fs.writeFileSync(path.join(d, "new\nline"), "12");
  fs.writeFileSync(path.join(d, "empty"), "");
  fs.mkdirSync(path.join(d, "sub"));
  fs.writeFileSync(path.join(d, "sub", "inner"), "not counted");
  fs.symlinkSync("a b.txt", path.join(d, "link"));
  fs.symlinkSync("sub", path.join(d, "dirlink"));
  return d;
}
const sizesOf = (stdout) => Object.fromEntries(parseListing(stdout).map((e) => [e.name, e.dir ? "dir" : e.size]));
const EXPECTED = { "a b.txt": 5, "-lead": 1500, "new\nline": 2, empty: 0, sub: "dir", link: 7, dirlink: "dir" };
const SHELLS = ["sh", ...["/bin/dash", "/usr/bin/dash"].filter((p) => fs.existsSync(p)).slice(0, 1)];

for (const shell of SHELLS) test(`LIST_SCRIPT with <sizes> 1 gives each file's size, a link as itself (${shell})`, () => {
  const d = sizeFixture();
  const r = spawnSync(shell, ["-c", LIST_SCRIPT, "files", d, "500", "0", "0", "0", "1"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.deepEqual(sizesOf(r.stdout), EXPECTED);
});

// GNU stat (-c%s) is what Linux machines have; tested where it is installed as gstat (Homebrew coreutils) or is the stat.
const GSTAT = ["/opt/homebrew/bin/gstat", "/usr/local/bin/gstat"].find((p) => fs.existsSync(p));
test("LIST_SCRIPT sizes with GNU stat", { skip: !GSTAT && process.platform !== "linux" && "no GNU stat here" }, () => {
  const d = sizeFixture(), bin = mkTmpSync("filer-pro-gnu-");
  if (GSTAT) fs.symlinkSync(GSTAT, path.join(bin, "stat"));
  const r = spawnSync("sh", ["-c", LIST_SCRIPT, "files", d, "500", "0", "0", "0", "1"], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(sizesOf(r.stdout), EXPECTED);
});

test("LIST_SCRIPT with sizes keeps the real path pair, the limit and the exit code of a missing folder", () => {
  const d = sizeFixture();
  const r = spawnSync("sh", ["-c", LIST_SCRIPT, "files", path.join(d, "sub"), "500", "0", "0", "1", "1"], { encoding: "utf8" });
  const list = parseListing(r.stdout);
  assert.equal(list.real, fs.realpathSync(path.join(d, "sub")));
  assert.deepEqual(list.map((e) => [e.name, e.size]), [["inner", 11]]);
  const cut = parseListing(spawnSync("sh", ["-c", LIST_SCRIPT, "files", d, "2", "0", "0", "0", "1"], { encoding: "utf8" }).stdout);
  assert.equal(cut.length, 3, "one past the limit, as without sizes");
  assert.ok(cut.filter((e) => !e.dir).every((e) => Number.isInteger(e.size)));
  const gone = spawnSync("sh", ["-c", LIST_SCRIPT, "files", path.join(d, "nope"), "500", "0", "0", "0", "1"], { encoding: "utf8" });
  assert.equal(folderMissing({ code: gone.status, stdout: gone.stdout, stderr: gone.stderr }), true);
});

test("LIST_SCRIPT without <sizes> runs no stat and no xargs (show_sizes off costs nothing)", () => {
  const d = sizeFixture(), bin = mkTmpSync("filer-pro-spy-"), log = path.join(bin, "log");
  for (const name of ["stat", "xargs"]) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho ${name} >> '${log}'\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  // `$5=1` prints the real path as `P\0<path>\0`: a folder name that ends in S must not look like the size marker, so one
  // of the two folders is named so on purpose (random folder names end in S about once in 62 runs).
  const endsInS = path.join(d, "dirS");
  fs.mkdirSync(endsInS);
  fs.writeFileSync(path.join(endsInS, "f"), "x");
  for (const dir of [d, endsInS]) {
    for (const args of [[], ["0", "0"], ["0", "0", "1"]]) {
      const r = spawnSync("sh", ["-c", LIST_SCRIPT, "files", dir, "500", ...args], { encoding: "utf8", env });
      assert.equal(r.status, 0);
      const list = parseListing(r.stdout);
      assert.ok(list.length > 0);
      assert.ok(list.every((e) => e.size === undefined), "no size block without <sizes>");
    }
  }
  assert.equal(fs.existsSync(log), false);
  spawnSync("sh", ["-c", LIST_SCRIPT, "files", d, "500", "0", "0", "0", "1"], { encoding: "utf8", env });
  assert.equal(fs.existsSync(log), true, "the spy itself works");
});

test("parseListing: pairs, the real path, a file named S, and sizes only when they match the files", () => {
  assert.deepEqual(parseListing("f\0S\0d\0x\0"), Object.assign([{ name: "S", dir: false }, { name: "x", dir: true }], { real: "" }));
  const withP = parseListing("P\0/real\0f\0a\0d\0b\0f\0c\0S\0" + "3\n40\0");
  assert.equal(withP.real, "/real");
  assert.deepEqual(withP.map((e) => [e.name, e.dir, e.size]), [["a", false, 3], ["b", true, undefined], ["c", false, 40]]);
  assert.deepEqual(parseListing("f\0a\0f\0b\0S\0" + "3\0").map((e) => e.size), [undefined, undefined], "a vanished file: no sizes at all");
  assert.deepEqual(parseListing("f\0a\0S\0x\0").map((e) => e.size), [undefined]);
  assert.deepEqual(parseListing("d\0a\0S\0\0").map((e) => e.name), ["a"], "no files, empty S block");
  assert.deepEqual(parseListing(""), Object.assign([], { real: "" }));
});

test("psListCommand adds the Length only with sizes; psEntries keeps a number on files only", () => {
  assert.equal(psListCommand("C:\\x", 20, {}).includes("size="), false);
  assert.match(psListCommand("C:\\x", 20, {}, true), /; size=\$_\.Length \} \}\)/);
  assert.deepEqual(psEntries([{ name: "a", dir: false, size: 12 }, { name: "b", dir: true, size: null }, { name: "c", dir: false }]),
    [{ name: "a", dir: false, size: 12 }, { name: "b", dir: true }, { name: "c", dir: false }]);
  assert.deepEqual(psEntries({ name: "one", dir: false }), [{ name: "one", dir: false }], "a single entry comes as an object");
});
