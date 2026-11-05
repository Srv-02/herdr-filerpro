import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkTmp } from "./tmp-helper.js";
import { keepBothName, tempName, joinPath, parentOf, baseName, relativePath, shellPath, psQuoted, stemEnd } from "../mods/filer-pro/lib/names.js";

test("keepBothName", () => {
  assert.equal(keepBothName("a.tar.gz", new Set()), "a.tar.gz");
  assert.equal(keepBothName("a.tar.gz", new Set(["a.tar.gz"])), "a-1.tar.gz");
  assert.equal(keepBothName("a.tar.gz", new Set(["a.tar.gz", "a-1.tar.gz"])), "a-2.tar.gz");
  assert.equal(keepBothName(".env", new Set([".env"])), ".env-1");
  assert.equal(keepBothName("dir", new Set(["dir"])), "dir-1");
  assert.equal(keepBothName("x.", new Set(["x."])), "x.-1");
});

test("tempName", () => {
  assert.equal(tempName("a b.txt", "k3"), ".a b.txt.fs-k3.part");
});

test("path helpers", () => {
  assert.equal(parentOf("/r/x/y.md"), "/r/x");
  assert.equal(parentOf("/a"), "/");
  assert.equal(baseName("/r/x/"), "x");
  assert.equal(baseName("/"), "");
  assert.equal(joinPath("/r/", "a"), "/r/a");
  assert.equal(joinPath("/", "a"), "/a");
  assert.equal(joinPath("/r", "a"), "/r/a");
});

test("stemEnd selects the stem before the last extension", () => {
  assert.equal(stemEnd("report.pdf", false), 6);
  assert.equal(stemEnd("a.tar.gz", false), 5);
  assert.equal(stemEnd(".env", false), 4);
  assert.equal(stemEnd("noext", false), 5);
  assert.equal(stemEnd("dir.v2", true), 6);
});

test("keepBothName with a key compares names by that key, also for the candidates (#33)", () => {
  const key = (n) => n.normalize("NFC").toLowerCase();
  const taken = (...names) => new Set(names.map(key));
  assert.equal(keepBothName("A.TXT", taken("a.txt"), key), "A-1.TXT");
  assert.equal(keepBothName("A.TXT", taken("a.txt", "a-1.txt"), key), "A-2.TXT");
  assert.equal(keepBothName("B.TXT", taken("a.txt"), key), "B.TXT");
  assert.equal(keepBothName("Ü.txt", taken("ü.txt"), key), "Ü-1.txt"); // NFD against NFC
  assert.equal(keepBothName("A.TXT", new Set(["a.txt"])), "A.TXT"); // without a key: exact as before
});

test("relativePath: below the root, trailing slashes, root /, the root itself, outside the root, no root", () => {
  assert.equal(relativePath("/srv", "/srv/data/a.txt"), "data/a.txt");
  assert.equal(relativePath("/srv/", "/srv/data/a.txt"), "data/a.txt");
  assert.equal(relativePath("/srv//", "/srv/data/"), "data");
  assert.equal(relativePath("/", "/srv/a"), "srv/a");
  assert.equal(relativePath("/srv", "/srv"), ".");
  assert.equal(relativePath("/srv/", "/srv"), ".");
  assert.equal(relativePath("/a", "/ab/c"), "/ab/c");
  assert.equal(relativePath("/srv", "/other/a"), "/other/a");
  assert.equal(relativePath("/Users/me/Proj", "/users/me/proj/x"), "/users/me/proj/x"); // exact comparison
  assert.equal(relativePath("", "/srv/a"), "/srv/a");
  assert.equal(relativePath(null, "/srv/a"), "/srv/a");
  assert.equal(relativePath(undefined, "/srv/a"), "/srv/a");
});

const SHELL_CASES = [
  "/Users/me/Cloud Drive/Dokumente Max/Führerschein.pdf",
  "/Users/me/Dokumente/Führerschein.pdf",
  "/Users/me/Dokumente/Fu\u0308hrerschein.pdf", // NFD
  "/srv/it's here.txt",
  "/srv/'",
  "/srv/a$HOME.txt",
  "/srv/$(id).txt",
  "/srv/*.txt",
  "/srv/a\tb.txt",
  "/srv/a\nb.txt",
  "/srv/a\\b",
  "/srv/!x",
  "/srv/~me",
  "/srv/a;b",
  "/srv/a\"b",
  "/srv/a`id`",
  "/srv/{a,b}",
  "/srv/[ab]",
  "-rf",
  "-a b",
  "=ls",
  "data/a.txt",
  ".",
  "",
];

test("shellPath leaves safe paths raw, also with umlauts in NFC and NFD", () => {
  assert.equal(shellPath("/Users/me/Dokumente/Führerschein.pdf"), "/Users/me/Dokumente/Führerschein.pdf");
  assert.equal(shellPath("/Users/me/Dokumente/Fu\u0308hrerschein.pdf"), "/Users/me/Dokumente/Fu\u0308hrerschein.pdf");
  assert.equal(shellPath("/srv/a_b-c+d,e:f@g%h=i.tar.gz"), "/srv/a_b-c+d,e:f@g%h=i.tar.gz");
  assert.equal(shellPath("data/a.txt"), "data/a.txt");
  assert.equal(shellPath("."), ".");
  assert.equal(shellPath("/"), "/");
});

test("shellPath quotes paths with other characters in single quotes, a quote inside as '\\''", () => {
  assert.equal(shellPath("/Users/me/Cloud Drive/Dokumente Max/Führerschein.pdf"), "'/Users/me/Cloud Drive/Dokumente Max/Führerschein.pdf'");
  assert.equal(shellPath("/srv/it's here.txt"), "'/srv/it'\\''s here.txt'");
  assert.equal(shellPath("/srv/a$HOME.txt"), "'/srv/a$HOME.txt'");
  assert.equal(shellPath("/srv/*.txt"), "'/srv/*.txt'");
  assert.equal(shellPath("/srv/a\tb.txt"), "'/srv/a\tb.txt'");
  assert.equal(shellPath("/srv/a\nb.txt"), "'/srv/a\nb.txt'");
  assert.equal(shellPath("=ls"), "'=ls'");
  assert.equal(shellPath(""), "''");
  for (const p of SHELL_CASES) assert.equal(shellPath(p).endsWith("\n"), false, p);
});

test("shellPath puts ./ before a relative path starting with -, an absolute path stays", () => {
  assert.equal(shellPath("-rf"), "./-rf");
  assert.equal(shellPath("-a b"), "'./-a b'");
  assert.equal(shellPath("/-rf"), "/-rf");
});

// Reads every quoted path back through a real shell: a script file below tmp/ prints each word with
// printf '%s\0', so each case must come back as exactly one word equal to the input (the ./ prefix aside).
for (const shell of ["/bin/sh", "/bin/zsh", "/bin/bash"]) {
  test(`shellPath round trip through ${shell}`, { skip: !existsSync(shell) && `${shell} missing` }, async () => {
    const dir = await mkTmp("shellpath-");
    const script = `${dir}/words.sh`;
    await fs.writeFile(script, SHELL_CASES.map((p) => `printf '%s\\0' ${shellPath(p)}\n`).join(""));
    const out = await new Promise((resolve, reject) => execFile(shell, [script], { cwd: dir, encoding: "utf8" }, (err, stdout) => (err ? reject(err) : resolve(stdout))));
    const expected = SHELL_CASES.map((p) => (!p.startsWith("/") && p.startsWith("-") ? `./${p}` : p));
    assert.deepEqual(out.split("\0").slice(0, -1), expected);
  });
}

test("psQuoted doubles every quote PowerShell reads as a single quote", () => {
  assert.equal(psQuoted("a'b"), "a''b");
  assert.equal(psQuoted("a\u2018b"), "a\u2018\u2018b");
  assert.equal(psQuoted("a\u2019b"), "a\u2019\u2019b");
  assert.equal(psQuoted("a\u201Ab"), "a\u201A\u201Ab");
  assert.equal(psQuoted("a\u201Bb"), "a\u201B\u201Bb");
  assert.equal(psQuoted("C:\\Users\\me\\Projekte \u00dcbersicht\\a\"b"), "C:\\Users\\me\\Projekte \u00dcbersicht\\a\"b");
  assert.equal(psQuoted("a\u2019; New-Item PWNED; \u2019b"), "a\u2019\u2019; New-Item PWNED; \u2019\u2019b");
});
