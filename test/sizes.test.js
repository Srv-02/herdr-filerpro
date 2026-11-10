import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkTmpSync } from "./tmp-helper.js";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { SIZE_SCRIPT, SIZE_GRACE_MS, INCOMPLETE, sizeArgs, sizeNote, parseSizeOutput, parseSize, formatBytes, formatRate, FOLDER_SIZE_MS, CLAIM_MS, TOO_LARGE, busy, sizeKey, parseSizeKey, requestSize, claimSizes, sizeResult, storeSize, dropSizes, sizeCell, sizeDetail } from "../mods/filer-pro/lib/sizes.js";

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

test("parseSizeOutput: bytes with the partial and timeout flags, null for a missing path and junk", () => {
  assert.deepEqual(parseSizeOutput("8\n"), { bytes: 8, incomplete: false, timedOut: false });
  assert.deepEqual(parseSizeOutput("8 partial\n"), { bytes: 8, incomplete: true, timedOut: false });
  assert.deepEqual(parseSizeOutput("0 timeout\n"), { bytes: 0, incomplete: false, timedOut: true });
  assert.equal(parseSizeOutput("-1\n"), null);
  assert.equal(parseSizeOutput("12 junk"), null);
  assert.equal(parseSizeOutput(""), null);
});

test("parseSize counts only complete sums", () => {
  assert.equal(parseSize("8 partial\n"), null);
  assert.equal(parseSize("8 timeout\n"), null);
  assert.equal(parseSize("8\n"), 8);
});

test("sizeArgs: the script, the path and the limit in whole seconds", () => {
  assert.deepEqual(sizeArgs("/a b", 120000), ["-c", SIZE_SCRIPT, "size", "/a b", "120"]);
  assert.equal(sizeArgs("/a", 5000)[4], "5");
  assert.equal(sizeArgs("/a", 25000)[4], "25");
  assert.equal(sizeArgs("/a", 1)[4], "1");
  assert.equal(SIZE_GRACE_MS, 5000);
});

test("sizeResult: a partial sum is done and incomplete, the script's timeout is too large", () => {
  assert.deepEqual(sizeResult({ result: { code: 0, stdout: "2400000 partial\n" }, ms: 50 }), { state: "done", bytes: 2400000, incomplete: true });
  assert.deepEqual(sizeResult({ result: { code: 0, stdout: "123 timeout\n" }, ms: 50 }), { state: "toolarge" });
  assert.equal("incomplete" in sizeResult({ result: { code: 0, stdout: "5\n" }, ms: 50 }), false);
});

test("storeSize keeps the incomplete field", () => {
  const key = sizeKey(null, "/r/a");
  const run = { [key]: { state: "running", id: "i1", at: 1 } };
  assert.deepEqual(storeSize(run, key, "i1", { state: "done", bytes: 9, incomplete: true }), { [key]: { state: "done", bytes: 9, incomplete: true, id: "i1" } });
});

test("sizeCell and sizeDetail: an incomplete sum shows the same size with the tooltip text", () => {
  const r = { state: "done", bytes: 2_400_000, incomplete: true };
  assert.deepEqual(sizeCell({ dir: true }, r), { text: "~2.4 MB", spin: false, title: "Some folders could not be read" });
  assert.equal(INCOMPLETE, "Some folders could not be read");
  assert.equal(sizeDetail(r), "~2.4 MB");
  assert.equal(sizeNote(r, 0), INCOMPLETE);
  assert.equal(sizeNote({ state: "done", bytes: 1 }, 0), null);
  assert.equal(sizeNote({ state: "toolarge" }, 0), null);
  assert.equal(sizeNote(undefined, 0), null);
  assert.equal(sizeNote({ ...r, state: "running", at: 0 }, 1), null, "busy");
});

test("SIZE_SCRIPT marks the sum partial when a subfolder cannot be read", { skip: process.getuid?.() === 0 }, () =>
  scratch((dir) => {
    fs.mkdirSync(path.join(dir, "ok"));
    fs.mkdirSync(path.join(dir, "deny"));
    fs.writeFileSync(path.join(dir, "ok", "a"), "abc");
    fs.writeFileSync(path.join(dir, "deny", "c"), "wxyz");
    fs.chmodSync(path.join(dir, "deny"), 0);
    try {
      assert.equal(size(dir), "3 partial");
    } finally {
      fs.chmodSync(path.join(dir, "deny"), 0o755);
    }
  }));

// Watchdog (issue #73): a fake find first in PATH records its PID and then sleeps; a wrapper sleep records the watchdog's.
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await wait(50); }
  return fn();
}
function which(cmd) {
  try { return execFileSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).trim() || null; } catch { return null; }
}
function rig(dir) {
  const findDir = path.join(dir, "fbin"), sleepDir = path.join(dir, "sbin");
  fs.mkdirSync(findDir); fs.mkdirSync(sleepDir);
  const realSleep = which("sleep");
  fs.writeFileSync(path.join(findDir, "find"), `#!/bin/sh\necho $$ > "$FIND_PID"\nexec "${realSleep}" 30\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(sleepDir, "sleep"), `#!/bin/sh\necho $$ >> "$SLEEP_PIDS"\nexec "${realSleep}" "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${findDir}:${sleepDir}:${process.env.PATH}`, FIND_PID: path.join(dir, "find.pid"), SLEEP_PIDS: path.join(dir, "sleep.pids") };
  return { env, findPid: () => Number(fs.readFileSync(env.FIND_PID, "utf8").trim()), sleepPids: () => (fs.existsSync(env.SLEEP_PIDS) ? fs.readFileSync(env.SLEEP_PIDS, "utf8").split("\n").filter(Boolean).map(Number) : []) };
}
const shells = ["sh", "dash", "bash"].filter((s) => which(s));

for (const shell of shells) {
  test(`SIZE_SCRIPT ends find at the limit and answers timeout (${shell})`, async () => {
    const dir = mkTmpSync("fs-wd-");
    try {
      const { env, findPid } = rig(dir);
      fs.writeFileSync(path.join(dir, "f"), "abc");
      const t0 = Date.now();
      const r = spawnSync(shell, ["-c", SIZE_SCRIPT, "size", path.join(dir, "f"), "1"], { encoding: "utf8", env });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, "0 timeout\n");
      assert.equal(r.stderr, "");
      assert.ok(Date.now() - t0 < 8000, "back in time");
      const pid = findPid();
      assert.ok(await until(() => !alive(pid), 2000), "find is gone");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test(`SIZE_SCRIPT answers at once under a long limit and leaves no watchdog (${shell})`, async () => {
    const dir = mkTmpSync("fs-wd-");
    try {
      const real = path.join(dir, "real");
      fs.mkdirSync(real);
      fs.writeFileSync(path.join(real, "f"), "abc");
      const { env, sleepPids } = rig(dir);
      fs.rmSync(path.join(dir, "fbin"), { recursive: true }); // use the real find
      const t0 = Date.now();
      const r = spawnSync(shell, ["-c", SIZE_SCRIPT, "size", real, "60"], { encoding: "utf8", env });
      assert.equal(r.stdout, "3\n");
      assert.ok(Date.now() - t0 < 8000, "does not wait for the watchdog");
      const pids = sleepPids();
      for (const pid of pids) assert.ok(await until(() => !alive(pid), 5000), `watchdog sleep ${pid} is gone`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test("SIZE_SCRIPT ends find at the limit although the calling sh was killed", async () => {
  const dir = mkTmpSync("fs-wd-");
  try {
    const { env, findPid } = rig(dir);
    fs.writeFileSync(path.join(dir, "f"), "abc");
    const child = spawn("sh", ["-c", SIZE_SCRIPT, "size", path.join(dir, "f"), "2"], { env, stdio: "ignore" });
    assert.ok(await until(() => fs.existsSync(env.FIND_PID) && fs.readFileSync(env.FIND_PID, "utf8").trim() !== "", 4000), "find started");
    const pid = findPid();
    child.kill("SIGKILL");
    assert.ok(alive(pid), "find is still running right after the kill");
    assert.ok(await until(() => !alive(pid), 6000), "find is gone at the limit");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("SIZE_SCRIPT without a limit argument, or with a broken one, uses its default", () =>
  scratch((dir) => {
    const f = path.join(dir, "f");
    fs.writeFileSync(f, "abc");
    for (const extra of [[], ["abc"]]) {
      const r = spawnSync("sh", ["-c", SIZE_SCRIPT, "size", f, ...extra], { encoding: "utf8" });
      assert.equal(r.stdout.trim(), "3");
    }
  }));

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
  assert.equal(formatBytes(5e15), "5.0 PB");
  assert.equal(formatBytes(999_960_000_000_000), "1.0 PB", "rounding carries from TB into PB");
  assert.equal(formatBytes(2.4e18), "2400 PB", "PB is the last unit");
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

// Issue #58: Calculate Size through the shared value filer-pro.sizes.
test("sizeKey round-trips machine and path", () => {
  assert.deepEqual(parseSizeKey(sizeKey("box", "/a b")), { machine: "box", path: "/a b" });
  assert.deepEqual(parseSizeKey(sizeKey(undefined, "/x")), { machine: null, path: "/x" });
  assert.equal(parseSizeKey("{nope"), null);
  assert.equal(parseSizeKey('["box"]'), null);
});

test("requestSize asks once; a second ask while it runs changes nothing", () => {
  const m1 = requestSize(undefined, null, "/r/a", "id1", 1000);
  assert.deepEqual(m1, { [sizeKey(null, "/r/a")]: { state: "requested", id: "id1", at: 1000 } });
  assert.equal(requestSize(m1, null, "/r/a", "id2", 2000), m1);
  const done = { [sizeKey(null, "/r/a")]: { state: "done", bytes: 5, id: "id1" } };
  assert.deepEqual(requestSize(done, null, "/r/a", "id2", 3000)[sizeKey(null, "/r/a")], { state: "requested", id: "id2", at: 3000 }, "a known size can be calculated again");
});

test("claimSizes takes only the requests the copy shows and marks them running", () => {
  const map = { ...requestSize({}, null, "/r/a", "i1", 0), ...requestSize({}, "box", "/r/b", "i2", 0), [sizeKey(null, "/r/c")]: { state: "done", bytes: 1, id: "i0" } };
  const got = claimSizes(map, (machine, path) => machine === null && path.startsWith("/r/"), 100);
  assert.deepEqual(got.claimed, [{ key: sizeKey(null, "/r/a"), machine: null, path: "/r/a", id: "i1" }]);
  assert.deepEqual(got.map[sizeKey(null, "/r/a")], { state: "running", id: "i1", at: 100 });
  assert.deepEqual(got.map[sizeKey("box", "/r/b")], { state: "requested", id: "i2", at: 0 }, "another machine's request stays for its panel");
  assert.equal(claimSizes(got.map, (machine) => machine === null, 200), null, "a running one is not claimed twice");
  assert.equal(claimSizes(undefined, () => true, 0), null);
  assert.equal(claimSizes(map, () => true, CLAIM_MS + 1), null, "a request nobody took in time is not started late");
});

test("sizeResult: bytes, gone, failure, and too large when the time is used up", () => {
  assert.deepEqual(sizeResult({ result: { code: 0, stdout: "2400000\n", stderr: "" }, ms: 50 }), { state: "done", bytes: 2400000 });
  assert.deepEqual(sizeResult({ result: { code: 0, stdout: "-1\n" }, ms: 5 }), { state: "failed", error: "Folder not found" });
  assert.deepEqual(sizeResult({ result: { code: 255, stdout: "", stderr: "ssh: no route\n" }, ms: 5 }), { state: "failed", error: "ssh: no route" });
  assert.deepEqual(sizeResult({ error: new Error("boom"), ms: 5 }), { state: "failed", error: "boom" });
  assert.deepEqual(sizeResult({ result: { code: 137, stdout: "" }, ms: FOLDER_SIZE_MS }), { state: "toolarge" });
  assert.deepEqual(sizeResult({ error: new Error("timed out"), ms: FOLDER_SIZE_MS + 3 }), { state: "toolarge" });
  assert.deepEqual(sizeResult({ result: { code: 0, stdout: "7\n" }, ms: FOLDER_SIZE_MS - 500 }), { state: "done", bytes: 7 }, "an answer just before the limit counts");
  assert.equal(FOLDER_SIZE_MS, 120000);
  assert.equal(TOO_LARGE, "Too large to calculate");
});

test("busy: a request nobody claimed, or a run whose copy is gone, ends after its time; the entry is usable again", () => {
  assert.equal(busy({ state: "requested", at: 0 }, CLAIM_MS), true);
  assert.equal(busy({ state: "requested", at: 0 }, CLAIM_MS + 1), false);
  assert.equal(busy({ state: "running", at: 0 }, FOLDER_SIZE_MS), true);
  assert.equal(busy({ state: "running", at: 0 }, FOLDER_SIZE_MS + CLAIM_MS + 1), false);
  assert.equal(busy({ state: "done", bytes: 1 }, 0), false);
  assert.equal(busy(undefined, 0), false);
  const stale = { [sizeKey(null, "/r/a")]: { state: "running", id: "old", at: 0 } }, later = FOLDER_SIZE_MS + CLAIM_MS + 1;
  assert.deepEqual(sizeCell({ dir: true }, stale[sizeKey(null, "/r/a")], later), { text: "\u2014", spin: false }, "no endless spinner");
  assert.equal(sizeDetail(stale[sizeKey(null, "/r/a")], later), null);
  assert.equal(requestSize(stale, null, "/r/a", "new", later)[sizeKey(null, "/r/a")].id, "new");
  assert.deepEqual(dropSizes(stale, null, "/r", later), {}, "Refresh clears it");
});

test("storeSize keeps the result unless a newer request replaced it; a failure removes the entry", () => {
  const key = sizeKey(null, "/r/a"), run = { [key]: { state: "running", id: "i1" } };
  assert.deepEqual(storeSize(run, key, "i1", { state: "done", bytes: 9 }), { [key]: { state: "done", bytes: 9, id: "i1" } });
  assert.deepEqual(storeSize(run, key, "i1", { state: "failed", error: "x" }), {});
  assert.equal(storeSize(run, key, "old", { state: "done", bytes: 1 }), run);
});

test("dropSizes forgets finished results at and below the root of that machine only (Refresh)", () => {
  const map = {
    [sizeKey(null, "/r/a")]: { state: "done", bytes: 1 }, [sizeKey(null, "/r/b")]: { state: "toolarge" }, [sizeKey(null, "/r/c")]: { state: "running" },
    [sizeKey(null, "/rx")]: { state: "done", bytes: 2 }, [sizeKey("box", "/r/a")]: { state: "done", bytes: 3 },
  };
  assert.deepEqual(Object.keys(dropSizes(map, null, "/r/", 0)).sort(), [sizeKey("box", "/r/a"), sizeKey(null, "/r/c"), sizeKey(null, "/rx")].sort());
  const none = { [sizeKey("box", "/r/a")]: { state: "done", bytes: 3 } };
  assert.equal(dropSizes(none, null, "/r", 0), none, "unchanged object when nothing goes");
});

test("sizeCell: files their size, folders a dash until calculated, packages nothing", () => {
  assert.deepEqual(sizeCell({ dir: false, size: 3200 }), { text: "3.2 kB", spin: false });
  assert.deepEqual(sizeCell({ dir: false, size: 812 }), { text: "812 B", spin: false });
  assert.deepEqual(sizeCell({ dir: false }), { text: "", spin: false }, "unknown size");
  assert.deepEqual(sizeCell({ dir: true }), { text: "\u2014", spin: false });
  assert.deepEqual(sizeCell({ dir: true, bundle: true }), { text: "", spin: false });
  assert.deepEqual(sizeCell({ dir: true }, undefined, 0, false), { text: "", spin: false }, "no dash where Calculate Size cannot run");
  assert.deepEqual(sizeCell({ dir: true }, { state: "running" }), { text: "", spin: true });
  assert.deepEqual(sizeCell({ dir: true }, { state: "requested" }), { text: "", spin: true });
  assert.deepEqual(sizeCell({ dir: true, bundle: true }, { state: "done", bytes: 2_400_000 }), { text: "~2.4 MB", spin: false });
  assert.deepEqual(sizeCell({ dir: true }, { state: "toolarge" }), { text: "Too large", spin: false, title: TOO_LARGE });
});

test("sizeDetail: the text at the right of Calculate Size", () => {
  assert.equal(sizeDetail(undefined), null);
  assert.equal(sizeDetail({ state: "running" }), "\u2026");
  assert.equal(sizeDetail({ state: "done", bytes: 2_400_000 }), "~2.4 MB");
  assert.equal(sizeDetail({ state: "toolarge" }), "Too large");
});
