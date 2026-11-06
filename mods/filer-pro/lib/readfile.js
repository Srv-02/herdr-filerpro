// The read of a text file to show, in one bounded exec (issue #39): READ_SCRIPT gives kind, size and, up to 1 MiB, the
// bytes, locally or on a machine. The same bytes decide Edit (checkEditable), so a machine is asked once per click
// instead of a cat (herdr's readTextFile) plus the edit probe. Pure except readFileGuarded, which runs that one exec.
// No Buffer, TextDecoder or Intl here: the QuickJS runtime has none of them.

import { EDIT_MAX_BYTES, READ_SCRIPT, parseRead, checkEditable, looksUtf16, CHECK_FAILED, CHECK_TIMEOUT_MS } from "./textedit.js";
import { BINARY_MESSAGE, UNREADABLE_MESSAGE, UTF16_MESSAGE, largeMessage } from "./binary.js";
import { decodeUtf8, decodeUtf8Lossy } from "./textcodec.js";
import { explainError } from "./errors.js";

export const GONE_MESSAGE = "This file is no longer available";
export const NO_READ_MESSAGE = "No read permission · cannot show this file";
const NOT_FILE_MESSAGE = "Not a regular file";

const fail = (message, binary = false) => ({ ok: false, message, binary });

// The exec result of READ_SCRIPT -> { ok: true, text, lossy, edit } | { ok: false, message, binary }.
// text: the file as a string (CRLF kept, as readTextFile gives it); lossy: not UTF-8, shown with U+FFFD; edit: the
// result of checkEditable for the same bytes (a link is shown, never edited). binary: the message is the binary one.
// opts.defer: a file that is not UTF-8 comes back as { ok: true, text: null, lossy: true, bytes, edit } and the caller
// decodes the bytes in slices (readFileGuarded), since a lossy decode of 1 MiB does not fit one QuickJS job.
export function readResult(res, { maxChars = Infinity, on = null, localPlatform, defer = false } = {}) {
  const stderr = String(res?.stderr ?? "").trim();
  const why = () => (stderr ? `${UNREADABLE_MESSAGE}: ${explainError(stderr, on, UNREADABLE_MESSAGE, { localPlatform })}` : UNREADABLE_MESSAGE);
  if (!res || res.code !== 0) return fail(why());
  const r = parseRead(res.stdout);
  if (r.kind === "missing") return fail(GONE_MESSAGE);
  if (r.kind === "dir" || r.kind === "special") return fail(NOT_FILE_MESSAGE);
  if (r.kind === "unreadable") return fail(NO_READ_MESSAGE);
  if (r.kind !== "file") return fail(UNREADABLE_MESSAGE);
  const b = r.bytes;
  if (r.size > EDIT_MAX_BYTES || (b && b.length > EDIT_MAX_BYTES)) return fail(largeMessage(Math.max(r.size, b?.length ?? 0)));
  if (!b) return fail(UNREADABLE_MESSAGE);
  // The read itself failed (macOS privacy, a root-squashed share): READ_SCRIPT says so on stderr, never an empty text.
  if (/(^|\n)readfail$/.test(stderr)) {
    const rest = stderr.replace(/\n?readfail$/, "").trim();
    return fail(rest ? `${UNREADABLE_MESSAGE}: ${explainError(rest, on, UNREADABLE_MESSAGE, { localPlatform })}` : UNREADABLE_MESSAGE);
  }
  if (looksUtf16(b)) return fail(UTF16_MESSAGE);
  if (b.includes(0)) return fail(BINARY_MESSAGE, true);
  const decoded = decodeUtf8(b);
  const edit = r.link ? { ok: false, reason: "Symbolic link" }
    : checkEditable({ kind: "file", writable: r.writable, mode: r.mode, size: r.size, bytes: b, openDir: r.openDir }, { maxChars, decoded });
  if (decoded === null && defer) return { ok: true, text: null, lossy: true, bytes: b, edit };
  return { ok: true, text: decoded ?? decodeUtf8Lossy(b), lossy: decoded === null, edit };
}

export const LOSSY_SLICE = 65536;

// [start, end) slices of about n bytes that never split a valid UTF-8 sequence: a cut lands before a byte that is no
// continuation byte (at most 3 steps on; a valid sequence has at most 3 continuation bytes).
export function lossySlices(bytes, n = LOSSY_SLICE) {
  const out = [];
  for (let i = 0; i < bytes.length;) {
    let j = Math.min(bytes.length, i + n);
    for (let k = 0; k < 3 && j < bytes.length && (bytes[j] & 0xc0) === 0x80; k++) j++;
    out.push([i, j]);
    i = j;
  }
  return out;
}

// readResult of one READ_SCRIPT exec that always ends: done(result) runs exactly once. Every synchronous part (the
// parse and edit check, then each slice of a lossy decode) runs in its own job with a zero timer armed before it, so
// an interrupt by the runtime (uncatchable) ends as "Could not check this file"; a rejected exec (the machine cannot
// be reached) and no answer within timeoutMs end with their message. The result is delivered from a fresh job, so the
// caller builds its editor with a whole job's budget. So "Loading file…" never stays. after(ms, fn) is cx.timer.after;
// work and decode are replaceable for tests.
export function readFileGuarded({ exec, on = null, path, maxChars, after, timeoutMs = CHECK_TIMEOUT_MS, localPlatform, slice = LOSSY_SLICE, work = readResult, decode = decodeUtf8Lossy }, done) {
  let ended = false;
  const end = (r) => {
    if (ended) return;
    ended = true;
    done(r);
  };
  after(timeoutMs, () => end(fail(`${CHECK_FAILED} (no answer)`)));
  const step = (fn) => {
    let finished = false;
    after(0, () => { if (!finished) end(fail(CHECK_FAILED)); });
    try { return fn(); } catch { end(fail(CHECK_FAILED)); return null; } finally { finished = true; }
  };
  const next = () => new Promise((resolve) => after(0, resolve));
  (async () => {
    let res;
    try {
      res = await exec("sh", ["-c", READ_SCRIPT, "read", path], { on });
    } catch (e) {
      return end(fail(on == null ? UNREADABLE_MESSAGE : `Cannot reach the machine: ${explainError(String(e?.message ?? e), on, UNREADABLE_MESSAGE, { localPlatform })}`));
    }
    let r = step(() => work(res, { maxChars, on, localPlatform, defer: true }));
    if (ended || !r) return;
    if (r.ok && r.text === null) {
      const parts = [];
      for (const [a, b] of lossySlices(r.bytes, slice)) {
        await next();
        if (ended) return;
        const part = step(() => decode(r.bytes.subarray(a, b)));
        if (ended) return;
        parts.push(part);
      }
      r = { ok: true, text: parts.join(""), lossy: true, edit: r.edit };
    }
    await next();
    end(r);
  })();
}
