// Files that are not text: the extension list that skips the read, and the reasons the viewer shows when a file
// cannot be shown as text (issues #32, #33). Pure; lib/readfile.js reads a file and picks the reason.
// No Buffer, TextDecoder or Intl here: the QuickJS runtime has none of them.

import { extOf } from "./langs.js";
import { formatBytes } from "./sizes.js";

export const BINARY_MESSAGE = "Binary file · no text preview";
export const UNREADABLE_MESSAGE = "Cannot read this file";
export const UTF16_MESSAGE = "UTF-16 file · use Open or Edit in Terminal";

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
