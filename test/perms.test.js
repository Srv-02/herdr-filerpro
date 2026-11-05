// lib/perms.js: pure mode helpers (octal parsing and formatting, the rwx matrix, symbolic text, the warnings the dialog
// shows while editing) and the parsers for the probe, count and chmod answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseOctal, formatOctal, formatSymbolic, formatChange, chmodArg, getBit, setBit, specialBits, modeWarnings, canChange,
  parseProbe, parseCount, parseModeOut, mismatchText, insideText, COUNT_LIMIT,
} from "../mods/filer-pro/lib/perms.js";

test("parseOctal: 3 or 4 digits 0-7 are accepted", () => {
  assert.deepEqual(parseOctal("644"), { ok: true, mode: 0o644 });
  assert.deepEqual(parseOctal("0644"), { ok: true, mode: 0o644 });
  assert.deepEqual(parseOctal("2755"), { ok: true, mode: 0o2755 });
  assert.deepEqual(parseOctal("000"), { ok: true, mode: 0 });
  assert.deepEqual(parseOctal("7777"), { ok: true, mode: 0o7777 });
});

test("parseOctal: everything else is refused before any command runs", () => {
  for (const bad of ["", "6", "64", "64444", "00644", "888", "648", "u+x", "a=rwx", "+x", "0x1f", "64 4", " 644", "644 ", "644\n", "-644", "6.4", "６４４", "rwx", "644;ls"]) {
    const r = parseOctal(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(typeof r.error, "string");
  }
  assert.equal(parseOctal(644).ok, false, "only text");
  assert.equal(parseOctal(null).ok, false);
});

test("formatOctal: 3 digits, 4 only with special bits", () => {
  assert.equal(formatOctal(0o644), "644");
  assert.equal(formatOctal(0), "000");
  assert.equal(formatOctal(0o7), "007");
  assert.equal(formatOctal(0o4755), "4755");
  assert.equal(formatOctal(0o1777), "1777");
});

test("formatSymbolic: rwx text with s, S, t, T", () => {
  assert.equal(formatSymbolic(0o644), "rw-r--r--");
  assert.equal(formatSymbolic(0o755), "rwxr-xr-x");
  assert.equal(formatSymbolic(0), "---------");
  assert.equal(formatSymbolic(0o4755), "rwsr-xr-x");
  assert.equal(formatSymbolic(0o4644), "rwSr--r--");
  assert.equal(formatSymbolic(0o2755), "rwxr-sr-x");
  assert.equal(formatSymbolic(0o1777), "rwxrwxrwt");
  assert.equal(formatSymbolic(0o1776), "rwxrwxrwT");
});

test("formatChange: old and new in the same width", () => {
  assert.equal(formatChange(0o644, 0o600), "644 → 600");
  assert.equal(formatChange(0o644, 0o2755), "0644 → 2755");
  assert.equal(formatChange(0o4755, 0o755), "4755 → 0755");
});

test("chmodArg: always five digits so GNU chmod clears special bits of a folder", () => {
  assert.equal(chmodArg(0o755), "00755");
  assert.equal(chmodArg(0), "00000");
  assert.equal(chmodArg(0o2755), "02755");
  assert.equal(chmodArg(0o7777), "07777");
  assert.throws(() => chmodArg(0o10000));
  assert.throws(() => chmodArg(-1));
  assert.throws(() => chmodArg(1.5));
  assert.throws(() => chmodArg("644"));
});

test("matrix: getBit and setBit address owner, group, others and r, w, x", () => {
  assert.equal(getBit(0o640, "owner", "w"), true);
  assert.equal(getBit(0o640, "group", "w"), false);
  assert.equal(getBit(0o640, "group", "r"), true);
  assert.equal(getBit(0o640, "others", "r"), false);
  assert.equal(getBit(0o641, "others", "x"), true);
  assert.equal(setBit(0o640, "others", "r", true), 0o644);
  assert.equal(setBit(0o644, "owner", "w", false), 0o444);
  assert.equal(setBit(0o644, "group", "x", true), 0o654);
  assert.equal(setBit(0o755, "owner", "x", false), 0o655);
});

test("matrix: toggling a box keeps the special bits, and octal text stays in sync both ways", () => {
  const m = setBit(0o4755, "others", "w", true);
  assert.equal(m, 0o4757);
  assert.equal(formatOctal(m), "4757");
  const parsed = parseOctal("4757");
  for (const who of ["owner", "group", "others"]) for (const what of ["r", "w", "x"]) assert.equal(getBit(parsed.mode, who, what), getBit(m, who, what));
  assert.throws(() => setBit(0o644, "nobody", "r", true));
  assert.throws(() => setBit(0o644, "owner", "s", true));
});

test("specialBits", () => {
  assert.deepEqual(specialBits(0o644), { setuid: false, setgid: false, sticky: false });
  assert.deepEqual(specialBits(0o7000), { setuid: true, setgid: true, sticky: true });
  assert.deepEqual(specialBits(0o2755), { setuid: false, setgid: true, sticky: false });
});

const w = (over) => modeWarnings({ oldMode: 0o644, newMode: 0o644, isDir: false, recursive: false, ...over });

test("modeWarnings: a harmless change has no warning", () => {
  assert.deepEqual(w({ newMode: 0o600 }), []);
  assert.deepEqual(w({ newMode: 0o755 }), []);
});

test("modeWarnings: world writable result", () => {
  for (const m of [0o777, 0o666, 0o602, 0o1777]) assert.ok(w({ newMode: m }).some((x) => /World writable/.test(x)), m.toString(8));
  assert.ok(!w({ newMode: 0o664 }).some((x) => /World writable/.test(x)));
});

test("modeWarnings: removing the user's own read or write permission", () => {
  assert.ok(w({ newMode: 0o244 }).some((x) => /your own read permission/.test(x)));
  assert.ok(w({ newMode: 0o444 }).some((x) => /your own write permission/.test(x)));
  assert.ok(w({ newMode: 0o044 }).some((x) => /your own read and write permission/.test(x)));
  assert.ok(!w({ newMode: 0o640 }).some((x) => /your own/.test(x)));
  // a permission that was not there before is not removed
  assert.ok(!w({ oldMode: 0o444, newMode: 0o444 }).some((x) => /your own/.test(x)));
});

test("modeWarnings: a folder without execute for the owner cannot be entered", () => {
  assert.ok(w({ isDir: true, oldMode: 0o755, newMode: 0o644 }).some((x) => /your own execute permission: you can no longer open the folder/.test(x)));
  assert.ok(!w({ isDir: false, oldMode: 0o755, newMode: 0o644 }).some((x) => /execute/.test(x)));
});

test("modeWarnings: setuid, setgid and sticky", () => {
  assert.ok(w({ newMode: 0o4755 }).some((x) => /sets setuid/.test(x)));
  assert.ok(w({ oldMode: 0o2755, newMode: 0o755 }).some((x) => /clears setgid/.test(x)));
  const both = w({ oldMode: 0o1755, newMode: 0o6755 }).find((x) => /Special bits/.test(x));
  assert.match(both, /sets setuid, setgid/);
  assert.match(both, /clears sticky/);
  assert.ok(!w({ oldMode: 0o4755, newMode: 0o4700 }).some((x) => /Special bits/.test(x)), "unchanged special bits are no warning");
});

test("insideText: the entries inside a recursive apply, never the folder itself", () => {
  assert.equal(insideText(1234), "Also sets this mode on 1,234 items inside (links are skipped).");
  assert.match(insideText(1), /on 1 item inside/);
  assert.match(insideText(0), /on 0 items inside/);
  assert.match(insideText(COUNT_LIMIT), /10,000 items/);
  assert.match(insideText(COUNT_LIMIT + 1), /more than 10,000 items/);
  assert.match(insideText(null), /many items/);
  assert.equal(insideText(null, true), "Counting the items inside…");
});

test("modeWarnings: no count, and nothing about the inside without recursive", () => {
  assert.ok(!w({ isDir: true, oldMode: 0o755, newMode: 0o755 }).some((x) => /inside/.test(x)));
  assert.ok(!modeWarnings({ oldMode: 0o755, newMode: 0o755, isDir: true, recursive: true, count: 5 }).some((x) => /items/.test(x)), "the count is insideText's");
});

test("modeWarnings: recursive with one mode for files and folders", () => {
  const r = (newMode) => modeWarnings({ oldMode: 0o755, newMode, isDir: true, recursive: true });
  assert.ok(r(0o644).some((x) => /cannot be opened/.test(x)));
  assert.ok(r(0o755).some((x) => /Files inside become executable/.test(x)));
  assert.ok(r(0o750).some((x) => /become executable/.test(x)));
  assert.ok(!r(0o600).some((x) => /become executable/.test(x)));
});

test("modeWarnings: every line fits the notes area (one line of about 64 characters, at most two)", () => {
  const all = [
    ...w({ newMode: 0o666 }), ...w({ newMode: 0o044 }), ...w({ isDir: true, oldMode: 0o755, newMode: 0o055 }),
    ...w({ oldMode: 0o1755, newMode: 0o6755 }), ...modeWarnings({ oldMode: 0o755, newMode: 0o644, isDir: true, recursive: true }),
    insideText(COUNT_LIMIT + 1), insideText(null, true),
  ];
  for (const x of all) assert.ok(x.length <= 128, x);
});

test("canChange: the owner or root, nobody else", () => {
  assert.equal(canChange({ uid: "501", me: "501" }), true);
  assert.equal(canChange({ uid: "0", me: "0" }), true);
  assert.equal(canChange({ uid: "501", me: "0" }), true);
  assert.equal(canChange({ uid: "0", me: "501" }), false);
  assert.equal(canChange({ uid: "501", me: "502" }), false);
  assert.equal(canChange({ uid: "", me: "502" }), false);
  assert.equal(canChange({ uid: "501", me: "" }), false);
});

const nul = (...f) => f.map((x) => `${x}\0`).join("");

test("parseProbe: type, mode, owner, group and own uid", () => {
  const p = parseProbe(nul("f", "0644", "501", "20", "alice", "staff", "501"));
  assert.deepEqual(p, { type: "f", mode: 0o644, uid: "501", gid: "20", user: "alice", group: "staff", me: "501", isDir: false, isLink: false, owned: true });
  const d = parseProbe(nul("d", "2775", "0", "0", "root", "wheel", "501"));
  assert.equal(d.isDir, true);
  assert.equal(d.mode, 0o2775);
  assert.equal(d.owned, false);
  assert.equal(parseProbe(nul("l", "0777", "1", "1", "", "", "1")).isLink, true);
  assert.equal(parseProbe("garbage"), null);
  assert.equal(parseProbe(""), null);
  assert.equal(parseProbe(nul("f", "9999", "1", "1", "a", "b", "1")), null);
});

test("parseProbe: names fall back to the numeric ids", () => {
  const p = parseProbe(nul("f", "0600", "1234", "5678", "", "", "1234"));
  assert.equal(p.user, "1234");
  assert.equal(p.group, "5678");
});

test("parseCount and parseModeOut", () => {
  assert.equal(parseCount("   42\n"), 42);
  assert.equal(parseCount("0\n"), 0);
  assert.equal(parseCount("x"), null);
  assert.equal(parseCount(""), null);
  assert.equal(parseModeOut("2755\n"), 0o2755);
  assert.equal(parseModeOut("0644"), 0o644);
  assert.equal(parseModeOut("nope"), null);
});

test("mismatchText: names the requested and the real mode", () => {
  assert.equal(mismatchText("a.txt", 0o2755, 0o755), "a.txt: asked for 2755, the system set 755");
  assert.match(mismatchText("a.txt", 0o644, null), /could not be read back/);
});
