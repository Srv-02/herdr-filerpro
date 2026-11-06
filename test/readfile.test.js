// #39: the bounded read of a text file to show (lib/readfile.js): one READ_SCRIPT exec gives the text and the edit
// decision; a file that is not UTF-8 is shown lossily in slices; the guard always ends.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readResult, readFileGuarded, lossySlices, GONE_MESSAGE, NO_READ_MESSAGE } from "../mods/filer-pro/lib/readfile.js";
import { READ_SCRIPT, CHECK_FAILED, CHECK_TIMEOUT_MS, EDIT_MAX_BYTES } from "../mods/filer-pro/lib/textedit.js";
import { BINARY_MESSAGE, UTF16_MESSAGE } from "../mods/filer-pro/lib/binary.js";
import { decodeUtf8Lossy } from "../mods/filer-pro/lib/textcodec.js";

const out = (bytes, { w = "y", mode = "644", size = bytes.length, open = "n", link = "n", stderr = "" } = {}) =>
  ({ code: 0, stdout: `file ${w} ${mode} ${size} ${open} ${link}\n${size <= EDIT_MAX_BYTES ? Buffer.from(bytes).toString("base64") : ""}\n`, stderr });
const R = "�";

describe("readResult", () => {
  test("UTF-8 text: shown as is (CRLF kept) and editable from the same bytes", () => {
    const r = readResult(out(Buffer.from("hä\r\nb\r\n")), { maxChars: 100 });
    assert.equal(r.ok, true);
    assert.equal(r.text, "hä\r\nb\r\n");
    assert.equal(r.lossy, false);
    assert.equal(r.edit.ok, true);
    assert.equal(r.edit.info.text, "hä\nb\n");
    assert.equal(r.edit.info.eol, "CRLF");
  });

  test("missing, folder, special, unreadable and broken output each say why", () => {
    assert.deepEqual(readResult({ code: 0, stdout: "missing\n", stderr: "" }), { ok: false, message: GONE_MESSAGE, binary: false });
    assert.equal(GONE_MESSAGE, "This file is no longer available");
    assert.equal(readResult({ code: 0, stdout: "dir\n", stderr: "" }).message, "Not a regular file");
    assert.equal(readResult({ code: 0, stdout: "special\n", stderr: "" }).message, "Not a regular file");
    assert.deepEqual(readResult({ code: 0, stdout: "unreadable n 200 5 n n\n", stderr: "" }), { ok: false, message: NO_READ_MESSAGE, binary: false });
    assert.equal(readResult({ code: 0, stdout: "garbage\n", stderr: "" }).message, "Cannot read this file");
    assert.equal(readResult({ code: 1, stdout: "", stderr: "" }).message, "Cannot read this file");
    assert.equal(readResult({ code: 127, stdout: "", stderr: "sh: head: not found\n" }).message, "Cannot read this file: sh: head: not found");
  });

  test("a read that failed after the permission test (readfail) is never an empty text", () => {
    const r = readResult(out(Buffer.alloc(0), { size: 5, stderr: "sh: /x/a.txt: Permission denied\nreadfail\n" }));
    assert.deepEqual(r, { ok: false, message: "Cannot read this file: sh: /x/a.txt: Permission denied", binary: false });
    const mac = readResult(out(Buffer.alloc(0), { size: 5, stderr: "sh: /x: Operation not permitted\nreadfail\n" }), { on: null, localPlatform: "macos" });
    assert.match(mac.message, /^Cannot read this file: Not permitted: macOS privacy settings/);
  });

  test("above 1 MiB, UTF-16 and binary", () => {
    assert.equal(readResult(out(Buffer.alloc(0), { size: 3_400_000 })).message, "File larger than 1 MiB (3.4 MB)");
    assert.equal(readResult(out(Buffer.from("\xff\xfeh\0i\0", "latin1"))).message, UTF16_MESSAGE);
    assert.deepEqual(readResult(out(Buffer.from([0x50, 0x4b, 0, 0, 1]))), { ok: false, message: BINARY_MESSAGE, binary: true });
  });

  test("not UTF-8: shown with U+FFFD, Edit refused with the reason", () => {
    const r = readResult(out(Buffer.from("Gr\xfc\xdfe\n", "latin1")), { maxChars: 100 });
    assert.equal(r.ok, true);
    assert.equal(r.text, `Gr${R}${R}e\n`);
    assert.equal(r.lossy, true);
    assert.deepEqual(r.edit, { ok: false, reason: "Not UTF-8 (Latin-1 or other), use Edit in Terminal" });
    const later = readResult(out(Buffer.from("Gr\xfc\n", "latin1")), { defer: true });
    assert.equal(later.text, null);
    assert.equal(Buffer.from(later.bytes).toString("latin1"), "Gr\xfc\n");
  });

  test("a symbolic link: shown through the link, Edit refused", () => {
    const r = readResult(out(Buffer.from("hi\n"), { link: "y" }), { maxChars: 100 });
    assert.equal(r.text, "hi\n");
    assert.deepEqual(r.edit, { ok: false, reason: "Symbolic link" });
  });
});

test("lossySlices never splits a valid sequence and covers every byte", () => {
  const b = new Uint8Array(Buffer.from("aé€😀".repeat(50) + "\xff", "utf8"));
  for (const n of [1, 2, 3, 5, 7, 64]) {
    const slices = lossySlices(b, n);
    assert.equal(slices[0][0], 0);
    assert.equal(slices.at(-1)[1], b.length);
    for (let i = 1; i < slices.length; i++) assert.equal(slices[i][0], slices[i - 1][1]);
    assert.equal(slices.map(([x, y]) => decodeUtf8Lossy(b.subarray(x, y))).join(""), decodeUtf8Lossy(b), `slice ${n}`);
  }
});

// A fake timer: run(ms) fires the timers of that delay armed so far, as the host would once the current job ended.
function fakeTimers() {
  const armed = [];
  return {
    armed,
    after: (ms, fn) => armed.push({ ms, fn }),
    run: (ms) => armed.filter((t) => t.ms === ms && !t.fired).forEach((t) => { t.fired = true; t.fn(); }),
  };
}
const settle = () => new Promise((r) => setImmediate(r));
// Fires zero timers until nothing new is armed (each round is one job of the host).
async function drain(t) { for (let i = 0; i < 100; i++) { t.run(0); await settle(); } }

describe("readFileGuarded", () => {
  test("one READ_SCRIPT exec, the result from a fresh job", async () => {
    const t = fakeTimers(), results = [], calls = [];
    const exec = async (cmd, args, opts) => { calls.push({ cmd, args, on: opts.on }); return out(Buffer.from("hi\n")); };
    readFileGuarded({ exec, on: "box", path: "/f", maxChars: 100, after: t.after }, (r) => results.push(r));
    await settle();
    assert.deepEqual(results, [], "not in the job that parsed");
    await drain(t);
    assert.equal(results.length, 1);
    assert.equal(results[0].text, "hi\n");
    assert.deepEqual(calls.map((c) => [c.cmd, c.args[1], c.args[3], c.on]), [["sh", READ_SCRIPT, "/f", "box"]]);
  });

  test("not UTF-8: decoded in slices, one job each, same text as in one go", async () => {
    const t = fakeTimers(), results = [];
    const bytes = Buffer.from("Gr\xfc\xdfe ".repeat(100), "latin1");
    readFileGuarded({ exec: async () => out(bytes), path: "/f", maxChars: 10000, after: t.after, slice: 64 }, (r) => results.push(r));
    await drain(t);
    assert.equal(results.length, 1);
    assert.equal(results[0].text, decodeUtf8Lossy(new Uint8Array(bytes)));
    assert.equal(results[0].lossy, true);
    assert.equal(results[0].edit.ok, false);
    assert.ok(t.armed.filter((a) => a.ms === 0).length > 2 * Math.ceil(bytes.length / 64), "a guard and a yield per slice");
  });

  test("an interrupted parse or slice still ends: Could not check this file", async () => {
    // The interrupt cannot be caught: nothing after it runs in that job, then the host fires the timers armed before it.
    // Modelled by work that fires the zero timers while it is still running (and then never returns normally).
    for (const where of ["parse", "slice"]) {
      const t = fakeTimers(), results = [];
      const interrupt = () => { t.run(0); throw new Error("interrupted"); };
      const opts = where === "parse" ? { work: interrupt } : { decode: interrupt };
      readFileGuarded({ exec: async () => out(Buffer.from("Gr\xfc\n", "latin1")), path: "/f", maxChars: 100, after: t.after, ...opts }, (r) => results.push(r));
      await drain(t);
      assert.deepEqual(results, [{ ok: false, message: CHECK_FAILED, binary: false }], where);
    }
  });

  test("a rejected exec names the machine problem; no answer ends after the timeout", async () => {
    let t = fakeTimers(), results = [];
    readFileGuarded({ exec: async () => { throw new Error("Could not resolve hostname box"); }, on: "box", path: "/f", after: t.after }, (r) => results.push(r));
    await settle();
    assert.deepEqual(results, [{ ok: false, message: "Cannot reach the machine: Machine not reachable", binary: false }]);
    t = fakeTimers(); results = [];
    readFileGuarded({ exec: () => new Promise(() => {}), path: "/f", after: t.after }, (r) => results.push(r));
    await settle();
    assert.equal(t.armed[0].ms, CHECK_TIMEOUT_MS);
    t.run(CHECK_TIMEOUT_MS);
    assert.deepEqual(results, [{ ok: false, message: `${CHECK_FAILED} (no answer)`, binary: false }]);
    t.run(0);
    assert.equal(results.length, 1, "ends once");
  });
});
