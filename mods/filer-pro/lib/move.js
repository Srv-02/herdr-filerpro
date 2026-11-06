// Move within one machine: the check before the dialogs, the move script and the exec-backed ops.
// Pure helpers and shell scripts here; every path goes in as an argument, never into a shell string.
import { SAME_FN, MOUNT_FN, REMOVE_SCRIPT, normalizePath } from "./fileops.js";
import { LIST_SCRIPT } from "./jobs.js";
import { keepBothName, joinPath, baseName, nameKey } from "./names.js";
import { explainError as explainRaw } from "./errors.js";

// Shell functions of both scripts. The mount guard (MOUNT_FN) uses the variables s, E, e, t, f, l, m, k, tab, u, L, lk, c, j and ph,
// so the scripts below keep clear of those names.
// res <dir>: R is the physical path of <dir> (cd -P, pwd -P; the "x" keeps a trailing newline of the name), else empty.
// dev <path>: D is the device number of <path> (GNU stat -c first, else BSD stat -f; a link counts with its folder), else empty.
// into <dir> <folder>: y when <folder> is the folder <dir> or lies below it (-ef on every folder up to /), n for
// a file or a link as <dir> (a link to a folder is moved as the link), ? when a folder on the way cannot be entered.
export const MOVE_FNS = `${SAME_FN}
${MOUNT_FN}
res() { R=$(cd -P -- "$1" 2>/dev/null && pwd -P && printf x); R=\${R%x}; R=\${R%"
"}; }
dev() { D=$(stat -c %d -- "$1" 2>/dev/null) || D=$(stat -f %d -- "$1" 2>/dev/null); case $D in ''|*[!0-9]*) D= ;; esac; }
into() {
  [ -d "$1" ] && [ ! -L "$1" ] || { echo n; return; }
  a=$2
  while :; do
    if [ "$1" -ef "$a" ]; then echo y; return; fi
    if [ "$a" = / ]; then echo n; return; fi
    res "$a/.."; [ -n "$R" ] || { echo '?'; return; }
    a=$R
  done
}`;

// `x <src> <destDir> <trash> [<info> [<mount>]]`: what the file system says before any dialog, as ten NUL-terminated
// fields: physical target folder (empty: cannot be entered), target exists (y|n), its type (f|d|l), same folder as
// the source's (y|n), the source contains the target folder (y|n|?), the existing target contains the source
// (y|n|?, only for a real folder), a file system is mounted in the existing target (y|n, only for a real folder;
// the message goes to stderr), device of the source, of the target folder, of the Trash (empty without <trash>;
// the folder itself, else its parent). <info> and <mount> stand in for the mount tables (tests only).
export const MOVE_CHECK_SCRIPT = `${MOVE_FNS}
S=$1 DD=$2 N=\${1##*/}
SP=\${S%/*}; [ -n "$SP" ] || SP=/
res "$DD"; PD=$R
[ -n "$PD" ] || { printf '%s\\0' "" n f n n n n "" "" ""; exit 0; }
case $PD in /) TG=/$N ;; *) TG=$PD/$N ;; esac
EX=n TY=f
if [ -L "$TG" ]; then EX=y TY=l; elif [ -e "$TG" ]; then EX=y; [ -d "$TG" ] && TY=d; fi
SAMEF=n; [ "$SP" -ef "$PD" ] && SAMEF=y
IN=$(into "$S" "$PD")
AB=n MT=n
if [ "$EX" = y ] && [ "$TY" = d ]; then
  AB=$(into "$TG" "$SP")
  V=replace
  mounted "$TG" "$4" "$5" || MT=y
fi
dev "$S"; SD=$D; dev "$PD"; TD=$D
RD=
if [ -n "$3" ]; then RT=$3; [ -e "$RT" ] || { RT=\${RT%/*}; [ -n "$RT" ] || RT=/; }; dev "$RT"; RD=$D; fi
printf '%s\\0' "$PD" "$EX" "$TY" "$SAMEF" "$IN" "$AB" "$MT" "$SD" "$TD" "$RD"`;

// `x <src> <dest> <input> <replace 0|1> <trash> [<info> [<mount>]]`: moves <src> to <dest> with one mv -n (never over an existing entry,
// never across devices). Exit 0 (stdout: path of the entry set aside, or empty), 1 failure (the last stderr line is the
// message), 2 path refused, 3 <src> missing, 4 <dest> exists, 5 <src> is not the entry <input> names, 6 into itself,
// 7 other volume. 5 also when <dest>'s folder is no longer a physical path (a link was put in), checked before anything moves.
// With replace=1 a mount in the old <dest> refuses (exit 1, like REMOVE_SCRIPT; <info> and <mount> stand in for the tables, tests only);
// the old <dest> is set aside first (<trash>/<name> <time>[-n], or without <trash>
// next to <dest> as .<name>.fs-move.<pid>[-n]) and goes back when the mv fails; if it cannot go back, the last stderr
// line names where it is. D2 keeps <dest>: in a sh function $2 is the function's own argument.
// -T and --no-copy only where mv knows them. The inode check after mv is the one of RENAME_SCRIPT.
export const MOVE_SCRIPT = `${MOVE_FNS}
ino() { I=$(set -f; set -- $(ls -di -- "$1" 2>/dev/null); printf %s "$1"); }
D2=$2
for p in "$1" "$2"; do
  case $p in /?*) ;; *) echo "Refusing to move: $p" >&2; exit 2 ;; esac
  case $p in */|*//*|*/./*|*/../*|*/.|*/..) echo "Refusing to move: $p" >&2; exit 2 ;; esac
  case $p in /*/*) ;; *) echo "Refusing to move: $p" >&2; exit 2 ;; esac
done
[ -e "$1" ] || [ -L "$1" ] || exit 3
same "$1" "$3" || { echo "The path changed while it was checked: $3" >&2; exit 5; }
dd=\${2%/*}; [ -n "$dd" ] || dd=/
res "$dd"; [ "$R" = "$dd" ] || { echo "The path changed while it was checked: $dd" >&2; exit 5; }
[ "$(into "$1" "$dd")" = n ] || { echo "Cannot move a folder into itself" >&2; exit 6; }
dev "$1"; sd=$D; dev "$dd"; td=$D
[ -n "$sd" ] && [ "$sd" = "$td" ] || { echo "The target is on another volume" >&2; exit 7; }
T=; mv -T --version >/dev/null 2>&1 && T=-T
NC=; mv --no-copy --version >/dev/null 2>&1 && NC=--no-copy
aside= left=
if [ -e "$2" ] || [ -L "$2" ]; then
  [ "$4" = 1 ] || exit 4
  V=replace
  if [ -d "$2" ] && [ ! -L "$2" ]; then mounted "$2" "$6" "$7" || exit 1; fi
  n=\${2##*/}
  if [ -n "$5" ]; then mkdir -p -- "$5" || exit 1; base="$5/$n $(date +%Y%m%d-%H%M%S)"; else base="$dd/.$n.fs-move.$$"; fi
  aside=$base; k=0
  while [ -e "$aside" ] || [ -L "$aside" ]; do k=$((k + 1)); aside="$base-$k"; done
  mv -n $T -- "$2" "$aside" || exit 1
  if [ -e "$2" ] || [ -L "$2" ]; then echo "Could not replace: $2" >&2; exit 1; fi
fi
back() {
  [ -n "$aside" ] || return 0
  if [ -e "$D2" ] || [ -L "$D2" ]; then left=$aside; return 0; fi
  mv -n $T -- "$aside" "$D2"
  if [ -e "$aside" ] || [ -L "$aside" ]; then left=$aside
  elif [ -e "$D2/\${aside##*/}" ] || [ -L "$D2/\${aside##*/}" ]; then left=$D2/\${aside##*/}; fi
}
fail() { back; echo "Could not move: $1\${left:+. The old entry is now in: $left}" >&2; exit 1; }
ino "$1"; i1=$I
[ -n "$i1" ] || fail "$1"
mv -n $NC $T -- "$1" "$2"
if [ -e "$1" ] || [ -L "$1" ]; then
  if [ -z "$aside" ] && { [ -e "$2" ] || [ -L "$2" ]; }; then exit 4; fi
  fail "$1"
fi
[ -e "$2" ] || [ -L "$2" ] || fail "$1"
ino "$2"
if [ "$I" != "$i1" ]; then
  n=\${1##*/}
  ino "$2/$n"
  [ "$I" = "$i1" ] || fail "$1"
  mv -n $T -- "$2/$n" "$1"
  ino "$1"
  if [ "$I" = "$i1" ]; then [ -z "$aside" ] && exit 4; fail "$1"; fi
  where=$2/$n; ino "$1/$n"; [ "$I" = "$i1" ] && where=$1/$n
  back; echo "A folder appeared at the target, the item is now in: $where\${left:+. The old entry is now in: $left}" >&2; exit 1
fi
printf '%s' "$aside"`;

export function parseMoveCheck(stdout) {
  const f = String(stdout ?? "").split("\0");
  return {
    destDir: f[0] ?? "", exists: f[1] === "y", type: f[2] ?? "f",
    same: f[3] ?? "?", into: f[4] ?? "?", above: f[5] ?? "?", mounted: f[6] ?? "?",
    srcDev: f[7] ?? "", destDev: f[8] ?? "", trashDev: f[9] ?? "",
  };
}

const CHANGED = "The item changed while the dialog was open";
const OTHER_VOLUME = "The target is on another volume";
const NO_CHECK = "Could not check the path";

// The verdict on the answer of MOVE_CHECK_SCRIPT, in the order the user would hit the problems. destDir is the
// folder as the caller named it (for the message), stderr the script's (for the mount message).
export function moveVerdict({ info, src, destDir, stderr }) {
  if (!info.destDir) return { error: `Target folder does not exist: ${destDir}` };
  if (info.into === "y") return { error: "Cannot move a folder into itself" };
  if (info.into !== "n") return { error: NO_CHECK };
  if (info.same === "y") return { noop: true };
  if (!info.srcDev || !info.destDev) return { error: "Could not check the volume" };
  if (info.srcDev !== info.destDev) return { crossVolume: true };
  const dest = joinPath(info.destDir, baseName(src));
  let replaceError = null;
  if (info.exists) {
    if (info.above !== "n" && info.above !== "y") return { error: NO_CHECK };
    if (info.above === "y") replaceError = "Cannot replace a folder that contains the source";
    else if (info.mounted === "y") replaceError = explainRaw(stderr, null, "Refusing to replace, a file system is mounted in the target");
    else if (info.trashDev !== "" && info.trashDev !== info.destDev) replaceError = "Cannot replace here, the Trash lies on another volume";
  }
  return { exists: info.exists, destIsDir: info.type === "d", dest, replaceError };
}

export function moveToasts(out) {
  if (!out?.ok || !out.moved) return [];
  const toasts = [{ title: "Moved", body: baseName(out.path), level: "success" }];
  if (out.warning) toasts.push({ title: "Could not remove the old entry", body: out.warning, level: "error" });
  return toasts;
}

// exec-backed move. deps: { exec, check, trashDir, mountTables? }; check is the guard of createFileOps. Results:
// { ok: true, ... } or { ok: false, error }. mountTables: [infoPath, mountPath] for MOVE_CHECK_SCRIPT (tests only).
export function createMoveOps({ exec, check, trashDir, mountTables = [], localPlatform }) {
  const explainError = (stderr, host, fallback) => explainRaw(stderr, host, fallback, { localPlatform: localPlatform?.() });
  const failure = (e, on) => ({ ok: false, error: explainError(String(e?.message ?? e), on) });
  const run = (script, args, on) => exec("sh", ["-c", script, "x", ...args], { on });

  async function inspectMove({ on = null, src, destDir, root }) {
    const c = await check({ on, path: src, root, verb: "move" });
    if (!c.ok) return c;
    let res;
    try {
      res = await run(MOVE_CHECK_SCRIPT, [c.path, normalizePath(destDir), on ? "" : trashDir, ...mountTables], on);
    } catch (e) {
      return failure(e, on);
    }
    if (res.code !== 0) return { ok: false, error: explainError(res.stderr, on, NO_CHECK) };
    const info = parseMoveCheck(res.stdout);
    const v = moveVerdict({ info, src: c.path, destDir, stderr: res.stderr });
    if (v.error) return { ok: false, error: v.error };
    if (v.noop) return { ok: true, noop: true, src: c.path };
    if (v.crossVolume) return { ok: true, crossVolume: true, src: c.path, name: c.name, isDir: c.isDir };
    if (v.exists) {
      const g = await check({ on, path: v.dest, root, verb: "delete" });
      if (!g.ok) return { ok: false, error: g.error };
    }
    return { ok: true, src: c.path, name: c.name, isDir: c.isDir, destDir: info.destDir, dest: v.dest, exists: v.exists, destIsDir: v.destIsDir, replaceError: v.replaceError };
  }

  async function move({ on = null, src, destDir, root, choice, expect, expectDest, reserved = [] }) {
    const i = await inspectMove({ on, src, destDir, root });
    if (!i.ok) return i;
    if (expect !== undefined && i.src !== expect) return { ok: false, error: CHANGED };
    if (i.noop) return { ok: true, noop: true };
    if (i.crossVolume) return { ok: false, error: OTHER_VOLUME };
    if (expectDest !== undefined && i.dest !== expectDest) return { ok: false, error: CHANGED };
    if (choice === "replace" && i.replaceError) return { ok: false, error: i.replaceError };
    let name = i.name;
    if (choice === "keep_both") {
      let list;
      try {
        list = await run(LIST_SCRIPT, [i.destDir], on);
      } catch (e) {
        return failure(e, on);
      }
      if (list.code !== 0) return { ok: false, error: explainError(list.stderr, on, "Could not list the folder") };
      // Without letter case and Unicode normalization also on a machine (#33); the own name counts as taken.
      const taken = new Set([...list.stdout.split("\0").filter(Boolean).map((e) => e.replace(/^\.\//, "")), ...reserved, i.name].map(nameKey));
      name = keepBothName(i.name, taken, nameKey);
    }
    const dest = joinPath(i.destDir, name);
    let res;
    try {
      res = await run(MOVE_SCRIPT, [i.src, dest, normalizePath(src), choice === "replace" && i.exists ? "1" : "0", on ? "" : trashDir, ...mountTables], on);
    } catch (e) {
      return failure(e, on);
    }
    if (res.code === 3) return { ok: false, error: `No such file or folder: ${i.src}` };
    if (res.code === 4) return { ok: false, error: `"${name}" already exists` };
    if (res.code === 5) return { ok: false, error: String(res.stderr ?? "").trim() ? explainError(res.stderr, on) : `The path changed while it was checked: ${normalizePath(src)}` };
    if (res.code === 6) return { ok: false, error: "Cannot move a folder into itself" };
    if (res.code === 7) return { ok: false, error: OTHER_VOLUME };
    if (res.code !== 0) return { ok: false, error: explainError(res.stderr, on, "Could not move") };
    const out = { ok: true, moved: true, path: dest, name, isDir: i.isDir };
    const aside = res.stdout;
    if (aside) {
      if (!on) out.trash_path = aside;
      else {
        let ok = false;
        try {
          // Only what MOVE_SCRIPT put next to the target is removed, and only after the delete guard.
          if (aside.startsWith(`${i.destDir === "/" ? "" : i.destDir}/.`) && aside.includes(".fs-move.")) {
            const c = await check({ on, path: aside, root, verb: "delete" });
            if (c.ok) ok = (await run(REMOVE_SCRIPT, [c.path, aside], on)).code === 0;
          }
        } catch { /* a warning below */ }
        if (!ok) out.warning = `The old entry could not be removed: ${aside}`;
      }
    }
    return out;
  }

  return { inspectMove, move };
}
