// #49: a folder without read or search permission is not "empty", and a file below a folder that cannot be searched is not
// "no longer available". Real files with chmod 000 and read-without-search, locally and through the fake ssh (a shell).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkTmpSync } from "./tmp-helper.js";
import { LIST_SCRIPT, LIST_DENIED, NO_LIST_MESSAGE, folderMissing, visibleRows } from "../mods/filer-pro/lib/tree.js";
import { READ_SCRIPT, PROBE_SCRIPT, VERIFY_SCRIPT, parseRead, parseProbe, parseVerify, checkEditable } from "../mods/filer-pro/lib/textedit.js";
import { readResult, NO_SEARCH_MESSAGE, GONE_MESSAGE } from "../mods/filer-pro/lib/readfile.js";

const FAKE_SSH = path.resolve(import.meta.dirname, "fake", "ssh");
const root = process.getuid?.() === 0 ? null : mkTmpSync("filer-pro-noperm-");
const opts = { skip: root === null && "root ignores permission bits" };
const q = (s) => `'${s.replaceAll("'", "'\\''")}'`;

// Runs a script locally ("local") or through the fake ssh ("remote", the way herdr runs a command on a machine).
function run(where, script, name, ...args) {
  if (where === "local") return spawnSync("sh", ["-c", script, name, ...args], { encoding: "utf8" });
  return spawnSync(FAKE_SSH, ["box", ["sh", "-c", q(script), name, ...args.map(q)].join(" ")], { encoding: "utf8" });
}

// none/ (chmod 000), noexec/ (r--, no search), noread/ (--x, no listing), ok/; each holds f.txt (where its mode allows).
const dirs = {};
if (root) {
  for (const [name, mode] of [["none", 0], ["noexec", 0o444], ["noread", 0o111], ["ok", 0o755]]) {
    const d = path.join(root, name);
    fs.mkdirSync(path.join(d, "sub"), { recursive: true });
    fs.writeFileSync(path.join(d, "f.txt"), "hello\n");
    dirs[name] = d;
  }
  for (const [name, mode] of [["none", 0], ["noexec", 0o444], ["noread", 0o111]]) fs.chmodSync(dirs[name], mode);
  // The shared cleanup (tmp-helper) runs before an after() hook of this file: the last test restores the modes.
}

for (const where of ["local", "remote"]) {
  test(`${where}: LIST_SCRIPT answers exit ${LIST_DENIED} for chmod 000, read without search and search without read`, opts, () => {
    for (const name of ["none", "noexec", "noread"]) {
      const r = run(where, LIST_SCRIPT, "files", dirs[name], "100", "0", "0");
      assert.equal(r.status, LIST_DENIED, name);
      assert.equal(r.stdout, "", name);
      assert.equal(folderMissing({ code: r.status, stdout: r.stdout, stderr: r.stderr }), false, `${name} is not a vanished folder`);
    }
  });

  test(`${where}: LIST_SCRIPT still lists a normal folder, an empty one, and reports a vanished one as missing`, opts, () => {
    const ok = run(where, LIST_SCRIPT, "files", dirs.ok, "100", "0", "0");
    assert.equal(ok.status, 0);
    assert.deepEqual(ok.stdout.split("\0").filter(Boolean).sort(), ["d", "f", "f.txt", "sub"]);
    const empty = run(where, LIST_SCRIPT, "files", path.join(dirs.ok, "sub"), "100", "0", "0");
    assert.equal(empty.status, 0);
    assert.equal(empty.stdout, "");
    const gone = run(where, LIST_SCRIPT, "files", path.join(dirs.ok, "gone"), "100", "0", "0");
    assert.equal(folderMissing({ code: gone.status, stdout: gone.stdout, stderr: gone.stderr }), true);
  });

  test(`${where}: READ_SCRIPT says noaccess for a file below an unsearchable folder, missing only when it can be searched`, opts, () => {
    for (const name of ["none", "noexec"]) {
      const f = path.join(dirs[name], "f.txt");
      assert.equal(run(where, READ_SCRIPT, "read", f).stdout, "noaccess\n", name);
      // The file's folder is gone below a folder that cannot be searched: still no claim that it is gone.
      assert.equal(run(where, READ_SCRIPT, "read", path.join(dirs[name], "x", "y.txt")).stdout, "noaccess\n", `${name} deeper`);
    }
    assert.equal(run(where, READ_SCRIPT, "read", path.join(dirs.ok, "gone.txt")).stdout, "missing\n");
    assert.equal(run(where, READ_SCRIPT, "read", path.join(dirs.ok, "gone", "deeper.txt")).stdout, "missing\n", "folder deleted, parents searchable");
    assert.equal(run(where, READ_SCRIPT, "read", path.join(dirs.noread, "gone.txt")).stdout, "missing\n", "search without read: absence is certain");
    assert.match(run(where, READ_SCRIPT, "read", path.join(dirs.noread, "f.txt")).stdout, /^file /, "search without read still opens a known file");
  });

  test(`${where}: PROBE_SCRIPT and VERIFY_SCRIPT agree`, opts, () => {
    const f = path.join(dirs.none, "f.txt");
    assert.equal(run(where, PROBE_SCRIPT, "probe", f).stdout, "noaccess\n");
    assert.equal(run(where, VERIFY_SCRIPT, "verify", f).stdout, "noaccess\n");
    assert.equal(run(where, PROBE_SCRIPT, "probe", path.join(dirs.ok, "gone.txt")).stdout, "missing\n");
    assert.equal(run(where, VERIFY_SCRIPT, "verify", path.join(dirs.ok, "gone.txt")).stdout, "missing\n");
  });
}

// Local listings pass a fifth argument "1": the first record is P and the folder's real path (issue #42). A denied folder
// must still end with exit 3 and must not print anything else; a symlinked folder reports its target.
test("LIST_SCRIPT with the local fifth argument: denied folders exit 3 with only the P record, a symlink gives its target", opts, () => {
  for (const name of ["none", "noexec", "noread"]) {
    const r = run("local", LIST_SCRIPT, "files", dirs[name], "100", "0", "0", "1");
    assert.equal(r.status, LIST_DENIED, name);
    const rec = r.stdout.split("\0");
    assert.equal(rec[0], "P", `${name}: the P record comes first`);
    assert.equal(rec.slice(2).filter(Boolean).length, 0, `${name}: no entries after it`);
    assert.equal(rec[1], name === "noread" ? fs.realpathSync.native(dirs[name]) : "", `${name}: real path`);
    assert.equal(folderMissing({ code: r.status, stdout: r.stdout, stderr: r.stderr }), false, `${name} is not a vanished folder`);
  }
  const ok = run("local", LIST_SCRIPT, "files", dirs.ok, "100", "0", "0", "1");
  assert.equal(ok.status, 0);
  assert.deepEqual(ok.stdout.split("\0").slice(0, 2), ["P", fs.realpathSync.native(dirs.ok)]);
  const link = path.join(dirs.ok, "link-to-sub");
  fs.symlinkSync(path.join(dirs.ok, "sub"), link);
  try {
    const l = run("local", LIST_SCRIPT, "files", link, "100", "0", "0", "1");
    assert.equal(l.status, 0);
    assert.deepEqual(l.stdout.split("\0").slice(0, 2), ["P", fs.realpathSync.native(path.join(dirs.ok, "sub"))], "P gives the target");
  } finally { fs.unlinkSync(link); }
});

test("readResult: a file below an unsearchable folder gets a permission reason, a deleted one stays 'no longer available'", () => {
  const denied = readResult({ code: 0, stdout: "noaccess\n", stderr: "" });
  assert.deepEqual(denied, { ok: false, message: NO_SEARCH_MESSAGE, binary: false });
  assert.match(NO_SEARCH_MESSAGE, /permission/i);
  assert.notEqual(NO_SEARCH_MESSAGE, GONE_MESSAGE);
  assert.equal(readResult({ code: 0, stdout: "missing\n", stderr: "" }).message, GONE_MESSAGE);
});

test("parsers and the edit check know noaccess", () => {
  assert.equal(parseRead("noaccess\n").kind, "noaccess");
  assert.equal(parseProbe("noaccess\n").kind, "noaccess");
  assert.deepEqual(parseVerify("noaccess\n"), { kind: "noaccess" });
  assert.equal(checkEditable({ kind: "noaccess" }).ok, false);
});

test("visibleRows: a folder whose list is denied shows one note row below it, an empty one shows none", () => {
  const denied = Object.assign([], { denied: true });
  const entries = new Map([["", [{ name: "locked", dir: true }, { name: "empty", dir: true }]], ["locked", denied], ["empty", []]]);
  const rows = visibleRows(entries, new Set(["locked", "empty"]));
  assert.deepEqual(rows.map((r) => r.entry.name), ["locked", NO_LIST_MESSAGE, "empty"]);
  assert.equal(rows[1].entry.note, true);
  assert.equal(rows[1].depth, 1);
  assert.equal(NO_LIST_MESSAGE, "No permission to list this folder");
});

test("restore the modes so the scratch folder can be removed", opts, () => {
  for (const d of Object.values(dirs)) fs.chmodSync(d, 0o755);
});
