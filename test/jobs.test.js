import { test } from "node:test";
import assert from "node:assert/strict";
import { createJobs } from "../mods/filer-pro/lib/jobs.js";
import { createFake } from "./fake/herdr.js";
import { OPEN_CHECK_SCRIPT } from "../mods/filer-pro/lib/open.js";
import { SIZE_SCRIPT } from "../mods/filer-pro/lib/sizes.js";
import { LINKS_SCRIPT } from "../mods/filer-pro/lib/links.js";
import { RESOLVE_SCRIPT, STOP_REMOVE_SCRIPT, REPLACE_CHECK_SCRIPT, LIST_SCRIPT } from "../mods/filer-pro/lib/jobs.js";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { mkTmp, mkTmpSync } from "./tmp-helper.js";

const SRC = "/srv/data/a.txt";
const DIR = "/Users/m/Downloads";
const STATUS = "/Users/m/.config/herdr-app/filer-pro/jobs/id1.status";

function setup(over) {
  const f = createFake(over);
  return { f, jobs: createJobs(f.deps()) };
}
const down = (extra = {}) => ({ direction: "down", machine: "box", src: SRC, destDir: DIR, choice: "new", ...extra });

test("start download: hc run args, temp next to the destination", async () => {
  const { f, jobs } = setup();
  const job = await jobs.start(down());
  assert.deepEqual(f.hcRuns()[0], [
    "run", "--bg", "--json", "--no-parent", "--no-notify", "--name", "fs-id1", "--",
    "sh", "/Users/m/.config/herdr-app/mods/filer-pro/bin/transfer.sh",
    "down", "new", "user@box", SRC, "/Users/m/Downloads/a.txt", "/Users/m/Downloads/.a.txt.fs-id1.part",
    STATUS, "/Users/m/.Trash",
  ]);
  assert.equal(job.state, "running");
  assert.equal(job.terminal, "term-fs-id1");
  assert.deepEqual(f.execsOf("mkdir")[0].args, ["-p", "/Users/m/.config/herdr-app/filer-pro/jobs"]);
  assert.equal(f.jobs().id1.dest, "/Users/m/Downloads/a.txt");
});

test("start upload runs sizing locally and passes remote dest and temp", async () => {
  const { f, jobs } = setup();
  f.sizes["/Users/m/a.txt"] = 500;
  const job = await jobs.start({ direction: "up", machine: "box", src: "/Users/m/a.txt", destDir: "/srv/in", choice: "replace" });
  const sizeCall = f.execCalls.find((c) => c.args[0] === "-c" && c.args[3] === "/Users/m/a.txt");
  assert.equal(sizeCall.on, null);
  assert.equal(job.total, 500);
  const run = f.hcRuns()[0];
  assert.deepEqual(run.slice(10, 18), ["up", "replace", "user@box", "/Users/m/a.txt", "/srv/in/a.txt", "/srv/in/.a.txt.fs-id1.part", STATUS, "/Users/m/.Trash"]);
});

test("keep_both twice in parallel yields a-1.txt and a-2.txt", async () => {
  const { f, jobs } = setup();
  f.listings[DIR] = ["a.txt"];
  const [x, y] = await Promise.all([jobs.start(down({ choice: "keep_both" })), jobs.start(down({ choice: "keep_both" }))]);
  assert.deepEqual([x.dest, y.dest].sort(), [`${DIR}/a-1.txt`, `${DIR}/a-2.txt`]);
  assert.ok(f.hcRuns().every((r) => r[r.indexOf("new") - 1] === "down"));
});

test("keep_both lists the destination side: remote for uploads", async () => {
  const { f, jobs } = setup();
  f.listings["/srv/in"] = ["a.txt"];
  const job = await jobs.start({ direction: "up", machine: "box", src: "/Users/m/a.txt", destDir: "/srv/in", choice: "keep_both" });
  assert.equal(job.dest, "/srv/in/a-1.txt");
  assert.equal(job.mode, "new");
});

test("sshTarget error (via machine) fails the job without hc run", async () => {
  const { f, jobs } = setup({ machines: { machines: [{ name: "box", via: true, target: "x" }] } });
  const job = await jobs.start(down());
  assert.equal(job.state, "failed");
  assert.equal(job.error, "box is connected via a command, not SSH; filer-pro needs SSH");
  assert.equal(f.hcRuns().length, 0);
  assert.deepEqual(f.notifications, [{ title: "Download failed", body: job.error, level: "error" }]);
  assert.equal(f.jobs().id1.state, "failed");
});

test("hc run failure fails the job", async () => {
  const { f, jobs } = setup({ runError: "no space left" });
  const job = await jobs.start(down());
  assert.equal(job.state, "failed");
  assert.equal(job.error, "no space left");
});

test("total probe throws: total and percent are null, job still runs", async () => {
  const { f, jobs } = setup({ sizeError: new Error("unreachable") });
  const job = await jobs.start(down());
  assert.equal(job.total, null);
  assert.equal(job.percent, null);
  assert.equal(job.state, "running");
  assert.equal(f.hcRuns().length, 1);
});

test("total probe slower than 25 s: total is null", async () => {
  const { f, jobs } = setup({ sizeDelay: 26_000 });
  f.sizes[SRC] = 100;
  assert.equal((await jobs.start(down())).total, null);
});

test("tick updates bytes and percent from the temp file", async () => {
  const { f, jobs } = setup();
  f.sizes[SRC] = 200;
  await jobs.start(down());
  f.sizes[`${DIR}/.a.txt.fs-id1.part`] = 50;
  f.t += 2000;
  await jobs.tick();
  const j = f.jobs().id1;
  assert.equal(j.bytes, 50);
  assert.equal(j.percent, 25);
  assert.equal(j.state, "running");
  assert.ok(j.rate > 0);
});

test("tick sizes the remote temp for uploads", async () => {
  const { f, jobs } = setup();
  await jobs.start({ direction: "up", machine: "box", src: "/Users/m/a.txt", destDir: "/srv/in", choice: "new" });
  f.execCalls.length = 0;
  await jobs.tick();
  const c = f.execCalls.find((x) => x.args[0] === "-c");
  assert.equal(c.args[3], "/srv/in/.a.txt.fs-id1.part");
  assert.equal(c.on, "box");
});

test("finished terminal with state=done: job done, terminal removed, success toast", async () => {
  const { f, jobs } = setup();
  await jobs.start(down());
  f.terminals["term-fs-id1"] = { state: "finished", exit_code: 0 };
  f.files[STATUS] = "state=done\ncode=0\n";
  await jobs.tick();
  assert.equal(f.jobs().id1.state, "done");
  assert.equal(f.jobs().id1.percent, 100);
  assert.deepEqual(f.hcCalls.at(-1), ["rm", "term-fs-id1"]);
  assert.deepEqual(f.notifications, [{ title: "Downloaded", body: "a.txt", level: "success", action: { name: "filer-pro.reveal" } }]);
  assert.equal(f.store["filer-pro.last_download"], `${DIR}/a.txt`);
  assert.deepEqual(f.execsOf("rm").at(-1).args, ["-f", "--", STATUS]);
});

test("a finished copy-instead job empties the Cut clipboard, a failed one keeps it", async () => {
  for (const [status, kept] of [["state=done\ncode=0\n", false], ["state=failed\ncode=1\nboom\n", true]]) {
    const { f, jobs } = setup();
    await jobs.start(down());
    f.store["filer-pro.clipboard"] = { machine: "box", path: SRC, isDir: false, at: 1, cut: true, copyJobs: ["id1"] };
    f.terminals["term-fs-id1"] = { state: "finished", exit_code: 0 };
    f.files[STATUS] = status;
    await jobs.tick();
    assert.equal(f.store["filer-pro.clipboard"] !== null, kept);
  }
  const { f, jobs } = setup(); // a clipboard that names another job stays
  await jobs.start(down());
  f.store["filer-pro.clipboard"] = { machine: "box", path: SRC, isDir: false, at: 1, cut: true, copyJobs: ["other"] };
  f.terminals["term-fs-id1"] = { state: "finished", exit_code: 0 };
  f.files[STATUS] = "state=done\ncode=0\n";
  await jobs.tick();
  assert.ok(f.store["filer-pro.clipboard"]);
});

test("upload done toast has no reveal action", async () => {
  const { f, jobs } = setup();
  await jobs.start({ direction: "up", machine: "box", src: "/Users/m/a.txt", destDir: "/srv/in", choice: "new" });
  f.terminals["term-fs-id1"] = { state: "finished" };
  f.files[STATUS] = "state=done\ncode=0\n";
  await jobs.tick();
  assert.deepEqual(f.notifications, [{ title: "Uploaded", body: "a.txt", level: "success" }]);
  assert.equal(f.store["filer-pro.last_download"], undefined);
});

const LOADS = `/Users/m/.config/herdr-app/data/filer-pro/loads/${"a".repeat(64)}`, AS = `${"a".repeat(64)}.pdf`;
test("a preview job (Load in the file view) carries preview: true, lands under `as`, keeps the source name, ends quietly", async () => {
  const { f, jobs } = setup();
  const job = await jobs.start(down({ destDir: LOADS, preview: true, as: AS }));
  assert.equal(job.preview, true);
  assert.equal(f.jobs().id1.preview, true);
  assert.equal(f.jobs().id1.dest, `${LOADS}/${AS}`, "a fixed file name: no odd source name reaches image()");
  assert.equal(f.jobs().id1.temp, `${LOADS}/.${AS}.fs-id1.part`);
  assert.equal(f.jobs().id1.name, "a.txt", "the transfers bar shows the source name");
  assert.deepEqual(f.hcRuns()[0].slice(13, 16), [SRC, `${LOADS}/${AS}`, `${LOADS}/.${AS}.fs-id1.part`]);
  f.terminals["term-fs-id1"] = { state: "finished", exit_code: 0 };
  f.files[STATUS] = "state=done\ncode=0\n";
  await jobs.tick();
  assert.equal(f.jobs().id1.state, "done");
  assert.deepEqual(f.notifications, []);
  assert.equal(f.store["filer-pro.last_download"], undefined);
  assert.equal(f.store["filer-pro.changed"], undefined);
  assert.equal(f.execsOf("open").length, 0);
});

test("a failed or cancelled preview job has no toast; a normal job keeps its toasts", async () => {
  const { f, jobs } = setup();
  await jobs.start(down({ destDir: LOADS, preview: true, as: AS }));
  f.terminals["term-fs-id1"] = { state: "finished", exit_code: 1 };
  f.files[STATUS] = "state=failed\ncode=1\nboom\n";
  await jobs.tick();
  assert.equal(f.jobs().id1.state, "failed");
  assert.equal(f.jobs().id1.error, "boom");
  assert.deepEqual(f.notifications, []);
  const { f: g, jobs: j2 } = setup();
  await j2.start(down());
  assert.equal(g.jobs().id1.preview, undefined, "a normal job has no preview flag");
  assert.equal(g.jobs().id1.dest, `${DIR}/a.txt`, "without `as` the destination keeps the source name");
  g.terminals["term-fs-id1"] = { state: "finished", exit_code: 1 };
  g.files[STATUS] = "state=failed\ncode=1\nboom\n";
  await j2.tick();
  assert.deepEqual(g.notifications, [{ title: "Download failed", body: "boom", level: "error" }]);
});

test("failed status with host key error gives the host-key text", async () => {
  const { f, jobs } = setup();
  await jobs.start(down());
  f.terminals["term-fs-id1"] = { state: "finished", exit_code: 1 };
  f.files[STATUS] = "state=failed\ncode=1\nHost key verification failed.\n";
  await jobs.tick();
  const j = f.jobs().id1;
  assert.equal(j.state, "failed");
  assert.equal(j.error, "Unknown host key. Connect once in a terminal: ssh user@box");
  assert.deepEqual(f.notifications[0], { title: "Download failed", body: j.error, level: "error" });
});

test("finished without status file: killed means cancelled, otherwise failed", async () => {
  const a = setup();
  await a.jobs.start(down());
  a.f.terminals["term-fs-id1"] = { state: "finished", reason: "killed", signal: 1 };
  await a.jobs.tick();
  assert.equal(a.f.jobs().id1.state, "cancelled");
  assert.equal(a.f.notifications.length, 0);

  const b = setup();
  await b.jobs.start(down());
  b.f.terminals["term-fs-id1"] = { state: "finished", exit_code: 3 };
  await b.jobs.tick();
  assert.equal(b.f.jobs().id1.state, "failed");
  assert.equal(b.f.jobs().id1.error, "Transfer ended unexpectedly");
});

test("stalled job whose status says cancelled still ends failed", async () => {
  const { f, jobs } = setup();
  await jobs.start(down());
  f.sizes[`${DIR}/.a.txt.fs-id1.part`] = 10;
  f.t += 1000;
  await jobs.tick();
  f.t += 121_000;
  // the terminal already finished (killed itself) in the same tick the stall is seen
  f.files[STATUS] = "state=cancelled\ncode=130\n";
  f.terminals["term-fs-id1"] = { state: "finished", reason: "killed" };
  await jobs.tick();
  assert.equal(f.jobs().id1.state, "failed");
  assert.equal(f.jobs().id1.error, "Transfer stalled");
});

test("cancel kills the terminal; tick with state=cancelled ends cancelled", async () => {
  const { f, jobs } = setup();
  await jobs.start(down());
  await jobs.cancel("id1");
  assert.deepEqual(f.hcCalls.filter((a) => a[0] === "kill"), [["kill", "term-fs-id1"]]);
  assert.equal(f.jobs().id1.state, "running");
  f.files[STATUS] = "state=cancelled\ncode=130\n";
  await jobs.tick();
  assert.equal(f.jobs().id1.state, "cancelled");
  assert.equal(f.notifications.length, 0);
});

test("recover: unknown terminal and no status file: failed Interrupted, temp removed", async () => {
  const { f, jobs } = setup();
  await jobs.start(down());
  f.getFail = true;
  await jobs.recover();
  const j = f.jobs().id1;
  assert.equal(j.state, "failed");
  assert.equal(j.error, "Interrupted");
  const rm = f.execsOf("rm").find((c) => c.args.includes(`${DIR}/.a.txt.fs-id1.part`));
  assert.deepEqual(rm.args, ["-rf", "--", `${DIR}/.a.txt.fs-id1.part`]);
  assert.equal(rm.on, null);
});

test("recover: upload temp is removed on the remote side", async () => {
  const { f, jobs } = setup();
  await jobs.start({ direction: "up", machine: "box", src: "/Users/m/a.txt", destDir: "/srv/in", choice: "new" });
  f.getFail = true;
  await jobs.recover();
  const rm = f.execsOf("rm").find((c) => c.args.includes("/srv/in/.a.txt.fs-id1.part"));
  assert.equal(rm.on, "box");
});

test("recover: unknown terminal but status file present uses it", async () => {
  const { f, jobs } = setup();
  await jobs.start(down());
  f.getFail = true;
  f.files[STATUS] = "state=done\ncode=0\n";
  await jobs.recover();
  assert.equal(f.jobs().id1.state, "done");
});

test("recover: live terminal keeps the job running", async () => {
  const { f, jobs } = setup();
  await jobs.start(down());
  await jobs.recover();
  assert.equal(f.jobs().id1.state, "running");
});

function withDirs(f, ...dirs) {
  for (const d of dirs) {
    f.existing.add(d);
    f.dirs.add(d);
  }
}

test("inspect file: exists on the local destination, no link check", async () => {
  const { f, jobs } = setup();
  f.existing.add(SRC);
  f.existing.add(`${DIR}/a.txt`);
  withDirs(f, DIR);
  const r = await jobs.inspect({ direction: "down", machine: "box", src: SRC, destDir: DIR });
  assert.deepEqual(r, { name: "a.txt", isDir: false, exists: true, destIsDir: false, linkWarning: null, linkTitle: null });
  const sides = f.execCalls.map((c) => [c.args[3], c.on]);
  assert.deepEqual(sides, [[SRC, "box"], [DIR, null], [`${DIR}/a.txt`, null]]);
});

test("inspect upload checks the destination on the remote machine", async () => {
  const { f, jobs } = setup();
  f.existing.add("/Users/m/a.txt");
  withDirs(f, "/srv/in");
  const r = await jobs.inspect({ direction: "up", machine: "box", src: "/Users/m/a.txt", destDir: "/srv/in" });
  assert.equal(r.exists, false);
  assert.deepEqual(f.execCalls.map((c) => [c.args[3], c.on]), [["/Users/m/a.txt", null], ["/srv/in", "box"], ["/srv/in/a.txt", "box"]]);
});

test("inspect up of a folder: source and links local, target folder and target on the machine", async () => {
  const { f, jobs } = setup();
  f.existing.add("/Users/m/dir");
  f.dirs.add("/Users/m/dir");
  withDirs(f, "/srv/in");
  f.links = "";
  const r = await jobs.inspect({ direction: "up", machine: "box", src: "/Users/m/dir", destDir: "/srv/in" });
  assert.equal(r.isDir, true);
  const sides = f.execCalls.map((c) => [c.args[2], c.args[3], c.on]);
  assert.deepEqual(sides.find((c) => c[0] === "links"), ["links", "/Users/m/dir", null]);
  assert.deepEqual(sides.filter((c) => c[0] !== "links").map((c) => [c[1], c[2]]), [["/Users/m/dir", null], ["/srv/in", "box"], ["/srv/in/dir", "box"]]);
});

test("inspect down: missing target folder is an error, no link check", async () => {
  const { f, jobs } = setup();
  f.existing.add("/srv/data");
  f.dirs.add("/srv/data");
  const r = await jobs.inspect({ direction: "down", machine: "box", src: "/srv/data", destDir: DIR });
  assert.equal(r.error, `Target folder does not exist: ${DIR}`);
  assert.equal(f.execCalls.some((c) => c.args[2] === "links"), false);
});

test("inspect up: missing remote target folder is an error, checked on the machine", async () => {
  const { f, jobs } = setup();
  f.existing.add("/Users/m/a.txt");
  const r = await jobs.inspect({ direction: "up", machine: "box", src: "/Users/m/a.txt", destDir: "/srv/in" });
  assert.equal(r.error, "Target folder does not exist: /srv/in");
  assert.equal(f.execCalls.find((c) => c.args[3] === "/srv/in").on, "box");
});

test("inspect: unknown machine", async () => {
  const { f, jobs } = setup();
  f.exec = async (cmd, args = [], opts = {}) => {
    f.execCalls.push({ cmd, args, on: opts.on ?? null });
    throw new Error('`herdr.exec`: unknown machine "nope"');
  };
  const j = createJobs({ ...f.deps(), exec: f.exec });
  const r = await j.inspect({ direction: "down", machine: "nope", src: SRC, destDir: DIR });
  assert.equal(r.error, "Unknown machine: nope");
});

test("inspect folder with outside link warns; check runs at the source", async () => {
  const { f, jobs } = setup();
  f.existing.add("/srv/a");
  f.dirs.add("/srv/a");
  withDirs(f, DIR);
  f.links = "outside\0data\0/mnt/archive\0total=1 outside=1 loop=0\n";
  const r = await jobs.inspect({ direction: "down", machine: "box", src: "/srv/a", destDir: DIR });
  assert.equal(r.isDir, true);
  assert.equal(r.linkTitle, "Symlink found!");
  assert.equal(r.linkWarning, '"a" contains 1 symlink pointing outside it (e.g. data → /mnt/archive). scp copies what it points to.');
  const linkCall = f.execCalls.find((c) => c.args[2] === "links");
  assert.equal(linkCall.on, "box");
});

test("inspect folder: failed or unreadable link check gives the could-not-check text", async () => {
  for (const over of [{ linksReject: true }, { linksCode: 1 }, { links: "garbage" }]) {
    const { f, jobs } = setup(over);
    f.existing.add("/srv/a");
    f.dirs.add("/srv/a");
    withDirs(f, DIR);
    const r = await jobs.inspect({ direction: "down", machine: "box", src: "/srv/a", destDir: DIR });
    assert.equal(r.linkTitle, "Could not check symlinks");
    assert.equal(r.linkWarning, 'Could not check "a" for symlinks. If it has any, scp copies what they point to.');
  }
});

test("inspect: missing source and exec failure give an error", async () => {
  const a = setup();
  const r = await a.jobs.inspect({ direction: "down", machine: "box", src: SRC, destDir: DIR });
  assert.equal(r.error, `No such file or folder: ${SRC}`);
  const b = setup({ execReject: new Error("Connection timed out") });
  b.f.exec = async () => { throw new Error("Connection timed out"); };
  const jobs = createJobs({ ...b.f.deps(), exec: b.f.exec });
  const r2 = await jobs.inspect({ direction: "down", machine: "box", src: SRC, destDir: DIR });
  assert.equal(r2.error, "Machine not reachable");
});

test("clearFinished drops done and cancelled after 10 s, failed stays until dismissed", async () => {
  const { f, jobs } = setup();
  for (const id of ["a", "b", "c", "d"]) {
    f.store["filer-pro.jobs"] = {
      ...f.jobs(),
      [id]: { id, state: { a: "done", b: "cancelled", c: "failed", d: "running" }[id], finishedAt: f.t },
    };
  }
  f.t += 9_000;
  jobs.clearFinished();
  assert.equal(Object.keys(f.jobs()).length, 4);
  f.t += 2_000;
  jobs.clearFinished();
  assert.deepEqual(Object.keys(f.jobs()).sort(), ["c", "d"]);
  jobs.dismiss("d");
  assert.deepEqual(Object.keys(f.jobs()).sort(), ["c", "d"]);
  jobs.dismiss("c");
  assert.deepEqual(Object.keys(f.jobs()), ["d"]);
});

test("stall: tick kills and returns, job stays running; later done wins", async () => {
  const { f, jobs } = setup();
  f.sizes[SRC] = 100;
  await jobs.start(down());
  f.sizes[`${DIR}/.a.txt.fs-id1.part`] = 10;
  f.t += 1000;
  await jobs.tick();
  f.t += 121_000;
  await jobs.tick();
  assert.deepEqual(f.hcCalls.filter((a) => a[0] === "kill"), [["kill", "term-fs-id1"]]);
  assert.equal(f.jobs().id1.state, "running");
  assert.equal(f.jobs().id1.stalled, true);
  assert.equal(f.hcCalls.filter((a) => a[0] === "rm").length, 0);
  // finalization ignored the kill and finished successfully
  f.terminals["term-fs-id1"] = { state: "finished", exit_code: 0 };
  f.files[STATUS] = "state=done\ncode=0\n";
  f.t += 1000;
  await jobs.tick();
  assert.equal(f.jobs().id1.state, "done");
  assert.equal(f.hcCalls.filter((a) => a[0] === "kill").length, 1);
});

test("stall: later cancelled status ends failed Transfer stalled", async () => {
  const { f, jobs } = setup();
  f.sizes[SRC] = 100;
  await jobs.start(down());
  f.sizes[`${DIR}/.a.txt.fs-id1.part`] = 10;
  f.t += 1000;
  await jobs.tick();
  f.t += 121_000;
  await jobs.tick();
  f.files[STATUS] = "state=cancelled\ncode=130\n";
  f.t += 1000;
  await jobs.tick();
  assert.equal(f.jobs().id1.state, "failed");
  assert.equal(f.jobs().id1.error, "Transfer stalled");
});

test("a missing temp for over 120 s does not stall", async () => {
  const { f, jobs } = setup();
  await jobs.start(down());
  for (let i = 0; i < 3; i++) {
    f.t += 60_000;
    await jobs.tick();
  }
  assert.equal(f.jobs().id1.state, "running");
  assert.equal(f.hcCalls.filter((a) => a[0] === "kill").length, 0);
});

test("hc machine ls rejecting fails the job with a toast", async () => {
  const { f, jobs } = setup({ machineReject: new Error("Connection timed out") });
  const job = await jobs.start(down());
  assert.equal(job.state, "failed");
  assert.equal(job.error, "Machine not reachable");
  assert.equal(f.notifications.length, 1);
  assert.equal(f.hcRuns().length, 0);
});

test("inspect: ssh failure (code 255) is reported, not read as a missing file", async () => {
  const fail255 = () => ({ code: 255, stderr: "Host key verification failed." });
  const a = setup();
  a.f.execCode = fail255;
  const r = await a.jobs.inspect({ direction: "down", machine: "box", src: SRC, destDir: DIR });
  assert.equal(r.error, "Unknown host key. Connect once in a terminal: ssh box");

  const b = setup();
  b.f.existing.add("/Users/m/a.txt");
  withDirs(b.f, "/srv/in");
  b.f.execCode = (p) => (p === "/srv/in/a.txt" ? fail255() : null);
  const r2 = await b.jobs.inspect({ direction: "up", machine: "box", src: "/Users/m/a.txt", destDir: "/srv/in" });
  assert.equal(r2.error, "Unknown host key. Connect once in a terminal: ssh box");
});

test("cancel during the size measurement ends cancelled without hc run", async () => {
  const { f, jobs } = setup();
  f.onSize = () => {
    f.onSize = null;
    jobs.cancel("id1");
  };
  const job = await jobs.start(down());
  assert.equal(job.state, "cancelled");
  assert.equal(f.hcRuns().length, 0);
  assert.equal(f.notifications.length, 0);
});

test("cancel during hc run kills the new terminal right away", async () => {
  const { f, jobs } = setup();
  f.onRun = () => jobs.cancel("id1");
  const job = await jobs.start(down());
  assert.equal(job.state, "running");
  assert.deepEqual(f.hcCalls.filter((a) => a[0] === "kill"), [["kill", "term-fs-id1"]]);
  await jobs.tick();
  assert.equal(f.jobs().id1.state, "cancelled");
});

test("reveal:true reveals the finished download; without it nothing is run", async () => {
  for (const reveal of [true, false]) {
    const { f, jobs } = setup();
    await jobs.start(down(reveal ? { reveal } : {}));
    f.terminals["term-fs-id1"] = { state: "finished", exit_code: 0 };
    f.files[STATUS] = "state=done\ncode=0\n";
    await jobs.tick();
    const open = f.execsOf("open");
    if (reveal) assert.deepEqual(open[0].args, ["-R", `${DIR}/a.txt`]);
    else assert.equal(open.length, 0);
  }
});

const openChecks = (f) => f.execsOf("sh").filter((c) => c.args[1] === OPEN_CHECK_SCRIPT);
const settle = () => new Promise((r) => setImmediate(r));

test('reveal:"open" runs the open check with the default opener after done, "preview" with -a Preview', async () => {
  for (const [reveal, tail] of [["open", ["open"]], ["preview", ["open", "-a", "Preview"]]]) {
    const { f, jobs } = setup();
    await jobs.start(down({ reveal }));
    assert.equal(f.jobs().id1.reveal, reveal);
    f.terminals["term-fs-id1"] = { state: "finished", exit_code: 0 };
    f.files[STATUS] = "state=done\ncode=0\n";
    await jobs.tick();
    await settle(); // the open check follows the xattr call
    assert.deepEqual(f.execsOf("xattr").map((c) => c.args.slice(0, 2)), [["-w", "com.apple.quarantine"]]);
    assert.equal(f.execsOf("xattr")[0].args[3], `${DIR}/a.txt`);
    assert.deepEqual(openChecks(f).map((c) => c.args), [["-c", OPEN_CHECK_SCRIPT, "sh", `${DIR}/a.txt`, ...tail]]);
    assert.ok(f.execCalls.findIndex((c) => c.cmd === "xattr") < f.execCalls.findIndex((c) => c.args[1] === OPEN_CHECK_SCRIPT));
    assert.equal(f.execsOf("open").length, 0); // no Finder reveal for open/preview
    assert.equal(f.jobs().id1.state, "done");
  }
});

test("no open after a failed or cancelled job, none after an upload", async () => {
  for (const status of ["state=failed\ncode=1\nboom\n", "state=cancelled\ncode=130\n"]) {
    const { f, jobs } = setup();
    await jobs.start(down({ reveal: "open" }));
    f.terminals["term-fs-id1"] = { state: "finished", exit_code: 1 };
    f.files[STATUS] = status;
    await jobs.tick();
    await settle();
    assert.equal(openChecks(f).length, 0);
    assert.equal(f.execsOf("xattr").length, 0);
  }
  const { f, jobs } = setup();
  await jobs.start({ direction: "up", machine: "box", src: "/Users/m/a.txt", destDir: "/srv/in", choice: "new", reveal: "open" });
  f.terminals["term-fs-id1"] = { state: "finished", exit_code: 0 };
  f.files[STATUS] = "state=done\ncode=0\n";
  await jobs.tick();
  await settle();
  assert.equal(openChecks(f).length, 0);
  assert.equal(f.execsOf("xattr").length, 0);
});

// ---- local mode (Task 8c)
const LOCAL = { direction: "local", machine: null, src: "/Users/m/Desktop/a.png", destDir: "/Users/m/git/x", choice: "new" };

test("start local: no hc machine ls, target is '-', temp next to the destination", async () => {
  const { f, jobs } = setup();
  const job = await jobs.start(LOCAL);
  assert.equal(f.hcCalls.some((a) => a[0] === "machine"), false);
  assert.deepEqual(f.hcRuns()[0].slice(8), [
    "sh", "/Users/m/.config/herdr-app/mods/filer-pro/bin/transfer.sh",
    "local", "new", "-", "/Users/m/Desktop/a.png", "/Users/m/git/x/a.png", "/Users/m/git/x/.a.png.fs-id1.part",
    STATUS, "/Users/m/.Trash",
  ]);
  assert.equal(job.machine, null);
  assert.equal(job.target, null);
  assert.equal(job.direction, "local");
  assert.ok(f.execCalls.every((c) => c.on === null));
});

test("inspect local: everything on this machine, no link check", async () => {
  const { f, jobs } = setup();
  f.existing.add("/Users/m/p");
  f.dirs.add("/Users/m/p");
  withDirs(f, "/Users/m/q");
  const r = await jobs.inspect({ direction: "local", machine: null, src: "/Users/m/p", destDir: "/Users/m/q" });
  assert.deepEqual(r, { name: "p", isDir: true, exists: false, linkWarning: null, linkTitle: null });
  assert.ok(f.execCalls.every((c) => c.on === null));
  assert.equal(f.execCalls.some((c) => c.args[2] === "links"), false);
});

test("inspect local: a folder cannot be copied into itself or a subfolder", async () => {
  const { f, jobs } = setup();
  f.existing.add("/Users/m/p");
  f.dirs.add("/Users/m/p");
  withDirs(f, "/Users/m/p/sub", "/Users/m/p2");
  for (const destDir of ["/Users/m/p", "/Users/m/p/sub"]) {
    const r = await jobs.inspect({ direction: "local", machine: null, src: "/Users/m/p", destDir });
    assert.equal(r.error, "Cannot copy a folder into itself");
  }
  const ok = await jobs.inspect({ direction: "local", machine: null, src: "/Users/m/p", destDir: "/Users/m/p2" });
  assert.equal(ok.error, undefined);
});

test("keep_both local lists with on null; tick measures the temp with on null", async () => {
  const { f, jobs } = setup();
  f.listings["/Users/m/git/x"] = ["a.png"];
  const job = await jobs.start({ ...LOCAL, choice: "keep_both" });
  assert.equal(job.dest, "/Users/m/git/x/a-1.png");
  assert.ok(f.execCalls.every((c) => c.on === null));
  f.execCalls.length = 0;
  await jobs.tick();
  assert.equal(f.execCalls[0].args[3], "/Users/m/git/x/.a-1.png.fs-id1.part");
  assert.equal(f.execCalls[0].on, null);
});

test("keep_both reservation compares the destination side, not the direction (R68)", async () => {
  const { f, jobs } = setup();
  await jobs.start(down({ src: "/srv/a.txt", destDir: "/Users/m/Downloads", choice: "new" }));
  const j = await jobs.start({ direction: "local", machine: null, src: "/Users/m/Desktop/a.txt", destDir: "/Users/m/Downloads", choice: "keep_both" });
  assert.equal(j.dest, "/Users/m/Downloads/a-1.txt");

  const g = setup();
  await g.jobs.start({ direction: "up", machine: "box", src: "/Users/m/a.txt", destDir: "/srv/in", choice: "new" });
  const k = await g.jobs.start({ direction: "local", machine: null, src: "/Users/m/Desktop/a.txt", destDir: "/srv/in", choice: "keep_both" });
  assert.equal(k.dest, "/srv/in/a.txt");
});

test("local done: Copied toast with reveal action, last_download set", async () => {
  const { f, jobs } = setup();
  await jobs.start(LOCAL);
  f.terminals["term-fs-id1"] = { state: "finished", exit_code: 0 };
  f.files[STATUS] = "state=done\ncode=0\n";
  await jobs.tick();
  assert.deepEqual(f.notifications, [{ title: "Copied", body: "a.png", level: "success", action: { name: "filer-pro.reveal" } }]);
  assert.equal(f.store["filer-pro.last_download"], "/Users/m/git/x/a.png");
  assert.equal(f.execsOf("open").length, 0);
});

test("local failed: Copy failed toast", async () => {
  const { f, jobs } = setup();
  await jobs.start(LOCAL);
  f.terminals["term-fs-id1"] = { state: "finished", exit_code: 1 };
  f.files[STATUS] = "state=failed\ncode=1\ncp: boom\n";
  await jobs.tick();
  assert.equal(f.jobs().id1.state, "failed");
  assert.equal(f.notifications[0].title, "Copy failed");
  assert.equal(f.notifications[0].level, "error");
});

test("local reveal:true opens the Finder after done", async () => {
  const { f, jobs } = setup();
  await jobs.start({ ...LOCAL, reveal: true });
  f.terminals["term-fs-id1"] = { state: "finished", exit_code: 0 };
  f.files[STATUS] = "state=done\ncode=0\n";
  await jobs.tick();
  assert.deepEqual(f.execsOf("open")[0].args, ["-R", "/Users/m/git/x/a.png"]);
});

test("inspect local: self-copy guard compares resolved paths (R70)", async () => {
  const insp = (f, jobs, destDir, src = "/Users/m/git/Proj") => jobs.inspect({ direction: "local", machine: null, src, destDir });
  // symlinked destination folder that points into the source
  let { f, jobs } = setup();
  withDirs(f, "/Users/m/git/Proj", "/Users/m/link");
  f.resolved["/Users/m/link"] = "/Users/m/git/Proj/sub";
  assert.equal((await insp(f, jobs, "/Users/m/link")).error, "Cannot copy a folder into itself");
  // same folder under another spelling (symlinked source)
  ({ f, jobs } = setup());
  withDirs(f, "/tmp/p", "/Users/m/p");
  f.resolved["/tmp/p"] = "/private/tmp/p";
  f.resolved["/Users/m/p"] = "/private/tmp/p";
  assert.equal((await insp(f, jobs, "/Users/m/p", "/tmp/p")).error, "Cannot copy a folder into itself");
  // letter case (macOS)
  ({ f, jobs } = setup());
  withDirs(f, "/Users/m/git/Proj", "/Users/m/git/proj/sub");
  assert.equal((await insp(f, jobs, "/Users/m/git/proj/sub")).error, "Cannot copy a folder into itself");
  // sibling with the same prefix and a normal other folder are fine
  ({ f, jobs } = setup());
  withDirs(f, "/Users/m/git/Proj", "/Users/m/git/Proj2", "/Users/m/other");
  assert.equal((await insp(f, jobs, "/Users/m/git/Proj2")).error, undefined);
  assert.equal((await insp(f, jobs, "/Users/m/other")).error, undefined);
});

test("inspect local: resolution failure falls back to the spelled paths", async () => {
  const { f, jobs } = setup({ resolveFail: true });
  withDirs(f, "/Users/m/p", "/Users/m/p/sub", "/Users/m/q");
  assert.equal((await jobs.inspect({ direction: "local", machine: null, src: "/Users/m/p", destDir: "/Users/m/p/sub" })).error, "Cannot copy a folder into itself");
  assert.equal((await jobs.inspect({ direction: "local", machine: null, src: "/Users/m/p", destDir: "/Users/m/q" })).error, undefined);
});

test("failed status with CRLF stderr (A4): job error has no carriage return", async () => {
  const { f, jobs } = setup();
  await jobs.start(down());
  f.terminals["term-fs-id1"] = { state: "finished", exit_code: 1 };
  f.files[STATUS] = 'state=failed\ncode=1\nscp: open local "/x/.a.part": Read-only file system\r\n';
  await jobs.tick();
  const j = f.jobs().id1;
  assert.equal(j.error, "Cannot write to the target folder: Read-only file system");
  assert.equal(f.notifications[0].body, j.error);
});

test("inspect folder with a loop (and an outside link) is blocked; example is the loop link", async () => {
  const { f, jobs } = setup();
  f.existing.add("/srv/a");
  f.dirs.add("/srv/a");
  withDirs(f, DIR);
  f.links = "outside\0ext\0/mnt/o\0loop\0self\0/srv/a\0total=2 outside=1 loop=1\n";
  const r = await jobs.inspect({ direction: "down", machine: "box", src: "/srv/a", destDir: DIR });
  assert.equal(r.linkBlocked, true);
  assert.equal(r.linkWarning, '"a" contains 1 symlink looping back into it (e.g. self → /srv/a). scp cannot transfer a folder with a symlink loop.');
  f.links = "outside\0ext\0/mnt/o\0total=1 outside=1 loop=0\n";
  const o = await jobs.inspect({ direction: "down", machine: "box", src: "/srv/a", destDir: DIR });
  assert.equal(o.linkBlocked, undefined);
});

// ---- remote copy: source and target on the same machine
const REMOTE = { direction: "remote", machine: "box", src: "/srv/data/a.txt", destDir: "/srv/in", choice: "new" };

test("start remote: hc machine ls, transfer.sh remote with the ssh target", async () => {
  const { f, jobs } = setup();
  const job = await jobs.start(REMOTE);
  assert.equal(f.hcCalls[0][0], "machine");
  assert.deepEqual(f.hcRuns()[0].slice(10), ["remote", "new", "user@box", "/srv/data/a.txt", "/srv/in/a.txt", "/srv/in/.a.txt.fs-id1.part", STATUS, "/Users/m/.Trash"]);
  assert.equal(job.direction, "remote");
  assert.equal(job.target, "user@box");
  const sizing = f.execsOf("sh").filter((c) => c.args[1] === SIZE_SCRIPT);
  assert.ok(sizing.length > 0 && sizing.every((c) => c.on === "box"), "the source is measured on the machine");
});

test("inspect remote: source, target folder and target on the machine, no link check", async () => {
  const { f, jobs } = setup();
  withDirs(f, "/srv/data/d", "/srv/in");
  const r = await jobs.inspect({ direction: "remote", machine: "box", src: "/srv/data/d", destDir: "/srv/in" });
  assert.deepEqual(r, { name: "d", isDir: true, exists: false, linkWarning: null, linkTitle: null });
  assert.ok(f.execsOf("sh").every((c) => c.on === "box"));
  assert.equal(f.execsOf("sh").some((c) => c.args[1] === LINKS_SCRIPT), false);
});

test("inspect remote: a folder cannot be pasted into itself; the machine compares exactly", async () => {
  const mk = () => { const x = setup(); withDirs(x.f, "/srv/p", "/srv/p/sub", "/srv/P"); return x; };
  for (const destDir of ["/srv/p", "/srv/p/sub"]) {
    const { jobs } = mk();
    const r = await jobs.inspect({ direction: "remote", machine: "box", src: "/srv/p", destDir });
    assert.equal(r.error, "Cannot copy a folder into itself", destDir);
  }
  const { f, jobs } = mk();
  const ok = await jobs.inspect({ direction: "remote", machine: "box", src: "/srv/p", destDir: "/srv/P" });
  assert.equal(ok.error, undefined);
  const resolves = f.execsOf("sh").filter((c) => c.args[1] === RESOLVE_SCRIPT);
  assert.ok(resolves.length > 0 && resolves.every((c) => c.on === "box"));
});

test("remote tick measures the temp on the machine; done gives Copied without reveal and sets filer-pro.changed", async () => {
  const { f, jobs } = setup();
  const job = await jobs.start(REMOTE);
  f.files[STATUS] = "state=done\ncode=0\n";
  f.terminals[job.terminal] = { state: "finished", reason: "exited" };
  await jobs.tick();
  const sizes = f.execsOf("sh").filter((c) => c.args[1] === SIZE_SCRIPT && c.args[3] === job.temp);
  assert.ok(sizes.length > 0 && sizes.every((c) => c.on === "box"));
  assert.deepEqual(f.notifications.at(-1), { title: "Copied", body: "a.txt", level: "success" });
  assert.equal(f.execsOf("open").length, 0);
  assert.equal(f.store["filer-pro.last_download"], undefined);
  assert.deepEqual(f.store["filer-pro.changed"], { at: f.t });
});

test("remote failed: Copy failed toast, no filer-pro.changed", async () => {
  const { f, jobs } = setup({ runError: "boom" });
  await jobs.start(REMOTE);
  assert.equal(f.notifications.at(-1).title, "Copy failed");
  assert.equal(f.store["filer-pro.changed"], undefined);
});

test("a finished download also sets filer-pro.changed", async () => {
  const { f, jobs } = setup();
  const job = await jobs.start(down());
  f.files[STATUS] = "state=done\ncode=0\n";
  f.terminals[job.terminal] = { state: "finished", reason: "exited" };
  await jobs.tick();
  assert.deepEqual(f.store["filer-pro.changed"], { at: f.t });
});

test("a cancelled job does not set filer-pro.changed", async () => {
  const { f, jobs } = setup();
  const job = await jobs.start(REMOTE);
  f.files[STATUS] = "state=cancelled\ncode=130\n";
  f.terminals[job.terminal] = { state: "finished", reason: "exited" };
  await jobs.tick();
  assert.equal(f.jobs().id1.state, "cancelled");
  assert.equal(f.store["filer-pro.changed"], undefined);
});

test("killed before it could report: the temp is removed on the destination side", async () => {
  const { f, jobs } = setup();
  const job = await jobs.start(REMOTE);
  f.terminals[job.terminal] = { state: "finished", reason: "killed", signal: 9 };
  await jobs.tick();
  assert.equal(f.jobs().id1.state, "cancelled");
  // remote: the cp on the machine may outlive the killed transfer, so it is stopped before the temp goes
  assert.equal(f.execsOf("rm").some((c) => c.args.includes(job.temp)), false);
  const stop = f.execsOf("sh").find((c) => c.args[1] === STOP_REMOVE_SCRIPT);
  assert.deepEqual(stop && [stop.args, stop.on], [["-c", STOP_REMOVE_SCRIPT, "x", job.temp, "id1"], "box"]);
  const local = setup();
  const l = await local.jobs.start(down());
  local.f.terminals[l.terminal] = { state: "finished", reason: "killed", signal: 9 };
  await local.jobs.tick();
  assert.equal(local.f.execsOf("rm").find((c) => c.args.includes(l.temp)).on, null);
});

test("a finished job with a status file never gets its temp removed by the manager", async () => {
  const { f, jobs } = setup();
  const job = await jobs.start(REMOTE);
  f.files[STATUS] = "state=done\ncode=0\n";
  f.terminals[job.terminal] = { state: "finished", reason: "exited" };
  await jobs.tick();
  assert.equal(f.execsOf("rm").some((c) => c.args.includes(job.temp)), false);
});

test("recover with the terminal gone: a remote copy is stopped before its temp is removed", async () => {
  const { f, jobs } = setup();
  const job = await jobs.start(REMOTE);
  f.getFail = true;
  await jobs.recover();
  assert.equal(f.jobs().id1.error, "Interrupted");
  assert.equal(f.execsOf("rm").some((c) => c.args.includes(job.temp)), false);
  const stop = f.execsOf("sh").find((c) => c.args[1] === STOP_REMOVE_SCRIPT);
  assert.deepEqual(stop && [stop.args, stop.on], [["-c", STOP_REMOVE_SCRIPT, "x", job.temp, "id1"], "box"]);
});

test("STOP_REMOVE_SCRIPT stops the cp writing the temp, then removes the temp; never itself", async () => {
  const d = fs.realpathSync(mkTmpSync("jobs-stop-"));
  try {
    const id = `t${Math.random().toString(36).slice(2, 10)}`;
    const temp = `${d}/.a.fs-${id}.part`;
    fs.writeFileSync(`${d}/a`, "a");
    const marker = `7.${Math.floor(100000 + Math.random() * 899999)}`;
    const fakeCp = path.resolve(import.meta.dirname, "fake/cp");
    const cp = spawn("sh", [fakeCp, "-R", "-P", "-p", "--", `${d}/a`, temp], { env: { ...process.env, FAKE_SLEEP: marker }, stdio: "ignore" });
    const t0 = Date.now();
    while (!(fs.existsSync(temp) && spawnSync("pgrep", ["-f", `sleep ${marker}`]).status === 0) && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(temp));
    assert.equal(spawnSync("pgrep", ["-f", `sleep ${marker}`]).status, 0, "the copy should be running");
    const r = spawnSync("sh", ["-c", STOP_REMOVE_SCRIPT, "x", temp, id], { encoding: "utf8", timeout: 15000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(temp), false);
    await new Promise((res) => (cp.exitCode !== null || cp.signalCode !== null ? res() : cp.on("exit", res)));
    assert.equal(spawnSync("pgrep", ["-f", `sleep ${marker}`], { encoding: "utf8" }).stdout.trim(), "", "orphaned sleep");
    // an id outside [a-z0-9] only removes, it never becomes a pattern
    fs.writeFileSync(temp, "x");
    assert.equal(spawnSync("sh", ["-c", STOP_REMOVE_SCRIPT, "x", temp, ".*"]).status, 0);
    assert.equal(fs.existsSync(temp), false);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test("RESOLVE_SCRIPT resolves a link physically ahead of .. (Issue #14)", () => {
  const base = mkTmpSync("resolve-");
  try {
    fs.mkdirSync(path.join(base, "proj", "sub"), { recursive: true });
    fs.symlinkSync(path.join(base, "proj", "sub"), path.join(base, "link"));
    const run = (p) => spawnSync("sh", ["-c", RESOLVE_SCRIPT, "resolve", p], { encoding: "utf8" }).stdout.trim();
    const real = fs.realpathSync(base);
    // Logical cd would give the parent of the link (base); the copy itself climbs from the target (proj).
    assert.equal(run(`${base}/link/..`), path.join(real, "proj"));
    assert.equal(run(`${base}/link`), path.join(real, "proj", "sub"));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ---- Replace over a mount (issue #31): inspect reports it for up and remote, the target side checks.
const MOUNT_MSG = "Refusing to replace, a file system is mounted at: /srv/in/dir/mnt";
for (const direction of ["up", "remote"]) {
  test(`inspect ${direction}: a mount in the existing target folder gives replaceError, checked on the machine`, async () => {
    const { f, jobs } = setup();
    const src = direction === "up" ? "/Users/m/dir" : "/srv/data/dir";
    f.existing.add(src); f.dirs.add(src);
    withDirs(f, "/srv/in");
    f.existing.add("/srv/in/dir"); f.dirs.add("/srv/in/dir");
    f.mounted["/srv/in/dir"] = MOUNT_MSG;
    f.links = "";
    const r = await jobs.inspect({ direction, machine: "box", src, destDir: "/srv/in" });
    assert.equal(r.exists, true);
    assert.equal(r.replaceError, MOUNT_MSG);
    const c = f.execCalls.find((x) => x.args[1] === REPLACE_CHECK_SCRIPT);
    assert.deepEqual([c.args[3], c.on], ["/srv/in/dir", "box"]);
  });
}
for (const direction of ["down", "local"]) {
  test(`inspect ${direction}: no mount check (local Replace goes to the Trash)`, async () => {
    const { f, jobs } = setup();
    f.existing.add("/srv/data/dir"); f.dirs.add("/srv/data/dir");
    withDirs(f, DIR);
    f.existing.add(`${DIR}/dir`); f.dirs.add(`${DIR}/dir`);
    f.mounted[`${DIR}/dir`] = MOUNT_MSG;
    f.links = "";
    const r = await jobs.inspect({ direction, machine: direction === "local" ? null : "box", src: "/srv/data/dir", destDir: DIR });
    assert.equal(r.replaceError, undefined);
    assert.equal(f.execCalls.some((x) => x.args[1] === REPLACE_CHECK_SCRIPT), false);
  });
}
test("inspect up: a file as the existing target needs no mount check", async () => {
  const { f, jobs } = setup();
  f.existing.add("/Users/m/a.txt");
  withDirs(f, "/srv/in");
  f.existing.add("/srv/in/a.txt");
  const r = await jobs.inspect({ direction: "up", machine: "box", src: "/Users/m/a.txt", destDir: "/srv/in" });
  assert.deepEqual(r, { name: "a.txt", isDir: false, exists: true, destIsDir: false, linkWarning: null, linkTitle: null });
  assert.equal(f.execCalls.some((x) => x.args[1] === REPLACE_CHECK_SCRIPT), false);
});
test("inspect passes the test mount tables to the check", async () => {
  const f = createFake();
  const jobs = createJobs({ ...f.deps(), mountTables: ["/t/info", "/t/mount"] });
  f.existing.add("/Users/m/dir"); f.dirs.add("/Users/m/dir");
  withDirs(f, "/srv/in");
  f.existing.add("/srv/in/dir"); f.dirs.add("/srv/in/dir");
  f.links = "";
  await jobs.inspect({ direction: "up", machine: "box", src: "/Users/m/dir", destDir: "/srv/in" });
  assert.deepEqual(f.execCalls.find((x) => x.args[1] === REPLACE_CHECK_SCRIPT).args.slice(3), ["/srv/in/dir", "/t/info", "/t/mount"]);
});

// REPLACE_CHECK_SCRIPT on the real file system, with tables standing in for /proc/self/mountinfo.
test("REPLACE_CHECK_SCRIPT: mount below, through a linked path, link as target, no mount, missing folder", () => {
  const d = mkTmpSync("filer-pro-rc-");
  try {
    const p = fs.realpathSync(d);
    fs.mkdirSync(`${d}/in/dir/mnt`, { recursive: true });
    fs.mkdirSync(`${d}/in/free`);
    fs.symlinkSync(`${d}/in`, `${d}/lnk`);
    fs.symlinkSync(`${d}/in/dir`, `${d}/in/link`);
    fs.writeFileSync(`${d}/info.txt`, `36 35 98:0 / ${p}/in/dir/mnt rw,relatime shared:1 - ext4 /dev/sdb1 rw\n`);
    const check = (dest) => spawnSync("sh", ["-c", REPLACE_CHECK_SCRIPT, "x", dest, `${d}/info.txt`, ""], { encoding: "utf8" });
    const msg = `Refusing to replace, a file system is mounted at: ${p}/in/dir/mnt\n`;
    for (const dest of [`${d}/in/dir`, `${d}/lnk/dir`]) {
      const r = check(dest);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, msg, dest);
    }
    for (const dest of [`${d}/in/free`, `${d}/in/link`, `${d}/in/none`]) {
      const r = check(dest);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "", dest);
    }
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// A case-insensitive file system takes "Dir" for the existing "dir": the table spells the mount ".../dir/mnt".
test("REPLACE_CHECK_SCRIPT: another letter case of the folder still finds the mount (case-insensitive file system)", async (t) => {
  const d = await mkTmp("rc-case-");
  const p = fs.realpathSync(d);
  fs.mkdirSync(`${d}/in/dir/mnt`, { recursive: true });
  fs.writeFileSync(`${d}/CaseProbe`, "");
  if (!fs.existsSync(`${d}/caseprobe`)) return t.skip("the file system here tells letter case apart");
  fs.writeFileSync(`${d}/info.txt`, `36 35 98:0 / ${p}/in/dir/mnt rw,relatime shared:1 - ext4 /dev/sdb1 rw\n`);
  fs.writeFileSync(`${d}/bsd.txt`, `/dev/disk9s1 on ${p}/in/dir/mnt (hfs, local, nodev, nosuid, nobrowse)\n`);
  const msg = `Refusing to replace, a file system is mounted at: ${p}/in/dir/mnt\n`;
  for (const [dest, info, bsd] of [[`${d}/in/Dir`, `${d}/info.txt`, ""], [`${d}/IN/DIR`, `${d}/info.txt`, ""], [`${d}/in/Dir`, `${d}/none`, `${d}/bsd.txt`]]) {
    const r = spawnSync("sh", ["-c", REPLACE_CHECK_SCRIPT, "x", dest, info, bsd], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, msg, dest);
  }
});

// APFS takes "café" in NFC for the stored NFD "café": the table spells the mount in the stored form (#31).
const SHELLS = ["sh", ...(spawnSync("dash", ["-c", ":"]).status === 0 ? ["dash"] : [])];
test("REPLACE_CHECK_SCRIPT: an NFC name still finds the mount in the stored NFD folder", async (t) => {
  const d = await mkTmp("rc-nfd-");
  const p = fs.realpathSync(d);
  fs.mkdirSync(`${d}/in/cafe\u0301/mnt`, { recursive: true });
  if (!fs.existsSync(`${d}/in/caf\u00e9`)) return t.skip("the file system here tells Unicode normal forms apart");
  fs.writeFileSync(`${d}/info.txt`, `36 35 98:0 / ${p}/in/cafe\u0301/mnt rw,relatime shared:1 - ext4 /dev/sdb1 rw\n`);
  fs.writeFileSync(`${d}/bsd.txt`, `/dev/disk9s1 on ${p}/in/cafe\u0301/mnt (hfs, local, nodev, nosuid, nobrowse)\n`);
  const msg = `Refusing to replace, a file system is mounted at: ${p}/in/cafe\u0301/mnt\n`;
  for (const shell of SHELLS) {
    for (const [dest, info, bsd] of [[`${d}/in/caf\u00e9`, `${d}/info.txt`, ""], [`${d}/in/caf\u00e9`, `${d}/none`, `${d}/bsd.txt`], [`${d}/in/cafe\u0301`, `${d}/none`, `${d}/bsd.txt`]]) {
      const r = spawnSync(shell, ["-c", REPLACE_CHECK_SCRIPT, "x", dest, info, bsd], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, msg, `${shell} ${dest.normalize("NFD") === dest ? "NFD" : "NFC"} ${bsd ? "mount" : "mountinfo"}`);
    }
  }
});

// ---- Keep both without letter case and Unicode normalization (#33), on every side.
for (const [label, start, listDir] of [
  ["download", (jobs) => jobs.start(down({ src: "/srv/data/A.TXT", choice: "keep_both" })), DIR],
  ["upload", (jobs) => jobs.start({ direction: "up", machine: "box", src: "/Users/m/A.TXT", destDir: "/srv/in", choice: "keep_both" }), "/srv/in"],
  ["local", (jobs) => jobs.start({ ...LOCAL, src: "/Users/m/Desktop/A.TXT", choice: "keep_both" }), LOCAL.destDir],
]) {
  test(`keep_both ${label}: A.TXT next to a.txt and a-1.txt becomes A-2.TXT`, async () => {
    const { f, jobs } = setup();
    f.listings[listDir] = ["a.txt", "a-1.txt"];
    const job = await start(jobs);
    assert.equal(job.name, "A-2.TXT");
    assert.equal(job.dest, `${listDir}/A-2.TXT`);
  });
}

test("keep_both: an NFD name next to its NFC spelling gets a new name (#33)", async () => {
  const { f, jobs } = setup();
  f.listings[DIR] = ["ü.txt"];
  const job = await jobs.start(down({ src: "/srv/data/ü.txt", choice: "keep_both" }));
  assert.equal(job.name, "ü-1.txt");
});

test("keep_both: a running job's name is reserved in any letter case and with a trailing slash (#33)", async () => {
  const { f, jobs } = setup();
  await jobs.start(down({ src: "/srv/a.txt", destDir: `${DIR}/`, choice: "new" }));
  const j = await jobs.start(down({ src: "/srv/x/A.TXT", destDir: DIR, choice: "keep_both" }));
  assert.equal(j.dest, `${DIR}/A-1.TXT`);
  const k = await jobs.start(down({ src: "/srv/y/a.txt", destDir: `${DIR}//`, choice: "keep_both" }));
  assert.equal(k.dest, `${DIR}/a-2.txt`);
});

// ---- Empty stderr (#34): every caller has its own text, a failure never reads as "no error".
test("hc run failing with empty stderr: Could not start the transfer", async () => {
  const { f } = setup();
  f.hc = async (args) => (f.hcCalls.push(args), args[0] === "run" ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: JSON.stringify(f.machines), stderr: "" });
  const job = await createJobs(f.deps()).start(down());
  assert.equal(job.state, "failed");
  assert.equal(job.error, "Could not start the transfer");
});

test("failed status without a message: Transfer failed", async () => {
  const { f, jobs } = setup();
  await jobs.start(down());
  f.terminals["term-fs-id1"] = { state: "finished", exit_code: 1 };
  f.files[STATUS] = "state=failed\ncode=1\n";
  await jobs.tick();
  assert.equal(f.jobs().id1.error, "Transfer failed");
});

test("inspect: a mount check that fails without any message is an error, never a free Replace (#31, #34)", async () => {
  const { f } = setup();
  f.existing.add("/Users/m/dir"); f.dirs.add("/Users/m/dir");
  withDirs(f, "/srv/in");
  f.existing.add("/srv/in/dir"); f.dirs.add("/srv/in/dir");
  f.links = "";
  const exec = f.exec;
  f.exec = async (cmd, args, opts) => { if (args?.[1] === REPLACE_CHECK_SCRIPT) throw new Error(""); return exec(cmd, args, opts); };
  const fresh = createJobs(f.deps());
  const r = await fresh.inspect({ direction: "up", machine: "box", src: "/Users/m/dir", destDir: "/srv/in" });
  assert.equal(r.error, "Could not check the path");
  f.exec = async (cmd, args, opts) => (args?.[1] === REPLACE_CHECK_SCRIPT ? { code: 1, stdout: "", stderr: "" } : exec(cmd, args, opts));
  assert.equal((await createJobs(f.deps()).inspect({ direction: "up", machine: "box", src: "/Users/m/dir", destDir: "/srv/in" })).error, "Could not check the path");
});

// ---- #48: a probe that fails without a message never shows "exit code N".
test("inspect: an exists probe that fails without any message gives Could not check the path (#48)", async () => {
  const { f, jobs } = setup();
  f.execCode = () => ({ code: 1, stderr: "" });
  const r = await jobs.inspect({ direction: "down", machine: "box", src: SRC, destDir: DIR });
  assert.equal(r.error, "Could not check the path");
});

test("keep_both: a listing that fails without any message gives Could not list the folder (#48)", async () => {
  const { f } = setup();
  const exec = f.exec;
  f.exec = async (cmd, args, opts) => (args?.[1] === LIST_SCRIPT ? { code: 1, stdout: "", stderr: "" } : exec(cmd, args, opts));
  const job = await createJobs(f.deps()).start(down({ choice: "keep_both" }));
  assert.equal(job.state, "failed");
  assert.equal(job.error, "Could not list the folder");
});

// ---- #46: Merge with a symlink to a folder as the source (cp -P copies the link, nothing would be merged).
const MERGE_LINK = (src) => `Cannot merge a symlink into a folder: ${src}`;
for (const direction of ["local", "remote"]) {
  const machine = direction === "remote" ? "box" : null;
  test(`inspect ${direction}: a symlink to a folder over a folder gives mergeError (#46)`, async () => {
    const { f, jobs } = setup();
    withDirs(f, "/srv/link", "/srv/in", "/srv/in/link");
    f.symlinks.add("/srv/link");
    const r = await jobs.inspect({ direction, machine, src: "/srv/link", destDir: "/srv/in" });
    assert.deepEqual(r, { name: "link", isDir: true, exists: true, destIsDir: true, linkWarning: null, linkTitle: null, mergeError: MERGE_LINK("/srv/link") });
  });
  test(`inspect ${direction}: a real folder, a link over a link and a link without target get no mergeError (#46)`, async () => {
    for (const [srcLink, destDir, destLink] of [[false, true, false], [true, true, true], [true, false, false]]) {
      const { f, jobs } = setup();
      withDirs(f, "/srv/d", "/srv/in");
      f.existing.add("/srv/in/d");
      if (destDir) f.dirs.add("/srv/in/d");
      if (srcLink) f.symlinks.add("/srv/d");
      if (destLink) f.symlinks.add("/srv/in/d");
      const r = await jobs.inspect({ direction, machine, src: "/srv/d", destDir: "/srv/in" });
      assert.equal(r.mergeError, undefined, JSON.stringify([srcLink, destDir, destLink]));
    }
  });
}

// The real probes in sh on real folders below tmp/: only exec is stood in for (the machine side would need ssh).
test("inspect local and remote: the real exists probe tells a linked folder from a real one (#46)", async () => {
  const d = await mkTmp("merge-link-");
  fs.mkdirSync(`${d}/real/x`, { recursive: true }); fs.mkdirSync(`${d}/in/link`, { recursive: true }); fs.mkdirSync(`${d}/in/x`);
  fs.symlinkSync(`${d}/real`, `${d}/link`);
  const exec = async (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  for (const direction of ["local", "remote"]) {
    const jobs = createJobs({ ...createFake().deps(), exec });
    const machine = direction === "remote" ? "box" : null;
    assert.equal((await jobs.inspect({ direction, machine, src: `${d}/link`, destDir: `${d}/in` })).mergeError, `Cannot merge a symlink into a folder: ${d}/link`);
    assert.equal((await jobs.inspect({ direction, machine, src: `${d}/real/x`, destDir: `${d}/in` })).mergeError, undefined);
  }
});

test("inspect down and up: scp copies what a link points to, so a linked folder may merge (#46)", async () => {
  for (const [direction, src, destDir] of [["down", "/srv/link", DIR], ["up", "/Users/m/link", "/srv/in"]]) {
    const { f, jobs } = setup();
    withDirs(f, src, destDir, `${destDir}/link`);
    f.symlinks.add(src);
    f.links = "";
    const r = await jobs.inspect({ direction, machine: "box", src, destDir });
    assert.equal(r.mergeError, undefined, direction);
  }
});

// ---- #46: the old copy a Replace on a machine could not remove stays done, with a warning toast naming it.
test("up and remote done with a left old copy: state done, warning toast names the old copy (#46)", async () => {
  for (const [start, title] of [[{ direction: "up", machine: "box", src: "/Users/m/dir", destDir: "/srv/in", choice: "replace" }, "Uploaded"], [{ ...REMOTE, src: "/srv/data/dir", choice: "replace" }, "Copied"]]) {
    const { f, jobs } = setup();
    await jobs.start(start);
    f.terminals["term-fs-id1"] = { state: "finished" };
    f.files[STATUS] = "state=done\ncode=0\nrm: cannot remove '/srv/in/.dir.fs-old-id1/locked/f': Permission denied\nWarning: could not fully remove old copy: /srv/in/.dir.fs-old-id1\n";
    await jobs.tick();
    const job = f.jobs().id1;
    assert.equal(job.state, "done", title);
    assert.equal(job.warning, "Could not fully remove the old copy: /srv/in/.dir.fs-old-id1");
    assert.deepEqual(f.notifications, [{ title, body: "Could not fully remove the old copy: /srv/in/.dir.fs-old-id1", level: "warning" }]);
    assert.deepEqual(f.store["filer-pro.changed"], { at: f.t });
  }
});

test("done without the warning line keeps the success toast and no warning (#46)", async () => {
  const { f, jobs } = setup();
  await jobs.start({ direction: "up", machine: "box", src: "/Users/m/a.txt", destDir: "/srv/in", choice: "new" });
  f.terminals["term-fs-id1"] = { state: "finished" };
  f.files[STATUS] = "state=done\ncode=0\nsome scp chatter\n";
  await jobs.tick();
  assert.equal(f.jobs().id1.warning, undefined);
  assert.deepEqual(f.notifications, [{ title: "Uploaded", body: "a.txt", level: "success" }]);
});

// #54: inspect says what the existing target is, not only what the source is.
test("inspect #54: the kind of the existing target comes back as destIsDir, locally and on a machine", async () => {
  const cases = [
    // [direction, machine, src, destDir, srcIsDir, destIsDir]
    ["local", null, "/Users/m/p", "/Users/m/q", true, false],
    ["local", null, "/Users/m/a.txt", "/Users/m/q", false, true],
    ["up", "box", "/Users/m/a.txt", "/srv/in", false, true],
    ["up", "box", "/Users/m/p", "/srv/in", true, false],
    ["remote", "box", "/srv/a.txt", "/srv/in", false, true],
  ];
  for (const [direction, machine, src, destDir, srcIsDir, destIsDir] of cases) {
    const { f, jobs } = setup();
    const name = src.split("/").pop();
    f.existing.add(src);
    if (srcIsDir) f.dirs.add(src);
    withDirs(f, destDir);
    f.existing.add(`${destDir}/${name}`);
    if (destIsDir) f.dirs.add(`${destDir}/${name}`);
    f.links = "";
    const r = await jobs.inspect({ direction, machine, src, destDir });
    assert.equal(r.exists, true, direction);
    assert.equal(r.isDir, srcIsDir, direction);
    assert.equal(r.destIsDir, destIsDir, `${direction} ${src}`);
  }
});

test("inspect #54: a linked target counts as no folder, a missing target has no destIsDir", async () => {
  const { f, jobs } = setup();
  f.existing.add("/Users/m/p");
  f.dirs.add("/Users/m/p");
  withDirs(f, "/Users/m/q", "/Users/m/q/p");
  f.symlinks.add("/Users/m/q/p");
  const r = await jobs.inspect({ direction: "local", machine: null, src: "/Users/m/p", destDir: "/Users/m/q" });
  assert.equal(r.destIsDir, false);
  const g = setup();
  g.f.existing.add("/Users/m/a.txt");
  withDirs(g.f, "/Users/m/q");
  const m = await g.jobs.inspect({ direction: "local", machine: null, src: "/Users/m/a.txt", destDir: "/Users/m/q" });
  assert.equal("destIsDir" in m, false);
});

test("settings: clearFinished(keepMs) uses the configured time", async () => {
  const { f, jobs } = setup();
  f.store["filer-pro.jobs"] = { a: { id: "a", state: "done", finishedAt: f.t } };
  f.t += 3_000;
  jobs.clearFinished(5_000);
  assert.deepEqual(Object.keys(f.jobs()), ["a"]);
  f.t += 3_000;
  jobs.clearFinished(5_000);
  assert.deepEqual(Object.keys(f.jobs()), []);
});

test("settings: stall_seconds from settings() decides when tick kills a transfer", async () => {
  const f = createFake();
  const jobs = createJobs({ ...f.deps(), settings: () => ({ stall_seconds: 30 }) });
  f.sizes[SRC] = 100;
  await jobs.start(down());
  f.sizes[`${DIR}/.a.txt.fs-id1.part`] = 10;
  f.t += 1000;
  await jobs.tick();
  f.t += 31_000;
  await jobs.tick();
  assert.deepEqual(f.hcCalls.filter((a) => a[0] === "kill"), [["kill", "term-fs-id1"]]);
});

test("settings: SSH options reach transfer.sh through env, only when they differ from the defaults", async () => {
  const run = async (settings) => {
    const f = createFake();
    const jobs = createJobs({ ...f.deps(), settings: () => settings });
    await jobs.start(down());
    return f.hcRuns()[0].slice(8);
  };
  const plain = await run({ ssh_connect_timeout: 15, ssh_alive_interval: 15, ssh_alive_count: 4 });
  assert.equal(plain[0], "sh");
  assert.deepEqual(await run({}), plain);
  assert.deepEqual((await run({ ssh_connect_timeout: 30, ssh_alive_interval: 15, ssh_alive_count: 4 })).slice(0, 5),
    ["env", "FILER_PRO_SSH_CONNECT_TIMEOUT=30", "FILER_PRO_SSH_ALIVE_INTERVAL=15", "FILER_PRO_SSH_ALIVE_COUNT=4", "sh"]);
  // Anything that is not a whole number in range never reaches the command line: the default is used.
  assert.deepEqual(await run({ ssh_connect_timeout: "15 -o ProxyCommand=x", ssh_alive_interval: 1.5, ssh_alive_count: 4 }), plain);
  assert.deepEqual((await run({ ssh_connect_timeout: 9999, ssh_alive_interval: 15, ssh_alive_count: 4 })).slice(0, 2), ["env", "FILER_PRO_SSH_CONNECT_TIMEOUT=300"]);
});
