// Archives that the row menu can extract (#57): which names are archives, the probe scripts that run on the archive's
// side (this computer or a machine), the check of the member list and the messages. Pure, no node imports and no Intl
// (herdr runs the mod on QuickJS-ng). The scripts are POSIX sh and run as `sh -c SCRIPT x <args>` (locally) or through
// ssh with the same text; nothing of an archive name ever lands in a command line.
import { nameKey } from "./names.js";
import { formatBytes } from "./sizes.js";

// Longest suffix first, so "x.tar.gz" is a tar archive and not a gzip file "x.tar". family: tar (one tar, maybe
// compressed), zip, single (one compressed file, no tar inside). need: the helper a tar archive needs ("-" for none);
// for single it is the tool itself.
export const ARCHIVE_TYPES = Object.freeze([
  [".tar.gz", "tar", "gzip"], [".tar.bz2", "tar", "bzip2"], [".tar.xz", "tar", "xz"], [".tar.zst", "tar", "zstd"],
  [".tgz", "tar", "gzip"], [".tbz2", "tar", "bzip2"], [".txz", "tar", "xz"], [".tar", "tar", "-"],
  [".zip", "zip", "-"],
  [".gz", "single", "gzip"], [".bz2", "single", "bzip2"], [".xz", "single", "xz"], [".zst", "single", "zstd"],
].map(([ext, family, need]) => Object.freeze({ ext, family, need })));

// { family, need, stem, ext } for an archive file name, null for anything else (also a name that is only the suffix).
export function archiveOf(name) {
  if (typeof name !== "string") return null;
  const lower = name.toLowerCase();
  for (const t of ARCHIVE_TYPES) {
    if (!lower.endsWith(t.ext)) continue;
    const stem = name.slice(0, name.length - t.ext.length);
    if (stem === "" || stem === "." || stem === "..") return null;
    return { family: t.family, need: t.need, stem, ext: name.slice(name.length - t.ext.length) };
  }
  return null;
}

// Width of one code point in menu units: 2 for CJK, fullwidth forms and emoji (astral), else 1.
function unitsOf(cp) {
  if (cp > 0xffff) return 2;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)) return 2;
  return 1;
}

// Menu label of Extract to: the stem as far as it fits MENU_WIDTH 200 (10 units, or 9 and an ellipsis), cut on code points.
export function extractToLabel(stem) {
  const cps = Array.from(stem);
  const width = (list) => list.reduce((w, c) => w + unitsOf(c.codePointAt(0)), 0);
  let fit = stem;
  if (width(cps) > 10) {
    const head = [];
    let w = 0;
    for (const c of cps) {
      const u = unitsOf(c.codePointAt(0));
      if (w + u > 9) break;
      head.push(c);
      w += u;
    }
    fit = `${head.join("")}…`;
  }
  return `Extract to "${fit}/"`;
}

// Every script below starts with the same line: processes the app starts often have no LANG, and then tar prints
// non-ASCII names as octal escapes or "?" (R2). A UTF-8 locale makes it print the names as they are; parseProbe decodes
// the escapes that remain anyway.
const LOCALE = `L=$(locale -a 2>/dev/null | grep -i -m1 -E '^(C|en_US)\\.utf-?8$'); [ -n "$L" ] && LC_ALL=$L && export LC_ALL`;

// ARCHIVE_PROBE_SCRIPT: picks the tool and lists the members of an archive.
//   sh -c SCRIPT x <family> <need> <archive>
//     family  tar | zip | single (archiveOf().family)
//     need    archiveOf().need: the helper a compressed tar needs (gzip|bzip2|xz|zstd) or "-"; for single the tool itself
//     archive absolute path (a leading "-" is made safe)
//   stdout  `tool=<t>` (tar | bsdtar | unzip | gzip | bzip2 | xz | zstd, the one extract.sh and ARCHIVE_SIZE_SCRIPT
//           get as <tool>), a line `--`, then one member per line (nothing for single). Directory members end in "/".
//           tar/bsdtar print a newline in a name as \n, a backslash as \\ and non-ASCII bytes maybe as \ooo (parseProbe decodes).
//   exit 0  ok
//   exit 3  a tool is missing: stdout `missing=<tool>`
//   exit 4  the listing failed (not an archive, damaged, ...): the tool's messages on stderr
//   Tool choice: tar family -> tar. zip -> unzip when `unzip -Z1` lists it, else bsdtar when present, else missing unzip
//   (no `tar --version` sniffing, R11). single -> its tool. A tar listing that fails while its `need` helper is missing
//   reports the helper (bsdtar reads gzip/bzip2/xz itself, zstd and GNU tar's helpers are external).
export const ARCHIVE_PROBE_SCRIPT = `${LOCALE}
f=$1; n=$2; a=$3
case "$a" in -*) a=./$a;; esac
miss() { printf 'missing=%s\\n' "$1"; exit 3; }
has() { command -v "$1" >/dev/null 2>&1; }
bad() { [ -n "$m" ] && printf '%s\\n' "$m" >&2; exit 4; }
m=
case "$f" in
  single)
    t=$n; has "$t" || miss "$t"
    printf 'tool=%s\\n--\\n' "$t"; exit 0;;
  zip)
    if has unzip && m=$(unzip -Z1 "$a" 2>/dev/null); then t=unzip
    elif has bsdtar; then t=bsdtar; m=$(bsdtar -tf "$a") || bad
    elif has unzip; then m=$(unzip -Z1 "$a" 2>&1); bad
    else miss unzip; fi;;
  *)
    t=tar; has tar || miss tar
    if ! m=$(tar -tf "$a"); then
      [ "$n" != - ] && ! has "$n" && miss "$n"
      bad
    fi;;
esac
printf 'tool=%s\\n--\\n%s\\n' "$t" "$m"
`;

// ARCHIVE_SIZE_SCRIPT: how much room the extracted files need and how much the target folder has (R4). A separate exec
// from the probe (timeout 120000 ms): unpacking to count bytes can take long on a big archive.
//   sh -c SCRIPT x <tool> <archive> <dest_dir>
//     tool      the one parseProbe returned
//     archive   absolute path
//     dest_dir  the folder the files go to (must exist)
//   stdout  `size=<bytes>` (empty when unknown: sum of the regular file sizes, measured with \`<tool> -xOf | wc -c\`,
//           \`unzip -l\` for zip, \`<tool> -dc | wc -c\` for single), then the lines of \`df -Pk <dest_dir>\` each prefixed
//           \`df=\`. Always exit 0.
export const ARCHIVE_SIZE_SCRIPT = `t=$1; a=$2; d=$3
case "$a" in -*) a=./$a;; esac
s=
# cnt <cmd>...: the bytes the command prints on stdout into $s, left empty when the command fails (pipeline status via fd 3)
cnt() {
  r=$( { { "$@" 2>/dev/null; echo "rc=$?" >&3; } | wc -c | sed 's/^/n=/'; } 3>&1 )
  case "$r" in *rc=0*) s=$(printf '%s\n' "$r" | sed -n 's/^n=//p');; esac
}
case "$t" in
  unzip) s=$(unzip -l "$a" 2>/dev/null | tail -n 1 | awk '{print $1}');;
  tar|bsdtar) cnt "$t" -xOf "$a";;
  gzip|bzip2|xz|zstd) cnt "$t" -dc < "$a";;
esac
s=$(printf '%s' "$s" | tr -d ' \t\n')
case "$s" in ''|*[!0-9]*) s=;; esac
printf 'size=%s\\n' "$s"
df -Pk "$d" 2>/dev/null | sed 's/^/df=/'
exit 0
`;

// EXTRACT_STOP_SCRIPT: ends an extract job's side process and removes its temp folder (jobs.js removeTemp, local or
// through ssh). The side shell of extract.sh writes its pid to <temp>/pid and has the id in its arguments (\`fs-<id>\`).
//   sh -c SCRIPT x <temp> <id>
//   Kills the pid only when \`ps -p <pid> -o args=\` contains \`fs-<id>\` (a reused pid is left alone), waits up to 5 s for it
//   to end (its trap removes the extractor), then \`rm -rf -- <temp>\`. Always exit 0.
export const EXTRACT_STOP_SCRIPT = `[ -n "$1" ] && [ -n "$2" ] || exit 1
p=$(cat -- "$1/pid" 2>/dev/null)
case "$p" in ''|*[!0-9]*) ;; *)
  a=$(ps -p "$p" -o args= 2>/dev/null)
  case "$a" in *" fs-$2 "*|*" fs-$2") kill "$p" 2>/dev/null
    i=0; while [ "$i" -lt 5 ] && kill -0 "$p" 2>/dev/null; do sleep 1; i=$((i+1)); done;; esac;;
esac
rm -rf -- "$1"
exit 0
`;

// ---- parsing ----

// Bytes -> string, strictly UTF-8 (no TextDecoder in QuickJS); null for an invalid sequence.
function utf8Decode(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    let len = 0, cp = 0;
    if (b < 0x80) { out += String.fromCharCode(b); i++; continue; }
    if (b >= 0xc2 && b <= 0xdf) { len = 2; cp = b & 0x1f; } else if (b >= 0xe0 && b <= 0xef) { len = 3; cp = b & 0x0f; } else if (b >= 0xf0 && b <= 0xf4) { len = 4; cp = b & 0x07; } else return null;
    if (i + len > bytes.length) return null;
    for (let k = 1; k < len; k++) {
      const c = bytes[i + k];
      if ((c & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (c & 0x3f);
    }
    if ((len === 3 && (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff))) || (len === 4 && (cp < 0x10000 || cp > 0x10ffff))) return null; // overlong, surrogate, too big
    out += String.fromCodePoint(cp);
    i += len;
  }
  return out;
}

function utf8Bytes(cp, into) {
  if (cp < 0x80) into.push(cp);
  else if (cp < 0x800) into.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
  else if (cp < 0x10000) into.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  else into.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
}

// One line of a tar listing: \\ -> \, \n -> newline, \ooo -> that byte; the bytes are then read as UTF-8. A line with
// an invalid sequence stays as printed.
const SIMPLE = { "\\": 0x5c, n: 0x0a, t: 0x09, r: 0x0d };
export function unescapeName(line) {
  if (!line.includes("\\")) return line;
  const bytes = [];
  const chars = Array.from(line);
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === "\\") {
      const oct = chars.slice(i + 1, i + 4).join("");
      if (/^[0-3][0-7][0-7]$/.test(oct)) { bytes.push(parseInt(oct, 8)); i += 3; continue; }
      if (chars[i + 1] in SIMPLE) { bytes.push(SIMPLE[chars[i + 1]]); i++; continue; }
    }
    utf8Bytes(c.codePointAt(0), bytes);
  }
  return utf8Decode(bytes) ?? line;
}

// stdout of ARCHIVE_PROBE_SCRIPT -> { tool, names }. names are the members (escapes of tar/bsdtar decoded; unzip -Z1 prints
// names as they are).
export function parseProbe(stdout) {
  const lines = String(stdout ?? "").split("\n");
  const cut = lines.indexOf("--");
  const head = cut < 0 ? lines : lines.slice(0, cut);
  const tool = (head.find((l) => l.startsWith("tool=")) ?? "").slice(5) || null;
  const raw = cut < 0 ? [] : lines.slice(cut + 1).filter((l) => l !== "");
  return { tool, names: tool === "tar" || tool === "bsdtar" ? raw.map(unescapeName) : raw };
}

// stdout of ARCHIVE_SIZE_SCRIPT -> { size, avail } in bytes, null when unknown (df prints KiB; its first column can hold
// spaces, so the numbers are read from the right).
export function parseSize(stdout) {
  let size = null, avail = null;
  for (const line of String(stdout ?? "").split("\n")) {
    if (line.startsWith("size=")) {
      const v = line.slice(5);
      if (/^\d+$/.test(v)) size = Number(v);
    } else if (line.startsWith("df=")) {
      const m = /\s(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+.*$/.exec(line.slice(3));
      if (m) avail = Number(m[3]) * 1024;
    }
  }
  return { size, avail };
}

// ---- checks ----

// The member list of an archive -> { tops: [{ name, isDir }] } (the entries that land in the target folder) or { error }.
// This is the second line of defense; the first are the tools' defaults (bsdtar refuses "..", absolute names and writing
// through links, GNU tar strips or defers them, Info-ZIP strips "../"). Refusing the archive here means nothing is
// written at all. Refused: an absolute member, a ".." component, a member below a non-directory member (a symlink that
// later members would be written through). zip names also treat "\\" as a separator.
export function checkMembers(names, { zip = false } = {}) {
  const members = [];
  for (const raw of names) {
    const name = zip ? raw.replace(/\\/g, "/") : raw;
    if (name.startsWith("/") || (zip && /^[A-Za-z]:/.test(name))) return { error: `The archive contains an absolute path: ${raw}` };
    const parts = name.split("/").filter((p) => p !== "" && p !== ".");
    if (parts.includes("..")) return { error: `The archive contains a path with "..": ${raw}` };
    if (parts.length) members.push({ raw, parts, dir: name.endsWith("/") });
  }
  if (!members.length) return { error: "The archive is empty" };
  const key = (parts) => parts.map(nameKey).join("/");
  const plain = new Set(), dirs = new Set(); // plain: listed without a trailing slash (file or link); dirs: listed as folders
  for (const m of members) {
    const k = key(m.parts);
    (m.dir ? dirs : plain).add(k);
  }
  for (const m of members) {
    for (let i = 1; i < m.parts.length; i++) {
      const k = key(m.parts.slice(0, i));
      if (plain.has(k) && !dirs.has(k)) return { error: `The archive writes through a link: ${m.raw}` };
    }
  }
  const tops = new Map();
  for (const m of members) {
    const k = nameKey(m.parts[0]);
    const isDir = m.parts.length > 1 || m.dir;
    const t = tops.get(k);
    if (t) t.isDir ||= isDir;
    else tops.set(k, { name: m.parts[0], isDir });
  }
  return { tops: [...tops.values()] };
}

// size and avail in bytes; null when either is unknown (no refusal then).
export function spaceError(size, avail) {
  if (!Number.isFinite(size) || !Number.isFinite(avail) || size <= avail) return null;
  return `Not enough space: ${formatBytes(size)} needed, ${formatBytes(avail)} free`;
}

export const missingTool = (tool, machine) => `${tool} is not installed on ${machine ?? "this computer"}`;
