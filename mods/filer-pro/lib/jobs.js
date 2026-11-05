// Job manager: one `transfer.sh` run per job in its own invisible hc terminal. The manager only
// starts it, polls the temp size and the terminal state, and settles the end state. Pure: every
// herdr API arrives through `deps` (exec, hc, readTextFile, getShared, setShared, notify, now,
// newId, appHome, home; optional settings() -> the config of lib/config.js, read at each use). Jobs live in shared("filer-pro.jobs") as a plain object id -> job.
import { keepBothName, tempName, joinPath, parentOf, baseName, nameKey } from "./names.js";
import { sshTarget } from "./machines.js";
import { explainError, cleanText } from "./errors.js";
import { platform } from "./platform.js";
import { afterDownload } from "./open.js";
import { SIZE_SCRIPT, parseSize } from "./sizes.js";
import { progressOf } from "./progress.js";
import { LINKS_SCRIPT, parseLinks, linkWarning } from "./links.js";
import { MOUNT_FN, normalizePath } from "./fileops.js";
import { numbers } from "./settings.js";

const KEY = "filer-pro.jobs";
const SIZE_LIMIT_MS = 25_000;
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

const okOut = (r) => (r && r.code === 0 ? r.stdout : null);

// The line transfer.sh writes when a Replace on a machine could not remove the set-aside old copy (the job stays done).
// The path runs to the end of stderr: a name may hold a newline, and nothing is written after this line.
const OLD_COPY_LEFT = /(?:^|\n)Warning: could not fully remove old copy: ([\s\S]*)$/;

export function createJobs(deps) {
  const { exec, hc, readTextFile, getShared, setShared, notify, now, newId, appHome, home } = deps;
  // The numbers of lib/settings.js, checked again here (whole numbers in range, else the default).
  const limits = () => numbers(deps.settings?.() ?? null);
  const mountTables = deps.mountTables ?? []; // [infoPath, mountPath] for REPLACE_CHECK_SCRIPT, tests only

  const all = () => getShared(KEY) || {};
  const get = (id) => all()[id];
  const put = (job) => setShared(KEY, { ...all(), [job.id]: job });
  function update(id, patch) {
    const job = { ...get(id), ...patch };
    put(job);
    return job;
  }

  // Side of the transfer where a path lives (null = this computer): the source is remote for down,
  // the destination for up; local copies stay on this computer, remote ones on the machine.
  const srcOn = (direction, machine) => (direction === "down" || direction === "remote" ? machine : null);
  const destOn = (direction, machine) => (direction === "up" || direction === "remote" ? machine : null);

  // Any non-zero code is a transport failure (the probe scripts themselves always exit 0). Without stderr the
  // message stays empty, so the caller's fallback text applies (explainError), never "exit code N" (#48).
  async function probe(script, path, on) {
    const r = await exec("sh", ["-c", script, "x", path], { on });
    if (r.code !== 0) throw new Error(r.stderr ?? "");
    return r.stdout;
  }

  async function measure(path, on) {
    try {
      return parseSize(okOut(await exec("sh", ["-c", SIZE_SCRIPT, "size", path], { on })));
    } catch {
      return null;
    }
  }

  function notifyEnd(job) {
    if (job.preview) return;
    if (job.state === "failed") {
      const title = { down: "Download failed", up: "Upload failed", local: "Copy failed", remote: "Copy failed" }[job.direction];
      notify({ title, body: job.error, level: "error" });
    } else if (job.state === "done" && job.warning) { // done, but something stayed behind (#46): one warning toast
      const title = { down: "Downloaded", up: "Uploaded", local: "Copied", remote: "Copied" }[job.direction];
      notify({ title, body: job.warning, level: "warning" });
    } else if (job.state === "done" && job.direction === "remote") {
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
    if (job.state === "done" && !job.preview) setShared("filer-pro.changed", { at: now() }); // the tree reloads at once
    if (job.state === "done") { // a Cut waiting on this copy ("Copy instead", requests.js runMove) is complete now
      const clip = getShared("filer-pro.clipboard");
      if (Array.isArray(clip?.copyJobs) && clip.copyJobs.includes(id)) {
        const rest = clip.copyJobs.filter((j) => j !== id && all()[j]?.state !== "done");
        setShared("filer-pro.clipboard", rest.length > 0 ? { ...clip, copyJobs: rest } : null);
      }
    }
    if (job.state === "done" && (job.direction === "down" || job.direction === "local") && job.reveal) {
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

  async function inspect({ direction, machine, src, destDir }) {
    const name = baseName(src);
    const dest = joinPath(destDir, name);
    try {
      const out = await probe(EXISTS_SCRIPT, src, srcOn(direction, machine));
      if (!out.includes("y")) return { name, isDir: false, exists: false, linkWarning: null, linkTitle: null, error: `No such file or folder: ${src}` };
      const isDir = out.includes("d");
      const srcIsLink = out.includes("l");
      if (!(await probe(EXISTS_SCRIPT, destDir, destOn(direction, machine))).includes("d")) {
        return { name, isDir, exists: false, linkWarning: null, linkTitle: null, error: `Target folder does not exist: ${destDir}` };
      }
      if ((direction === "local" || direction === "remote") && isDir && (await intoItself(src, destDir, destOn(direction, machine)))) {
        return { name, isDir, exists: false, linkWarning: null, linkTitle: null, error: "Cannot copy a folder into itself" };
      }
      const destOut = await probe(EXISTS_SCRIPT, dest, destOn(direction, machine));
      const exists = destOut.includes("y");
      // Replace on a machine deletes the old folder for good (rm -rf, transfer.sh): a mounted file system in it would
      // be emptied. Like Move, Replace stays a choice and is refused after it (requests.js runTransfers). Locally the
      // old entry goes to the Trash by mv (on another volume than the Trash: copied there, then deleted).
      let replaceError = null;
      if (exists && destOut.includes("d") && (direction === "up" || direction === "remote")) {
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
      if (isDir && (direction === "down" || direction === "up")) { // cp -P never follows links, so a copy on one machine needs no check
        try {
          w = linkWarning(parseLinks(okOut(await exec("sh", ["-c", LINKS_SCRIPT, "links", src], { on: srcOn(direction, machine) }))), name);
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
      return { name, isDir: false, exists: false, linkWarning: null, linkTitle: null, error: explainError(String(e?.message ?? e), machine, "Could not check the path") };
    }
  }

  // preview: a Load of the file view (main.js fetchLoad): the view shows the outcome, so the job ends without toast,
  // last_download, changed or reveal. as: the file name at the destination (loads/<key>/<key>.<ext>), the source name
  // stays the job's name. `as` only goes with choice "new"; the keep_both branch below is untouched.
  async function start({ direction, machine, src, destDir, choice, isDir = false, reveal = false, preview = false, as = null }) {
    const id = newId();
    const name = baseName(src), file = as ?? name;
    const statusFile = `${appHome()}/filer-pro/jobs/${id}.status`;
    const startedAt = now();
    let job = {
      id, direction, machine, target: null, src, name, destDir, dest: joinPath(destDir, file),
      temp: joinPath(destDir, tempName(file, id)), isDir, mode: choice === "keep_both" ? "new" : choice,
      state: "running", total: null, bytes: 0, rate: 0, percent: null, error: null, terminal: null,
      startedAt, lastGrowthAt: startedAt, at: startedAt, statusFile, stalled: false, finishedAt: null,
      ...(reveal ? { reveal } : {}),
      ...(preview ? { preview: true } : {}),
    };

    let t = { target: null };
    if (direction !== "local") {
      try {
        t = sshTarget(okOut(await hc(["machine", "ls", "--json"])) ?? "", machine);
      } catch (e) {
        put(job);
        return fail(id, explainError(String(e?.message ?? e), machine, "Could not start the transfer"));
      }
      if (t.error) {
        put(job);
        return fail(id, t.error);
      }
    }
    job.target = t.target;

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

    try {
      const t0 = now();
      const total = await measure(src, srcOn(direction, machine));
      const total2 = total !== null && now() - t0 <= SIZE_LIMIT_MS ? total : null;
      if (get(id).cancelRequested) return end(id, { state: "cancelled", total: total2 });
      job = update(id, { total: total2, percent: null });
      await exec("mkdir", ["-p", `${appHome()}/filer-pro/jobs`], { on: null });
      const r = await hc([
        "run", "--bg", "--json", "--no-parent", "--no-notify", "--name", `fs-${id}`, "--",
        ...sshEnv(limits()),
        "sh", `${appHome()}/mods/filer-pro/bin/transfer.sh`,
        direction, job.mode, t.target ?? "-", src, job.dest, job.temp, statusFile, platform.trashDir(home()),
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
    } else if (status?.state === "done") {
      const m = OLD_COPY_LEFT.exec(status.stderr);
      const left = m ? cleanText(m[1]) : "";
      end(id, { state: "done", error: null, percent: 100, ...(left ? { warning: `Could not fully remove the old copy: ${left}` } : {}) });
    } else if (job.stalled) {
      fail(id, "Transfer stalled");
    } else if (status?.state === "cancelled" || (!status && info.reason === "killed")) {
      // Killed hard before the script could clean up: the temp it left is removed here.
      if (!status) await removeTemp(job);
      end(id, { state: "cancelled", error: null });
    } else if (status?.state === "failed") {
      fail(id, explainError(status.stderr, job.target));
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

  const running = () => Object.values(all()).filter((j) => j.state === "running");

  async function tick() {
    for (const snap of running()) {
      if (!snap.terminal) continue;
      const size = await measure(snap.temp, destOn(snap.direction, snap.machine));
      const cur = get(snap.id);
      if (cur?.state !== "running") continue;
      const p = progressOf({ bytes: cur.bytes, at: cur.at, lastGrowthAt: cur.lastGrowthAt, rate: cur.rate }, size ?? cur.bytes, cur.total, now(), limits().stall_seconds * 1000);
      // A missing temp (not created yet, or already moved away while finalizing) is no stall.
      const stalled = size !== null && p.stalled;
      const lastGrowthAt = size === null ? p.at : p.lastGrowthAt;
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
    if (job?.state !== "running") return;
    if (job.terminal) await hc(["kill", job.terminal]);
    else update(id, { cancelRequested: true });
  }

  async function recover() {
    for (const snap of running()) {
      const info = snap.terminal ? await terminalInfo(snap) : null;
      if (!info) await settle(snap.id, { gone: true });
      else if (info.state === "finished") await settle(snap.id, { reason: info.reason });
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
    if (!job || job.state === "running") return;
    const { [id]: _, ...rest } = all();
    setShared(KEY, rest);
  }

  return { inspect, start, tick, cancel, recover, clearFinished, dismiss };
}
