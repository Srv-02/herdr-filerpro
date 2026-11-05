// Link safety check that runs before every folder transfer. Pure; the script runs as
// `sh -c LINKS_SCRIPT links <dir>` locally or on the remote (non-login sh, GNU and BSD/macOS,
// no `readlink -f`: directories resolve via `cd -P`/`pwd -P`).
//
// Output: per risky link three NUL-terminated fields `kind\0link\0target\0` (link relative to
// the folder, target the resolved absolute path), at most 50 records PER KIND, then
// `total=<n> outside=<a> loop=<b>\n` counting ALL risky links (n = a + b). No `total=` line means the check failed.
// Risky: `loop` (target is the folder itself or an ancestor of the link's own directory) or
// `outside` (target resolves outside the folder). A directory link that resolves inside the
// folder is also `loop` when another directory link lies under its target (catches mutual cycles;
// conservative). Dead links and other links inside are ignored.
// Relative targets without `.`/`..` components take a fast path (no cd, no subshell); readlink runs
// once per find batch (falls back to one call per link if its output cannot be matched up).

export const LINKS_SCRIPT = String.raw`
R=$(cd -P -- "$1" 2>/dev/null && pwd -P && echo x) || exit 1
R=@{R%?x}
T=$(mktemp -d) || exit 1
trap 'rm -rf "$T"' EXIT
trap 'rm -rf "$T"; exit 1' HUP INT TERM
echo 0 0 > "$T/n" || exit 1
find "$R" -type l -exec sh -c '
for l in "$@"; do
  [ -d "$l" ] && printf "%s\n" "$l"
done
exit 0
' sh {} + > "$T/d" 2>/dev/null || exit 1
find "$R" -type l -exec sh -c '
R=$1; T=$2; shift 2
nl="
"
read no lo < "$T/n"
all=$nl$(cat "$T/d")$nl
one() {
[ -e "$l" ] || return 0
ld=@{l%/*}
kind=; res=; fast=
case $p in
  /*|""|.|./*|*/.|*/./*|..|../*|*/..|*/../*|*/|*//*) ;;
  *) fast=1; res=$ld/$p ;;
esac
if [ -z "$fast" ]; then
  case $p in /*) ;; *) p=$ld/$p ;; esac
  hops=0
  while :; do
    if [ -d "$p" ]; then res=$(cd -P "$p" 2>/dev/null && pwd -P); break; fi
    [ -e "$p" ] || break
    d=@{p%/*}; b=@{p##*/}
    [ -n "$d" ] || d=/
    d=$(cd -P "$d" 2>/dev/null && pwd -P) || break
    case $d in /) p=/$b ;; *) p=$d/$b ;; esac
    if [ -L "$p" ]; then
      hops=$((hops + 1)); [ "$hops" -le 40 ] || break
      t=$(readlink "$p"; echo x) || break
      t=@{t%?x}
      case $t in /*) p=$t ;; *) p=$d/$t ;; esac
      continue
    fi
    res=$p; break
  done
  [ -n "$res" ] || return 0
  if [ "$res" = / ]; then kind=loop
  else
    case "$ld/" in "$res"/*) kind=loop ;; esac
    case "$res/" in "$R"/*) ;; *) [ -n "$kind" ] || kind=outside ;; esac
  fi
fi
if [ -z "$kind" ] && [ -d "$l" ]; then
  case "$all" in *"$nl$res/"*) kind=loop ;; esac
fi
[ -n "$kind" ] || return 0
if [ "$kind" = outside ]; then
  if [ "$no" -lt 50 ]; then printf "%s\0%s\0%s\0" "$kind" "@{l#"$R"/}" "$res"; fi
  no=$((no + 1))
else
  if [ "$lo" -lt 50 ]; then printf "%s\0%s\0%s\0" "$kind" "@{l#"$R"/}" "$res"; fi
  lo=$((lo + 1))
fi
}
c=0
if out=$(readlink "$@" 2>/dev/null); then
  while IFS= read -r x; do c=$((c + 1)); done <<LINES_END
$out
LINES_END
fi
if [ "$c" -eq "$#" ]; then
  while IFS= read -r p; do
    l=$1; shift
    one
  done <<LINES_END
$out
LINES_END
else
  for l in "$@"; do
    p=$(readlink "$l"; echo x) || continue
    p=@{p%?x}
    one
  done
fi
echo "$no $lo" > "$T/n"
' sh "$R" "$T" {} + 2>/dev/null || exit 1
read no lo < "$T/n"
printf "total=%s outside=%s loop=%s\n" "$((no + lo))" "$no" "$lo"
`.trim().replaceAll("@{", "$" + "{");

const KINDS = new Set(["outside", "loop"]);

// stdout of LINKS_SCRIPT -> { risky, total, outside, loop } or null when unreadable.
export function parseLinks(stdout) {
  if (typeof stdout !== "string") return null;
  const cut = stdout.lastIndexOf("\0") + 1;
  const tail = /^total=(\d+) outside=(\d+) loop=(\d+)\n?$/.exec(stdout.slice(cut));
  if (!tail) return null;
  const [total, outside, loop] = tail.slice(1).map(Number);
  if (total !== outside + loop) return null;
  const fields = stdout.slice(0, cut).split("\0");
  fields.pop(); // empty piece after the last NUL
  if (fields.length % 3 !== 0) return null;
  const risky = [];
  for (let i = 0; i < fields.length; i += 3) {
    const [kind, link, target] = fields.slice(i, i + 3);
    if (!KINDS.has(kind)) return null;
    risky.push({ kind, link, target });
  }
  if (risky.filter((r) => r.kind === "outside").length > outside) return null;
  if (risky.filter((r) => r.kind === "loop").length > loop) return null;
  return { risky, total, outside, loop };
}

const plural = (n, one, many) => (n === 1 ? one : many);

// Dialog { title, text, blocked } before a folder transfer; null when there is nothing to warn about.
// A folder with at least one loop is blocked (R74): scp follows the loop down to ELOOP and fails,
// so the dialog only offers OK and the example is always a loop link.
export function linkWarning(result, name) {
  if (!result) {
    return { title: "Could not check symlinks", text: `Could not check "${name}" for symlinks. If it has any, scp copies what they point to.`, blocked: false };
  }
  if (result.total === 0) return null;
  const { outside, loop } = result;
  const title = "Symlink found!";
  if (loop > 0) {
    const first = result.risky.find((r) => r.kind === "loop");
    const eg = first ? ` (e.g. ${first.link} → ${first.target})` : "";
    return { title, blocked: true, text: `"${name}" contains ${loop === 1 ? "1 symlink" : `${loop} symlinks`} looping back into it${eg}. scp cannot transfer a folder with a symlink loop.` };
  }
  const first = result.risky.find((r) => r.kind === "outside");
  const eg = first ? `(e.g. ${first.link} → ${first.target})` : "";
  return { title, blocked: false, text: `"${name}" contains ${outside} ${plural(outside, "symlink", "symlinks")} pointing outside it ${eg}. scp copies what ${plural(outside, "it points", "they point")} to.` };
}
