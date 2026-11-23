import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { mkTmpSync } from "./tmp-helper.js";
import {
  MOVE_VERIFY_SCRIPT, VERIFY_MS, VERIFY_LIMIT_S, HASH_MAX_BYTES, verifyArgs, parseMoveVerify, verdict,
  KEPT_UNKNOWN, KEPT_MISMATCH, KEPT_CHANGED, KEPT_NO_HASH,
} from "../mods/filer-pro/lib/verify.js";

const run = (p, links = "L", max = "1000000000", s = "590", env = {}) =>
  spawnSync("sh", ["-c", MOVE_VERIFY_SCRIPT, "verify", p, links, max, s], { encoding: "utf8", env: { ...process.env, ...env } }).stdout.trim();
const scratch = (fn) => {
  const dir = mkTmpSync("fs-verify-");
  fn(dir);
};
const tree = (dir) => {
  const d = path.join(dir, "d");
  fs.mkdirSync(path.join(d, "sub"), { recursive: true });
  fs.writeFileSync(path.join(d, "a.txt"), "abc");
  fs.writeFileSync(path.join(d, "sub", "b.txt"), "12345");
  return d;
};

test("MOVE_VERIFY_SCRIPT counts files, folders and bytes of a folder", () =>
  scratch((dir) => {
    const v = parseMoveVerify(run(tree(dir)));
    assert.equal(v.files, 2);
    assert.equal(v.dirs, 2);
    assert.equal(v.bytes, 8);
    assert.match(v.digest, /^[0-9a-f]{64}$/);
    assert.ok(v.newest > 1_600_000_000);
  }));
test("MOVE_VERIFY_SCRIPT follows links with L and not with P", () =>
  scratch((dir) => {
    const d = tree(dir);
    fs.writeFileSync(path.join(dir, "big"), "x".repeat(1000));
    fs.symlinkSync("../big", path.join(d, "ln"));
    const l = parseMoveVerify(run(d, "L")), p = parseMoveVerify(run(d, "P"));
    assert.deepEqual([l.files, l.bytes], [3, 1008]);
    assert.deepEqual([p.files, p.bytes], [2, 8]);
  }));
test("MOVE_VERIFY_SCRIPT on a link to a file", () =>
  scratch((dir) => {
    fs.writeFileSync(path.join(dir, "big"), "x".repeat(1000));
    fs.symlinkSync("big", path.join(dir, "ln"));
    const v = parseMoveVerify(run(path.join(dir, "ln"), "L"));
    assert.deepEqual([v.files, v.bytes, v.dirs], [1, 1000, 0]);
    assert.match(v.digest, /^[0-9a-f]{64}$/);
  }));
test("MOVE_VERIFY_SCRIPT: same content under another name gives the same digest, one changed byte another", () =>
  scratch((dir) => {
    const d = tree(dir), e = path.join(dir, "e");
    fs.cpSync(d, e, { recursive: true });
    assert.equal(parseMoveVerify(run(d)).digest, parseMoveVerify(run(e)).digest);
    fs.writeFileSync(path.join(e, "a.txt"), "abd");
    const b = parseMoveVerify(run(e));
    assert.notEqual(parseMoveVerify(run(d)).digest, b.digest);
    assert.equal(b.bytes, 8);
  }));
test("MOVE_VERIFY_SCRIPT: a renamed file changes the folder digest", () =>
  scratch((dir) => {
    const d = tree(dir), e = path.join(dir, "e");
    fs.cpSync(d, e, { recursive: true });
    fs.renameSync(path.join(e, "a.txt"), path.join(e, "z.txt"));
    assert.notEqual(parseMoveVerify(run(d)).digest, parseMoveVerify(run(e)).digest);
  }));
test("MOVE_VERIFY_SCRIPT: a file digest is the SHA-256 of its content", () =>
  scratch((dir) => {
    fs.writeFileSync(path.join(dir, "f"), "abc");
    assert.equal(parseMoveVerify(run(path.join(dir, "f"))).digest, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  }));
test("MOVE_VERIFY_SCRIPT: over the hash limit the digest is -", () =>
  scratch((dir) => assert.equal(parseMoveVerify(run(tree(dir), "L", "2")).digest, "-")));
test("MOVE_VERIFY_SCRIPT: no hash tool gives ?", () =>
  scratch((dir) => {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    for (const t of ["sh", "find", "stat", "awk", "sort", "sed", "date", "sleep", "kill", "printf", "echo", "cat"]) {
      const r = spawnSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
      if (r.startsWith("/")) fs.symlinkSync(r, path.join(bin, t));
    }
    assert.equal(parseMoveVerify(run(tree(dir), "L", "1000000000", "590", { PATH: bin })).digest, "?");
  }));
test("MOVE_VERIFY_SCRIPT: a missing path prints -1, a leading dash works", () =>
  scratch((dir) => {
    assert.equal(run(path.join(dir, "nope")), "-1");
    fs.writeFileSync(path.join(dir, "-x"), "abc");
    const r = spawnSync("sh", ["-c", MOVE_VERIFY_SCRIPT, "verify", "-x", "L", "1000", "590"], { encoding: "utf8", cwd: dir }).stdout.trim();
    assert.equal(parseMoveVerify(r).bytes, 3);
  }));
test("MOVE_VERIFY_SCRIPT: the watchdog prints timeout", () =>
  scratch((dir) => {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "find"), "#!/bin/sh\nexec sleep 3\n", { mode: 0o755 });
    const t = Date.now();
    const out = run(tree(dir), "L", "1000000000", "1", { PATH: `${bin}:${process.env.PATH}` });
    assert.equal(out, "timeout");
    assert.equal(parseMoveVerify(out), null);
    assert.ok(Date.now() - t < 2900);
  }));
test("parseMoveVerify: junk, partial and timeout are null", () => {
  for (const s of ["", "-1", "partial", "timeout", "v1 1 0 x 5 -", "3 0 8 1 -"]) assert.equal(parseMoveVerify(s), null);
  assert.deepEqual(parseMoveVerify("v1 2 1 8 1700000000 -\n"), { files: 2, dirs: 1, bytes: 8, newest: 1700000000, digest: "-" });
});
test("verifyArgs: the path at args[3], the limits fit under the exec maximum", () => {
  assert.deepEqual(verifyArgs("/p", "P"), ["-c", MOVE_VERIFY_SCRIPT, "verify", "/p", "P", String(HASH_MAX_BYTES), String(VERIFY_LIMIT_S)]);
  assert.ok(VERIFY_LIMIT_S * 1000 < VERIFY_MS);
});
test("verdict: unknown, changed, mismatch, no hash tool, ok", () => {
  const h = "a".repeat(64), v = (o = {}) => ({ files: 2, dirs: 1, bytes: 8, newest: 5, digest: h, ...o });
  for (const bad of [{ before: null, source: v(), target: v() }, { before: v(), source: null, target: v() }, { before: v(), source: v(), target: null }]) {
    assert.deepEqual(verdict(bad), { kept: KEPT_UNKNOWN });
  }
  assert.deepEqual(verdict({ before: v(), source: v({ newest: 6 }), target: v() }), { kept: KEPT_CHANGED });
  assert.deepEqual(verdict({ before: v(), source: v({ bytes: 9 }), target: v({ bytes: 9 }) }), { kept: KEPT_CHANGED });
  assert.deepEqual(verdict({ before: v(), source: v(), target: v({ files: 1 }) }), { kept: KEPT_MISMATCH });
  assert.deepEqual(verdict({ before: v(), source: v(), target: v({ dirs: 5 }) }), { kept: KEPT_MISMATCH });
  assert.deepEqual(verdict({ before: v(), source: v(), target: v({ bytes: 7 }) }), { kept: KEPT_MISMATCH });
  assert.deepEqual(verdict({ before: v(), source: v(), target: v({ digest: "b".repeat(64) }) }), { kept: KEPT_MISMATCH });
  assert.deepEqual(verdict({ before: v({ digest: "?" }), source: v({ digest: "?" }), target: v() }), { kept: KEPT_NO_HASH });
  assert.deepEqual(verdict({ before: v(), source: v(), target: v({ digest: "?" }) }), { kept: KEPT_NO_HASH });
  assert.deepEqual(verdict({ before: v(), source: v(), target: v({ newest: 99 }) }), { ok: true });
  const big = { bytes: 2_000_000_000, digest: "-" };
  assert.deepEqual(verdict({ before: v(big), source: v(big), target: v(big) }), { ok: true });
  assert.deepEqual(verdict({ before: v(big), source: v(big), target: v({ ...big, bytes: 1 }) }), { kept: KEPT_MISMATCH });
});
