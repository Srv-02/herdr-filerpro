// Size probe and byte formatting. Pure; the script runs as `sh -c SIZE_SCRIPT size <path> [<seconds>]`
// locally or on the remote (non-login sh, POSIX tools only, GNU and BSD/macOS).

// Prints one line, exit code always 0: the summed size of all regular files under <path> (a file counts as itself),
// never following symlinks. `-1`: the path does not exist. `<bytes>`: a complete sum. `<bytes> partial`: find ended
// with an error (unreadable folder, a file that vanished), the sum is a lower bound. `<bytes> timeout`: a watchdog
// killed find (by its PID) after <seconds> (default 120), the number is not used. The watchdog is its own process, so
// find ends on the machine at the limit even when the caller is gone. find's status travels through fd 3, like cnt()
// in lib/archives.js, because the exit code of a pipeline is awk's. Every newline is written \\n for the template.
export const SIZE_SCRIPT = `p=$1 n=$2
case $p in -*) p=./$p ;; esac
case $n in ""|*[!0-9]*) n=120 ;; esac
if [ ! -e "$p" ] && [ ! -L "$p" ]; then echo -1; exit 0; fi
if stat -c%s / >/dev/null 2>&1; then f=-c%s; else f=-f%z; fi
r=$( { {
  find -H "$p" -type f -exec stat -L "$f" {} + 2>/dev/null &
  fp=$!
  ( trap 'kill "$sp" 2>/dev/null; exit 0' TERM
    sleep "$n" & sp=$!
    wait "$sp" && kill "$fp" 2>/dev/null ) >/dev/null 2>&1 3>&- &
  wp=$!
  wait "$fp"; rc=$?
  kill "$wp" 2>/dev/null
  echo "rc=$rc" >&3
} 2>/dev/null | awk '{ s += $1 } END { printf "n=%.0f\\n", s }'; } 3>&1 )
s=$(printf '%s\\n' "$r" | sed -n 's/^n=//p')
c=$(printf '%s\\n' "$r" | sed -n 's/^rc=//p')
case $s in ""|*[!0-9]*) s=0 ;; esac
case $c in ""|*[!0-9]*) c=1 ;; esac
if [ "$c" -eq 0 ]; then echo "$s"; elif [ "$c" -gt 128 ]; then echo "$s timeout"; else echo "$s partial"; fi`;

export const SIZE_GRACE_MS = 5000;
export const INCOMPLETE = "Some folders could not be read";

// argv after "sh" for one run with a limit in ms (rounded up to whole seconds, at least 1). The path stays at args[3].
export const sizeArgs = (path, limitMs) => ["-c", SIZE_SCRIPT, "size", path, String(Math.max(1, Math.ceil(limitMs / 1000)))];

// stdout -> { bytes, incomplete, timedOut }, or null (missing path, anything unexpected)
export function parseSizeOutput(stdout) {
  const m = /^\s*(\d+)(?: (partial|timeout))?\s*$/.exec(String(stdout ?? ""));
  if (!m) return null;
  return { bytes: Number(m[1]), incomplete: m[2] === "partial", timedOut: m[2] === "timeout" };
}

// stdout -> bytes of a COMPLETE sum, else null (missing, partial, timeout, junk)
export function parseSize(stdout) {
  const v = parseSizeOutput(stdout);
  return v && !v.incomplete && !v.timedOut ? v.bytes : null;
}

const UNITS = ["B", "kB", "MB", "GB", "TB", "PB"];

export function formatBytes(n) {
  let v = Number.isFinite(n) && n > 0 ? n : 0;
  let i = 0;
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1000;
    i++;
  }
  let r = i > 0 && v < 10 ? Math.round(v * 10) / 10 : Math.round(v);
  if (r >= 1000 && i < UNITS.length - 1) {
    // rounding carried into the next unit, e.g. 999.6 kB
    r = Math.round((r / 1000) * 10) / 10;
    i++;
  } else if (i > 0 && r >= 10 && r !== Math.round(r)) {
    r = Math.round(r);
  }
  const text = i > 0 && r < 10 ? r.toFixed(1) : String(r);
  return `${text} ${UNITS[i]}`;
}

export function formatRate(bps) {
  return `${formatBytes(bps)}/s`;
}

// Calculate Size on a folder (issue #58). The results live in the shared value filer-pro.sizes, an object of
// sizeKey(machine, path) -> { state, id, bytes?, incomplete? }, so every panel copy and the row menu (a separate copy) see them:
// requested (the menu asked), running (a panel copy claimed it and runs SIZE_SCRIPT), done (bytes, always shown with a ~;
// incomplete: some folders could not be read, the number is a lower bound), toolarge (the script stopped find at the limit,
// or no answer within FOLDER_SIZE_MS plus SIZE_GRACE_MS). A failure removes the entry (a toast tells why). Results stay until Refresh or a new
// Calculate Size: a snapshot, not a watch. requested and running carry at (ms): a request nobody claimed within
// CLAIM_MS (the panel moved on to another folder) or a run older than the limit plus a margin (the copy that ran it
// was reloaded or closed) counts as gone, so a row never spins forever and the entry can be used again.
export const FOLDER_SIZE_MS = 120000;
export const CLAIM_MS = 10000;
export const TOO_LARGE = "Too large to calculate";

export const sizeKey = (machine, path) => JSON.stringify([machine ?? null, path]);

export function parseSizeKey(key) {
  try {
    const v = JSON.parse(key);
    return Array.isArray(v) && v.length === 2 && typeof v[1] === "string" ? { machine: v[0] ?? null, path: v[1] } : null;
  } catch { return null; }
}

// Is a run on the way for this entry at time now (ms)?
export function busy(r, now) {
  if (r?.state === "requested") return !(now - r.at > CLAIM_MS);
  if (r?.state === "running") return !(now - r.at > FOLDER_SIZE_MS + CLAIM_MS);
  return false;
}

// The map after the menu asked for the size of path on machine; unchanged (same object) while one is already on the way.
export function requestSize(map, machine, path, id, now) {
  const key = sizeKey(machine, path);
  return busy(map?.[key], now) ? map : { ...(map ?? {}), [key]: { state: "requested", id, at: now } };
}

// The requests this panel copy takes over: those whose path it shows (shows(machine, path)). Returns the claimed
// { key, machine, path, id } and the map with them marked running, or null when there is nothing to claim.
export function claimSizes(map, shows, now) {
  const claimed = [];
  for (const [key, r] of Object.entries(map ?? {})) {
    if (r?.state !== "requested" || !busy(r, now)) continue;
    const at = parseSizeKey(key);
    if (at && shows(at.machine, at.path)) claimed.push({ key, ...at, id: r.id });
  }
  if (!claimed.length) return null;
  const next = { ...map };
  for (const c of claimed) next[c.key] = { state: "running", id: c.id, at: now };
  return { claimed, map: next };
}

// What one SIZE_SCRIPT run ended with. outcome: { result } from exec or { error }; ms: how long it took. A run that
// used up the timeout is too large (exec may answer with a code or reject when it kills the command); a path that
// is gone (-1) or any other failure is an error with its message.
export function sizeResult({ result, error, ms }, timeoutMs = FOLDER_SIZE_MS) {
  const v = error === undefined && result?.code === 0 ? parseSizeOutput(result.stdout) : null;
  if (v?.timedOut) return { state: "toolarge" };
  if (v) return v.incomplete ? { state: "done", bytes: v.bytes, incomplete: true } : { state: "done", bytes: v.bytes }; // an answer just before the limit still counts
  if (ms >= timeoutMs - 1000) return { state: "toolarge" };
  if (error !== undefined) return { state: "failed", error: String(error?.message ?? error) || "Could not calculate the size" };
  if (result?.code !== 0) return { state: "failed", error: String(result?.stderr ?? "").trim() || "Could not calculate the size" };
  return { state: "failed", error: "Folder not found" };
}

// The map with one finished run stored (failed: removed), unless a newer request replaced it meanwhile.
export function storeSize(map, key, id, outcome) {
  if (map?.[key]?.id !== id) return map ?? {};
  const next = { ...map };
  if (outcome.state === "failed") delete next[key];
  else next[key] = { ...outcome, id };
  return next;
}

// The map without the finished (or gone) results of machine at root or below it (Refresh); runs on the way stay.
export function dropSizes(map, machine, root, now) {
  const base = String(root ?? "").replace(/\/+$/, "");
  let next = null;
  for (const [key, r] of Object.entries(map ?? {})) {
    const at = parseSizeKey(key);
    if (!at || busy(r, now) || (at.machine ?? null) !== (machine ?? null)) continue;
    if (at.path === base || at.path.startsWith(`${base}/`)) { next ??= { ...map }; delete next[key]; }
  }
  return next ?? map;
}

// The text of the size column for a row. entry: { dir, size?, bundle? }; result: its filer-pro.sizes entry or undefined.
// -> { text, spin, title? } (title: a tooltip; spin: draw a spinner instead of text). A file shows its size (nothing when unknown); a folder its
// calculated size, a spinner while it runs, "—" before; a macOS package nothing before it was calculated, and a folder
// nothing where Calculate Size cannot run (calc false: local Windows).
export function sizeCell(entry, result, now, calc = true) {
  if (!entry.dir) return { text: Number.isFinite(entry.size) ? formatBytes(entry.size) : "", spin: false };
  if (busy(result, now)) return { text: "", spin: true };
  if (result?.state === "done") return { text: `~${formatBytes(result.bytes)}`, spin: false, ...(result.incomplete ? { title: INCOMPLETE } : {}) };
  if (result?.state === "toolarge") return { text: "Too large", spin: false, title: TOO_LARGE };
  return { text: entry.bundle || !calc ? "" : "\u2014", spin: false };
}

// The detail at the right of the Calculate Size menu entry: the size once known, … while it runs, else nothing.
export function sizeDetail(result, now) {
  if (busy(result, now)) return "\u2026";
  if (result?.state === "done") return `~${formatBytes(result.bytes)}`;
  if (result?.state === "toolarge") return "Too large";
  return null;
}

// The tooltip of the Calculate Size entry: why the shown size is only a lower bound, else nothing.
export function sizeNote(result, now) {
  return result?.state === "done" && result.incomplete && !busy(result, now) ? INCOMPLETE : null;
}
