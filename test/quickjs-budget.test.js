// The edit check and save of a 1 MiB file inside herdr's own QuickJS (`herdr-app check`), which interrupts a job after
// about 0.5 s with an error JS cannot catch: a check that took longer left Edit on "Checking…" for good. Each scenario
// is the synchronous work of one job in the app and runs as the top level of a throwaway mod. Skipped where herdr-app
// is not installed (CI); `npm test` on the Mac runs it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { mkTmpSync } from "./tmp-helper.js";

const MOD = path.resolve(import.meta.dirname, "..", "mods", "filer-pro");
const HAS_HERDR = spawnSync("herdr-app", ["--version"], { encoding: "utf8" }).status === 0;

// Exactly 1 MiB (EDIT_MAX_BYTES) of multibyte text with CRLF line ends, built with native string ops only, so the
// setup takes little of the job's time: bin holds one char per byte, bytes() makes the Uint8Array.
const SETUP = `
import { EDIT_MAX_BYTES, parseProbe, checkEditable, bufferBytes } from "./lib/textedit.js";
import { bytesToBase64, binaryToBytes, equalBytes, sha256Hex, SHA_SLICE, decodeUtf8Lossy } from "./lib/textcodec.js";
import { readResult, LOSSY_SLICE } from "./lib/readfile.js";
import { View, div } from "gpui-kit";
const unit = "Grüße € 😀 the quick brown fox\\r\\n";
const unitBytes = unescape(encodeURIComponent(unit)).length;
const n = Math.floor(EDIT_MAX_BYTES / unitBytes);
const text = unit.repeat(n) + "x".repeat(EDIT_MAX_BYTES - n * unitBytes);
const bin = unescape(encodeURIComponent(text));
if (bin.length !== EDIT_MAX_BYTES) throw new Error("setup: " + bin.length);
const stdout = "file y 644 " + bin.length + " n\\n" + btoa(bin) + "\\n";
const bytes = () => binaryToBytes(bin);
const timed = (f) => { const t = Date.now(); const r = f(); return { r, ms: Date.now() - t }; };
`;
const REPORT = `
export default class Budget extends View { render() { return div(); } }
throw new Error("RESULT " + JSON.stringify(result));
`;

// The limit is wall-clock time, and `npm test` runs the other test files in parallel, so under load a run can be
// interrupted although its work fits. An interrupted run is tried again after a pause that grows (1, 2, 4, 8, 16, 30 s:
// about a minute in all, as long as a whole `npm test` keeps the CPU busy), so a retry runs on a quieter machine. This
// does not weaken the check: the old per-byte code needed well over the limit and was interrupted on every try,
// so a pass still needs one complete run inside a single job.
const PAUSES_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function runInHerdr(body) {
  const dir = mkTmpSync("quickjs-budget-");
  fs.cpSync(path.join(MOD, "lib"), path.join(dir, "lib"), { recursive: true });
  fs.copyFileSync(path.join(MOD, "icons.js"), path.join(dir, "icons.js")); // lib/icons.js imports it
  fs.writeFileSync(path.join(dir, "mod.json"), '{ "place": "none" }\n');
  fs.writeFileSync(path.join(dir, "main.js"), SETUP + body + REPORT);
  let out = "";
  for (let attempt = 0; attempt <= PAUSES_MS.length; attempt++) {
    if (attempt > 0) pause(PAUSES_MS[attempt - 1]);
    const r = spawnSync("herdr-app", ["check", dir], { encoding: "utf8", timeout: 60000 });
    out = `${r.stdout}\n${r.stderr}`;
    if (!/interrupted/.test(out)) break;
  }
  assert.ok(!/interrupted/.test(out), `herdr interrupted the job:\n${out.slice(0, 2000)}`);
  const m = /RESULT (\{.*\})/.exec(out);
  assert.ok(m, `no result:\n${out.slice(0, 2000)}`);
  return JSON.parse(m[1]);
}

test("in herdr's QuickJS the check of a 1 MiB file finishes within one job", { skip: !HAS_HERDR && "herdr-app not installed" }, (t) => {
  const res = runInHerdr(`
const c = timed(() => checkEditable(parseProbe(stdout), { maxChars: 2000000 }));
const result = { ok: c.r.ok, reason: c.r.reason ?? null, eol: c.r.info?.eol, ms: c.ms };
`);
  t.diagnostic(`parseProbe + checkEditable: ${res.ms} ms`);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.eol, "CRLF");
});

test("in herdr's QuickJS each job of a 1 MiB save finishes within one job", { skip: !HAS_HERDR && "herdr-app not installed" }, (t) => {
  // the Save click (buffer to bytes), the upload job (last hash slice, then base64 for the staged file) and the job
  // after the save (probe parse, then the byte compare), each in its own run like in the app
  const click = runInHerdr(`
const value = text.replaceAll("\\r\\n", "\\n");
const b = timed(() => bufferBytes(value, { eol: "CRLF" }));
const result = { same: b.r.length === bin.length, ms: b.ms };
`);
  const upload = runInHerdr(`
const b = bytes();
const u = timed(() => { sha256Hex(b.subarray(0, SHA_SLICE)); return bytesToBase64(b).length; });
const result = { len: u.r, ms: u.ms };
`);
  const after = runInHerdr(`
const b = bytes();
const a = timed(() => equalBytes(parseProbe(stdout).bytes, b));
const result = { same: a.r, ms: a.ms };
`);
  t.diagnostic(`click ${click.ms} ms, hash slice + base64 ${upload.ms} ms, parse + compare ${after.ms} ms`);
  assert.equal(click.same, true);
  assert.ok(upload.len > 1398000);
  assert.equal(after.same, true);
});

// #39: the bounded read of a 1 MiB file: parse, decode and edit check in the job that receives the exec output; a file
// that is not UTF-8 is decoded lossily one slice per job (lib/readfile.js readFileGuarded), so each slice must fit.
test("in herdr's QuickJS the read of a 1 MiB file and each lossy slice finish within one job", { skip: !HAS_HERDR && "herdr-app not installed" }, (t) => {
  const read = runInHerdr(`
const out = { code: 0, stdout: stdout.replace(" n\\n", " n n\\n"), stderr: "" };
const c = timed(() => readResult(out, { maxChars: 2000000, defer: true }));
const result = { ok: c.r.ok, edit: c.r.edit.ok, len: c.r.text.length, ms: c.ms };
`);
  // worst cases for one slice: all bytes >= 0x80 (a Cyrillic code page), and CJK UTF-8 with one stray byte
  const slices = runInHerdr(`
let high = ""; for (let i = 0; i < LOSSY_SLICE; i++) high += String.fromCharCode(0x80 + (i % 128));
const cjk = unescape(encodeURIComponent("漢字かな交じり文".repeat(Math.ceil(LOSSY_SLICE / 24)))).slice(0, LOSSY_SLICE - 1) + "\\xff";
const a = timed(() => decodeUtf8Lossy(binaryToBytes(high)).length);
const b = timed(() => decodeUtf8Lossy(binaryToBytes(cjk)).length);
const result = { a: a.r, aMs: a.ms, b: b.r, bMs: b.ms };
`);
  t.diagnostic(`readResult 1 MiB: ${read.ms} ms; lossy slice all-high ${slices.aMs} ms, CJK + 1 bad byte ${slices.bMs} ms`);
  assert.equal(read.ok, true);
  assert.equal(read.edit, true);
  assert.ok(read.len > 800000);
  assert.equal(slices.a, 65536);
  assert.ok(slices.b > 20000);
});
