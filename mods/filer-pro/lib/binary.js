// Files that are not text: the extension list that skips the read, and the reasons the viewer shows when a file
// cannot be shown as text (issues #32, #33). Pure except explainUnreadable, which runs one exec.
// No Buffer, TextDecoder or Intl here: the QuickJS runtime has none of them.

import { extOf } from "./langs.js";
import { EDIT_MAX_BYTES, PROBE_SCRIPT, parseProbe, looksUtf16 } from "./textedit.js";
import { SIZE_SCRIPT, parseSize, formatBytes } from "./sizes.js";
import { decodeUtf8 } from "./textcodec.js";

export const BINARY_MESSAGE = "Binary file · no text preview";
export const UNREADABLE_MESSAGE = "Cannot read this file";
const UTF16_MESSAGE = "UTF-16 file · use Open or Edit in Terminal";
const ENCODING_MESSAGE = "Not UTF-8 text (Latin-1 or other encoding) · use Open or Edit in Terminal";

// Archives and Office/ODF documents: a click never reads them as text. Installers and programs (pkg, dmg, exe) are
// deliberately not here; they show their message only after the read.
const BINARY = new Set([
  "zip", "gz", "tgz", "bz2", "tbz2", "xz", "txz", "zst", "7z", "rar", "tar",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
]);

export function isBinaryName(path) {
  return BINARY.has(extOf(path));
}

export const largeMessage = (size) => `File larger than 1 MiB (${formatBytes(size)})`;

// UTF-16 without a BOM that readTextFile accepted (NUL is valid UTF-8): every second character is NUL. A machine's
// text comes back with replacement characters for a BOM, so those two are skipped.
export function looksUtf16Text(text) {
  let s = text.startsWith("��") ? text.slice(2) : text;
  const n = Math.min(s.length, 512) & ~1;
  if (n < 2) return false;
  let evenZero = true, oddZero = true, evenAny = false, oddAny = false;
  for (let i = 0; i < n; i += 2) {
    if (s.charCodeAt(i) !== 0) { evenZero = false; evenAny = true; }
    if (s.charCodeAt(i + 1) !== 0) { oddZero = false; oddAny = true; }
  }
  return (oddZero && evenAny) || (evenZero && oddAny);
}

// The reason for a file that readTextFile gave back with NUL characters: UTF-16 text, else binary.
export function nulReason(text) {
  return looksUtf16Text(text) ? { message: UTF16_MESSAGE, binary: false } : { message: BINARY_MESSAGE, binary: true };
}

// parseProbe result -> { message, binary } for a file that readTextFile refused. First matching reason wins.
export function probeReason(p) {
  if (p.kind === "missing") return { message: "This file is no longer available", binary: false };
  if (p.kind === "dir" || p.kind === "special") return { message: "Not a regular file", binary: false };
  if (p.kind !== "file") return { message: UNREADABLE_MESSAGE, binary: false };
  if (p.size > EDIT_MAX_BYTES) return { message: largeMessage(p.size), binary: false };
  const b = p.bytes;
  if (!b) return { message: UNREADABLE_MESSAGE, binary: false };
  if (looksUtf16(b)) return { message: UTF16_MESSAGE, binary: false };
  if (b.includes(0)) return { message: BINARY_MESSAGE, binary: true };
  if (decodeUtf8(b) === null) return { message: ENCODING_MESSAGE, binary: false };
  return { message: UNREADABLE_MESSAGE, binary: false };
}

// Why did readTextFile reject this file? One exec, only after the read failed (never before a read): size and the
// first bytes from PROBE_SCRIPT, locally or on the machine. A link is not followed by the probe, so its size comes
// from SIZE_SCRIPT (which follows it). -> { message, binary }, never rejects.
export async function explainUnreadable({ exec, on = null, path }) {
  const generic = { message: UNREADABLE_MESSAGE, binary: false };
  try {
    const r = await exec("sh", ["-c", PROBE_SCRIPT, "probe", path], { on });
    if (r?.code !== 0) return generic;
    const p = parseProbe(r.stdout);
    if (p.kind !== "link") return probeReason(p);
    const s = await exec("sh", ["-c", SIZE_SCRIPT, "size", path], { on });
    const size = s?.code === 0 ? parseSize(s.stdout) : null;
    return size !== null && size > EDIT_MAX_BYTES ? { message: largeMessage(size), binary: false } : generic;
  } catch {
    return generic;
  }
}
