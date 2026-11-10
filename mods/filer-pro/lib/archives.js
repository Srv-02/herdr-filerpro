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

// The most members an archive may list: above it the probe stops before the long listing and the extract is refused, so
// the listing that reaches the app stays bounded. The check runs in slices of CHECK_SLICE (memberCheck's cost: about one
// unit per character), one QuickJS job each (checkListing): herdr interrupts a job after about 0.5 s.
export const ARCHIVE_MAX_MEMBERS = 200000;
export const CHECK_SLICE = 65536;
const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
export const tooManyMembers = (n) => (Number.isFinite(n) && n > ARCHIVE_MAX_MEMBERS
  ? `The archive lists ${grouped(n)} entries: more than ${grouped(ARCHIVE_MAX_MEMBERS)} cannot be checked`
  : `The archive lists more than ${grouped(ARCHIVE_MAX_MEMBERS)} entries: too many to check`);
export const CHECK_INTERRUPTED = "Could not check the archive in time: it lists too many entries";

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
//           get as <tool>), `types=<c...>` (tar and zip: the first character of each member's line in the long listing,
//           in member order: d folder, - file, l symlink, h hard link, ...), `size=<bytes>` (tar and bsdtar: the sum of
//           the regular files' sizes read from the same long listing, empty when a line has an unknown layout),
//           `encrypted=<0|1>` (1: a zip entry is encrypted, seen by unzip), a line `--`, then one member per line
//           (nothing for single). Directory members usually end in "/".
//           tar/bsdtar print a newline in a name as \n, a backslash as \\ and non-ASCII bytes maybe as \ooo (parseProbe decodes).
//   exit 0  ok
//   exit 3  a tool is missing: stdout `missing=<tool>`
//   exit 4  the listing failed (not an archive, damaged, ...): the tool's messages on stderr
//   exit 5  more than ARCHIVE_MAX_MEMBERS members: stdout `count=<n>`, nothing else is read
//   A compressed tar is decompressed twice (the name listing and the long listing); the long listing gives the types
//   and the size, so the space check needs no third pass (ARCHIVE_SIZE_SCRIPT gets "-" as its tool then).
//   Tool choice: tar family -> tar. zip -> unzip when `unzip -Z1` lists it, else bsdtar when present, else missing unzip
//   (no `tar --version` sniffing, R11). single -> its tool. A tar listing that fails while its `need` helper is missing
//   reports the helper (bsdtar reads gzip/bzip2/xz itself, zstd and GNU tar's helpers are external).
export const ARCHIVE_PROBE_SCRIPT = `${LOCALE}
f=$1; n=$2; a=$3
case "$a" in -*) a=./$a;; esac
miss() { printf 'missing=%s\\n' "$1"; exit 3; }
has() { command -v "$1" >/dev/null 2>&1; }
bad() { [ -n "$m" ] && printf '%s\\n' "$m" >&2; exit 4; }
big() { c=$(printf '%s\\n' "$m" | wc -l | tr -d ' '); [ "$c" -le ${ARCHIVE_MAX_MEMBERS} ] || { printf 'count=%s\\n' "$c"; exit 5; }; }
# long <cmd>...: the type characters (y) and the regular files' byte sum (z) of a long listing. GNU and busybox tar print
# "mode user/group size ...", bsdtar "mode links user group size ..."; any other layout leaves z empty.
long() {
  v=$("$@" 2>/dev/null)
  y=$(printf '%s\\n' "$v" | cut -c1 | tr -d '\\n')
  z=$(printf '%s\\n' "$v" | awk 'substr($0, 1, 1) != "-" { next }
    $2 ~ /\\// && $3 ~ /^[0-9]+$/ { s += $3; next }
    $2 ~ /^[0-9]+$/ && $5 ~ /^[0-9]+$/ { s += $5; next }
    { u = 1 } END { if (!u) printf "%.0f", s }')
}
m= y= z= e=0
case "$f" in
  single)
    t=$n; has "$t" || miss "$t"
    printf 'tool=%s\\n--\\n' "$t"; exit 0;;
  zip)
    if has unzip && m=$(unzip -Z1 "$a" 2>/dev/null); then t=unzip; big
      y=$(unzip -Z -s "$a" 2>/dev/null | sed '1,2d;$d' | cut -c1 | tr -d '\\n')
      # zipinfo writes the t/b column in capitals for an encrypted entry
      e=$(unzip -Z -s "$a" 2>/dev/null | awk 'NR > 2 && $5 ~ /^[TB]/ { f = 1 } END { print f + 0 }')
    elif has bsdtar; then t=bsdtar; m=$(bsdtar -tf "$a") || bad
      big; long bsdtar -tvf "$a"
    elif has unzip; then m=$(unzip -Z1 "$a" 2>&1); bad
    else miss unzip; fi;;
  *)
    t=tar; has tar || miss tar
    if ! m=$(tar -tf "$a"); then
      [ "$n" != - ] && ! has "$n" && miss "$n"
      bad
    fi
    big; long tar -tvf "$a";;
esac
printf 'tool=%s\\ntypes=%s\\nsize=%s\\nencrypted=%s\\n--\\n%s\\n' "$t" "$y" "$z" "$e" "$m"
`;

// ARCHIVE_SIZE_SCRIPT: how much room the extracted files need and how much the target folder has (R4). A separate exec
// from the probe (timeout 120000 ms): unpacking to count bytes can take long on a big archive.
//   sh -c SCRIPT x <tool> <archive> <dest_dir>
//     tool      the one parseProbe returned, or "-" when the probe already gave the size (then only df runs)
//     archive   absolute path
//     dest_dir  the folder the files go to (must exist)
//   stdout  `size=<bytes>` (empty when unknown: sum of the regular file sizes, measured with \`<tool> -xOf | wc -c\` (a tar
//           only gets here when its long listing had an unknown layout),
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

// One line of a tar listing: \\ -> \, \n -> newline, \ooo -> that byte; the bytes are then read as UTF-8. A line with
// an invalid sequence stays as printed. The line is rewritten as percent escapes and read with decodeURIComponent, which
// is native and strict (it refuses overlong forms, surrogates and cut sequences, like a strict UTF-8 decoder): a
// per-character decoder in QuickJS needed about 3 µs per character, too slow for a listing of escaped names.
// The line is cut at each backslash (a native split; a regular expression over the line was too slow in QuickJS): each
// piece after a cut starts with what followed the backslash.
const BYTE = {}; // "000".."377" -> "%00".."%FF"
for (let b = 0; b < 256; b++) BYTE[b.toString(8).padStart(3, "0")] = `%${b.toString(16).padStart(2, "0").toUpperCase()}`;
const SIMPLE = { n: "%0A", t: "%09", r: "%0D" };
export function unescapeName(line) {
  if (!line.includes("\\")) return line;
  try {
    const seg = line.split("\\");
    let out = encodeURIComponent(seg[0]);
    for (let i = 1; i < seg.length; i++) {
      const s = seg[i];
      const byte = BYTE[s.slice(0, 3)];
      if (byte !== undefined) out += byte + encodeURIComponent(s.slice(3));
      else if (s === "" && i + 1 < seg.length) out += `%5C${encodeURIComponent(seg[++i])}`; // "\\": the piece after it is plain
      else if (Object.hasOwn(SIMPLE, s.charAt(0))) out += SIMPLE[s.charAt(0)] + encodeURIComponent(s.slice(1));
      else out += `%5C${encodeURIComponent(s)}`; // a lone backslash
    }
    return decodeURIComponent(out);
  } catch {
    return line; // an invalid sequence, or a lone surrogate in the line
  }
}

// stdout of ARCHIVE_PROBE_SCRIPT -> { tool, names, types?, size?, encrypted? }. names are the members (escapes of tar/bsdtar
// decoded; unzip -Z1 prints names as they are; raw: left as printed, checkListing decodes them slice by slice); types the
// type characters in member order and size the byte sum of the long listing (each absent when its line is missing or empty).
export function parseProbe(stdout, { raw: keep = false } = {}) {
  const lines = String(stdout ?? "").split("\n");
  const cut = lines.indexOf("--");
  const head = cut < 0 ? lines : lines.slice(0, cut);
  const tool = (head.find((l) => l.startsWith("tool=")) ?? "").slice(5) || null;
  const typeLine = head.find((l) => l.startsWith("types="));
  const size = (head.find((l) => l.startsWith("size=")) ?? "").slice(5);
  let raw = cut < 0 ? [] : lines.slice(cut + 1);
  while (raw.length && raw[raw.length - 1] === "") raw.pop();
  if (raw.indexOf("") >= 0) raw = raw.filter((l) => l !== ""); // native search first: a long listing has no empty line
  return {
    tool, names: !keep && (tool === "tar" || tool === "bsdtar") ? raw.map(unescapeName) : raw, ...(typeLine !== undefined ? { types: typeLine.slice(6) } : {}),
    ...(/^\d+$/.test(size) ? { size: Number(size) } : {}),
    ...(head.includes("encrypted=1") ? { encrypted: true } : {}),
  };
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
// through links, GNU tar strips them and defers dangerous links, Info-ZIP strips "../"). Refusing the archive here means
// nothing is written at all. Refused: an absolute member, a ".." component, a member below a member that is no folder (a
// symlink or hard link that later members would be written through, also a link listed with a trailing slash), and a
// path listed both as a folder and as something else. types: one character per member from the long listing (d folder,
// l symlink, h hard link, - file); without it (or when it does not match the list) a member counts as a folder only with a
// trailing slash. Paths are compared with nameKey on every side: on APFS "Foo" and "foo/x" are the same path, and on a
// case-sensitive machine a refusal of such an archive is only overly careful. zip names also treat "\\" as a separator.
export function checkMembers(names, opts) {
  return memberCheck(names, opts).step(Infinity);
}

// The key of a member path: nameKey of each component, joined with "/". A pure ASCII path only needs toLowerCase (NFC
// changes no ASCII), which keeps the check of a big listing cheap; a component key never contains "/", so the key of
// every leading part of the path is the key up to one of its slashes.
const ASCII = /^[\x00-\x7f]*$/;
const MEMBER_COST = 16;
const cost = (text) => MEMBER_COST + text.length;
const pathKey = (parts) => {
  const joined = parts.join("/");
  return ASCII.test(joined) ? joined.toLowerCase() : parts.map(nameKey).join("/");
};

// checkMembers in steps: step(budget) works on members until their cost (MEMBER_COST plus the length of the line: a long
// name, above all one of escapes, takes longer) reaches budget, and returns the result ({ tops } or { error }, the same
// as checkMembers) once it is known, else null. decode (optional) turns each listed line into the member name first.
// Two passes: every name (absolute, "..", the folder and non-folder sets, the tops), then every member against the sets
// (both a folder and something else, written through a non-folder).
export function memberCheck(names, { zip = false, types, decode = null } = {}) {
  const typed = typeof types === "string" && types.length === names.length;
  let result = null;
  if (typeof types === "string" && !typed) result = { error: "Could not read the member types of the archive" };
  else if (names.length > ARCHIVE_MAX_MEMBERS) result = { error: tooManyMembers(names.length) };
  const members = [], dirs = new Set(), other = new Set(), tops = new Map(); // other: files, links and anything else that is no folder
  let pass = 0, i = 0;
  const first = (line, at) => {
    const raw = decode ? decode(line) : line;
    const name = zip ? raw.replace(/\\/g, "/") : raw;
    if (name.startsWith("/") || (zip && /^[A-Za-z]:/.test(name))) return { error: `The archive contains an absolute path: ${raw}` };
    const parts = name.split("/").filter((p) => p !== "" && p !== ".");
    if (parts.includes("..")) return { error: `The archive contains a path with "..": ${raw}` };
    if (!parts.length) return null;
    const dir = typed ? types[at] === "d" : name.endsWith("/");
    const key = pathKey(parts);
    (dir ? dirs : other).add(key);
    members.push({ raw, key });
    const slash = key.indexOf("/");
    const top = slash < 0 ? key : key.slice(0, slash);
    const isDir = parts.length > 1 || dir;
    const t = tops.get(top);
    if (t) t.isDir ||= isDir;
    else tops.set(top, { name: parts[0], isDir });
    return null;
  };
  const second = ({ raw, key }) => {
    if (dirs.has(key) && other.has(key)) return { error: `The archive lists a path both as a folder and as a file or link: ${raw}` };
    for (let j = key.indexOf("/"); j >= 0; j = key.indexOf("/", j + 1)) {
      if (other.has(key.slice(0, j))) return { error: `The archive writes through a link: ${raw}` };
    }
    return null;
  };
  return {
    step(budget) {
      for (let left = budget; !result && left > 0;) {
        if (pass === 0) {
          if (i < names.length) { left -= cost(names[i]); result = first(names[i], i); i++; continue; }
          if (!members.length) result = { error: "The archive is empty" };
          pass = 1; i = 0;
        } else if (i < members.length) { left -= cost(members[i].key); result = second(members[i++]); }
        else result = { tops: [...tops.values()] };
      }
      return result;
    },
  };
}

// The member check of one probe output that never stalls the app: parseProbe in one QuickJS job, then memberCheck in
// slices of `slice` cost units, each in its own job (after(0) between them). Before each part a zero timer is armed: when
// herdr interrupts the job (uncatchable, the promise would never settle) that timer ends the check with
// CHECK_INTERRUPTED. Without after (tests) everything runs at once. Always resolves, with { probe, tops } or { error }.
// family and stem: archiveOf(); a single compressed file has no member list, its one entry is the stem. check is
// replaceable for tests.
export function checkListing(stdout, { family, stem, after = null, slice = CHECK_SLICE, check = memberCheck }) {
  return new Promise((done) => {
    let ended = false;
    const end = (r) => {
      if (ended) return;
      ended = true;
      done(r);
    };
    const step = (fn) => {
      let finished = false;
      if (after) after(0, () => { if (!finished) end({ error: CHECK_INTERRUPTED }); });
      try { return fn(); } catch (e) { end({ error: `Could not check the archive: ${String(e?.message ?? e)}` }); return null; } finally { finished = true; }
    };
    const next = () => (after ? new Promise((resolve) => after(0, resolve)) : Promise.resolve());
    (async () => {
      const p = step(() => parseProbe(stdout, { raw: true }));
      if (ended) return;
      if (p.encrypted) return end({ error: "Encrypted archives are not supported" });
      if (family === "single") return end({ probe: p, tops: [{ name: stem, isDir: false }] });
      const decode = p.tool === "tar" || p.tool === "bsdtar" ? unescapeName : null;
      const c = check(p.names, { zip: family === "zip" || p.tool === "unzip", types: p.types, decode });
      for (;;) {
        await next();
        if (ended) return;
        const r = step(() => c.step(slice));
        if (ended) return;
        if (r) return end(r.error ? { error: r.error } : { probe: p, tops: r.tops });
      }
    })();
  });
}

// size and avail in bytes; null when either is unknown (no refusal then).
export function spaceError(size, avail) {
  if (!Number.isFinite(size) || !Number.isFinite(avail) || size <= avail) return null;
  return `Not enough space: ${formatBytes(size)} needed, ${formatBytes(avail)} free`;
}

export const missingTool = (tool, machine) => `${tool} is not installed on ${machine ?? "this computer"}`;
