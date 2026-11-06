import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  bytesToBase64,
  base64ToBytes,
  decodeUtf8,
  encodeUtf8,
  sha256Hex,
  sha256HexSliced,
  SHA_SLICE,
  bytesToBinary,
  binaryToBytes,
  equalBytes,
} from "../mods/filer-pro/lib/textcodec.js";

// Deterministic PRNG (mulberry32) so failures are reproducible.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBytes(rnd, n) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.floor(rnd() * 256);
  return b;
}

function randomString(rnd, n) {
  // Mix of ASCII, 2, 3 and 4 byte code points; never a lone surrogate.
  let s = "";
  for (let i = 0; i < n; i++) {
    const k = rnd();
    let cp;
    if (k < 0.4) cp = Math.floor(rnd() * 0x80);
    else if (k < 0.6) cp = 0x80 + Math.floor(rnd() * 0x780);
    else if (k < 0.85) {
      cp = 0x800 + Math.floor(rnd() * 0xf800);
      if (cp >= 0xd800 && cp <= 0xdfff) cp = 0x4e00;
    } else cp = 0x10000 + Math.floor(rnd() * 0x100000);
    s += String.fromCodePoint(cp);
  }
  return s;
}

const u8 = (...a) => Uint8Array.from(a);

test("bytesToBase64: padding cases and empty", () => {
  assert.equal(bytesToBase64(u8()), "");
  assert.equal(bytesToBase64(u8(0x66)), "Zg==");
  assert.equal(bytesToBase64(u8(0x66, 0x6f)), "Zm8=");
  assert.equal(bytesToBase64(u8(0x66, 0x6f, 0x6f)), "Zm9v");
  assert.equal(bytesToBase64(u8(0xff, 0xfe, 0xfd)), "//79");
  assert.equal(bytesToBase64(u8(0xfb, 0xef)), "++8=");
});

test("base64 round trip against Buffer on seeded random data", () => {
  const rnd = prng(1234);
  for (let n = 0; n < 200; n++) {
    const b = randomBytes(rnd, n);
    const expected = Buffer.from(b).toString("base64");
    assert.equal(bytesToBase64(b), expected);
    assert.deepEqual(Array.from(base64ToBytes(expected)), Array.from(b));
  }
});

test("base64ToBytes: empty and whitespace", () => {
  const e = base64ToBytes("");
  assert.ok(e instanceof Uint8Array);
  assert.equal(e.length, 0);
  assert.equal(base64ToBytes(" \t\r\n").length, 0);
  assert.deepEqual(Array.from(base64ToBytes("Zm9v\r\nYmFy\n")), [0x66, 0x6f, 0x6f, 0x62, 0x61, 0x72]);
  assert.deepEqual(Array.from(base64ToBytes(" Z m 8 = ")), [0x66, 0x6f]);
});

test("base64ToBytes: invalid input returns null", () => {
  for (const bad of [
    "Zm9v!", // bad char
    "Zm-v", // url-safe alphabet not accepted
    "Zm_v",
    "Zm9", // length not multiple of 4
    "Z",
    "Zg=", // padding short
    "Zg===", // too long
    "Z===", // more than 2 '='
    "====",
    "=Zg=", // padding not at end
    "Zg==Zm9v", // padding in the middle
    "Z=g=",
    "Zm9vé", // non-ASCII
    "Zm9v\u000b", // vertical tab is not whitespace here
    "Zm9v ",
  ]) {
    assert.equal(base64ToBytes(bad), null, JSON.stringify(bad));
  }
});

test("decodeUtf8: valid sequences of 1 to 4 bytes", () => {
  assert.equal(decodeUtf8(u8()), "");
  assert.equal(decodeUtf8(u8(0x41)), "A");
  assert.equal(decodeUtf8(u8(0x00)), "\u0000");
  assert.equal(decodeUtf8(u8(0x7f)), "\u007f");
  assert.equal(decodeUtf8(u8(0xc2, 0x80)), "\u0080");
  assert.equal(decodeUtf8(u8(0xdf, 0xbf)), "߿");
  assert.equal(decodeUtf8(u8(0xe0, 0xa0, 0x80)), "ࠀ");
  assert.equal(decodeUtf8(u8(0xed, 0x9f, 0xbf)), "퟿");
  assert.equal(decodeUtf8(u8(0xee, 0x80, 0x80)), "");
  assert.equal(decodeUtf8(u8(0xef, 0xbf, 0xbf)), "￿");
  assert.equal(decodeUtf8(u8(0xf0, 0x90, 0x80, 0x80)), "\u{10000}");
  assert.equal(decodeUtf8(u8(0xf4, 0x8f, 0xbf, 0xbf)), "\u{10ffff}");
  assert.equal(decodeUtf8(u8(0x68, 0xc3, 0xa4, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80)), "hä€\u{1f600}");
});

test("decodeUtf8: invalid sequences return null", () => {
  const bad = {
    "C0 overlong": [0xc0, 0x80],
    "C1 overlong": [0xc1, 0xbf],
    "E0 overlong": [0xe0, 0x9f, 0xbf],
    "E0 80 80 overlong": [0xe0, 0x80, 0x80],
    "F0 overlong": [0xf0, 0x8f, 0xbf, 0xbf],
    "surrogate ED A0 80": [0xed, 0xa0, 0x80],
    "surrogate ED BF BF": [0xed, 0xbf, 0xbf],
    "above 10FFFF F4 90": [0xf4, 0x90, 0x80, 0x80],
    "F5": [0xf5, 0x80, 0x80, 0x80],
    "F8": [0xf8, 0x88, 0x80, 0x80, 0x80],
    "FF": [0xff],
    "FE": [0xfe],
    "lone continuation 80": [0x80],
    "lone continuation BF": [0xbf],
    "continuation after ASCII": [0x41, 0x80],
    "truncated 2": [0xc3],
    "truncated 3 after 1": [0xe2, 0x82],
    "truncated 3 after 0": [0xe2],
    "truncated 4 after 2": [0xf0, 0x9f, 0x98],
    "truncated 4 after 0": [0xf0],
    "bad continuation in 2": [0xc3, 0x41],
    "bad continuation in 3": [0xe2, 0x82, 0x41],
    "bad continuation in 4": [0xf0, 0x9f, 0x98, 0x41],
    "lead followed by lead": [0xe2, 0xe2, 0x82],
  };
  for (const [name, bytes] of Object.entries(bad)) {
    assert.equal(decodeUtf8(Uint8Array.from(bytes)), null, name);
  }
});

test("decodeUtf8 agrees with a fatal TextDecoder on seeded random bytes", () => {
  const rnd = prng(99);
  const dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  for (let n = 0; n < 3000; n++) {
    const b = randomBytes(rnd, Math.floor(rnd() * 8));
    // Bias towards interesting bytes so valid sequences also appear.
    for (let i = 0; i < b.length; i++) if (rnd() < 0.5) b[i] = [0xc2, 0xe0, 0xed, 0xf0, 0xf4, 0x80, 0x9f, 0xa0, 0x8f, 0x90, 0xbf][Math.floor(rnd() * 11)];
    let expected;
    try {
      expected = dec.decode(b);
    } catch {
      expected = null;
    }
    assert.equal(decodeUtf8(b), expected, Buffer.from(b).toString("hex"));
  }
});

test("utf8 round trip against Buffer on seeded random strings", () => {
  const rnd = prng(7);
  for (let n = 0; n < 200; n++) {
    const s = randomString(rnd, n);
    const bytes = encodeUtf8(s);
    assert.deepEqual(Array.from(bytes), Array.from(Buffer.from(s, "utf8")));
    assert.equal(decodeUtf8(bytes), s);
    assert.equal(decodeUtf8(new Uint8Array(Buffer.from(s, "utf8"))), s);
  }
});

test("BOM is preserved on decode and encode", () => {
  const s = decodeUtf8(u8(0xef, 0xbb, 0xbf, 0x41));
  assert.equal(s, "﻿A");
  assert.deepEqual(Array.from(encodeUtf8(s)), [0xef, 0xbb, 0xbf, 0x41]);
});

test("encodeUtf8: edge code points and surrogate pairs", () => {
  assert.equal(encodeUtf8("").length, 0);
  assert.deepEqual(Array.from(encodeUtf8("\u0000")), [0]);
  assert.deepEqual(Array.from(encodeUtf8("\u007f")), [0x7f]);
  assert.deepEqual(Array.from(encodeUtf8("\u0080")), [0xc2, 0x80]);
  assert.deepEqual(Array.from(encodeUtf8("߿")), [0xdf, 0xbf]);
  assert.deepEqual(Array.from(encodeUtf8("ࠀ")), [0xe0, 0xa0, 0x80]);
  assert.deepEqual(Array.from(encodeUtf8("￿")), [0xef, 0xbf, 0xbf]);
  assert.deepEqual(Array.from(encodeUtf8("\u{10000}")), [0xf0, 0x90, 0x80, 0x80]);
  assert.deepEqual(Array.from(encodeUtf8("\u{10ffff}")), [0xf4, 0x8f, 0xbf, 0xbf]);
  assert.deepEqual(Array.from(encodeUtf8("😀")), [0xf0, 0x9f, 0x98, 0x80]);
});

test("encodeUtf8: lone surrogates return null", () => {
  assert.equal(encodeUtf8("\ud800"), null);
  assert.equal(encodeUtf8("\udbff"), null);
  assert.equal(encodeUtf8("\udc00"), null);
  assert.equal(encodeUtf8("\udfff"), null);
  assert.equal(encodeUtf8("a\ud800"), null);
  assert.equal(encodeUtf8("\ud800a"), null);
  assert.equal(encodeUtf8("\udc00\ud800"), null); // reversed pair
  assert.equal(encodeUtf8("\ud800𐀀"), null);
  assert.equal(encodeUtf8("x\udc00y"), null);
});

const sha = (b) => createHash("sha256").update(b).digest("hex");
const enc = (s) => new Uint8Array(Buffer.from(s, "latin1"));

test("sha256Hex: NIST vectors", () => {
  assert.equal(sha256Hex(u8()), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex(enc("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(
    sha256Hex(enc("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
  assert.equal(
    sha256Hex(enc("abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu")),
    "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1",
  );
});

test("sha256Hex: padding boundary lengths match node:crypto", () => {
  const rnd = prng(55);
  for (const n of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129]) {
    const b = randomBytes(rnd, n);
    assert.equal(sha256Hex(b), sha(b), `length ${n}`);
  }
  for (const n of [55, 56, 63, 64, 65]) {
    const b = new Uint8Array(n).fill(0x61);
    assert.equal(sha256Hex(b), sha(b), `a x ${n}`);
  }
});

test("sha256Hex: works on a subarray view", () => {
  const rnd = prng(3);
  const big = randomBytes(rnd, 200);
  const view = big.subarray(13, 150);
  assert.equal(sha256Hex(view), sha(view));
});

test("1 MiB input: base64, utf8 and sha256 are correct and fast", () => {
  const rnd = prng(2024);
  const n = 1024 * 1024;
  const text = randomString(rnd, 300000);
  const bytes = encodeUtf8(text);
  assert.ok(bytes.length > 300000);
  assert.equal(decodeUtf8(bytes), text);

  const big = new Uint8Array(n);
  for (let i = 0; i < n; i++) big[i] = i % 128 === 0 ? 0xc3 : 0x41; // c3 41 is invalid
  big[1] = 0x80;
  const t0 = Date.now();
  const b64 = bytesToBase64(big);
  assert.equal(b64, Buffer.from(big).toString("base64"));
  assert.deepEqual(base64ToBytes(b64), big);
  assert.equal(sha256Hex(big), sha(big));
  const ascii = new Uint8Array(n).fill(0x61);
  ascii[n - 2] = 0xc3; // lead byte with its continuation cut off at the end
  assert.equal(decodeUtf8(ascii), null);
  ascii[n - 2] = 0x61;
  assert.equal(decodeUtf8(ascii), "a".repeat(n));
  assert.ok(Date.now() - t0 < 5000);
});

// herdr's QuickJS interrupts a job after about 0.5 s; the codecs therefore run natively (atob, btoa, escape, unescape,
// URI functions). Without those globals they fall back to the JS loops, which must give the same results.
function withoutNatives(fn) {
  const names = ["atob", "btoa", "escape", "unescape"];
  const saved = names.map((n) => Object.getOwnPropertyDescriptor(globalThis, n));
  const from = Object.getOwnPropertyDescriptor(Uint8Array, "fromBase64");
  const to = Object.getOwnPropertyDescriptor(Uint8Array.prototype, "toBase64");
  for (const n of names) delete globalThis[n];
  delete Uint8Array.fromBase64;
  delete Uint8Array.prototype.toBase64;
  try {
    assert.equal(typeof escape + typeof atob + typeof Uint8Array.fromBase64, "undefinedundefinedundefined");
    return fn();
  } finally {
    names.forEach((n, i) => Object.defineProperty(globalThis, n, saved[i]));
    if (from) Object.defineProperty(Uint8Array, "fromBase64", from);
    if (to) Object.defineProperty(Uint8Array.prototype, "toBase64", to);
  }
}

test("equalBytes compares content, with and without the native route", () => {
  const rnd = prng(12);
  const a = randomBytes(rnd, 5000);
  const b = a.slice();
  for (const run of [(f) => f(), withoutNatives]) {
    run(() => {
      assert.equal(equalBytes(a, b), true);
      assert.equal(equalBytes(u8(), u8()), true);
      b[4999] ^= 1;
      assert.equal(equalBytes(a, b), false);
      b[4999] ^= 1;
      assert.equal(equalBytes(a, b.subarray(1)), false);
      assert.equal(equalBytes(a, null), false);
    });
  }
});

test("codecs give the same results with and without the native routes", () => {
  const rnd = prng(77);
  const samples = [u8(), u8(0x41), u8(0xc3, 0xa4), u8(0xc0, 0x80), u8(0xed, 0xa0, 0x80), u8(0xf4, 0x90, 0x80, 0x80), u8(0xe2, 0x82)];
  for (let i = 0; i < 300; i++) samples.push(randomBytes(rnd, Math.floor(rnd() * 40)));
  for (let i = 0; i < 100; i++) samples.push(new Uint8Array(Buffer.from(randomString(rnd, 30), "utf8")));
  const run = () => samples.map((b) => {
    const b64 = bytesToBase64(b);
    const text = decodeUtf8(b);
    return { b64, back: Array.from(base64ToBytes(b64)), text, enc: text === null ? null : Array.from(encodeUtf8(text)) };
  });
  const native = run();
  const loops = withoutNatives(run);
  assert.deepEqual(native, loops);
  for (const s of ["\ud800", "a\udc00b", "ok ä € 😀"]) {
    assert.deepEqual(encodeUtf8(s) && Array.from(encodeUtf8(s)), withoutNatives(() => encodeUtf8(s) && Array.from(encodeUtf8(s))), JSON.stringify(s));
  }
  for (const bad of ["Zm9v!", "Zm9", "Zg===", "=Zg=", "Zm9v\u00a0", "Zm9v\u000b"]) {
    assert.equal(withoutNatives(() => base64ToBytes(bad)), null, JSON.stringify(bad));
    assert.equal(base64ToBytes(bad), null, JSON.stringify(bad));
  }
});

test("bytesToBinary and binaryToBytes round-trip all 256 byte values and long input", () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.equal(bytesToBinary(all).length, 256);
  assert.deepEqual(binaryToBytes(bytesToBinary(all)), all);
  const big = randomBytes(prng(9), 70000); // more than one slice of String.fromCharCode.apply
  assert.deepEqual(binaryToBytes(bytesToBinary(big)), big);
});

test("sha256HexSliced: same hash as sha256Hex, pause between the slices only", async () => {
  const rnd = prng(31);
  for (const n of [0, 1, 63, 64, 65, 200, 1000]) {
    const b = randomBytes(rnd, n);
    let pauses = 0;
    assert.equal(await sha256HexSliced(b, async () => { pauses++; }, 64), sha(b), `length ${n}`);
    assert.equal(pauses, Math.max(0, Math.floor(n / 64) - 1), `pauses for ${n}`);
  }
  const mib = randomBytes(rnd, 1048576);
  let pauses = 0;
  assert.equal(await sha256HexSliced(mib, async () => { pauses++; }), sha(mib));
  assert.equal(pauses, 1048576 / SHA_SLICE - 1);
});
