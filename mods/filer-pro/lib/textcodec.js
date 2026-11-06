// Pure codecs for the text editor: base64, strict UTF-8 and SHA-256 over Uint8Array.
// No Buffer, TextDecoder, TextEncoder or crypto: the QuickJS runtime has none of them. It has Uint8Array.fromBase64 and
// toBase64, atob, btoa, escape, unescape and the URI functions, which run natively: herdr interrupts a job after about
// 0.5 s (an error JS cannot catch), and a per-byte JS loop over 1 MiB takes most of that there. So each codec takes the
// native route when the runtime has it and keeps the plain JS loop only as a fallback.
const hasB64 = () => typeof Uint8Array.fromBase64 === "function" && typeof Uint8Array.prototype.toBase64 === "function";

const CHUNK = 8192;
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = new Int8Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64_INDEX[B64.charCodeAt(i)] = i;

// Uint8Array -> string with one char (0..255) per byte, in slices (apply has an argument limit).
export function bytesToBinary(bytes) {
  const parts = [];
  for (let i = 0; i < bytes.length; i += CHUNK) parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
  return parts.join("");
}

// The reverse of bytesToBinary (callers pass binary strings only: chars 0..255).
export function binaryToBytes(bin) {
  if (hasB64() && typeof btoa === "function") return Uint8Array.fromBase64(btoa(bin));
  const n = bin.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes) {
  if (hasB64()) return bytes.toBase64();
  if (typeof btoa === "function") return btoa(bytesToBinary(bytes));
  return bytesToBase64Loop(bytes);
}

function bytesToBase64Loop(bytes) {
  const n = bytes.length;
  const parts = [];
  let chunk = "";
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    chunk += B64[v >> 18] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = "";
    }
  }
  if (n - i === 1) {
    const v = bytes[i] << 16;
    chunk += B64[v >> 18] + B64[(v >> 12) & 63] + "==";
  } else if (n - i === 2) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8);
    chunk += B64[v >> 18] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + "=";
  }
  parts.push(chunk);
  return parts.join("");
}

const B64_STRICT = /^[A-Za-z0-9+/]*={0,2}$/;

// Returns null on any invalid input. ASCII whitespace is ignored.
export function base64ToBytes(text) {
  if (typeof atob !== "function") return base64ToBytesLoop(text);
  // The same rules as the loop below, checked natively: standard alphabet, padding only at the end, length % 4 == 0.
  const raw = String(text);
  const clean = /[ \t\n\r]/.test(raw) ? raw.replace(/[ \t\n\r]+/g, "") : raw; // the probe sends none: no copy
  if (clean.length % 4 !== 0 || !B64_STRICT.test(clean)) return null;
  try {
    return hasB64() ? Uint8Array.fromBase64(clean) : binaryToBytes(atob(clean));
  } catch {
    return null;
  }
}

// Byte arrays with the same content (natively compared as base64 when possible).
export function equalBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  if (hasB64()) return a.toBase64() === b.toBase64();
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function base64ToBytesLoop(text) {
  const s = String(text);
  const vals = [];
  let pad = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) continue;
    if (c === 61) {
      if (++pad > 2) return null;
      continue;
    }
    if (pad > 0 || c >= 128) return null;
    const v = B64_INDEX[c];
    if (v < 0) return null;
    vals.push(v);
  }
  if ((vals.length + pad) % 4 !== 0) return null;
  // Padding must match the number of leftover sextets.
  const rest = vals.length % 4;
  if (rest === 1 || (rest === 0 ? pad !== 0 : pad !== 4 - rest)) return null;
  const outLen = (vals.length >> 2) * 3 + (rest === 0 ? 0 : rest - 1);
  const out = new Uint8Array(outLen);
  let o = 0;
  let i = 0;
  for (; i + 3 < vals.length; i += 4) {
    const v = (vals[i] << 18) | (vals[i + 1] << 12) | (vals[i + 2] << 6) | vals[i + 3];
    out[o++] = v >> 16;
    out[o++] = (v >> 8) & 255;
    out[o++] = v & 255;
  }
  if (rest === 2) {
    out[o++] = (vals[i] << 2) | (vals[i + 1] >> 4);
  } else if (rest === 3) {
    out[o++] = (vals[i] << 2) | (vals[i + 1] >> 4);
    out[o++] = ((vals[i + 1] & 15) << 4) | (vals[i + 2] >> 2);
  }
  return out;
}

// Strict decoder: null for overlongs, surrogates, > U+10FFFF, stray or missing continuation bytes.
// A leading BOM is kept as U+FEFF. Natively: escape() turns every byte >= 0x80 into %XX and decodeURIComponent decodes
// them as UTF-8, throwing a URIError on exactly the sequences above (ECMA-262 Decode).
export function decodeUtf8(bytes) {
  if (typeof escape !== "function") return decodeUtf8Loop(bytes);
  try {
    return decodeURIComponent(escape(bytesToBinary(bytes)));
  } catch {
    return null;
  }
}

function decodeUtf8Loop(bytes) {
  const n = bytes.length;
  const parts = [];
  let units = [];
  let i = 0;
  while (i < n) {
    const b = bytes[i];
    let cp;
    if (b < 0x80) {
      cp = b;
      i++;
    } else if (b >= 0xc2 && b <= 0xdf) {
      if (i + 1 >= n) return null;
      const b1 = bytes[i + 1];
      if ((b1 & 0xc0) !== 0x80) return null;
      cp = ((b & 0x1f) << 6) | (b1 & 0x3f);
      i += 2;
    } else if (b >= 0xe0 && b <= 0xef) {
      if (i + 2 >= n) return null;
      const b1 = bytes[i + 1];
      const b2 = bytes[i + 2];
      if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80) return null;
      if (b === 0xe0 && b1 < 0xa0) return null;
      if (b === 0xed && b1 >= 0xa0) return null;
      cp = ((b & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
      i += 3;
    } else if (b >= 0xf0 && b <= 0xf4) {
      if (i + 3 >= n) return null;
      const b1 = bytes[i + 1];
      const b2 = bytes[i + 2];
      const b3 = bytes[i + 3];
      if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80 || (b3 & 0xc0) !== 0x80) return null;
      if (b === 0xf0 && b1 < 0x90) return null;
      if (b === 0xf4 && b1 >= 0x90) return null;
      cp = ((b & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
      i += 4;
    } else {
      return null;
    }
    if (cp >= 0x10000) {
      cp -= 0x10000;
      units.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      units.push(cp);
    }
    if (units.length >= CHUNK) {
      parts.push(String.fromCharCode.apply(null, units));
      units = [];
    }
  }
  if (units.length > 0) parts.push(String.fromCharCode.apply(null, units));
  return parts.join("");
}

// Null when the string holds an unpaired surrogate (encodeURIComponent throws a URIError for one).
export function encodeUtf8(text) {
  if (typeof unescape !== "function") return encodeUtf8Loop(text);
  let bin;
  try {
    bin = unescape(encodeURIComponent(String(text)));
  } catch {
    return null;
  }
  return binaryToBytes(bin);
}

function encodeUtf8Loop(text) {
  const s = String(text);
  const n = s.length;
  // First pass sizes the output and validates surrogates.
  let size = 0;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) size += 1;
    else if (c < 0x800) size += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < n ? s.charCodeAt(i + 1) : 0;
      if (d < 0xdc00 || d > 0xdfff) return null;
      i++;
      size += 4;
    } else if (c >= 0xdc00 && c <= 0xdfff) return null;
    else size += 3;
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (let i = 0; i < n; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) {
      out[o++] = c;
    } else if (c < 0x800) {
      out[o++] = 0xc0 | (c >> 6);
      out[o++] = 0x80 | (c & 63);
    } else if (c >= 0xd800 && c <= 0xdbff) {
      c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00);
      out[o++] = 0xf0 | (c >> 18);
      out[o++] = 0x80 | ((c >> 12) & 63);
      out[o++] = 0x80 | ((c >> 6) & 63);
      out[o++] = 0x80 | (c & 63);
    } else {
      out[o++] = 0xe0 | (c >> 12);
      out[o++] = 0x80 | ((c >> 6) & 63);
      out[o++] = 0x80 | (c & 63);
    }
  }
  return out;
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

// The hash over bytes in steps: step(from, to) hashes the full 64-byte blocks in [from, to) (multiples of 64, up to
// full), finish() the padded tail and returns the hex.
function sha256State(bytes) {
  const len = bytes.length;
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  const total = (((len + 8) >> 6) + 1) << 6; // data + 0x80 + 8 length bytes, rounded to 64
  const tail = new Uint8Array(total - (len & ~63));
  tail.set(bytes.subarray(len & ~63));
  tail[len & 63] = 0x80;
  const bits = len * 8;
  const t = tail.length;
  tail[t - 4] = (bits >>> 24) & 255;
  tail[t - 3] = (bits >>> 16) & 255;
  tail[t - 2] = (bits >>> 8) & 255;
  tail[t - 1] = bits & 255;
  tail[t - 5] = Math.floor(bits / 4294967296) & 255;
  tail[t - 6] = (Math.floor(bits / 4294967296) >>> 8) & 255;
  tail[t - 7] = (Math.floor(bits / 4294967296) >>> 16) & 255;
  tail[t - 8] = (Math.floor(bits / 4294967296) >>> 24) & 255;

  const block = (src, off) => {
    for (let i = 0; i < 16; i++, off += 4) {
      w[i] = ((src[off] << 24) | (src[off + 1] << 16) | (src[off + 2] << 8) | src[off + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15];
      const b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  };

  return {
    full: len & ~63,
    step(from, to) {
      for (let off = from; off < to; off += 64) block(bytes, off);
    },
    finish() {
      for (let off = 0; off < tail.length; off += 64) block(tail, off);
      let hex = "";
      for (let i = 0; i < 8; i++) hex += (h[i] + 0x100000000).toString(16).slice(1);
      return hex;
    },
  };
}

export function sha256Hex(bytes) {
  const s = sha256State(bytes);
  s.step(0, s.full);
  return s.finish();
}

// 64 KiB: about 0.05 s of hashing in herdr's QuickJS (1 MiB in one go takes about 0.9 s, past the job limit).
export const SHA_SLICE = 65536;

// sha256Hex in slices of SHA_SLICE bytes with `await pause()` between them. herdr only resets its per-job time limit
// for a new job: pause must wait for a timer (cx.timer.after), an awaited resolved promise is not enough.
export async function sha256HexSliced(bytes, pause, slice = SHA_SLICE) {
  const s = sha256State(bytes);
  for (let off = 0; off < s.full; off += slice) {
    if (off > 0) await pause();
    s.step(off, Math.min(off + slice, s.full));
  }
  return s.finish();
}
