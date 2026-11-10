import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import { EXTRACT_STOP_SCRIPT } from "../mods/filer-pro/lib/archives.js";
import { mkTmpSync } from "./tmp-helper.js";
import { tarBuffer, zipBuffer } from "./archive-craft.js";

const root = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(root, "mods/filer-pro/bin/extract.sh");
const SH = process.env.TEST_SH || "sh";
const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;
const HAS_UNZIP = has("unzip"), HAS_BSDTAR = has("bsdtar"), HAS_PY = has("python3"), HAS_GZIP = has("gzip");

const ENV = { ...process.env, FILER_PRO_SSH: path.join(root, "test/fake/ssh") };
delete ENV.FILER_PRO_MACHINE;

const uid = () => `t${Math.random().toString(36).slice(2, 10)}${process.pid.toString(36)}`;
const names = (dir) => fs.readdirSync(dir).sort();

function setup() {
  const d = mkTmpSync("filer-pro-x-");
  for (const s of ["dest", "trash"]) fs.mkdirSync(path.join(d, s));
  return d;
}

// Builds the argument list; o: { tool, need, sub, file, plan: [[entry, mode, name]], target, archive }
function build(d, archiveName, data, o = {}) {
  const archive = o.archive ?? path.join(d, archiveName);
  if (data) fs.writeFileSync(path.join(d, archiveName), data);
  const id = uid();
  const temp = path.join(d, "dest", `.${archiveName}.fs-${id}.part`);
  const status = path.join(d, "status");
  const list = [o.target ?? "-", o.tool ?? "tar", o.need ?? "-", archive, o.sub ?? "-", o.file ?? "-", temp,
    path.join(d, "dest"), status, path.join(d, "trash"), ...(o.plan ?? []).flat()];
  return { list, temp, status, dest: path.join(d, "dest"), trash: path.join(d, "trash"), id };
}

function run(a, env = {}, cwd) {
  return spawnSync(SH, [SCRIPT, ...a.list], { env: { ...ENV, ...env }, encoding: "utf8", cwd });
}
const status = (a) => fs.readFileSync(a.status, "utf8");
const tarOf = (entries) => tarBuffer(entries);
const files = [{ name: "a.txt", data: "A" }, { name: "dir/", type: "dir" }, { name: "dir/b.txt", data: "B" }];

test("tar, Extract Here: entries land in the folder, temp gone, status done", () => {
  const d = setup();
  const a = build(d, "x.tar", tarOf(files));
  const r = run(a);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(names(a.dest), ["a.txt", "dir"]);
  assert.equal(fs.readFileSync(path.join(a.dest, "dir/b.txt"), "utf8"), "B");
  assert.match(status(a), /^state=done\ncode=0\n/);
  assert.equal(fs.existsSync(a.status + ".err"), false);
});

test("tar.gz, Extract to: everything lands in the named folder", { skip: !HAS_GZIP && "gzip is not installed" }, () => {
  const d = setup();
  const a = build(d, "x.tar.gz", zlib.gzipSync(tarOf(files)), { need: "gzip", sub: "x" });
  const r = run(a);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(names(a.dest), ["x"]);
  assert.deepEqual(names(path.join(a.dest, "x")), ["a.txt", "dir"]);
});

test("zip with unzip", { skip: !HAS_UNZIP && "unzip is not installed" }, () => {
  const d = setup();
  const a = build(d, "x.zip", zipBuffer([{ name: "a.txt", data: "A" }, { name: "s/b.txt", data: "B" }]), { tool: "unzip" });
  const r = run(a);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(a.dest, "s/b.txt"), "utf8"), "B");
  assert.match(status(a), /^state=done/);
});

test("tar through bsdtar (the dummy passphrase does not hurt a tar)", { skip: !HAS_BSDTAR && "bsdtar is not installed" }, () => {
  const d = setup();
  const a = build(d, "x.tar", tarOf(files), { tool: "bsdtar" });
  const r = run(a);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(names(a.dest), ["a.txt", "dir"]);
});

test("single .gz: the output file gets the given name", { skip: !HAS_GZIP && "gzip is not installed" }, () => {
  const d = setup();
  const a = build(d, "note.txt.gz", zlib.gzipSync("hello"), { tool: "gzip", need: "gzip", file: "note.txt" });
  const r = run(a);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(a.dest, "note.txt"), "utf8"), "hello");
});

test("an archive named -odd [x].tar works, absolute and relative", () => {
  for (const rel of [false, true]) {
    const d = setup();
    const name = "-odd [x].tar";
    const a = build(d, name, tarOf(files), rel ? { archive: name } : {});
    const r = run(a, {}, rel ? d : undefined);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(names(a.dest), ["a.txt", "dir"]);
  }
});

test("plan: skip leaves it out, a new name keeps both, nothing else is touched", () => {
  const d = setup();
  fs.writeFileSync(path.join(d, "dest/a.txt"), "old");
  const a = build(d, "x.tar", tarOf(files), { plan: [["a.txt", "new", "a-1.txt"], ["dir", "skip", "dir"]] });
  const r = run(a);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(names(a.dest), ["a-1.txt", "a.txt"]);
  assert.equal(fs.readFileSync(path.join(a.dest, "a.txt"), "utf8"), "old");
  assert.equal(fs.readFileSync(path.join(a.dest, "a-1.txt"), "utf8"), "A");
});

test("plan: replace puts the old entry into the trash dir", () => {
  const d = setup();
  fs.writeFileSync(path.join(d, "dest/a.txt"), "old");
  const a = build(d, "x.tar", tarOf(files), { plan: [["a.txt", "replace", "a.txt"]] });
  const r = run(a);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(a.dest, "a.txt"), "utf8"), "A");
  const t = names(a.trash);
  assert.equal(t.length, 1);
  assert.equal(fs.readFileSync(path.join(a.trash, t[0]), "utf8"), "old");
  assert.deepEqual(names(a.dest), ["a.txt", "dir"]);
  assert.deepEqual(fs.readdirSync(d).filter((n) => n.startsWith("status.")), []);
});

test("plan: merge keeps old files and overwrites same names", () => {
  const d = setup();
  fs.mkdirSync(path.join(d, "dest/dir"));
  fs.writeFileSync(path.join(d, "dest/dir/b.txt"), "old");
  fs.writeFileSync(path.join(d, "dest/dir/keep.txt"), "keep");
  const a = build(d, "x.tar", tarOf(files), { plan: [["dir", "merge", "dir"]] });
  const r = run(a);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(names(path.join(a.dest, "dir")), ["b.txt", "keep.txt"]);
  assert.equal(fs.readFileSync(path.join(a.dest, "dir/b.txt"), "utf8"), "B");
});

test("a destination that appeared meanwhile: failed, nothing overwritten", () => {
  const d = setup();
  fs.writeFileSync(path.join(d, "dest/a.txt"), "old");
  const a = build(d, "x.tar", tarOf(files));
  const r = run(a);
  assert.equal(r.status, 1);
  assert.equal(fs.readFileSync(path.join(a.dest, "a.txt"), "utf8"), "old");
  assert.match(status(a), /^state=failed\ncode=1\n[\s\S]*Destination already exists: .*a\.txt/);
  assert.deepEqual(names(a.dest), ["a.txt", "dir"], "the other entry still arrived, no temp left");
});

test("a link that points outside: done, with the warning line", () => {
  const d = setup();
  const a = build(d, "x.tar", tarOf([{ name: "l", type: "symlink", target: "/etc/hosts" }, { name: "m", type: "symlink", target: "../x" },
    { name: "ok", type: "symlink", target: "a.txt" }, { name: "a.txt", data: "A" }]));
  const r = run(a);
  assert.equal(r.status, 0, r.stderr);
  assert.match(status(a), /^state=done\ncode=0\nWarning: 2 links point outside the extracted files\n/);
  const b = build(d, "y.tar", tarOf([{ name: "l2", type: "symlink", target: "/etc/hosts" }]));
  assert.equal(run(b).status, 0);
  assert.match(status(b), /Warning: 1 link points outside the extracted files\n/);
});

test("a crafted traversal archive writes nothing outside the target", () => {
  const d = setup();
  const outside = path.join(d, "outside");
  fs.mkdirSync(outside);
  const abs = `/filer-pro-abs-${uid()}.txt`;
  const a = build(d, "evil.tar", tarOf([
    { name: "../escape.txt", data: "x" }, { name: abs, data: "x" },
    { name: "l", type: "symlink", target: outside }, { name: "l/pwned.txt", data: "x" }]));
  run(a); // the rc differs: GNU tar strips with 0, bsdtar refuses with 1
  assert.deepEqual(names(outside), []);
  assert.equal(fs.existsSync(abs), false);
  const found = spawnSync("find", [d, "-name", "escape.txt", "-o", "-name", "pwned.txt"], { encoding: "utf8" }).stdout.trim();
  assert.equal(found, "");
  assert.equal(fs.existsSync(path.join(d, "escape.txt")), false);
});

// A PATH folder with a symlink to every tool of /bin and /usr/bin except zstd and xz (they may live in /opt/homebrew).
function restrictedBin(d) {
  const bin = path.join(d, "bin");
  fs.mkdirSync(bin);
  for (const dir of ["/bin", "/usr/bin"]) {
    for (const n of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (n === "zstd" || n === "xz" || fs.existsSync(path.join(bin, n))) continue;
      try { fs.symlinkSync(path.join(dir, n), path.join(bin, n)); } catch { /* ignore */ }
    }
  }
  return bin;
}

test("a missing zstd: failed with the tool named", () => {
  const d = setup();
  const a = build(d, "x.tar.zst", Buffer.from("not really zstd"), { need: "zstd" });
  const r = spawnSync(process.env.TEST_SH || "/bin/sh", [SCRIPT, ...a.list], { env: { ...ENV, PATH: restrictedBin(d) }, encoding: "utf8" });
  assert.equal(r.status, 1, r.stderr);
  assert.match(status(a), /^state=failed\ncode=1\nzstd is not installed on this computer\n/);
  assert.deepEqual(names(a.dest), []);
});

test("an unreadable archive: failed with the tool's message, temp gone", () => {
  const d = setup();
  const a = build(d, "x.tar", Buffer.from("this is not a tar archive at all"));
  const r = run(a);
  assert.equal(r.status, 1);
  assert.match(status(a), /^state=failed\ncode=1\n.+/);
  assert.deepEqual(names(a.dest), []);
});

test("cancel: SIGTERM ends the extractor, the temp is gone, status cancelled", async () => {
  const d = setup();
  const bin = path.join(d, "slowbin");
  fs.mkdirSync(bin);
  const marker = `31.${Math.floor(Math.random() * 1e6)}`;
  fs.writeFileSync(path.join(bin, "tar"), `#!/bin/sh\nexec sleep ${marker}\n`, { mode: 0o755 });
  const a = build(d, "x.tar", tarOf(files));
  const p = spawn(SH, [SCRIPT, ...a.list], { env: { ...ENV, PATH: `${bin}:${process.env.PATH}` }, stdio: "ignore" });
  const closed = new Promise((res) => p.on("close", (c) => res(c)));
  const sleeping = () => spawnSync("pgrep", ["-f", `sleep ${marker}`], { encoding: "utf8" }).stdout.trim() !== "";
  const t0 = Date.now();
  while (!sleeping() && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 20));
  assert.ok(sleeping(), "the fake extractor never started");
  p.kill("SIGTERM");
  assert.equal(await closed, 130);
  assert.match(status(a), /^state=cancelled\ncode=130\n/);
  assert.deepEqual(names(a.dest), []);
  assert.equal(sleeping(), false, "the extractor is still running");
});

test("remote through the fake ssh: extract, replace via rplace", () => {
  const d = setup();
  fs.writeFileSync(path.join(d, "dest/a.txt"), "old");
  const a = build(d, "x.tar", tarOf(files), { target: "box", plan: [["a.txt", "replace", "a.txt"]] });
  const r = run(a, { FILER_PRO_MACHINE: "box" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(a.dest, "a.txt"), "utf8"), "A");
  assert.deepEqual(names(a.dest), ["a.txt", "dir"]);
  assert.match(status(a), /^state=done\ncode=0\n/);
});

test("remote: a missing tool names the machine", () => {
  const d = setup();
  const a = build(d, "x.tar.zst", Buffer.from("x"), { target: "box", tool: "zstd" });
  const r = spawnSync(process.env.TEST_SH || "/bin/sh", [SCRIPT, ...a.list], { env: { ...ENV, PATH: restrictedBin(d), FILER_PRO_MACHINE: "box" }, encoding: "utf8" });
  assert.equal(r.status, 1, r.stderr);
  assert.match(status(a), /zstd is not installed on box\n/);
});

const PTY = `import os, pty, select, signal, sys, time
argv = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execv(argv[0], argv)
end = time.time() + 20
while True:
    if time.time() > end:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        sys.exit(99)
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try:
            os.read(fd, 4096)
        except OSError:
            pass
    w, st = os.waitpid(pid, os.WNOHANG)
    if w:
        sys.exit(os.waitstatus_to_exitcode(st))
`;

test("an encrypted zip under a pty: failed, no password prompt", { skip: (!HAS_PY && "python3 is not installed") || (!HAS_UNZIP && "unzip is not installed") }, () => {
  const d = setup();
  const py = path.join(d, "pty.py");
  fs.writeFileSync(py, PTY);
  const a = build(d, "e.zip", zipBuffer([{ name: "a.txt", data: "secret" }], { encrypted: true }), { tool: "unzip" });
  const r = spawnSync("python3", ["-I", py, "/bin/sh", SCRIPT, ...a.list], { env: ENV, encoding: "utf8", timeout: 30000 });
  assert.equal(r.status, 1, `${r.stderr} ${r.stdout}`);
  assert.match(status(a), /^state=failed\ncode=1\nEncrypted archives are not supported\n/);
  assert.deepEqual(names(a.dest), []);
});

test("extract.sh carries EXTRACT_STOP_SCRIPT unchanged", () => {
  const text = fs.readFileSync(SCRIPT, "utf8");
  const m = /^# BEGIN EXTRACT_STOP_SCRIPT\nstop_sh\(\) {\n  cat <<'EOF'\n([\s\S]*?)\nEOF\n}\n# END EXTRACT_STOP_SCRIPT$/m.exec(text);
  assert.ok(m, "the stop script block was not found in extract.sh");
  assert.equal(`${m[1]}\n`, EXTRACT_STOP_SCRIPT);
});

test("usage: too few arguments or a bad tool exit 2 without a status file", () => {
  const d = setup();
  const a = build(d, "x.tar", tarOf(files), { tool: "rm" });
  assert.equal(run(a).status, 2);
  assert.equal(fs.existsSync(a.status), false);
  assert.equal(spawnSync(SH, [SCRIPT, "-"], { encoding: "utf8" }).status, 2);
});
