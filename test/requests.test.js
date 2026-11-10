import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createJobs } from "../mods/filer-pro/lib/jobs.js";
import { createFake } from "./fake/herdr.js";
import { mkTmp, mkTmpSync } from "./tmp-helper.js";
import { parseRequest, claim, resultText, handleRequest, closeAnswer, panelPlan, openResult, modeResult, askPanel, answerShow, runTransfers } from "../mods/filer-pro/lib/requests.js";

test("parseRequest: valid actions", () => {
  assert.deepEqual(parseRequest('{"action":"download","machine":"box","path":"/a/b","conflict":"replace"}'),
    { action: "download", machine: "box", path: "/a/b", conflict: "replace" });
  assert.deepEqual(parseRequest('{"action":"upload","machine":"box","paths":["/x"],"folder":"/srv"}'),
    { action: "upload", machine: "box", paths: ["/x"], folder: "/srv" });
  assert.deepEqual(parseRequest('{"action":"cancel","job":"j1"}'), { action: "cancel", job: "j1" });
  assert.deepEqual(parseRequest('{"action":"answer","choice":"replace","apply_to_all":true}'), { action: "answer", choice: "replace", apply_to_all: true });
  assert.deepEqual(parseRequest('{"action":"status"}'), { action: "status" });
});
test("parseRequest: invalid", () => {
  assert.deepEqual(parseRequest('{"action":"download","path":"/a"}'), { error: "machine is required" });
  assert.match(parseRequest('{"action":"nope"}').error, /Unknown action/);
  assert.ok(parseRequest("{x").error);
  assert.ok(parseRequest('{"action":"download","machine":"b","path":"/a","conflict":"zap"}').error);
  assert.deepEqual(parseRequest('{"action":"upload","machine":"b","paths":[],"folder":"/s"}'), { error: "paths is required" });
});
test("claim: first true, then false", async () => {
  const seen = new Set();
  const w = async (p, t, exp) => {
    assert.equal(t, "1");
    assert.equal(exp, null);
    if (seen.has(p)) throw new Error("stale");
    seen.add(p);
  };
  assert.equal(await claim("/d", "r1", w), true);
  assert.ok(seen.has("/d/r1.claim"));
  assert.equal(await claim("/d", "r1", w), false);
});
test("resultText is JSON with 2 spaces", () => {
  assert.equal(resultText({ ok: false, error: "x" }), '{\n  "ok": false,\n  "error": "x"\n}');
});

function deps(over = {}) {
  const store = { ...(over.store || {}) };
  const calls = [], asked = [], fileOpsCalls = [];
  const info = { name: "a", isDir: false, exists: false, linkWarning: null, ...(over.info || {}) };
  return {
    calls, store, fileOpsCalls, now: () => 777,
    fileOps: {
      check: async (a) => (fileOpsCalls.push(["check", a]), over.fileOpsError ? { ok: false, error: over.fileOpsError } : { ok: true, path: a.path.replace(/\/+$/, ""), name: a.path.replace(/\/+$/, "").split("/").pop(), isDir: a.path.replace(/\/+$/, "") === "/srv/d" }),
      rename: async (a) => (fileOpsCalls.push(["rename", a]), over.fileOpsError ? { ok: false, error: over.fileOpsError } : { ok: true, path: a.path.replace(/[^/]+$/, a.name) }),
      mkdir: async (a) => (fileOpsCalls.push(["mkdir", a]), over.fileOpsError ? { ok: false, error: over.fileOpsError } : { ok: true, path: `${a.path}/${a.name}` }),
      inspectMove: async (a) => (fileOpsCalls.push(["inspectMove", a]), over.inspect ?? { ok: true, src: a.src, name: "a", isDir: false, destDir: a.destDir, dest: `${a.destDir}/a`, exists: false, destIsDir: false, replaceError: null }),
      move: async (a) => (fileOpsCalls.push(["move", a]), over.moveOut ?? { ok: true, moved: true, path: "/srv/in/a", name: "a", isDir: false }),
      remove: async (a) => (fileOpsCalls.push(["remove", a]), over.removeOut ? over.removeOut : a.on ? { ok: true, trashed: false, name: "d", isDir: true } : { ok: true, trashed: true, trash_path: "/Users/m/.Trash/a.txt", name: "a.txt", isDir: false }),
    },
    jobs: {
      inspect: async (a) => (calls.push(["inspect", a]), info),
      start: async (a) => (calls.push(["start", a]), { id: "j1" }),
      cancel: async (id) => calls.push(["cancel", id]),
    },
    loadConfig: async () => ({ download_folder: "/home/u/Downloads" }),
    asked,
    ask: async (pending) => (asked.push(pending), (over.answers || []).shift() || { choice: "cancel" }),
    newBatchId: () => "b1",
    getShared: (k) => store[k],
    setShared: (k, v) => { store[k] = v; return null; },
  };
}
const dl = (x = {}) => ({ action: "download", machine: "box", path: "/srv/a", ...x });

test("status lists jobs", async () => {
  const d = deps({ store: { "filer-pro.jobs": { j1: { id: "j1" } } } });
  assert.deepEqual(await handleRequest({ action: "status" }, d), { ok: true, jobs: [{ id: "j1" }] });
});
test("cancel calls jobs.cancel", async () => {
  const d = deps();
  assert.deepEqual(await handleRequest({ action: "cancel", job: "j1" }, d), { ok: true });
  assert.deepEqual(d.calls[0], ["cancel", "j1"]);
});
test("download happy path uses config folder and choice new", async () => {
  const d = deps();
  assert.deepEqual(await handleRequest(dl(), d), { ok: true, job: { id: "j1" } });
  assert.equal(d.calls[0][1].destDir, "/home/u/Downloads");
  assert.deepEqual(d.calls[1][1], { direction: "down", machine: "box", src: "/srv/a", destDir: "/home/u/Downloads", choice: "new", isDir: false });
});
test("download honours dest_dir", async () => {
  const d = deps();
  await handleRequest(dl({ dest_dir: "/x" }), d);
  assert.equal(d.calls[1][1].destDir, "/x");
});
test("link warning asks the dialog; transfer_anyway starts, cancel stops", async () => {
  const d = deps({ info: { isDir: true, linkWarning: "W text", linkTitle: "W title" }, answers: [{ choice: "transfer_anyway" }] });
  assert.equal((await handleRequest(dl(), d)).ok, true);
  assert.equal(d.asked.length, 1);
  assert.deepEqual(d.asked[0].choices, ["transfer_anyway", "cancel"]);
  assert.equal(d.asked[0].item.linkWarning, "W text");
  assert.equal(d.asked[0].item.linkTitle, "W title");
  assert.equal(d.calls.at(-1)[1].choice, "new");
  const e = deps({ info: { isDir: true, linkWarning: "w" }, answers: [{ choice: "cancel" }] });
  assert.deepEqual(await handleRequest(dl(), e), { ok: false, error: "Cancelled" });
  assert.equal(e.calls.some((c) => c[0] === "start"), false);
});
test("links field answers the link dialog up front", async () => {
  const d = deps({ info: { isDir: true, linkWarning: "w" } });
  assert.equal((await handleRequest(dl({ links: "transfer_anyway" }), d)).ok, true);
  assert.equal(d.asked.length, 0);
  assert.deepEqual(await handleRequest(dl({ links: "cancel" }), d), { ok: false, error: "Cancelled" });
});
test("existing target without conflict opens the dialog and starts with the answer", async () => {
  const d = deps({ info: { exists: true }, answers: [{ choice: "keep_both", apply_to_all: false }] });
  assert.deepEqual(await handleRequest(dl(), d), { ok: true, job: { id: "j1" } });
  assert.equal(d.asked.length, 1);
  assert.equal(d.asked[0].batch, "b1#1");
  assert.deepEqual(d.asked[0].choices, ["replace", "keep_both", "cancel"]);
  assert.equal(d.calls.at(-1)[1].choice, "keep_both");
});
test("dialog cancel gives Cancelled", async () => {
  const d = deps({ info: { exists: true }, answers: [{ choice: "cancel" }] });
  assert.deepEqual(await handleRequest(dl(), d), { ok: false, error: "Cancelled" });
});
test("conflict field means no dialog", async () => {
  const d = deps({ info: { exists: true } });
  assert.equal((await handleRequest(dl({ conflict: "keep_both" }), d)).ok, true);
  assert.equal(d.asked.length, 0);
  assert.equal(d.calls.at(-1)[1].choice, "keep_both");
});
test("merge on a file target is started as replace", async () => {
  const d = deps({ info: { exists: true } });
  await handleRequest(dl({ conflict: "merge" }), d);
  assert.equal(d.calls.at(-1)[1].choice, "replace");
});
test("reveal is handed to start", async () => {
  const d = deps();
  await handleRequest(dl({ reveal: true }), d);
  assert.equal(d.calls.at(-1)[1].reveal, true);
  await handleRequest(dl(), d);
  assert.equal("reveal" in d.calls.at(-1)[1], false);
  await handleRequest(dl({ reveal: "open" }), d);
  assert.equal(d.calls.at(-1)[1].reveal, "open");
  await handleRequest(dl({ reveal: "preview" }), d);
  assert.equal(d.calls.at(-1)[1].reveal, "preview");
});
test("parseRequest: reveal accepts true, open and preview, ignores false, refuses other values", () => {
  const dlq = (v) => parseRequest(`{"action":"download","machine":"box","path":"/a","reveal":${v}}`);
  assert.equal(dlq('"open"').reveal, "open");
  assert.equal(dlq('"preview"').reveal, "preview");
  assert.equal(dlq("true").reveal, true);
  assert.equal("reveal" in dlq("false"), false);
  assert.equal("reveal" in dlq("null"), false);
  for (const v of ['"finder"', '"OPEN"', "1", '""', "{}"]) assert.deepEqual(dlq(v), { error: "reveal must be true, open or preview" });
  assert.deepEqual(parseRequest('{"action":"copy","paths":["/x"],"reveal":"zap"}'), { error: "reveal must be true, open or preview" });
  assert.equal(parseRequest('{"action":"upload","machine":"box","paths":["/x"],"folder":"/srv","reveal":"preview"}').reveal, "preview");
  assert.equal(parseRequest('{"action":"paste","folder":"/srv","reveal":"open"}').reveal, "open");
});
test("parseRequest keeps reveal", () => {
  assert.deepEqual(parseRequest('{"action":"download","machine":"box","path":"/a","reveal":true}'),
    { action: "download", machine: "box", path: "/a", reveal: true });
});
test("conflict cancel only aborts when the target exists (R66)", async () => {
  const d = deps({ info: { exists: true } });
  assert.deepEqual(await handleRequest(dl({ conflict: "cancel" }), d), { ok: false, error: "Cancelled" });
  assert.equal(d.calls.some((c) => c[0] === "start"), false);
  const e = deps();
  assert.deepEqual(await handleRequest(dl({ conflict: "cancel" }), e), { ok: true, job: { id: "j1" } });
  assert.equal(e.calls.at(-1)[1].choice, "new");
});
test("inspect error is returned", async () => {
  const d = deps({ info: { error: "No such file or folder: /srv/a" } });
  assert.deepEqual(await handleRequest(dl(), d), { ok: false, error: "No such file or folder: /srv/a" });
});
const up = (x = {}) => ({ action: "upload", machine: "box", paths: ["/Users/m/a.txt", "/Users/m/dir"], folder: "/srv/in", ...x });

test("upload: inspect and start per path with direction up and choice new", async () => {
  const d = deps();
  d.jobs.inspect = async (a) => (d.calls.push(["inspect", a]), { name: a.src.split("/").pop(), isDir: false, exists: false, linkWarning: null });
  const r = await handleRequest(up(), d);
  const ins = d.calls.filter((c) => c[0] === "inspect").map((c) => c[1]);
  assert.equal(ins.length, 2);
  for (const a of ins) assert.deepEqual([a.direction, a.machine, a.destDir], ["up", "box", "/srv/in"]);
  const starts = d.calls.filter((c) => c[0] === "start").map((c) => c[1]);
  assert.equal(starts.length, 2);
  for (const a of starts) assert.deepEqual([a.direction, a.machine, a.destDir, a.choice], ["up", "box", "/srv/in", "new"]);
  assert.equal(r.ok, true);
  assert.equal(r.jobs.length, 2);
});
test("upload of a folder with symlinks asks transfer_anyway or cancel; links cancel skips the question", async () => {
  const info = { name: "dir", isDir: true, linkWarning: "w", linkTitle: "Symlink found!" };
  const d = deps({ info, answers: [{ choice: "transfer_anyway" }] });
  assert.equal((await handleRequest(up({ paths: ["/Users/m/dir"] }), d)).ok, true);
  assert.deepEqual(d.asked[0].choices, ["transfer_anyway", "cancel"]);
  assert.equal(d.asked[0].item.linkWarning, "w");
  assert.equal(d.asked[0].item.linkTitle, "Symlink found!");
  const e = deps({ info });
  assert.deepEqual(await handleRequest(up({ paths: ["/Users/m/dir"], links: "cancel" }), e), { ok: false, error: "Cancelled" });
  assert.equal(e.asked.length, 0);
  assert.equal(e.calls.some((c) => c[0] === "start"), false);
});
test("upload of three existing files: one question for all, three replace starts", async () => {
  const d = deps({ answers: [{ choice: "replace", apply_to_all: true }] });
  d.jobs.inspect = async (a) => (d.calls.push(["inspect", a]), { name: a.src.split("/").pop(), isDir: false, exists: true, linkWarning: null });
  const r = await handleRequest(up({ paths: ["/p/a", "/p/b", "/p/c"] }), d);
  assert.equal(d.asked.length, 1);
  assert.equal(d.asked[0].remaining, 3);
  const starts = d.calls.filter((c) => c[0] === "start").map((c) => c[1]);
  assert.deepEqual(starts.map((a) => [a.direction, a.choice]), [["up", "replace"], ["up", "replace"], ["up", "replace"]]);
  assert.equal(r.jobs.length, 3);
});
test("answer sets filer-pro.answer with pending batch", async () => {
  const d = deps({ store: { "filer-pro.pending": { batch: "b1" } } });
  assert.deepEqual(await handleRequest({ action: "answer", choice: "replace", apply_to_all: true }, d), { ok: true });
  assert.deepEqual(d.store["filer-pro.answer"], { batch: "b1", choice: "replace", apply_to_all: true });
  const e = deps();
  await handleRequest({ action: "answer", choice: "cancel", apply_to_all: false }, e);
  assert.equal(e.store["filer-pro.answer"].batch, null);
});

import { processRequest } from "../mods/filer-pro/lib/requests.js";

function io(over = {}) {
  const log = { written: [], removed: [] };
  return {
    log,
    readTextFile: async () => '{"action":"status"}',
    writeResult: async (p, t) => { log.written.push([p, JSON.parse(t)]); },
    removeClaim: async (p) => { log.removed.push(p); },
    handle: async () => ({ ok: true, jobs: [] }),
    ...over,
  };
}

test("processRequest: normal request writes the result", async () => {
  const i = io();
  assert.equal(await processRequest("/d", "r1", i), true);
  assert.deepEqual(i.log.written, [["/d/r1.result.json", { ok: true, jobs: [] }]]);
});
test("processRequest: unreadable request (null or reject) gets an error result", async () => {
  for (const readTextFile of [async () => null, async () => { throw new Error("io"); }]) {
    const i = io({ readTextFile });
    assert.equal(await processRequest("/d", "r1", i), true);
    assert.deepEqual(i.log.written[0][1], { ok: false, error: "Cannot read request" });
  }
});
test("processRequest: parse error and handler throw give error results", async () => {
  const a = io({ readTextFile: async () => "{x" });
  await processRequest("/d", "r1", a);
  assert.equal(a.log.written[0][1].ok, false);
  const b = io({ handle: async () => { throw new Error("boom"); } });
  await processRequest("/d", "r1", b);
  assert.deepEqual(b.log.written[0][1], { ok: false, error: "boom" });
});
test("processRequest: failed result write removes the claim for a retry", async () => {
  const i = io({ writeResult: async () => { throw new Error("disk"); } });
  assert.equal(await processRequest("/d", "r1", i), false);
  assert.deepEqual(i.log.removed, ["/d/r1.claim"]);
});

test("every question of a request gets its own id", async () => {
  const d = deps({ info: { isDir: true, exists: true, linkWarning: "w" }, answers: [{ choice: "transfer_anyway" }, { choice: "merge" }] });
  assert.equal((await handleRequest(dl(), d)).ok, true);
  assert.deepEqual(d.asked.map(a => a.batch), ["b1#1", "b1#2"]);
});
test("a stale close of question #1 cannot cancel question #2", () => {
  const second = { batch: "b1#2" };
  assert.equal(closeAnswer("b1#1", second, null), null);
  assert.equal(closeAnswer("b1#1", second, { batch: "b1#1" }), null);
  assert.deepEqual(closeAnswer("b1#2", second, null), { batch: "b1#2", choice: "cancel", apply_to_all: false });
  assert.equal(closeAnswer("b1#2", second, { batch: "b1#2", choice: "replace" }), null);
  assert.equal(closeAnswer(null, second, null), null);
});

// ---- copy and runTransfers (Task 8c)
test("parseRequest: copy", () => {
  assert.deepEqual(parseRequest('{"action":"copy","paths":["/Users/m/Desktop/a.png"],"folder":"/Users/m/git/x"}'),
    { action: "copy", paths: ["/Users/m/Desktop/a.png"], folder: "/Users/m/git/x" });
  assert.deepEqual(parseRequest('{"action":"copy","paths":["/a"]}'), { action: "copy", paths: ["/a"] });
  assert.deepEqual(parseRequest('{"action":"copy","paths":["/a"],"links":"cancel"}'), { action: "copy", paths: ["/a"] });
});
test("parseRequest: copy and upload check paths and folder", () => {
  for (const head of ['"action":"copy"', '"action":"upload","machine":"box"']) {
    const extra = head.includes("upload") ? ',"folder":"/s"' : "";
    assert.deepEqual(parseRequest(`{${head},"paths":[]${extra}}`), { error: "paths is required" });
    assert.deepEqual(parseRequest(`{${head}${extra}}`), { error: "paths is required" });
    assert.deepEqual(parseRequest(`{${head},"paths":["a.png"]${extra}}`), { error: "paths must be absolute" });
    assert.deepEqual(parseRequest(`{${head},"paths":["/a"],"folder":"x"}`), { error: "folder must be absolute" });
  }
});

const cp = (x = {}) => ({ action: "copy", paths: ["/Users/m/Desktop/a.png"], folder: "/Users/m/git/x", ...x });

test("copy: three existing items, one answer for all, three local starts", async () => {
  const d = deps({ info: { exists: true }, answers: [{ choice: "keep_both", apply_to_all: true }] });
  d.jobs.inspect = async (a) => (d.calls.push(["inspect", a]), { name: a.src.split("/").pop(), isDir: false, exists: true, linkWarning: null });
  const r = await handleRequest(cp({ paths: ["/p/a", "/q/b", "/r/c"] }), d);
  assert.equal(d.asked.length, 1);
  const starts = d.calls.filter((c) => c[0] === "start").map((c) => c[1]);
  assert.equal(starts.length, 3);
  for (const a of starts) {
    assert.equal(a.direction, "local");
    assert.equal(a.machine, null);
    assert.equal(a.choice, "keep_both");
  }
  assert.deepEqual(starts.map((a) => a.src), ["/p/a", "/q/b", "/r/c"]);
  assert.equal(r.ok, true);
  assert.equal(r.jobs.length, 3);
});

test("copy without folder uses download_folder", async () => {
  const d = deps();
  await handleRequest({ action: "copy", paths: ["/Users/m/a.png"] }, d);
  assert.equal(d.calls.find((c) => c[0] === "inspect")[1].destDir, "/home/u/Downloads");
  assert.equal(d.calls.find((c) => c[0] === "start")[1].destDir, "/home/u/Downloads");
});

test("copy: errors are collected per path, valid ones still run", async () => {
  const d = deps();
  d.jobs.inspect = async (a) => (a.src === "/x"
    ? { name: "x", isDir: false, exists: false, linkWarning: null, error: "No such file or folder: /x" }
    : { name: "a", isDir: false, exists: false, linkWarning: null });
  const err = { path: "/x", error: "No such file or folder: /x" };
  assert.deepEqual(await handleRequest(cp({ paths: ["/x", "/a"] }), d), { ok: true, jobs: [{ id: "j1" }], errors: [err] });
  const e = deps();
  e.jobs.inspect = d.jobs.inspect;
  assert.deepEqual(await handleRequest(cp({ paths: ["/x"] }), e), { ok: false, error: "No such file or folder: /x", errors: [err] });
});

test("same name twice in one run: the later one is keep_both without a dialog (R67)", async () => {
  const names = (a) => ({ name: "x.txt", isDir: false, exists: false, linkWarning: null });
  const d = deps();
  d.jobs.inspect = async (a) => names(a);
  await handleRequest(cp({ paths: ["/a/x.txt", "/b/x.txt"] }), d);
  assert.equal(d.asked.length, 0);
  assert.deepEqual(d.calls.filter((c) => c[0] === "start").map((c) => [c[1].src, c[1].choice]), [["/a/x.txt", "new"], ["/b/x.txt", "keep_both"]]);

  const e = deps();
  e.jobs.inspect = async () => ({ name: "x.txt", isDir: false, exists: true, linkWarning: null });
  await handleRequest(cp({ paths: ["/a/x.txt", "/b/x.txt"], conflict: "replace" }), e);
  assert.equal(e.asked.length, 0);
  assert.deepEqual(e.calls.filter((c) => c[0] === "start").map((c) => c[1].choice), ["replace", "keep_both"]);
});

test("a cancelled entry is skipped, the rest runs; all cancelled gives Cancelled", async () => {
  const d = deps({ answers: [{ choice: "cancel", apply_to_all: false }] });
  d.jobs.inspect = async (a) => ({ name: a.src.split("/").pop(), isDir: false, exists: a.src === "/a/x", linkWarning: null });
  const r = await handleRequest(cp({ paths: ["/a/x", "/a/y"] }), d);
  assert.deepEqual(d.calls.filter((c) => c[0] === "start").map((c) => c[1].src), ["/a/y"]);
  assert.equal(r.ok, true);
  const e = deps({ info: { exists: true }, answers: [{ choice: "cancel", apply_to_all: true }] });
  assert.deepEqual(await handleRequest(cp(), e), { ok: false, error: "Cancelled" });
});

test("resultText writes errors only when given", () => {
  const t = JSON.parse(resultText({ ok: true, jobs: [], errors: [{ path: "/x", error: "e" }] }));
  assert.deepEqual(t.errors, [{ path: "/x", error: "e" }]);
  assert.equal("errors" in JSON.parse(resultText({ ok: true, jobs: [] })), false);
});

test("a same-name duplicate is cancelled with the first entry (R71)", async () => {
  const info = async () => ({ name: "x.txt", isDir: false, exists: true, linkWarning: null });
  const e = deps();
  e.jobs.inspect = info;
  assert.deepEqual(await handleRequest(cp({ paths: ["/a/x.txt", "/b/x.txt"], conflict: "cancel" }), e), { ok: false, error: "Cancelled" });
  assert.equal(e.calls.some((c) => c[0] === "start"), false);
  const d = deps({ answers: [{ choice: "cancel", apply_to_all: true }] });
  d.jobs.inspect = info;
  assert.deepEqual(await handleRequest(cp({ paths: ["/a/x.txt", "/b/x.txt"] }), d), { ok: false, error: "Cancelled" });
  assert.equal(d.calls.some((c) => c[0] === "start"), false);
  // first replaced via the dialog: the duplicate is still keep_both
  const g = deps({ answers: [{ choice: "replace", apply_to_all: false }] });
  g.jobs.inspect = info;
  await handleRequest(cp({ paths: ["/a/x.txt", "/b/x.txt"] }), g);
  assert.deepEqual(g.calls.filter((c) => c[0] === "start").map((c) => c[1].choice), ["replace", "keep_both"]);
  assert.equal(g.asked.length, 1);
});

// Folders with a symlink loop (R74): blocked, only OK, never transferred.
const BLOCK_TEXT = '"dir" contains 1 symlink looping back into it (e.g. self → /r/dir). scp cannot transfer a folder with a symlink loop.';
const blockedInfo = { name: "dir", isDir: true, linkWarning: BLOCK_TEXT, linkTitle: "Symlink found!", linkBlocked: true };
const startsOf = (d) => d.calls.filter((c) => c[0] === "start");

test("blocked folder: links transfer_anyway starts nothing and reports the dialog text (download and upload)", async () => {
  const d = deps({ info: blockedInfo });
  assert.deepEqual(await handleRequest(dl({ links: "transfer_anyway" }), d), { ok: false, error: BLOCK_TEXT });
  assert.equal(startsOf(d).length, 0);
  assert.equal(d.asked.length, 0);
  const u = deps({ info: blockedInfo });
  const r = await handleRequest({ action: "upload", machine: "box", paths: ["/Users/m/dir"], folder: "/srv/in", links: "transfer_anyway" }, u);
  assert.deepEqual(r, { ok: false, error: BLOCK_TEXT, errors: [{ path: "/Users/m/dir", error: BLOCK_TEXT }] });
  assert.equal(startsOf(u).length, 0);
});
test("blocked folder without links asks with only ok; ok and transfer_anyway both end as Cancelled", async () => {
  for (const choice of ["ok", "transfer_anyway"]) {
    const d = deps({ info: blockedInfo, answers: [{ choice }] });
    assert.deepEqual(await handleRequest(dl(), d), { ok: false, error: "Cancelled" });
    assert.deepEqual(d.asked[0].choices, ["ok"]);
    assert.equal(d.asked[0].item.linkWarning, BLOCK_TEXT);
    assert.equal(startsOf(d).length, 0);
  }
  const c = deps({ info: blockedInfo });
  assert.deepEqual(await handleRequest(dl({ links: "cancel" }), c), { ok: false, error: "Cancelled" });
});
test("mixed request: file starts, blocked folder is an error entry", async () => {
  const d = deps();
  d.jobs.inspect = async (a) => (a.src.endsWith("dir") ? blockedInfo : { name: "f.txt", isDir: false, exists: false, linkWarning: null });
  const r = await handleRequest({ action: "upload", machine: "box", paths: ["/Users/m/dir", "/Users/m/f.txt"], folder: "/srv/in", links: "transfer_anyway" }, d);
  assert.equal(startsOf(d).length, 1);
  assert.equal(startsOf(d)[0][1].src, "/Users/m/f.txt");
  assert.deepEqual(r, { ok: true, jobs: [{ id: "j1" }], errors: [{ path: "/Users/m/dir", error: BLOCK_TEXT }] });
});

// ---- clip, paste, rename, delete
test("parseRequest: clip, paste, rename, delete", () => {
  assert.deepEqual(parseRequest('{"action":"clip","path":"/a","is_dir":true}'), { action: "clip", path: "/a", is_dir: true });
  assert.deepEqual(parseRequest('{"action":"clip","machine":"box","path":"/a"}'), { action: "clip", machine: "box", path: "/a", is_dir: false });
  assert.deepEqual(parseRequest('{"action":"clip","path":"a"}'), { error: "path must be absolute" });
  assert.deepEqual(parseRequest('{"action":"clip"}'), { error: "path is required" });
  assert.deepEqual(parseRequest('{"action":"paste","folder":"/in","conflict":"keep_both"}'), { action: "paste", folder: "/in", conflict: "keep_both" });
  assert.deepEqual(parseRequest('{"action":"paste","machine":"box","folder":"in"}'), { error: "folder must be absolute" });
  assert.deepEqual(parseRequest('{"action":"paste"}'), { error: "folder is required" });
  assert.deepEqual(parseRequest('{"action":"rename","machine":"box","path":"/a/b","root":"/a","name":"c"}'), { action: "rename", machine: "box", path: "/a/b", root: "/a", name: "c" });
  assert.deepEqual(parseRequest('{"action":"rename","path":"/a/b","root":"/a"}'), { error: "name is required" });
  assert.deepEqual(parseRequest('{"action":"rename","path":"/a/b","name":"c"}'), { error: "root is required" });
  assert.deepEqual(parseRequest('{"action":"delete","path":"/a/b","root":"/a","confirm":true}'), { action: "delete", path: "/a/b", root: "/a", confirm: true });
  assert.deepEqual(parseRequest('{"action":"delete","path":"/a/b","root":"/a","confirm":"yes"}'), { action: "delete", path: "/a/b", root: "/a", confirm: false }); // only true confirms
  assert.deepEqual(parseRequest('{"action":"delete","path":"/a/b"}'), { error: "root is required" });
  assert.deepEqual(parseRequest('{"action":"delete","path":"/a/b","root":"a"}'), { error: "root must be absolute" });
  assert.deepEqual(parseRequest('{"action":"delete","path":"a/b","root":"/a"}'), { error: "path must be absolute" });
});

test("parseRequest: a machine that is not a name is an error, never a silent local operation", () => {
  assert.deepEqual(parseRequest('{"action":"delete","machine":5,"path":"/a/b","root":"/a"}'), { error: "machine must be a name" });
  assert.deepEqual(parseRequest('{"action":"delete","machine":"","path":"/a/b","root":"/a"}'), { error: "machine must be a name" });
  assert.deepEqual(parseRequest('{"action":"rename","machine":null,"path":"/a/b","root":"/a","name":"c"}'), { action: "rename", path: "/a/b", root: "/a", name: "c" });
});

test("resultText carries path, trashed and trash_path", () => {
  assert.equal(resultText({ ok: true, trashed: true, trash_path: "/T/a" }), '{\n  "ok": true,\n  "trashed": true,\n  "trash_path": "/T/a"\n}');
  assert.equal(resultText({ ok: true, trashed: false }), '{\n  "ok": true,\n  "trashed": false\n}');
  assert.equal(resultText({ ok: true, path: "/a/b" }), '{\n  "ok": true,\n  "path": "/a/b"\n}');
});

test("clip stores the clipboard", async () => {
  const d = deps();
  assert.deepEqual(await handleRequest({ action: "clip", machine: "box", path: "/srv/a", is_dir: false }, d), { ok: true });
  assert.deepEqual(d.store["filer-pro.clipboard"], { machine: "box", path: "/srv/a", isDir: false, at: 777 });
  await handleRequest({ action: "clip", path: "/Users/m/a", is_dir: true }, d);
  assert.deepEqual(d.store["filer-pro.clipboard"], { machine: null, path: "/Users/m/a", isDir: true, at: 777 });
});

test("paste: nothing copied, cross machine, and the four directions through runTransfers", async () => {
  assert.deepEqual(await handleRequest({ action: "paste", folder: "/in" }, deps()), { ok: false, error: "Nothing to paste" });
  const clip = (machine, path) => ({ "filer-pro.clipboard": { machine, path, isDir: false, at: 1 } });
  assert.deepEqual(await handleRequest({ action: "paste", machine: "other", folder: "/in", conflict: "keep_both" }, deps({ store: clip("box", "/srv/a"), answers: [{ choice: "copy" }] })), { ok: true, jobs: [{ id: "j1" }] });
  const cases = [
    [clip(null, "/Users/m/a"), {}, { direction: "local", machine: null }],
    [clip("box", "/srv/a"), { machine: "box" }, { direction: "remote", machine: "box" }],
    [clip("box", "/srv/a"), {}, { direction: "down", machine: "box" }],
    [clip(null, "/Users/m/a"), { machine: "box" }, { direction: "up", machine: "box" }],
  ];
  for (const [store, extra, want] of cases) {
    const d = deps({ store });
    const r = await handleRequest({ action: "paste", folder: "/in", conflict: "keep_both", ...extra }, d);
    assert.deepEqual(r, { ok: true, jobs: [{ id: "j1" }] });
    const start = d.calls.find((c) => c[0] === "start")[1];
    assert.equal(start.direction, want.direction);
    assert.equal(start.machine, want.machine);
    assert.equal(start.destDir, "/in");
    assert.equal(start.src, store["filer-pro.clipboard"].path);
  }
});

test("paste with a stale clipboard reports the inspect error and starts nothing", async () => {
  const d = deps({ store: { "filer-pro.clipboard": { machine: null, path: "/Users/m/gone", isDir: false, at: 1 } }, info: { error: "No such file or folder: /Users/m/gone" } });
  assert.deepEqual(await handleRequest({ action: "paste", folder: "/in" }, d), { ok: false, error: "No such file or folder: /Users/m/gone", errors: [{ path: "/Users/m/gone", error: "No such file or folder: /Users/m/gone" }] });
  assert.equal(d.calls.some((c) => c[0] === "start"), false);
});

test("paste into the folder of the copied file asks the conflict dialog like a drop", async () => {
  const d = deps({ store: { "filer-pro.clipboard": { machine: null, path: "/Users/m/a.txt", isDir: false, at: 1 } }, info: { name: "a.txt", exists: true }, answers: [{ choice: "keep_both" }] });
  assert.deepEqual(await handleRequest({ action: "paste", folder: "/Users/m" }, d), { ok: true, jobs: [{ id: "j1" }] });
  assert.deepEqual(d.asked[0].choices, ["replace", "keep_both", "cancel"]);
  assert.equal(d.calls.at(-1)[1].choice, "keep_both");
});

test("rename passes through fileOps and signals the tree", async () => {
  const d = deps();
  assert.deepEqual(await handleRequest({ action: "rename", machine: "box", path: "/srv/a", root: "/srv", name: "b" }, d), { ok: true, path: "/srv/b" });
  assert.deepEqual(d.fileOpsCalls[0], ["rename", { on: "box", path: "/srv/a", root: "/srv", name: "b" }]);
  assert.deepEqual(d.store["filer-pro.changed"], { at: 777 });
  const e = deps({ fileOpsError: '"b" already exists' });
  assert.deepEqual(await handleRequest({ action: "rename", path: "/Users/m/a", root: "/Users/m", name: "b" }, e), { ok: false, error: '"b" already exists' });
  assert.deepEqual(e.store["filer-pro.changed"], { at: 777 }, "a failure signals too: on a machine it may still have happened (#31)");
});

test("delete: check first, then the dialog unless confirm, then remove", async () => {
  const d = deps({ answers: [{ choice: "delete" }] });
  assert.deepEqual(await handleRequest({ action: "delete", path: "/Users/m/x/a.txt", root: "/Users/m/x", confirm: false }, d), { ok: true, trashed: true, trash_path: "/Users/m/.Trash/a.txt", name: "a.txt", isDir: false });
  assert.deepEqual(d.asked[0], { batch: "b1#1", item: { name: "a.txt", isDir: false, path: "/Users/m/x/a.txt", machine: null, trash: true }, choices: ["delete", "cancel"], remaining: 1 });
  assert.deepEqual(d.fileOpsCalls.map((c) => c[0]), ["check", "remove"]);
  assert.deepEqual(d.store["filer-pro.changed"], { at: 777 });
  const c = deps({ answers: [{ choice: "cancel" }] });
  assert.deepEqual(await handleRequest({ action: "delete", machine: "box", path: "/srv/d", root: "/srv", confirm: false }, c), { ok: false, error: "Cancelled" });
  assert.equal(c.asked[0].item.trash, false);
  assert.equal(c.asked[0].item.machine, "box");
  assert.equal(c.asked[0].item.isDir, true);
  assert.equal(c.fileOpsCalls.some((x) => x[0] === "remove"), false);
  assert.equal(c.store["filer-pro.changed"], undefined);
  const k = deps();
  assert.deepEqual(await handleRequest({ action: "delete", machine: "box", path: "/srv/d", root: "/srv", confirm: true }, k), { ok: true, trashed: false, name: "d", isDir: true });
  assert.equal(k.asked.length, 0);
  const g = deps({ fileOpsError: "Refusing to delete the shown folder" });
  assert.deepEqual(await handleRequest({ action: "delete", path: "/Users/m/x", root: "/Users/m/x", confirm: true }, g), { ok: false, error: "Refusing to delete the shown folder" });
  assert.equal(g.fileOpsCalls.some((x) => x[0] === "remove"), false);
});

test("delete: only the answer delete deletes; replace, merge, ok, nothing, a closed dialog are all Cancelled", async () => {
  for (const answer of [{ choice: "replace" }, { choice: "merge" }, { choice: "keep_both" }, { choice: "ok" }, { choice: "transfer_anyway" }, { choice: "DELETE" }, { choice: "Delete " }, {}, { choice: undefined }]) {
    const d = deps({ answers: [answer] });
    assert.deepEqual(await handleRequest({ action: "delete", path: "/Users/m/x/a.txt", root: "/Users/m/x", confirm: false }, d), { ok: false, error: "Cancelled" }, JSON.stringify(answer));
    assert.equal(d.fileOpsCalls.some((x) => x[0] === "remove"), false, JSON.stringify(answer));
  }
  const none = deps({ answers: [] });
  assert.deepEqual(await handleRequest({ action: "delete", path: "/Users/m/x/a.txt", root: "/Users/m/x", confirm: false }, none), { ok: false, error: "Cancelled" });
});

test("delete without a dialog needs confirm to be exactly true", async () => {
  const d = deps();
  const r = await handleRequest({ action: "delete", path: "/Users/m/x/a.txt", root: "/Users/m/x", confirm: "true" }, d);
  assert.deepEqual(r, { ok: false, error: "Cancelled" });
  assert.equal(d.fileOpsCalls.some((x) => x[0] === "remove"), false);
});

// ---- open and mode: the panel shows a file like a click on its row (test infrastructure for the app check)

test("parseRequest: open and mode", () => {
  assert.deepEqual(parseRequest('{"action":"open","path":"/Users/m/x/README.md"}'), { action: "open", path: "/Users/m/x/README.md" });
  assert.deepEqual(parseRequest('{"action":"open","machine":null,"path":"/a/b.md","mode":"source"}'), { action: "open", path: "/a/b.md", mode: "source" });
  assert.deepEqual(parseRequest('{"action":"open","machine":"box","path":"/srv/a.md","mode":"preview"}'), { action: "open", machine: "box", path: "/srv/a.md", mode: "preview" });
  assert.deepEqual(parseRequest('{"action":"open","path":"a.md"}'), { error: "path must be absolute" });
  assert.deepEqual(parseRequest('{"action":"open"}'), { error: "path is required" });
  assert.deepEqual(parseRequest('{"action":"open","path":"/a","mode":"raw"}'), { error: "mode must be preview or source" });
  assert.deepEqual(parseRequest('{"action":"open","machine":3,"path":"/a"}'), { error: "machine must be a name" });
  assert.deepEqual(parseRequest('{"action":"mode","mode":"source"}'), { action: "mode", mode: "source" });
  assert.deepEqual(parseRequest('{"action":"mode"}'), { error: "mode must be preview or source" });
});

test("resultText carries shown and mode", () => {
  assert.deepEqual(JSON.parse(resultText({ ok: true, shown: "/a/b.md", mode: "preview" })), { ok: true, shown: "/a/b.md", mode: "preview" });
});

test("panelPlan: only a file below the folder the panel shows, on the same machine", () => {
  const local = { on: null, root: "/Users/m/x", file: null };
  assert.deepEqual(panelPlan(local, { action: "open", on: null, path: "/Users/m/x/docs/a.md" }), { hit: true, rel: "docs/a.md" });
  assert.deepEqual(panelPlan({ ...local, root: "/" }, { action: "open", on: null, path: "/etc/hosts" }), { hit: true, rel: "etc/hosts" });
  assert.deepEqual(panelPlan(local, { action: "open", on: null, path: "/Users/m/xy/a.md" }), { hit: false, error: "Not below the shown folder: /Users/m/x" });
  assert.deepEqual(panelPlan(local, { action: "open", on: null, path: "/Users/m/x" }), { hit: false, error: "Not below the shown folder: /Users/m/x" });
  assert.deepEqual(panelPlan(local, { action: "open", on: null, path: "/Users/m/x/../y/a.md" }), { hit: false, error: 'Path must not contain ".", ".." or "//"' });
  assert.deepEqual(panelPlan(local, { action: "open", on: "box", path: "/Users/m/x/a.md" }), { hit: false, error: "The panel shows this computer, not box" });
  assert.deepEqual(panelPlan({ on: "box", root: "/srv" }, { action: "open", on: null, path: "/srv/a" }), { hit: false, error: "The panel shows box, not this computer" });
  assert.deepEqual(panelPlan({ on: null, root: null }, { action: "open", on: null, path: "/a" }), { hit: false, error: "The panel shows no folder" });
  assert.deepEqual(panelPlan(local, { action: "mode", mode: "source" }), { hit: false, error: "No file is shown" });
  assert.deepEqual(panelPlan({ ...local, file: "a.md" }, { action: "mode", mode: "source" }), { hit: true, rel: "a.md" });
});

test("openResult: what the panel shows after loading", () => {
  assert.deepEqual(openResult("/x/a.md", undefined, { mode: "preview", preview: true }), { ok: true, shown: "/x/a.md", mode: "preview" });
  assert.deepEqual(openResult("/x/a.js", undefined, { mode: "source", preview: false }), { ok: true, shown: "/x/a.js", mode: "source" });
  assert.deepEqual(openResult("/x/a.md", "source", { mode: "source", preview: true }), { ok: true, shown: "/x/a.md", mode: "source" });
  assert.deepEqual(openResult("/x/a.js", "preview", { mode: "source", preview: false }), { ok: false, error: "No preview for this file", shown: "/x/a.js", mode: "source" });
  assert.deepEqual(openResult("/x/b.bin", undefined, { error: "Binary file · no text preview", mode: "source" }), { ok: false, error: "Binary file · no text preview", shown: "/x/b.bin", mode: "source" });
});

test("modeResult: switch only where a preview exists", () => {
  assert.deepEqual(modeResult("/x/a.md", "source", true), { ok: true, shown: "/x/a.md", mode: "source" });
  assert.deepEqual(modeResult("/x/a.md", "preview", true), { ok: true, shown: "/x/a.md", mode: "preview" });
  assert.deepEqual(modeResult("/x/a.js", "preview", false), { ok: false, error: "No preview for this file", shown: "/x/a.js", mode: "source" });
  assert.deepEqual(modeResult("/x/a.js", "source", false), { ok: true, shown: "/x/a.js", mode: "source" });
});

function panelBus() {
  const store = {};
  let t = 0;
  return { store, getShared: (k) => store[k], setShared: (k, v) => { store[k] = v; }, newBatchId: () => "s1", sleep: async (ms) => { t += ms; }, now: () => t };
}

test("askPanel: posts the request for the panel copies and returns the answer of the one that shows it", async () => {
  const bus = panelBus();
  const sleep = bus.sleep;
  bus.sleep = async (ms) => {
    await sleep(ms);
    const s = bus.store["filer-pro.show"];
    assert.deepEqual(s, { id: "s1", action: "open", on: "box", path: "/srv/a.md", mode: "source" });
    answerShow(bus, s.id, false, { ok: false, error: "Not below the shown folder: /other" }); // another copy
    answerShow(bus, s.id, true, { ok: true, shown: "/srv/a.md", mode: "source" });
    answerShow(bus, s.id, false, { ok: false, error: "late miss" }); // never overwrites a hit
  };
  assert.deepEqual(await handleRequest({ action: "open", machine: "box", path: "/srv/a.md", mode: "source" }, bus), { ok: true, shown: "/srv/a.md", mode: "source" });
  assert.equal(bus.store["filer-pro.show"], null);
});

test("askPanel: no hit in time gives the miss, no answer at all says the panel is not open", async () => {
  const miss = panelBus();
  const sleep = miss.sleep;
  miss.sleep = async (ms) => { await sleep(ms); answerShow(miss, "s1", false, { ok: false, error: "Not below the shown folder: /x" }); };
  assert.deepEqual(await askPanel({ action: "mode", mode: "preview" }, miss), { ok: false, error: "Not below the shown folder: /x" });
  const none = panelBus();
  assert.deepEqual(await askPanel({ action: "mode", mode: "preview" }, none), { ok: false, error: "The Filer Pro panel is not open" });
  assert.ok(none.now() >= 3000);
  assert.equal(none.store["filer-pro.show"], null);
});

test("askPanel: a copy that took the request (answer without result) is waited for while the file loads", async () => {
  const bus = panelBus();
  const sleep = bus.sleep;
  bus.sleep = async (ms) => {
    await sleep(ms);
    if (bus.now() === 100) answerShow(bus, "s1", true, null);
    if (bus.now() === 8000) answerShow(bus, "s1", true, { ok: true, shown: "/x/a.md", mode: "preview" });
  };
  assert.deepEqual(await askPanel({ action: "open", path: "/x/a.md" }, bus), { ok: true, shown: "/x/a.md", mode: "preview" });
});

test("parseRequest: mkdir", () => {
  assert.deepEqual(parseRequest('{"action":"mkdir","machine":"box","path":"/a/b","name":"c"}'), { action: "mkdir", machine: "box", path: "/a/b", name: "c" });
  assert.deepEqual(parseRequest('{"action":"mkdir","path":"/a/b","name":"c"}'), { action: "mkdir", path: "/a/b", name: "c" });
  assert.deepEqual(parseRequest('{"action":"mkdir","path":"/a/b"}'), { error: "name is required" });
  assert.deepEqual(parseRequest('{"action":"mkdir","path":"b","name":"c"}'), { error: "path must be absolute" });
});

test("mkdir passes through fileOps, signals the tree and asks it to open the parent", async () => {
  const d = deps();
  assert.deepEqual(await handleRequest({ action: "mkdir", machine: "box", path: "/srv/in", name: "n" }, d), { ok: true, path: "/srv/in/n" });
  assert.deepEqual(d.fileOpsCalls[0], ["mkdir", { on: "box", path: "/srv/in", name: "n" }]);
  assert.deepEqual(d.store["filer-pro.changed"], { at: 777, expand: { machine: "box", folder: "/srv/in" } });
  const e = deps({ fileOpsError: 'An item named "n" already exists' });
  assert.deepEqual(await handleRequest({ action: "mkdir", path: "/Users/m/a", name: "n" }, e), { ok: false, error: 'An item named "n" already exists' });
  assert.deepEqual(e.store["filer-pro.changed"], { at: 777 }, "a failure signals too, without opening the parent");
});

// ---- delete against the real file system (only inside a throw-away folder below tmp/ of the repo)
test("delete: a link in the path bent while the dialog is open never deletes the other target", async (t) => {
  const fs = await import("node:fs"), path = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { createFileOps } = await import("../mods/filer-pro/lib/fileops.js");
  const d = fs.realpathSync(mkTmpSync("delete-race-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  for (const rel of ["rel1", "rel2"]) { fs.mkdirSync(`${d}/${rel}/logs`, { recursive: true }); fs.writeFileSync(`${d}/${rel}/logs/f`, rel); }
  fs.mkdirSync(`${d}/home`);
  fs.symlinkSync(`${d}/rel1`, `${d}/current`);
  // The machine "box" is this computer: the scripts run for real with sh, inside d only.
  const exec = async (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, HOME: `${d}/home` } });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const shown = [];
  const out = await handleRequest({ action: "delete", machine: "box", path: `${d}/current/logs`, root: d, confirm: false }, {
    fileOps: createFileOps({ exec }), newBatchId: () => "b1", now: () => 1, getShared: () => undefined, setShared: () => {},
    ask: async (pending) => {
      shown.push(pending.item.path);
      fs.unlinkSync(`${d}/current`);
      fs.symlinkSync(`${d}/rel2`, `${d}/current`); // current -> rel1 becomes rel2 while the dialog is open
      return { choice: "delete" };
    },
  });
  assert.deepEqual(shown, [`${d}/rel1/logs`]);
  assert.deepEqual(out, { ok: false, error: "The item changed while the dialog was open" });
  assert.equal(fs.readFileSync(`${d}/rel1/logs/f`, "utf8"), "rel1");
  assert.equal(fs.readFileSync(`${d}/rel2/logs/f`, "utf8"), "rel2");
  // Unchanged link: the confirmed entry is deleted.
  const again = await handleRequest({ action: "delete", machine: "box", path: `${d}/current/logs`, root: d, confirm: false }, {
    fileOps: createFileOps({ exec }), newBatchId: () => "b2", now: () => 1, getShared: () => undefined, setShared: () => {},
    ask: async () => ({ choice: "delete" }),
  });
  assert.equal(again.ok, true);
  assert.equal(fs.existsSync(`${d}/rel2/logs`), false);
  assert.equal(fs.readFileSync(`${d}/rel1/logs/f`, "utf8"), "rel1");
});

test("askPanel: at the end it clears only its own filer-pro.show, never a later request's", async () => {
  const bus = panelBus();
  const sleep = bus.sleep;
  bus.sleep = async (ms) => {
    await sleep(ms);
    if (bus.now() === 200) bus.store["filer-pro.show"] = { id: "other", action: "mode", mode: "source" }; // a second request
  };
  assert.deepEqual(await askPanel({ action: "mode", mode: "preview" }, bus), { ok: false, error: "The Filer Pro panel is not open" });
  assert.deepEqual(bus.store["filer-pro.show"], { id: "other", action: "mode", mode: "source" });
});

// Issue #14: spelling of request paths ("." / ".." / "//" refused, "/" allowed as a folder).
const SPELL = { error: 'Path must not contain ".", ".." or "//"' };
test("parseRequest: copy, upload, clip and paste refuse ., .. and // in paths", () => {
  for (const bad of ["/a/../b", "/a/./b", "//home/u/a.txt", "/a//b", "/link/.."]) {
    assert.deepEqual(parseRequest(JSON.stringify({ action: "copy", paths: [bad] })), SPELL, bad);
    assert.deepEqual(parseRequest(JSON.stringify({ action: "copy", paths: ["/a"], folder: bad })), SPELL, bad);
    assert.deepEqual(parseRequest(JSON.stringify({ action: "upload", machine: "box", paths: [bad], folder: "/s" })), SPELL, bad);
    assert.deepEqual(parseRequest(JSON.stringify({ action: "upload", machine: "box", paths: ["/a"], folder: bad })), SPELL, bad);
    assert.deepEqual(parseRequest(JSON.stringify({ action: "clip", path: bad })), SPELL, bad);
    assert.deepEqual(parseRequest(JSON.stringify({ action: "paste", folder: bad })), SPELL, bad);
  }
});
test("parseRequest: the root folder / and a trailing slash are valid folders", () => {
  assert.deepEqual(parseRequest('{"action":"paste","folder":"/"}'), { action: "paste", folder: "/" });
  assert.deepEqual(parseRequest('{"action":"paste","folder":"/a/"}'), { action: "paste", folder: "/a/" });
  assert.deepEqual(parseRequest('{"action":"copy","paths":["/a"],"folder":"/"}'), { action: "copy", paths: ["/a"], folder: "/" });
  assert.deepEqual(parseRequest('{"action":"upload","machine":"box","paths":["/a/"],"folder":"/"}'),
    { action: "upload", machine: "box", paths: ["/a/"], folder: "/" });
  assert.deepEqual(parseRequest('{"action":"clip","path":"/a/b"}'), { action: "clip", path: "/a/b", is_dir: false });
});
test("parseRequest: / is no valid source and says so", () => {
  assert.deepEqual(parseRequest('{"action":"copy","paths":["/"]}'), { error: '"/" cannot be copied' });
  assert.deepEqual(parseRequest('{"action":"copy","paths":["/a","//"]}'), { error: '"/" cannot be copied' });
  assert.deepEqual(parseRequest('{"action":"upload","machine":"box","paths":["/"],"folder":"/s"}'), { error: '"/" cannot be uploaded' });
  assert.deepEqual(parseRequest('{"action":"clip","path":"/"}'), { error: '"/" cannot be copied or cut' });
  assert.deepEqual(parseRequest('{"action":"clip","path":"/","cut":true}'), { error: '"/" cannot be copied or cut' });
});

test("parseRequest: clip with cut, paste with root", () => {
  assert.deepEqual(parseRequest('{"action":"clip","machine":"box","path":"/a","cut":true}'), { action: "clip", machine: "box", path: "/a", is_dir: false, cut: true });
  assert.deepEqual(parseRequest('{"action":"clip","path":"/a","cut":"yes"}'), { action: "clip", path: "/a", is_dir: false });
  assert.deepEqual(parseRequest('{"action":"paste","machine":"box","folder":"/in","root":"/srv"}'), { action: "paste", machine: "box", folder: "/in", root: "/srv" });
  assert.deepEqual(parseRequest('{"action":"paste","folder":"/in","root":"srv"}'), { error: "root must be absolute" });
});
test("resultText passes moved, noop and warning", () => {
  assert.equal(resultText({ ok: true, moved: true, path: "/in/a", warning: "w" }), '{\n  "ok": true,\n  "path": "/in/a",\n  "moved": true,\n  "warning": "w"\n}');
  assert.equal(resultText({ ok: true, noop: true }), '{\n  "ok": true,\n  "noop": true\n}');
});

const cut = (machine, path, isDir = false) => ({ "filer-pro.clipboard": { machine, path, isDir, at: 1, cut: true } });
const found = (o = {}) => ({ ok: true, src: "/srv/real/a", name: "a", isDir: false, destDir: "/srv/in", dest: "/srv/in/a", exists: false, destIsDir: false, replaceError: null, ...o });
const item = (o = {}) => ({ name: "a", isDir: false, path: "/srv/real/a", machine: "box", trash: false, action: "move", direction: "remote", destDir: "/srv/in", destIsDir: false, ...o });
const paste = (extra = {}) => ({ action: "paste", machine: "box", folder: "/srv/in", root: "/srv", ...extra });

test("clip with cut stores the mark, clip without clears it", async () => {
  const d = deps();
  await handleRequest({ action: "clip", machine: "box", path: "/srv/a", is_dir: false, cut: true }, d);
  assert.deepEqual(d.store["filer-pro.clipboard"], { machine: "box", path: "/srv/a", isDir: false, at: 777, cut: true });
  await handleRequest({ action: "clip", machine: "box", path: "/srv/a", is_dir: false }, d);
  assert.deepEqual(d.store["filer-pro.clipboard"], { machine: "box", path: "/srv/a", isDir: false, at: 777 });
});
test("paste after cut on another machine is refused and starts nothing", async () => {
  for (const [store, extra] of [[cut("box", "/srv/a"), { machine: undefined }], [cut("box", "/srv/a"), { machine: "other" }], [cut(null, "/Users/me/a"), { machine: "box" }]]) {
    const d = deps({ store });
    assert.deepEqual(await handleRequest(paste(extra), d), { ok: false, error: "Cut and Paste work only within one machine" });
    assert.deepEqual(d.calls, []); assert.deepEqual(d.fileOpsCalls, []);
  }
});
test("move without root is refused", async () => {
  const d = deps({ store: cut("box", "/srv/a") });
  assert.deepEqual(await handleRequest({ action: "paste", machine: "box", folder: "/srv/in" }, d), { ok: false, error: "root is required" });
  assert.deepEqual(d.fileOpsCalls, []);
});
test("move: inspect, then move with the physical paths as expect; clipboard cleared, tree reloads", async () => {
  const d = deps({ store: cut("box", "/srv/a"), inspect: found() });
  assert.deepEqual(await handleRequest(paste(), d), { ok: true, moved: true, path: "/srv/in/a", name: "a", isDir: false });
  assert.deepEqual(d.fileOpsCalls, [["inspectMove", { on: "box", src: "/srv/a", destDir: "/srv/in", root: "/srv" }], ["move", { on: "box", src: "/srv/a", destDir: "/srv/in", root: "/srv", choice: "new", expect: "/srv/real/a", expectDest: "/srv/in/a", reserved: [] }]]);
  assert.equal(d.store["filer-pro.clipboard"], null); assert.deepEqual(d.store["filer-pro.changed"], { at: 777 }); assert.deepEqual(d.asked, []);
});
test("the clipboard is only cleared when it is still the same entry", async () => {
  const d = deps({ store: cut("box", "/srv/a"), inspect: found() });
  d.fileOps.move = async (a) => { d.store["filer-pro.clipboard"] = { machine: "box", path: "/srv/z", isDir: false, at: 9, cut: true }; return { ok: true, moved: true, path: "/srv/in/a", name: "a", isDir: false }; };
  assert.equal((await handleRequest(paste(), d)).ok, true);
  assert.deepEqual(d.store["filer-pro.clipboard"], { machine: "box", path: "/srv/z", isDir: false, at: 9, cut: true });
});
test("move to same folder is no-op without dialog; the clipboard stays", async () => {
  const d = deps({ store: cut("box", "/srv/a"), inspect: { ok: true, noop: true, src: "/srv/real/a" } });
  assert.deepEqual(await handleRequest(paste({ folder: "/srv" }), d), { ok: true, noop: true });
  assert.equal(d.fileOpsCalls.length, 1); assert.deepEqual(d.store["filer-pro.clipboard"], cut("box", "/srv/a")["filer-pro.clipboard"]); assert.equal(d.store["filer-pro.changed"], undefined);
});
test("paste after the source vanished reports no such file", async () => {
  const d = deps({ store: cut("box", "/srv/a"), inspect: { ok: false, error: "No such file or folder: /srv/a" } });
  assert.deepEqual(await handleRequest(paste(), d), { ok: false, error: "No such file or folder: /srv/a" });
  assert.equal(d.fileOpsCalls.length, 1); assert.ok(d.store["filer-pro.clipboard"]);
});
test("move conflict asks replace, keep both, cancel with a move item", async () => {
  const d = deps({ store: cut("box", "/srv/a"), inspect: found({ exists: true, destIsDir: true }), answers: [{ choice: "keep_both" }] });
  assert.equal((await handleRequest(paste(), d)).ok, true);
  assert.deepEqual(d.asked, [{ batch: "b1#1", item: item({ destIsDir: true }), choices: ["replace", "keep_both", "cancel"], remaining: 1 }]);
  assert.equal(d.fileOpsCalls[1][1].choice, "keep_both");
  const l = deps({ store: cut(null, "/Users/me/a"), inspect: found({ exists: true }), answers: [{ choice: "cancel" }] });
  assert.deepEqual(await handleRequest({ action: "paste", folder: "/srv/in", root: "/srv" }, l), { ok: false, error: "Cancelled" });
  assert.deepEqual(l.asked[0].item, item({ machine: null, trash: true, direction: "local" })); assert.equal(l.fileOpsCalls.length, 1); assert.ok(l.store["filer-pro.clipboard"]);
});
test("conflict answers the move dialog up front: merge is replace, cancel only when the target exists, keep_both without target moves as new", async () => {
  let d = deps({ store: cut("box", "/srv/a"), inspect: found({ exists: true }) });
  await handleRequest(paste({ conflict: "merge" }), d);
  assert.deepEqual(d.asked, []); assert.equal(d.fileOpsCalls[1][1].choice, "replace");
  d = deps({ store: cut("box", "/srv/a"), inspect: found({ exists: true }) });
  assert.deepEqual(await handleRequest(paste({ conflict: "cancel" }), d), { ok: false, error: "Cancelled" }); assert.equal(d.fileOpsCalls.length, 1);
  for (const conflict of ["cancel", "keep_both", "replace"]) {
    d = deps({ store: cut("box", "/srv/a"), inspect: found() });
    assert.equal((await handleRequest(paste({ conflict }), d)).ok, true, conflict);
    assert.equal(d.fileOpsCalls[1][1].choice, "new", conflict);
  }
});
test("move replace on a target with a replaceError is refused before moving, keep both goes on", async () => {
  const err = "Cannot replace a folder that contains the source";
  let d = deps({ store: cut("box", "/srv/a", true), inspect: found({ exists: true, destIsDir: true, isDir: true, replaceError: err }) });
  assert.deepEqual(await handleRequest(paste({ conflict: "replace" }), d), { ok: false, error: err }); assert.equal(d.fileOpsCalls.length, 1);
  d = deps({ store: cut("box", "/srv/a", true), inspect: found({ exists: true, destIsDir: true, isDir: true, replaceError: err }), answers: [{ choice: "replace" }] });
  assert.deepEqual(await handleRequest(paste(), d), { ok: false, error: err }); assert.equal(d.asked.length, 1);
  d = deps({ store: cut("box", "/srv/a", true), inspect: found({ exists: true, destIsDir: true, isDir: true, replaceError: err }) });
  assert.equal((await handleRequest(paste({ conflict: "keep_both" }), d)).ok, true); assert.equal(d.fileOpsCalls[1][1].choice, "keep_both");
});
test("move keep both skips names reserved by running jobs", async () => {
  const jobs = { j1: { state: "running", direction: "remote", machine: "box", destDir: "/srv/in", dest: "/srv/in/a-1" }, j2: { state: "running", direction: "up", machine: "box", destDir: "/srv/in", dest: "/srv/in/a-2" }, j3: { state: "running", direction: "local", machine: null, destDir: "/srv/in", dest: "/srv/in/a-3" }, j4: { state: "done", direction: "remote", machine: "box", destDir: "/srv/in", dest: "/srv/in/a-4" }, j5: { state: "running", direction: "remote", machine: "box", destDir: "/srv/other", dest: "/srv/other/a-5" } };
  const d = deps({ store: { ...cut("box", "/srv/a"), "filer-pro.jobs": jobs }, inspect: found({ exists: true }) });
  await handleRequest(paste({ conflict: "keep_both" }), d);
  assert.deepEqual(d.fileOpsCalls[1][1].reserved, ["a-1", "a-2"]);
});
test("cross-volume asks copy-instead and runs the copy path, keeping the clipboard until the job is done", async () => {
  let d = deps({ store: cut("box", "/srv/a"), inspect: { ok: true, crossVolume: true, src: "/srv/real/a", name: "a", isDir: false }, answers: [{ choice: "copy_instead" }] });
  assert.deepEqual(await handleRequest(paste(), d), { ok: true, jobs: [{ id: "j1" }] });
  assert.deepEqual(d.asked[0], { batch: "b1#1", item: (({ destIsDir: _omit, ...rest }) => rest)(item()), choices: ["copy_instead", "cancel"], remaining: 1 });
  assert.deepEqual(d.calls, [["inspect", { direction: "remote", machine: "box", src: "/srv/a", destDir: "/srv/in" }], ["start", { direction: "remote", machine: "box", src: "/srv/a", destDir: "/srv/in", choice: "new", isDir: false }]]);
  assert.equal(d.fileOpsCalls.length, 1);
  d = deps({ store: cut("box", "/srv/a"), inspect: { ok: true, crossVolume: true, src: "/srv/real/a", name: "a", isDir: false }, answers: [{ choice: "cancel" }] });
  assert.deepEqual(await handleRequest(paste(), d), { ok: false, error: "Cancelled" }); assert.deepEqual(d.calls, []); assert.ok(d.store["filer-pro.clipboard"]);
});
test("copy-instead leaves the Cut clipboard in place and names the copy job (jobs.js clears it on success)", async () => {
  const d = deps({ store: cut("box", "/srv/a"), inspect: { ok: true, crossVolume: true, src: "/srv/real/a", name: "a", isDir: false }, answers: [{ choice: "copy_instead" }] });
  assert.equal((await handleRequest(paste(), d)).ok, true);
  assert.deepEqual(d.store["filer-pro.clipboard"], { ...cut("box", "/srv/a")["filer-pro.clipboard"], copyJobs: ["j1"] });
});
test("copy-instead clears the clipboard at once when the job is already done", async () => {
  const d = deps({ store: { ...cut("box", "/srv/a"), "filer-pro.jobs": { j1: { id: "j1", state: "done" } } }, inspect: { ok: true, crossVolume: true, src: "/srv/real/a", name: "a", isDir: false }, answers: [{ choice: "copy_instead" }] });
  assert.equal((await handleRequest(paste(), d)).ok, true);
  assert.equal(d.store["filer-pro.clipboard"], null);
});
test("a cancelled copy-instead conflict keeps the clipboard", async () => {
  const d = deps({ store: cut("box", "/srv/a"), inspect: { ok: true, crossVolume: true, src: "/srv/real/a", name: "a", isDir: false }, info: { name: "a", exists: true }, answers: [{ choice: "copy_instead" }, { choice: "cancel" }] });
  assert.deepEqual(await handleRequest(paste(), d), { ok: false, error: "Cancelled" });
  assert.equal(d.asked.length, 2); assert.deepEqual(d.asked[1].choices, ["replace", "keep_both", "cancel"]); assert.ok(d.store["filer-pro.clipboard"]);
});

// ---- Replace over a mount (issue #31): like Move, Replace stays a choice and is refused after it, per entry.
const MOUNT_ERR = "Refusing to replace, a file system is mounted at: /srv/in/dir/mnt";
const upDirs = (x = {}) => ({ action: "upload", machine: "box", paths: ["/Users/m/dir", "/Users/m/other"], folder: "/srv/in", ...x });
const mountedInspect = (d) => async (a) => (d.calls.push(["inspect", a]), {
  name: a.src.split("/").pop(), isDir: true, exists: true, linkWarning: null, linkTitle: null,
  ...(a.src === "/Users/m/dir" ? { replaceError: MOUNT_ERR } : {}),
});
const mountStarts = (d) => d.calls.filter((c) => c[0] === "start").map((c) => [c[1].src, c[1].choice]);

test("upload: Replace chosen in the dialog over a mount is refused for that entry, the dialog still offers it", async () => {
  const d = deps({ answers: [{ choice: "replace", apply_to_all: false }, { choice: "replace", apply_to_all: false }] });
  d.jobs.inspect = mountedInspect(d);
  const r = await handleRequest(upDirs(), d);
  assert.deepEqual(d.asked[0].choices, ["merge", "replace", "keep_both", "cancel"]);
  assert.deepEqual(mountStarts(d), [["/Users/m/other", "replace"]]);
  assert.deepEqual(r, { ok: true, jobs: [{ id: "j1" }], errors: [{ path: "/Users/m/dir", error: MOUNT_ERR }] });
});

test("upload: Replace with Apply to all and preset conflict replace give the error per entry", async () => {
  for (const [d, req] of [
    [deps({ answers: [{ choice: "replace", apply_to_all: true }] }), upDirs()],
    [deps(), upDirs({ conflict: "replace" })],
  ]) {
    d.jobs.inspect = mountedInspect(d);
    const r = await handleRequest(req, d);
    assert.equal(d.asked.length, req.conflict ? 0 : 1);
    assert.deepEqual(mountStarts(d), [["/Users/m/other", "replace"]]);
    assert.deepEqual(r, { ok: true, jobs: [{ id: "j1" }], errors: [{ path: "/Users/m/dir", error: MOUNT_ERR }] });
  }
  const only = deps();
  only.jobs.inspect = mountedInspect(only);
  assert.deepEqual(await handleRequest(upDirs({ paths: ["/Users/m/dir"], conflict: "replace" }), only),
    { ok: false, error: MOUNT_ERR, errors: [{ path: "/Users/m/dir", error: MOUNT_ERR }] });
  assert.deepEqual(mountStarts(only), []);
});

// The real path: handleRequest -> createJobs.inspect -> REPLACE_CHECK_SCRIPT in sh, on real folders below tmp/. Only
// exec is stood in for, because the machine side would need ssh: it runs every probe here, on this computer.
test("upload: Replace of \"Dir\" over \"dir\" with a mount in it is refused by the real check, nothing starts", async () => {
  const d = await mkTmp("req-mount-");
  const p = fs.realpathSync(d);
  fs.mkdirSync(`${d}/src/Dir`, { recursive: true }); fs.mkdirSync(`${d}/in/dir/mnt`, { recursive: true });
  fs.writeFileSync(`${d}/info.txt`, `36 35 98:0 / ${p}/in/dir/mnt rw,relatime shared:1 - ext4 /dev/sdb1 rw\n`);
  fs.writeFileSync(`${d}/CaseProbe`, "");
  const name = fs.existsSync(`${d}/caseprobe`) ? "Dir" : "dir"; // a case-sensitive file system: the exact name
  if (name === "dir") fs.renameSync(`${d}/src/Dir`, `${d}/src/dir`);
  const exec = async (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const real = createJobs({ ...createFake().deps(), exec, mountTables: [`${d}/info.txt`, ""] });
  const dd = deps();
  dd.jobs.inspect = (a) => (dd.calls.push(["inspect", a]), real.inspect(a));
  const err = `Refusing to replace, a file system is mounted at: ${p}/in/dir/mnt`;
  const r = await handleRequest({ action: "upload", machine: "box", paths: [`${d}/src/${name}`], folder: `${d}/in`, conflict: "replace" }, dd);
  assert.deepEqual(r, { ok: false, error: err, errors: [{ path: `${d}/src/${name}`, error: err }] });
  assert.deepEqual(mountStarts(dd), []);
  assert.equal(fs.existsSync(`${d}/in/dir/mnt`), true);
});

// ---- Merge of a linked folder (#46): not offered in the dialog, refused after a preset or Apply to all, per entry.
const LINK_ERR = "Cannot merge a symlink into a folder: /Users/m/link";
const linkedInspect = (d) => async (a) => (d.calls.push(["inspect", a]), {
  name: a.src.split("/").pop(), isDir: true, exists: true, linkWarning: null, linkTitle: null,
  ...(a.src === "/Users/m/link" ? { mergeError: LINK_ERR } : {}),
});

test("copy of a linked folder over a folder: the dialog offers no Merge; preset and Apply to all merge are refused for it (#46)", async () => {
  const asked = deps({ answers: [{ choice: "replace", apply_to_all: false }, { choice: "merge", apply_to_all: false }] });
  asked.jobs.inspect = linkedInspect(asked);
  await runTransfers({ direction: "local", machine: null, paths: ["/Users/m/link", "/Users/m/real"], destDir: "/Users/m/in" }, asked);
  assert.deepEqual(asked.asked[0].choices, ["replace", "keep_both", "cancel"]);
  assert.equal(asked.asked[0].item.mergeError, LINK_ERR);
  assert.deepEqual(asked.asked[1].choices, ["merge", "replace", "keep_both", "cancel"]);
  assert.deepEqual(mountStarts(asked), [["/Users/m/link", "replace"], ["/Users/m/real", "merge"]]);
  for (const [d, req] of [
    [deps({ answers: [{ choice: "merge", apply_to_all: true }] }), { paths: ["/Users/m/real", "/Users/m/link"] }],
    [deps(), { conflict: "merge" }],
  ]) {
    d.jobs.inspect = linkedInspect(d);
    const r = await runTransfers({ direction: "local", machine: null, paths: ["/Users/m/link", "/Users/m/real"], destDir: "/Users/m/in", ...req }, d);
    assert.deepEqual(mountStarts(d), [["/Users/m/real", "merge"]]);
    assert.deepEqual(r, { ok: true, jobs: [{ id: "j1" }], errors: [{ path: "/Users/m/link", error: LINK_ERR }] });
  }
});

test("upload over a mount: Merge and Keep both still start", async () => {
  for (const choice of ["merge", "keep_both"]) {
    const d = deps();
    d.jobs.inspect = mountedInspect(d);
    const r = await handleRequest(upDirs({ paths: ["/Users/m/dir"], conflict: choice }), d);
    assert.equal(r.ok, true);
    assert.deepEqual(mountStarts(d), [["/Users/m/dir", choice]]);
  }
});

test("upload of a file over a mounted folder: preset merge counts as replace and is refused", async () => {
  const d = deps();
  d.jobs.inspect = async (a) => (d.calls.push(["inspect", a]), { name: "dir", isDir: false, exists: true, linkWarning: null, linkTitle: null, replaceError: MOUNT_ERR });
  assert.deepEqual(await handleRequest(upDirs({ paths: ["/Users/m/dir"], conflict: "merge" }), d),
    { ok: false, error: MOUNT_ERR, errors: [{ path: "/Users/m/dir", error: MOUNT_ERR }] });
  assert.deepEqual(mountStarts(d), []);
});

test("copy-instead over a mount: preset replace is refused, the Cut clipboard stays", async () => {
  const d = deps({ store: cut("box", "/srv/a"), inspect: { ok: true, crossVolume: true, src: "/srv/real/a", name: "a", isDir: true }, info: { name: "a", isDir: true, exists: true, replaceError: MOUNT_ERR }, answers: [{ choice: "copy_instead" }] });
  const before = d.store["filer-pro.clipboard"];
  assert.deepEqual(await handleRequest(paste({ conflict: "replace" }), d), { ok: false, error: MOUNT_ERR, errors: [{ path: "/srv/a", error: MOUNT_ERR }] });
  assert.deepEqual(mountStarts(d), []);
  assert.deepEqual(d.store["filer-pro.clipboard"], before);
});

// ---- #33: download paths, keep-both reservation with a trailing slash and in any letter case
test("download refuses a relative or badly spelled path and dest_dir", () => {
  const p = (o) => parseRequest(JSON.stringify({ action: "download", machine: "box", ...o }));
  assert.deepEqual(p({ path: "srv/a" }), { error: "path must be absolute" });
  assert.deepEqual(p({ path: "/srv/../a" }), { error: 'Path must not contain ".", ".." or "//"' });
  assert.deepEqual(p({ path: "/" }), { error: '"/" cannot be downloaded' });
  assert.deepEqual(p({ path: "/srv/a", dest_dir: "Downloads" }), { error: "dest_dir must be absolute" });
  assert.deepEqual(p({ path: "/srv/a", dest_dir: "/Users/me//x" }), { error: 'Path must not contain ".", ".." or "//"' });
  assert.deepEqual(p({ path: "/srv/a/", dest_dir: "/Users/me/x/" }), { action: "download", machine: "box", path: "/srv/a/", dest_dir: "/Users/me/x/" });
  assert.deepEqual(p({ path: "/srv/a", dest_dir: "/" }), { action: "download", machine: "box", path: "/srv/a", dest_dir: "/" });
  assert.deepEqual(p({ path: "/srv/a", dest_dir: 5 }), { error: "dest_dir must be absolute" });
  assert.deepEqual(p({ path: "/srv/a", dest_dir: "" }), { error: "dest_dir must be absolute" });
  assert.deepEqual(p({ path: "/srv/a", dest_dir: null }), { action: "download", machine: "box", path: "/srv/a" }); // null: download_folder
});
test("move keep both reserves names of running jobs whose folder has a trailing slash", async () => {
  const jobs = { j1: { state: "running", direction: "remote", machine: "box", destDir: "/srv/in/", dest: "/srv/in/a-1" } };
  const d = deps({ store: { ...cut("box", "/srv/a"), "filer-pro.jobs": jobs }, inspect: found({ exists: true }) });
  await handleRequest(paste({ folder: "/srv/in//", conflict: "keep_both" }), d);
  assert.deepEqual(d.fileOpsCalls[1][1].reserved, ["a-1"]);
});
test("same name in another letter case in one run: the later one is keep_both too (#33)", async () => {
  const d = deps();
  d.jobs.inspect = async (a) => ({ name: a.src.split("/").pop(), isDir: false, exists: false, linkWarning: null });
  await handleRequest(cp({ paths: ["/a/X.TXT", "/b/x.txt"] }), d);
  assert.deepEqual(d.calls.filter((c) => c[0] === "start").map((c) => [c[1].src, c[1].choice]), [["/a/X.TXT", "new"], ["/b/x.txt", "keep_both"]]);
});

test("#54: runTransfers puts the kind of the existing target into the dialog item", async () => {
  const d = deps({ answers: [{ choice: "replace", apply_to_all: false }] });
  d.jobs.inspect = async (a) => (d.calls.push(["inspect", a]), { name: "a", isDir: true, exists: true, destIsDir: false, linkWarning: null, linkTitle: null });
  await runTransfers({ direction: "local", machine: null, paths: ["/Users/m/a"], destDir: "/Users/m/in" }, d);
  assert.equal(d.asked[0].item.destIsDir, false);
  assert.deepEqual(d.asked[0].choices, ["replace", "keep_both", "cancel"]);
});

// Regression of #31 (no timer): an operation that failed may still have changed something (a folder deleted halfway, a
// move that set the old entry aside), so the tree gets the signal anyway; a cancel before anything ran sends none.
test("a failed delete or move still signals the tree; a cancelled one does not", async () => {
  const del = deps({ removeOut: { ok: false, error: "rm: /srv/d/x: Permission denied" } });
  assert.deepEqual(await handleRequest({ action: "delete", machine: "box", path: "/srv/d", root: "/srv", confirm: true }, del), { ok: false, error: "rm: /srv/d/x: Permission denied" });
  assert.deepEqual(del.store["filer-pro.changed"], { at: 777 });
  const cut = { "filer-pro.clipboard": { machine: "box", path: "/srv/a", isDir: false, at: 1, cut: true } };
  const mv = deps({ store: cut, moveOut: { ok: false, error: "Could not move: /srv/a. The old entry is now in: /srv/in/.a.fs-move.1" } });
  const out = await handleRequest({ action: "paste", machine: "box", folder: "/srv/in", root: "/srv" }, mv);
  assert.equal(out.ok, false);
  assert.deepEqual(mv.fileOpsCalls.map((c) => c[0]), ["inspectMove", "move"]);
  assert.deepEqual(mv.store["filer-pro.changed"], { at: 777 });
  assert.ok(mv.store["filer-pro.clipboard"], "the Cut stays after a failed move");
  const cancelled = deps({ store: cut, inspect: { ok: true, src: "/srv/a", name: "a", isDir: false, destDir: "/srv/in", dest: "/srv/in/a", exists: true, destIsDir: false, replaceError: null }, answers: [{ choice: "cancel" }] });
  assert.deepEqual(await handleRequest({ action: "paste", machine: "box", folder: "/srv/in", root: "/srv" }, cancelled), { ok: false, error: "Cancelled" });
  assert.equal(cancelled.store["filer-pro.changed"], undefined);
});

// Copy between two machines (#60): one warning per paste, after inspect and before the conflict dialog.
const crossClip = (extra = {}) => ({ "filer-pro.clipboard": { machine: "box", path: "/srv/a", isDir: false, at: 1, ...extra } });
const crossPaste = (x = {}) => ({ action: "paste", machine: "other", folder: "/in", ...x });
const WARN_ITEM = { name: "a", isDir: false, path: "/srv/a", from: "box", machine: "other", direction: "cross" };

test("paste cross: asks the warning once (copy / cancel), then inspects and starts with from", async () => {
  const d = deps({ store: crossClip(), answers: [{ choice: "copy" }] });
  assert.deepEqual(await handleRequest(crossPaste(), d), { ok: true, jobs: [{ id: "j1" }] });
  assert.equal(d.asked.length, 1);
  assert.deepEqual(d.asked[0].choices, ["copy", "cancel"]);
  assert.deepEqual(d.asked[0].item, { ...WARN_ITEM, count: 1, size: null }); // no sourceSize in this fake: size unknown
  assert.equal(d.asked[0].remaining, 1);
  assert.deepEqual(d.calls, [
    ["inspect", { direction: "cross", machine: "other", from: "box", src: "/srv/a", destDir: "/in" }],
    ["start", { direction: "cross", machine: "other", from: "box", src: "/srv/a", destDir: "/in", choice: "new", isDir: false }],
  ]);
});

test("paste cross: cancel and a closed dialog end Cancelled, no job", async () => {
  for (const answers of [[{ choice: "cancel" }], [{}], [{ choice: "replace" }]]) {
    const d = deps({ store: crossClip(), answers });
    assert.deepEqual(await handleRequest(crossPaste(), d), { ok: false, error: "Cancelled" });
    assert.equal(d.calls.some((c) => c[0] === "start"), false);
  }
});

test("paste cross: warn_cross_copy false asks nothing", async () => {
  const d = deps({ store: crossClip() });
  d.loadConfig = async () => ({ download_folder: "/x", warn_cross_copy: false });
  assert.equal((await handleRequest(crossPaste(), d)).ok, true);
  assert.equal(d.asked.length, 0);
  assert.equal(d.calls.at(-1)[1].from, "box");
});

test("paste cross: the warning comes before the conflict dialog; presets do not answer it", async () => {
  const d = deps({ store: crossClip(), info: { name: "a", exists: true }, answers: [{ choice: "copy" }, { choice: "keep_both" }] });
  assert.equal((await handleRequest(crossPaste(), d)).ok, true);
  assert.deepEqual(d.asked[0].choices, ["copy", "cancel"]);
  assert.ok(d.asked[1].choices.includes("keep_both") && !d.asked[1].choices.includes("copy"));
  assert.equal(d.calls.at(-1)[1].choice, "keep_both");
  const e = deps({ store: crossClip(), answers: [{ choice: "cancel" }] });
  assert.deepEqual(await handleRequest(crossPaste({ conflict: "replace", links: "transfer_anyway" }), e), { ok: false, error: "Cancelled" });
});

test("paste cross: no warning when every path errors in inspect", async () => {
  const d = deps({ store: crossClip(), info: { name: "a", error: "No such file or folder: /srv/a" } });
  assert.deepEqual(await handleRequest(crossPaste(), d), { ok: false, error: "No such file or folder: /srv/a", errors: [{ path: "/srv/a", error: "No such file or folder: /srv/a" }] });
  assert.equal(d.asked.length, 0);
});

test("paste cross: Cut across machines still errors; same-machine paste has no warning and no from", async () => {
  const d = deps({ store: crossClip({ cut: true }) });
  assert.deepEqual(await handleRequest(crossPaste(), d), { ok: false, error: "Cut and Paste work only within one machine" });
  const e = deps({ store: crossClip() });
  await handleRequest(crossPaste({ machine: "box" }), e);
  assert.equal(e.asked.length, 0);
  assert.equal("from" in e.calls[0][1] || "from" in e.calls[1][1], false);
});

test("runTransfers: warn is asked after inspect with its own batch id, before createBatch", async () => {
  const d = deps({ answers: [{ choice: "copy" }] });
  const r = await runTransfers({ direction: "cross", machine: "other", from: "box", paths: ["/srv/a"], destDir: "/in", warn: { item: WARN_ITEM } }, d);
  assert.equal(r.ok, true);
  assert.equal(d.calls[0][0], "inspect");
  assert.equal(d.asked[0].batch, "b1#0");
});

test("paste cross: the warning tells how many entries and bytes travel, measured on the source machine", async () => {
  const d = deps({ store: crossClip(), answers: [{ choice: "copy" }] });
  d.jobs.sourceSize = async (a) => (d.calls.push(["sourceSize", a]), 48_100_000);
  assert.equal((await handleRequest(crossPaste(), d)).ok, true);
  assert.deepEqual(d.calls[1], ["sourceSize", { direction: "cross", machine: "other", from: "box", src: "/srv/a" }]);
  assert.equal(d.asked[0].item.count, 1);
  assert.equal(d.asked[0].item.size, 48_100_000);
  const e = deps({ store: crossClip(), answers: [{ choice: "copy" }] });
  e.jobs.sourceSize = async () => null; // unknown or too slow: the dialog leaves the size out
  await handleRequest(crossPaste(), e);
  assert.equal(e.asked[0].item.size, null);
});

test("paste cross: Don't show again with Copy turns warn_cross_copy off; with Cancel nothing is saved", async () => {
  const saved = [];
  const d = deps({ store: crossClip(), answers: [{ choice: "copy", apply_to_all: true }] });
  d.saveConfig = async (edits) => (saved.push(edits), { ok: true });
  assert.equal((await handleRequest(crossPaste(), d)).ok, true);
  assert.deepEqual(saved, [{ warn_cross_copy: false }]);
  const e = deps({ store: crossClip(), answers: [{ choice: "cancel", apply_to_all: true }] });
  e.saveConfig = async (edits) => (saved.push(edits), { ok: true });
  assert.deepEqual(await handleRequest(crossPaste(), e), { ok: false, error: "Cancelled" });
  const f = deps({ store: crossClip(), answers: [{ choice: "copy" }] });
  f.saveConfig = async (edits) => (saved.push(edits), { ok: true });
  await handleRequest(crossPaste(), f);
  assert.equal(saved.length, 1, "only Copy with the box checked saves");
  // A failing save does not stop the copy.
  const g = deps({ store: crossClip(), answers: [{ choice: "copy", apply_to_all: true }] });
  g.saveConfig = async () => { throw new Error("disk full"); };
  assert.deepEqual(await handleRequest(crossPaste(), g), { ok: true, jobs: [{ id: "j1" }] });
});

test("runMove reserved names include a running cross job on the target machine", async () => {
  const jobs = { j1: { state: "running", direction: "cross", from: "other", machine: "box", destDir: "/srv/in", dest: "/srv/in/a-1" } };
  const d = deps({ store: { ...cut("box", "/srv/a"), "filer-pro.jobs": jobs }, inspect: found({ exists: true }) });
  await handleRequest(paste({ conflict: "keep_both" }), d);
  assert.deepEqual(d.fileOpsCalls[1][1].reserved, ["a-1"]);
});

// ---- extract (#57)
test("parseRequest: extract", () => {
  assert.deepEqual(parseRequest('{"action":"extract","path":"/Users/m/a.zip","how":"here"}'), { action: "extract", path: "/Users/m/a.zip", how: "here" });
  assert.deepEqual(parseRequest('{"action":"extract","machine":"box","path":"/s/a.tgz","how":"to","conflict":"keep_both","links":"cancel","reveal":true}'),
    { action: "extract", machine: "box", path: "/s/a.tgz", how: "to", conflict: "keep_both" });
  assert.deepEqual(parseRequest('{"action":"extract","path":"/a.zip","how":"there"}'), { error: "how must be here or to" });
  assert.deepEqual(parseRequest('{"action":"extract","path":"/a.zip"}'), { error: "how must be here or to" });
  assert.deepEqual(parseRequest('{"action":"extract","path":"a.zip","how":"here"}'), { error: "path must be absolute" });
  assert.deepEqual(parseRequest('{"action":"extract","path":"/","how":"here"}'), { error: '"/" cannot be extracted' });
  assert.deepEqual(parseRequest('{"action":"extract","path":"/a/../b.zip","how":"here"}'), { error: 'Path must not contain ".", ".." or "//"' });
  assert.deepEqual(parseRequest('{"action":"extract","machine":3,"path":"/a.zip","how":"here"}'), { error: "machine must be a name" });
  assert.deepEqual(parseRequest('{"action":"extract","path":"/a.zip","how":"here","conflict":"zap"}'), { error: "conflict must be one of replace, merge, keep_both, cancel" });
});

const XA = "/Users/m/Downloads/pics.tar.gz";
const XD = "/Users/m/Downloads";
function xdeps(over = {}) {
  const d = deps(over);
  const entries = over.entries ?? [{ name: "a.txt", isDir: false, exists: false }, { name: "d", isDir: true, exists: false }];
  const info = over.archive ?? { name: "pics.tar.gz", stem: "pics", family: "tar", tool: "tar", need: "gzip", total: null, destDir: XD, entries, taken: entries.filter((e) => e.exists).map((e) => e.name) };
  d.jobs.inspectArchive = async (a) => (d.calls.push(["inspectArchive", a]), over.archiveError ? { error: over.archiveError } : info);
  d.jobs.startExtract = async (a) => (d.calls.push(["startExtract", a]), { id: "x1" });
  d.loadConfig = async () => over.config ?? {};
  return d;
}
const xr = (x = {}) => ({ action: "extract", path: XA, how: "here", ...x });
const starts = (d) => d.calls.filter((c) => c[0] === "startExtract").map((c) => c[1]);

test("extract: no conflict starts with an empty plan, spaceCheck on by default and off with the setting", async () => {
  const d = xdeps();
  assert.deepEqual(await handleRequest(xr(), d), { ok: true, job: { id: "x1" } });
  assert.deepEqual(d.asked, []);
  assert.equal(starts(d).length, 1);
  assert.deepEqual([starts(d)[0].src, starts(d)[0].how, starts(d)[0].plan, starts(d)[0].info.name], [XA, "here", [], "pics.tar.gz"]);
  assert.deepEqual(d.calls.find((c) => c[0] === "inspectArchive")[1], { machine: undefined, src: XA, how: "here", spaceCheck: true });
  const e = xdeps({ config: { extract_space_check: false } });
  await handleRequest(xr({ machine: "box" }), e);
  assert.deepEqual(e.calls.find((c) => c[0] === "inspectArchive")[1], { machine: "box", src: XA, how: "here", spaceCheck: false });
});

test("extract: inspect errors (space, tool, unreadable) pass through, nothing starts", async () => {
  const d = xdeps({ archiveError: "Not enough space: 5 GB needed, 1 GB free" });
  assert.deepEqual(await handleRequest(xr(), d), { ok: false, error: "Not enough space: 5 GB needed, 1 GB free" });
  assert.deepEqual(starts(d), []);
});

const both = [{ name: "a.txt", isDir: false, exists: true, destIsDir: false }, { name: "d", isDir: true, exists: true, destIsDir: true }, { name: "n", isDir: false, exists: false }];

test("extract: one question per colliding entry; Replace and Merge go into the plan, Cancel skips", async () => {
  const d = xdeps({ entries: both, answers: [{ choice: "replace" }, { choice: "cancel" }] });
  assert.equal((await handleRequest(xr(), d)).ok, true);
  assert.equal(d.asked.length, 2);
  assert.deepEqual(d.asked[0].item, { key: "0", path: `${XD}/a.txt`, name: "a.txt", isDir: false, direction: "local", machine: undefined, exists: true, destIsDir: false, linkWarning: null });
  assert.deepEqual(d.asked[0].choices, ["replace", "keep_both", "cancel"]);
  assert.deepEqual(d.asked[1].choices, ["merge", "replace", "keep_both", "cancel"]);
  assert.deepEqual(starts(d)[0].plan, [{ entry: "a.txt", mode: "replace", name: "a.txt" }, { entry: "d", mode: "skip", name: "d" }]);
  const m = xdeps({ entries: both, answers: [{ choice: "cancel" }, { choice: "merge" }] });
  await handleRequest(xr({ machine: "box" }), m);
  assert.equal(m.asked[0].item.direction, "remote");
  assert.deepEqual(starts(m)[0].plan[1], { entry: "d", mode: "merge", name: "d" });
});

test("extract: Apply to all answers entries of the same kind once", async () => {
  const entries = [{ name: "a", isDir: false, exists: true, destIsDir: false }, { name: "b", isDir: false, exists: true, destIsDir: false }];
  const d = xdeps({ entries, answers: [{ choice: "keep_both", apply_to_all: true }] });
  await handleRequest(xr(), d);
  assert.equal(d.asked.length, 1);
  assert.deepEqual(starts(d)[0].plan, [{ entry: "a", mode: "new", name: "a-1" }, { entry: "b", mode: "new", name: "b-1" }]);
});

test("extract: cancelling every entry gives Cancelled and starts nothing", async () => {
  const d = xdeps({ entries: both.slice(0, 2), answers: [{ choice: "cancel", apply_to_all: true }, { choice: "cancel" }] });
  assert.deepEqual(await handleRequest(xr(), d), { ok: false, error: "Cancelled" });
  assert.deepEqual(starts(d), []);
});

test("extract: Keep Both avoids the folder, every top name, earlier choices and running jobs", async () => {
  const entries = [{ name: "a.txt", isDir: false, exists: true, destIsDir: false }, { name: "a-1.txt", isDir: false, exists: false }];
  const store = { "filer-pro.jobs": {
    j1: { id: "j1", state: "running", kind: "extract", destDir: XD, machine: null, names: ["A-2.txt"] },
    j2: { id: "j2", state: "running", direction: "down", destDir: XD, machine: "box", dest: `${XD}/a-3.txt` },
    j3: { id: "j3", state: "running", direction: "up", destDir: XD, machine: "box", dest: `${XD}/a-4.txt` },
    j4: { id: "j4", state: "done", kind: "extract", destDir: XD, machine: null, names: ["a-5.txt"] },
  } };
  const d = xdeps({ entries, store, answers: [{ choice: "keep_both" }] });
  await handleRequest(xr(), d);
  // a-1.txt is a top name of the archive, a-2.txt belongs to a running extract and a-3.txt to a running download here (down writes locally)
  assert.deepEqual(starts(d)[0].plan, [{ entry: "a.txt", mode: "new", name: "a-4.txt" }]);
});

test("extract: the archive's own name is never asked and always kept both", async () => {
  const entries = [{ name: "PICS.tar.gz", isDir: false, exists: true, destIsDir: false }, { name: "x", isDir: false, exists: false }];
  const d = xdeps({ entries, conflict: "replace" });
  await handleRequest(xr({ conflict: "replace" }), d);
  assert.deepEqual(d.asked, []);
  assert.deepEqual(starts(d)[0].plan, [{ entry: "PICS.tar.gz", mode: "new", name: "PICS-1.tar.gz" }]);
});

test("extract: Replace of a folder with a mount is refused per entry; all refused gives the error", async () => {
  const entries = [{ name: "d", isDir: true, exists: true, destIsDir: true, replaceError: "Refusing to replace, a file system is mounted at: /m" }, { name: "f", isDir: false, exists: false }];
  const d = xdeps({ entries, answers: [{ choice: "replace" }] });
  const r = await handleRequest(xr({ machine: "box" }), d);
  assert.deepEqual(r.errors, [{ path: `${XD}/d`, error: "Refusing to replace, a file system is mounted at: /m" }]);
  assert.equal(r.ok, true);
  assert.deepEqual(starts(d)[0].plan, [{ entry: "d", mode: "skip", name: "d" }]);
  const one = xdeps({ entries: entries.slice(0, 1), answers: [{ choice: "replace" }] });
  const o = await handleRequest(xr({ machine: "box" }), one);
  assert.deepEqual([o.ok, o.error, o.errors.length], [false, "Refusing to replace, a file system is mounted at: /m", 1]);
  assert.deepEqual(starts(one), []);
});

test("extract: the request's conflict answers up front", async () => {
  const d = xdeps({ entries: both.slice(0, 2) });
  await handleRequest(xr({ conflict: "keep_both" }), d);
  assert.deepEqual(d.asked, []);
  assert.deepEqual(starts(d)[0].plan, [{ entry: "a.txt", mode: "new", name: "a-1.txt" }, { entry: "d", mode: "new", name: "d-1" }]);
  const c = xdeps({ entries: both.slice(0, 2) });
  assert.deepEqual(await handleRequest(xr({ conflict: "cancel" }), c), { ok: false, error: "Cancelled" });
  const m = xdeps({ entries: both.slice(0, 2) });
  await handleRequest(xr({ conflict: "merge" }), m);
  assert.deepEqual(starts(m)[0].plan, [{ entry: "a.txt", mode: "replace", name: "a.txt" }, { entry: "d", mode: "merge", name: "d" }]);
});
