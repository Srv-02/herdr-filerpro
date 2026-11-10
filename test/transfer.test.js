import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { MOUNT_FN } from "../mods/filer-pro/lib/fileops.js";
import { mkTmp, mkTmpSync } from "./tmp-helper.js";

const root = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(root, "mods/filer-pro/bin/transfer.sh");
const scratch = [];
after(() => {
  for (const d of scratch) fs.rmSync(d, { recursive: true, force: true });
});

const ENV = {
  ...process.env,
  FILER_PRO_SCP: path.join(root, "test/fake/scp"),
  FILER_PRO_SSH: path.join(root, "test/fake/ssh"),
};
delete ENV.FAKE_SLEEP;
delete ENV.FAKE_FAIL;

function setup() {
  const d = mkTmpSync("filer-pro-");
  scratch.push(d);
  for (const s of ["src", "dst", "trash"]) fs.mkdirSync(path.join(d, s));
  return d;
}

// Every test gets its own job id: the cancel path runs a machine-wide pkill on "fs-<id>", so a shared id would let a
// parallel run kill this run's fake cp.
const uid = () => `t${Math.random().toString(36).slice(2, 10)}${process.pid.toString(36)}`;

function args(d, dir, mode, name, id = uid()) {
  const src = path.join(d, "src", name);
  const dest = path.join(d, "dst", name);
  const temp = path.join(d, "dst", `.${name}.fs-${id}.part`);
  const status = path.join(d, "status");
  const list = [dir, mode, "box", src, dest, temp, status, path.join(d, "trash")];
  if (dir === "cross") list.push("box2"); // the SSH target of the source machine, cross only
  return { src, dest, temp, status, list };
}

function run(a, env = {}) {
  return spawnSync(process.env.TEST_SH || "sh", [SCRIPT, ...a.list], { env: { ...ENV, ...env }, encoding: "utf8" });
}

const status = (a) => fs.readFileSync(a.status, "utf8");
// Polls until fn() is truthy; the upper bound only matters when something is really broken.
async function waitFor(fn, timeoutMs = 10000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
}

const running = (marker) => spawnSync("pgrep", ["-f", `sleep ${marker}`], { encoding: "utf8" }).stdout.trim() !== "";
const matching = (pat) => spawnSync("pgrep", ["-f", pat], { encoding: "utf8" }).stdout.trim() !== "";
// Created right after spawn, so the event cannot be missed; the limit keeps a stuck process from hanging the suite.
function closing(p, ms = 30000) {
  const pr = new Promise((res, rej) => {
    const t = setTimeout(() => { p.kill("SIGKILL"); rej(new Error("process did not end")); }, ms);
    p.on("close", (c) => { clearTimeout(t); res(c); });
  });
  pr.catch(() => {}); // a rejection before the test awaits it must not crash the run
  return pr;
}

const names = (dir) => fs.readdirSync(dir).sort();

function mkTree(base) {
  fs.mkdirSync(path.join(base, "sub"), { recursive: true });
  fs.writeFileSync(path.join(base, "-x ü.md"), "umlaut");
  fs.writeFileSync(path.join(base, "sub", "deep.txt"), "deep");
}

for (const dir of ["down", "up", "remote", "cross"]) {
  const nasty = "a b'c [1]*?.txt";

  test(`${dir} new: file with nasty name arrives exact`, () => {
    const d = setup();
    const a = args(d, dir, "new", nasty);
    fs.writeFileSync(a.src, "hello");
    const r = run(a);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(a.dest, "utf8"), "hello");
    assert.deepEqual(names(path.join(d, "dst")), [nasty]);
    assert.match(status(a), /^state=done\ncode=0\n/);
    assert.equal(fs.existsSync(a.status + ".err"), false);
  });

  test(`${dir} new: folder with sub folder and "-x ü.md"`, () => {
    const d = setup();
    const a = args(d, dir, "new", "folder");
    mkTree(a.src);
    const r = run(a);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(a.dest, "-x ü.md"), "utf8"), "umlaut");
    assert.equal(fs.readFileSync(path.join(a.dest, "sub", "deep.txt"), "utf8"), "deep");
    assert.deepEqual(names(path.join(d, "dst")), ["folder"]);
  });

  test(`${dir} new: existing dest fails, dest unchanged, temp gone`, () => {
    const d = setup();
    const a = args(d, dir, "new", "folder");
    mkTree(a.src);
    fs.mkdirSync(a.dest);
    fs.writeFileSync(path.join(a.dest, "keep.txt"), "old");
    const r = run(a);
    assert.notEqual(r.status, 0);
    assert.match(status(a), /^state=failed\ncode=[1-9]/);
    assert.deepEqual(names(a.dest), ["keep.txt"]);
    assert.deepEqual(names(path.join(d, "dst")), ["folder"]);
  });

  test(`${dir} replace: folder is replaced, old one set aside`, () => {
    const d = setup();
    const a = args(d, dir, "replace", "folder");
    mkTree(a.src);
    fs.mkdirSync(a.dest);
    fs.writeFileSync(path.join(a.dest, "old.txt"), "old");
    const r = run(a);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(names(a.dest), ["-x ü.md", "sub"]);
    assert.deepEqual(names(path.join(d, "dst")), ["folder"]);
    if (dir === "down") {
      const t = names(path.join(d, "trash"));
      assert.equal(t.length, 1);
      assert.match(t[0], /^folder \d{8}-\d{6}/);
      assert.equal(fs.readFileSync(path.join(d, "trash", t[0], "old.txt"), "utf8"), "old");
    } else {
      assert.deepEqual(names(path.join(d, "trash")), []);
    }
  });

  test(`${dir} replace: file with nasty name`, () => {
    const d = setup();
    const a = args(d, dir, "replace", nasty);
    fs.writeFileSync(a.src, "new");
    fs.writeFileSync(a.dest, "old");
    const r = run(a);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(a.dest, "utf8"), "new");
    assert.deepEqual(names(path.join(d, "dst")), [nasty]);
  });

  // $(...) drops trailing newlines: "foo<newline>" must never become its neighbour "foo".
  test(`${dir} replace: a name with a trailing newline stays itself, the neighbour without it is untouched`, () => {
    const d = setup();
    const a = args(d, dir, "replace", "foo\n");
    fs.writeFileSync(a.src, "new");
    fs.writeFileSync(a.dest, "old");
    fs.writeFileSync(path.join(d, "dst", "foo"), "neighbour");
    const r = run(a);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(d, "dst", "foo"), "utf8"), "neighbour");
    assert.equal(fs.readFileSync(a.dest, "utf8"), "new");
    assert.deepEqual(names(path.join(d, "dst")), ["foo", "foo\n"]);
  });

  test(`${dir} replace: trash name collision gets a suffix`, { skip: dir !== "down" }, () => {
    const d = setup();
    const a = args(d, dir, "replace", "f.txt");
    fs.writeFileSync(a.src, "new");
    fs.writeFileSync(a.dest, "old");
    const pad = (n) => String(n).padStart(2, "0");
    const fmt = (t) => `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;
    // Occupy every plausible name around now, so the script must add a suffix.
    for (let s = -2; s <= 3; s++) fs.writeFileSync(path.join(d, "trash", `f.txt ${fmt(new Date(Date.now() + s * 1000))}`), "taken");
    const r = run(a);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(a.dest, "utf8"), "new");
    assert.equal(names(path.join(d, "trash")).length, 7);
  });

  test(`${dir} merge: old single files stay, same names overwritten`, () => {
    const d = setup();
    const a = args(d, dir, "merge", "folder");
    mkTree(a.src);
    fs.mkdirSync(path.join(a.dest, "sub"), { recursive: true });
    fs.writeFileSync(path.join(a.dest, "old.txt"), "old");
    fs.writeFileSync(path.join(a.dest, "sub", "deep.txt"), "stale");
    const r = run(a);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(names(a.dest), ["-x ü.md", "old.txt", "sub"]);
    assert.equal(fs.readFileSync(path.join(a.dest, "sub", "deep.txt"), "utf8"), "deep");
    assert.deepEqual(names(path.join(d, "dst")), ["folder"]);
  });

  test(`${dir} merge: nothing at dest yet just moves`, () => {
    const d = setup();
    const a = args(d, dir, "merge", "folder");
    mkTree(a.src);
    const r = run(a);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(names(a.dest), ["-x ü.md", "sub"]);
    assert.deepEqual(names(path.join(d, "dst")), ["folder"]);
  });

  test(`${dir} merge: symlink in dest is replaced, outside target untouched`, () => {
    const d = setup();
    const a = args(d, dir, "merge", "folder");
    mkTree(a.src);
    fs.writeFileSync(path.join(a.src, "x.txt"), "fresh");
    fs.mkdirSync(path.join(d, "outside", "sub"), { recursive: true });
    fs.writeFileSync(path.join(d, "outside", "x.txt"), "precious");
    fs.mkdirSync(a.dest);
    fs.symlinkSync(path.join(d, "outside", "x.txt"), path.join(a.dest, "x.txt"));
    fs.symlinkSync(path.join(d, "outside", "sub"), path.join(a.dest, "sub"));
    const r = run(a);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.lstatSync(path.join(a.dest, "x.txt")).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(a.dest, "x.txt"), "utf8"), "fresh");
    assert.equal(fs.lstatSync(path.join(a.dest, "sub")).isDirectory(), true);
    assert.equal(fs.readFileSync(path.join(a.dest, "sub", "deep.txt"), "utf8"), "deep");
    assert.equal(fs.readFileSync(path.join(d, "outside", "x.txt"), "utf8"), "precious");
    assert.deepEqual(names(path.join(d, "outside", "sub")), []);
  });

  test(`${dir} merge: type clash fails, dest unchanged, temp gone`, () => {
    const d = setup();
    const a = args(d, dir, "merge", "folder");
    mkTree(a.src);
    fs.mkdirSync(a.dest);
    fs.writeFileSync(path.join(a.dest, "-x ü.md"), "keep"); // dir-case below
    fs.mkdirSync(path.join(a.dest, "other"));
    fs.writeFileSync(path.join(a.dest, "sub"), "i am a file"); // temp has folder "sub"
    fs.rmSync(path.join(a.dest, "-x ü.md"));
    fs.mkdirSync(path.join(a.dest, "-x ü.md")); // temp has file "-x ü.md"
    const r = run(a);
    assert.notEqual(r.status, 0);
    assert.match(status(a), /^state=failed\ncode=[1-9]/);
    assert.match(status(a), /Type conflict/);
    assert.deepEqual(names(a.dest), ["-x ü.md", "other", "sub"]);
    assert.equal(fs.readFileSync(path.join(a.dest, "sub"), "utf8"), "i am a file");
    assert.deepEqual(names(path.join(a.dest, "-x ü.md")), []);
    assert.deepEqual(names(path.join(d, "dst")), ["folder"]);
  });

  for (const nm of ["x$(touch PWNED).txt", "a;b`touch PWNED`.txt"]) {
    test(`${dir}: name ${nm} arrives verbatim, nothing executed`, () => {
      const d = setup();
      const a = args(d, dir, "new", nm);
      fs.writeFileSync(a.src, "hi");
      const r = run(a, { PWD_PROBE: "1" });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.readFileSync(a.dest, "utf8"), "hi");
      assert.deepEqual(names(path.join(d, "dst")), [nm]);
      for (const x of [process.cwd(), d, path.join(d, "dst"), path.join(d, "src"), os.homedir()]) {
        assert.equal(fs.existsSync(path.join(x, "PWNED")), false);
      }
    });
  }

  test(`${dir}: scp failure gives failed, stderr line in status, temp gone`, () => {
    const d = setup();
    const a = args(d, dir, "new", "folder");
    mkTree(a.src);
    const r = run(a, { FAKE_FAIL: "Host key verification failed." });
    assert.equal(r.status, 1);
    const s = status(a);
    assert.match(s, /^state=failed\ncode=1\n/);
    assert.match(s, /Host key verification failed\./);
    assert.deepEqual(names(path.join(d, "dst")), []);
    assert.equal(fs.existsSync(a.status + ".err"), false);
    assert.equal(fs.existsSync(a.status + ".tmp"), false);
  });

  for (const sig of ["SIGHUP", "SIGTERM"]) {
    test(`${dir}: ${sig} mid transfer gives cancelled, no temp, no dest, no orphan`, async () => {
      const d = setup();
      const a = args(d, dir, "new", "folder");
      mkTree(a.src);
      const marker = `5.${Math.floor(100000 + Math.random() * 899999)}`;
      const p = spawn(process.env.TEST_SH || "sh", [SCRIPT, ...a.list], { env: { ...ENV, FAKE_SLEEP: marker }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      p.stdout.on("data", (c) => (out += c));
      p.stderr.on("data", (c) => (out += c));
      const closed = closing(p);
      const appeared = await waitFor(() => fs.readdirSync(path.join(d, "dst")).length > 0);
      assert.ok(appeared, "temp should exist before cancel");
      p.kill(sig);
      const code = await closed;
      assert.equal(code, 130);
      assert.match(status(a), /^state=cancelled\ncode=130\n/);
      assert.deepEqual(names(path.join(d, "dst")), []);
      assert.equal(out, "");
      assert.equal(fs.existsSync(a.status + ".err"), false);
      assert.ok(await waitFor(() => !running(marker)), "orphaned sleep");
    });
  }
}

function localArgs(d, mode, name, id = uid()) {
  const a = args(d, "local", mode, name, id);
  a.list[2] = "-";
  return a;
}

test("local new: file with nasty name arrives exact, target is ignored", () => {
  const d = setup();
  const nasty = "a b'c [1]*?.txt";
  const a = localArgs(d, "new", nasty);
  fs.writeFileSync(a.src, "hello");
  const r = run(a, { FILER_PRO_CP: path.join(root, "test/fake/cp") });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(a.dest, "utf8"), "hello");
  assert.deepEqual(names(path.join(d, "dst")), [nasty]);
  assert.match(status(a), /^state=done\ncode=0\n/);
  assert.equal(fs.existsSync(a.status + ".err"), false);
});

test("local new: folder keeps links as links and copies nothing outside", () => {
  const d = setup();
  const a = localArgs(d, "new", "folder");
  mkTree(a.src);
  fs.mkdirSync(path.join(d, "src", "outside"));
  fs.writeFileSync(path.join(d, "src", "outside", "o.txt"), "o");
  fs.symlinkSync("../outside", path.join(a.src, "ext"));
  fs.symlinkSync(".", path.join(a.src, "self"));
  const r = run(a);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(a.dest, "sub", "deep.txt"), "utf8"), "deep");
  assert.equal(fs.readFileSync(path.join(a.dest, "-x ü.md"), "utf8"), "umlaut");
  assert.equal(fs.readlinkSync(path.join(a.dest, "ext")), "../outside");
  assert.equal(fs.readlinkSync(path.join(a.dest, "self")), ".");
  assert.equal(fs.lstatSync(path.join(a.dest, "ext")).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(a.dest, "self")).isSymbolicLink(), true);
  assert.deepEqual(names(a.dest), ["-x ü.md", "ext", "self", "sub"]);
  assert.deepEqual(names(path.join(d, "dst")), ["folder"]);
});

test("local replace: old file goes to the trash, new one arrives", () => {
  const d = setup();
  const a = localArgs(d, "replace", "a.txt");
  fs.writeFileSync(a.src, "new");
  fs.writeFileSync(a.dest, "old");
  const r = run(a);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(a.dest, "utf8"), "new");
  const t = names(path.join(d, "trash"));
  assert.equal(t.length, 1);
  assert.match(t[0], /^a\.txt \d{8}-\d{6}/);
  assert.equal(fs.readFileSync(path.join(d, "trash", t[0]), "utf8"), "old");
});

test("local merge: old single files stay, same names are overwritten", () => {
  const d = setup();
  const a = localArgs(d, "merge", "folder");
  mkTree(a.src);
  fs.mkdirSync(path.join(a.dest, "sub"), { recursive: true });
  fs.writeFileSync(path.join(a.dest, "keep.txt"), "keep");
  fs.writeFileSync(path.join(a.dest, "sub", "deep.txt"), "old");
  const r = run(a);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(a.dest, "keep.txt"), "utf8"), "keep");
  assert.equal(fs.readFileSync(path.join(a.dest, "sub", "deep.txt"), "utf8"), "deep");
  assert.deepEqual(names(path.join(d, "dst")), ["folder"]);
});

// cp -P copies a link as the link and find does not follow it: a merge would do nothing and still say done (#46).
for (const dir of ["local", "remote"]) {
  test(`${dir} merge: a symlink to a folder as the source is refused, the target folder and the link stay (#46)`, () => {
    const d = setup();
    const a = dir === "local" ? localArgs(d, "merge", "folder") : args(d, dir, "merge", "folder");
    fs.mkdirSync(path.join(d, "real"));
    fs.writeFileSync(path.join(d, "real", "new.txt"), "new");
    fs.symlinkSync(path.join(d, "real"), a.src);
    fs.mkdirSync(a.dest);
    fs.writeFileSync(path.join(a.dest, "old.txt"), "old");
    const r = run(a);
    assert.notEqual(r.status, 0);
    assert.match(status(a), /^state=failed\ncode=[1-9]/);
    assert.match(status(a), new RegExp(`Cannot merge a symlink into a folder: ${a.src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\n?$`));
    assert.deepEqual(names(a.dest), ["old.txt"]);
    assert.deepEqual(names(path.join(d, "dst")), ["folder"]);
    assert.equal(fs.lstatSync(a.src).isSymbolicLink(), true);
    assert.deepEqual(names(path.join(d, "real")), ["new.txt"]);
  });
}

test("local new: existing dest fails, dest unchanged, temp gone", () => {
  const d = setup();
  const a = localArgs(d, "new", "a.txt");
  fs.writeFileSync(a.src, "new");
  fs.writeFileSync(a.dest, "old");
  const r = run(a);
  assert.notEqual(r.status, 0);
  assert.match(status(a), /^state=failed\ncode=[1-9]/);
  assert.equal(fs.readFileSync(a.dest, "utf8"), "old");
  assert.deepEqual(names(path.join(d, "dst")), ["a.txt"]);
});

test("local: SIGTERM mid copy gives cancelled, no temp, no dest", async () => {
  const d = setup();
  const a = localArgs(d, "new", "folder");
  mkTree(a.src);
  const marker = `5.${Math.floor(100000 + Math.random() * 899999)}`;
  const p = spawn(process.env.TEST_SH || "sh", [SCRIPT, ...a.list], { env: { ...ENV, FILER_PRO_CP: path.join(root, "test/fake/cp"), FAKE_SLEEP: marker }, stdio: "ignore" });
  const closed = closing(p);
  assert.ok(await waitFor(() => running(marker)), "the copy should be running");
  p.kill("SIGTERM");
  const code = await closed;
  assert.equal(code, 130);
  assert.match(status(a), /^state=cancelled\ncode=130\n/);
  assert.deepEqual(names(path.join(d, "dst")), []);
  // The fake cp is "sleep; exec cp": its own sleep child cannot be reaped by the script (a real cp has no child).
});

test("unknown direction: usage, exit 2, no status file", () => {
  const d = setup();
  const a = args(d, "sideways", "new", "a.txt");
  fs.writeFileSync(a.src, "x");
  const r = run(a);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: transfer\.sh <down\|up\|local\|remote\|cross>/);
  assert.equal(fs.existsSync(a.status), false);
  assert.deepEqual(names(path.join(d, "dst")), []);
});

test("argument count: cross needs 9 arguments, every other direction exactly 8", () => {
  const d = setup();
  const c = args(d, "cross", "new", "a.txt");
  fs.writeFileSync(c.src, "x");
  const r8 = run({ ...c, list: c.list.slice(0, 8) });
  assert.equal(r8.status, 2);
  assert.match(r8.stderr, /usage: transfer\.sh/);
  assert.equal(fs.existsSync(c.status), false);
  const u = args(d, "up", "new", "a.txt");
  const r9 = run({ ...u, list: [...u.list, "box2"] });
  assert.equal(r9.status, 2);
  assert.match(r9.stderr, /usage: transfer\.sh/);
  assert.equal(fs.existsSync(u.status), false);
  assert.deepEqual(names(path.join(d, "dst")), []);
});

test("cross: scp gets -3, the masked source on box2 and the temp on box", () => {
  const d = setup();
  const log = path.join(d, "scp.log"), wrap = path.join(d, "scp-wrap");
  fs.writeFileSync(wrap, `#!/bin/sh\nfor a; do printf '%s\\n' "$a"; done >> '${log}'\nexec '${path.join(root, "test/fake/scp")}' "$@"\n`, { mode: 0o755 });
  const a = args(d, "cross", "new", "a [1]*.txt");
  fs.writeFileSync(a.src, "x");
  const r = run(a, { FILER_PRO_SCP: wrap });
  assert.equal(r.status, 0, r.stderr);
  const argv = fs.readFileSync(log, "utf8").split("\n");
  assert.ok(argv.includes("-3"), argv.join(" "));
  assert.ok(argv.includes("-s"), argv.join(" "));
  assert.equal(argv[argv.length - 3], `box2:${a.src.replace(/[[\]*?\\]/g, "\\$&")}`);
  assert.equal(argv[argv.length - 2], `box:${a.temp}`);
  assert.equal(fs.readFileSync(a.dest, "utf8"), "x");
});

// ---- remote: src, dest and temp all on the machine (one cp -R -P -p over ssh)
test("remote new: a symlink in the source arrives as a link (cp -P)", () => {
  const d = setup();
  const a = args(d, "remote", "new", "folder");
  mkTree(a.src);
  fs.symlinkSync("/etc/hosts", path.join(a.src, "link"));
  const r = run(a);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.lstatSync(path.join(a.dest, "link")).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(path.join(a.dest, "link")), "/etc/hosts");
});

test("remote: a missing source fails, no temp, status failed", () => {
  const d = setup();
  const a = args(d, "remote", "new", "missing");
  const r = run(a);
  assert.notEqual(r.status, 0);
  assert.match(status(a), /^state=failed\ncode=[1-9]/);
  assert.deepEqual(names(path.join(d, "dst")), []);
});

test("remote: cancel stops a copy that outlives the dropped connection, and removes the temp", async () => {
  const d = setup();
  const id = `t${Math.random().toString(36).slice(2, 10)}`;
  const a = args(d, "remote", "new", "folder", id);
  mkTree(a.src);
  const marker = `5.${Math.floor(100000 + Math.random() * 899999)}`;
  const env = { ...ENV, FILER_PRO_SSH: path.join(root, "test/fake/ssh-detach"), FAKE_SLEEP: marker };
  const p = spawn(process.env.TEST_SH || "sh", [SCRIPT, ...a.list], { env, stdio: "ignore" });
  const closed = closing(p);
  assert.ok(await waitFor(() => running(marker)), "the remote copy should be running");
  p.kill("SIGTERM");
  const code = await closed;
  assert.equal(code, 130);
  assert.match(status(a), /^state=cancelled\ncode=130\n/);
  assert.deepEqual(names(path.join(d, "dst")), []);
  assert.ok(await waitFor(() => !matching(`fs-${id}`)), "the remote copy was left running");
  assert.ok(await waitFor(() => !running(marker)), "orphaned sleep");
});

// The remote login shell may be csh or fish: the cancel's command line must not need sh syntax there.
test("remote: cancel with a csh login shell on the machine still stops the copy and removes the temp", async (t) => {
  if (!fs.existsSync("/bin/csh")) return t.skip("no /bin/csh");
  const d = setup();
  const id = `t${Math.random().toString(36).slice(2, 10)}`;
  const a = args(d, "remote", "new", "folder", id);
  mkTree(a.src);
  const marker = `5.${Math.floor(100000 + Math.random() * 899999)}`;
  const env = { ...ENV, FILER_PRO_SSH: path.join(root, "test/fake/ssh-detach"), FAKE_SLEEP: marker, FAKE_LOGIN: "/bin/csh" };
  const p = spawn(process.env.TEST_SH || "sh", [SCRIPT, ...a.list], { env, stdio: "ignore" });
  const closed = closing(p, 6000);
  assert.ok(await waitFor(() => running(marker)), "the remote copy should be running");
  p.kill("SIGTERM");
  // csh cannot parse sh's while loop and waits for its "end": a hanging cancel counts as failure.
  let code;
  try {
    code = await closed;
  } finally {
    const gone = await waitFor(() => !matching(`fs-${id}`), 3000);
    if (!gone) spawnSync("pkill", ["-9", "-f", `fs-${id}`]);
    spawnSync("pkill", ["-f", `sleep ${marker}`]);
    assert.ok(gone, "the remote copy was left running");
  }
  assert.equal(code, 130);
  assert.deepEqual(names(path.join(d, "dst")), []);
});

test("up replace: old copy that cannot be fully removed only warns, state stays done", (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip("root can delete everything");
  const d = setup();
  const id = uid();
  const a = args(d, "up", "replace", "folder", id);
  mkTree(a.src);
  fs.mkdirSync(path.join(a.dest, "locked"), { recursive: true });
  fs.writeFileSync(path.join(a.dest, "locked", "f"), "old");
  fs.chmodSync(path.join(a.dest, "locked"), 0o555);
  t.after(() => fs.chmodSync(path.join(d, "dst", `.folder.fs-old-${id}`, "locked"), 0o755));
  const r = run(a);
  assert.equal(r.status, 0, r.stderr);
  assert.match(status(a), /^state=done\ncode=0\n/);
  assert.match(status(a), /Warning: could not fully remove old copy/);
  assert.deepEqual(names(a.dest), ["-x ü.md", "sub"]);
});

// The remote login shell may be csh: it refuses a newline inside quotes ("Unmatched '"), so the multi-line
// finalization must not travel in the command line.
for (const dir of ["up", "remote", "cross"]) {
  for (const mode of ["new", "merge"]) {
    test(`${dir} ${mode}: finalization works with a csh login shell on the machine`, async (t) => {
      if (!fs.existsSync("/bin/csh")) return t.skip("no /bin/csh");
      const d = setup();
      const a = args(d, dir, mode, "folder");
      mkTree(a.src);
      if (mode === "merge") { fs.mkdirSync(a.dest); fs.writeFileSync(path.join(a.dest, "old.txt"), "old"); }
      // csh may also hang on the open quote instead of failing: own process group, killed after 20 s.
      const r = await new Promise((resolve) => {
        const p = spawn("sh", [SCRIPT, ...a.list], { env: { ...ENV, FAKE_LOGIN: "/bin/csh" }, detached: true, stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        p.stderr.on("data", (c) => { stderr += c; });
        const timer = setTimeout(() => { try { process.kill(-p.pid, "SIGKILL"); } catch {} }, 20000);
        p.on("exit", (status) => { clearTimeout(timer); try { process.kill(-p.pid, "SIGKILL"); } catch {} resolve({ status, stderr }); });
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.readFileSync(path.join(a.dest, "sub", "deep.txt"), "utf8"), "deep");
      if (mode === "merge") assert.equal(fs.readFileSync(path.join(a.dest, "old.txt"), "utf8"), "old");
      assert.deepEqual(names(path.join(d, "dst")), ["folder"]);
      assert.match(status(a), /^state=done\ncode=0\n/);
    });
  }
}

// csh also parses "!" (history, "Event not found") and newlines in the command line: names must not travel there.
for (const dir of ["up", "remote", "cross"]) {
  for (const name of ["bang!name", "!", "line\nbreak"]) {
    test(`${dir} new: name ${JSON.stringify(name)} survives a csh login shell on the machine`, async (t) => {
      if (!fs.existsSync("/bin/csh")) return t.skip("no /bin/csh");
      const d = setup();
      const a = args(d, dir, "new", name);
      fs.writeFileSync(a.src, "hello");
      const r = await new Promise((resolve) => {
        const p = spawn("sh", [SCRIPT, ...a.list], { env: { ...ENV, FAKE_LOGIN: "/bin/csh" }, detached: true, stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        p.stderr.on("data", (c) => { stderr += c; });
        const timer = setTimeout(() => { try { process.kill(-p.pid, "SIGKILL"); } catch {} }, 20000);
        p.on("exit", (status) => { clearTimeout(timer); try { process.kill(-p.pid, "SIGKILL"); } catch {} resolve({ status, stderr }); });
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.readFileSync(a.dest, "utf8"), "hello");
      assert.deepEqual(names(path.join(d, "dst")), [name]);
    });
  }
}

// ---- Mount guard before Replace (issue #31). The tables stand in for /proc/self/mountinfo and `mount`
// (FILER_PRO_MOUNTINFO / FILER_PRO_MOUNTS, tests only). Mount points are physical paths: on macOS the temp
// folder is /var/... and its physical spelling /private/var/..., so the guard must resolve the folder first.
const infoLine = (mp) => `36 35 98:0 / ${mp} rw,relatime shared:1 - ext4 /dev/sdb1 rw\n`;
const bsdLine = (mp) => `/dev/disk9s1 on ${mp} (hfs, local, nodev, nosuid, nobrowse)\n`;
const MOUNT_REFUSED = /Refusing to replace, a file system is mounted at: /;

function mountedDest(d, a) {
  fs.mkdirSync(path.join(a.dest, "mnt"), { recursive: true });
  fs.writeFileSync(path.join(a.dest, "old.txt"), "old");
  fs.writeFileSync(path.join(a.dest, "mnt", "precious.txt"), "precious");
  return path.join(fs.realpathSync(a.dest), "mnt");
}
const untouched = (a) => fs.readFileSync(path.join(a.dest, "mnt", "precious.txt"), "utf8") === "precious"
  && fs.readFileSync(path.join(a.dest, "old.txt"), "utf8") === "old";

for (const dir of ["up", "remote", "cross"]) {
  for (const mode of ["replace", "merge"]) {
    for (const table of ["mountinfo", "mount"]) {
      test(`${dir} ${mode === "merge" ? "merge of a file over a folder" : "replace"}: a mount below the old folder refuses (${table}), nothing is deleted`, () => {
        const d = setup();
        const a = args(d, dir, mode, "folder");
        if (mode === "merge") fs.writeFileSync(a.src, "file"); // merge falls back to replace for a file
        else mkTree(a.src);
        const mp = mountedDest(d, a);
        const env = table === "mountinfo"
          ? { FILER_PRO_MOUNTINFO: path.join(d, "info.txt") }
          : { FILER_PRO_MOUNTINFO: path.join(d, "none"), FILER_PRO_MOUNTS: path.join(d, "bsd.txt") };
        fs.writeFileSync(path.join(d, table === "mountinfo" ? "info.txt" : "bsd.txt"), table === "mountinfo" ? infoLine(mp) : bsdLine(mp));
        const r = run(a, env);
        assert.notEqual(r.status, 0);
        assert.match(status(a), /^state=failed\ncode=[1-9]/);
        assert.match(status(a), MOUNT_REFUSED);
        assert.ok(status(a).includes(mp), status(a));
        assert.ok(untouched(a), "the old folder must stay as it was");
        assert.deepEqual(names(path.join(d, "dst")), ["folder"]);
      });
    }
  }

  test(`${dir} replace: the guard resolves a symlink in the path to the target folder`, () => {
    const d = setup();
    const a = args(d, dir, "replace", "folder");
    mkTree(a.src);
    const mp = mountedDest(d, a);
    fs.symlinkSync(path.join(d, "dst"), path.join(d, "lnk"));
    a.list[4] = path.join(d, "lnk", "folder");
    a.list[5] = path.join(d, "lnk", path.basename(a.temp));
    fs.writeFileSync(path.join(d, "info.txt"), infoLine(mp));
    const r = run(a, { FILER_PRO_MOUNTINFO: path.join(d, "info.txt") });
    assert.notEqual(r.status, 0);
    assert.match(status(a), MOUNT_REFUSED);
    assert.ok(untouched(a));
  });

  test(`${dir} replace: a mount elsewhere does not stop the replace`, () => {
    const d = setup();
    const a = args(d, dir, "replace", "folder");
    mkTree(a.src);
    mountedDest(d, a);
    fs.writeFileSync(path.join(d, "info.txt"), infoLine(`${fs.realpathSync(path.join(d, "dst"))}/folder-other/mnt`));
    const r = run(a, { FILER_PRO_MOUNTINFO: path.join(d, "info.txt") });
    assert.equal(r.status, 0, r.stderr);
    assert.match(status(a), /^state=done\ncode=0\n/);
    assert.deepEqual(names(a.dest), ["-x ü.md", "sub"]);
  });

  test(`${dir} replace: a link as the old target is replaced as the link, its target is not checked`, () => {
    const d = setup();
    const a = args(d, dir, "replace", "folder");
    mkTree(a.src);
    fs.mkdirSync(path.join(d, "elsewhere", "mnt"), { recursive: true });
    fs.writeFileSync(path.join(d, "elsewhere", "mnt", "precious.txt"), "precious");
    fs.symlinkSync(path.join(d, "elsewhere"), a.dest);
    fs.writeFileSync(path.join(d, "info.txt"), infoLine(`${fs.realpathSync(path.join(d, "elsewhere"))}/mnt`));
    const r = run(a, { FILER_PRO_MOUNTINFO: path.join(d, "info.txt") });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.lstatSync(a.dest).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(d, "elsewhere", "mnt", "precious.txt"), "utf8"), "precious");
  });
}

// A case-insensitive target (APFS, HFS+) takes "Folder" for the existing "folder": the guard must see the mount in
// it although the mount table spells the path "folder" (follow-up to #31). Real folders below the worktree tmp/.
const caseInsensitive = (d) => { fs.writeFileSync(path.join(d, "CaseProbe"), ""); const r = fs.existsSync(path.join(d, "caseprobe")); fs.rmSync(path.join(d, "CaseProbe")); return r; };
async function caseSetup(dir) {
  const d = await mkTmp("case-");
  for (const s of ["src", "dst", "trash"]) fs.mkdirSync(path.join(d, s));
  const a = args(d, dir, "replace", "Folder");
  mkTree(a.src);
  return { d, a, old: { ...a, dest: path.join(d, "dst", "folder") } };
}
for (const dir of ["up", "remote", "cross"]) {
  for (const table of ["mountinfo", "mount"]) {
    test(`${dir} replace: "Folder" over the existing "folder" with a mount in it refuses on a case-insensitive target (${table})`, async (t) => {
      const { d, a, old } = await caseSetup(dir);
      if (!caseInsensitive(d)) return t.skip("the file system here tells letter case apart");
      const mp = mountedDest(d, old);
      const env = table === "mountinfo"
        ? { FILER_PRO_MOUNTINFO: path.join(d, "info.txt") }
        : { FILER_PRO_MOUNTINFO: path.join(d, "none"), FILER_PRO_MOUNTS: path.join(d, "bsd.txt") };
      fs.writeFileSync(path.join(d, table === "mountinfo" ? "info.txt" : "bsd.txt"), table === "mountinfo" ? infoLine(mp) : bsdLine(mp));
      const r = run(a, env);
      assert.notEqual(r.status, 0);
      assert.match(status(a), /^state=failed\ncode=[1-9]/);
      assert.match(status(a), MOUNT_REFUSED);
      assert.ok(status(a).includes(mp), status(a));
      assert.ok(untouched(old), "the old folder must stay as it was");
      assert.deepEqual(names(path.join(d, "dst")), ["folder"]);
    });
  }

  test(`${dir} replace: "Folder" next to a separate "folder" with a mount is replaced on a case-sensitive target`, async (t) => {
    const { d, a, old } = await caseSetup(dir);
    if (caseInsensitive(d)) return t.skip("the file system here ignores letter case");
    const mp = mountedDest(d, old);
    fs.mkdirSync(a.dest);
    fs.writeFileSync(path.join(d, "info.txt"), infoLine(mp));
    const r = run(a, { FILER_PRO_MOUNTINFO: path.join(d, "info.txt") });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(names(a.dest), ["-x ü.md", "sub"]);
    assert.ok(untouched(old));
  });
}

// APFS and HFS+ take "café" in NFC for the stored NFD "café": the table spells the mount in the stored form, the
// builtin pwd -P of bash (macOS sh) keeps the spelling of the call, so the guard asks the external pwd (#31).
const NFD = "café", NFC = "café";
for (const dir of ["up", "remote", "cross"]) {
  for (const table of ["mountinfo", "mount"]) {
    test(`${dir} replace: an NFC name over the existing NFD folder with a mount in it refuses (${table})`, async (t) => {
      const d = await mkTmp("nfd-");
      for (const s of ["src", "dst", "trash"]) fs.mkdirSync(path.join(d, s));
      const a = args(d, dir, "replace", NFC);
      const old = { ...a, dest: path.join(d, "dst", NFD) };
      fs.mkdirSync(old.dest);
      if (!fs.existsSync(a.dest)) return t.skip("the file system here tells Unicode normal forms apart");
      mkTree(a.src);
      const mp = mountedDest(d, old);
      assert.ok(mp.includes(NFD), "the mount point must be in the stored form");
      const env = table === "mountinfo"
        ? { FILER_PRO_MOUNTINFO: path.join(d, "info.txt") }
        : { FILER_PRO_MOUNTINFO: path.join(d, "none"), FILER_PRO_MOUNTS: path.join(d, "bsd.txt") };
      fs.writeFileSync(path.join(d, table === "mountinfo" ? "info.txt" : "bsd.txt"), table === "mountinfo" ? infoLine(mp) : bsdLine(mp));
      const r = run(a, env);
      assert.notEqual(r.status, 0);
      assert.match(status(a), /^state=failed\ncode=[1-9]/);
      assert.match(status(a), MOUNT_REFUSED);
      assert.ok(untouched(old), "the old folder must stay as it was");
      assert.deepEqual(names(path.join(d, "dst")), [NFD]);
    });
  }
}

// transfer.sh is standalone sh and cannot import MOUNT_FN: its copy must stay the same text and the same behaviour.
test("transfer.sh carries MOUNT_FN unchanged and both judge the same cases alike", () => {
  const text = fs.readFileSync(SCRIPT, "utf8");
  const m = /^mount_sh\(\) {\n  cat <<'EOF'\n([\s\S]*?)\nEOF\n}\nMOUNT_SH=\$\(mount_sh\)$/m.exec(text);
  assert.ok(m, "MOUNT_SH heredoc not found in transfer.sh");
  assert.equal(m[1], MOUNT_FN);
  const d = setup();
  const p = fs.realpathSync(d);
  fs.writeFileSync(`${d}/info.txt`, infoLine(`${p}/a/mnt`) + infoLine(`${p}/b\\040c/m`) + infoLine(`${p}/n\\012l`));
  fs.writeFileSync(`${d}/bsd.txt`, bsdLine(`${p}/x (1)/m`) + bsdLine(`${p}/y`));
  for (const f of ["a", "b c", "y"]) fs.mkdirSync(`${p}/${f}`); // the near matches below are checked by identity
  const ci = caseInsensitive(d) ? 1 : 0;
  const cases = [
    [`${p}/a`, `${d}/info.txt`, ""], [`${p}/a/mnt`, `${d}/info.txt`, ""], [`${p}/ab`, `${d}/info.txt`, ""],
    [`${p}/b c`, `${d}/info.txt`, ""], [`${p}/n\nl`, `${d}/info.txt`, ""], [`${p}/z`, `${d}/info.txt`, ""],
    [`${p}/x (1)`, `${d}/none`, `${d}/bsd.txt`], [`${p}/y`, `${d}/none`, `${d}/bsd.txt`], [`${p}/yy`, `${d}/none`, `${d}/bsd.txt`],
    [`${p}/A`, `${d}/info.txt`, ""], [`${p}/B C`, `${d}/info.txt`, ""], [`${p}/Y`, `${d}/none`, `${d}/bsd.txt`], [`${p}/AB`, `${d}/info.txt`, ""],
  ];
  const judge = (fn, c) => {
    const r = spawnSync("sh", ["-c", `${fn}\nV=replace; mounted "$1" "$2" "$3"`, "x", ...c], { encoding: "utf8" });
    return [r.status, r.stderr];
  };
  const hits = [];
  for (const c of cases) {
    const a = judge(MOUNT_FN, c), b = judge(m[1], c);
    assert.deepEqual(b, a, JSON.stringify(c));
    hits.push(a[0]);
  }
  assert.deepEqual(hits, [1, 1, 0, 1, 1, 0, 1, 1, 0, ci, ci, ci, 0]);
});

// Settings: FILER_PRO_SSH_* set the ssh options of scp and ssh; anything but digits falls back to the default, because
// the options are word-split into the command line (a value like "15 -o ProxyCommand=x" must never become options).
test("SSH options come from FILER_PRO_SSH_*; non-digit values fall back to the defaults", () => {
  const d = setup();
  const log = path.join(d, "scp.log"), wrap = path.join(d, "scp-wrap");
  fs.writeFileSync(wrap, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${path.join(root, "test/fake/scp")}' "$@"\n`, { mode: 0o755 });
  const once = (name, env) => {
    fs.writeFileSync(path.join(d, "src", name), "x");
    fs.rmSync(log, { force: true });
    const r = run(args(d, "down", "new", name), { FILER_PRO_SCP: wrap, ...env });
    assert.equal(r.status, 0, r.stderr);
    return fs.readFileSync(log, "utf8");
  };
  assert.match(once("a.txt", {}), /-o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 /);
  assert.match(once("b.txt", { FILER_PRO_SSH_CONNECT_TIMEOUT: "30", FILER_PRO_SSH_ALIVE_INTERVAL: "5", FILER_PRO_SSH_ALIVE_COUNT: "9" }),
    /-o BatchMode=yes -o ConnectTimeout=30 -o ServerAliveInterval=5 -o ServerAliveCountMax=9 /);
  const bad = once("c.txt", { FILER_PRO_SSH_CONNECT_TIMEOUT: "15 -o ProxyCommand=x", FILER_PRO_SSH_ALIVE_INTERVAL: "", FILER_PRO_SSH_ALIVE_COUNT: "-1" });
  assert.match(bad, /-o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 /);
  assert.doesNotMatch(bad, /ProxyCommand/);
});
