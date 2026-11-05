import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkTmpSync } from "./tmp-helper.js";
import path from "node:path";
import { LINKS_SCRIPT, parseLinks, linkWarning } from "../mods/filer-pro/lib/links.js";

function run(dir, cwd, okStatus = 0) {
  const r = spawnSync("sh", ["-c", LINKS_SCRIPT, "links", dir], { encoding: "utf8", cwd });
  assert.equal(r.status, okStatus, r.stderr);
  return r.stdout;
}

function scratch(fn) {
  const dir = mkTmpSync("fs-links-");
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const byLink = (res) => Object.fromEntries(res.risky.map((r) => [r.link, r]));

test("classifies links in a folder with a space in its name", () =>
  scratch((dir) => {
    const d = path.join(dir, "my folder");
    fs.mkdirSync(path.join(d, "sub"), { recursive: true });
    fs.writeFileSync(path.join(d, "sub", "a.txt"), "x");
    fs.symlinkSync("sub/a.txt", path.join(d, "in"));
    fs.symlinkSync("/usr/share", path.join(d, "out"));
    fs.symlinkSync(".", path.join(d, "self"));
    fs.symlinkSync("..", path.join(d, "up"));
    fs.symlinkSync("nope", path.join(d, "dead"));
    const stdout = run(d);
    assert.match(stdout, /total=3 outside=1 loop=2\n$/);
    const res = parseLinks(stdout);
    assert.equal(res.total, 3);
    const m = byLink(res);
    assert.deepEqual(Object.keys(m).sort(), ["out", "self", "up"]);
    assert.equal(m.out.kind, "outside");
    assert.equal(m.out.target, fs.realpathSync("/usr/share"));
    assert.equal(m.self.kind, "loop");
    assert.equal(m.self.target, fs.realpathSync(d));
    assert.equal(m.up.kind, "loop");
    assert.equal(m.up.target, fs.realpathSync(dir));
  }));

test("nested link: relative path, ancestor loop, sibling inside is harmless", () =>
  scratch((dir) => {
    const d = path.join(dir, "root");
    fs.mkdirSync(path.join(d, "a", "b"), { recursive: true });
    fs.mkdirSync(path.join(d, "c"));
    fs.symlinkSync("../..", path.join(d, "a", "b", "toroot"));
    fs.symlinkSync("..", path.join(d, "a", "b", "toa"));
    fs.symlinkSync("../../c", path.join(d, "a", "b", "toc"));
    const res = parseLinks(run(d));
    assert.equal(res.total, 2);
    const m = byLink(res);
    assert.equal(m["a/b/toroot"].kind, "loop");
    assert.equal(m["a/b/toa"].kind, "loop");
  }));

test("link to a file outside; fast-path chain links are covered by their intermediate link", () =>
  scratch((dir) => {
    const d = path.join(dir, "r");
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(dir, "secret"), "s");
    fs.symlinkSync("../secret", path.join(d, "f"));
    fs.symlinkSync("f", path.join(d, "chain"));
    fs.symlinkSync("/" + path.relative("/", path.join(d, "f")), path.join(d, "abschain"));
    const res = parseLinks(run("r", dir));
    const m = byLink(res);
    assert.equal(m.f.kind, "outside");
    assert.equal(m.f.target, path.join(fs.realpathSync(dir), "secret"));
    assert.equal(m.abschain.kind, "outside"); // slow path resolves the chain
    assert.equal(m.abschain.target, m.f.target);
    assert.equal(m.chain, undefined);
    assert.equal(res.total, 2);
  }));

test("root itself reached through a symlink is resolved", () =>
  scratch((dir) => {
    const real = path.join(dir, "real");
    fs.mkdirSync(real);
    fs.symlinkSync(".", path.join(real, "self"));
    fs.symlinkSync(real, path.join(dir, "via"));
    const res = parseLinks(run(path.join(dir, "via")));
    assert.equal(res.total, 1);
    assert.equal(res.risky[0].kind, "loop");
  }));

test("odd names: quote, glob, newline, leading dash", () =>
  scratch((dir) => {
    const d = path.join(dir, "-d");
    fs.mkdirSync(d);
    const names = ["a b'c [1]*?", 'q"x', "nl\nname", "-x"];
    for (const n of names) fs.symlinkSync("/usr/share", path.join(d, n));
    const res = parseLinks(run("-d", dir));
    assert.equal(res.total, 4);
    assert.deepEqual(res.risky.map((r) => r.link).sort(), [...names].sort());
  }));

test("caps records at 50 but total counts all", () =>
  scratch((dir) => {
    const d = path.join(dir, "many");
    fs.mkdirSync(d);
    for (let i = 0; i < 120; i++) fs.symlinkSync("/usr/share", path.join(d, `l${i}`));
    const res = parseLinks(run(d));
    assert.equal(res.total, 120);
    assert.equal(res.risky.length, 50);
  }));

test("clean folder and missing folder", () =>
  scratch((dir) => {
    fs.mkdirSync(path.join(dir, "ok"));
    fs.writeFileSync(path.join(dir, "ok", "f"), "x");
    assert.deepEqual(parseLinks(run(path.join(dir, "ok"))), { risky: [], total: 0, outside: 0, loop: 0 });
    assert.equal(parseLinks(run(path.join(dir, "missing"), undefined, 1)), null);
  }));

test("per-kind caps: 55 loops and one outside link (example is a loop link, R77)", () =>
  scratch((dir) => {
    const d = path.join(dir, "mix");
    fs.mkdirSync(d);
    for (let i = 1; i <= 55; i++) fs.symlinkSync(".", path.join(d, `l${String(i).padStart(2, "0")}`));
    fs.symlinkSync("/usr/share", path.join(d, "zz"));
    const res = parseLinks(run(d));
    assert.equal(res.outside, 1);
    assert.equal(res.loop, 55);
    assert.equal(res.total, 56);
    assert.equal(res.risky.filter((r) => r.kind === "outside").length, 1);
    assert.equal(res.risky.filter((r) => r.kind === "loop").length, 50);
    const w = linkWarning(res, "mix");
    assert.equal(w.blocked, true);
    assert.match(w.text, /^"mix" contains 55 symlinks looping back into it \(e\.g\. l\d\d → /);
    assert.ok(!w.text.includes("zz"));
  }));

test("parseLinks rejects malformed output", () => {
  assert.equal(parseLinks(""), null);
  assert.equal(parseLinks("garbage"), null);
  assert.equal(parseLinks("outside\0a\0total=1 outside=1 loop=0\n"), null);
  assert.equal(parseLinks("weird\0a\0/b\0total=1 outside=1 loop=0\n"), null);
  assert.equal(parseLinks("outside\0a\0/b\0"), null);
  assert.equal(parseLinks("total=x\n"), null);
  assert.equal(parseLinks("total=1\n"), null);
  assert.equal(parseLinks("total=2 outside=1 loop=0\n"), null);
  assert.equal(parseLinks("loop\0a\0/b\0total=1 outside=1 loop=0\n"), null);
  assert.deepEqual(parseLinks("total=0 outside=0 loop=0\n"), { risky: [], total: 0, outside: 0, loop: 0 });
  assert.deepEqual(parseLinks("loop\0a\0/b\0total=4 outside=0 loop=4\n"), {
    risky: [{ kind: "loop", link: "a", target: "/b" }],
    total: 4,
    outside: 0,
    loop: 4,
  });
});

const O = { kind: "outside", link: "ext", target: "/r/o" };
const L = { kind: "loop", link: "self", target: "/r/links" };

test("linkWarning", () => {
  const T = "Symlink found!";
  const OUT = "scp copies what they point to.";
  const BLOCK = "scp cannot transfer a folder with a symlink loop.";
  const cases = [
    [{ risky: [O], total: 1, outside: 1, loop: 0 }, "x", false, '"x" contains 1 symlink pointing outside it (e.g. ext → /r/o). scp copies what it points to.'],
    [{ risky: [{ kind: "outside", link: "data", target: "/mnt/archive" }, O], total: 2, outside: 2, loop: 0 }, "data-dir", false,
      `"data-dir" contains 2 symlinks pointing outside it (e.g. data → /mnt/archive). ${OUT}`],
    [{ risky: [L], total: 1, outside: 0, loop: 1 }, "links", true, `"links" contains 1 symlink looping back into it (e.g. self → /r/links). ${BLOCK}`],
    [{ risky: [L, L], total: 2, outside: 0, loop: 2 }, "links", true, `"links" contains 2 symlinks looping back into it (e.g. self → /r/links). ${BLOCK}`],
    [{ risky: [O, L], total: 2, outside: 1, loop: 1 }, "links", true, `"links" contains 1 symlink looping back into it (e.g. self → /r/links). ${BLOCK}`],
    [{ risky: [L, L, O, O, O], total: 5, outside: 3, loop: 2 }, "x", true, `"x" contains 2 symlinks looping back into it (e.g. self → /r/links). ${BLOCK}`],
  ];
  for (const [res, name, blocked, text] of cases) assert.deepEqual(linkWarning(res, name), { title: T, text, blocked });
  assert.equal(linkWarning({ risky: [], total: 0, outside: 0, loop: 0 }, "x"), null);
  assert.deepEqual(linkWarning(null, "x"), {
    title: "Could not check symlinks",
    text: 'Could not check "x" for symlinks. If it has any, scp copies what they point to.',
    blocked: false,
  });
});

test("mutual directory cycle is flagged", () =>
  scratch((dir) => {
    const d = path.join(dir, "r");
    fs.mkdirSync(path.join(d, "a"), { recursive: true });
    fs.mkdirSync(path.join(d, "b"));
    fs.symlinkSync("../b", path.join(d, "a", "l1"));
    fs.symlinkSync("../a", path.join(d, "b", "l2"));
    const res = parseLinks(run(d));
    assert.equal(res.total, 2);
    assert.ok(res.risky.every((r) => r.kind === "loop"));
    assert.notEqual(linkWarning(res, "r"), null);
  }));

test("three-link directory cycle is flagged", () =>
  scratch((dir) => {
    const d = path.join(dir, "r");
    for (const n of ["a", "b", "c"]) fs.mkdirSync(path.join(d, n), { recursive: true });
    fs.symlinkSync("../b", path.join(d, "a", "x"));
    fs.symlinkSync("../c", path.join(d, "b", "y"));
    fs.symlinkSync("../a", path.join(d, "c", "z"));
    const res = parseLinks(run(d));
    assert.equal(res.total, 3);
    assert.notEqual(linkWarning(res, "r"), null);
  }));

test("harmless directory links stay unflagged (fast path and dotted path)", () =>
  scratch((dir) => {
    const d = path.join(dir, "r");
    fs.mkdirSync(path.join(d, "sub", "deep"), { recursive: true });
    fs.mkdirSync(path.join(d, "other"));
    fs.symlinkSync("sub", path.join(d, "fast"));
    fs.symlinkSync("./other", path.join(d, "dotted"));
    assert.deepEqual(parseLinks(run(d)), { risky: [], total: 0, outside: 0, loop: 0 });
  }));

test("fast-path directory link that contains another directory link is flagged", () =>
  scratch((dir) => {
    const d = path.join(dir, "r");
    fs.mkdirSync(path.join(d, "sub"), { recursive: true });
    fs.symlinkSync("sub", path.join(d, "x"));
    fs.symlinkSync("..", path.join(d, "sub", "back"));
    const res = parseLinks(run(d));
    assert.ok(res.total >= 1);
    assert.ok(res.risky.some((r) => r.link === "x" && r.kind === "loop"));
  }));

test("many harmless links produce no findings", () =>
  scratch((dir) => {
    const d = path.join(dir, "r");
    fs.mkdirSync(path.join(d, "sub"), { recursive: true });
    fs.writeFileSync(path.join(d, "sub", "a.txt"), "x");
    for (let i = 0; i < 3000; i++) fs.symlinkSync("sub/a.txt", path.join(d, `l${i}`));
    assert.deepEqual(parseLinks(run(d)), { risky: [], total: 0, outside: 0, loop: 0 });
  }));

test("link text containing a newline falls back to per-link readlink", () =>
  scratch((dir) => {
    const d = path.join(dir, "r");
    fs.mkdirSync(path.join(d, "t\nx"), { recursive: true });
    fs.symlinkSync("t\nx", path.join(d, "nl"));
    fs.symlinkSync("/usr/share", path.join(d, "out"));
    fs.symlinkSync("..", path.join(d, "up"));
    const res = parseLinks(run(d));
    assert.equal(res.total, 2);
    assert.deepEqual(res.risky.map((r) => r.link).sort(), ["out", "up"]);
  }));
