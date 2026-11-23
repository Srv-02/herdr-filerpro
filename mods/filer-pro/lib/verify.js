// The check before a moved original is deleted (#100). Pure; the script runs as
// `sh -c VERIFY_SCRIPT verify <path> <L|P> <hashMaxBytes> <seconds>` locally or on a machine (non-login sh, POSIX tools
// only, GNU and BSD/macOS). It counts what a copy must have: files, folders, bytes, plus a SHA-256 over the content.
//
// Prints one line, exit code always 0:
//   -1                                      the path does not exist
//   v1 <files> <dirs> <bytes> <newest> <digest>
//   partial | timeout                       find ended with an error / the watchdog stopped it after <seconds>
// find -L (L) follows links like scp does, find -P (P) does not (the target of a copy holds real files).
// files: regular files, dirs: folders (the item itself counts), bytes: sum of file sizes, newest: the largest mtime in
// seconds over files and folders. digest: a file -> its SHA-256; a folder -> the SHA-256 of the sorted list
// "<hash> <relative path>" of its files; "-" over <hashMaxBytes>; "?" when the side has no sha256sum, shasum or sha256.
// The watchdog is its own process, like in lib/sizes.js: find ends on the machine at the limit even when the caller is gone.
// The hash walk gets what is left of <seconds>. Status of find travels through fd 3.
export const VERIFY_SCRIPT = String.raw`p=$1 l=$2 m=$3 n=$4
case $p in -*) p=./$p ;; esac
case $l in P) ;; *) l=L ;; esac
case $m in ""|*[!0-9]*) m=0 ;; esac
case $n in ""|*[!0-9]*) n=590 ;; esac
if [ ! -e "$p" ] && [ ! -L "$p" ]; then echo -1; exit 0; fi
if stat -c%s / >/dev/null 2>&1; then o=-c ff='f %s %Y' fd='d %s %Y'; else o=-f ff='f %z %m' fd='d %z %m'; fi
t0=$(date +%s)
r=$( { {
  find -"$l" "$p" \( -type f -exec stat -L "$o" "$ff" {} + \) -o \( -type d -exec stat -L "$o" "$fd" {} + \) 2>/dev/null &
  fp=$!
  ( trap 'kill "$sp" 2>/dev/null; exit 0' TERM
    sleep "$n" & sp=$!
    wait "$sp" && kill "$fp" 2>/dev/null ) >/dev/null 2>&1 3>&- &
  wp=$!
  wait "$fp"; rc=$?
  kill "$wp" 2>/dev/null
  echo "rc=$rc" >&3
} 2>/dev/null | awk '$1 == "f" { f++; s += $2 } $1 == "d" { d++ } { if ($3 + 0 > w) w = $3 + 0 } END { printf "n=%.0f %.0f %.0f %.0f\n", f, d, s, w }'; } 3>&1 )
c=$(printf '%s\n' "$r" | sed -n 's/^rc=//p')
case $c in ""|*[!0-9]*) c=1 ;; esac
if [ "$c" -gt 128 ]; then echo timeout; exit 0; fi
if [ "$c" -ne 0 ]; then echo partial; exit 0; fi
set -- $(printf '%s\n' "$r" | sed -n 's/^n=//p')
nf=$1 nd=$2 nb=$3 nw=$4
case $nf$nd$nb$nw in ""|*[!0-9]*) echo partial; exit 0 ;; esac
dg=-
if [ "$nb" -le "$m" ]; then
  dg='?'
  H=
  for h in "sha256sum" "shasum -a 256" "sha256 -r"; do
    set -- $h
    if command -v "$1" >/dev/null 2>&1; then H=$h; break; fi
  done
  if [ -n "$H" ]; then
    if [ -d "$p" ]; then
      if cd -P -- "$p" 2>/dev/null; then
        left=$((n - ($(date +%s) - t0))); [ "$left" -ge 1 ] || left=1
        q=$( { {
          find -"$l" . -type f -exec $H {} + 2>/dev/null &
          fp=$!
          ( trap 'kill "$sp" 2>/dev/null; exit 0' TERM
            sleep "$left" & sp=$!
            wait "$sp" && kill "$fp" 2>/dev/null ) >/dev/null 2>&1 3>&- &
          wp=$!
          wait "$fp"; rc=$?
          kill "$wp" 2>/dev/null
          echo "rc=$rc" >&3
        } 2>/dev/null | awk '{ h = $1; sub(/^\\/, "", h); x = $0; sub(/^[^ ]+ [ *]?/, "", x); print h " " x }'; } 3>&1 )
        c=$(printf '%s\n' "$q" | sed -n 's/^rc=//p')
        case $c in ""|*[!0-9]*) c=1 ;; esac
        if [ "$c" -gt 128 ]; then echo timeout; exit 0; fi
        if [ "$c" -ne 0 ]; then echo partial; exit 0; fi
        dg=$(printf '%s\n' "$q" | sed '/^rc=/d' | LC_ALL=C sort | $H | awk '{ print $1; exit }')
        case $dg in ""|*[!0-9a-f]*) dg='?' ;; esac
      fi
    else
      dg=$($H < "$p" 2>/dev/null | awk '{ print $1; exit }')
      case $dg in ""|*[!0-9a-f]*) dg='?' ;; esac
    fi
  fi
fi
echo "v1 $nf $nd $nb $nw $dg"`;

export const VERIFY_MS = 600_000;
export const VERIFY_LIMIT_S = 590;
export const HASH_MAX_BYTES = 1_000_000_000;

// argv after "sh": links is "L" (follow, like scp) or "P" (do not follow). The path stays at args[3], like sizeArgs.
export const verifyArgs = (path, links) => ["-c", VERIFY_SCRIPT, "verify", path, links, String(HASH_MAX_BYTES), String(VERIFY_LIMIT_S)];

// stdout -> { files, dirs, bytes, newest, digest }, or null (missing path, partial, timeout, anything unexpected)
export function parseVerify(stdout) {
  const m = /^\s*v1 (\d+) (\d+) (\d+) (\d+) (-|\?|[0-9a-f]{64})\s*$/.exec(String(stdout ?? ""));
  return m ? { files: Number(m[1]), dirs: Number(m[2]), bytes: Number(m[3]), newest: Number(m[4]), digest: m[5] } : null;
}

export const KEPT_UNKNOWN = "The copy could not be checked";
export const KEPT_MISMATCH = "The copy does not match the original";
export const KEPT_CHANGED = "The original changed during the copy";
export const KEPT_NO_HASH = "No SHA-256 tool to check the copy";
export const KEPT_CANCELLED = "Cancelled before the original was deleted";
export const KEPT_RESTART = "Herdr was restarted";
export const KEPT_RESTART_DELETE = "Herdr was restarted during the delete. Check the original";
export const KEPT_NO_ROOT = "The folder shown at Cut is not known";

const SAME = ["files", "dirs", "bytes"];

// before: the original measured before the copy, source: measured after it, target: the copy. Any of them null -> kept.
// ok only when the original did not change and the copy has the same files, folders and bytes (and the same SHA-256 up to
// HASH_MAX_BYTES). newest is compared with the original only, never with the target.
export function verdict({ before, source, target }) {
  if (!before || !source || !target) return { kept: KEPT_UNKNOWN };
  if ([...SAME, "newest", "digest"].some((k) => before[k] !== source[k])) return { kept: KEPT_CHANGED };
  if (SAME.some((k) => source[k] !== target[k])) return { kept: KEPT_MISMATCH };
  if (source.bytes <= HASH_MAX_BYTES) {
    if (source.digest === "?" || target.digest === "?") return { kept: KEPT_NO_HASH };
    if (source.digest !== target.digest) return { kept: KEPT_MISMATCH };
  }
  return { ok: true };
}
