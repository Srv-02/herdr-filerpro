// Permissions through createFileOps (permissions, permissionsCount, chmod): the real shell scripts run against throw-away
// folders below tmp/. Paths and modes travel as argv only; links are never changed; recursive stays out of protected paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { mkTmpSync } from "./tmp-helper.js";
import { createFileOps } from "../mods/filer-pro/lib/fileops.js";
import { PROBE_SCRIPT, CHMOD_SCRIPT, COUNT_SCRIPT, COUNT_LIMIT } from "../mods/filer-pro/lib/perms.js";

const tree = () => {
  const d = fs.realpathSync(mkTmpSync("perms-"));
  fs.mkdirSync(`${d}/Users/m/proj/sub/deep`, { recursive: true });
  fs.mkdirSync(`${d}/outside`);
  fs.writeFileSync(`${d}/Users/m/proj/a.txt`, "a");
  fs.writeFileSync(`${d}/Users/m/proj/sub/b.txt`, "b");
  fs.writeFileSync(`${d}/Users/m/proj/sub/deep/c.txt`, "c");
  fs.writeFileSync(`${d}/outside/o.txt`, "o");
  return { d, root: `${d}/Users/m/proj`, home: `${d}/Users/m` };
};
const mode = (p) => fs.statSync(p).mode & 0o7777;

// Runs every script for real; records command and arguments.
function ops(home, over = {}) {
  const calls = [];
  const exec = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, on: opts.on ?? null });
    if (over.answer) { const a = over.answer(cmd, args); if (a) return a; }
    const r = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, HOME: home } });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return { calls, scripts: () => calls.map((c) => c.args?.[1]), ops: createFileOps({ exec }) };
}

test("permissions: mode, owner and group of a file and a folder", async () => {
  const { d, home } = tree();
  fs.chmodSync(`${d}/Users/m/proj/a.txt`, 0o640);
  const { ops: o, calls } = ops(home);
  const f = await o.permissions({ on: null, path: `${d}/Users/m/proj/a.txt` });
  assert.equal(f.ok, true);
  assert.equal(f.mode, 0o640);
  assert.equal(f.isDir, false);
  assert.equal(f.owned, true);
  assert.equal(f.uid, String(process.getuid()));
  assert.match(f.user, /\S/);
  const dir = await o.permissions({ on: null, path: `${d}/Users/m/proj/sub/` });
  assert.equal(dir.isDir, true);
  assert.deepEqual(calls[0].args, ["-c", PROBE_SCRIPT, "x", `${d}/Users/m/proj/a.txt`]);
  assert.equal(calls[0].cmd, "sh");
});

test("permissions: a link shows the permissions of its target and is marked as a link", async () => {
  const { d, home } = tree();
  fs.chmodSync(`${d}/outside/o.txt`, 0o600);
  fs.symlinkSync(`${d}/outside/o.txt`, `${d}/Users/m/proj/ln`);
  const r = await ops(home).ops.permissions({ on: null, path: `${d}/Users/m/proj/ln` });
  assert.equal(r.isLink, true);
  assert.equal(r.mode, 0o600);
});

test("permissions: setuid, setgid and sticky show up in the mode", async () => {
  const { d, home } = tree();
  fs.chmodSync(`${d}/Users/m/proj/sub`, 0o1755);
  const r = await ops(home).ops.permissions({ on: null, path: `${d}/Users/m/proj/sub` });
  assert.equal(r.mode, 0o1755);
});

test("permissions: a missing entry, a dangling link and a relative path give messages", async () => {
  const { d, home } = tree();
  fs.symlinkSync(`${d}/gone`, `${d}/Users/m/proj/dead`);
  const o = ops(home).ops;
  assert.equal((await o.permissions({ on: null, path: `${d}/nope` })).ok, false);
  assert.match((await o.permissions({ on: null, path: `${d}/nope` })).error, /No such file or folder/);
  // GNU stat -L fails on a dangling link; BSD stat -L falls back to the link itself. Either way nothing is changeable.
  const dead = await o.permissions({ on: null, path: `${d}/Users/m/proj/dead` });
  assert.ok(dead.ok === false || dead.isLink === true);
  assert.deepEqual(await o.permissions({ on: null, path: "rel" }), { ok: false, error: "path must be absolute" });
});

test("chmod: changes the mode, passes values as argv and reports the mode it re-read", async () => {
  const { d, root, home } = tree();
  fs.chmodSync(`${root}/a.txt`, 0o644);
  const { ops: o, calls } = ops(home);
  const r = await o.chmod({ on: null, path: `${root}/a.txt`, root, mode: 0o600, recursive: false });
  assert.deepEqual(r, { ok: true, mode: 0o600, requested: 0o600, mismatch: false });
  assert.equal(mode(`${root}/a.txt`), 0o600);
  assert.deepEqual(calls.at(-1).args, ["-c", CHMOD_SCRIPT, "x", "00600", `${root}/a.txt`, "0"]);
  assert.ok(!CHMOD_SCRIPT.includes(root) && !CHMOD_SCRIPT.includes("00600"), "no value in the script text");
  assert.equal(calls.length, 1, "a single file needs no guard run");
});

test("chmod: a name with spaces, quotes and a leading dash is safe", async () => {
  const { root, home } = tree();
  const name = `-x 'q' "d" $(touch pwned); \`id\``;
  fs.writeFileSync(`${root}/${name}`, "");
  fs.chmodSync(`${root}/${name}`, 0o644);
  const r = await ops(home).ops.chmod({ on: null, path: `${root}/${name}`, root, mode: 0o640, recursive: false });
  assert.equal(r.ok, true, r.error);
  assert.equal(mode(`${root}/${name}`), 0o640);
  assert.equal(fs.existsSync(`${root}/pwned`), false);
});

test("chmod: a folder loses setgid with the five digit mode, not just the other bits", async (t) => {
  const { root, home } = tree();
  fs.chmodSync(`${root}/sub`, 0o2755);
  if ((mode(`${root}/sub`) & 0o2000) === 0) return t.skip("setgid not settable here");
  const r = await ops(home).ops.chmod({ on: null, path: `${root}/sub`, root, mode: 0o755, recursive: false });
  assert.equal(r.ok, true, r.error);
  assert.equal(mode(`${root}/sub`), 0o755);
  assert.equal(r.mismatch, false);
});

test("chmod: a symbolic link is refused and neither the link nor its target changes", async () => {
  const { d, root, home } = tree();
  fs.chmodSync(`${d}/outside/o.txt`, 0o644);
  fs.symlinkSync(`${d}/outside/o.txt`, `${root}/ln`);
  fs.symlinkSync(`${d}/outside`, `${root}/dirln`);
  const o = ops(home).ops;
  for (const p of [`${root}/ln`, `${root}/dirln`, `${root}/dirln/`]) {
    const r = await o.chmod({ on: null, path: p, root, mode: 0o600, recursive: false });
    assert.equal(r.ok, false, p);
    assert.match(r.error, /symbolic link/i);
  }
  const rec = await o.chmod({ on: null, path: `${root}/dirln`, root, mode: 0o600, recursive: true });
  assert.equal(rec.ok, false);
  assert.equal(mode(`${d}/outside/o.txt`), 0o644);
  assert.notEqual(mode(`${d}/outside/o.txt`), 0o600);
});

test("CHMOD_SCRIPT: refuses a link even when called directly (no guard in between)", () => {
  const { d, root } = tree();
  fs.symlinkSync(`${d}/outside/o.txt`, `${root}/ln`);
  const r = spawnSync("sh", ["-c", CHMOD_SCRIPT, "x", "00600", `${root}/ln`, "0"], { encoding: "utf8" });
  assert.equal(r.status, 6);
  assert.notEqual(mode(`${d}/outside/o.txt`), 0o600);
});

test("CHMOD_SCRIPT: bad arguments run nothing", () => {
  const { root } = tree();
  const run = (...a) => spawnSync("sh", ["-c", CHMOD_SCRIPT, "x", ...a], { encoding: "utf8" });
  assert.equal(run("644", `${root}/a.txt`, "0").status, 2);
  assert.equal(run("u+x", `${root}/a.txt`, "0").status, 2);
  assert.equal(run("000644", `${root}/a.txt`, "0").status, 2);
  assert.equal(run("00644", "a.txt", "0").status, 2);
  assert.equal(run("00644", `${root}/gone`, "0").status, 3);
  assert.equal(run("00644", `${root}/a.txt`, "1").status, 7);
});

test("chmod recursive: changes the folder and everything inside, never through a link", async () => {
  const { d, root, home } = tree();
  fs.symlinkSync(`${d}/outside`, `${root}/sub/out`);
  fs.symlinkSync(`${d}/outside/o.txt`, `${root}/sub/outfile`);
  fs.chmodSync(`${d}/outside/o.txt`, 0o644);
  const before = mode(`${d}/outside`);
  const { ops: o, scripts } = ops(home);
  const r = await o.chmod({ on: null, path: `${root}/sub`, root, mode: 0o750, recursive: true });
  assert.equal(r.ok, true, r.error);
  for (const p of ["sub", "sub/deep", "sub/b.txt", "sub/deep/c.txt"]) assert.equal(mode(`${root}/${p}`), 0o750, p);
  assert.equal(mode(`${d}/outside`), before, "folder behind a link untouched");
  assert.equal(mode(`${d}/outside/o.txt`), 0o644, "file behind a link untouched");
  assert.equal(mode(`${root}/a.txt`) === 0o750, false, "a sibling is untouched");
  assert.equal(scripts().length, 2, "guard, then chmod");
  assert.equal(scripts()[1], CHMOD_SCRIPT);
});

test("chmod recursive: a folder that loses its execute bit is still changed completely (contents first)", async () => {
  const { root, home } = tree();
  const r = await ops(home).ops.chmod({ on: null, path: `${root}/sub`, root, mode: 0o644, recursive: true });
  assert.equal(r.ok, true, r.error);
  fs.chmodSync(`${root}/sub`, 0o755);
  fs.chmodSync(`${root}/sub/deep`, 0o755);
  assert.equal(mode(`${root}/sub/deep/c.txt`), 0o644);
  assert.equal(mode(`${root}/sub/b.txt`), 0o644);
});

test("chmod recursive: protected paths are refused by the guard and no chmod command is built", async () => {
  const { d, root, home } = tree();
  const { ops: o, scripts } = ops(home);
  const verdicts = [];
  for (const p of ["/", d, `${d}/Users`, home, root, `${root}/`, "/usr", "/etc", `${root}/../proj/sub`, `${root}/gone`]) {
    const r = await o.chmod({ on: null, path: p, root, mode: 0o700, recursive: true });
    assert.equal(r.ok, false, p);
    verdicts.push(r.error);
  }
  assert.equal(verdicts[0], "Refusing to change permissions of this folder");
  assert.equal(verdicts[4], "Refusing to change permissions of this folder");
  assert.ok(!scripts().includes(CHMOD_SCRIPT), "chmod never ran");
});

test("chmod recursive: without root nothing runs", async () => {
  const { root, home } = tree();
  const { ops: o, calls } = ops(home);
  assert.deepEqual(await o.chmod({ on: null, path: `${root}/sub`, mode: 0o700, recursive: true }), { ok: false, error: "root is required" });
  assert.equal(calls.length, 0);
});

test("chmod: an invalid mode or path is refused before any command runs", async () => {
  const { root, home } = tree();
  const { ops: o, calls } = ops(home);
  for (const m of [0o10000, -1, 1.5, "644", NaN, undefined]) assert.equal((await o.chmod({ on: null, path: `${root}/a.txt`, root, mode: m, recursive: false })).ok, false, String(m));
  assert.equal((await o.chmod({ on: null, path: "rel", root, mode: 0o644, recursive: false })).error, "path must be absolute");
  assert.equal((await o.chmod({ on: null, path: `${root}/a\n.txt`, root, mode: 0o644, recursive: false })).ok, false);
  assert.equal(calls.length, 0);
});

test("chmod: the mode the system really set is compared with the request and a difference is reported", async () => {
  const { root, home } = tree();
  const { ops: o } = ops(home, { answer: (cmd, args) => (args[1] === CHMOD_SCRIPT ? { code: 0, stdout: "0755\n", stderr: "" } : undefined) });
  const r = await o.chmod({ on: null, path: `${root}/a.txt`, root, mode: 0o2755, recursive: false });
  assert.deepEqual(r, { ok: true, mode: 0o755, requested: 0o2755, mismatch: true });
});

test("chmod: an answer without the re-read mode is a failure to verify, not a success", async () => {
  const { root, home } = tree();
  const { ops: o } = ops(home, { answer: (cmd, args) => (args[1] === CHMOD_SCRIPT ? { code: 0, stdout: "", stderr: "" } : undefined) });
  const r = await o.chmod({ on: null, path: `${root}/a.txt`, root, mode: 0o600, recursive: false });
  assert.equal(r.ok, true);
  assert.equal(r.mode, null);
  assert.equal(r.mismatch, true);
});

test("chmod: the system's refusal is shown", async () => {
  const { root, home } = tree();
  const { ops: o } = ops(home, { answer: (cmd, args) => (args[1] === CHMOD_SCRIPT ? { code: 1, stdout: "", stderr: "chmod: changing permissions of 'x': Operation not permitted\n" } : undefined) });
  const r = await o.chmod({ on: null, path: `${root}/a.txt`, root, mode: 0o600, recursive: false });
  assert.deepEqual(r, { ok: false, error: "Not the owner, permissions cannot be changed (or the item is locked or protected)" });
  const denied = ops(home, { answer: (cmd, args) => (args[1] === CHMOD_SCRIPT ? { code: 1, stdout: "", stderr: "chmod: cannot access 'x': Permission denied\n" } : undefined) });
  assert.equal((await denied.ops.chmod({ on: null, path: `${root}/a.txt`, root, mode: 0o600, recursive: false })).error, "chmod: cannot access 'x': Permission denied");
});

test("chmod, permissions and count on a machine: same scripts, on is passed to exec", async () => {
  const { calls, ops: o } = ops("/nonexistent", { answer: () => ({ code: 0, stdout: "0644\n", stderr: "" }) });
  await o.permissions({ on: "box", path: "/srv/a" });
  await o.chmod({ on: "box", path: "/srv/a", root: "/srv", mode: 0o600, recursive: false });
  await o.permissionsCount({ on: "box", path: "/srv/d" });
  assert.deepEqual(calls.map((c) => [c.cmd, c.args[1], c.on]), [["sh", PROBE_SCRIPT, "box"], ["sh", CHMOD_SCRIPT, "box"], ["sh", COUNT_SCRIPT, "box"]]);
});

test("permissionsCount: files and folders inside, links skipped, a huge tree capped", async () => {
  const { d, root, home } = tree();
  fs.symlinkSync(`${d}/outside`, `${root}/sub/out`);
  const o = ops(home).ops;
  assert.equal(await o.permissionsCount({ on: null, path: `${root}/sub` }), 4, "sub, deep, b.txt, c.txt");
  fs.mkdirSync(`${d}/big`);
  for (let i = 0; i < 40; i++) fs.writeFileSync(`${d}/big/f${i}`, "");
  assert.equal(await o.permissionsCount({ on: null, path: `${d}/big` }), 41);
  assert.equal(COUNT_LIMIT, 10000);
  const failing = ops(home, { answer: () => ({ code: 1, stdout: "", stderr: "boom" }) }).ops;
  assert.equal(await failing.permissionsCount({ on: null, path: `${d}/big` }), null);
  const throwing = createFileOps({ exec: async () => { throw new Error("x"); } });
  assert.equal(await throwing.permissionsCount({ on: "box", path: "/srv" }), null);
});

test("PROBE_SCRIPT on BSD stat (a stand-in that only knows stat -f): the mode is the last four digits of %p", () => {
  const { d, root } = tree();
  const bin = `${d}/bin`;
  fs.mkdirSync(bin);
  fs.writeFileSync(`${bin}/stat`, `#!/bin/sh
[ "$1" = -c ] && exit 1
[ "$1" = -L ] && [ "$2" = -f ] || exit 1
case $3 in %p) echo "$BSD_MODE" ;; %u) echo 501 ;; %g) echo 20 ;; %Su) echo alice ;; %Sg) echo staff ;; *) exit 1 ;; esac
`, { mode: 0o755 });
  const run = (m) => spawnSync("sh", ["-c", PROBE_SCRIPT, "x", `${root}/a.txt`], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BSD_MODE: m } });
  for (const [raw, want] of [["100644", 0o644], ["104755", 0o4755], ["40755", 0o755], ["41777", 0o1777]]) {
    const r = run(raw);
    assert.equal(r.status, 0, r.stderr);
    const f = r.stdout.split("\0");
    assert.equal(parseInt(f[1], 8), want, raw);
    assert.deepEqual([f[2], f[3], f[4], f[5]], ["501", "20", "alice", "staff"]);
  }
});

test("CHMOD_SCRIPT recursive: BSD chmod gets -h (a swapped-in link is changed itself, not its target), GNU does not", () => {
  const { d, root } = tree();
  const bin = `${d}/bin2`;
  fs.mkdirSync(bin);
  fs.writeFileSync(`${bin}/chmod`, `#!/bin/sh\necho "$@" >> "${d}/chmod.log"\n`, { mode: 0o755 });
  fs.writeFileSync(`${bin}/stat`, `#!/bin/sh\nif [ "$BSD" = 1 ]; then [ "$1" = -c ] && exit 1; case $3 in %p) echo 40755 ;; *) echo 1 ;; esac; else [ "$1" = -c ] && { echo 755; exit 0; }; [ "$2" = -c ] && { echo 755; exit 0; }; exit 1; fi\n`, { mode: 0o755 });
  const run = (bsd) => spawnSync("sh", ["-c", CHMOD_SCRIPT, "x", "00750", `${root}/sub`, "1"], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BSD: bsd } });
  run("1");
  const bsdLog = fs.readFileSync(`${d}/chmod.log`, "utf8");
  fs.rmSync(`${d}/chmod.log`);
  run("0");
  assert.match(bsdLog, /^-h -- 00750 /m);
  assert.doesNotMatch(fs.readFileSync(`${d}/chmod.log`, "utf8"), /-h/);
});
