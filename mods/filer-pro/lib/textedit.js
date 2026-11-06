// Text editing of plain files: byte probe, editability check, undo history and a safe in-place save.
// Pure except for the injected exec. The scripts run as `exec("sh", ["-c", SCRIPT, "<name>", ...args], { on })`
// locally or on a machine (non-login sh, POSIX tools only, GNU and BSD/macOS). Paths and data travel only as
// positional arguments, never inside the script text. No sudo, no prompts.
// No Buffer, TextDecoder, crypto or Intl here (and no locale formatting): the QuickJS runtime has none of them.
// herdr interrupts a job that runs longer than about 0.5 s with an error JS cannot catch: the check stays below that
// for 1 MiB (native codecs, lib/textcodec.js), hashing yields through an injected pause(), and probeFileGuarded ends
// a check in any case.
//
// The text never travels in argv (other users could read it there with ps): stage() writes it as base64 into a private
// local file; locally BEGIN_FILE_SCRIPT decodes that file, for a machine send() first copies it there with scp
// (bin/transfer.sh, as uploads do) and BEGIN_FILE_SCRIPT decodes it on the machine.

import { base64ToBytes, bytesToBase64, decodeUtf8, encodeUtf8, sha256HexSliced } from "./textcodec.js";
import { validateName } from "./fileops.js";
import { explainError } from "./errors.js";
import { joinPath, tempName } from "./names.js";
import { sshTarget } from "./machines.js";
import { sshEnv } from "./jobs.js";

export const EDIT_MAX_BYTES = 1048576;

// "@{" stands for the shell's dollar-brace (a template literal would swallow it).
const sh = (s) => s.trim().replaceAll("@{", "$" + "{");

// Sets $dec to the base64 decode flag: found by output, since GNU has -d, older BSD/macOS -D, busybox --decode.
const DECODER = String.raw`
dec=
for f in -d -D --decode; do
  if [ "$(printf QQ== | base64 $f 2>/dev/null)" = A ]; then dec=$f; break; fi
done
[ -n "$dec" ] || { echo nobase64; exit 1; }
`;

// sum <file> reads the file from stdin and prints its sha256 hex: sha256sum, shasum, openssl (last field).
const HASHER = String.raw`
if command -v sha256sum >/dev/null 2>&1; then
  sum() { sha256sum | awk '{ print $1 }'; }
elif command -v shasum >/dev/null 2>&1; then
  sum() { shasum -a 256 | awk '{ print $1 }'; }
elif command -v openssl >/dev/null 2>&1; then
  sum() { openssl dgst -sha256 | awk '{ print $NF }'; }
else
  echo nohash; exit 10
fi
`;

// stat in the machine's dialect, detected once (GNU stat -c, else BSD/macOS stat -f), for the path itself (no -L):
// st_mode <path> prints the permission bits with the special bits (GNU %a, e.g. 4755; BSD %p, e.g. 104755 with the file
// type in front, which parseProbe masks off), st_size <path> the size in bytes, ino <path> device:inode.
const STAT = String.raw`
if stat -c%i / >/dev/null 2>&1; then
  st_mode() { stat -c%a "$1"; }; st_size() { stat -c%s "$1"; }; ino() { stat -c '%d:%i' "$1"; }
else
  st_mode() { stat -f%p "$1"; }; st_size() { stat -f%z "$1"; }; ino() { stat -f '%d:%i' "$1"; }
fi
`;

// open_dir <path>: true when the folder of <path> is writable by everyone without the sticky bit, so any user could
// swap the file for a link between our check and our write. Such folders are refused.
const GUARDS = String.raw`
${STAT}
open_dir() { [ -n "$(find "$(dirname -- "$1")" -prune -perm -0002 ! -perm -1000 2>/dev/null)" ]; }
`;

// Where uploads and backups live on the machine: private, outside any watched folder.
const CACHE = String.raw`
d=@{XDG_CACHE_HOME:-$HOME/.cache}/filer-pro/edit
`;

// Output line 1: link | dir | missing | special | file <w> <mode> <size> <open>, open = y when the folder is writable by
// everyone without the sticky bit. For a file of at most EDIT_MAX_BYTES line 2 is
// its base64 without line breaks (empty for an empty file). `head -c` bounds the read if the file grows meanwhile.
export const PROBE_SCRIPT = sh(String.raw`
p=$1
case $p in -*) p=./$p ;; esac
if [ -L "$p" ]; then echo link; exit 0; fi
if [ -d "$p" ]; then echo dir; exit 0; fi
if [ ! -e "$p" ]; then echo missing; exit 0; fi
if [ ! -f "$p" ]; then echo special; exit 0; fi
${STAT}
m=$(st_mode "$p"); s=$(st_size "$p")
w=n
[ -w "$p" ] && w=y
o=n
[ -n "$(find "$(dirname -- "$p")" -prune -perm -0002 ! -perm -1000 2>/dev/null)" ] && o=y
echo "file $w $m $s $o"
if [ "$s" -le ${EDIT_MAX_BYTES} ]; then
  head -c ${EDIT_MAX_BYTES + 1} < "$p" | base64 | tr -d '\n\r'
  echo
fi
`);

// private-dir: makes the private upload folder on the machine (0700) and prints its path: send() copies the staged
// text there before BEGIN_FILE_SCRIPT runs on the machine.
export const PRIVATE_DIR_SCRIPT = sh(String.raw`
umask 077
${CACHE}
mkdir -p "$d" && chmod 700 "$d" || { echo nocache; exit 1; }
printf '%s
' "$d"
`);

// begin-file <src>: makes the private folder, decodes the staged base64 file <src> into a fresh file there and prints
// its path. The staged file is removed in any case.
export const BEGIN_FILE_SCRIPT = sh(String.raw`
umask 077
src=$1
${CACHE}
mkdir -p "$d" && chmod 700 "$d" || { rm -f -- "$src"; echo nocache; exit 1; }
${DECODER}
t=$(mktemp "$d/edit.XXXXXX") || { rm -f -- "$src"; echo nocache; exit 1; }
if tr -d '\n\r' < "$src" | base64 $dec > "$t"; then rm -f -- "$src"; echo "$t"; else rm -f -- "$t" "$src"; echo upload; exit 1; fi
`);

// commit <tmp> <path> <oldHash> <newHash>: replaces the content of <path> in place (same inode, mode, owner, links),
// but only if the upload is intact (newHash) and the file still has the content the editor started from (oldHash).
// Prints one word on the first line: ok | link | notfile | nowrite | unsafe | upload | changed | nobackup | nohash | restored | broken.
// restored: line 2 = upload file (the file is as before). broken: line 2 = backup, line 3 = upload file.
export const COMMIT_SCRIPT = sh(String.raw`
t=$1; p=$2; old=$3; new=$4
case $p in -*) p=./$p ;; esac
${HASHER}
${CACHE}
${GUARDS}
if [ -L "$p" ]; then echo link; exit 2; fi
if [ ! -f "$p" ]; then echo notfile; exit 3; fi
if [ ! -w "$p" ]; then echo nowrite; exit 4; fi
if open_dir "$p"; then echo unsafe; exit 11; fi
i1=$(ino "$p")
case $t in */filer-pro/edit/edit.*) ;; *) echo upload; exit 6 ;; esac
h=$(sum < "$t")
if [ "$h" != "$new" ]; then echo upload; exit 6; fi
h=$(sum < "$p")
if [ "$h" != "$old" ]; then echo changed; exit 5; fi
umask 077
bak=$(mktemp "$d/bak.XXXXXX") || { echo nobackup; exit 7; }
if ! cp -p "$p" "$bak"; then rm -f "$bak"; echo nobackup; exit 7; fi
# The same file as hashed, still not a link: checked again right before the write.
if [ -L "$p" ] || [ "$(ino "$p")" != "$i1" ]; then rm -f "$bak"; echo changed; exit 5; fi
if cat "$t" > "$p"; then
  rm -f "$t" "$bak"
  echo ok
  exit 0
fi
if cat "$bak" > "$p"; then
  rm -f "$bak"
  printf '%s\n%s\n' restored "$t"
  exit 8
fi
printf '%s\n%s\n%s\n' broken "$bak" "$t"
exit 9
`);

// copy <tmp> <dest> <newHash> <mode>: creates a NEW file (exclusive, set -C) under a umask made from <mode>, so it gets the
// original's read and write bits from the start and no chmod follows (a chmod by path could hit a link swapped in).
// Execute bits are not copied. Never overwrites. Prints ok | exists | unsafe | upload | failed | nohash.
export const COPY_SCRIPT = sh(String.raw`
t=$1; p=$2; new=$3; mode=$4
case $p in -*) p=./$p ;; esac
${HASHER}
${GUARDS}
case $t in */filer-pro/edit/edit.*) ;; *) echo upload; exit 6 ;; esac
h=$(sum < "$t")
if [ "$h" != "$new" ]; then echo upload; exit 6; fi
case $mode in ""|*[!0-7]*) mode=600 ;; esac
if [ -e "$p" ] || [ -L "$p" ]; then echo exists; exit 2; fi
if open_dir "$p"; then echo unsafe; exit 11; fi
if ! ( umask "$(printf '%o' $(( 0777 & ~0$mode )))" && set -C && cat "$t" > "$p" ) 2>/dev/null; then
  if [ -e "$p" ] || [ -L "$p" ]; then echo exists; exit 2; fi
  echo failed; exit 3
fi
rm -f "$t"
echo ok
`);

// clean <tmp>: removes an upload file again (only inside the private folder).
export const CLEAN_SCRIPT = sh(String.raw`
case $1 in */filer-pro/edit/edit.*) rm -f -- "$1" ;; esac
exit 0
`);

// ---- probe parsing and the editability decision

// stdout of PROBE_SCRIPT -> { kind, writable, mode, size, bytes }. kind: link | dir | missing | special | file | error.
export function parseProbe(stdout) {
  const bad = { kind: "error", writable: false, mode: null, size: 0, bytes: null };
  const lines = String(stdout ?? "").split("\n");
  const head = lines[0].trim();
  if (head === "link" || head === "dir" || head === "missing" || head === "special") {
    return { kind: head, writable: false, mode: null, size: 0, bytes: null };
  }
  const m = /^file (y|n) ([0-7]+) (\d+)(?: (y|n))?$/.exec(head);
  if (!m) return bad;
  const size = Number(m[3]);
  let bytes = null;
  if (size <= EDIT_MAX_BYTES) {
    const line = lines[1] ?? (size === 0 ? "" : null);
    if (line === null) return bad;
    bytes = base64ToBytes(line);
    if (bytes === null) return bad;
  }
  return { kind: "file", writable: m[1] === "y", mode: octalMode(m[2]), size, bytes, openDir: m[4] === "y" };
}

// The permission bits as shown in the status line: 644, or 4 digits (4755) when a special bit is set. The same rule as
// formatOctal of the Permissions dialog (#23), so both show one mode; BSD's %p brings the file type in front (100644).
export function octalMode(text) {
  const mode = parseInt(text, 8) & 0o7777;
  return mode.toString(8).padStart(mode & 0o7000 ? 4 : 3, "0");
}

const REFUSED = {
  link: "Symbolic link",
  dir: "Folder",
  missing: "File no longer available",
};

// UTF-16 by BOM, or by the NUL pattern of mostly-ASCII text (every second byte 0 in the first 512 bytes).
export function looksUtf16(b) {
  if (b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) return true;
  const n = Math.min(b.length, 512) & ~1;
  if (n < 2) return false;
  let evenZero = true, oddZero = true, evenAny = false, oddAny = false;
  for (let i = 0; i < n; i += 2) {
    if (b[i] !== 0) { evenZero = false; evenAny = true; }
    if (b[i + 1] !== 0) { oddZero = false; oddAny = true; }
  }
  return (oddZero && evenAny) || (evenZero && oddAny);
}

// -> { ok: false, reason } | { ok: true, info: { bytes, text, eol, mode, size } }. First matching reason wins.
export function checkEditable(probe, { maxChars = Infinity } = {}) {
  const no = (reason) => ({ ok: false, reason });
  const kind = probe?.kind;
  if (REFUSED[kind]) return no(REFUSED[kind]);
  if (kind !== "file") return no("Not a regular file");
  if (probe.size > EDIT_MAX_BYTES) return no("File larger than 1 MiB");
  const b = probe.bytes;
  if (!b || b.length !== probe.size) return no("File changed while reading");
  if (looksUtf16(b)) return no("UTF-16 file, use Edit in Terminal");
  if (b.includes(0)) return no("Binary file");
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return no("UTF-8 with BOM, use Edit in Terminal");
  const decoded = decodeUtf8(b);
  if (decoded === null) return no("Not UTF-8 (Latin-1 or other), use Edit in Terminal");
  if (decoded.length > maxChars) return no("Display truncated");
  if (/\r(?!\n)/.test(decoded)) return no("Old Mac line endings (CR)");
  const crlf = decoded.includes("\r\n");
  if (crlf && /(^|[^\r])\n/.test(decoded)) return no("Mixed line endings");
  const mode = String(probe.mode ?? "");
  if (!probe.writable || (parseInt(mode, 8) & 0o222) === 0) return no("No write permission");
  if (probe.openDir) return no("Folder writable by everyone");
  return { ok: true, info: { bytes: b, text: crlf ? decoded.replaceAll("\r\n", "\n") : decoded, eol: crlf ? "CRLF" : "LF", mode, size: probe.size } };
}

// ---- buffer to bytes

// The bytes to write for the editor's value: any CRLF or lone CR becomes LF, then LF becomes CRLF for a CRLF file,
// then UTF-8. null when the text holds a lone surrogate. An unchanged buffer gives exactly info.bytes.
export function bufferBytes(value, info) {
  let v = String(value).replace(/\r\n?/g, "\n");
  if (info.eol === "CRLF") v = v.replaceAll("\n", "\r\n");
  return encodeUtf8(v);
}

export function isDirty(value, info) {
  return value !== info.text;
}

// "UTF-8 · LF · 600", or "UTF-8 · LF · 600 → 644" when a save changed the mode (modeBefore is the old one).
export function statusText(info, modeBefore) {
  const mode = modeBefore && modeBefore !== info.mode ? `${modeBefore} → ${info.mode}` : info.mode;
  return `UTF-8 · ${info.eol} · ${mode}`;
}

// File name of the unsaved-text mirror: the id, then the file's name with anything but [A-Za-z0-9._-] made "_" and no
// leading dot, so a remote name ("..", "\\", ":", control characters) can never leave the mirror folder or hide itself.
export function mirrorName(id, name) {
  const safe = String(name ?? "").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 80);
  return `${id}-${safe || "file"}.txt`;
}

export function copyName(name) {
  const i = name.lastIndexOf(".");
  return i <= 0 ? `${name} copy` : `${name.slice(0, i)} copy${name.slice(i)}`;
}

// ---- undo history of whole values (pure: the caller passes the clock)

export function createHistory({ maxEntries = 100, maxChars = 16 * 1024 * 1024, mergeMs = 800 } = {}) {
  let entries = [""];
  let at = 0;
  let last = null; // time of the latest record, null after reset/undo/redo (the next record starts a new step)

  function trim() {
    let total = 0;
    for (const e of entries) total += e.length;
    while (entries.length > 1 && at > 0 && (entries.length > maxEntries || total > maxChars)) {
      total -= entries[0].length;
      entries.shift();
      at--;
    }
  }

  return {
    reset(value) {
      entries = [String(value)];
      at = 0;
      last = null;
    },
    record(value, now) {
      const v = String(value);
      if (v === entries[at]) return;
      entries.length = at + 1; // a new edit ends the redo branch
      if (last !== null && at > 0 && now - last <= mergeMs) {
        entries[at] = v;
      } else {
        entries.push(v);
        at++;
      }
      last = now;
      trim();
    },
    undo() {
      if (at === 0) return null;
      at--;
      last = null;
      return entries[at];
    },
    redo() {
      if (at >= entries.length - 1) return null;
      at++;
      last = null;
      return entries[at];
    },
    canUndo: () => at > 0,
    canRedo: () => at < entries.length - 1,
  };
}

// ---- exec: probe, upload, save

const CANNOT_READ = { ok: false, reason: "Cannot read this file" };

// The probe's exec result -> the result of checkEditable.
const checkProbe = (res, maxChars) => (!res || res.code !== 0 ? CANNOT_READ : checkEditable(parseProbe(res.stdout), { maxChars }));

export async function probeFile({ exec, on = null, path, maxChars }) {
  let res;
  try {
    res = await exec("sh", ["-c", PROBE_SCRIPT, "probe", path], { on });
  } catch {
    return CANNOT_READ;
  }
  return checkProbe(res, maxChars);
}

export const CHECK_FAILED = "Could not check this file";
export const CHECK_TIMEOUT_MS = 60000;

// probeFile that always ends: done(result) runs exactly once. after(ms, fn) is a timer (cx.timer.after).
// - The check part (parse and checkEditable) runs synchronously in the job that receives the probe output. A timer is
//   armed right before it: it can only fire after that job, so it finds the check unfinished only when the runtime
//   interrupted the job (uncatchable, nothing after it in that job runs) -> CHECK_FAILED.
// - A check that throws -> CHECK_FAILED; no answer within timeoutMs -> CHECK_FAILED with "no answer".
// check is the check part, replaceable for tests.
export function probeFileGuarded({ exec, on = null, path, maxChars, after, timeoutMs = CHECK_TIMEOUT_MS, check = checkProbe }, done) {
  let ended = false;
  const end = (r) => {
    if (ended) return;
    ended = true;
    done(r);
  };
  after(timeoutMs, () => end({ ok: false, reason: `${CHECK_FAILED} (no answer)` }));
  (async () => {
    let res;
    try {
      res = await exec("sh", ["-c", PROBE_SCRIPT, "probe", path], { on });
    } catch {
      return end(CANNOT_READ);
    }
    after(0, () => end({ ok: false, reason: CHECK_FAILED }));
    let r;
    try {
      r = check(res, maxChars);
    } catch {
      r = { ok: false, reason: CHECK_FAILED };
    }
    end(r);
  })();
}

const firstLine = (s) => String(s ?? "").split("\n")[0].trim();
const lines = (s) => String(s ?? "").split("\n").map((l) => l.trim());

// localPlatform (window().platform of this computer) decides the text of a local "Operation not permitted" (errors.js).
const explain = (stderr, on, fallback, localPlatform) => explainError(stderr, on, fallback, { localPlatform });
const cannotReach = (e, on, localPlatform) => `Cannot reach the machine: ${explain(String(e?.message ?? e), on, undefined, localPlatform)}`;

// Uploads bytes into a fresh private file on the machine. -> { tmp } | { error }. Nothing is left behind on failure.
// stage(b64) writes the base64 into a private local file and resolves with its path; for a machine, send({ on, src, dir,
// name }) copies that file to <dir>/<name> there (scpSender) -> { ok } | { ok: false, error }. The local file is removed
// in any case (locally by BEGIN_FILE_SCRIPT, for a machine here, after the copy).
async function upload(exec, on, bytes, stage, send, localPlatform) {
  if (!stage || (on != null && !send)) return { error: "Could not prepare the text for saving" };
  let src = null;
  try { src = await stage(bytesToBase64(bytes)); } catch { src = null; }
  if (typeof src !== "string" || !src.startsWith("/")) return { error: "Could not prepare the text for saving" };
  let tmp = null, remote = null;
  const fail = async (error) => {
    if (tmp) await clean(exec, on, tmp);
    if (remote) await clean(exec, on, remote);
    return { error };
  };
  try {
    let from = src;
    if (on != null) {
      try {
        const d = await exec("sh", ["-c", PRIVATE_DIR_SCRIPT, "private-dir", ""], { on });
        const dir = firstLine(d.stdout);
        if (d.code !== 0 || !dir.startsWith("/")) return { error: "Cannot create the private upload folder on the machine" };
        const name = `edit.up-${randomId()}.b64`;
        remote = joinPath(dir, name);
        let sent;
        try { sent = await send({ on, src, dir, name }); } catch (e) { sent = { ok: false, error: String(e?.message ?? e) }; }
        if (!sent?.ok) return await fail(`Could not copy the text to the machine: ${sent?.error || "scp failed"}`);
      } finally {
        await removeLocal(exec, src);
      }
      from = remote;
    }
    const res = await exec("sh", ["-c", BEGIN_FILE_SCRIPT, "begin-file", from], { on });
    remote = null; // BEGIN_FILE_SCRIPT removed it
    if (res.code !== 0) {
      const word = firstLine(res.stdout);
      if (word === "nocache") return { error: "Cannot create the private upload folder on the machine" };
      if (word === "nobase64") return { error: "The machine has no base64 tool" };
      return { error: explain(res.stderr, on, "Could not upload the text", localPlatform) };
    }
    tmp = firstLine(res.stdout);
    if (!tmp.startsWith("/")) return await fail("Could not upload the text");
    return { tmp };
  } catch (e) {
    if (on == null) await removeLocal(exec, src);
    return await fail(cannotReach(e, on, localPlatform));
  }
}

const randomId = () => (Math.random().toString(36).slice(2) + "00000000").slice(0, 8);

// Removes a staged local file (best effort; it lives in a 0700 folder).
async function removeLocal(exec, src) {
  try { await exec("rm", ["-f", "--", src], { on: null }); } catch {}
}

// send() for upload: copies the staged local file to <dir>/<name> on the machine with bin/transfer.sh (scp in SFTP mode,
// BatchMode, the SSH settings as FILER_PRO_SSH_* exactly as transfer jobs get them), mode "new" so nothing is
// replaced. It runs as one exec (30 s limit; a save is at most about 1.4 MB of base64), without a job row, progress
// or cancel. The status file lands next to the staged file and is removed again.
// deps: { exec, hc, script (path of transfer.sh), trashDir, limits() -> config numbers }.
export function scpSender({ exec, hc, script, trashDir, limits, localPlatform }) {
  return async ({ on, src, dir, name }) => {
    let t;
    try {
      const r = await hc(["machine", "ls", "--json"]);
      t = r?.code === 0 ? sshTarget(r.stdout, on) : { error: "Cannot read the machine list" };
    } catch (e) { t = { error: String(e?.message ?? e) }; }
    if (t.error) return { ok: false, error: t.error };
    const id = randomId(), status = `${src}.status`;
    const argv = [...sshEnv(limits()), "sh", script, "up", "new", t.target, src, joinPath(dir, name), joinPath(dir, tempName(name, id)), status, trashDir];
    let r;
    try { r = await exec(argv[0], argv.slice(1), { on: null }); } catch (e) { r = { code: 1, stdout: "", stderr: String(e?.message ?? e) }; }
    let detail = "";
    try {
      const st = await exec("sh", ["-c", 'cat -- "$1" 2>/dev/null; rm -f -- "$1" "$1.err" "$1.tmp"', "status", status], { on: null });
      detail = String(st.stdout ?? "").split("\n").filter((l) => l && !l.startsWith("state=") && !l.startsWith("code=")).join(" ").trim();
    } catch {}
    if (r.code === 0) return { ok: true };
    return { ok: false, error: explain(detail || r.stderr, t.target, "scp failed", localPlatform) };
  };
}

async function clean(exec, on, tmp) {
  try {
    await exec("sh", ["-c", CLEAN_SCRIPT, "clean", tmp], { on });
  } catch {
    // best effort: the file lives in the private cache folder and holds only the text the user typed
  }
}

// No pause between hash slices (tests); the app passes a timer wait, see sha256HexSliced.
const noPause = async () => {};

// Writes bytes into the open file in place. info is the baseline the editor started from (info.bytes = what the file
// held, info.hash its sha256 when known). -> { ok: true, bytes, hash } (the sent bytes are the new baseline) | { ok: false, error, kept? }.
// pause() runs between hash slices so 1 MiB hashes without hitting herdr's per-job time limit.
// kept: a path on the machine that still holds the text; backup: the backup of the original (only after "may be incomplete").
export async function saveFile({ exec, on = null, path, info, bytes, stage, send, pause = noPause, localPlatform }) {
  if (!bytes) return { ok: false, error: "Text contains characters that cannot be saved as UTF-8" };
  const oldHash = info.hash ?? (await sha256HexSliced(info.bytes, pause));
  await pause();
  const hash = await sha256HexSliced(bytes, pause);
  const up = await upload(exec, on, bytes, stage, send, localPlatform);
  if (up.error) return { ok: false, error: up.error };
  const tmp = up.tmp;
  let res;
  try {
    res = await exec("sh", ["-c", COMMIT_SCRIPT, "commit", tmp, path, oldHash, hash], { on });
  } catch (e) {
    return { ok: false, error: cannotReach(e, on, localPlatform) };
  }
  const [word, a, b] = lines(res.stdout);
  if (res.code === 0 && word === "ok") return { ok: true, bytes, hash };
  if (word === "restored") {
    return { ok: false, error: `Could not write the file; it is unchanged. Your text is also in ${a}`, kept: a };
  }
  if (word === "broken") {
    return { ok: false, error: `Could not write the file; it may be incomplete. Original: ${a}, your text: ${b}`, kept: b, backup: a };
  }
  await clean(exec, on, tmp);
  const known = {
    changed: "The file changed since it was opened. Your text is kept: use Save a Copy…",
    link: "The file is now a symbolic link; nothing was written",
    notfile: "The path is no longer a regular file; nothing was written",
    nowrite: "No write permission; nothing was written",
    unsafe: "The folder is writable by everyone; nothing was written",
    upload: "The upload was damaged on the way; nothing was written, try again",
    nobackup: "Could not make a backup first; nothing was written",
    nohash: "The machine has no sha256 tool (sha256sum, shasum or openssl)",
  };
  return { ok: false, error: known[word] ?? explain(res.stderr, on, "Could not write the file", localPlatform) };
}

// Creates a new file <dir>/<name> with the bytes and the given mode (octal string). Never replaces anything.
// -> { ok: true, path, bytes, hash } | { ok: false, error }.
export async function saveCopy({ exec, on = null, dir, name, bytes, mode, stage, send, pause = noPause, localPlatform }) {
  const bad = validateName(name ?? "");
  if (bad) return { ok: false, error: bad };
  if (typeof dir !== "string" || !dir.startsWith("/")) return { ok: false, error: "path must be absolute" };
  if (!bytes) return { ok: false, error: "Text contains characters that cannot be saved as UTF-8" };
  const dest = joinPath(dir, name);
  const hash = await sha256HexSliced(bytes, pause);
  const up = await upload(exec, on, bytes, stage, send, localPlatform);
  if (up.error) return { ok: false, error: up.error };
  let res;
  try {
    res = await exec("sh", ["-c", COPY_SCRIPT, "copy", up.tmp, dest, hash, String(mode ?? "600").slice(-3)], { on });
  } catch (e) {
    return { ok: false, error: cannotReach(e, on, localPlatform) };
  }
  const word = firstLine(res.stdout);
  if (res.code === 0 && word === "ok") return { ok: true, path: dest, bytes, hash };
  await clean(exec, on, up.tmp);
  const known = {
    exists: "A file with that name already exists",
    unsafe: "The folder is writable by everyone; nothing was written",
    upload: "The upload was damaged on the way; nothing was written, try again",
    failed: "Could not create the copy",
    nohash: "The machine has no sha256 tool (sha256sum, shasum or openssl)",
  };
  return { ok: false, error: known[word] ?? explain(res.stderr, on, "Could not create the copy", localPlatform) };
}
