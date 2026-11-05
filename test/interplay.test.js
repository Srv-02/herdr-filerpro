// Interplay of separately built changes, checked on the combined state (from the check agent after #46-#49).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createJobs } from "../mods/filer-pro/lib/jobs.js";
import { createFake } from "./fake/herdr.js";
import { mkTmpSync } from "./tmp-helper.js";
import { OPEN_CHECK_SCRIPT } from "../mods/filer-pro/lib/open.js";
import { runTransfers, parseRequest } from "../mods/filer-pro/lib/requests.js";

const root = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(root, "mods/filer-pro/bin/transfer.sh");
const STATUS = "/Users/m/.config/herdr-app/filer-pro/jobs/id1.status";
const settle = () => new Promise((r) => setImmediate(r));
const openChecks = (f) => f.execsOf("sh").filter((c) => c.args[1] === OPEN_CHECK_SCRIPT);

// #46 old copy: the REAL status file of transfer.sh (up replace, rm -rf of the old copy fails) through jobs.js.
test("w: real transfer.sh status with a left old copy gives done + the warning toast with the real path", async (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip("root can delete everything");
  const d = mkTmpSync("interplay-w-");
  for (const s of ["src", "dst", "trash"]) fs.mkdirSync(path.join(d, s));
  const id = "tw1";
  const src = path.join(d, "src", "folder"), dest = path.join(d, "dst", "folder"), st = path.join(d, "status");
  fs.mkdirSync(path.join(src, "sub"), { recursive: true });
  fs.writeFileSync(path.join(src, "sub", "n.txt"), "new");
  fs.mkdirSync(path.join(dest, "locked"), { recursive: true });
  fs.writeFileSync(path.join(dest, "locked", "f"), "old");
  fs.chmodSync(path.join(dest, "locked"), 0o555);
  const old = path.join(d, "dst", `.folder.fs-old-${id}`);
  t.after(() => fs.existsSync(old) && fs.chmodSync(path.join(old, "locked"), 0o755));
  const env = { ...process.env, FILER_PRO_SCP: path.join(root, "test/fake/scp"), FILER_PRO_SSH: path.join(root, "test/fake/ssh") };
  delete env.FAKE_SLEEP; delete env.FAKE_FAIL;
  const r = spawnSync("sh", [SCRIPT, "up", "replace", "box", src, dest, path.join(d, "dst", `.folder.fs-${id}.part`), st, path.join(d, "trash")], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const f = createFake();
  const jobs = createJobs(f.deps());
  await jobs.start({ direction: "up", machine: "box", src: "/Users/m/folder", destDir: "/srv/in", choice: "replace" });
  f.terminals["term-fs-id1"] = { state: "finished", exit_code: 0 };
  f.files[STATUS] = fs.readFileSync(st, "utf8");
  await jobs.tick();
  assert.equal(f.jobs().id1.state, "done");
  assert.deepEqual(f.notifications, [{ title: "Uploaded", body: `Could not fully remove the old copy: ${old}`, level: "warning" }]);
});

// #46 mergeError refusal and #49 reveal values through the real runTransfers and jobs.
test("c: copy with conflict merge + reveal preview: the linked folder is refused, the other job keeps reveal preview", async () => {
  const f = createFake();
  for (const p of ["/Users/m/link", "/Users/m/real", "/Users/m/in", "/Users/m/in/link", "/Users/m/in/real"]) { f.existing.add(p); f.dirs.add(p); }
  f.symlinks.add("/Users/m/link");
  const jobs = createJobs(f.deps());
  const req = parseRequest('{"action":"copy","paths":["/Users/m/link","/Users/m/real"],"folder":"/Users/m/in","conflict":"merge","reveal":"preview"}');
  assert.equal(req.error, undefined);
  assert.equal(req.reveal, "preview");
  const r = await runTransfers({ direction: "local", machine: null, paths: req.paths, destDir: "/Users/m/in", conflict: "merge", reveal: "preview" },
    { jobs, ask: async () => { throw new Error("no dialog expected"); }, newBatchId: () => "b1" });
  assert.deepEqual(r.errors, [{ path: "/Users/m/link", error: "Cannot merge a symlink into a folder: /Users/m/link" }]);
  assert.equal(r.jobs.length, 1);
  assert.equal(f.jobs().id1.src, "/Users/m/real");
  assert.equal(f.jobs().id1.reveal, "preview");
  assert.equal(f.jobs().id1.mode, "merge");
});

// #49 quarantine only for direction down, through jobs.end (not only afterDownload alone).
test("q: jobs.end of a local copy with reveal open runs the open check but no xattr; a download runs both", async () => {
  for (const [start, xattrs] of [
    [{ direction: "local", machine: null, src: "/Users/m/a.txt", destDir: "/Users/m/in", choice: "new", reveal: "open" }, 0],
    [{ direction: "down", machine: "box", src: "/srv/a.txt", destDir: "/Users/m/Downloads", choice: "new", reveal: "open" }, 1],
  ]) {
    const f = createFake();
    const jobs = createJobs(f.deps());
    await jobs.start(start);
    f.terminals["term-fs-id1"] = { state: "finished", exit_code: 0 };
    f.files[STATUS] = "state=done\ncode=0\n";
    await jobs.tick();
    await settle();
    assert.equal(f.execsOf("xattr").length, xattrs, start.direction);
    assert.equal(openChecks(f).length, 1, start.direction);
  }
});
