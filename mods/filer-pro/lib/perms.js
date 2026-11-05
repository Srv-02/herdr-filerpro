// File permissions (issue #23): pure helpers for modes (octal, the rwx matrix, symbolic text, the warnings the dialog
// shows while editing), the three shell scripts and the parsers of their answers. No file system access here; the exec-backed
// operations are in createFileOps (lib/fileops.js). The helpers are exported on purpose so other parts (a mode in a status
// line) can format a mode the same way.
import { group } from "./numbers.js";

export const COUNT_LIMIT = 10000;
const WHO = { owner: 6, group: 3, others: 0 };
const WHAT = { r: 4, w: 2, x: 1 };
const SPECIAL = { setuid: 0o4000, setgid: 0o2000, sticky: 0o1000 };

// Strict octal text: exactly 3 or 4 digits 0-7, nothing else (no symbolic modes, no spaces, no sign).
export function parseOctal(text) {
  if (typeof text !== "string" || !/^[0-7]{3,4}$/.test(text)) return { ok: false, error: "Enter 3 or 4 octal digits (0-7), for example 644" };
  return { ok: true, mode: parseInt(text, 8) };
}

// 644, or 4 digits (2755) when a special bit is set.
export function formatOctal(mode, width = mode & 0o7000 ? 4 : 3) {
  return (mode & 0o7777).toString(8).padStart(width, "0");
}

// "rw-r--r--"; s, S (setuid, setgid without execute), t, T (sticky) as ls prints them.
export function formatSymbolic(mode) {
  const bit = (b, ch) => (mode & b ? ch : "-");
  const x = (xb, sb, lower, upper) => (mode & sb ? (mode & xb ? lower : upper) : bit(xb, "x"));
  return `${bit(0o400, "r")}${bit(0o200, "w")}${x(0o100, 0o4000, "s", "S")}${bit(0o40, "r")}${bit(0o20, "w")}${x(0o10, 0o2000, "s", "S")}${bit(0o4, "r")}${bit(0o2, "w")}${x(0o1, 0o1000, "t", "T")}`;
}

// "644 → 600"; both in four digits when either has a special bit.
export function formatChange(oldMode, newMode) {
  const width = (oldMode | newMode) & 0o7000 ? 4 : 3;
  return `${formatOctal(oldMode, width)} → ${formatOctal(newMode, width)}`;
}

// The mode argument for chmod: five digits, so GNU chmod also clears setuid and setgid of a folder (three or four
// digits keep them there).
export function chmodArg(mode) {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new Error("Invalid mode");
  return mode.toString(8).padStart(5, "0");
}

function shift(who, what) {
  if (!(who in WHO) || !(what in WHAT)) throw new Error(`Unknown permission: ${who} ${what}`);
  return WHAT[what] << WHO[who];
}

export const getBit = (mode, who, what) => (mode & shift(who, what)) !== 0;
export const setBit = (mode, who, what, on) => (on ? mode | shift(who, what) : mode & ~shift(who, what));

export function specialBits(mode) {
  return { setuid: (mode & SPECIAL.setuid) !== 0, setgid: (mode & SPECIAL.setgid) !== 0, sticky: (mode & SPECIAL.sticky) !== 0 };
}

const list = (words) => (words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}` : words[0]);

// The warnings the dialog shows under the fields while the mode is edited, one short line each (they share a fixed
// three line area). The number of items a recursive apply touches is not a warning: see insideText.
export function modeWarnings({ oldMode, newMode, isDir, recursive }) {
  const out = [];
  if (newMode & 0o002) out.push("World writable: any user on the machine can change it.");
  const lost = ["r", "w", ...(isDir ? ["x"] : [])].filter((w) => getBit(oldMode, "owner", w) && !getBit(newMode, "owner", w));
  if (lost.length) {
    const names = lost.map((w) => ({ r: "read", w: "write", x: "execute" })[w]);
    out.push(lost.includes("x") ? `Removes your own ${list(names)} permission: you can no longer open the folder.`
      : `Removes your own ${list(names)} permission: you may lock yourself out.`);
  }
  const sets = [], clears = [];
  for (const [name, bit] of Object.entries(SPECIAL)) {
    if ((newMode & bit) && !(oldMode & bit)) sets.push(name);
    if (!(newMode & bit) && (oldMode & bit)) clears.push(name);
  }
  if (sets.length || clears.length) out.push(`Special bits change: ${[sets.length ? `sets ${sets.join(", ")}` : "", clears.length ? `clears ${clears.join(", ")}` : ""].filter(Boolean).join("; ")}.`);
  if (recursive) {
    if (!(newMode & 0o111)) out.push("Folders inside lose their execute bits and cannot be opened.");
    else out.push("Files inside become executable.");
  }
  return out;
}

// The line about a recursive apply. count: the entries inside the folder (not the folder itself; more than COUNT_LIMIT
// means "more than"), null when it could not be determined; counting: still running.
export function insideText(count, counting = false) {
  if (counting) return "Counting the items inside…";
  const n = count === null || count === undefined ? "many items"
    : count > COUNT_LIMIT ? `more than ${group(COUNT_LIMIT)} items`
    : `${group(count)} ${count === 1 ? "item" : "items"}`;
  return `Also sets this mode on ${n} inside (links are skipped).`;
}

// The notice when the mode read back after chmod is not the one asked for (actual: null when it could not be read).
export function mismatchText(name, requested, actual) {
  return actual === null ? `${name}: asked for ${formatOctal(requested)}, the new mode could not be read back`
    : `${name}: asked for ${formatOctal(requested)}, the system set ${formatOctal(actual)}`;
}

// Whether the user may change the mode: the owner, or root. Anything else the system decides when chmod runs.
export function canChange({ uid, me }) {
  return /^\d+$/.test(uid ?? "") && /^\d+$/.test(me ?? "") && (me === "0" || Number(me) === Number(uid));
}

// Probe answer (PROBE_SCRIPT): type f|d|l, mode (4 digits), uid, gid, user, group, own uid; null when it is not that.
export function parseProbe(stdout) {
  const f = String(stdout ?? "").split("\0");
  if (f.length < 7 || !["f", "d", "l"].includes(f[0]) || !/^[0-7]{4}$/.test(f[1]) || !/^\d+$/.test(f[2]) || !/^\d+$/.test(f[3])) return null;
  const p = { type: f[0], mode: parseInt(f[1], 8), uid: f[2], gid: f[3], user: f[4] || f[2], group: f[5] || f[3], me: f[6] };
  return { ...p, isDir: p.type === "d", isLink: p.type === "l", owned: canChange(p) };
}

export function parseCount(stdout) {
  const m = /^\s*(\d+)\s*$/.exec(String(stdout ?? ""));
  return m ? Number(m[1]) : null;
}

export function parseModeOut(stdout) {
  const m = /^\s*([0-7]{3,4})\s*$/.exec(String(stdout ?? ""));
  return m ? parseInt(m[1], 8) : null;
}

// stat in the dialect of the machine (GNU stat -c first, BSD stat -f otherwise, as lib/sizes.js detects it). mode: the last
// four octal digits of the mode (GNU %a is padded, BSD %p holds the file type in front).
// Shell function: st <path> -> sets T (type), M, U, G, UN, GN of what the entry points to (links followed).
const STAT_FN = `if stat -c %a / >/dev/null 2>&1; then g=1; else g=0; fi
st() {
  if [ $g = 1 ]; then
    M=$(stat -L -c %a -- "$1") && U=$(stat -L -c %u -- "$1") && G=$(stat -L -c %g -- "$1") && UN=$(stat -L -c %U -- "$1") && GN=$(stat -L -c %G -- "$1") || return 1
  else
    M=$(stat -L -f %p -- "$1") && U=$(stat -L -f %u -- "$1") && G=$(stat -L -f %g -- "$1") && UN=$(stat -L -f %Su -- "$1") && GN=$(stat -L -f %Sg -- "$1") || return 1
  fi
  M=0000$M; M=\${M#\${M%????}}
}`;

// `x <path>`: type (f|d|l, a link as the link), mode, uid, gid, owner name, group name and own uid of <path> (what a link
// points to), NUL-terminated. Exit 3: no such entry, 4: unreadable (a dangling link).
export const PROBE_SCRIPT = `p=$1
case $p in /*) ;; *) echo "path must be absolute" >&2; exit 2 ;; esac
if [ -L "$p" ]; then T=l; elif [ -d "$p" ]; then T=d; elif [ -e "$p" ]; then T=f; else exit 3; fi
${STAT_FN}
st "$p" || { echo "Cannot read the permissions of $p" >&2; exit 4; }
printf '%s\\0' "$T" "$M" "$U" "$G" "$UN" "$GN" "$(id -u)"`;

// `x <mode 5 digits> <path> <recursive 0|1>`: chmod, then prints the mode the entry really has. Exit 2: bad argument,
// 3: no such entry, 6: the path is a symbolic link (never changed, also not through the link), 7: recursive on a
// non-folder. Recursive: find -P, so no link is followed, and every link is skipped (chmod would follow it on BSD);
// -depth changes the contents before the folder, so a folder that loses its execute bit is left last.
// Residual race: between find's type check and chmod an entry could be swapped for a link by someone who can write in the
// tree. BSD/macOS chmod -h then changes the link itself, never its target. GNU chmod has no such flag (and its own -R
// would stop at a folder that lost its execute bit), so there the window stays; see the README.
export const CHMOD_SCRIPT = `m=$1 p=$2 r=$3
${STAT_FN}
case $m in [0-7][0-7][0-7][0-7][0-7]) ;; *) echo "invalid mode" >&2; exit 2 ;; esac
case $p in /*) ;; *) echo "path must be absolute" >&2; exit 2 ;; esac
if [ -L "$p" ]; then echo "Symbolic links are not changed" >&2; exit 6; fi
[ -e "$p" ] || exit 3
if [ "$r" = 1 ]; then
  [ -d "$p" ] || exit 7
  if [ $g = 1 ]; then
    find -P "$p" ! -type l -depth -exec chmod -- "$m" {} + || exit 1
  else
    find -P "$p" ! -type l -depth -exec chmod -h -- "$m" {} + || exit 1
  fi
else
  chmod -- "$m" "$p" || exit 1
fi
st "$p" && echo "$M"`;

// `x <path>`: the number of entries inside the folder (files and folders at any depth, not the folder itself; links are
// skipped) up to COUNT_LIMIT + 1. find stops as soon as head has enough, so a huge tree does not run into the 30 second
// limit of exec (macOS has no timeout). -mindepth 1 is in both GNU and BSD find.
export const COUNT_SCRIPT = `find -P "$1" -mindepth 1 ! -type l 2>/dev/null | head -n ${COUNT_LIMIT + 1} | wc -l`;
