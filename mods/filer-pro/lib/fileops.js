// File operations beside the transfers: new folder, rename and delete. Pure helpers here, the exec-backed ops below.
import { platform } from "./platform.js";
import { baseName, parentOf, joinPath, nameKey } from "./names.js";
import { explainError, cleanText } from "./errors.js";

// Newline, tab and the other control characters (0x00-0x1F, 0x7F): never deleted or renamed through here.
const CONTROL = /[\x00-\x1f\x7f]/;
const CONTROL_ERROR = "Names with control characters are not supported";

export function validateName(name) {
  if (CONTROL.test(name)) return CONTROL_ERROR;
  if (name.trim() === "") return "Enter a name";
  if (name.includes("/")) return 'A name cannot contain "/"';
  if (name === "." || name === "..") return '"." and ".." are not allowed';
  return null;
}

export function renameCheck(value, original) {
  return validateName(value) ?? (value === original ? "The name is unchanged" : null);
}

// Trailing slashes off ("/" stays), so a link to a folder is never addressed through its target.
export function normalizePath(path) {
  const p = path.replace(/\/+$/, "");
  return p === "" && path.startsWith("/") ? "/" : p;
}

// A component ".", ".." or "" (from "//") anywhere in the path: refused before the file system is asked.
// ".." behind a link climbs from the link's target, so no spelling of it is trusted.
export function badSpelling(path) {
  return path.split("/").slice(1).some((c) => c === "" || c === "." || c === "..");
}

// The verdict on a path from what the file system itself reports (see GUARD_SCRIPT): whether the entry is
// the home folder, the shown folder (`root`) or a folder above one of them is decided there by -ef, so
// neither letter case, Unicode normalization nor links in the parent can disguise it. ".", ".." and "//"
// are refused outright. Refused: "/", every ".", ".." or empty component, home and the shown folder
// themselves, everything above them, and every entry directly below /. Returns an error text or null.
// info: { exists, type, parent, root, home, coversHome, coversRoot, rootEntry, system } (covers, system: "y" | "n" | "?").
// system: the entry is a system folder (see GUARD_SCRIPT), refused like a top-level folder.
export function guardVerdict({ path, info, rootPath, on, verb }) {
  if (!path.startsWith("/")) return "path must be absolute";
  const name = baseName(path);
  if (path === "/") return verb === "delete" ? "Refusing to delete the root folder" : `Refusing to ${verb} this folder`;
  if (badSpelling(path)) return 'Path must not contain ".", ".." or "//"';
  if (!info.parent || !info.exists) return `No such file or folder: ${path}`;
  if (!info.home) return "Cannot determine the home folder";
  if (info.coversHome === "y") return verb === "delete" ? "Refusing to delete the home folder" : `Refusing to ${verb} this folder`;
  if (!info.root) return `No such file or folder: ${rootPath}`;
  // The shown folder itself, also when it is a link (then -ef in coversRoot does not apply).
  const key = (x) => (on ? x : platform.pathKey(x));
  if (info.coversRoot === "y" || info.rootEntry || key(path) === key(normalizePath(rootPath ?? ""))) return verb === "delete" ? "Refusing to delete the shown folder" : `Refusing to ${verb} this folder`;
  if (info.coversHome !== "n" || info.coversRoot !== "n") return "Could not check the path";
  // Directly below / (/usr, /etc, /home, /Users, /Volumes): never, also not as root. The physical parent counts.
  if (info.parent === "/") return verb === "delete" ? "Refusing to delete a top-level folder" : `Refusing to ${verb} this folder`;
  if (info.system === "y") return verb === "delete" ? "Refusing to delete a system folder" : `Refusing to ${verb} this folder`;
  if (info.system !== "n") return "Could not check the path";
  return null;
}

// `x <path> <root> <fold 0|1> <base>`: what the file system says about <path>, as NUL-terminated fields (see parseGuard):
// exists (y|n), type (f|d|l), physical parent folder (cd -P, pwd -P; empty when it cannot be entered), physical
// <root>, physical $HOME, and whether the entry is $HOME / <root> or a folder above it (y|n|?, never y for a
// link). That walks from $HOME and <root> up to / with cd -P .. and tests each folder with -ef: pwd -P keeps
// the letter case it is given (/USERS stays /USERS on macOS), so comparing strings would miss it.
// "?" when a folder on the way cannot be entered: the verdict then refuses. Last field: whether the
// entry is <root>'s own entry (same name in the same folder, -ef), which also catches a <root> that is a link.
// fold=1: both names are equal after NFC and lower case (decided in JS, sh cannot normalize). Then two links
// in the same folder (-ef) with the same target count as the same entry: on APFS or a case-insensitive
// volume they are one link in another spelling. On a case-sensitive volume this refuses at most a second
// link to the same target whose name differs only in case or normalization.
// cd -P: a logical cd would cancel ".." against the link before it, while rm walks the link first.
// Last but one field (system, y|n|?): the entry is a system folder, decided by -ef, so no spelling or link in
// the parent hides it. Never touched: every entry directly in / (also as /System/Volumes/Data/Users, the firmlink
// spelling of /Users), /System/Volumes, /System/Volumes/Data, /private/var, /private/etc, /private/tmp,
// /Users/Shared and every entry in /Volumes (looked at only for a path directly in /Volumes: a hung network mount
// there would block every other check), each as that folder itself (a link at that place too); below them
// is allowed. /usr, /var and /etc with everything below, where they are real folders (on Linux; on macOS /var
// and /etc are links to /private/var and /private/etc, protected as that level only, so the temp folders in
// /private/var/folders stay usable). <base> is "" in production; tests pass a throw-away folder as a fake /.
// res: $(...) drops trailing newlines, so pwd -P is followed by an "x" that is cut off again with the one
// newline of pwd: a folder "foo<newline>" stays itself and never becomes its neighbour "foo".
export const GUARD_SCRIPT = `p=$1 r=$2
res() { R=$(cd -P -- "$1" 2>/dev/null && pwd -P && printf x); R=\${R%x}; R=\${R%"
"}; }
e=n t=f
if [ -L "$p" ]; then e=y t=l
elif [ -e "$p" ]; then e=y; [ -d "$p" ] && t=d; fi
dir=\${p%/*}; [ -n "$dir" ] || dir=/
res "$dir"; par=$R
rt=; [ -n "$r" ] && { res "$r"; rt=$R; }
hm=; [ -n "$HOME" ] && { res "$HOME"; hm=$R; }
case $par in /) q=/\${p##*/} ;; *) q=$par/\${p##*/} ;; esac
covers() {
  [ -n "$1" ] && [ -n "$par" ] && [ "$e" = y ] && [ "$t" != l ] || { echo n; return; }
  a=$1
  while :; do
    if [ "$q" -ef "$a" ]; then echo y; return; fi
    if [ "$a" = / ]; then echo n; return; fi
    res "$a/.."; [ -n "$R" ] || { echo '?'; return; }
    a=$R
  done
}
ch=$(covers "$hm") cr=$(covers "$rt")
re=n
if [ -n "$r" ] && [ -n "$par" ]; then
  if [ "\${r##*/}" = "\${p##*/}" ] || { [ "$3" = 1 ] && [ -L "$p" ] && [ -L "$r" ] && [ "$p" -ef "$r" ]; }; then
    rd=\${r%/*}; [ -n "$rd" ] || rd=/
    res "$rd"; [ -n "$R" ] && [ "$R" -ef "$par" ] && re=y
  fi
fi
sy=n
if [ -n "$par" ] && [ "$e" = y ]; then
  B=$4
  pos() { d=\${1%/*}; [ -n "$d" ] || d=/; [ "$par" -ef "$d" ] && [ "\${1##*/}" = "\${p##*/}" ]; }
  vol=
  [ -d "$B/Volumes" ] && [ "$par" -ef "$B/Volumes" ] && vol=y
  set -- "$B"/* "$B"/.[!.]* "$B/System/Volumes" "$B/System/Volumes/Data" "$B/private/var" "$B/private/etc" "$B/private/tmp" "$B/Users/Shared"
  [ -z "$vol" ] || set -- "$@" "$B"/Volumes/*
  for P do
    [ -e "$P" ] || [ -L "$P" ] || continue
    if pos "$P" || { [ "$t" != l ] && [ "$q" -ef "$P" ]; }; then sy=y; break; fi
  done
  if [ "$sy" = n ]; then
    for X in "$B/usr" "$B/var" "$B/etc"; do
      [ -d "$X" ] && [ ! -L "$X" ] || continue
      if [ "$t" != l ] && [ "$q" -ef "$X" ]; then sy=y; break; fi
      a=$par
      while :; do
        if [ "$a" -ef "$X" ]; then sy=y; break 2; fi
        [ "$a" = / ] && break
        res "$a/.."; [ -n "$R" ] || { sy='?'; break; }
        a=$R
      done
    done
  fi
fi
printf '%s\\0' "$e" "$t" "$par" "$rt" "$hm" "$ch" "$cr" "$re" "$sy"`;

export function parseGuard(stdout) {
  const f = String(stdout ?? "").split("\0");
  return { exists: f[0] === "y", type: f[1] ?? "f", parent: f[2] ?? "", root: f[3] ?? "", home: f[4] ?? "", coversHome: f[5] ?? "?", coversRoot: f[6] ?? "?", rootEntry: f[7] === "y", system: f[8] ?? "?" };
}

// same <physical> <input>: the checked physical path is still the entry the input names. -ef follows
// links, so a link is compared as the link: same name, and the folders it sits in are the same (-ef).
// Only parameter expansion, no $(...): a trailing newline in a name survives.
export const SAME_FN = `same() {
  if [ -L "$2" ]; then
    [ -L "$1" ] && [ "\${1##*/}" = "\${2##*/}" ] || return 1
    d1=\${1%/*}; [ -n "$d1" ] || d1=/
    d2=\${2%/*}; [ -n "$d2" ] || d2=/
    [ "$d1" -ef "$d2" ]
  else
    [ ! -L "$1" ] && [ "$1" -ef "$2" ]
  fi
}`;

// `x <physical> <input>`: exit 5 unless <physical> is the same entry as <input> (see SAME_FN). Runs right
// before the trash, which is a program of its own.
export const CONFIRM_SCRIPT = `${SAME_FN}
same "$1" "$2" || { echo "The path changed while it was checked: $2" >&2; exit 5; }`;

// `x <src> <dest> <caseOnly 0|1> <input>`: exit 2 for a path that is not absolute, ends in a slash, has a
// ".", ".." or empty component or lies directly below /, 3 when <src> is missing, 5 when <src> is not the entry <input> names,
// 4 when <dest> exists (also as a dead link). A same-spelling target passes only when
// caseOnly is 1 and both are the same file and neither is a link (readme.md -> README.md on APFS, also on a
// remote Mac). Only then the plain mv runs; a <dest> that does not exist always goes through mv -n, so the flag
// is safe on a case-sensitive machine too (there readme.md and README.md are two files, -ef tells them apart).
// mv -n (GNU and BSD): a target that appears after the check is never overwritten; afterwards the source
// must be gone and the target there, else exit 4 (target appeared) or 1. caseOnly needs the plain mv: for
// mv -n the other spelling of the same file already "exists". A case-insensitive volume holds no second file
// of that name to overwrite.
// A folder that appears at <dest> after the check: mv -n would move <src> into it and still succeed. So the
// inode of <src> (ls -di, a link as the link) must be the one at <dest> afterwards; is it at <dest>/<name>
// instead, it is moved back and the answer is exit 4. GNU mv gets -T (never into a folder) as well.
export const RENAME_SCRIPT = `${SAME_FN}
ino() { I=$(set -f; set -- $(ls -di -- "$1" 2>/dev/null); printf %s "$1"); }
for p in "$1" "$2"; do
  case $p in /?*) ;; *) echo "Refusing to rename: $p" >&2; exit 2 ;; esac
  case $p in */|*//*|*/./*|*/../*|*/.|*/..) echo "Refusing to rename: $p" >&2; exit 2 ;; esac
  case $p in /*/*) ;; *) echo "Refusing to rename: $p" >&2; exit 2 ;; esac
done
[ -e "$1" ] || [ -L "$1" ] || exit 3
same "$1" "$4" || { echo "The path changed while it was checked: $4" >&2; exit 5; }
co=0
if [ -e "$2" ] || [ -L "$2" ]; then
  if [ "$3" = 1 ] && [ ! -L "$1" ] && [ ! -L "$2" ] && [ "$1" -ef "$2" ]; then co=1; else exit 4; fi
fi
if [ "$co" = 1 ]; then
  mv -- "$1" "$2" || exit 1
  [ -e "$2" ] || { echo "Could not rename: $1" >&2; exit 1; }
else
  T=; mv -T --version >/dev/null 2>&1 && T=-T
  ino "$1"; i1=$I
  [ -n "$i1" ] || { echo "Could not rename: $1" >&2; exit 1; }
  mv -n $T -- "$1" "$2"
  if [ -e "$1" ] || [ -L "$1" ]; then
    if [ -e "$2" ] || [ -L "$2" ]; then exit 4; fi
    echo "Could not rename: $1" >&2; exit 1
  fi
  [ -e "$2" ] || [ -L "$2" ] || { echo "Could not rename: $1" >&2; exit 1; }
  ino "$2"
  if [ "$I" != "$i1" ]; then
    n=\${1##*/}
    ino "$2/$n"
    [ "$I" = "$i1" ] || { echo "Could not rename: $1" >&2; exit 1; }
    mv -n $T -- "$2/$n" "$1"
    ino "$1"
    [ "$I" = "$i1" ] && exit 4
    where=$2/$n
    ino "$1/$n"
    [ "$I" = "$i1" ] && where=$1/$n
    echo "A folder appeared at the target, the item is now in: $where" >&2; exit 1
  fi
fi`;

// `mounted <path> [<info> [<mount>]]`: returns 1 and prints `Refusing to $V, a file system is mounted at: <m>` on stderr
// when a file system is mounted at <path> or below it, else 0 (the table logic is described at REMOVE_SCRIPT). The
// caller sets V (the verb) first. `mounted1` checks one spelling; `mounted` checks <path> as given and then, for a real
// folder, once more in the form the file system stores (APFS and HFS+ take "café" in NFC for the stored NFD "café",
// the table holds the stored form). That form comes from the external pwd (env pwd -P, getcwd) after cd -P into the
// folder: the builtin pwd -P of bash (macOS sh) keeps the spelling of the call, for the folder itself as well; without
// an external pwd the builtin stands in. A folder that cannot be entered keeps the result of the first check. The
// string check of <path> comes first, so a mount at <path> in the spelling of the call is found before any cd. A hung
// mount at <path> in another spelling blocks the cd, nothing is deleted while it waits: the caller's exec timeout or
// stall detection ends that as an error, never as a free path.
export const MOUNT_FN = `enc() { s=$E E=; while :; do case $s in *"$1"*) E=$E\${s%%"$1"*}\\\\$2 s=\${s#*"$1"} ;; *) E=$E$s; break ;; esac; done; }
dec() { s=$E E=; while :; do case $s in *"\\\\$1"*) E=$E\${s%%"\\\\$1"*}$2 s=\${s#*"\\\\$1"} ;; *) E=$E$s; break ;; esac; done; }
low() { L=$(printf '%sx' "$1" | LC_ALL=C tr A-Z a-z); L=\${L%x}; }
hit() { printf 'Refusing to %s, a file system is mounted at: %s\\n' "$V" "$1" >&2; return 1; }
scan() {
  while IFS= read -r l || [ -n "$l" ]; do
    if [ "$f" = info ]; then
      m=\${l#* * * * }; m=\${m%% *}
    else
      case $l in *" on "*" ("*) ;; *) continue ;; esac
      m=\${l#* on }; m=\${m% (*}
    fi
    case $m in "$k"|"$k"/*) hit "$m"; return ;; esac
    [ -n "$lk" ] && [ "\${#m}" -ge "\${#k}" ] || continue
    low "$m"
    case $L in "$lk"|"$lk"/*) ;; *) continue ;; esac
    c=$m j=$((\${#m} - \${#k}))
    while [ "$j" -gt 0 ]; do c=\${c%?} j=$((j - 1)); done
    if [ "$f" = info ]; then E=$c; dec 011 '	'; dec 012 '
'; dec 040 ' '; dec 134 '\\'; c=$E; fi
    if [ "$c" -ef "$t" ]; then hit "$m"; return; fi
  done
}
mounted1() {
  t=$1 E=$1
  enc '\\' 134; enc ' ' 040; enc '	' 011; enc '
' 012
  e=$E
  tab=\${2:-/proc/self/mountinfo}
  if [ -r "$tab" ]; then f=info k=$e u=$(cat -- "$tab")
  elif [ -n "$3" ]; then f=bsd k=$t u=$(cat -- "$3" 2>/dev/null)
  else f=bsd k=$t u=$(mount 2>/dev/null)
  fi
  low "$k"; lk=$L; low "$u"
  case $L in *"$lk"*) ;; *) lk= ;; esac
  printf '%s\\n' "$u" | scan
}
mounted() {
  mounted1 "$1" "$2" "$3" || return 1
  [ -d "$1" ] && [ ! -L "$1" ] || return 0
  ph=$(cd -P -- "$1" 2>/dev/null && { env pwd -P 2>/dev/null || pwd -P; } && printf x) || return 0
  ph=\${ph%x}; ph=\${ph%"
"}
  [ -n "$ph" ] && [ "$ph" != "$1" ] || return 0
  mounted1 "$ph" "$2" "$3"
}`;

// `x <path> <input>`: exit 2 for a path that is not absolute, is "/", lies directly below /, ends in "/" or has
// a ".", ".." or empty component: a trailing slash would make rm work on a link's target. rm -r never follows a link.
// Exit 5 when <path> is not the entry <input> names, 1 when the path is still there.
// Exit 6 when a file system is mounted at <path> or below it: /proc/self/mountinfo (field 5, read raw: the path
// is encoded the way the kernel escapes it, "\" as \134 first, then " " \040, tab \011, newline \012; <path> is
// the physical parent from pwd -P plus the name, so tab and newline can get here through a link in the input),
// else the lines of `mount` ("dev on /p (opts)": after the first " on ", before the last " ("). Strings are
// compared first, no mount point is stat'ed for that (a hung network mount must not block). A case-insensitive file
// system (APFS, HFS+, SMB, vfat) takes "Folder" for "folder": a mount path that matches <path> only without ASCII case
// (tr A-Z a-z, path and table each folded once, a line only when the table holds the folded path at all) is checked
// once more by identity, its part as long as <path> (decoded) -ef <path>. Only that one candidate is stat'ed, and only
// on such a near match, so a case-sensitive file system blocks nothing more than before. Not for a link as <path> (rm deletes
// only the link). No readable table: deletes as before.
// <info> and <mount>: files that stand in for the two tables (tests only), omitted in production.
// The mount guard is MOUNT_FN, shared with move.js.
// `x <path> <input> [<info> [<mount>]]`
export const REMOVE_SCRIPT = `${SAME_FN}
${MOUNT_FN}
case $1 in /?*) ;; *) echo "Refusing to delete: $1" >&2; exit 2 ;; esac
case $1 in */|*//*|*/./*|*/../*|*/.|*/..) echo "Refusing to delete: $1" >&2; exit 2 ;; esac
case $1 in /*/*) ;; *) echo "Refusing to delete: $1" >&2; exit 2 ;; esac
same "$1" "$2" || { echo "The path changed while it was checked: $2" >&2; exit 5; }
V=delete
if [ ! -L "$1" ]; then mounted "$1" "$3" "$4" || exit 6; fi
rm -r -f -- "$1"
if [ -e "$1" ] || [ -L "$1" ]; then echo "Could not delete: $1" >&2; exit 1; fi`;

// `x <parent> <name>`: creates the folder <name> in <parent> and prints its physical path. Exit 2 for a parent
// that is not absolute or a name that is empty, "." / ".." or holds a "/", 3 when <parent> is no folder that
// can be entered, 4 when <name> exists already (also as a file, a link or a dead link). <parent> is resolved
// with cd -P, pwd -P (the "x" is cut off again with the one newline of pwd, so a trailing newline in a folder
// name survives $(...)). mkdir without -p and with "--": the parent must exist, a leading "-" is no option, and
// an entry that appears after the check makes mkdir itself fail (exit 4 again, nothing is overwritten).
export const MKDIR_SCRIPT = `p=$1 n=$2
case $p in /*) ;; *) echo "Refusing to create a folder in: $p" >&2; exit 2 ;; esac
case $n in ""|.|..|*/*) echo "Refusing to create a folder named: $n" >&2; exit 2 ;; esac
R=$(cd -P -- "$p" 2>/dev/null && pwd -P && printf x) || exit 3
R=\${R%x}; R=\${R%"
"}
[ -n "$R" ] || exit 3
case $R in /) t=/$n ;; *) t=$R/$n ;; esac
if [ -e "$t" ] || [ -L "$t" ]; then exit 4; fi
mkdir -- "$t" || { if [ -e "$t" ] || [ -L "$t" ]; then exit 4; fi; exit 1; }
printf '%s' "$t"`;

const TRASH_BIN = "/usr/bin/trash";

// exec-backed rename and delete. Every path goes in as an argument, never into a shell string.
// deps: { exec, trashBin? }. Results: { ok: true, ... } or { ok: false, error }.
export function createFileOps({ exec, trashBin = TRASH_BIN }) {
  const failure = (e, on) => ({ ok: false, error: explainError(String(e?.message ?? e), on) });
  const run = (cmd, args, on) => exec(cmd, args, { on });

  // The guard for delete and rename: normalized path, then the physical check. Nothing is changed here.
  // path in the answer is the checked physical one (physical parent plus name): rm, mv and trash get that.
  async function check({ on = null, path, root, verb = "delete" }) {
    if (typeof root !== "string" || root === "") return { ok: false, error: "root is required" };
    if (typeof path !== "string" || !path.startsWith("/")) return { ok: false, error: "path must be absolute" };
    if (!root.startsWith("/")) return { ok: false, error: "root must be absolute" };
    if (CONTROL.test(path)) return { ok: false, error: CONTROL_ERROR };
    const p = normalizePath(path), r = normalizePath(root);
    const early = p === "/" || badSpelling(p) ? guardVerdict({ path: p, info: {}, rootPath: r, on, verb }) : null;
    if (early) return { ok: false, error: early };
    let res;
    try {
      res = await run("sh", ["-c", GUARD_SCRIPT, "x", p, r, nameKey(baseName(p)) === nameKey(baseName(r)) ? "1" : "0", ""], on);
    } catch (e) {
      return failure(e, on);
    }
    if (res.code !== 0) return { ok: false, error: explainError(res.stderr, on, "Could not check the path") };
    const info = parseGuard(res.stdout);
    const error = guardVerdict({ path: p, info, rootPath: r, on, verb });
    if (error) return { ok: false, error };
    return { ok: true, path: joinPath(info.parent, baseName(p)), name: baseName(p), isDir: info.type === "d" };
  }

  async function rename({ on = null, path, root, name }) {
    if (typeof root !== "string" || root === "") return { ok: false, error: "root is required" };
    const bad = validateName(name ?? "");
    if (bad) return { ok: false, error: bad };
    if (typeof path !== "string" || !path.startsWith("/")) return { ok: false, error: "path must be absolute" };
    const p = normalizePath(path);
    if (name === baseName(p)) return { ok: false, error: "The name is unchanged" };
    const c = await check({ on, path: p, root, verb: "rename" });
    if (!c.ok) return c;
    const dest = joinPath(parentOf(c.path), name);
    const input = normalizePath(path);
    // Only a hint: the script itself requires the same file (-ef) and no link before the plain mv.
    const caseOnly = (on ? nameKey(baseName(c.path)) === nameKey(name) : platform.pathKey(baseName(c.path)) === platform.pathKey(name)) ? "1" : "0";
    let res;
    try {
      res = await run("sh", ["-c", RENAME_SCRIPT, "x", c.path, dest, caseOnly, input], on);
    } catch (e) {
      return failure(e, on);
    }
    if (res.code === 0) return { ok: true, path: dest };
    if (res.code === 3) return { ok: false, error: `No such file or folder: ${c.path}` };
    if (res.code === 4) return { ok: false, error: `"${name}" already exists` };
    if (res.code === 5) return { ok: false, error: `The path changed while it was checked: ${input}` };
    return { ok: false, error: explainError(res.stderr, on, "Could not rename") };
  }

  // New folder: the parent must exist and be a folder, an existing name (file or folder) is never touched.
  async function mkdir({ on = null, path, name }) {
    const bad = validateName(name ?? "");
    if (bad) return { ok: false, error: bad };
    if (typeof path !== "string" || !path.startsWith("/")) return { ok: false, error: "path must be absolute" };
    if (CONTROL.test(path)) return { ok: false, error: CONTROL_ERROR };
    let res;
    try {
      res = await run("sh", ["-c", MKDIR_SCRIPT, "x", path, name], on);
    } catch (e) {
      return failure(e, on);
    }
    if (res.code === 0) return { ok: true, path: res.stdout || joinPath(path, name) };
    if (res.code === 3) return { ok: false, error: `No such folder: ${path}` };
    if (res.code === 4) return { ok: false, error: `An item named "${name}" already exists` };
    return { ok: false, error: explainError(res.stderr, on, "Could not create the folder") };
  }

  // expect: the physical path the user confirmed (check before the dialog). The new check must land on the
  // same entry, else a link in the path was bent while the dialog was open and nothing is deleted.
  async function remove({ on = null, path, root, expect }) {
    const c = await check({ on, path, root, verb: "delete" });
    if (!c.ok) return c;
    if (expect !== undefined && c.path !== expect) return { ok: false, error: "The item changed while the dialog was open" };
    const done = { name: c.name, isDir: c.isDir };
    if (on) {
      let res;
      try {
        res = await run("sh", ["-c", REMOVE_SCRIPT, "x", c.path, normalizePath(path)], on);
      } catch (e) {
        return failure(e, on);
      }
      return res.code === 0 ? { ok: true, trashed: false, ...done } : { ok: false, error: explainError(res.stderr, on, "Could not delete") };
    }
    // trash has no "--": the path is absolute, so a leading "-" in a name cannot be read as an option.
    let res;
    try {
      res = await run("sh", ["-c", CONFIRM_SCRIPT, "x", c.path, normalizePath(path)], null);
    } catch (e) {
      return failure(e, null);
    }
    if (res.code !== 0) return { ok: false, error: explainError(res.stderr, null, "The path changed while it was checked") };
    try {
      res = await run(trashBin, ["-s", "-v", c.path], null);
    } catch {
      return { ok: false, error: "Moving to the Trash needs macOS 15 or later" };
    }
    if (res.code !== 0) return { ok: false, error: explainError(res.stderr, null, "Could not move to the Trash") };
    const moved = / to "(.*)"\s*$/m.exec(res.stdout ?? "");
    return { ok: true, trashed: true, ...(moved ? { trash_path: moved[1] } : {}), ...done };
  }

  return { check, rename, remove, mkdir };
}

// The toast after a successful UI request; null where there is nothing to say.
export function successToast(req, out) {
  if (!out?.ok) return null;
  if (req.action === "rename") return { title: "Renamed", body: `${baseName(req.path)} → ${baseName(out.path)}`, level: "success" };
  if (req.action === "mkdir") return { title: "Folder created", body: baseName(out.path), level: "success" };
  if (req.action === "delete") {
    return out.trashed
      ? { title: "Moved to Trash", body: out.name, level: "success" }
      : { title: "Deleted", body: `${out.name} on ${req.machine}`, level: "success" };
  }
  return null;
}
