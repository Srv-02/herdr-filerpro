import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { mkTmpSync } from "./tmp-helper.js";
import {
  EDIT_MAX_BYTES, PROBE_SCRIPT, BEGIN_FILE_SCRIPT, PRIVATE_DIR_SCRIPT, COPY_SCRIPT, COMMIT_SCRIPT, CLEAN_SCRIPT,
  parseProbe, checkEditable, bufferBytes, isDirty, statusText, createHistory, probeFile, probeFileGuarded, CHECK_FAILED, CHECK_TIMEOUT_MS, saveFile, saveCopy, copyName, mirrorName, octalMode, scpSender,
} from "../mods/filer-pro/lib/textedit.js";
import { numbers } from "../mods/filer-pro/lib/settings.js";

const FAKE_SSH = path.resolve(import.meta.dirname, "fake", "ssh");
const FAKE_SCP = path.resolve(import.meta.dirname, "fake", "scp");
const TRANSFER = path.resolve(import.meta.dirname, "..", "mods", "filer-pro", "bin", "transfer.sh");
const MACHINES = JSON.stringify({ machines: [{ name: "box", target: "box", via: false }] });
const IS_ROOT = process.getuid?.() === 0;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const q = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

// A stand-in for herdr's exec. on == null runs the command directly, on == "box" sends one shell-quoted string through
// the fake ssh (like herdr's remote exec probably does). HOME and the cache folder point into the scratch folder;
// transfer.sh finds the fake scp and ssh through FILER_PRO_SCP / FILER_PRO_SSH.
// exec.stage and exec.send are what main.js passes to saveFile/saveCopy: a private local stage folder and the scp sender.
function makeExec(root, { shell = "sh", pathPrefix = "", wrap, stageWrap, sendWrap, extraEnv = {} } = {}) {
  const calls = [];
  const env = { ...process.env, HOME: path.join(root, "home"), XDG_CACHE_HOME: path.join(root, "cache"), FILER_PRO_SCP: FAKE_SCP, FILER_PRO_SSH: FAKE_SSH, ...extraEnv };
  if (pathPrefix) env.PATH = `${pathPrefix}:${env.PATH}`;
  const exec = async (cmd, args, opts = {}) => {
    if (wrap) [cmd, args] = (await wrap(cmd, args)) ?? [cmd, args];
    calls.push({ cmd, args, on: opts.on ?? null });
    const c = cmd === "sh" ? shell : cmd;
    let r;
    if (opts.on == null) {
      r = spawnSync(c, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env });
    } else {
      assert.equal(opts.on, "box");
      const joined = [c, ...args].map(q).join(" ");
      assert.ok(Buffer.byteLength(joined) < 131072, `command line of ${Buffer.byteLength(joined)} bytes`);
      r = spawnSync(FAKE_SSH, ["box", joined], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env });
    }
    if (r.error) throw r.error;
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const stageDir = path.join(root, "stage");
  exec.stage = async (b64) => {
    fs.mkdirSync(stageDir, { recursive: true, mode: 0o700 });
    const p = path.join(stageDir, `s${crypto.randomBytes(4).toString("hex")}.b64`);
    fs.writeFileSync(p, stageWrap ? stageWrap(b64) : b64, { mode: 0o600 });
    return p;
  };
  const hc = async (args) => (args[0] === "machine" ? { code: 0, stdout: MACHINES, stderr: "" } : { code: 1, stdout: "", stderr: "" });
  const send = scpSender({ exec, hc, script: TRANSFER, trashDir: path.join(root, "trash"), limits: () => numbers(null) });
  exec.send = sendWrap ? (a) => sendWrap(a, send) : send;
  const staged = () => (fs.existsSync(stageDir) ? fs.readdirSync(stageDir) : []);
  return { exec, calls, staged, cacheDir: path.join(root, "cache", "filer-pro", "edit") };
}
const io = (exec) => ({ exec, stage: exec.stage, send: exec.send });

function scratch() {
  const root = mkTmpSync("textedit-");
  fs.mkdirSync(path.join(root, "files"));
  return { root, files: path.join(root, "files") };
}

const utf16le = (s, bom = true) => Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(s, "utf16le")]);
const utf16be = (s) => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(s, "utf16le").swap16()]);

// umask-independent fixture
function put(p, bytes, mode = 0o644) {
  fs.writeFileSync(p, bytes);
  fs.chmodSync(p, mode);
}

const CASES = [
  ["utf8", () => Buffer.from("héllo\nwörld ✓ 😀\n"), null],
  ["utf8 bom", () => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hi\n")]), "UTF-8 with BOM, use Edit in Terminal"],
  ["utf16 le bom", () => utf16le("hello\n"), "UTF-16 file, use Edit in Terminal"],
  ["utf16 be", () => utf16be("hello\n"), "UTF-16 file, use Edit in Terminal"],
  ["utf16 le no bom", () => utf16le("hello there\n", false), "UTF-16 file, use Edit in Terminal"],
  ["latin1", () => Buffer.from("caf\xe9\n", "latin1"), "Not UTF-8 (Latin-1 or other), use Edit in Terminal"],
  ["crlf", () => Buffer.from("a\r\nb\r\n"), null],
  ["mixed", () => Buffer.from("a\r\nb\nc\n"), "Mixed line endings"],
  ["lone cr", () => Buffer.from("a\rb\r"), "Old Mac line endings (CR)"],
  ["no final newline", () => Buffer.from("a\nb"), null],
  ["empty", () => Buffer.alloc(0), null],
  ["binary", () => Buffer.from([0x61, 0, 0x62, 0, 0xff, 0x01, 0, 0]), "Binary file"],
];

describe("probeFile on real files, local and through the fake ssh", () => {
  for (const on of [null, "box"]) {
    for (const [name, make, reason] of CASES) {
      test(`${name} (${on ?? "local"})`, async () => {
        const { root, files } = scratch();
        const { exec } = makeExec(root);
        const p = path.join(files, "f.txt");
        const bytes = make();
        put(p, bytes);
        const r = await probeFile({ exec, on, path: p, maxChars: 100000 });
        if (reason) assert.deepEqual(r, { ok: false, reason });
        else {
          assert.equal(r.ok, true);
          assert.deepEqual(Buffer.from(r.info.bytes), bytes);
          assert.equal(r.info.size, bytes.length);
          assert.equal(r.info.mode, "644");
        }
      });
    }

    test(`entry kinds and limits (${on ?? "local"})`, async () => {
      const { root, files } = scratch();
      const { exec } = makeExec(root);
      const probe = (p, maxChars = 100000) => probeFile({ exec, on, path: p, maxChars });
      const f = path.join(files, "real.txt");
      fs.writeFileSync(f, "x\n");
      fs.symlinkSync(f, path.join(files, "link"));
      fs.mkdirSync(path.join(files, "folder"));
      spawnSync("mkfifo", [path.join(files, "fifo")]);
      assert.deepEqual(await probe(path.join(files, "link")), { ok: false, reason: "Symbolic link" });
      assert.deepEqual(await probe(path.join(files, "folder")), { ok: false, reason: "Folder" });
      assert.deepEqual(await probe(path.join(files, "gone")), { ok: false, reason: "File no longer available" });
      assert.deepEqual(await probe(path.join(files, "fifo")), { ok: false, reason: "Not a regular file" });
      fs.writeFileSync(path.join(files, "big"), Buffer.alloc(EDIT_MAX_BYTES + 1, 0x61));
      assert.deepEqual(await probe(path.join(files, "big")), { ok: false, reason: "File larger than 1 MiB" });
      fs.writeFileSync(path.join(files, "long"), "a".repeat(2000));
      assert.deepEqual(await probe(path.join(files, "long"), 1000), { ok: false, reason: "Display truncated" });
      fs.writeFileSync(path.join(files, "ro"), "x");
      fs.chmodSync(path.join(files, "ro"), 0o444);
      assert.deepEqual(await probe(path.join(files, "ro")), { ok: false, reason: "No write permission" });
      fs.writeFileSync(path.join(files, "priv"), "x");
      fs.chmodSync(path.join(files, "priv"), 0o600);
      assert.equal((await probe(path.join(files, "priv"))).info.mode, "600");
      const odd = path.join(files, "it's a \"file\" $x.txt");
      fs.writeFileSync(odd, "o");
      assert.equal((await probe(odd)).info.text, "o");
    });
  }

  test("a file of exactly 1 MiB is editable and a 1 MiB + 1 file is not", async () => {
    const { root, files } = scratch();
    const { exec } = makeExec(root);
    fs.writeFileSync(path.join(files, "max"), Buffer.alloc(EDIT_MAX_BYTES, 0x61));
    const r = await probeFile({ exec, on: null, path: path.join(files, "max"), maxChars: 2000000 });
    assert.equal(r.ok, true);
    assert.equal(r.info.bytes.length, EDIT_MAX_BYTES);
  });

  test("a dash-leading relative name is made ./name by the script", () => {
    const { files } = scratch();
    fs.writeFileSync(path.join(files, "-dash"), "d");
    const r = spawnSync("sh", ["-c", PROBE_SCRIPT, "probe", "-dash"], { encoding: "utf8", cwd: files });
    assert.match(r.stdout, /^file y \d+ 1 n\n/);
  });

  test("bash runs the probe too", () => {
    const { files } = scratch();
    put(path.join(files, "a"), "hi");
    const r = spawnSync("bash", ["-c", PROBE_SCRIPT, "probe", path.join(files, "a")], { encoding: "utf8" });
    // GNU prints 644, BSD %p 100644 (file type in front); parseProbe makes both 644.
    assert.match(r.stdout, new RegExp(`^file y (100)?644 2 n\\n${Buffer.from("hi").toString("base64")}\\n$`));
    assert.equal(parseProbe(r.stdout).mode, "644");
  });

  test("an exec that rejects or fails gives a plain reason", async () => {
    assert.deepEqual(await probeFile({ exec: async () => { throw new Error("boom"); }, on: "box", path: "/x", maxChars: 1 }), { ok: false, reason: "Cannot read this file" });
    assert.deepEqual(await probeFile({ exec: async () => ({ code: 1, stdout: "", stderr: "" }), on: null, path: "/x", maxChars: 1 }), { ok: false, reason: "Cannot read this file" });
  });
});

describe("parseProbe and checkEditable (pure)", () => {
  test("parses every header", () => {
    for (const k of ["link", "dir", "missing", "special"]) assert.equal(parseProbe(`${k}\n`).kind, k);
    const f = parseProbe(`file y 600 3\n${Buffer.from("abc").toString("base64")}\n`);
    assert.deepEqual({ ...f, bytes: Buffer.from(f.bytes).toString() }, { kind: "file", writable: true, mode: "600", size: 3, bytes: "abc", openDir: false });
    assert.equal(parseProbe("file y 644 0 y\n\n").openDir, true);
    assert.equal(parseProbe("file n 4755 0\n\n").writable, false);
    assert.equal(parseProbe("file n 4755 0\n\n").mode, "4755");
    assert.equal(parseProbe("file y 644 0\n\n").bytes.length, 0);
    assert.equal(parseProbe(`file y 644 ${EDIT_MAX_BYTES + 1}\n`).bytes, null);
  });
  test("malformed output is kind error", () => {
    for (const s of ["", "garbage", "file y 644", "file x 644 3\nYWJj\n", "file y 999 3\nYWJj\n", "file y 644 3\n!!!\n", "file y 644 3"]) {
      assert.equal(parseProbe(s).kind, "error", JSON.stringify(s));
    }
    assert.deepEqual(checkEditable(parseProbe("garbage"), { maxChars: 10 }), { ok: false, reason: "Not a regular file" });
  });
  test("size mismatch is File changed while reading", () => {
    assert.deepEqual(checkEditable(parseProbe(`file y 644 5\n${Buffer.from("abc").toString("base64")}\n`), { maxChars: 10 }), { ok: false, reason: "File changed while reading" });
  });
  test("mode without write bits is refused even when the shell said writable", () => {
    assert.deepEqual(checkEditable(parseProbe(`file y 444 1\n${Buffer.from("a").toString("base64")}\n`), { maxChars: 10 }), { ok: false, reason: "No write permission" });
    assert.equal(checkEditable(parseProbe(`file y 200 1\n${Buffer.from("a").toString("base64")}\n`), { maxChars: 10 }).ok, true);
  });
  test("info carries LF text for a CRLF file", () => {
    const r = checkEditable(parseProbe(`file y 600 6\n${Buffer.from("a\r\nb\r\n").toString("base64")}\n`), { maxChars: 10 });
    assert.deepEqual({ ...r.info, bytes: undefined }, { bytes: undefined, text: "a\nb\n", eol: "CRLF", mode: "600", size: 6 });
  });
  test("reason order: UTF-16 wins over Binary and over truncation", () => {
    const b = utf16le("hello", false);
    assert.equal(checkEditable(parseProbe(`file y 644 ${b.length}\n${b.toString("base64")}\n`), { maxChars: 1 }).reason, "UTF-16 file, use Edit in Terminal");
  });
});

describe("bufferBytes, isDirty, statusText, copyName", () => {
  const info = (text, eol = "LF") => ({ text, eol, bytes: Buffer.from(eol === "CRLF" ? text.replaceAll("\n", "\r\n") : text), mode: "600", size: 0 });
  test("unchanged buffer gives the original bytes", () => {
    for (const [t, e] of [["a\nb\n", "LF"], ["a\nb", "LF"], ["", "LF"], ["a\nb\n", "CRLF"], ["a\n\nb", "CRLF"]]) {
      const i = info(t, e);
      assert.deepEqual(Buffer.from(bufferBytes(t, i)), i.bytes);
      assert.equal(isDirty(t, i), false);
    }
  });
  test("typed lines get the file's line ending, pasted CR and CRLF are normalised", () => {
    assert.equal(Buffer.from(bufferBytes("a\nb\nc\n", info("a\n", "CRLF"))).toString(), "a\r\nb\r\nc\r\n");
    assert.equal(Buffer.from(bufferBytes("a\r\nb\rc", info("x", "LF"))).toString(), "a\nb\nc");
    assert.equal(Buffer.from(bufferBytes("a\r\nb", info("x", "CRLF"))).toString(), "a\r\nb");
  });
  test("no final newline stays absent and a present one stays present", () => {
    assert.equal(Buffer.from(bufferBytes("ab", info("a"))).toString(), "ab");
    assert.equal(Buffer.from(bufferBytes("ab\n", info("a"))).toString(), "ab\n");
  });
  test("a lone surrogate gives null", () => {
    assert.equal(bufferBytes("a\ud800b", info("a")), null);
    assert.equal(bufferBytes("😀", info("a")).length, 4);
  });
  test("isDirty compares strings", () => {
    assert.equal(isDirty("a ", info("a")), true);
  });
  test("statusText", () => {
    assert.equal(statusText({ eol: "LF", mode: "600" }), "UTF-8 · LF · 600");
    assert.equal(statusText({ eol: "CRLF", mode: "644" }, "600"), "UTF-8 · CRLF · 600 → 644");
    assert.equal(statusText({ eol: "LF", mode: "644" }, "644"), "UTF-8 · LF · 644");
    assert.doesNotMatch(statusText({ eol: "LF", mode: "644" }, "600"), /[–—]/);
  });
  test("copyName", () => {
    assert.equal(copyName("notes.txt"), "notes copy.txt");
    assert.equal(copyName("Makefile"), "Makefile copy");
    assert.equal(copyName(".env"), ".env copy");
    assert.equal(copyName("a.tar.gz"), "a.tar copy.gz");
  });
});

describe("createHistory", () => {
  test("undo and redo walk the steps; the base value is the floor", () => {
    const h = createHistory();
    h.reset("a");
    assert.equal(h.canUndo(), false);
    assert.equal(h.undo(), null);
    h.record("ab", 1000);
    h.record("abc", 5000);
    assert.equal(h.canUndo(), true);
    assert.equal(h.undo(), "ab");
    assert.equal(h.undo(), "a");
    assert.equal(h.undo(), null);
    assert.equal(h.canRedo(), true);
    assert.equal(h.redo(), "ab");
    assert.equal(h.redo(), "abc");
    assert.equal(h.redo(), null);
  });
  test("changes within the merge window are one step", () => {
    const h = createHistory({ mergeMs: 800 });
    h.reset("");
    h.record("a", 100);
    h.record("ab", 600);
    h.record("abc", 1300); // 700 ms after the previous change: still the same step
    h.record("abcd", 3000);
    assert.equal(h.undo(), "abc");
    assert.equal(h.undo(), "");
    assert.equal(h.undo(), null);
  });
  test("the first record after an undo starts a new step", () => {
    const h = createHistory();
    h.reset("");
    h.record("a", 0);
    h.record("ab", 5000);
    assert.equal(h.undo(), "a");
    h.record("ax", 5001);
    assert.equal(h.undo(), "a");
  });
  test("record clears the redo list", () => {
    const h = createHistory();
    h.reset("");
    h.record("a", 0);
    h.undo();
    assert.equal(h.canRedo(), true);
    h.record("b", 10000);
    assert.equal(h.canRedo(), false);
    assert.equal(h.redo(), null);
  });
  test("an unchanged value records nothing", () => {
    const h = createHistory();
    h.reset("a");
    h.record("a", 0);
    assert.equal(h.canUndo(), false);
  });
  test("maxEntries drops the oldest", () => {
    const h = createHistory({ maxEntries: 3 });
    h.reset("0");
    for (let i = 1; i <= 6; i++) h.record(String(i), i * 10000);
    const seen = [];
    for (let v = h.undo(); v !== null; v = h.undo()) seen.push(v);
    assert.deepEqual(seen, ["5", "4"]);
  });
  test("maxChars drops the oldest but keeps the current value", () => {
    const h = createHistory({ maxChars: 25 });
    h.reset("a".repeat(10));
    h.record("b".repeat(10), 10000);
    h.record("c".repeat(10), 20000);
    assert.equal(h.undo(), "b".repeat(10));
    assert.equal(h.undo(), null);
    const big = createHistory({ maxChars: 5 });
    big.reset("x");
    big.record("y".repeat(50), 10000);
    assert.equal(big.canUndo(), false);
    assert.equal(big.canRedo(), false);
  });
  test("reset starts over", () => {
    const h = createHistory();
    h.reset("a");
    h.record("b", 0);
    h.reset("z");
    assert.equal(h.canUndo(), false);
    assert.equal(h.canRedo(), false);
  });
});



async function open(exec, on, p, maxChars = 100000) {
  const r = await probeFile({ exec, on, path: p, maxChars });
  assert.equal(r.ok, true, r.reason);
  return r.info;
}
const cacheLeft = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

describe("saveFile", () => {
  for (const on of [null, "box"]) {
    const tag = on ?? "local";

    test(`unchanged buffer is byte identical (${tag})`, async () => {
      const { root, files } = scratch();
      const { exec, cacheDir } = makeExec(root);
      for (const bytes of [Buffer.from("h\xe9\nx"), Buffer.from("a\r\nb\r\n"), Buffer.alloc(0), Buffer.from("é\n")]) {
        const p = path.join(files, "f");
        fs.writeFileSync(p, bytes);
        const info = await open(exec, on, p);
        const r = await saveFile({ ...io(exec), on, path: p, info, bytes: bufferBytes(info.text, info) });
        assert.equal(r.ok, true, r.error);
        assert.equal(sha(fs.readFileSync(p)), sha(bytes));
        assert.equal(r.hash, sha(bytes));
      }
      assert.deepEqual(cacheLeft(cacheDir), []);
    });

    test(`edited CRLF file keeps CRLF; mode and inode are kept (${tag})`, async () => {
      const { root, files } = scratch();
      const { exec, cacheDir } = makeExec(root);
      const p = path.join(files, "f");
      fs.writeFileSync(p, "a\r\nb\r\n");
      fs.chmodSync(p, 0o600);
      const ino = fs.statSync(p).ino;
      const info = await open(exec, on, p);
      const bytes = bufferBytes("a\nb\ntyped\nlines\n", info);
      const r = await saveFile({ ...io(exec), on, path: p, info, bytes });
      assert.equal(r.ok, true, r.error);
      assert.equal(fs.readFileSync(p, "utf8"), "a\r\nb\r\ntyped\r\nlines\r\n");
      assert.equal(fs.statSync(p).mode & 0o7777, 0o600);
      assert.equal(fs.statSync(p).ino, ino);
      assert.deepEqual(Buffer.from(r.bytes), fs.readFileSync(p));
      assert.deepEqual(cacheLeft(cacheDir), []);
      // the sent bytes are the next baseline: a second save works without re-probing
      const next = { ...info, bytes: r.bytes, text: "a\nb\ntyped\nlines\n" };
      const r2 = await saveFile({ ...io(exec), on, path: p, info: next, bytes: bufferBytes("x\n", next) });
      assert.equal(r2.ok, true, r2.error);
      assert.equal(fs.readFileSync(p, "utf8"), "x\r\n");
    });

    test(`1 MiB save hashes in slices with pause() between them; a known info.hash is the baseline (${tag})`, async () => {
      const { root, files } = scratch();
      const { exec } = makeExec(root);
      const p = path.join(files, "f");
      const text = mibText();
      fs.writeFileSync(p, text);
      const info = await open(exec, on, p, 2000000);
      let pauses = 0;
      const pause = async () => { pauses++; };
      const bytes = bufferBytes(info.text.replace("Grüße", "Hallo"), info);
      const r = await saveFile({ ...io(exec), on, path: p, info, bytes, pause });
      assert.equal(r.ok, true, r.error);
      assert.equal(r.hash, sha(fs.readFileSync(p)));
      assert.ok(pauses >= 15, `${pauses} pauses`); // two hashes of 8 slices each, a pause between all of them
      // the next save takes the old hash from info.hash: a wrong one reads as a change by someone else
      const next = { ...info, bytes: r.bytes, hash: "0".repeat(64) };
      const r2 = await saveFile({ ...io(exec), on, path: p, info: next, bytes: bufferBytes("x\n", next) });
      assert.equal(r2.ok, false);
      assert.match(r2.error, /changed since it was opened/);
      const r3 = await saveFile({ ...io(exec), on, path: p, info: { ...next, hash: r.hash }, bytes: bufferBytes("x\n", next) });
      assert.equal(r3.ok, true, r3.error);
      assert.equal(fs.readFileSync(p, "utf8"), "x\r\n");
    });

    test(`no final newline stays absent (${tag})`, async () => {
      const { root, files } = scratch();
      const { exec } = makeExec(root);
      const p = path.join(files, "f");
      fs.writeFileSync(p, "a\nb");
      const info = await open(exec, on, p);
      const r = await saveFile({ ...io(exec), on, path: p, info, bytes: bufferBytes("a\nbc", info) });
      assert.equal(r.ok, true, r.error);
      assert.equal(fs.readFileSync(p, "utf8"), "a\nbc");
    });

    test(`a change between probe and save is refused, file untouched, upload removed (${tag})`, async () => {
      const { root, files } = scratch();
      const { exec, cacheDir } = makeExec(root);
      const p = path.join(files, "f");
      fs.writeFileSync(p, "one\n");
      const info = await open(exec, on, p);
      fs.writeFileSync(p, "someone else\n");
      const r = await saveFile({ ...io(exec), on, path: p, info, bytes: bufferBytes("mine\n", info) });
      assert.deepEqual(r, { ok: false, error: "The file changed since it was opened. Your text is kept: use Save a Copy…" });
      assert.equal(fs.readFileSync(p, "utf8"), "someone else\n");
      assert.deepEqual(cacheLeft(cacheDir), []);
    });

    test(`a damaged or partial upload is refused before anything is written (${tag})`, async () => {
      const { root, files } = scratch();
      const big = "line of text\n".repeat(8000);
      const p = path.join(files, "f");
      fs.writeFileSync(p, big);
      const damage = [
        { stageWrap: (b64) => (b64[0] === "A" ? "B" : "A") + b64.slice(1) }, // a flipped character
        { sendWrap: async (a, send) => { const r = await send(a); fs.truncateSync(path.join(a.dir, a.name), 1000); return r; } }, // a cut transfer
      ];
      for (const opts of damage) {
        if (opts.sendWrap && on == null) continue; // local saves send nothing
        const { exec, cacheDir, staged } = makeExec(root, opts);
        const info = await open(exec, on, p, 1000000);
        const r = await saveFile({ ...io(exec), on, path: p, info, bytes: bufferBytes(big + "more\n", info) });
        assert.equal(r.ok, false);
        assert.match(r.error, /upload was damaged/);
        assert.equal(fs.readFileSync(p, "utf8"), big);
        assert.deepEqual(cacheLeft(cacheDir), []);
        assert.deepEqual(staged(), []);
      }
    });


    test(`a 1 MiB file round-trips byte exact with no content in any argv (${tag})`, async () => {
      const { root, files } = scratch();
      const { exec, calls, cacheDir } = makeExec(root);
      const p = path.join(files, "f");
      const line = "0123456789 abcdefghij ünï ✓\n";
      const text = line.repeat(Math.floor((EDIT_MAX_BYTES - 40) / Buffer.byteLength(line)));
      const orig = Buffer.from(text);
      assert.ok(orig.length <= EDIT_MAX_BYTES);
      fs.writeFileSync(p, orig);
      const info = await open(exec, on, p, 2000000);
      const bytes = bufferBytes(info.text + "tail \u{1F600}\n", info);
      const r = await saveFile({ ...io(exec), on, path: p, info, bytes });
      assert.equal(r.ok, true, r.error);
      assert.equal(sha(fs.readFileSync(p)), sha(bytes));
      for (const c of calls) assert.ok(c.args.join("").length < 4096, "only paths and hashes in argv");
      assert.deepEqual(cacheLeft(cacheDir), []);
    });
  }

  test("a path, a text and a name with quotes, spaces and a dash survive", async () => {
    const { root, files } = scratch();
    const { exec } = makeExec(root);
    const p = path.join(files, "it's \"x\" $HOME `id`;.txt");
    fs.writeFileSync(p, "a\n");
    for (const on of [null, "box"]) {
      const info = await open(exec, on, p);
      const text = "$(touch pwned) `touch pwned2` ' \" \\ ;\n";
      const r = await saveFile({ ...io(exec), on, path: p, info, bytes: bufferBytes(text, info) });
      assert.equal(r.ok, true, r.error);
      assert.equal(fs.readFileSync(p, "utf8"), text);
    }
    assert.deepEqual(fs.readdirSync(files), [path.basename(p)]);
  });

  test("a lone surrogate is refused without any call", async () => {
    const calls = [];
    const r = await saveFile({ exec: async (...a) => calls.push(a), on: null, path: "/x", info: { bytes: new Uint8Array(0) }, bytes: bufferBytes("\ud800", { eol: "LF" }) });
    assert.equal(r.ok, false);
    assert.match(r.error, /cannot be saved as UTF-8/);
    assert.equal(calls.length, 0);
  });

  test("link, folder and vanished file are refused with a short message and nothing is left", async () => {
    const { root, files } = scratch();
    const { exec, cacheDir } = makeExec(root);
    const p = path.join(files, "f");
    fs.writeFileSync(p, "a\n");
    const info = await open(exec, null, p);
    const bytes = bufferBytes("b\n", info);
    fs.rmSync(p);
    fs.writeFileSync(path.join(files, "target"), "a\n");
    fs.symlinkSync(path.join(files, "target"), p);
    let r = await saveFile({ ...io(exec), on: null, path: p, info, bytes });
    assert.match(r.error, /symbolic link/);
    assert.equal(fs.readFileSync(path.join(files, "target"), "utf8"), "a\n");
    fs.rmSync(p);
    r = await saveFile({ ...io(exec), on: null, path: p, info, bytes });
    assert.match(r.error, /no longer a regular file/);
    fs.mkdirSync(p);
    r = await saveFile({ ...io(exec), on: null, path: p, info, bytes });
    assert.match(r.error, /no longer a regular file/);
    assert.deepEqual(cacheLeft(cacheDir), []);
  });

  test("a file that lost its write permission is refused", { skip: IS_ROOT && "root can write to any file, test -w always passes" }, async () => {
    const { root, files } = scratch();
    const { exec, cacheDir } = makeExec(root);
    const p = path.join(files, "f");
    fs.writeFileSync(p, "a\n");
    const info = await open(exec, null, p);
    fs.chmodSync(p, 0o444);
    const r = await saveFile({ ...io(exec), on: null, path: p, info, bytes: bufferBytes("b\n", info) });
    assert.deepEqual(r, { ok: false, error: "No write permission; nothing was written" });
    assert.equal(fs.readFileSync(p, "utf8"), "a\n");
    assert.deepEqual(cacheLeft(cacheDir), []);
  });

  test("a failing write is rolled back from the backup and the text is kept", async () => {
    const { root, files } = scratch();
    const shim = path.join(root, "shim");
    fs.mkdirSync(shim);
    // cat that dies half way when it writes the upload file into the target
    fs.writeFileSync(path.join(shim, "cat"), `#!/bin/sh\ncase "$1" in */edit/edit.*) printf partial; exit 1 ;; esac\nexec ${spawnSync("sh", ["-c", "command -v cat"], { encoding: "utf8" }).stdout.trim()} "$@"\n`, { mode: 0o755 });
    const { exec, cacheDir } = makeExec(root, { pathPrefix: shim });
    const p = path.join(files, "f");
    fs.writeFileSync(p, "original\n");
    const info = await open(exec, null, p);
    const r = await saveFile({ ...io(exec), on: null, path: p, info, bytes: bufferBytes("new text\n", info) });
    assert.equal(r.ok, false);
    assert.match(r.error, /^Could not write the file; it is unchanged\. Your text is also in \//);
    assert.equal(fs.readFileSync(p, "utf8"), "original\n");
    assert.ok(r.error.endsWith(r.kept));
    assert.equal(fs.readFileSync(r.kept, "utf8"), "new text\n");
    assert.deepEqual(cacheLeft(cacheDir), [path.basename(r.kept)]);
  });

  test("a failing write and a failing rollback report both paths", async () => {
    const { root, files } = scratch();
    const shim = path.join(root, "shim");
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, "cat"), `#!/bin/sh\ncase "$1" in */edit/*) printf partial; exit 1 ;; esac\nexec ${spawnSync("sh", ["-c", "command -v cat"], { encoding: "utf8" }).stdout.trim()} "$@"\n`, { mode: 0o755 });
    const { exec } = makeExec(root, { pathPrefix: shim });
    const p = path.join(files, "f");
    fs.writeFileSync(p, "original\n");
    const info = await open(exec, null, p);
    const r = await saveFile({ ...io(exec), on: null, path: p, info, bytes: bufferBytes("new text\n", info) });
    assert.equal(r.ok, false);
    assert.equal(r.error, `Could not write the file; it may be incomplete. Original: ${r.backup}, your text: ${r.kept}`);
    assert.equal(fs.readFileSync(r.backup, "utf8"), "original\n");
    assert.equal(fs.readFileSync(r.kept, "utf8"), "new text\n");
  });

  test("exec that rejects gives a Cannot reach the machine message and cleans up what it can", async () => {
    const calls = [];
    const exec = async (cmd, args) => {
      calls.push(cmd === "sh" ? args[2] : cmd);
      if (args[2] === "begin-file") return { code: 0, stdout: "/c/filer-pro/edit/edit.abc\n", stderr: "" };
      if (cmd === "rm") return { code: 0, stdout: "", stderr: "" };
      throw new Error('`herdr.exec`: unknown machine "box"');
    };
    const stage = async () => "/stage/s1.b64";
    const r = await saveFile({ exec, stage, on: null, path: "/x", info: { bytes: new Uint8Array(0) }, bytes: new Uint8Array([97]) });
    assert.equal(r.ok, false);
    assert.match(r.error, /^Cannot reach the machine: /);
    assert.deepEqual(calls, ["begin-file", "commit"]);
    const r2 = await saveFile({ exec: async () => { throw new Error("ssh: connect to host box port 22: Connection refused"); }, stage, send: async () => ({ ok: true }), on: "box", path: "/x", info: { bytes: new Uint8Array(0) }, bytes: new Uint8Array([97]) });
    assert.match(r2.error, /^Cannot reach the machine: |private upload folder/);
  });


  test("a cache folder that cannot be created is reported", async () => {
    const { root, files } = scratch();
    const { exec } = makeExec(root);
    fs.writeFileSync(path.join(root, "cache"), "a file where the folder should be");
    const p = path.join(files, "f");
    fs.writeFileSync(p, "a\n");
    const info = await open(exec, null, p);
    const r = await saveFile({ ...io(exec), on: null, path: p, info, bytes: bufferBytes("b\n", info) });
    assert.equal(r.ok, false);
    assert.match(r.error, /private upload folder/);
    assert.equal(fs.readFileSync(p, "utf8"), "a\n");
  });
});

describe("saveCopy", () => {
  for (const on of [null, "box"]) {
    test(`creates the copy with the original mode (${on ?? "local"})`, async () => {
      const { root, files } = scratch();
      const { exec, cacheDir } = makeExec(root);
      for (const mode of ["600", "644", "640", "444"]) {
        const bytes = Buffer.from(`copy ${mode}\r\n`);
        const r = await saveCopy({ ...io(exec), on, dir: files, name: `c ${mode}.txt`, bytes, mode });
        assert.equal(r.ok, true, r.error);
        assert.equal(r.path, path.join(files, `c ${mode}.txt`));
        assert.deepEqual(fs.readFileSync(r.path), bytes);
        assert.equal((fs.statSync(r.path).mode & 0o777).toString(8), mode);
      }
      assert.deepEqual(cacheLeft(cacheDir), []);
    });
  }

  test("a 600 file's copy is private even under a permissive umask", async () => {
    const { root, files } = scratch();
    const { exec } = makeExec(root);
    const r = await saveCopy({ ...io(exec), on: null, dir: files, name: "p", bytes: Buffer.from("x"), mode: "600" });
    assert.equal(r.ok, true);
    assert.equal(fs.statSync(r.path).mode & 0o777, 0o600);
  });

  test("refuses an existing name, an existing symlink and a dangling symlink, touching nothing", async () => {
    const { root, files } = scratch();
    const { exec, cacheDir } = makeExec(root);
    fs.writeFileSync(path.join(files, "taken"), "keep");
    fs.writeFileSync(path.join(files, "target"), "target");
    fs.symlinkSync(path.join(files, "target"), path.join(files, "lnk"));
    fs.symlinkSync(path.join(files, "nowhere"), path.join(files, "dangling"));
    for (const name of ["taken", "lnk", "dangling"]) {
      const r = await saveCopy({ ...io(exec), on: null, dir: files, name, bytes: Buffer.from("new"), mode: "644" });
      assert.deepEqual(r, { ok: false, error: "A file with that name already exists" }, name);
    }
    assert.equal(fs.readFileSync(path.join(files, "taken"), "utf8"), "keep");
    assert.equal(fs.readFileSync(path.join(files, "target"), "utf8"), "target");
    assert.equal(fs.existsSync(path.join(files, "nowhere")), false);
    assert.deepEqual(cacheLeft(cacheDir), []);
  });

  test("validates the name and the folder", async () => {
    const { root, files } = scratch();
    const { exec, calls } = makeExec(root);
    assert.equal((await saveCopy({ ...io(exec), on: null, dir: files, name: "a/b", bytes: Buffer.from("x"), mode: "600" })).ok, false);
    assert.equal((await saveCopy({ ...io(exec), on: null, dir: files, name: "", bytes: Buffer.from("x"), mode: "600" })).ok, false);
    assert.equal((await saveCopy({ ...io(exec), on: null, dir: files, name: "..", bytes: Buffer.from("x"), mode: "600" })).ok, false);
    assert.equal((await saveCopy({ ...io(exec), on: null, dir: "rel", name: "a", bytes: Buffer.from("x"), mode: "600" })).ok, false);
    assert.equal((await saveCopy({ ...io(exec), on: null, dir: files, name: "a", bytes: null, mode: "600" })).ok, false);
    assert.equal(calls.length, 0);
  });

  test("a name starting with a dash is fine, a missing folder is reported and cleaned up", async () => {
    const { root, files } = scratch();
    const { exec, cacheDir } = makeExec(root);
    assert.equal((await saveCopy({ ...io(exec), on: null, dir: files, name: "-n", bytes: Buffer.from("x"), mode: "600" })).ok, true);
    const r = await saveCopy({ ...io(exec), on: null, dir: path.join(files, "nope"), name: "a", bytes: Buffer.from("x"), mode: "600" });
    assert.deepEqual(r, { ok: false, error: "Could not create the copy" });
    assert.deepEqual(cacheLeft(cacheDir), []);
  });

  test("a large copy goes through several calls", async () => {
    const { root, files } = scratch();
    const { exec, calls } = makeExec(root);
    const bytes = crypto.randomBytes(300000);
    const r = await saveCopy({ ...io(exec), on: "box", dir: files, name: "big.bin", bytes, mode: "640" });
    assert.equal(r.ok, true, r.error);
    assert.ok(calls.length >= 6);
    assert.deepEqual(fs.readFileSync(r.path), bytes);
  });
});

describe("scripts", () => {
  test("hash fallbacks: shasum and openssl give the same verdict as sha256sum", async () => {
    // a PATH with only the tools the script needs, minus sha256sum / minus both
    const { root, files } = scratch();
    for (const hide of [["sha256sum"], ["sha256sum", "shasum"]]) {
      const bin = path.join(root, `bin-${hide.length}`);
      fs.mkdirSync(bin);
      for (const tool of ["sh", "cat", "cp", "chmod", "rm", "mktemp", "mkdir", "awk", "base64", "tr", "head", "printf", "shasum", "openssl", "perl", "stat", "dirname", "env"]) {
        if (hide.includes(tool)) continue;
        const r = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" });
        if (r.stdout.trim().startsWith("/")) fs.symlinkSync(r.stdout.trim(), path.join(bin, tool));
      }
      const cacheDir = path.join(root, "cache", "filer-pro", "edit");
      const run = (cmd, args) => spawnSync("/bin/sh", args.length ? ["-c", ...args] : [], { encoding: "utf8", env: { ...process.env, PATH: bin, HOME: path.join(root, "home"), XDG_CACHE_HOME: path.join(root, "cache") } });
      const p = path.join(files, `f${hide.length}`);
      fs.writeFileSync(p, "old\n");
      const src = path.join(root, `staged${hide.length}`);
      fs.writeFileSync(src, Buffer.from("new\n").toString("base64"));
      const begin = run("sh", [BEGIN_FILE_SCRIPT, "begin-file", src]);
      assert.equal(begin.status, 0, begin.stderr);
      const tmp = begin.stdout.trim();
      const c = run("sh", [COMMIT_SCRIPT, "commit", tmp, p, sha("old\n"), sha("new\n")]);
      assert.equal(c.stdout.trim(), "ok", c.stderr);
      assert.equal(fs.readFileSync(p, "utf8"), "new\n");
      assert.deepEqual(cacheLeft(cacheDir), []);
    }
  });

  test("with no sha256 tool at all the commit says nohash and writes nothing", () => {
    const { root, files } = scratch();
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    for (const tool of ["cat", "rm", "mktemp", "mkdir", "chmod", "awk", "base64", "cp"]) {
      const r = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" });
      fs.symlinkSync(r.stdout.trim(), path.join(bin, tool));
    }
    const p = path.join(files, "f");
    fs.writeFileSync(p, "old\n");
    const r = spawnSync("/bin/sh", ["-c", COMMIT_SCRIPT, "commit", "/x/filer-pro/edit/edit.1", p, "a", "b"], { encoding: "utf8", env: { PATH: bin, HOME: root } });
    assert.equal(r.stdout.trim(), "nohash");
    assert.equal(fs.readFileSync(p, "utf8"), "old\n");
  });

  test("base64 decode flag detection: a base64 that only knows -D works", () => {
    const { root } = scratch();
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const real = spawnSync("sh", ["-c", "command -v base64"], { encoding: "utf8" }).stdout.trim();
    // BSD-like: -d is an error, -D decodes
    fs.writeFileSync(path.join(bin, "base64"), `#!/bin/sh\ncase "$1" in -D) shift; exec ${real} -d "$@" ;; -*) echo "illegal option" >&2; exit 1 ;; esac\nexec ${real} "$@"\n`, { mode: 0o755 });
    const src = path.join(root, "staged");
    fs.writeFileSync(src, Buffer.from("hello").toString("base64"));
    const r = spawnSync("sh", ["-c", BEGIN_FILE_SCRIPT, "begin-file", src], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: root, XDG_CACHE_HOME: path.join(root, "cache") } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(r.stdout.trim(), "utf8"), "hello");
  });

  test("CLEAN_SCRIPT only removes files in the private folder", () => {
    const { root, files } = scratch();
    const keep = path.join(files, "keep");
    fs.writeFileSync(keep, "x");
    spawnSync("sh", ["-c", CLEAN_SCRIPT, "clean", keep]);
    assert.equal(fs.existsSync(keep), true);
    const dir = path.join(root, "filer-pro", "edit");
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, "edit.abc123");
    fs.writeFileSync(tmp, "x");
    spawnSync("sh", ["-c", CLEAN_SCRIPT, "clean", tmp]);
    assert.equal(fs.existsSync(tmp), false);
  });

  test("the module uses none of the APIs the QuickJS runtime lacks", () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "mods/filer-pro/lib/textedit.js"), "utf8");
    const code = src.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
    assert.doesNotMatch(code, /\bBuffer\b|TextDecoder|TextEncoder|node:crypto|\bIntl\b|toLocaleString|\batob\b|\bbtoa\b/);
    assert.doesNotMatch(src, /[–—]/);
  });
});

describe("security review fixes", () => {
  // A stage() like main.js's local one: the base64 goes into a private file, only its path into argv.
  const stager = (root) => async (b64) => {
    const dir = path.join(root, "stage");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const p = path.join(dir, `s${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(p, b64, { mode: 0o600 });
    return p;
  };

  test("a local save with stage() puts no file content into any argv and removes the staged file", async () => {
    const { root, files } = scratch();
    const { exec, calls, cacheDir } = makeExec(root);
    const p = path.join(files, "secret.env");
    put(p, Buffer.from("TOKEN=old\n"), 0o600);
    const info = await open(exec, null, p);
    const bytes = bufferBytes("TOKEN=new-value-" + "x".repeat(200000) + "\n", info);
    const r = await saveFile({ ...io(exec), on: null, path: p, info, bytes, stage: stager(root) });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(fs.readFileSync(p), Buffer.from(bytes));
    const b64 = Buffer.from(bytes).toString("base64");
    for (const c of calls) for (const a of c.args) assert.ok(!a.includes(b64.slice(0, 40)), "content in argv");
    assert.ok(calls.some((c) => c.args[1] === BEGIN_FILE_SCRIPT));
    assert.deepEqual(fs.readdirSync(path.join(root, "stage")), [], "staged file removed");
    assert.deepEqual(cacheLeft(cacheDir), []);
    const c = await saveCopy({ ...io(exec), on: null, dir: files, name: "copy.env", bytes, mode: "600", stage: stager(root) });
    assert.equal(c.ok, true, c.error);
    assert.deepEqual(fs.readdirSync(path.join(root, "stage")), []);
  });

  test("a failing stage() refuses without any exec, locally and for a machine", async () => {
    const { root, files } = scratch();
    const { exec, calls } = makeExec(root);
    const p = path.join(files, "f");
    put(p, Buffer.from("a\n"));
    for (const on of [null, "box"]) {
      const info = await open(exec, on, p);
      calls.length = 0;
      const r = await saveFile({ ...io(exec), on, path: p, info, bytes: Buffer.from("c\n"), stage: async () => { throw new Error("disk"); } });
      assert.deepEqual(r, { ok: false, error: "Could not prepare the text for saving" });
      assert.equal(calls.length, 0);
      assert.equal(fs.readFileSync(p, "utf8"), "a\n");
    }
    // without stage, or for a machine without send, nothing is uploaded either
    assert.equal((await saveFile({ exec, on: null, path: p, info: await open(exec, null, p), bytes: Buffer.from("c\n") })).ok, false);
    assert.equal((await saveFile({ exec, stage: exec.stage, on: "box", path: p, info: await open(exec, "box", p), bytes: Buffer.from("c\n") })).ok, false);
  });

  test("a save to a machine copies the staged file with scp (transfer.sh up): no content in any argv", async () => {
    const { root, files } = scratch();
    const { exec, calls, staged, cacheDir } = makeExec(root);
    const p = path.join(files, "secret.env");
    put(p, Buffer.from("TOKEN=old\n"), 0o600);
    const info = await open(exec, "box", p);
    const text = "TOKEN=" + "n3w-s3cr3t".repeat(30) + "\n";
    const bytes = bufferBytes(text, info);
    const r = await saveFile({ ...io(exec), on: "box", path: p, info, bytes });
    assert.equal(r.ok, true, r.error);
    assert.equal(fs.readFileSync(p, "utf8"), text);
    const b64 = Buffer.from(bytes).toString("base64");
    for (const c of calls) for (const a of c.args) assert.ok(!a.includes(b64.slice(0, 40)) && !a.includes("n3w-s3cr3t"), "content in argv");
    const up = calls.find((c) => c.args[0] === TRANSFER);
    assert.ok(up, "transfer.sh ran");
    assert.deepEqual(up.args.slice(1, 4), ["up", "new", "box"]);
    assert.equal(up.on, null, "scp runs here");
    assert.deepEqual(staged(), [], "local staged file and status removed");
    assert.deepEqual(cacheLeft(cacheDir), [], "nothing left on the machine");
    const c = await saveCopy({ ...io(exec), on: "box", dir: files, name: "copy.env", bytes, mode: "600" });
    assert.equal(c.ok, true, c.error);
    assert.equal(fs.readFileSync(path.join(files, "copy.env"), "utf8"), text);
    assert.deepEqual(staged(), []);
  });

  test("a failed scp transfer keeps the file and removes the local staged file and the remote leftovers", async () => {
    const { root, files } = scratch();
    const p = path.join(files, "f");
    put(p, Buffer.from("old\n"));
    for (const fail of ["env", "throw", "machine"]) {
      const { exec, staged, cacheDir } = makeExec(root, {
        extraEnv: fail === "env" ? { FAKE_FAIL: "scp: connection lost" } : {}, // the fake scp copies, then fails
        sendWrap: async (a, send) => {
          if (fail === "throw") throw new Error("boom");
          if (fail === "machine") return { ok: false, error: "Unknown machine: box" };
          return send(a);
        },
      });
      const info = await open(exec, "box", p);
      const r = await saveFile({ ...io(exec), on: "box", path: p, info, bytes: Buffer.from("new\n") });
      assert.equal(r.ok, false, fail);
      assert.match(r.error, /^Could not copy the text to the machine: /, fail);
      assert.equal(fs.readFileSync(p, "utf8"), "old\n");
      assert.deepEqual(staged(), [], `${fail}: local staged file removed`);
      assert.deepEqual(cacheLeft(cacheDir), [], `${fail}: nothing left on the machine`);
    }
  });

  test("scpSender passes the SSH settings as transfer jobs do, and reports a bad machine list", async () => {
    const seen = [];
    const exec = async (cmd, args) => { seen.push([cmd, ...args]); return { code: 0, stdout: "", stderr: "" }; };
    const hc = async () => ({ code: 0, stdout: MACHINES, stderr: "" });
    const send = scpSender({ exec, hc, script: "/t.sh", trashDir: "/trash", limits: () => ({ ...numbers(null), ssh_connect_timeout: 7 }) });
    assert.deepEqual(await send({ on: "box", src: "/s/x.b64", dir: "/r", name: "edit.up-1.b64" }), { ok: true });
    assert.equal(seen[0][0], "env");
    assert.ok(seen[0].includes("FILER_PRO_SSH_CONNECT_TIMEOUT=7"));
    assert.deepEqual(seen[0].slice(seen[0].indexOf("/t.sh") + 1, -3), ["up", "new", "box", "/s/x.b64", "/r/edit.up-1.b64"]);
    const bad = scpSender({ exec, hc: async () => ({ code: 0, stdout: "{}", stderr: "" }), script: "/t.sh", trashDir: "/trash", limits: () => numbers(null) });
    assert.equal((await bad({ on: "box", src: "/s", dir: "/r", name: "n" })).ok, false);
  });


  test("a folder writable by everyone without the sticky bit is refused; with the sticky bit it is fine", async () => {
    const { root, files } = scratch();
    const { exec } = makeExec(root);
    const open777 = path.join(files, "open"), sticky = path.join(files, "sticky");
    fs.mkdirSync(open777); fs.chmodSync(open777, 0o777);
    fs.mkdirSync(sticky); fs.chmodSync(sticky, 0o1777);
    put(path.join(open777, "f"), Buffer.from("a\n"));
    put(path.join(sticky, "f"), Buffer.from("a\n"));
    for (const on of [null, "box"]) {
      assert.deepEqual(await probeFile({ exec, on, path: path.join(open777, "f"), maxChars: 100 }), { ok: false, reason: "Folder writable by everyone" });
      assert.equal((await probeFile({ exec, on, path: path.join(sticky, "f"), maxChars: 100 })).ok, true);
    }
    // The commit and the copy refuse it too (the folder may have been opened up after the probe).
    const info = await open(exec, null, path.join(sticky, "f"));
    fs.chmodSync(sticky, 0o777);
    const r = await saveFile({ ...io(exec), on: null, path: path.join(sticky, "f"), info, bytes: Buffer.from("b\n") });
    assert.deepEqual(r, { ok: false, error: "The folder is writable by everyone; nothing was written" });
    assert.equal(fs.readFileSync(path.join(sticky, "f"), "utf8"), "a\n");
    const c = await saveCopy({ ...io(exec), on: null, dir: open777, name: "c", bytes: Buffer.from("x"), mode: "644" });
    assert.deepEqual(c, { ok: false, error: "The folder is writable by everyone; nothing was written" });
    assert.equal(fs.existsSync(path.join(open777, "c")), false);
  });

  test("a file swapped for another (new inode) after the hash check is not written", async () => {
    const { root, files } = scratch();
    const p = path.join(files, "f"), other = path.join(files, "other");
    put(p, Buffer.from("same\n"));
    put(other, Buffer.from("same\n"));
    // A cp shim that swaps the file for a link to another file with the same content right after the backup.
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "cp"), `#!/bin/sh\ncommand -p cp "$@" || exit 1\nrm -f '${p}' && ln -s '${other}' '${p}'\n`, { mode: 0o755 });
    const { exec } = makeExec(root, { pathPrefix: bin });
    const info = await open(exec, null, p);
    const r = await saveFile({ ...io(exec), on: null, path: p, info, bytes: Buffer.from("new\n") });
    assert.equal(r.ok, false);
    assert.match(r.error, /changed since it was opened/);
    assert.equal(fs.readFileSync(other, "utf8"), "same\n", "the link target is untouched");
  });

  test("the copy is created with its final mode, without any chmod, and gets no execute bits", async () => {
    assert.ok(!/\bchmod\b/.test(COPY_SCRIPT), "no chmod by path in the copy script");
    const { root, files } = scratch();
    const { exec } = makeExec(root);
    const r = await saveCopy({ ...io(exec), on: null, dir: files, name: "run.sh", bytes: Buffer.from("echo\n"), mode: "755" });
    assert.equal(r.ok, true, r.error);
    assert.equal(fs.statSync(r.path).mode & 0o777, 0o644);
  });
});

test("mirrorName keeps only safe characters and never starts with a dot", () => {
  assert.equal(mirrorName("ab12", "notes.txt"), "ab12-notes.txt.txt");
  assert.equal(mirrorName("ab12", ".."), "ab12-_.txt");
  assert.equal(mirrorName("ab12", ".env"), "ab12-_env.txt");
  assert.equal(mirrorName("ab12", "a\\b:c\u0001/d"), "ab12-a_b_c__d.txt");
  assert.equal(mirrorName("ab12", ""), "ab12-file.txt");
  assert.equal(mirrorName("ab12", "x".repeat(300)).length, "ab12-".length + 80 + 4);
});

describe("mode with special bits, the same on GNU and BSD stat", () => {
  test("octalMode: 3 digits, 4 when a special bit is set, file type masked off", () => {
    assert.equal(octalMode("644"), "644");
    assert.equal(octalMode("4755"), "4755");
    assert.equal(octalMode("100644"), "644");
    assert.equal(octalMode("104755"), "4755");
    assert.equal(octalMode("102775"), "2775");
    assert.equal(octalMode("0600"), "600");
    assert.equal(octalMode("41777"), "1777");
  });

  test("a setuid file reports 4755 with this machine's real stat (GNU on Linux, BSD on macOS)", async () => {
    const { root, files } = scratch();
    const { exec } = makeExec(root);
    const p = path.join(files, "tool");
    put(p, Buffer.from("echo\n"), 0o4755);
    if ((fs.statSync(p).mode & 0o7777) !== 0o4755) return; // a file system that drops setuid (nosuid mount)
    for (const on of [null, "box"]) assert.equal((await open(exec, on, p)).mode, "4755");
  });

  test("a BSD stat (stubbed: no -c, %p with the file type) gives the same mode as GNU", async () => {
    const { root, files } = scratch();
    const bin = path.join(root, "bsd");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "stat"), [
      "#!/bin/sh",
      'case $1 in -c*) exit 1 ;; esac',
      'case $1 in -f%p) echo 104755 ;; -f%z) wc -c < "$2" | tr -d " " ;; -f) echo 1:2 ;; *) exit 1 ;; esac',
      "",
    ].join("\n"), { mode: 0o755 });
    const { exec, calls } = makeExec(root, { pathPrefix: bin });
    const p = path.join(files, "f");
    put(p, Buffer.from("abc\n"), 0o644);
    for (const on of [null, "box"]) {
      const info = await open(exec, on, p);
      assert.equal(info.mode, "4755", on ?? "local");
      assert.equal(info.size, 4);
      assert.equal(statusText(info), "UTF-8 · LF · 4755");
    }
    assert.ok(calls.length > 0);
  });
});

// ---- the check always ends (herdr's QuickJS interrupts a job after about 0.5 s with an error JS cannot catch)

// A fake timer: run(ms) fires the timers of that delay armed so far, as the host would once the current job ended.
function fakeTimers() {
  const armed = [];
  return {
    armed,
    after: (ms, fn) => armed.push({ ms, fn }),
    run: (ms) => armed.filter((t) => t.ms === ms && !t.fired).forEach((t) => { t.fired = true; t.fn(); }),
  };
}
const probeOut = (text) => ({ code: 0, stdout: `file y 644 ${Buffer.byteLength(text)} n\n${Buffer.from(text).toString("base64")}\n`, stderr: "" });
const settle = () => new Promise((r) => setImmediate(r));

describe("probeFileGuarded", () => {
  test("a check interrupted by the runtime still ends: Could not check this file", async () => {
    const t = fakeTimers(), results = [];
    // The interrupt cannot be caught, so nothing after it runs in that job; the host then fires the timers. Modelled by a
    // check that lets the zero timer (armed before the check) fire while it is still running.
    const check = () => { t.run(0); return { ok: true, info: {} }; };
    probeFileGuarded({ exec: async () => probeOut("hi\n"), path: "/f", maxChars: 100, after: t.after, check }, (r) => results.push(r));
    await settle();
    assert.deepEqual(results, [{ ok: false, reason: CHECK_FAILED }]);
    assert.equal(CHECK_FAILED, "Could not check this file");
  });

  test("a check that throws ends with Could not check this file", async () => {
    const t = fakeTimers(), results = [];
    probeFileGuarded({ exec: async () => probeOut("hi\n"), path: "/f", maxChars: 100, after: t.after, check: () => { throw new Error("boom"); } }, (r) => results.push(r));
    await settle();
    t.run(0);
    assert.deepEqual(results, [{ ok: false, reason: CHECK_FAILED }]);
  });

  test("a probe without an answer ends after the timeout", async () => {
    const t = fakeTimers(), results = [];
    probeFileGuarded({ exec: () => new Promise(() => {}), path: "/f", maxChars: 100, after: t.after }, (r) => results.push(r));
    await settle();
    assert.deepEqual(results, []);
    assert.equal(t.armed[0].ms, CHECK_TIMEOUT_MS);
    t.run(CHECK_TIMEOUT_MS);
    assert.deepEqual(results, [{ ok: false, reason: `${CHECK_FAILED} (no answer)` }]);
  });

  test("a rejected or failed probe: Cannot read this file, once", async () => {
    for (const exec of [async () => { throw new Error("gone"); }, async () => ({ code: 1, stdout: "", stderr: "x" })]) {
      const t = fakeTimers(), results = [];
      probeFileGuarded({ exec, path: "/f", maxChars: 100, after: t.after }, (r) => results.push(r));
      await settle();
      t.run(0);
      t.run(CHECK_TIMEOUT_MS);
      assert.deepEqual(results, [{ ok: false, reason: "Cannot read this file" }]);
    }
  });

  test("a good check ends once with its result; the timers that fire later change nothing", async () => {
    const t = fakeTimers(), results = [];
    probeFileGuarded({ exec: async () => probeOut("hä\r\n"), path: "/f", maxChars: 100, after: t.after }, (r) => results.push(r));
    await settle();
    t.run(0);
    t.run(CHECK_TIMEOUT_MS);
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true);
    assert.equal(results[0].info.text, "hä\n");
    assert.equal(results[0].info.eol, "CRLF");
  });
});

// Exactly EDIT_MAX_BYTES of multibyte text with CRLF line ends.
function mibText() {
  const unit = "Grüße € 😀 the quick brown fox\r\n";
  const n = Math.floor(EDIT_MAX_BYTES / Buffer.byteLength(unit));
  const text = unit.repeat(n) + "x".repeat(EDIT_MAX_BYTES - n * Buffer.byteLength(unit));
  assert.equal(Buffer.byteLength(text), EDIT_MAX_BYTES);
  return text;
}

test("1 MiB (the edit limit) of multibyte CRLF text passes the check, one byte more is refused", () => {
  const text = mibText();
  const r = checkEditable(parseProbe(probeOut(text).stdout), { maxChars: 2000000 });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.info.eol, "CRLF");
  assert.equal(r.info.text, text.replaceAll("\r\n", "\n"));
  assert.deepEqual(Buffer.from(r.info.bytes), Buffer.from(text));
  assert.deepEqual(Buffer.from(bufferBytes(r.info.text, r.info)), Buffer.from(text));
  const over = text + "y";
  assert.equal(checkEditable(parseProbe(probeOut(over).stdout), { maxChars: 2000000 }).reason, "File larger than 1 MiB");
});

// Regression of #29 merged after #30: a local "Operation not permitted" names the macOS privacy settings only on macOS.
describe("localPlatform in the save texts", () => {
  const MAC = "Not permitted: macOS privacy settings, owner, or a locked item.";
  const NEUTRAL = "Not permitted (owner, sticky folder or locked item)";
  // Every command answers EPERM; the staged file is a real local path, so upload gets to its first exec.
  const denied = (step) => {
    const exec = async (cmd, args) => {
      const script = args?.[1];
      if (step === "begin" && script === BEGIN_FILE_SCRIPT) return { code: 1, stdout: "", stderr: "sh: /x: Operation not permitted" };
      if (script === BEGIN_FILE_SCRIPT) return { code: 0, stdout: "/x/up.tmp\n", stderr: "" };
      if (script === COMMIT_SCRIPT || script === COPY_SCRIPT) return { code: 1, stdout: "", stderr: "sh: /x/a.txt: Operation not permitted" };
      return { code: 0, stdout: "", stderr: "" };
    };
    return { exec, stage: async () => "/x/stage.b64" };
  };
  const info = { bytes: new Uint8Array([97]), hash: null, text: "a", eol: "LF", mode: "644", size: 1 };
  const bytes = new Uint8Array([98]);
  for (const [platform, want] of [[undefined, MAC], ["macos", MAC], ["linux", NEUTRAL], ["windows", NEUTRAL]]) {
    test(`saveFile, saveCopy and the upload on ${platform ?? "an unknown platform"}`, async () => {
      assert.equal((await saveFile({ ...denied("commit"), path: "/x/a.txt", info, bytes, localPlatform: platform })).error, want);
      assert.equal((await saveCopy({ ...denied("commit"), dir: "/x", name: "b.txt", bytes, mode: "644", localPlatform: platform })).error, want);
      assert.equal((await saveFile({ ...denied("begin"), path: "/x/a.txt", info, bytes, localPlatform: platform })).error, want);
      const thrown = { exec: async () => { throw new Error("Operation not permitted"); }, stage: async () => "/x/stage.b64" };
      assert.equal((await saveFile({ ...thrown, path: "/x/a.txt", info, bytes, localPlatform: platform })).error, `Cannot reach the machine: ${want}`);
    });
  }
  test("scpSender: a local side that is not permitted (scp open local) follows localPlatform too", async () => {
    const exec = async (cmd, args) => (cmd === "sh" && args[0] === "-c" ? { code: 0, stdout: 'open local "/x/stage.b64": Operation not permitted\n', stderr: "" } : { code: 1, stdout: "", stderr: "" });
    const hc = async () => ({ code: 0, stdout: MACHINES, stderr: "" });
    const send = (localPlatform) => scpSender({ exec, hc, script: "/t.sh", trashDir: "/t", limits: () => numbers(null), localPlatform })({ on: "box", src: "/x/stage.b64", dir: "/r", name: "n" });
    assert.equal((await send("linux")).error, NEUTRAL);
    assert.equal((await send("macos")).error, MAC);
  });
});
