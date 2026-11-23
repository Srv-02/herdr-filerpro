// Job manager: one `transfer.sh` run per job in its own invisible hc terminal. The manager only
// starts it, polls the temp size and the terminal state, and settles the end state. Pure: every
// herdr API arrives through `deps` (exec, hc, readTextFile, getShared, setShared, notify, now,
// newId, appHome, home; optional settings() -> the config of lib/config.js, read at each use, and after(ms, fn), a
// timer that starts a new QuickJS job: the member check of an archive runs in slices with it). Jobs live in shared("filer-pro.jobs") as a plain object id -> job.
import { clipItems } from "./clipboard.js";
import { keepBothName, tempName, joinPath, parentOf, baseName, nameKey } from "./names.js";
import { sshTarget } from "./machines.js";
import { explainError as explainRaw, cleanText } from "./errors.js";
import { platform } from "./platform.js";
import { afterDownload } from "./open.js";
import { sizeArgs, SIZE_GRACE_MS, parseSize, parseSizeOutput } from "./sizes.js";
import { progressOf } from "./progress.js";
import { verifyArgs, parseVerify, verdict, VERIFY_MS, KEPT_UNKNOWN, KEPT_CHANGED, KEPT_CANCELLED, KEPT_RESTART, KEPT_RESTART_DELETE, KEPT_NO_ROOT } from "./verify.js";
import { LINKS_SCRIPT, parseLinks, linkWarning } from "./links.js";
import { MOUNT_FN, normalizePath } from "./fileops.js";
import { numbers } from "./settings.js";
import {
  archiveOf, ARCHIVE_PROBE_SCRIPT, ARCHIVE_SIZE_SCRIPT, EXTRACT_STOP_SCRIPT, checkListing, tooManyMembers, parseSize as parseArchiveSize, spaceError, missingTool,
} from "./archives.js";

const KEY = "filer-pro.jobs";
const SIZE_LIMIT_MS = 25_000;
// Cross-copy dialog: watchdog limit 4 s plus 1 s of grace for exec, so one entry holds the dialog up for 5 s at most.
const SOURCE_SIZE_MS = 4_000;
const SOURCE_GRACE_MS = 1_000;
// Temp poll of tick(): the watchdog still bounds find on the machine, but far above any sane size of a transfer temp, so the
// poll yields a number (as before the watchdog existed). tick() waits for it, so polls never overlap.
const TEMP_POLL_MS = 600_000;
export const KEEP_DONE_MS = 10_000;

// The SSH options for transfer.sh (FILER_PRO_SSH_*): an `env` prefix for the hc run argv, only when a value differs from
// the default, so a config without them runs exactly the command of before. The values are whole numbers (numbers()),
// and transfer.sh accepts digits only, because it word-splits them into the ssh command line.
const SSH_ENV = [["ssh_connect_timeout", "FILER_PRO_SSH_CONNECT_TIMEOUT"], ["ssh_alive_interval", "FILER_PRO_SSH_ALIVE_INTERVAL"], ["ssh_alive_count", "FILER_PRO_SSH_ALIVE_COUNT"]];
export function sshEnv(limits) {
  const plain = numbers(null);
  if (SSH_ENV.every(([k]) => limits[k] === plain[k])) return [];
  return ["env", ...SSH_ENV.map(([k, name]) => `${name}=${limits[k]}`)];
}

// `x <path>`: prints y when the path exists (also as a dangling link), d when it is a directory (also through a link),
// l when it is a symlink.
export const EXISTS_SCRIPT = 'if test -e "$1" || test -L "$1"; then echo y; fi; if test -d "$1"; then echo d; fi; if test -L "$1"; then echo l; fi';
// `x <dir>`: the physical path of <dir> (symlinks resolved, also ahead of a "..": cd -P), empty when it cannot be entered.
export const RESOLVE_SCRIPT = 'cd -P -- "$1" 2>/dev/null && pwd -P';
// `x <dest> [<info> [<mount>]]`: for a real folder as <dest> (no link) the message of MOUNT_FN on stdout when a file
// system is mounted in it ("Refusing to replace, a file system is mounted at: <m>"), else nothing; always exit 0 (a probe
// counts any other code as a transport failure). MOUNT_FN compares strings first, so the folder is resolved physically first
// (cd -P; the "x" keeps a trailing newline of the name). <info> and <mount> stand in for the tables (tests only).
// transfer.sh checks the same once more right before it sets the old folder aside.
export const REPLACE_CHECK_SCRIPT = `${MOUNT_FN}
[ -d "$1" ] && [ ! -L "$1" ] || exit 0
n=\${1##*/} d=\${1%/*}; [ -n "$d" ] || d=/
P=$(cd -P -- "$d" 2>/dev/null && pwd -P && printf x); P=\${P%x}; P=\${P%"
"}
[ -n "$P" ] || { echo "Could not check the path: $d"; exit 0; }
case $P in /) P=/$n ;; *) P=$P/$n ;; esac
V=replace
mounted "$P" "$2" "$3" 2>&1
exit 0`;
// `x <dir>`: NUL-terminated entry names of <dir> as ./name.
export const LIST_SCRIPT = 'cd -- "$1" && find . ! -name . -prune -print0';

// `x <temp> <id>`: after a hard kill on a machine (direction remote) the cp there can outlive the
// transfer and write on into a removed temp. Stops it first, like transfer.sh's own cancel: pkill on a
// pattern that starts at "cp" and ends at the temp name (it never matches this shell, whose command
// line ends with the id), waits up to 5 s, then removes the temp. An id outside [a-z0-9] only removes.
export const STOP_REMOVE_SCRIPT = `case $2 in ""|*[!a-z0-9]*) ;; *)
  pat="(^|/)cp -R -P -p -- .*fs-$2\\.part\$"
  pkill -f "$pat"; n=0
  while pgrep -f "$pat" >/dev/null 2>&1 && [ $n -lt 25 ]; do sleep 0.2; n=$((n + 1)); done ;;
esac
rm -rf -- "$1"`;

// A move across sides must never delete the folder it copies into (#100). Two names can reach one folder (an alias, a
// localhost machine, another spelling of one SSH host, a shared mount): so a marker file goes into the source's parent folder
// on the source side, and the target folder and its parents are searched for it on the target side.
// `x <dir> <id>`: creates <dir>/.filer-pro-mark-<id> and never overwrites a file (set -C); exit 0 on success, 1 otherwise.
export const MARK_SCRIPT = 'set -C; : > "$1/.filer-pro-mark-$2" 2>/dev/null || exit 1; exit 0';
// `x <dir> <id>`: removes the marker, always exit 0.
export const UNMARK_SCRIPT = 'rm -f -- "$1/.filer-pro-mark-$2" 2>/dev/null; exit 0';
// `x <destDir> <id> <srcName>`: from the physical <destDir> up to /, the first folder F that holds the marker decides:
// "same" when F is <destDir> itself, "inside" when the first component of the way down from F is the entry F/<srcName>
// (-ef: the same entry, also under another spelling), else nothing. No marker: nothing. Exit 3 when <destDir> cannot be entered.
export const OVERLAP_SCRIPT = `d=$1 id=$2 n=$3
cd -P -- "$d" 2>/dev/null || exit 3
c=$(pwd -P) b=
while :; do
  if [ -e "$c/.filer-pro-mark-$id" ]; then
    if [ -z "$b" ]; then echo same
    else
      f=\${b%%/*}
      if [ "$c/$f" -ef "$c/$n" ]; then echo inside; fi
    fi
    exit 0
  fi
  [ "$c" = / ] && exit 0
  b=\${c##*/}\${b:+/$b}
  c=\${c%/*}; [ -n "$c" ] || c=/
done`;

const okOut = (r) => (r && r.code === 0 ? r.stdout : null);

// The line transfer.sh writes when a Replace on a machine could not remove the set-aside old copy (the job stays done).
// The path runs to the end of stderr: a name may hold a newline, and nothing is written after this line.
const LINKS_OUTSIDE = /^Warning: (\d+ links? points? outside the extracted files)\r?$/m;
const OLD_COPY_LEFT = /(?:^|\n)Warning: could not fully remove old copy: ([\s\S]*)$/;

export function createJobs(deps) {
  const { exec, hc, readTextFile, getShared, setShared, notify, now, newId, appHome, home } = deps;
  // The numbers of lib/settings.js, checked again here (whole numbers in range, else the default).
  const limits = () => numbers(deps.settings?.() ?? null);
  const explainError = (stderr, host, fallback, direction) => explainRaw(stderr, host, fallback, { localPlatform: deps.localPlatform?.(), direction });
  const mountTables = deps.mountTables ?? []; // [infoPath, mountPath] for REPLACE_CHECK_SCRIPT, tests only

  const all = () => getShared(KEY) || {};
  const get = (id) => all()[id];
  const put = (job) => setShared(KEY, { ...all(), [job.id]: job });
  function update(id, patch) {
    const job = { ...get(id), ...patch };
    put(job);
    return job;
  }

  // Side of the transfer where a path lives (null = this computer): the source is remote for down, the destination for
  // up; local copies stay on this computer, remote ones on the machine. A copy between machines (cross) reads on `from`
  // (the source machine) and writes on `machine` (the target machine). A job snapshot without `from` is never cross.
  const srcOn = (direction, machine, from) => (direction === "down" || direction === "remote" ? machine : direction === "cross" ? from ?? null : null);
  const destOn = (direction, machine) => (direction === "up" || direction === "remote" || direction === "cross" ? machine : null);

  // Any non-zero code is a transport failure (the probe scripts themselves always exit 0). Without stderr the
  // message stays empty, so the caller's fallback text applies (explainError), never "exit code N" (#48).
  async function probe(script, path, on) {
    const r = await exec("sh", ["-c", script, "x", path], { on });
    if (r.code !== 0) throw new Error(r.stderr ?? "");
    return r.stdout;
  }

  // Bytes of a COMPLETE sum, else null (a path the script could not read all of, or that it stopped after SIZE_LIMIT_MS, is unknown).
  async function measure(path, on) {
    try {
      return parseSize(okOut(await exec("sh", sizeArgs(path, SIZE_LIMIT_MS), { on, timeout: SIZE_LIMIT_MS + SIZE_GRACE_MS })));
    } catch {
      return null;
    }
  }

  // State of the temp of a running job, for tick(): { bytes } (a complete sum, or the lower bound of an incomplete one),
  // { gone } (no such path, or the probe failed: no progress, no stall), { unknown } (the watchdog stopped find: neither
  // progress nor a stall, the clock stays where it was).
  async function pollTemp(path, on) {
    try {
      const out = okOut(await exec("sh", sizeArgs(path, TEMP_POLL_MS), { on, timeout: TEMP_POLL_MS + SIZE_GRACE_MS }));
      const v = parseSizeOutput(out);
      if (!v) return { gone: true };
      return v.timedOut ? { unknown: true } : { bytes: v.bytes };
    } catch {
      return { gone: true };
    }
  }

  // Size of a source for the warning before a copy between machines (requests.js): null when it is unknown or takes
  // longer than timeoutMs plus one second, so a big folder holds the dialog up for 5 s per entry at most.
  async function sourceSize({ direction, machine, from, src }, timeoutMs = SOURCE_SIZE_MS) {
    try {
      return parseSize(okOut(await exec("sh", sizeArgs(src, timeoutMs), { on: srcOn(direction, machine, from), timeout: timeoutMs + SOURCE_GRACE_MS })));
    } catch {
      return null;
    }
  }

  function notifyMove(job) {
    if (job.moved) {
      notify({ title: "Moved", body: job.name, level: "success", ...(job.direction === "down" ? { action: { name: "filer-pro.reveal" } } : {}) });
      if (job.direction === "down") setShared("filer-pro.last_download", job.dest);
    } else if (typeof job.kept === "string") {
      notify({ title: "Copied, source kept", body: [job.kept, job.warning].filter(Boolean).join(" "), level: "warning" });
    }
  }

  function notifyEnd(job) {
    if (job.preview) return;
    if (job.kind === "extract") { // never last_download, Finder or the clipboard: the archive stays where it was
      if (job.state === "failed") notify({ title: "Extract failed", body: job.error, level: "error" });
      else if (job.state === "done" && job.warning) notify({ title: "Extracted", body: job.warning, level: "warning" });
      else if (job.state === "done") notify({ title: "Extracted", body: job.name, level: "success" });
      return;
    }
    if (job.state === "failed") {
      const title = { down: "Download failed", up: "Upload failed", local: "Copy failed", remote: "Copy failed", cross: "Copy failed" }[job.direction];
      notify({ title, body: job.error, level: "error" });
    } else if (job.state === "done" && job.move) { // a move job (#100): Moved, or the copy with its original kept
      notifyMove(job);
    } else if (job.state === "done" && job.warning) { // done, but something stayed behind (#46): one warning toast
      const title = { down: "Downloaded", up: "Uploaded", local: "Copied", remote: "Copied", cross: "Copied" }[job.direction];
      notify({ title, body: job.warning, level: "warning" });
    } else if (job.state === "done" && (job.direction === "remote" || job.direction === "cross")) {
      notify({ title: "Copied", body: job.name, level: "success" });
    } else if (job.state === "done" && job.direction !== "up") {
      notify({ title: job.direction === "down" ? "Downloaded" : "Copied", body: job.name, level: "success", action: { name: "filer-pro.reveal" } });
      setShared("filer-pro.last_download", job.dest);
    } else if (job.state === "done") {
      notify({ title: "Uploaded", body: job.name, level: "success" });
    }
  }

  function end(id, patch) {
    const job = update(id, { finishedAt: now(), ...patch });
    notifyEnd(job);
    // The tree reloads at once, also after a failed or cancelled job: it may have written part of a folder (issue #31,
    // no timer catches up on a machine).
    if (!job.preview) setShared("filer-pro.changed", { at: now() });
    if (job.state === "done" && job.moved && job.move) { // only a job that moved leaves the Cut: its item goes, a kept job never touches it
      const clip = getShared("filer-pro.clipboard");
      if (clip?.cut === true && clip.at === job.move.clipAt && (clip.machine ?? null) === (job.move.srcOn ?? null)) {
        const items = clipItems(clip).filter((i) => i.path !== job.src);
        const { path: _path, isDir: _isDir, items: _items, ...base } = clip;
        setShared("filer-pro.clipboard", items.length === 0 ? null : { ...base, items });
      }
    }
    if (job.state === "done" && !job.move) { // a Cut waiting on this copy ("Copy instead", requests.js runMove) is complete now
      const clip = getShared("filer-pro.clipboard");
      const idOf = (e) => (typeof e === "string" ? e : e?.id);
      const mine = Array.isArray(clip?.copyJobs) ? clip.copyJobs.find((e) => idOf(e) === id) : undefined;
      if (typeof mine === "string") { // old entry: every named job done empties the clipboard
        const rest = clip.copyJobs.filter((j) => j !== id && all()[j]?.state !== "done");
        setShared("filer-pro.clipboard", rest.length > 0 ? { ...clip, copyJobs: rest } : null);
      } else if (mine) { // { id, path } (#99): only that item leaves the Cut list
        const items = clipItems(clip).filter((i) => i.path !== mine.path);
        const copyJobs = clip.copyJobs.filter((e) => idOf(e) !== id);
        const { path: _path, isDir: _isDir, items: _items, copyJobs: _old, ...base } = clip;
        setShared("filer-pro.clipboard", items.length === 0 ? null : { ...base, items, ...(copyJobs.length > 0 ? { copyJobs } : {}) });
      }
    }
    if (job.state === "done" && (job.direction === "down" || job.direction === "local") && job.reveal && (!job.move || job.moved)) {
      afterDownload(job, { exec, notify, platform, now }).catch(() => {}); // true: Finder; "open" / "preview": open after the checks
    }
    return job;
  }

  const fail = (id, error) => end(id, { state: "failed", error: cleanText(error) });

  // Physical path of a folder; if it cannot be resolved the spelled path is used (the string
  // check still catches the plain cases, and the copy itself fails cleanly otherwise).
  async function physical(path, on) {
    try {
      const r = await exec("sh", ["-c", RESOLVE_SCRIPT, "resolve", path], { on });
      const out = r.code === 0 ? r.stdout.split("\n")[0] : "";
      if (out) return out;
    } catch {
      // fall through to the spelled path
    }
    return path;
  }

  // True when destDir is the folder src or lies below it, after resolving links; letter case is
  // ignored on this Mac, a machine compares exactly.
  async function intoItself(src, destDir, on) {
    const key = (p) => { const n = p.replace(/\/+$/, "") || "/"; return on ? n : platform.pathKey(n); };
    const from = key(await physical(src, on)), into = key(await physical(destDir, on));
    return into === from || into.startsWith(from === "/" ? "/" : `${from}/`);
  }

  // true when both machine names resolve to the identical SSH target string, false when they differ, null when the lookup
  // failed or a name has no target (#100: a move does not guess).
  async function sameMachine(a, b) {
    try {
      const out = okOut(await hc(["machine", "ls", "--json"]));
      if (out === null) return null;
      const ta = sshTarget(out, a), tb = sshTarget(out, b);
      return ta.error || tb.error ? null : ta.target === tb.target;
    } catch {
      return null;
    }
  }
  // A failed lookup counts as false: a copy is not blocked on that basis.
  const sameSshTarget = async (a, b) => (await sameMachine(a, b)) === true;

  // Before a move deletes anything: is the target folder the original's own folder, or below the original? The marker is
  // always removed again. Returns { ok: true } or { error }.
  async function overlap({ direction, machine, from, src, destDir }) {
    const id = newId(), srcSide = srcOn(direction, machine, from), destSide = destOn(direction, machine);
    const refuse = { error: "Could not check whether the target is the original's folder" };
    const parent = parentOf(src);
    try {
      let r;
      try {
        r = await exec("sh", ["-c", MARK_SCRIPT, "x", parent, id], { on: srcSide });
      } catch {
        return refuse;
      }
      if (r.code !== 0) return refuse;
      let p;
      try {
        p = await exec("sh", ["-c", OVERLAP_SCRIPT, "x", destDir, id, baseName(src)], { on: destSide });
      } catch {
        return refuse;
      }
      if (p.code !== 0) return refuse;
      const word = String(p.stdout ?? "").trim();
      if (word === "same") return { error: "The target is the original's own folder" };
      if (word === "inside") return { error: "Cannot move a folder into itself" };
      return { ok: true };
    } finally {
      await exec("sh", ["-c", UNMARK_SCRIPT, "x", parent, id], { on: srcSide }).catch(() => {});
    }
  }

  async function inspect({ direction, machine, from, src, destDir }) {
    const name = baseName(src);
    const dest = joinPath(destDir, name);
    const srcSide = srcOn(direction, machine, from);
    // The error of a probe on the source is explained with the machine that holds the source (from for cross); the rest with machine.
    let host = direction === "cross" ? from : machine;
    try {
      const out = await probe(EXISTS_SCRIPT, src, srcSide);
      host = machine;
      if (!out.includes("y")) return { name, isDir: false, exists: false, linkWarning: null, linkTitle: null, error: `No such file or folder: ${src}` };
      const isDir = out.includes("d");
      const srcIsLink = out.includes("l");
      if (!(await probe(EXISTS_SCRIPT, destDir, destOn(direction, machine))).includes("d")) {
        return { name, isDir, exists: false, linkWarning: null, linkTitle: null, error: `Target folder does not exist: ${destDir}` };
      }
      if ((direction === "local" || direction === "remote") && isDir && (await intoItself(src, destDir, destOn(direction, machine)))) {
        return { name, isDir, exists: false, linkWarning: null, linkTitle: null, error: "Cannot copy a folder into itself" };
      }
      // Two herdr machine names can point to one SSH target: the paste is "cross", but both sides are the same tree (#72).
      if (direction === "cross" && isDir && (await sameSshTarget(machine, from)) && (await intoItself(src, destDir, machine))) {
        return { name, isDir, exists: false, linkWarning: null, linkTitle: null, error: "Loophole: A folder can't go inside itself!" };
      }
      const destOut = await probe(EXISTS_SCRIPT, dest, destOn(direction, machine));
      const exists = destOut.includes("y");
      // Replace on a machine deletes the old folder for good (rm -rf, transfer.sh): a mounted file system in it would
      // be emptied. Like Move, Replace stays a choice and is refused after it (requests.js runTransfers). Locally the
      // old entry goes to the Trash by mv (on another volume than the Trash: copied there, then deleted).
      let replaceError = null;
      if (exists && destOut.includes("d") && (direction === "up" || direction === "remote" || direction === "cross")) {
        const r = await exec("sh", ["-c", REPLACE_CHECK_SCRIPT, "x", dest, ...mountTables], { on: destOn(direction, machine) });
        if (r.code !== 0) throw new Error(r.stderr ?? ""); // no message: "Could not check the path" below (#48)
        replaceError = cleanText(String(r.stdout ?? "")) || null;
      }
      // A copy on one computer (cp -P) copies a linked folder as the link, and transfer.sh's merge does not follow it:
      // Merge into a real folder would do nothing (#46). The dialog leaves Merge out, a preset or Apply to all is refused
      // after the answer (requests.js runTransfers); transfer.sh refuses the same once more. scp follows the link.
      const mergeError = (direction === "local" || direction === "remote") && srcIsLink && isDir && exists && destOut.includes("d") && !destOut.includes("l")
        ? `Cannot merge a symlink into a folder: ${src}` : null;
      let w = null;
      if (isDir && (direction === "down" || direction === "up" || direction === "cross")) { // cp -P never follows links, so a copy on one machine needs no check
        try {
          w = linkWarning(parseLinks(okOut(await exec("sh", ["-c", LINKS_SCRIPT, "links", src], { on: srcSide }))), name);
        } catch {
          w = linkWarning(null, name);
        }
      }
      // What is in the way (#54): a link counts as no folder, Replace and the dialog treat it as the link itself.
      const destIsDir = destOut.includes("d") && !destOut.includes("l");
      return {
        name, isDir, exists, ...(exists ? { destIsDir } : {}), linkWarning: w?.text ?? null, linkTitle: w?.title ?? null,
        ...(w?.blocked ? { linkBlocked: true } : {}), ...(replaceError ? { replaceError } : {}), ...(mergeError ? { mergeError } : {}),
      };
    } catch (e) {
      return { name, isDir: false, exists: false, linkWarning: null, linkTitle: null, error: explainError(String(e?.message ?? e), host, "Could not check the path") };
    }
  }

  // preview: a Load of the file view (main.js fetchLoad): the view shows the outcome, so the job ends without toast,
  // last_download, changed or reveal. as: the file name at the destination (loads/<key>/<key>.<ext>), the source name
  // stays the job's name. `as` only goes with choice "new"; the keep_both branch below is untouched.
  async function start({ direction, machine, from, src, destDir, choice, isDir = false, reveal = false, preview = false, as = null, move = null }) {
    const id = newId();
    const name = baseName(src), file = as ?? name;
    const statusFile = `${appHome()}/filer-pro/jobs/${id}.status`;
    const startedAt = now();
    let job = {
      id, direction, machine, ...(direction === "cross" ? { from } : {}), target: null, src, name, destDir, dest: joinPath(destDir, file),
      temp: joinPath(destDir, tempName(file, id)), isDir, mode: choice === "keep_both" ? "new" : choice,
      state: "running", total: null, bytes: 0, rate: 0, percent: null, error: null, terminal: null,
      startedAt, lastGrowthAt: startedAt, at: startedAt, statusFile, stalled: false, finishedAt: null,
      ...(reveal ? { reveal } : {}),
      ...(preview ? { preview: true } : {}),
      ...(move ? { move: { root: move.root, clipAt: move.clipAt, srcOn: srcOn(direction, machine, from) } } : {}),
    };

    let t = { target: null }, srcT = null;
    if (direction !== "local") {
      try {
        const ls = okOut(await hc(["machine", "ls", "--json"])) ?? "";
        t = sshTarget(ls, machine);
        if (direction === "cross" && !t.error) srcT = sshTarget(ls, from); // a cross job needs the SSH target of the source machine too
      } catch (e) {
        put(job);
        return fail(id, explainError(String(e?.message ?? e), machine, "Could not start the transfer"));
      }
      if (t.error || srcT?.error) {
        put(job);
        return fail(id, t.error ?? srcT.error);
      }
    }
    job.target = t.target;
    if (srcT) job.srcTarget = srcT.target;

    let taken = null;
    if (choice === "keep_both") {
      try {
        const out = await probe(LIST_SCRIPT, destDir, destOn(direction, machine));
        // Keys without letter case and Unicode normalization on every side (#33): A.TXT meets a.txt in the listing.
        taken = new Set(out.split("\0").filter(Boolean).map((e) => nameKey(e.replace(/^\.\//, ""))));
      } catch (e) {
        put(job);
        return fail(id, explainError(String(e?.message ?? e), t.target, "Could not list the folder"));
      }
    }
    // From here to put() nothing is awaited, so parallel starts see each other's reserved names.
    if (taken) {
      for (const j of Object.values(all())) {
        if (j.state === "running" && typeof j.destDir === "string" && normalizePath(j.destDir) === normalizePath(destDir) && destOn(j.direction, j.machine) === destOn(direction, machine)) taken.add(nameKey(baseName(j.dest)));
      }
      const unique = keepBothName(name, taken, nameKey);
      job = { ...job, name: unique, dest: joinPath(destDir, unique), temp: joinPath(destDir, tempName(unique, id)) };
    }
    put(job);

    // A move (#100): before one byte is copied the original gets its guard check and its numbers. Without either, nothing is
    // copied, so nothing can be deleted later.
    let moveTotal = null;
    if (move) {
      const sOn = srcOn(direction, machine, from);
      if (typeof move.root !== "string" || move.root === "" || !deps.fileOps) return fail(id, KEPT_NO_ROOT);
      try {
        const c = await deps.fileOps.check({ on: sOn, path: src, root: move.root, timeout: VERIFY_MS });
        if (!c.ok) return fail(id, c.error);
        const before = parseVerify(okOut(await exec("sh", verifyArgs(src, "L"), { on: sOn, timeout: VERIFY_MS })));
        if (!before) return fail(id, "Could not check the original before the copy");
        moveTotal = before.bytes;
        job = update(id, { move: { ...get(id).move, physical: c.path, before } });
      } catch (e) {
        return fail(id, explainError(String(e?.message ?? e), sOn ?? machine, "Could not check the original before the copy"));
      }
    }

    try {
      const t0 = now();
      const total = move ? moveTotal : await measure(src, srcOn(direction, machine, from));
      const total2 = move ? total : total !== null && now() - t0 <= SIZE_LIMIT_MS ? total : null;
      if (get(id).cancelRequested) return end(id, { state: "cancelled", total: total2 });
      job = update(id, { total: total2, percent: null });
      await exec("mkdir", ["-p", `${appHome()}/filer-pro/jobs`], { on: null });
      const r = await hc([
        "run", "--bg", "--json", "--no-parent", "--no-notify", "--name", `fs-${id}`, "--",
        ...sshEnv(limits()),
        "sh", `${appHome()}/mods/filer-pro/bin/transfer.sh`,
        direction, job.mode, t.target ?? "-", src, job.dest, job.temp, statusFile, platform.trashDir(home()),
        ...(srcT ? [srcT.target] : []), // only cross: the SSH target of the source machine, the 9th argument
      ]);
      if (r.code !== 0) return fail(id, explainError(r.stderr, t.target, "Could not start the transfer"));
      const terminal = JSON.parse(r.stdout).address;
      if (typeof terminal !== "string") return fail(id, "Could not start the transfer");
      const started = update(id, { terminal });
      if (started.cancelRequested) await hc(["kill", terminal]).catch(() => {});
      return started;
    } catch (e) {
      return fail(id, explainError(String(e?.message ?? e), t.target));
    }
  }

  // The archive menu (#57): everything the request needs to ask before anything is written. how: "here" (the top-level
  // entries of the archive land in its folder) or "to" (one folder named like the archive). The probe runs on the
  // archive's side; the size look (only with spaceCheck) is a separate, shorter exec whose failure never refuses.
  // Returns { name, stem, family, tool, need, total, destDir, entries: [{ name, isDir, exists, destIsDir?, replaceError? }],
  // taken: [names in the folder] } or { error }.
  async function inspectArchive({ machine, src, how, spaceCheck }) {
    const on = machine ?? null, name = baseName(src);
    const type = archiveOf(name);
    if (!type) return { error: `Not an archive: ${name}` };
    const destDir = parentOf(src);
    try {
      const here = await probe(EXISTS_SCRIPT, src, on);
      if (!here.includes("y")) return { error: `No such file or folder: ${src}` };
      if (here.includes("d")) return { error: `Not an archive: ${name}` };
      const r = await exec("sh", ["-c", ARCHIVE_PROBE_SCRIPT, "x", type.family, type.need, src], { on, timeout: 600000 });
      if (r.code === 3) return { error: missingTool(/^missing=(.+)$/m.exec(String(r.stdout ?? ""))?.[1] ?? type.need, machine) };
      if (r.code === 5) return { error: tooManyMembers(Number(/^count=(\d+)$/m.exec(String(r.stdout ?? ""))?.[1])) };
      if (r.code !== 0) return { error: explainError(r.stderr ?? "", machine, "Could not read the archive") };
      // in slices, one QuickJS job each, and ends with an error instead of never when herdr interrupts a job
      const checked = await checkListing(r.stdout, { family: type.family, stem: type.stem, after: deps.after ?? null });
      if (checked.error) return { error: checked.error };
      const { probe: p, tops } = checked;
      let total = null;
      if (spaceCheck) {
        try {
          // the probe's long listing gave the size of a tar: the script only asks df then ("-"), no further unpacking
          const known = Number.isFinite(p.size);
          const s = await exec("sh", ["-c", ARCHIVE_SIZE_SCRIPT, "x", known ? "-" : p.tool, src, destDir], { on, timeout: 120000 });
          if (s.code === 0) {
            const m = parseArchiveSize(s.stdout);
            const size = known ? p.size : m.size;
            const e = spaceError(size, m.avail);
            if (e) return { error: e };
            total = size;
          }
        } catch {
          // no measurement, no refusal
        }
      }
      const entries = how === "to" ? [{ name: type.stem, isDir: true }] : tops;
      const listed = (await probe(LIST_SCRIPT, destDir, on)).split("\0").filter(Boolean).map((e) => e.replace(/^\.\//, ""));
      const keys = new Set(listed.map(nameKey));
      const out = [];
      for (const e of entries) {
        if (!keys.has(nameKey(e.name))) { out.push({ ...e, exists: false }); continue; }
        const dest = joinPath(destDir, e.name);
        const o = await probe(EXISTS_SCRIPT, dest, on);
        const exists = o.includes("y");
        let replaceError = null;
        if (exists && o.includes("d") && machine) {
          const c = await exec("sh", ["-c", REPLACE_CHECK_SCRIPT, "x", dest, ...mountTables], { on });
          if (c.code !== 0) throw new Error(c.stderr ?? "");
          replaceError = cleanText(String(c.stdout ?? "")) || null;
        }
        out.push({ ...e, exists, ...(exists ? { destIsDir: o.includes("d") && !o.includes("l") } : {}), ...(replaceError ? { replaceError } : {}) });
      }
      return { name, stem: type.stem, family: type.family, tool: p.tool, need: type.need, total, destDir, entries: out, taken: listed };
    } catch (e) {
      return { error: explainError(String(e?.message ?? e), machine, "Could not read the archive") };
    }
  }

  // Starts extract.sh for an inspected archive. plan: [{ entry, mode: skip|new|replace|merge, name }] for the entries that
  // are not plain "new under their own name". The job shows the folder for "to", else the archive; names are the final
  // top-level names it creates (a later Extract in the same folder keeps clear of them).
  async function startExtract({ machine, src, how, info, plan = [] }) {
    const id = newId();
    const on = machine ?? null, destDir = info.destDir, archiveName = info.name;
    const statusFile = `${appHome()}/filer-pro/jobs/${id}.status`;
    const startedAt = now();
    const to = how === "to";
    const finalOf = (entry) => plan.find((p) => p.entry === entry)?.name ?? entry;
    const finalName = to ? finalOf(info.stem) : null;
    const names = to ? [finalName] : info.entries.filter((e) => plan.find((p) => p.entry === e.name)?.mode !== "skip").map((e) => finalOf(e.name));
    let job = {
      id, kind: "extract", direction: on ? "remote" : "local", machine: on, target: null, src, name: to ? finalName : archiveName, destDir,
      dest: to ? joinPath(destDir, finalName) : destDir, temp: joinPath(destDir, tempName(archiveName, id)), names, isDir: to, mode: how,
      state: "running", total: info.total ?? null, bytes: 0, rate: 0, percent: null, error: null, terminal: null,
      startedAt, lastGrowthAt: startedAt, at: startedAt, statusFile, stalled: false, finishedAt: null,
    };
    let target = null;
    if (on) {
      try {
        const t = sshTarget(okOut(await hc(["machine", "ls", "--json"])) ?? "", on);
        if (t.error) { put(job); return fail(id, t.error); }
        target = t.target;
      } catch (e) {
        put(job);
        return fail(id, explainError(String(e?.message ?? e), on, "Could not start the extraction"));
      }
    }
    job.target = target;
    put(job);
    try {
      await exec("mkdir", ["-p", `${appHome()}/filer-pro/jobs`], { on: null });
      if (get(id).cancelRequested) return end(id, { state: "cancelled" });
      const words = [...sshEnv(limits()).slice(1), ...(on ? [`FILER_PRO_MACHINE=${on}`] : [])];
      const r = await hc([
        "run", "--bg", "--json", "--no-parent", "--no-notify", "--name", `fs-${id}`, "--",
        ...(words.length ? ["env", ...words] : []),
        "sh", `${appHome()}/mods/filer-pro/bin/extract.sh`,
        target ?? "-", info.tool, info.family === "tar" ? info.need : "-", src, to ? info.stem : "-", info.family === "single" ? info.stem : "-",
        job.temp, destDir, statusFile, platform.trashDir(home()),
        ...plan.flatMap((p) => [p.entry, p.mode, p.name]),
      ]);
      if (r.code !== 0) return fail(id, explainError(r.stderr, target, "Could not start the extraction"));
      const terminal = JSON.parse(r.stdout).address;
      if (typeof terminal !== "string") return fail(id, "Could not start the extraction");
      const started = update(id, { terminal });
      if (started.cancelRequested) await hc(["kill", terminal]).catch(() => {});
      return started;
    } catch (e) {
      return fail(id, explainError(String(e?.message ?? e), target));
    }
  }

  async function readStatus(job) {
    let text = null;
    try {
      text = await readTextFile(job.statusFile);
    } catch {
      text = null;
    }
    if (text === null || text === undefined) return null;
    const lines = text.split("\n");
    const state = lines.find((l) => l.startsWith("state="))?.slice(6);
    const stderr = lines.filter((l) => !l.startsWith("state=") && !l.startsWith("code=")).join("\n");
    return { state, stderr };
  }

  // The temp a killed transfer left behind; for a copy on a machine the cp there is stopped first.
  async function removeTemp(job) {
    const on = destOn(job.direction, job.machine);
    if (job.kind === "extract") { // stops the extractor of that job (by its id in the side shell's arguments), then removes the temp
      await exec("sh", ["-c", EXTRACT_STOP_SCRIPT, "x", job.temp, job.id], { on }).catch(() => {});
      return;
    }
    const run = job.direction === "remote"
      ? exec("sh", ["-c", STOP_REMOVE_SCRIPT, "x", job.temp, job.id], { on })
      : exec("rm", ["-rf", "--", job.temp], { on });
    await run.catch(() => {});
  }

  // The terminal is over (or gone): derive the end state and clean up.
  async function settle(id, info) {
    const job = get(id);
    const status = await readStatus(job);
    if (info.gone && !status) {
      await removeTemp(job);
      end(id, { state: "failed", error: "Interrupted" });
    } else if (status?.state === "done" && job.move && (info.recovered || job.move.recovered)) {
      // A move whose copy finished while Herdr was away, or after a restart: nothing is checked, nothing is deleted.
      end(id, { state: "done", error: null, percent: 100, kept: KEPT_RESTART });
    } else if (status?.state === "done") {
      const m = OLD_COPY_LEFT.exec(status.stderr);
      const left = m ? cleanText(m[1]) : "";
      const oldCopy = left ? `Could not fully remove the old copy: ${left}` : "";
      // An extract also reports links that point outside the extracted files (extract.sh writes that line first).
      const warning = job.kind === "extract" ? [LINKS_OUTSIDE.exec(status.stderr)?.[1], oldCopy].filter(Boolean).join(" ") : oldCopy;
      if (job.move) { // verify, then delete (finishMove); the job is "verifying" until then
        update(id, { state: "verifying", error: null, percent: 100, ...(warning ? { warning } : {}) });
        startFinish(id);
      } else end(id, { state: "done", error: null, percent: 100, ...(warning ? { warning } : {}) });
    } else if (job.stalled) {
      fail(id, "Transfer stalled");
    } else if (status?.state === "cancelled" || (!status && info.reason === "killed")) {
      // Killed hard before the script could clean up: the temp it left is removed here.
      if (!status) await removeTemp(job);
      end(id, { state: "cancelled", error: null });
    } else if (status?.state === "failed") {
      // Known limitation: for cross the host named in a hint is job.target (the target machine), also when the source failed.
      fail(id, explainError(status.stderr, job.target, undefined, job.direction));
    } else {
      fail(id, "Transfer ended unexpectedly");
    }
    if (job.terminal) await hc(["rm", job.terminal]).catch(() => {});
    await exec("rm", ["-f", "--", job.statusFile], { on: null }).catch(() => {});
  }

  async function terminalInfo(job) {
    try {
      const r = await hc(["get", job.terminal, "--json"]);
      return r.code === 0 ? JSON.parse(r.stdout) : null;
    } catch {
      return null;
    }
  }

  // ---- move: verify the copy, then delete the original (#100). Every ending but a verified copy keeps the original.
  const finishing = new Map();
  function startFinish(id) {
    const p = finishMove(id).catch(() => {}).finally(() => finishing.delete(id));
    finishing.set(id, p);
  }
  const drain = async () => { while (finishing.size > 0) await Promise.all([...finishing.values()]); };

  // "Kept" ends the job as done with the reason. Only while the job is still verifying or deleting: a restart (recover) or
  // a later holder of the lease may have ended it already, and a late result never overwrites that.
  function keep(id, reason) {
    if (get(id)?.state === "verifying" || get(id)?.state === "deleting") end(id, { state: "done", kept: reason });
  }

  async function measureFor(path, on, links) {
    try {
      return parseVerify(okOut(await exec("sh", verifyArgs(path, links), { on, timeout: VERIFY_MS })));
    } catch {
      return null;
    }
  }

  async function finishMove(id) {
    try {
      const job = get(id), mv = job?.move;
      if (!mv || typeof mv.physical !== "string" || mv.physical === "" || !mv.before || typeof mv.root !== "string" || mv.root === "" || !deps.fileOps) return keep(id, KEPT_UNKNOWN);
      const sOn = mv.srcOn ?? null;
      const target = await measureFor(job.dest, destOn(job.direction, job.machine), "P");
      const source = await measureFor(job.src, sOn, "L");
      const v = verdict({ before: mv.before, source, target });
      if (v.kept) return keep(id, v.kept);
      // The job may have ended (restart, new lease holder) or be cancelled while the copy was measured.
      const alive = (state) => get(id)?.state === state;
      if (!alive("verifying")) return;
      if (get(id).cancelRequested) return keep(id, KEPT_CANCELLED);
      const c = await deps.fileOps.check({ on: sOn, path: job.src, root: mv.root, timeout: VERIFY_MS });
      if (!c.ok) return keep(id, c.error);
      if (c.path !== mv.physical) return keep(id, KEPT_CHANGED);
      if (!alive("verifying")) return;
      if (get(id).cancelRequested) return keep(id, KEPT_CANCELLED);
      update(id, { state: "deleting" });
      const r = await deps.fileOps.remove({ on: sOn, path: job.src, root: mv.root, expect: mv.physical, timeout: VERIFY_MS });
      if (!alive("deleting")) return;
      if (!r.ok) return keep(id, `Could not delete the original: ${r.error}`);
      end(id, { state: "done", moved: true, ...(r.trashed ? { trashed: true } : {}) });
    } catch {
      keep(id, KEPT_UNKNOWN);
    }
  }

  const running = () => Object.values(all()).filter((j) => j.state === "running");

  async function tick() {
    for (const snap of running()) {
      if (!snap.terminal) continue;
      const poll = await pollTemp(snap.temp, destOn(snap.direction, snap.machine));
      const size = poll.bytes ?? null;
      const cur = get(snap.id);
      if (cur?.state !== "running") continue;
      const p = progressOf({ bytes: cur.bytes, at: cur.at, lastGrowthAt: cur.lastGrowthAt, rate: cur.rate }, size ?? cur.bytes, cur.total, now(), limits().stall_seconds * 1000);
      // A missing temp (not created yet, or already moved away while finalizing) is no stall.
      // Finalizing an extract moves entries out of the temp, so for it any change of the size is progress (R8).
      const moved = cur.kind === "extract" && size !== null && size !== cur.bytes;
      const stalled = size !== null && !moved && p.stalled;
      const lastGrowthAt = poll.unknown ? cur.lastGrowthAt : size === null ? p.at : moved ? now() : p.lastGrowthAt;
      const job = update(cur.id, { bytes: p.bytes, at: p.at, lastGrowthAt, percent: p.percent, rate: p.rate, stalled: cur.stalled || stalled });
      const info = await terminalInfo(job);
      if (info?.state === "finished") {
        await settle(job.id, { reason: info.reason });
      } else if (stalled && !cur.stalled) {
        await hc(["kill", job.terminal]).catch(() => {}); // the job settles when a later tick sees the end
      }
    }
  }

  async function cancel(id) {
    const job = get(id);
    // Verifying and deleting only record the wish: the original is kept before the delete, a running delete finishes.
    if (job?.state === "verifying" || job?.state === "deleting") { update(id, { cancelRequested: true }); return; }
    if (job?.state !== "running") return;
    if (job.terminal) await hc(["kill", job.terminal]);
    else update(id, { cancelRequested: true });
  }

  // After a restart or a lease change. A move job is never verified or deleted from here: finished -> kept, still live -> marked
  // and kept when it finishes, verifying and deleting -> kept (a delete may have run: the text says to check the original).
  async function recover() {
    for (const snap of Object.values(all())) {
      if (!snap.move) continue;
      if (snap.state === "verifying") end(snap.id, { state: "done", kept: KEPT_RESTART });
      else if (snap.state === "deleting") end(snap.id, { state: "done", kept: KEPT_RESTART_DELETE });
    }
    for (const snap of running()) {
      const info = snap.terminal ? await terminalInfo(snap) : null;
      if (!info) await settle(snap.id, { gone: true, recovered: true });
      else if (info.state === "finished") await settle(snap.id, { reason: info.reason, recovered: true });
      else if (snap.move) update(snap.id, { move: { ...snap.move, recovered: true } });
    }
  }

  function clearFinished(keepMs = KEEP_DONE_MS) {
    const next = {};
    for (const [id, j] of Object.entries(all())) {
      const old = (j.state === "done" || j.state === "cancelled") && now() - j.finishedAt > keepMs;
      if (!old) next[id] = j;
    }
    setShared(KEY, next);
  }

  function dismiss(id) {
    const job = get(id);
    if (!job || job.state === "running" || job.state === "verifying" || job.state === "deleting") return;
    const { [id]: _, ...rest } = all();
    setShared(KEY, rest);
  }

  return { inspect, sameMachine, overlap, inspectArchive, startExtract, sourceSize, start, tick, cancel, recover, clearFinished, dismiss, drain };
}
