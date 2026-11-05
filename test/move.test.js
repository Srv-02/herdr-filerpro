import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createFileOps, GUARD_SCRIPT, REMOVE_SCRIPT } from "../mods/filer-pro/lib/fileops.js";
import { MOVE_CHECK_SCRIPT, MOVE_SCRIPT, parseMoveCheck, moveVerdict, createMoveOps, moveToasts } from "../mods/filer-pro/lib/move.js";
import { mkTmp, mkTmpSync } from "./tmp-helper.js";

const scratch = [];
after(() => {
  for (const d of scratch) fs.rmSync(d, { recursive: true, force: true });
});
function tmp() {
  const d = fs.realpathSync(mkTmpSync("move-"));
  scratch.push(d);
  return d;
}
const sh = (script, args, env = {}) => spawnSync("sh", ["-c", script, "x", ...args], { encoding: "utf8", env: { ...process.env, ...env } });
const caseInsensitive = (d) => { fs.writeFileSync(`${d}/CaseProbe`, ""); return fs.existsSync(`${d}/caseprobe`); };
const FAKE = (name) => `${path.resolve(import.meta.dirname, "fake", name)}:${process.env.PATH}`;
const P = (stdout) => parseMoveCheck(stdout);

function tree() { // src/a.txt, src/dir/sub/deep.txt, src/link -> src/dir, dst/, dst/a.txt (old), dst/dir/old.txt
  const d = tmp();
  fs.mkdirSync(`${d}/src/dir/sub`, { recursive: true }); fs.mkdirSync(`${d}/dst/dir`, { recursive: true });
  fs.writeFileSync(`${d}/src/a.txt`, "new"); fs.writeFileSync(`${d}/src/dir/sub/deep.txt`, "deep");
  fs.symlinkSync(`${d}/src/dir`, `${d}/src/link`);
  fs.writeFileSync(`${d}/dst/a.txt`, "old"); fs.writeFileSync(`${d}/dst/dir/old.txt`, "old");
  return d;
}
test("MOVE_CHECK_SCRIPT reports target, existing entry, same folder, into itself and devices", () => {
  const d = tree();
  const dev = (p) => String(fs.lstatSync(p).dev);
  assert.deepEqual(P(sh(MOVE_CHECK_SCRIPT, [`${d}/src/a.txt`, `${d}/dst/`, ""]).stdout),
    { destDir: `${d}/dst`, exists: true, type: "f", same: "n", into: "n", above: "n", mounted: "n", srcDev: dev(`${d}/src/a.txt`), destDev: dev(`${d}/dst`), trashDev: "" });
  assert.deepEqual(P(sh(MOVE_CHECK_SCRIPT, [`${d}/src/dir`, `${d}/dst`, `${d}/Trash`]).stdout),
    { destDir: `${d}/dst`, exists: true, type: "d", same: "n", into: "n", above: "n", mounted: "n", srcDev: dev(`${d}/src/dir`), destDev: dev(`${d}/dst`), trashDev: dev(d) }); // Trash missing: its parent's device
  assert.equal(P(sh(MOVE_CHECK_SCRIPT, [`${d}/src/a.txt`, `${d}/src`, ""]).stdout).same, "y");
  assert.equal(P(sh(MOVE_CHECK_SCRIPT, [`${d}/src/dir`, `${d}/src/dir/sub`, ""]).stdout).into, "y");
  assert.equal(P(sh(MOVE_CHECK_SCRIPT, [`${d}/src/dir`, `${d}/src/dir`, ""]).stdout).into, "y");
  assert.equal(P(sh(MOVE_CHECK_SCRIPT, [`${d}/src/a.txt`, `${d}/nope`, ""]).stdout).destDir, "");
  assert.equal(P(sh(MOVE_CHECK_SCRIPT, [`${d}/src/a.txt`, `${d}/dst`, ""]).stdout).exists, true);
  fs.symlinkSync(`${d}/gone`, `${d}/dst/dead`); fs.writeFileSync(`${d}/src/dead`, "");
  assert.equal(P(sh(MOVE_CHECK_SCRIPT, [`${d}/src/dead`, `${d}/dst`, ""]).stdout).type, "l");
});
test("MOVE_CHECK_SCRIPT: an existing target folder that contains the source is reported", () => {
  const d = tmp(); fs.mkdirSync(`${d}/x/b/b`, { recursive: true }); fs.mkdirSync(`${d}/y/b`, { recursive: true });
  assert.equal(P(sh(MOVE_CHECK_SCRIPT, [`${d}/x/b/b`, `${d}/x`, ""]).stdout).above, "y");
  assert.equal(P(sh(MOVE_CHECK_SCRIPT, [`${d}/x/b/b`, `${d}/y`, ""]).stdout).above, "n");
  fs.writeFileSync(`${d}/x/f`, ""); fs.mkdirSync(`${d}/x/d/f`, { recursive: true });
  assert.equal(P(sh(MOVE_CHECK_SCRIPT, [`${d}/x/d/f`, `${d}/x`, ""]).stdout).above, "n"); // a file at the target cannot contain anything
});
test("MOVE_CHECK_SCRIPT: a link to a folder is never 'into' its own target", () => {
  const d = tree();
  assert.equal(P(sh(MOVE_CHECK_SCRIPT, [`${d}/src/link`, `${d}/src/dir/sub`, ""]).stdout).into, "n");
  assert.equal(P(sh(MOVE_CHECK_SCRIPT, [`${d}/src/link`, `${d}/src/dir`, ""]).stdout).into, "n");
});
test("MOVE_CHECK_SCRIPT: a mount inside the existing target comes from the fake tables", () => {
  const d = tree();
  fs.writeFileSync(`${d}/info.txt`, `36 35 98:0 / ${d}/dst/dir/mnt rw,relatime shared:1 - ext4 /dev/sdb1 rw\n`);
  fs.writeFileSync(`${d}/mount.txt`, `/dev/disk9s1 on ${d}/dst/dir (hfs, local)\n`);
  let r = sh(MOVE_CHECK_SCRIPT, [`${d}/src/dir`, `${d}/dst`, "", `${d}/info.txt`, ""]);
  assert.equal(P(r.stdout).mounted, "y"); assert.match(r.stderr, /^Refusing to replace, a file system is mounted at: /m);
  r = sh(MOVE_CHECK_SCRIPT, [`${d}/src/dir`, `${d}/dst`, "", `${d}/none.txt`, `${d}/mount.txt`]);
  assert.equal(P(r.stdout).mounted, "y");
  r = sh(MOVE_CHECK_SCRIPT, [`${d}/src/a.txt`, `${d}/dst`, "", `${d}/info.txt`, ""]);
  assert.equal(P(r.stdout).mounted, "n"); // the existing target a.txt is a file: no mount check
  fs.writeFileSync(`${d}/empty.txt`, "");
  assert.equal(P(sh(MOVE_CHECK_SCRIPT, [`${d}/src/dir`, `${d}/dst`, "", `${d}/empty.txt`, ""]).stdout).mounted, "n");
});
test("MOVE_CHECK_SCRIPT and MOVE_SCRIPT: \"Dir\" over the existing \"dir\" with a mount refuses on a case-insensitive file system", (t) => {
  const d = tree();
  if (!caseInsensitive(d)) return t.skip("the file system here tells letter case apart");
  fs.renameSync(`${d}/src/dir`, `${d}/src/Dir`);
  fs.mkdirSync(`${d}/dst/dir/mnt`); fs.writeFileSync(`${d}/dst/dir/mnt/precious.txt`, "precious");
  fs.writeFileSync(`${d}/info.txt`, `36 35 98:0 / ${d}/dst/dir/mnt rw,relatime shared:1 - ext4 /dev/sdb1 rw\n`);
  fs.writeFileSync(`${d}/mount.txt`, `/dev/disk9s1 on ${d}/dst/dir/mnt (hfs, local)\n`);
  for (const tables of [[`${d}/info.txt`, ""], [`${d}/none.txt`, `${d}/mount.txt`]]) {
    const c = sh(MOVE_CHECK_SCRIPT, [`${d}/src/Dir`, `${d}/dst`, "", ...tables]);
    assert.equal(P(c.stdout).exists, true); assert.equal(P(c.stdout).mounted, "y", c.stderr);
    assert.match(c.stderr, /^Refusing to replace, a file system is mounted at: .*\/dst\/dir\/mnt$/m);
    const r = sh(MOVE_SCRIPT, [`${d}/src/Dir`, `${d}/dst/Dir`, `${d}/src/Dir`, "1", "", ...tables]);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /^Refusing to replace, a file system is mounted at: /m);
  }
  assert.equal(fs.readFileSync(`${d}/dst/dir/mnt/precious.txt`, "utf8"), "precious"); assert.equal(fs.readFileSync(`${d}/dst/dir/old.txt`, "utf8"), "old");
  assert.equal(fs.existsSync(`${d}/src/Dir/sub/deep.txt`), true); assert.deepEqual(fs.readdirSync(`${d}/dst`).sort(), ["a.txt", "dir"]);
});
test("MOVE_CHECK_SCRIPT and MOVE_SCRIPT: an NFC name over the existing NFD folder with a mount refuses (#31)", async (t) => {
  const d = fs.realpathSync(await mkTmp("move-nfd-"));
  const NFD = "cafe\u0301", NFC = "caf\u00e9";
  fs.mkdirSync(`${d}/src/${NFC}/sub`, { recursive: true }); fs.writeFileSync(`${d}/src/${NFC}/sub/deep.txt`, "deep");
  if (!fs.existsSync(`${d}/src/${NFD}`)) return t.skip("the file system here tells Unicode normal forms apart");
  fs.mkdirSync(`${d}/dst/${NFD}/mnt`, { recursive: true }); fs.writeFileSync(`${d}/dst/${NFD}/mnt/precious.txt`, "precious");
  fs.writeFileSync(`${d}/info.txt`, `36 35 98:0 / ${d}/dst/${NFD}/mnt rw,relatime shared:1 - ext4 /dev/sdb1 rw\n`);
  fs.writeFileSync(`${d}/mount.txt`, `/dev/disk9s1 on ${d}/dst/${NFD}/mnt (hfs, local)\n`);
  for (const shell of ["sh", ...(spawnSync("dash", ["-c", ":"]).status === 0 ? ["dash"] : [])]) {
    const run = (script, args) => spawnSync(shell, ["-c", script, "x", ...args], { encoding: "utf8" });
    for (const tables of [[`${d}/info.txt`, ""], [`${d}/none.txt`, `${d}/mount.txt`]]) {
      const c = run(MOVE_CHECK_SCRIPT, [`${d}/src/${NFC}`, `${d}/dst`, "", ...tables]);
      assert.equal(P(c.stdout).exists, true); assert.equal(P(c.stdout).mounted, "y", `${shell}: ${c.stderr}`);
      assert.match(c.stderr, /^Refusing to replace, a file system is mounted at: /m);
      const r = run(MOVE_SCRIPT, [`${d}/src/${NFC}`, `${d}/dst/${NFC}`, `${d}/src/${NFC}`, "1", "", ...tables]);
      assert.notEqual(r.status, 0, shell); assert.match(r.stderr, /^Refusing to replace, a file system is mounted at: /m);
    }
  }
  assert.equal(fs.readFileSync(`${d}/dst/${NFD}/mnt/precious.txt`, "utf8"), "precious");
  assert.equal(fs.existsSync(`${d}/src/${NFC}/sub/deep.txt`), true); assert.deepEqual(fs.readdirSync(`${d}/dst`), [NFD]);
});
test("MOVE_CHECK_SCRIPT reports another device for /dev", (t) => {
  const d = tmp(); fs.writeFileSync(`${d}/a.txt`, "a");
  if (fs.statSync("/dev").dev === fs.statSync(d).dev) return t.skip("no second volume here");
  const i = P(sh(MOVE_CHECK_SCRIPT, [`${d}/a.txt`, "/dev", ""]).stdout);
  assert.notEqual(i.srcDev, i.destDev);
  assert.deepEqual(moveVerdict({ info: i, src: `${d}/a.txt`, destDir: "/dev", stderr: "" }), { crossVolume: true });
});
test("moveVerdict: order of the answers, unknown device refuses, replaceError bundles the three replace bars", () => {
  const info = (o) => ({ destDir: "/x/dst", exists: false, type: "f", same: "n", into: "n", above: "n", mounted: "n", srcDev: "1", destDev: "1", trashDev: "", ...o });
  const v = (o, stderr = "") => moveVerdict({ info: info(o), src: "/x/a", destDir: "/x/dst/", stderr });
  assert.deepEqual(v({ destDir: "" }), { error: "Target folder does not exist: /x/dst/" });
  assert.deepEqual(v({ into: "y" }), { error: "Cannot move a folder into itself" });
  assert.deepEqual(v({ into: "?" }), { error: "Could not check the path" });
  assert.deepEqual(v({ same: "y" }), { noop: true });
  assert.deepEqual(v({ srcDev: "" }), { error: "Could not check the volume" });
  assert.deepEqual(v({ destDev: "2" }), { crossVolume: true });
  assert.deepEqual(v({}), { exists: false, destIsDir: false, dest: "/x/dst/a", replaceError: null });
  assert.deepEqual(v({ exists: true, type: "d" }), { exists: true, destIsDir: true, dest: "/x/dst/a", replaceError: null });
  assert.deepEqual(v({ exists: true, type: "d", above: "y" }), { exists: true, destIsDir: true, dest: "/x/dst/a", replaceError: "Cannot replace a folder that contains the source" });
  assert.deepEqual(v({ exists: true, type: "d", above: "?" }), { error: "Could not check the path" });
  assert.equal(v({ exists: true, type: "d", mounted: "y" }, "Refusing to replace, a file system is mounted at: /x/dst/a/mnt\n").replaceError, "Refusing to replace, a file system is mounted at: /x/dst/a/mnt");
  assert.equal(v({ exists: true, type: "f", trashDev: "2" }).replaceError, "Cannot replace here, the Trash lies on another volume");
  assert.equal(v({ exists: true, type: "f", trashDev: "1" }).replaceError, null);
  assert.equal(v({ exists: false, trashDev: "2" }).replaceError, null); // nothing to replace
});
test("MOVE_SCRIPT: moves a file and a folder, refuses an existing target without replace, moves a link as the link", () => {
  const d = tree();
  assert.equal(sh(MOVE_SCRIPT, [`${d}/src/a.txt`, `${d}/dst/a.txt`, `${d}/src/a.txt`, "0", ""]).status, 4);
  assert.equal(fs.readFileSync(`${d}/dst/a.txt`, "utf8"), "old"); assert.equal(fs.readFileSync(`${d}/src/a.txt`, "utf8"), "new");
  const r = sh(MOVE_SCRIPT, [`${d}/src/a.txt`, `${d}/dst/b.txt`, `${d}/src/a.txt`, "0", ""]);
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, ""); assert.equal(fs.readFileSync(`${d}/dst/b.txt`, "utf8"), "new"); assert.equal(fs.existsSync(`${d}/src/a.txt`), false);
  assert.equal(sh(MOVE_SCRIPT, [`${d}/src/dir`, `${d}/dst/dir2`, `${d}/src/dir`, "0", ""]).status, 0);
  assert.equal(fs.readFileSync(`${d}/dst/dir2/sub/deep.txt`, "utf8"), "deep");
  assert.equal(sh(MOVE_SCRIPT, [`${d}/src/link`, `${d}/dst/link`, `${d}/src/link`, "0", ""]).status, 0);
  assert.equal(fs.readlinkSync(`${d}/dst/link`), `${d}/src/dir`);
  assert.equal(sh(MOVE_SCRIPT, [`${d}/src/nope`, `${d}/dst/x`, `${d}/src/nope`, "0", ""]).status, 3);
});
test("move of a link into its own target folder moves the link", () => {
  const d = tree();
  assert.equal(sh(MOVE_SCRIPT, [`${d}/src/link`, `${d}/src/dir/link`, `${d}/src/link`, "0", ""]).status, 0);
  assert.equal(fs.lstatSync(`${d}/src/dir/link`).isSymbolicLink(), true);
});
test("move into own subfolder refused", () => {
  const d = tree();
  const r = sh(MOVE_SCRIPT, [`${d}/src/dir`, `${d}/src/dir/sub/dir`, `${d}/src/dir`, "0", ""]);
  assert.equal(r.status, 6); assert.match(r.stderr, /Cannot move a folder into itself/); assert.equal(fs.existsSync(`${d}/src/dir/sub/deep.txt`), true);
});
test("move replace puts old dest into trash", () => {
  const d = tree();
  const r = sh(MOVE_SCRIPT, [`${d}/src/a.txt`, `${d}/dst/a.txt`, `${d}/src/a.txt`, "1", `${d}/Trash`]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(`${d}/dst/a.txt`, "utf8"), "new");
  const trashed = fs.readdirSync(`${d}/Trash`);
  assert.equal(trashed.length, 1); assert.match(trashed[0], /^a\.txt \d{8}-\d{6}$/);
  assert.equal(r.stdout, `${d}/Trash/${trashed[0]}`); assert.equal(fs.readFileSync(r.stdout, "utf8"), "old");
  // a second replace in the same second gets "-1"
});
test("move replace deletes nothing itself on a machine: the old entry is set aside and named", () => {
  const d = tree();
  const r = sh(MOVE_SCRIPT, [`${d}/src/dir`, `${d}/dst/dir`, `${d}/src/dir`, "1", ""]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(`${d}/dst/dir/sub/deep.txt`, "utf8"), "deep");
  assert.match(r.stdout, new RegExp(`^${d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/dst/\\.dir\\.fs-move\\.\\d+$`));
  assert.equal(fs.readFileSync(`${r.stdout}/old.txt`, "utf8"), "old");
});
test("move replace restores the old dest when mv fails", () => {
  const d = tree();
  const env = { PATH: FAKE("mv-race"), FAKE_RACE_DEST: `${d}/dst/a.txt`, FAKE_RACE_KIND: "none", FAKE_RACE_FLAG: `${d}/flag` };
  const r = sh(MOVE_SCRIPT, [`${d}/src/a.txt`, `${d}/dst/a.txt`, `${d}/src/a.txt`, "1", `${d}/Trash`], env);
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim().split("\n").at(-1), `Could not move: ${d}/src/a.txt`);
  assert.equal(fs.readFileSync(`${d}/dst/a.txt`, "utf8"), "old"); assert.equal(fs.readFileSync(`${d}/src/a.txt`, "utf8"), "new");
  assert.deepEqual(fs.existsSync(`${d}/Trash`) ? fs.readdirSync(`${d}/Trash`) : [], []);
});
test("move replace names the old entry when it cannot go back", () => {
  for (const kind of ["file", "dir"]) {
    const d = tree();
    const env = { PATH: FAKE("mv-race"), FAKE_RACE_DEST: `${d}/dst/a.txt`, FAKE_RACE_KIND: kind, FAKE_RACE_FLAG: `${d}/flag` };
    const r = sh(MOVE_SCRIPT, [`${d}/src/a.txt`, `${d}/dst/a.txt`, `${d}/src/a.txt`, "1", `${d}/Trash`], env);
    assert.equal(r.status, 1, kind);
    const aside = `${d}/Trash/${fs.readdirSync(`${d}/Trash`)[0]}`;
    assert.equal(r.stderr.trim().split("\n").at(-1), `Could not move: ${d}/src/a.txt. The old entry is now in: ${aside}`, kind);
    assert.equal(fs.readFileSync(aside, "utf8"), "old", kind); // never moved into the appeared folder
    assert.equal(fs.readFileSync(`${d}/src/a.txt`, "utf8"), "new", kind);
    if (kind === "dir") assert.deepEqual(fs.readdirSync(`${d}/dst/a.txt`), [], kind);
  }
});
test("MOVE_SCRIPT refuses when the volumes differ", () => {
  const d = tmp(); fs.mkdirSync(`${d}/vol2`); fs.mkdirSync(`${d}/dst`); fs.writeFileSync(`${d}/vol2/a.txt`, "a"); fs.writeFileSync(`${d}/vol2/b.txt`, "b");
  const env = { PATH: FAKE("stat-vol2") };
  const r = sh(MOVE_SCRIPT, [`${d}/vol2/a.txt`, `${d}/dst/a.txt`, `${d}/vol2/a.txt`, "0", ""], env);
  assert.equal(r.status, 7); assert.match(r.stderr, /The target is on another volume/); assert.equal(fs.existsSync(`${d}/vol2/a.txt`), true);
  assert.equal(sh(MOVE_SCRIPT, [`${d}/vol2/b.txt`, `${d}/vol2/c.txt`, `${d}/vol2/b.txt`, "0", ""], env).status, 0);
});
test("MOVE_SCRIPT: relative paths, a trailing slash, . and .. and an entry directly below / are refused", () => {
  const d = tree();
  for (const [a, b] of [["rel", `${d}/dst/x`], [`${d}/src/a.txt`, `${d}/dst/x/`], [`${d}/src/../src/a.txt`, `${d}/dst/x`], [`${d}/src/a.txt`, "/x"]]) {
    const r = sh(MOVE_SCRIPT, [a, b, a, "0", ""]);
    assert.equal(r.status, 2, `${a} -> ${b}`); assert.match(r.stderr, /Refusing to move: /);
  }
  assert.equal(fs.existsSync(`${d}/src/a.txt`), true);
});

function ops(d, over = {}) {
  const calls = [];
  const exec = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, on: opts.on ?? null });
    over.before?.(cmd, args);
    if (over.fail?.(cmd, args)) return { code: 1, stdout: "", stderr: "exec failed" };
    if (cmd === "sh" && args[0] === "-c") { const r = sh(args[1], args.slice(3), { HOME: `${d}/Users/m`, ...(over.env ?? {}) }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; }
    return { code: 0, stdout: "", stderr: "" };
  };
  const base = createFileOps({ exec });
  const scripts = () => calls.filter((c) => c.cmd === "sh").map((c) => c.args[1]);
  return { calls, scripts, ...createMoveOps({ exec, check: base.check, trashDir: over.trashDir ?? `${d}/Trash`, ...(over.mountTables ? { mountTables: over.mountTables } : {}) }) };
}
// Fake home `${d}/Users/m`, shown folder `${root}` = `${d}/Users/m/proj` with a.txt, dir/sub/b.txt, in/ (target), in/a.txt (old), viaLink -> proj
function home() {
  const d = tmp(), root = `${d}/Users/m/proj`;
  fs.mkdirSync(`${root}/dir/sub`, { recursive: true }); fs.mkdirSync(`${root}/in`);
  fs.writeFileSync(`${root}/a.txt`, "new"); fs.writeFileSync(`${root}/dir/sub/b.txt`, "b"); fs.writeFileSync(`${root}/in/a.txt`, "old");
  fs.symlinkSync(root, `${d}/viaLink`);
  return { d, root };
}

test("inspectMove: guard first, then the check script, then the guard on an existing target", async () => {
  const { d, root } = home(); const o = ops(d);
  const r = await o.inspectMove({ on: null, src: `${d}/viaLink/dir`, destDir: `${root}/in/`, root });
  assert.deepEqual(r, { ok: true, src: `${root}/dir`, name: "dir", isDir: true, destDir: `${root}/in`, dest: `${root}/in/dir`, exists: false, destIsDir: false, replaceError: null });
  assert.deepEqual(o.scripts(), [GUARD_SCRIPT, MOVE_CHECK_SCRIPT]);
  assert.deepEqual(o.calls.at(-1).args.slice(3), [`${root}/dir`, `${root}/in`, `${d}/Trash`]);
  const e = await o.inspectMove({ on: null, src: `${root}/a.txt`, destDir: `${root}/in`, root });
  assert.deepEqual(e, { ok: true, src: `${root}/a.txt`, name: "a.txt", isDir: false, destDir: `${root}/in`, dest: `${root}/in/a.txt`, exists: true, destIsDir: false, replaceError: null });
  assert.deepEqual(o.scripts().slice(2), [GUARD_SCRIPT, MOVE_CHECK_SCRIPT, GUARD_SCRIPT]); // the third guard runs on in/a.txt
  assert.deepEqual(o.calls.at(-1).args.slice(3, 5), [`${root}/in/a.txt`, root]);
});
test("inspectMove remote: the same scripts with on, the trash argument empty", async () => {
  const { d, root } = home(); const o = ops(d);
  assert.equal((await o.inspectMove({ on: "box", src: `${root}/a.txt`, destDir: `${root}/in`, root })).ok, true);
  assert.ok(o.calls.every((c) => c.on === "box"));
  assert.equal(o.calls.find((c) => c.args[1] === MOVE_CHECK_SCRIPT).args[5], "");
});
test("move to same folder is no-op", async () => {
  const { d, root } = home(); const o = ops(d);
  assert.deepEqual(await o.inspectMove({ on: null, src: `${root}/a.txt`, destDir: root, root }), { ok: true, noop: true, src: `${root}/a.txt` });
  assert.deepEqual(await o.inspectMove({ on: null, src: `${root}/a.txt`, destDir: `${d}/viaLink`, root }), { ok: true, noop: true, src: `${root}/a.txt` });
  assert.deepEqual(await o.move({ on: null, src: `${root}/a.txt`, destDir: root, root, choice: "new" }), { ok: true, noop: true });
});
test("inspectMove refuses the guarded source and a vanished source", async () => {
  const { d, root } = home(); const o = ops(d);
  assert.deepEqual(await o.inspectMove({ on: null, src: `${d}/Users/m`, destDir: `${root}/in`, root }), { ok: false, error: "Refusing to move this folder" });
  assert.deepEqual(await o.inspectMove({ on: null, src: `${root}/gone`, destDir: `${root}/in`, root }), { ok: false, error: `No such file or folder: ${root}/gone` });
  assert.deepEqual(await o.inspectMove({ on: null, src: `${root}/a.txt`, destDir: `${root}/nope`, root }), { ok: false, error: `Target folder does not exist: ${root}/nope` });
  assert.deepEqual(o.scripts().filter((s) => s === MOVE_SCRIPT), []);
});
test("move replace refuses a guarded old dest", async () => {
  const { d, root } = home(); const o = ops(d);
  fs.mkdirSync(`${root}/m`); // a source named like the home folder
  assert.deepEqual(await o.inspectMove({ on: null, src: `${root}/m`, destDir: `${d}/Users`, root }), { ok: false, error: "Refusing to delete the home folder" });
  fs.mkdirSync(`${root}/in/proj`); // a source named like the shown folder, pasted into its parent
  assert.deepEqual(await o.inspectMove({ on: null, src: `${root}/in/proj`, destDir: `${d}/Users/m`, root }), { ok: false, error: "Refusing to delete the shown folder" });
  assert.deepEqual(o.scripts().filter((s) => s === MOVE_SCRIPT), []);
});
test("move replace refuses an old dest that contains the source", async () => {
  const { d, root } = home(); const o = ops(d);
  fs.mkdirSync(`${root}/b/b`, { recursive: true });
  const i = await o.inspectMove({ on: null, src: `${root}/b/b`, destDir: root, root });
  assert.equal(i.replaceError, "Cannot replace a folder that contains the source");
  assert.deepEqual(await o.move({ on: null, src: `${root}/b/b`, destDir: root, root, choice: "replace" }), { ok: false, error: "Cannot replace a folder that contains the source" });
  assert.equal(fs.existsSync(`${root}/b/b`), true);
  assert.deepEqual(await o.move({ on: null, src: `${root}/b/b`, destDir: root, root, choice: "keep_both" }), { ok: true, moved: true, path: `${root}/b-1`, name: "b-1", isDir: true });
});
test("move replace refuses an old dest with a mount inside", async () => {
  const { d, root } = home();
  fs.mkdirSync(`${root}/in/dir/mnt`, { recursive: true });
  fs.writeFileSync(`${d}/info.txt`, `36 35 98:0 / ${root}/in/dir/mnt rw,relatime shared:1 - ext4 /dev/sdb1 rw\n`);
  const o = ops(d, { mountTables: [`${d}/info.txt`, ""] });
  const i = await o.inspectMove({ on: "box", src: `${root}/dir`, destDir: `${root}/in`, root });
  assert.equal(i.replaceError, `Refusing to replace, a file system is mounted at: ${root}/in/dir/mnt`);
  assert.deepEqual(await o.move({ on: "box", src: `${root}/dir`, destDir: `${root}/in`, root, choice: "replace" }), { ok: false, error: `Refusing to replace, a file system is mounted at: ${root}/in/dir/mnt` });
  assert.equal(fs.existsSync(`${root}/in/dir/mnt`), true); assert.equal(fs.existsSync(`${root}/dir/sub/b.txt`), true);
  assert.equal((await o.move({ on: "box", src: `${root}/dir`, destDir: `${root}/in`, root, choice: "keep_both" })).path, `${root}/in/dir-1`);
});
test("move replace refuses when the Trash lies on another volume", async () => {
  const { d, root } = home(); fs.mkdirSync(`${d}/vol2`); // the Trash folder itself does not exist yet: its parent's device counts
  const o = ops(d, { trashDir: `${d}/vol2/Trash`, env: { PATH: FAKE("stat-vol2") } });
  const i = await o.inspectMove({ on: null, src: `${root}/a.txt`, destDir: `${root}/in`, root });
  assert.equal(i.replaceError, "Cannot replace here, the Trash lies on another volume");
  assert.deepEqual(await o.move({ on: null, src: `${root}/a.txt`, destDir: `${root}/in`, root, choice: "replace" }), { ok: false, error: "Cannot replace here, the Trash lies on another volume" });
  assert.equal((await ops(d, { trashDir: `${d}/vol2/Trash`, env: { PATH: FAKE("stat-vol2") } }).inspectMove({ on: "box", src: `${root}/a.txt`, destDir: `${root}/in`, root })).replaceError, null); // remote: no trash
});
test("cross-volume returns copy-instead", async (t) => {
  const { d, root } = home(); const o = ops(d);
  if (fs.statSync("/dev").dev === fs.statSync(d).dev) return t.skip("no second volume here");
  assert.deepEqual(await o.inspectMove({ on: null, src: `${root}/a.txt`, destDir: "/dev", root }), { ok: true, crossVolume: true, src: `${root}/a.txt`, name: "a.txt", isDir: false });
  assert.deepEqual(await o.move({ on: null, src: `${root}/a.txt`, destDir: "/dev", root, choice: "new" }), { ok: false, error: "The target is on another volume" });
});
test("move: new, replace local into the trash, the expect checks", async () => {
  const { d, root } = home(); const o = ops(d);
  assert.deepEqual(await o.move({ on: null, src: `${d}/viaLink/dir`, destDir: `${root}/in`, root, choice: "new", expect: `${root}/dir`, expectDest: `${root}/in/dir` }), { ok: true, moved: true, path: `${root}/in/dir`, name: "dir", isDir: true });
  assert.deepEqual(o.calls.at(-1).args.slice(3), [`${root}/dir`, `${root}/in/dir`, `${d}/viaLink/dir`, "0", `${d}/Trash`]);
  const r = await o.move({ on: null, src: `${root}/a.txt`, destDir: `${root}/in`, root, choice: "replace" });
  assert.equal(r.ok, true); assert.match(r.trash_path, /\/Trash\/a\.txt \d{8}-\d{6}$/); assert.equal(fs.readFileSync(`${root}/in/a.txt`, "utf8"), "new");
  fs.writeFileSync(`${root}/c.txt`, "");
  assert.deepEqual(await o.move({ on: null, src: `${root}/c.txt`, destDir: `${root}/in`, root, choice: "new", expect: `${root}/other` }), { ok: false, error: "The item changed while the dialog was open" });
  assert.deepEqual(await o.move({ on: null, src: `${root}/c.txt`, destDir: `${root}/in`, root, choice: "new", expectDest: `${root}/elsewhere/c.txt` }), { ok: false, error: "The item changed while the dialog was open" });
  assert.equal(fs.existsSync(`${root}/c.txt`), true);
});
test("replace refuses when the target folder changed during the dialog", async () => {
  const { d, root } = home(); const o = ops(d);
  fs.mkdirSync(`${root}/real`); fs.writeFileSync(`${root}/real/a.txt`, "old"); fs.symlinkSync(`${root}/in`, `${root}/target`);
  const i = await o.inspectMove({ on: null, src: `${root}/a.txt`, destDir: `${root}/target`, root }); // target -> in
  fs.unlinkSync(`${root}/target`); fs.symlinkSync(`${root}/real`, `${root}/target`); // bent during the dialog
  assert.deepEqual(await o.move({ on: null, src: `${root}/a.txt`, destDir: `${root}/target`, root, choice: "replace", expect: i.src, expectDest: i.dest }), { ok: false, error: "The item changed while the dialog was open" });
  assert.equal(fs.readFileSync(`${root}/real/a.txt`, "utf8"), "old"); assert.equal(fs.existsSync(`${root}/a.txt`), true);
});
test("move replace deletes old dest on a machine through REMOVE_SCRIPT, a failure there is a warning", async () => {
  const { d, root } = home(); const o = ops(d);
  fs.mkdirSync(`${root}/in/dir`); fs.writeFileSync(`${root}/in/dir/old.txt`, "old");
  const r = await o.move({ on: "box", src: `${root}/dir`, destDir: `${root}/in`, root, choice: "replace" });
  assert.deepEqual(r, { ok: true, moved: true, path: `${root}/in/dir`, name: "dir", isDir: true });
  assert.equal(o.calls.at(-1).args[1], REMOVE_SCRIPT); assert.equal(o.calls.at(-1).on, "box");
  assert.match(o.calls.at(-1).args[3], /\/in\/\.dir\.fs-move\.\d+$/);
  assert.deepEqual(fs.readdirSync(`${root}/in`).filter((n) => n.startsWith(".dir.fs-move")), []);
  fs.mkdirSync(`${root}/dir2`); fs.mkdirSync(`${root}/in/dir2`);
  const w = ops(d, { fail: (cmd, args) => args?.[1] === REMOVE_SCRIPT });
  const r2 = await w.move({ on: "box", src: `${root}/dir2`, destDir: `${root}/in`, root, choice: "replace" });
  assert.equal(r2.ok, true); assert.equal(r2.moved, true); assert.match(r2.warning, /^The old entry could not be removed: .*\/in\/\.dir2\.fs-move\.\d+$/);
});
test("replace never sets aside a target that appeared after the check", async () => {
  const { d, root } = home(); const o = ops(d, { before: (cmd, args) => { if (args?.[1] === MOVE_SCRIPT) fs.writeFileSync(`${root}/in/fresh.txt`, "fresh"); } });
  fs.writeFileSync(`${root}/fresh.txt`, "new");
  const r = await o.move({ on: null, src: `${root}/fresh.txt`, destDir: `${root}/in`, root, choice: "replace" });
  assert.deepEqual(r, { ok: false, error: '"fresh.txt" already exists' });
  assert.equal(fs.readFileSync(`${root}/in/fresh.txt`, "utf8"), "fresh"); assert.equal(fs.readFileSync(`${root}/fresh.txt`, "utf8"), "new");
  assert.equal(fs.existsSync(`${d}/Trash`) ? fs.readdirSync(`${d}/Trash`).length : 0, 0);
  assert.deepEqual(fs.readdirSync(`${root}/in`).filter((n) => n.includes("fs-move")), []);
});
test("MOVE_SCRIPT refuses when a folder on the target path became a link", () => {
  const d = tree(); fs.mkdirSync(`${d}/other`); fs.writeFileSync(`${d}/other/a.txt`, "other"); fs.symlinkSync(`${d}/other`, `${d}/dstlink`);
  for (const replace of ["0", "1"]) {
    const r = sh(MOVE_SCRIPT, [`${d}/src/a.txt`, `${d}/dstlink/a.txt`, `${d}/src/a.txt`, replace, `${d}/Trash`]);
    assert.equal(r.status, 5, replace); assert.match(r.stderr, /The path changed while it was checked: .*dstlink/);
    assert.equal(fs.readFileSync(`${d}/other/a.txt`, "utf8"), "other"); assert.equal(fs.readFileSync(`${d}/src/a.txt`, "utf8"), "new");
    assert.equal(fs.existsSync(`${d}/Trash`), false);
  }
});
test("replace leaves an entry alone when the target folder is bent to a link before the script runs", async () => {
  const { d, root } = home(); fs.mkdirSync(`${d}/other`); fs.writeFileSync(`${d}/other/a.txt`, "other");
  const o = ops(d, { before: (cmd, args) => { if (args?.[1] === MOVE_SCRIPT) { fs.renameSync(`${root}/in`, `${root}/in.orig`); fs.symlinkSync(`${d}/other`, `${root}/in`); } } });
  const r = await o.move({ on: "box", src: `${root}/a.txt`, destDir: `${root}/in`, root, choice: "replace" });
  assert.equal(r.ok, false); assert.match(r.error, /^The path changed while it was checked: .*\/in$/);
  assert.equal(fs.readFileSync(`${d}/other/a.txt`, "utf8"), "other"); assert.equal(fs.readFileSync(`${root}/a.txt`, "utf8"), "new");
  assert.equal(fs.readFileSync(`${root}/in.orig/a.txt`, "utf8"), "old"); assert.deepEqual(fs.readdirSync(`${d}/other`), ["a.txt"]);
});
test("MOVE_SCRIPT refuses replace over a mount", () => {
  const d = tree();
  fs.writeFileSync(`${d}/info.txt`, `36 35 98:0 / ${d}/dst/dir/mnt rw,relatime shared:1 - ext4 /dev/sdb1 rw\n`);
  fs.writeFileSync(`${d}/empty.txt`, "");
  const r = sh(MOVE_SCRIPT, [`${d}/src/dir`, `${d}/dst/dir`, `${d}/src/dir`, "1", "", `${d}/info.txt`, ""]);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /^Refusing to replace, a file system is mounted at: /m);
  assert.equal(fs.existsSync(`${d}/src/dir/sub/deep.txt`), true); assert.equal(fs.readFileSync(`${d}/dst/dir/old.txt`, "utf8"), "old");
  assert.deepEqual(fs.readdirSync(`${d}/dst`).filter((n) => n.includes("fs-move")), []);
  const ok = sh(MOVE_SCRIPT, [`${d}/src/dir`, `${d}/dst/dir`, `${d}/src/dir`, "1", "", `${d}/empty.txt`, ""]); // no mount: replaces as before
  assert.equal(ok.status, 0, ok.stderr);
});
test("remote cleanup goes through the delete guard and refuses an implausible path", async () => {
  const { d, root } = home();
  fs.mkdirSync(`${root}/dir2`); fs.mkdirSync(`${root}/in/dir2`); fs.writeFileSync(`${root}/in/dir2/old.txt`, "old");
  // guard rejects the set-aside entry (it is turned into the shown folder): nothing is removed, a warning
  const g = createMoveOps({ exec: async (cmd, args, opts = {}) => { const r = sh(args[1], args.slice(3), { HOME: `${d}/Users/m` }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; },
    check: async (a) => (a.verb === "delete" && /\.fs-move\./.test(a.path) ? { ok: false, error: "Refusing to delete: guarded" } : createFileOps({ exec: async (c, ar) => { const r = sh(ar[1], ar.slice(3), { HOME: `${d}/Users/m` }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; } }).check(a)), trashDir: `${d}/Trash` });
  const r = await g.move({ on: "box", src: `${root}/dir2`, destDir: `${root}/in`, root, choice: "replace" });
  assert.equal(r.ok, true); assert.equal(r.moved, true); assert.match(r.warning, /^The old entry could not be removed: .*\/in\/\.dir2\.fs-move\.\d+$/);
  assert.equal(fs.readdirSync(`${root}/in`).filter((n) => n.startsWith(".dir2.fs-move")).length, 1); // kept, named in the warning
  // the real chain calls the guard before REMOVE_SCRIPT
  fs.mkdirSync(`${root}/dir3`); fs.mkdirSync(`${root}/in/dir3`);
  const o2 = ops(d); const r3 = await o2.move({ on: "box", src: `${root}/dir3`, destDir: `${root}/in`, root, choice: "replace" });
  assert.equal(r3.warning, undefined);
  const sc = o2.scripts(); assert.equal(sc.at(-1), REMOVE_SCRIPT); assert.equal(sc.at(-2), GUARD_SCRIPT);
});
test("remote cleanup refuses an aside path outside the target folder", async () => {
  const { d, root } = home();
  const exec = async (cmd, args) => {
    if (args[1] === MOVE_SCRIPT) { const r = sh(args[1], args.slice(3), { HOME: `${d}/Users/m` }); return { code: r.status, stdout: `${root}/x.fs-move.1`, stderr: r.stderr }; }
    const r = sh(args[1], args.slice(3), { HOME: `${d}/Users/m` }); return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  fs.mkdirSync(`${root}/x.fs-move.1`);
  const o = createMoveOps({ exec, check: createFileOps({ exec }).check, trashDir: `${d}/Trash` });
  fs.mkdirSync(`${root}/in/dir`); fs.writeFileSync(`${root}/in/dir/old.txt`, "o");
  const r = await o.move({ on: "box", src: `${root}/dir`, destDir: `${root}/in`, root, choice: "replace" });
  assert.equal(r.ok, true); assert.match(r.warning, /could not be removed/);
  assert.equal(fs.existsSync(`${root}/x.fs-move.1`), true);
});
test("move keep both takes a free name, counts its own name as taken, skips reserved names", async (t) => {
  const { d, root } = home(); const o = ops(d);
  assert.equal((await o.move({ on: null, src: `${root}/a.txt`, destDir: `${root}/in`, root, choice: "keep_both" })).path, `${root}/in/a-1.txt`);
  assert.equal(fs.readFileSync(`${root}/in/a.txt`, "utf8"), "old");
  fs.writeFileSync(`${root}/x.txt`, ""); fs.writeFileSync(`${root}/in/x.txt`, "");
  assert.equal((await o.move({ on: null, src: `${root}/x.txt`, destDir: `${root}/in`, root, choice: "keep_both", reserved: ["x-1.txt"] })).path, `${root}/in/x-2.txt`);
  if (!caseInsensitive(d)) return t.skip("case-sensitive volume");
  fs.writeFileSync(`${root}/B.TXT`, ""); fs.writeFileSync(`${root}/in/b.txt`, "");
  assert.equal((await o.move({ on: null, src: `${root}/B.TXT`, destDir: `${root}/in`, root, choice: "keep_both" })).path, `${root}/in/B-1.TXT`);
});
test("move refuses a target that appears after the check and maps the other exit codes", async () => {
  const { d, root } = home(); const o = ops(d);
  fs.writeFileSync(`${root}/n.txt`, ""); fs.writeFileSync(`${root}/in/n.txt`, "");
  assert.deepEqual(await o.move({ on: null, src: `${root}/n.txt`, destDir: `${root}/in`, root, choice: "new" }), { ok: false, error: '"n.txt" already exists' });
  assert.deepEqual(await o.move({ on: null, src: `${root}/dir`, destDir: `${root}/dir/sub`, root, choice: "new" }), { ok: false, error: "Cannot move a folder into itself" });
  const v = ops(d, { env: { PATH: FAKE("stat-vol2") } }); fs.mkdirSync(`${root}/vol2`); fs.writeFileSync(`${root}/vol2/f`, "");
  assert.deepEqual(await v.move({ on: null, src: `${root}/vol2/f`, destDir: `${root}/in`, root, choice: "new" }), { ok: false, error: "The target is on another volume" });
});
test("moveToasts", () => {
  assert.deepEqual(moveToasts({ ok: true, moved: true, path: "/srv/in/a.txt" }), [{ title: "Moved", body: "a.txt", level: "success" }]);
  assert.deepEqual(moveToasts({ ok: true, moved: true, path: "/srv/in/d", warning: "The old entry could not be removed: /srv/in/.d.fs-move.5" })[1], { title: "Could not remove the old entry", body: "The old entry could not be removed: /srv/in/.d.fs-move.5", level: "error" });
  assert.deepEqual(moveToasts({ ok: true, moved: true, path: "/Users/me/in/a", trash_path: "/Users/me/.Trash/a 20261104-120000" }), [{ title: "Moved", body: "a", level: "success" }]);
  assert.deepEqual(moveToasts({ ok: true, noop: true }), []);
  assert.deepEqual(moveToasts({ ok: true, jobs: [] }), []);
  assert.deepEqual(moveToasts({ ok: false, error: "x" }), []);
});

// ---- Keep both without letter case (#33): also on a machine, where no probe asks the file system.
test("move keep both: A.TXT next to a.txt and a-1.txt becomes A-2.TXT, local and on a machine", async () => {
  for (const on of [null, "box"]) {
    const { d, root } = home(); const o = ops(d);
    fs.mkdirSync(`${root}/up`); fs.writeFileSync(`${root}/up/A.TXT`, "new");
    fs.writeFileSync(`${root}/in/a-1.txt`, "old1");
    const r = await o.move({ on, src: `${root}/up/A.TXT`, destDir: `${root}/in`, root, choice: "keep_both" });
    assert.equal(r.path, `${root}/in/A-2.TXT`, String(on));
    const r2 = await o.move({ on, src: `${root}/dir`, destDir: `${root}/in`, root, choice: "keep_both", reserved: ["DIR-1"] });
    assert.equal(r2.path, `${root}/in/dir-2`, String(on)); // a reserved name counts in any letter case
  }
});

// ---- Empty stderr (#34)
function emptyOps({ moveCode = 1, listCode = 0, checkCode = 0, mounted = "n" } = {}) {
  const info = ["/x/in", "y", "d", "n", "n", "n", mounted, "1", "1", ""].join("\0");
  const exec = async (cmd, args) => {
    if (args[1] === MOVE_CHECK_SCRIPT) return { code: checkCode, stdout: checkCode ? "" : info, stderr: "" };
    if (args[1] === MOVE_SCRIPT) return { code: moveCode, stdout: "", stderr: "" };
    return { code: listCode, stdout: "", stderr: "" };
  };
  const check = async ({ path: p }) => ({ ok: true, path: p, name: path.basename(p), isDir: true });
  return createMoveOps({ exec, check, trashDir: "/T" });
}
test("move with empty stderr: Could not move, Could not list the folder, Could not check the path", async () => {
  assert.deepEqual(await emptyOps().move({ on: "box", src: "/x/a", destDir: "/x/in", root: "/x", choice: "replace" }), { ok: false, error: "Could not move" });
  assert.deepEqual(await emptyOps({ listCode: 1 }).move({ on: "box", src: "/x/a", destDir: "/x/in", root: "/x", choice: "keep_both" }), { ok: false, error: "Could not list the folder" });
  assert.deepEqual(await emptyOps({ checkCode: 1 }).inspectMove({ on: "box", src: "/x/a", destDir: "/x/in", root: "/x" }), { ok: false, error: "Could not check the path" });
});
test("a mount reported without a message still refuses Replace (#31, #34)", async () => {
  const v = moveVerdict({ info: P(["/x/in", "y", "d", "n", "n", "n", "y", "1", "1", ""].join("\0")), src: "/x/a", destDir: "/x/in", stderr: "" });
  assert.ok(v.replaceError);
  const out = await emptyOps({ mounted: "y", moveCode: 0 }).move({ on: "box", src: "/x/a", destDir: "/x/in", root: "/x", choice: "replace" });
  assert.equal(out.ok, false);
  assert.ok(out.error.length > 0);
});
