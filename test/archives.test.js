import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {
  ARCHIVE_TYPES, archiveOf, extractToLabel, ARCHIVE_PROBE_SCRIPT, ARCHIVE_SIZE_SCRIPT, EXTRACT_STOP_SCRIPT,
  parseProbe, parseSize, unescapeName, checkMembers, spaceError, missingTool,
  memberCheck, checkListing, tooManyMembers, ARCHIVE_MAX_MEMBERS, CHECK_SLICE, CHECK_INTERRUPTED,
} from "../mods/filer-pro/lib/archives.js";
import { tarBuffer, zipBuffer } from "./archive-craft.js";
import { mkTmpSync } from "./tmp-helper.js";

// ---- pure ----

test("archiveOf: every suffix, longest first, case-insensitive, stem without the suffix", () => {
  const table = [
    ["a.tar.gz", "tar", "gzip", "a"], ["a.tgz", "tar", "gzip", "a"], ["a.tar.bz2", "tar", "bzip2", "a"], ["a.tbz2", "tar", "bzip2", "a"],
    ["a.tar.xz", "tar", "xz", "a"], ["a.txz", "tar", "xz", "a"], ["a.tar.zst", "tar", "zstd", "a"], ["a.tar", "tar", "-", "a"],
    ["a.zip", "zip", "-", "a"], ["a.gz", "single", "gzip", "a"], ["a.bz2", "single", "bzip2", "a"], ["a.xz", "single", "xz", "a"], ["a.zst", "single", "zstd", "a"],
    ["log.txt.gz", "single", "gzip", "log.txt"], ["My Photos.TAR.GZ", "tar", "gzip", "My Photos"], ["x.tar.gz", "tar", "gzip", "x"], ["a.b.zip", "zip", "-", "a.b"],
  ];
  for (const [name, family, need, stem] of table) {
    const a = archiveOf(name);
    assert.deepEqual([a?.family, a?.need, a?.stem], [family, need, stem], name);
  }
  assert.equal(archiveOf("My Photos.TAR.GZ").ext, ".TAR.GZ");
  assert.equal(ARCHIVE_TYPES.length, 13);
});
test("archiveOf: no archive for plain names, a bare suffix, 7z and rar", () => {
  for (const n of [".gz", ".tar.gz", ".zip", "..zip", "a.txt", "a.gzip", "a.7z", "a.rar", "zip", "", "a.tar.gz.bak"]) assert.equal(archiveOf(n), null, n);
  assert.equal(archiveOf(undefined), null);
});
test("extractToLabel: short, exactly 10, long, wide chars, emoji are not split", () => {
  assert.equal(extractToLabel("photos"), 'Extract to "photos/"');
  assert.equal(extractToLabel("0123456789"), 'Extract to "0123456789/"');
  assert.equal(extractToLabel("0123456789a"), 'Extract to "012345678…/"');
});
test("extractToLabel: width counts CJK and astral characters as two units", () => {
  assert.equal(extractToLabel("日本語日本"), 'Extract to "日本語日本/"'); // exactly 10 units
  assert.equal(extractToLabel("日本語日本語"), 'Extract to "日本語日…/"'); // 8 units + the ellipsis
  assert.equal(extractToLabel("😀😀😀😀😀😀"), 'Extract to "😀😀😀😀…/"');
  assert.equal(extractToLabel("ab😀😀😀😀😀"), 'Extract to "ab😀😀😀…/"');
});

test("parseProbe: tool, member list, directories keep their slash", () => {
  assert.deepEqual(parseProbe("tool=tar\n--\na/\na/b.txt\nc.txt\n"), { tool: "tar", names: ["a/", "a/b.txt", "c.txt"] });
  assert.deepEqual(parseProbe("tool=gzip\n--\n"), { tool: "gzip", names: [] });
  assert.deepEqual(parseProbe(""), { tool: null, names: [] });
});
test("parseProbe: tar escapes are decoded (backslash, newline, octal UTF-8), unzip names are left alone", () => {
  assert.deepEqual(parseProbe("tool=tar\n--\na\\nb.txt\nc\\\\d\n\\303\\251.txt\ne\\314\\201.txt\n").names, ["a\nb.txt", "c\\d", "é.txt", "e\u0301.txt"]);
  assert.deepEqual(parseProbe("tool=bsdtar\n--\n\\360\\237\\230\\200.txt\n").names, ["😀.txt"]);
  assert.deepEqual(parseProbe("tool=unzip\n--\na\\nb.txt\n").names, ["a\\nb.txt"]);
});
test("unescapeName: invalid UTF-8 keeps the printed text; raw non-ASCII passes through", () => {
  assert.equal(unescapeName("\\377bad"), "\\377bad");
  assert.equal(unescapeName("plain é.txt"), "plain é.txt");
  assert.equal(unescapeName("é\\n😀"), "é\n😀");
  assert.equal(unescapeName("trail\\"), "trail\\");
  assert.equal(unescapeName("\\303"), "\\303"); // truncated sequence
});
test("parseSize: size and the free bytes from the last df line, also with spaces in the file system name", () => {
  const df = "df=Filesystem 1024-blocks Used Available Capacity Mounted on\ndf=/dev/disk3s5 488245288 400000000 53821440 89% /System/Volumes/Data\n";
  assert.deepEqual(parseSize(`size=1234\n${df}`), { size: 1234, avail: 53821440 * 1024 });
  assert.deepEqual(parseSize("size=\ndf=Filesystem 1024-blocks Used Available Capacity Mounted on\ndf=map auto_home 0 0 0 100% /System/Volumes/Data/home\n"), { size: null, avail: 0 });
  assert.deepEqual(parseSize("size=0\n"), { size: 0, avail: null });
  assert.deepEqual(parseSize(""), { size: null, avail: null });
  assert.deepEqual(parseSize("size=12x\n"), { size: null, avail: null });
});

test("checkMembers: refuses absolute names, '..' components and writing through a link", () => {
  assert.match(checkMembers(["../escape.txt"]).error, /^The archive contains a path with "\.\.": \.\.\/escape\.txt$/);
  assert.match(checkMembers(["a/../../x"]).error, /path with "\.\."/);
  assert.match(checkMembers(["a/b/.."]).error, /path with "\.\."/);
  assert.match(checkMembers(["/abs.txt"]).error, /^The archive contains an absolute path: \/abs\.txt$/);
  assert.match(checkMembers(["l", "l/pwned.txt"]).error, /^The archive writes through a link: l\/pwned\.txt$/);
  assert.match(checkMembers(["a/l", "a/l/b/c"]).error, /writes through a link/);
  assert.match(checkMembers(["L", "l/x"]).error, /writes through a link/, "compared with nameKey");
  assert.equal(checkMembers([]).error, "The archive is empty");
  assert.equal(checkMembers(["", ".", "./"]).error, "The archive is empty");
});
test("checkMembers: zip treats a backslash as a separator and refuses a drive letter", () => {
  assert.match(checkMembers(["..\\x.txt"], { zip: true }).error, /path with "\.\."/);
  assert.match(checkMembers(["C:\\x.txt"], { zip: true }).error, /absolute path/);
  assert.match(checkMembers(["\\abs"], { zip: true }).error, /absolute path/);
  assert.deepEqual(checkMembers(["a\\b.txt"], { zip: true }).tops, [{ name: "a", isDir: true }]);
  assert.deepEqual(checkMembers(["a\\b.txt"]).tops, [{ name: "a\\b.txt", isDir: false }], "a tar name keeps its backslash");
});
test("checkMembers: tops are the first components, leading ./ stripped, folders recognised, deduplicated by nameKey", () => {
  assert.deepEqual(checkMembers(["./a/b", "./a/", "./c.txt", "./"]).tops, [{ name: "a", isDir: true }, { name: "c.txt", isDir: false }]);
  assert.deepEqual(checkMembers(["d/", "d/x"]).tops, [{ name: "d", isDir: true }]);
  assert.deepEqual(checkMembers(["a//b", "./././c"]).tops, [{ name: "a", isDir: true }, { name: "c", isDir: false }]);
  assert.deepEqual(checkMembers(["Foo.txt", "foo.TXT", "e\u0301/", "\u00e9/x"]).tops, [{ name: "Foo.txt", isDir: false }, { name: "e\u0301", isDir: true }]);
  assert.deepEqual(checkMembers(["empty/"]).tops, [{ name: "empty", isDir: true }]);
  assert.ok(checkMembers(["a..b", "..a", "a/..b"]).tops, "dots inside a name are fine");
});

test("spaceError: needs more than free -> message with formatBytes, otherwise or unknown null", () => {
  assert.equal(spaceError(4_200_000_000, 1_100_000_000), "Not enough space: 4.2 GB needed, 1.1 GB free");
  assert.equal(spaceError(100, 100), null);
  assert.equal(spaceError(100, 200), null);
  assert.equal(spaceError(null, 200), null);
  assert.equal(spaceError(100, null), null);
  assert.equal(spaceError(1, 0), "Not enough space: 1 B needed, 0 B free");
});
test("missingTool: names the machine, this computer when none", () => {
  assert.equal(missingTool("zstd", null), "zstd is not installed on this computer");
  assert.equal(missingTool("xz", undefined), "xz is not installed on this computer");
  assert.equal(missingTool("xz", "box"), "xz is not installed on box");
});
test("EXTRACT_STOP_SCRIPT is valid sh and ARCHIVE scripts pass sh -n", () => {
  for (const s of [ARCHIVE_PROBE_SCRIPT, ARCHIVE_SIZE_SCRIPT, EXTRACT_STOP_SCRIPT]) {
    const r = spawnSync("sh", ["-n", "-c", s], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
});

// ---- real runs ----

const dir = mkTmpSync("archives-");
let n = 0;
const put = (name, buf) => { const p = path.join(dir, `${name}`); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); return p; };
const run = (script, args, opts = {}) => spawnSync("sh", ["-c", script, "x", ...args], { encoding: "utf8", ...opts });
const probe = (family, need, file, opts) => run(ARCHIVE_PROBE_SCRIPT, [family, need, file], opts);
const have = (tool) => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;
const SYSTEM_PATH = process.env.PATH;

test("probe: a good tar lists its members with a slash on folders", () => {
  const f = put("good.tar", tarBuffer([{ name: "proj/", type: "dir" }, { name: "proj/a.txt", data: "hello" }, { name: "b.txt", data: "xy" }]));
  const r = probe("tar", "-", f);
  assert.equal(r.status, 0, r.stderr);
  const p = parseProbe(r.stdout);
  assert.ok(p.tool === "tar");
  assert.deepEqual(p.names.sort(), ["b.txt", "proj/", "proj/a.txt"]);
  assert.deepEqual(checkMembers(p.names).tops.map((t) => [t.name, t.isDir]).sort(), [["b.txt", false], ["proj", true]]);
});
test("probe: a tar.gz made with node zlib", () => {
  const f = put("good.tar.gz", zlib.gzipSync(tarBuffer([{ name: "d/", type: "dir" }, { name: "d/x.txt", data: "x".repeat(5000) }])));
  const r = probe("tar", "gzip", f);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(parseProbe(r.stdout).names, ["d/", "d/x.txt"]);
});
test("probe + checkMembers: ../escape.txt, /abs.txt and a symlink written through are refused", () => {
  const cases = [
    ["dots.tar", [{ name: "../escape.txt", data: "x" }], /path with "\.\."/],
    ["abs.tar", [{ name: "/abs.txt", data: "x" }], /absolute path/],
    ["link.tar", [{ name: "l", type: "symlink", target: "/tmp" }, { name: "l/pwned.txt", data: "x" }], /writes through a link/],
  ];
  for (const [name, entries, re] of cases) {
    const r = probe("tar", "-", put(name, tarBuffer(entries)));
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.match(checkMembers(parseProbe(r.stdout).names).error, re, name);
  }
});
test("probe: a file that is no archive exits 4 with the tool's message on stderr", () => {
  const r = probe("tar", "-", put("junk.tar", "this is not a tar archive at all\n".repeat(40)));
  assert.equal(r.status, 4);
  assert.notEqual(r.stderr.trim(), "");
});
test("probe: a name starting with a dash is read as a file", () => {
  const f = put("-dash.tar", tarBuffer([{ name: "a.txt", data: "x" }]));
  const r = spawnSync("sh", ["-c", ARCHIVE_PROBE_SCRIPT, "x", "tar", "-", path.basename(f)], { encoding: "utf8", cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(parseProbe(r.stdout).names, ["a.txt"]);
});
test("probe: single file archives only report their tool", () => {
  const f = put("log.txt.gz", zlib.gzipSync("hello\n"));
  const r = probe("single", "gzip", f);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(parseProbe(r.stdout), { tool: "gzip", names: [] });
  const none = probe("single", "no-such-tool-xyz", f);
  assert.equal(none.status, 3);
  assert.equal(none.stdout.trim(), "missing=no-such-tool-xyz");
});

// A PATH holding symlinks to every tool of /bin and /usr/bin except the named ones.
function restrictedBin(except) {
  const bin = mkTmpSync("bin-");
  for (const d of ["/bin", "/usr/bin"]) {
    let list = [];
    try { list = fs.readdirSync(d); } catch {}
    for (const f of list) {
      if (except.includes(f)) continue;
      try { fs.symlinkSync(path.join(d, f), path.join(bin, f)); } catch {}
    }
  }
  return bin;
}
const noZstd = restrictedBin(["zstd", "xz", "bsdtar", "unzip"]);

test("probe: a name with a newline and an NFD é survive env -i with a restricted PATH (R2)", () => {
  const f = put("odd.tar", tarBuffer([{ name: "a\nb.txt", data: "1" }, { name: "e\u0301.txt", data: "2" }, { name: "back\\slash.txt", data: "3" }]));
  const r = spawnSync("env", ["-i", `PATH=${noZstd}`, "sh", "-c", ARCHIVE_PROBE_SCRIPT, "x", "tar", "-", f], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const names = parseProbe(r.stdout).names;
  assert.deepEqual(names.sort(), ["a\nb.txt", "back\\slash.txt", "e\u0301.txt"].sort(), JSON.stringify(r.stdout));
  assert.ok(checkMembers(names).tops);
});
test("probe: a .tar.zst without zstd on the PATH exits 3 with missing=zstd", () => {
  const f = put("x.tar.zst", Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from("junk junk junk junk".repeat(20))]));
  const r = spawnSync("env", ["-i", `PATH=${noZstd}`, "sh", "-c", ARCHIVE_PROBE_SCRIPT, "x", "tar", "zstd", f], { encoding: "utf8" });
  assert.equal(r.status, 3, r.stderr);
  assert.equal(r.stdout.trim(), "missing=zstd");
});
test("probe: a zip without unzip and bsdtar on the PATH exits 3 with missing=unzip", () => {
  const f = put("m.zip", zipBuffer([{ name: "a.txt", data: "x" }]));
  const r = spawnSync("env", ["-i", `PATH=${noZstd}`, "sh", "-c", ARCHIVE_PROBE_SCRIPT, "x", "zip", "-", f], { encoding: "utf8" });
  assert.equal(r.status, 3, r.stderr);
  assert.equal(r.stdout.trim(), "missing=unzip");
});

const zipSkip = have("unzip") ? false : "unzip is not installed";
test("probe: a good zip lists through unzip -Z1; traversal names are refused by checkMembers", { skip: zipSkip }, () => {
  const f = put("good.zip", zipBuffer([{ name: "d", type: "dir" }, { name: "d/a.txt", data: "hello" }, { name: "b.txt", data: "xy" }]));
  const r = probe("zip", "-", f);
  assert.equal(r.status, 0, r.stderr);
  const p = parseProbe(r.stdout);
  assert.equal(p.tool, "unzip");
  assert.deepEqual(p.names.sort(), ["b.txt", "d/", "d/a.txt"]);
  assert.deepEqual(checkMembers(p.names, { zip: true }).tops.map((t) => [t.name, t.isDir]).sort(), [["b.txt", false], ["d", true]]);
  for (const bad of ["../escape.txt", "/abs.txt"]) {
    const q = parseProbe(probe("zip", "-", put("bad.zip", zipBuffer([{ name: bad, data: "x" }]))).stdout);
    assert.ok(checkMembers(q.names, { zip: true }).error, bad);
  }
  const link = parseProbe(probe("zip", "-", put("link.zip", zipBuffer([{ name: "l", type: "symlink", target: "/tmp" }, { name: "l/pwned.txt", data: "x" }]))).stdout);
  assert.match(checkMembers(link.names, { zip: true }).error, /writes through a link/);
});
test("probe: a damaged zip exits 4", { skip: zipSkip }, () => {
  const r = probe("zip", "-", put("junk.zip", "PK junk, not a zip\n".repeat(30)));
  assert.equal(r.status, 4);
});

test("size script: tar, tar.gz, zip and single report the sum of file sizes and the free bytes of the folder", () => {
  const sizeOf = (tool, file) => parseSize(run(ARCHIVE_SIZE_SCRIPT, [tool, file, dir]).stdout);
  const tar = put("s.tar", tarBuffer([{ name: "d", type: "dir" }, { name: "d/a", data: "a".repeat(1000) }, { name: "b", data: "b".repeat(234) }]));
  const s = sizeOf("tar", tar);
  assert.equal(s.size, 1234);
  assert.ok(s.avail > 0, "df of the folder");
  assert.equal(sizeOf("tar", put("s.tar.gz", zlib.gzipSync(fs.readFileSync(tar)))).size, 1234);
  assert.equal(sizeOf("gzip", put("s.txt.gz", zlib.gzipSync("x".repeat(777)))).size, 777);
  if (!zipSkip) assert.equal(sizeOf("unzip", put("s.zip", zipBuffer([{ name: "a", data: "a".repeat(300) }, { name: "b", data: "b".repeat(21) }]))).size, 321);
});
test("size script: a broken archive gives an unknown size, df still answers; a missing folder gives no df", () => {
  const r = run(ARCHIVE_SIZE_SCRIPT, ["gzip", put("bad.gz", "not gzip at all"), dir]);
  assert.equal(r.status, 0);
  assert.equal(parseSize(r.stdout).size, null, "gzip -dc failed: nothing to count");
  const gone = run(ARCHIVE_SIZE_SCRIPT, ["tar", put("g.tar", tarBuffer([{ name: "a", data: "1" }])), path.join(dir, "nope")]);
  assert.equal(gone.status, 0);
  assert.equal(parseSize(gone.stdout).avail, null);
});

test("EXTRACT_STOP_SCRIPT: kills a matching process and removes the temp; a reused pid is left alone", () => {
  const temp = path.join(dir, "stop-temp");
  fs.mkdirSync(temp);
  // a long sleeper whose args carry the job id, started like extract.sh's side shell (sh -c BODY fs-<id>)
  const child = spawnSync("sh", ["-c", `sleep 30 >/dev/null 2>&1 & echo $!`], { encoding: "utf8" });
  const bystander = Number(child.stdout.trim());
  fs.writeFileSync(path.join(temp, "pid"), `${bystander}\n`);
  const r = run(EXTRACT_STOP_SCRIPT, [temp, "abc123"]);
  assert.equal(r.status, 0);
  assert.equal(fs.existsSync(temp), false, "temp removed");
  let alive = true;
  try { process.kill(bystander, 0); } catch { alive = false; }
  assert.equal(alive, true, "a pid whose args do not contain fs-abc123 is not killed");
  process.kill(bystander, "SIGKILL");
  assert.equal(run(EXTRACT_STOP_SCRIPT, [path.join(dir, "absent"), "abc"]).status, 0, "no temp, no pid: still fine");
  assert.equal(run(EXTRACT_STOP_SCRIPT, ["", "abc"]).status, 1, "refuses an empty temp path");
});

// Security review of #57: the write-through check must not rely on the trailing slash alone, and a path must not be
// listed both as a folder and as a link (exactly or only in letter case: on APFS it is the same entry).
test("checkMembers with types: a link listed with a trailing slash, a path that is folder and link, case variants", () => {
  assert.match(checkMembers(["l/", "l/x.txt"], { types: "l-" }).error, /^The archive writes through a link: l\/x\.txt$/);
  assert.match(checkMembers(["l", "l/", "l/x.txt"], { types: "ld-" }).error, /^The archive lists a path both as a folder and as a file or link: l$/);
  assert.match(checkMembers(["Foo", "FOO/", "Foo/x.txt"], { types: "ld-" }).error, /both as a folder and as a file or link/);
  assert.match(checkMembers(["h", "h/x"], { types: "h-" }).error, /writes through a link/, "a hard link is no folder either");
  assert.deepEqual(checkMembers(["proj", "proj/a.txt"], { types: "d-" }).tops, [{ name: "proj", isDir: true }], "a folder without a slash is fine with types");
  assert.equal(checkMembers(["a", "b"], { types: "-" }).error, "Could not read the member types of the archive");
  assert.match(checkMembers(["l", "l/", "l/x.txt"]).error, /both as a folder/, "without types: the slash decides");
});
test("probe + checkMembers: crafted tar and zip with a slash-named link, link plus folder, and case variants are refused", () => {
  const cases = [
    ["slash", [{ name: "l/", type: "symlink", target: "../victim" }, { name: "l/x.txt", data: "x" }], /writes through a link/],
    ["both", [{ name: "l", type: "symlink", target: "../victim" }, { name: "l/", type: "dir" }, { name: "l/x.txt", data: "x" }], /both as a folder/],
    ["fold", [{ name: "Foo", type: "symlink", target: "../victim" }, { name: "FOO/", type: "dir" }, { name: "Foo/x.txt", data: "x" }], /both as a folder/],
    ["caseonly", [{ name: "Foo", type: "symlink", target: "../victim" }, { name: "foo/x.txt", data: "x" }], /writes through a link/],
  ];
  for (const [name, entries, re] of cases) {
    const r = probe("tar", "-", put(`sec-${name}.tar`, tarBuffer(entries)));
    assert.equal(r.status, 0, `${name}.tar: ${r.stderr}`);
    const p = parseProbe(r.stdout);
    assert.equal(p.types.length, p.names.length, `${name}.tar types`);
    assert.match(checkMembers(p.names, { types: p.types }).error, re, `${name}.tar`);
    if (!have("unzip") && !have("bsdtar")) continue; // zip needs one of them
    const z = probe("zip", "-", put(`sec-${name}.zip`, zipBuffer(entries)));
    assert.equal(z.status, 0, `${name}.zip: ${z.stderr}`);
    const q = parseProbe(z.stdout);
    assert.match(checkMembers(q.names, { zip: true, types: q.types }).error, re, `${name}.zip`);
  }
});
test("probe: types line matches the members of a good tar (folder without a trailing slash counts as a folder)", () => {
  const r = probe("tar", "-", put("typed.tar", tarBuffer([{ name: "proj", type: "dir" }, { name: "proj/a.txt", data: "a" }, { name: "ln", type: "symlink", target: "proj/a.txt" }])));
  const p = parseProbe(r.stdout);
  assert.equal(p.types, "d-l");
  assert.deepEqual(checkMembers(p.names, { types: p.types }).tops, [{ name: "proj", isDir: true }, { name: "ln", isDir: false }]);
});

test("probe: an encrypted zip entry is reported (zipinfo's capital T/B), a plain zip is not", { skip: !have("unzip") && "unzip is not installed" }, () => {
  const enc = parseProbe(probe("zip", "-", put("enc.zip", zipBuffer([{ name: "s.txt", data: "secret" }], { encrypted: true }))).stdout);
  assert.equal(enc.encrypted, true);
  const plain = parseProbe(probe("zip", "-", put("plain.zip", zipBuffer([{ name: "s.txt", data: "open" }]))).stdout);
  assert.equal(plain.encrypted, undefined);
});

// ---- the member check of a big listing in slices (follow-up to #68) ----
// herdr interrupts a QuickJS job after about 0.5 s (uncatchable); a node_modules or kernel tarball lists 100,000 members
// and more. test/archive-budget.test.js measures each job inside herdr; these tests pin the logic.

// A fake timer like test/readfile.test.js's: run(0) fires the zero timers armed so far, as the host does after a job.
function fakeTimers() {
  const armed = [];
  return {
    armed,
    after: (ms, fn) => armed.push({ ms, fn }),
    run: (ms) => armed.filter((t) => t.ms === ms && !t.fired).forEach((t) => { t.fired = true; t.fn(); }),
  };
}
const settle = () => new Promise((r) => setImmediate(r));
async function drain(t, rounds = 1000) { for (let i = 0; i < rounds; i++) { t.run(0); await settle(); } }

const CASES = [
  [["a/", "a/b.txt", "c.txt"]], [["../escape.txt"]], [["/abs.txt"]], [["l", "l/pwned.txt"]], [["L", "l/x"]], [[]], [["", ".", "./"]],
  [["C:\\x.txt"], { zip: true }], [["a\\b.txt"], { zip: true }], [["Foo.txt", "foo.TXT", "e\u0301/", "\u00e9/x"]],
  [["l/", "l/x.txt"], { types: "l-" }], [["l", "l/", "l/x.txt"], { types: "ld-" }], [["Foo", "FOO/", "Foo/x.txt"], { types: "ld-" }],
  [["proj", "proj/a.txt"], { types: "d-" }], [["a", "b"], { types: "-" }], [["x/y/z/1", "x/y/z/2", "X/Y/z", "x/y/z/3"]],
];

test("memberCheck: every budget gives the result of checkMembers, null until it is known", () => {
  for (const [names, opts] of CASES) {
    const whole = checkMembers(names, opts);
    for (const budget of [1, 17, 40, 1000]) {
      const c = memberCheck(names, opts);
      let r = null, steps = 0;
      while (!(r = c.step(budget))) steps++;
      assert.deepEqual(r, whole, `${JSON.stringify(names)} budget ${budget}`);
      assert.deepEqual(c.step(budget), whole, "a finished check keeps its result");
      if (budget === 1 && names.length > 2 && whole.tops) assert.ok(steps >= names.length, "one member per step with budget 1");
    }
  }
});

test("memberCheck: decode turns each line into the name first; too many members are refused before any work", () => {
  assert.deepEqual(memberCheck(["\\303\\251/a", "\\303\\251/b"], { decode: unescapeName }).step(Infinity), { tops: [{ name: "é", isDir: true }] });
  const many = { length: ARCHIVE_MAX_MEMBERS + 1 }; // never read: the count alone refuses
  assert.deepEqual(memberCheck(many).step(1), { error: "The archive lists 200,001 entries: more than 200,000 cannot be checked" });
  assert.equal(tooManyMembers(undefined), "The archive lists more than 200,000 entries: too many to check");
  assert.equal(tooManyMembers(NaN), tooManyMembers(undefined));
});

// A listing as the probe prints it: GNU tar style paths below node_modules, one folder per ten members.
function bigListing(n) {
  const names = [];
  let types = "";
  for (let i = 0; i < n; i++) {
    const dir = i % 10 === 0;
    names.push(`node_modules/pkg${i % 997}/lib/sub${i % 13}/file-${i}${dir ? "/" : ".js"}`);
    types += dir ? "d" : "-";
  }
  return { names, stdout: `tool=tar\ntypes=${types}\nsize=4096\nencrypted=0\n--\n${names.join("\n")}\n` };
}

test("checkListing: 100,000 members are checked in slices of CHECK_SLICE, each in its own job, same result as at once", async () => {
  const { names, stdout } = bigListing(100000);
  const t = fakeTimers(), results = [];
  checkListing(stdout, { family: "tar", stem: "big", after: t.after }).then((r) => results.push(r));
  await settle();
  assert.deepEqual(results, [], "nothing after the parse in the job that received the listing");
  await drain(t, 400);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].tops, checkMembers(names, { types: stdout.split("\n")[1].slice(6) }).tops);
  assert.equal(results[0].probe.size, 4096);
  const units = names.reduce((a, n) => a + 16 + n.length, 0) * 2; // two passes over every member
  const jobs = t.armed.filter((a) => a.ms === 0).length / 2; // a guard and a yield per slice
  assert.ok(jobs >= units / CHECK_SLICE, `${jobs} jobs for ${units} units`);
});

test("checkListing: errors, encrypted, a single file and the order of the refusals", async () => {
  const run = (stdout, opts = {}) => checkListing(stdout, { family: "tar", stem: "s", ...opts });
  assert.deepEqual(await run("tool=tar\ntypes=--\n--\na\n../b\n"), { error: 'The archive contains a path with "..": ../b' });
  assert.deepEqual(await run("tool=tar\ntypes=l-\n--\nl\nl/x\n"), { error: "The archive writes through a link: l/x" });
  assert.deepEqual(await run("tool=unzip\ntypes=-\nencrypted=1\n--\na\n", { family: "zip" }), { error: "Encrypted archives are not supported" });
  assert.deepEqual((await run("tool=gzip\n--\n", { family: "single", stem: "log.txt" })).tops, [{ name: "log.txt", isDir: false }]);
  assert.deepEqual((await run("tool=tar\ntypes=-\n--\n\\303\\251.txt\n")).tops, [{ name: "é.txt", isDir: false }], "tar escapes decoded");
  assert.deepEqual((await run("tool=unzip\ntypes=-\n--\na\\b\n", { family: "zip" })).tops, [{ name: "a", isDir: true }], "zip: backslash separates");
});

test("checkListing: an interrupted parse or slice still ends, with an error the dialog shows", async () => {
  // The interrupt cannot be caught: nothing after it runs in that job, then the host fires the timers armed before it.
  // Modelled by work that fires the zero timers while it is still running (and then never returns normally).
  for (const where of ["parse", "slice"]) {
    const t = fakeTimers(), results = [];
    const interrupt = () => { t.run(0); throw new Error("interrupted"); };
    const stdout = where === "parse" ? { toString: interrupt } : "tool=tar\ntypes=-\n--\nx\n";
    const check = () => ({ step: interrupt });
    checkListing(stdout, { family: "tar", stem: "s", after: t.after, ...(where === "slice" ? { check } : {}) }).then((r) => results.push(r));
    await drain(t, 20);
    assert.deepEqual(results, [{ error: CHECK_INTERRUPTED }], where);
  }
});

// A fake tar first on the PATH: logs its arguments, prints `lines` names for -tf and the long listing `long` for -tvf.
function fakeTar(name, { lines = 0, names = [], long = "" }) {
  const bin = path.join(dir, `fakebin-${name}`);
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(bin, "calls");
  fs.writeFileSync(path.join(bin, "names"), names.map((x) => `${x}\n`).join(""));
  fs.writeFileSync(path.join(bin, "long"), long);
  fs.writeFileSync(path.join(bin, "tar"), `#!/bin/sh
printf '%s\\n' "$1" >> '${log}'
case "$1" in
  -tf) if [ ${lines} -gt 0 ]; then awk 'BEGIN { for (i = 1; i <= ${lines}; i++) print "m" i }'; else cat '${path.join(bin, "names")}'; fi;;
  -tvf) cat '${path.join(bin, "long")}';;
esac
`, { mode: 0o755 });
  return { env: { ...process.env, PATH: `${bin}:${SYSTEM_PATH}` }, calls: () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean) };
}

test("probe: a tar.gz is read twice (names, long listing), the long listing gives types and the size", () => {
  const entries = [{ name: "d", type: "dir" }, { name: "d/a", data: "a".repeat(1000) }, { name: "b", data: "b".repeat(234) }, { name: "l", type: "symlink", target: "b" }];
  const tar = put("sz.tar", tarBuffer(entries));
  for (const f of [tar, put("sz.tar.gz", zlib.gzipSync(fs.readFileSync(tar)))]) {
    const p = parseProbe(probe("tar", f.endsWith(".gz") ? "gzip" : "-", f).stdout);
    assert.equal(p.types, "d--l", f);
    assert.equal(p.size, 1234, `${path.basename(f)}: the regular files only`);
  }
  const fake = fakeTar("count", { names: ["a"], long: "-rw-r--r-- user/group 5 2026-01-01 12:00 a\n" });
  const r = probe("tar", "gzip", tar, { env: fake.env });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fake.calls(), ["-tf", "-tvf"], "no third pass");
});

test("probe: size from GNU/busybox and bsdtar long listings; an unknown layout leaves it empty", () => {
  const gnu = "drwxr-xr-x root/root         0 2026-01-01 12:00 d/\n-rw-r--r-- root/root      1000 2026-01-01 12:00 d/a b.txt\n"
    + "hrw-r--r-- root/root         0 2026-01-01 12:00 d/h link to d/a b.txt\n-rw-r--r-- 0/0 234 2026-01-01 12:00:00 c\n";
  const bsd = "drwxr-xr-x  0 m      staff       0 Jan  1 12:00 d/\n-rw-r--r--  0 m      staff    1000 Jan  1 12:00 d/a\n"
    + "lrwxr-xr-x  0 m      staff       0 Jan  1 12:00 l -> d/a\n-rw-r--r--  0 m      staff     234 Jan  1 12:00 c\n";
  const odd = "-rw-r--r-- some owner with spaces 12 Jan  1 12:00 x\n";
  for (const [name, long, size, types] of [["gnu", gnu, 1234, "d-h-"], ["bsd", bsd, 1234, "d-l-"], ["odd", odd, undefined, "-"]]) {
    const fake = fakeTar(name, { names: types.split("").map((_, i) => `m${i}`), long });
    const p = parseProbe(probe("tar", "-", put(`${name}.tar`, "x"), { env: fake.env }).stdout);
    assert.equal(p.size, size, name);
    assert.equal(p.types, types, name);
  }
});

test("probe: more than ARCHIVE_MAX_MEMBERS members exit 5 with the count, before the long listing", () => {
  const fake = fakeTar("many", { lines: ARCHIVE_MAX_MEMBERS + 1 });
  const r = probe("tar", "-", put("many.tar", "x"), { env: fake.env });
  assert.equal(r.status, 5, r.stderr);
  assert.equal(r.stdout, `count=${ARCHIVE_MAX_MEMBERS + 1}\n`);
  assert.deepEqual(fake.calls(), ["-tf"]);
  const ok = fakeTar("max", { lines: ARCHIVE_MAX_MEMBERS });
  const s = probe("tar", "-", put("max.tar", "x"), { env: ok.env, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(s.status, 0, "exactly the bound is fine");
  assert.equal(parseProbe(s.stdout).names.length, ARCHIVE_MAX_MEMBERS);
});

test("size script: tool - only asks df (the probe gave the size)", () => {
  const r = parseSize(run(ARCHIVE_SIZE_SCRIPT, ["-", put("dash.tar", tarBuffer([{ name: "a", data: "1" }])), dir]).stdout);
  assert.equal(r.size, null);
  assert.ok(r.avail > 0);
});
