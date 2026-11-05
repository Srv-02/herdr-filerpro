import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkTmpSync } from "./tmp-helper.js";
import path from "node:path";
import { SIZE_SCRIPT, parseSize, formatBytes, formatRate } from "../mods/filer-pro/lib/sizes.js";

function size(p, cwd) {
  const r = spawnSync("sh", ["-c", SIZE_SCRIPT, "size", p], { encoding: "utf8", cwd });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function scratch(fn) {
  const dir = mkTmpSync("fs-size-");
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("SIZE_SCRIPT sums regular files in a folder with a space in its name", () =>
  scratch((dir) => {
    const d = path.join(dir, "my folder");
    fs.mkdirSync(path.join(d, "sub dir"), { recursive: true });
    fs.writeFileSync(path.join(d, "a.txt"), "abc");
    fs.writeFileSync(path.join(d, "sub dir", "b'\"\n.txt"), "12345");
    assert.equal(size(d), "8");
  }));

test("SIZE_SCRIPT does not follow symlinks", () =>
  scratch((dir) => {
    const d = path.join(dir, "f");
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, "a"), "abc");
    fs.writeFileSync(path.join(dir, "big"), "x".repeat(1000));
    fs.symlinkSync(path.join(dir, "big"), path.join(d, "ln"));
    fs.symlinkSync(".", path.join(d, "self"));
    assert.equal(size(d), "3");
  }));

test("SIZE_SCRIPT on a single file and an empty folder", () =>
  scratch((dir) => {
    fs.writeFileSync(path.join(dir, "one"), "1234567");
    fs.mkdirSync(path.join(dir, "empty"));
    assert.equal(size(path.join(dir, "one")), "7");
    assert.equal(size(path.join(dir, "empty")), "0");
  }));

test("SIZE_SCRIPT handles a leading dash", () =>
  scratch((dir) => {
    fs.mkdirSync(path.join(dir, "-d"));
    fs.writeFileSync(path.join(dir, "-d", "x"), "12");
    assert.equal(size("-d", dir), "2");
  }));

test("SIZE_SCRIPT prints -1 for a missing path", () =>
  scratch((dir) => {
    assert.equal(size(path.join(dir, "nope")), "-1");
  }));

test("parseSize", () => {
  assert.equal(parseSize("8\n"), 8);
  assert.equal(parseSize("0\n"), 0);
  assert.equal(parseSize("-1\n"), null);
  assert.equal(parseSize(""), null);
  assert.equal(parseSize("abc"), null);
  assert.equal(parseSize("12 junk"), null);
});

test("formatBytes", () => {
  assert.equal(formatBytes(412_000_000), "412 MB");
  assert.equal(formatBytes(1_200_000_000), "1.2 GB");
  assert.equal(formatBytes(999), "999 B");
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1000), "1.0 kB");
  assert.equal(formatBytes(9_960), "10 kB");
  assert.equal(formatBytes(999_600), "1.0 MB");
  assert.equal(formatBytes(-5), "0 B");
  assert.equal(formatBytes(NaN), "0 B");
  assert.equal(formatBytes(5e15), "5000 TB");
});

test("formatRate", () => {
  assert.equal(formatRate(24_000_000), "24 MB/s");
  assert.equal(formatRate(-1), "0 B/s");
});

test("SIZE_SCRIPT follows a symlinked source path itself", () =>
  scratch((dir) => {
    fs.mkdirSync(path.join(dir, "real"));
    fs.writeFileSync(path.join(dir, "real", "a"), "abcd");
    fs.writeFileSync(path.join(dir, "file"), "123456");
    fs.symlinkSync("real", path.join(dir, "dirlink"));
    fs.symlinkSync("file", path.join(dir, "filelink"));
    assert.equal(size(path.join(dir, "dirlink")), "4");
    assert.equal(size(path.join(dir, "filelink")), "6");
  }));
