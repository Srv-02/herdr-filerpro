#!/bin/sh
# filer-pro transfer: scp download/upload, copy between two machines, local copy and copy on one machine with safe finalization.
# Usage: transfer.sh <down|up|local|remote|cross|place|rplace> <new|replace|merge> <target> <src> <dest> <temp> <status_file> <trash_dir> [<src_target>]
#   down: src is remote, dest/temp are local.  up: src is local, dest/temp are remote.
#   local: src, dest and temp are local (cp -R -P -p, never follows links); <target> is ignored ("-").
#   remote: src, dest and temp are all on <target> (cp -R -P -p in one ssh call, never follows links).
#   cross: src is on <src_target>, dest/temp are on <target> (scp -3: the data runs through this computer).
#     Only cross takes the 9th argument <src_target> (and requires it); every other direction takes exactly 8.
#   place, rplace: finalize only (extract.sh, #57). <temp> already holds the finished copy; nothing is copied, <temp> is
#     moved to <dest> with <mode> as for local (place, incl. the trash for replace and merge) or on <target> as for
#     up (rplace, incl. the mount guard). <src> is only used in messages.
# Writes <status_file> (state=done|failed|cancelled, code=<n>, last 20 stderr lines).
# Exit 0 only for done, 130 for cancelled.
# Must stay POSIX sh (dash and macOS sh).

usage() {
  echo "usage: transfer.sh <down|up|local|remote|cross|place|rplace> <new|replace|merge> <target> <src> <dest> <temp> <status_file> <trash_dir> [<src_target>]" >&2
  exit 2
}
case $1 in
  cross) [ $# -eq 9 ] || usage ;;
  down|up|local|remote|place|rplace) [ $# -eq 8 ] || usage ;;
  *) usage ;;
esac

dir=$1 mode=$2 target=$3 src=$4 dest=$5 temp=$6 status=$7 trash=$8 srctarget=${9-}
CP=${FILER_PRO_CP:-cp}
SCP=${FILER_PRO_SCP:-scp}
SSH=${FILER_PRO_SSH:-ssh}
# SSH options from the settings (jobs.js passes them via env only when they differ from the defaults). SSH_OPTS is
# word-split into the command line, so only digits are accepted; anything else means the default.
num() { case $1 in ''|*[!0-9]*) R=$2 ;; *) R=$1 ;; esac; }
num "${FILER_PRO_SSH_CONNECT_TIMEOUT-}" 15; ssh_ct=$R
num "${FILER_PRO_SSH_ALIVE_INTERVAL-}" 15; ssh_ai=$R
num "${FILER_PRO_SSH_ALIVE_COUNT-}" 4; ssh_ac=$R
SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=$ssh_ct -o ServerAliveInterval=$ssh_ai -o ServerAliveCountMax=$ssh_ac"

# Relative paths get "./" so a leading "-" can never be read as an option. Sets R, no $(...): that would
# drop trailing newlines, and "foo<newline>" would become its neighbour "foo".
abs() {
  case $1 in
    /*) R=$1 ;;
    *) R=./$1 ;;
  esac
}
abs "$src"; src=$R
abs "$dest"; dest=$R
abs "$temp"; temp=$R
abs "$status"; status=$R
abs "$trash"; trash=$R
err="$status.err"

# q: quote for the (remote) shell. g: mask glob characters for SFTP paths, result in G (its value can end
# in a newline, which $(g ...) would drop; q's output ends in a quote). The "." after the value keeps
# trailing newlines through $(...); it is cut off again.
q() { _q=$(printf '%s.' "$1" | sed "s/'/'\\\\''/g"); printf "'%s'" "${_q%.}"; }
g() { G=$(printf '%s.' "$1" | sed 's/[][*?\\]/\\&/g'); G=${G%.}; }

# rs: build the stdin script for a remote sh in RS: "set -- <quoted args>" first, then the script, run with
# </dev/null. Nothing but the constant "sh -s" travels in the ssh command line: ssh hands that to the login shell,
# and csh would choke on "!" (history, "Event not found") or a newline in a name, even inside quotes.
# In { } </dev/null sh reads the whole script before it runs anything, so no command inside can eat the rest of
# it from stdin. Usage: rs <script> [arg...]; the script reads the args as "$1", "$2", ...
rs() {
  _s=$1
  shift
  _a=
  for _x; do _a="$_a $(q "$_x")"; done
  RS="set --$_a
{ $_s
} </dev/null"
}

# id for the remote side-name, taken from .<name>.fs-<id>.part
tb=${temp##*/}
case $tb in
  .*.fs-*.part) id=${tb%.part}; id=${id##*.fs-} ;;
  *) id=$$ ;;
esac

: > "$err"

write_status() { # state code
  {
    printf 'state=%s\ncode=%s\n' "$1" "$2"
    tail -n 20 "$err" 2>/dev/null
  } > "$status.tmp" && mv -f -- "$status.tmp" "$status"
  rm -f -- "$err"
}

# remote: a dropped ssh connection does not stop the cp on the machine, so one ssh call stops it
# (pkill, then waits until it is gone) before the temp is removed. The pattern starts at "cp" and
# ends at the temp name: it matches the cp, never the shell that runs pkill (that command line
# neither starts with cp nor ends with the temp name). A single call, because a cancelled
# terminal is killed hard after a short grace period. The line runs under sh -c: ssh hands it to the
# login shell, and csh or fish cannot read sh's while loop (csh waits for an "end" that never comes).
# The sh command line ends in a quote, so the pattern does not match it either.
cleanup_temp() {
  if [ "$dir" = remote ]; then
    case $id in
      ""|*[!a-z0-9]*) rs 'rm -rf -- "$1"' "$temp" ;;
      *) rs 'pkill -f "$2"; n=0; while pgrep -f "$2" >/dev/null 2>&1 && [ $n -lt 25 ]; do sleep 0.2; n=$((n + 1)); done; rm -rf -- "$1"' \
           "$temp" "(^|/)cp -R -P -p -- .*fs-$id\\.part\$" ;;
    esac
    printf '%s\n' "$RS" | "$SSH" $SSH_OPTS "$target" "sh -s" >/dev/null 2>&1
  elif [ "$dir" = up ] || [ "$dir" = cross ] || [ "$dir" = rplace ]; then
    rs 'rm -rf -- "$1"' "$temp"
    printf '%s\n' "$RS" | "$SSH" $SSH_OPTS "$target" "sh -s" >/dev/null 2>&1
  else
    rm -rf -- "$temp"
  fi
}

pid=
on_cancel() {
  trap '' HUP INT TERM
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
  fi
  cleanup_temp
  write_status cancelled 130
  exit 130
}
trap on_cancel HUP INT TERM

fail() { # code
  trap '' HUP INT TERM
  cleanup_temp
  write_status failed "$1"
  exit "$1"
}

# scp -s forces SFTP mode (the legacy protocol would let the remote shell parse
# paths). In SFTP mode only the remote download source is glob-expanded, so
# only that one is masked with g(); an upload target is taken literally. cross: -3 routes the data through this
# computer (both ends remote); the source is masked like a download source.
# Run scp in the background and wait, so signals are handled immediately.
# local: cp -P never follows links, so links arrive as links.
# place, rplace: nothing to copy, <temp> is already there (the else branch below would run scp).
if [ "$dir" = place ] || [ "$dir" = rplace ]; then
  :
elif [ "$dir" = local ]; then
  "$CP" -R -P -p -- "$src" "$temp" </dev/null 2>>"$err" &
elif [ "$dir" = remote ]; then
  rs 'cp -R -P -p -- "$1" "$2"' "$src" "$temp"
  printf '%s\n' "$RS" | "$SSH" $SSH_OPTS "$target" "sh -s" 2>>"$err" &
else
  if [ "$dir" = down ]; then
    g "$src"
    from="$target:$G"
    to=$temp
  elif [ "$dir" = cross ]; then
    g "$src"
    from="$srctarget:$G"
    to="$target:$temp"
  else
    from=$src
    to="$target:$temp"
  fi
  if [ "$dir" = cross ]; then
    "$SCP" -3 -s -r -p $SSH_OPTS "$from" "$to" </dev/null 2>>"$err" &
  else
    "$SCP" -s -r -p $SSH_OPTS "$from" "$to" </dev/null 2>>"$err" &
  fi
fi
if [ "$dir" != place ] && [ "$dir" != rplace ]; then
  pid=$!
  wait "$pid"
  rc=$?
  pid=
  [ "$rc" -eq 0 ] || fail "$rc"
fi

# From here on stderr goes to the status file, and signals are deferred:
# finalization is short and must not be left half done.
exec 2>>"$err"
trap '' HUP INT TERM

exists() { [ -e "$1" ] || [ -L "$1" ]; }

# Local finalization (down, local).
# Merge helper, runs as "sh -c "$MERGE_SH" fs <temp> <dest>" (locally, or inside
# the remote script). Pass 1 refuses type clashes before touching anything,
# pass 2 moves entries one by one. A symlink in dest is replaced, never written
# through. find output is never parsed (-exec ... +), so odd names are safe.
MERGE_SH='
T=$1 D=$2
find "$T" -exec sh -c '"'"'
  T=$1 D=$2
  shift 2
  for p; do
    rel=${p#"$T"}
    [ -n "$rel" ] || continue
    d=$D$rel
    if [ -d "$p" ] && [ ! -L "$p" ]; then
      if { [ -e "$d" ] || [ -L "$d" ]; } && [ ! -L "$d" ] && [ ! -d "$d" ]; then
        echo "Type conflict (folder over file): $d" >&2
        exit 1
      fi
    elif [ -d "$d" ] && [ ! -L "$d" ]; then
      echo "Type conflict (file over folder): $d" >&2
      exit 1
    fi
  done
'"'"' sh "$T" "$D" {} + || exit 1
find "$T" -exec sh -c '"'"'
  T=$1 D=$2
  shift 2
  for p; do
    rel=${p#"$T"}
    [ -n "$rel" ] || continue
    d=$D$rel
    if [ -d "$p" ] && [ ! -L "$p" ]; then
      if [ -L "$d" ]; then rm -f -- "$d" || exit 1; fi
      [ -d "$d" ] || mkdir -- "$d" || exit 1
    else
      if [ -e "$d" ] || [ -L "$d" ]; then rm -f -- "$d" || exit 1; fi
      mv -- "$p" "$d" || exit 1
    fi
  done
'"'"' sh "$T" "$D" {} + || exit 1
rm -rf -- "$T"
'

# Mount guard, a copy of MOUNT_FN in mods/filer-pro/lib/fileops.js (this script is standalone sh and cannot import it;
# test/transfer.test.js checks that both stay the same text). The heredoc sits in a function: bash 3.2 (macOS sh)
# misparses a heredoc with ")" inside $(...). `mounted <path> [<info> [<mount>]]` returns 1 and prints
# "Refusing to $V, a file system is mounted at: <m>" when a file system is mounted at <path> or below it.
# Uses the variables s, E, e, t, f, l, m, k, tab, u, L, lk, c, j and ph. For a real folder <path> is checked once more in
# the form the file system stores (NFD "café" for an NFC call on APFS), from cd -P and the external pwd (env pwd -P;
# the builtin of bash keeps the spelling of the call). A hung mount at <path> in another spelling blocks that cd and
# nothing is deleted while it waits: the exec timeout or the stall detection ends it as an error, never as a free path.
mount_sh() {
  cat <<'EOF'
enc() { s=$E E=; while :; do case $s in *"$1"*) E=$E${s%%"$1"*}\\$2 s=${s#*"$1"} ;; *) E=$E$s; break ;; esac; done; }
dec() { s=$E E=; while :; do case $s in *"\\$1"*) E=$E${s%%"\\$1"*}$2 s=${s#*"\\$1"} ;; *) E=$E$s; break ;; esac; done; }
low() { L=$(printf '%sx' "$1" | LC_ALL=C tr A-Z a-z); L=${L%x}; }
hit() { printf 'Refusing to %s, a file system is mounted at: %s\n' "$V" "$1" >&2; return 1; }
scan() {
  while IFS= read -r l || [ -n "$l" ]; do
    if [ "$f" = info ]; then
      m=${l#* * * * }; m=${m%% *}
    else
      case $l in *" on "*" ("*) ;; *) continue ;; esac
      m=${l#* on }; m=${m% (*}
    fi
    case $m in "$k"|"$k"/*) hit "$m"; return ;; esac
    [ -n "$lk" ] && [ "${#m}" -ge "${#k}" ] || continue
    low "$m"
    case $L in "$lk"|"$lk"/*) ;; *) continue ;; esac
    c=$m j=$((${#m} - ${#k}))
    while [ "$j" -gt 0 ]; do c=${c%?} j=$((j - 1)); done
    if [ "$f" = info ]; then E=$c; dec 011 '	'; dec 012 '
'; dec 040 ' '; dec 134 '\'; c=$E; fi
    if [ "$c" -ef "$t" ]; then hit "$m"; return; fi
  done
}
mounted1() {
  t=$1 E=$1
  enc '\' 134; enc ' ' 040; enc '	' 011; enc '
' 012
  e=$E
  tab=${2:-/proc/self/mountinfo}
  if [ -r "$tab" ]; then f=info k=$e u=$(cat -- "$tab")
  elif [ -n "$3" ]; then f=bsd k=$t u=$(cat -- "$3" 2>/dev/null)
  else f=bsd k=$t u=$(mount 2>/dev/null)
  fi
  low "$k"; lk=$L; low "$u"
  case $L in *"$lk"*) ;; *) lk= ;; esac
  printf '%s\n' "$u" | scan
}
mounted() {
  mounted1 "$1" "$2" "$3" || return 1
  [ -d "$1" ] && [ ! -L "$1" ] || return 0
  ph=$(cd -P -- "$1" 2>/dev/null && { env pwd -P 2>/dev/null || pwd -P; } && printf x) || return 0
  ph=${ph%x}; ph=${ph%"
"}
  [ -n "$ph" ] && [ "$ph" != "$1" ] || return 0
  mounted1 "$ph" "$2" "$3"
}
EOF
}
MOUNT_SH=$(mount_sh)

local_replace() {
  if exists "$dest"; then
    mkdir -p -- "$trash" || return 1
    name=${dest##*/}
    base="$trash/$name $(date +%Y%m%d-%H%M%S)"
    t=$base n=0
    while exists "$t"; do
      n=$((n + 1))
      t="$base-$n"
    done
    mv -- "$dest" "$t" || return 1
    if ! mv -- "$temp" "$dest"; then
      mv -- "$t" "$dest"
      return 1
    fi
  else
    mv -- "$temp" "$dest"
  fi
}

local_finalize() {
  case $mode in
    new)
      if exists "$dest"; then
        echo "Destination already exists: $dest" >&2
        return 1
      fi
      mv -- "$temp" "$dest"
      ;;
    replace) local_replace ;;
    merge)
      if [ -d "$temp" ] && [ ! -L "$dest" ] && [ -d "$dest" ]; then
        # cp -P copied a linked source as the link, and find does not follow it: nothing would be merged (#46).
        if [ -L "$temp" ]; then
          echo "Cannot merge a symlink into a folder: $src" >&2
          return 1
        fi
        sh -c "$MERGE_SH" fs "$temp" "$dest"
      else
        local_replace
      fi
      ;;
    *) echo "Unknown mode: $mode" >&2; return 1 ;;
  esac
}

# Remote finalization (up, remote, cross), one ssh call. Runs under the remote /bin/sh.
REMOTE_BODY='
mode=$1 temp=$2 dest=$3 id=$4 mi=$5 mt=$6 src=$7
name=${dest##*/}
d=${dest%/*}
[ -n "$d" ] || d=/
old="$d/.$name.fs-old-$id"
exists() { [ -e "$1" ] || [ -L "$1" ]; }
# A real folder as the old target: refuse when a file system is mounted in it, before anything moves (rm -rf of the
# set-aside copy would delete its files). MOUNT_SH compares strings first, so the folder is resolved physically first
# (cd -P; the "x" keeps a trailing newline of the name). A link is replaced as the link, without a check.
unmounted() {
  [ -d "$dest" ] && [ ! -L "$dest" ] || return 0
  P=$(cd -P -- "$d" 2>/dev/null && pwd -P && printf x); P=${P%x}; P=${P%"
"}
  [ -n "$P" ] || { echo "Could not check the path: $d" >&2; return 1; }
  case $P in /) P=/$name ;; *) P=$P/$name ;; esac
  V=replace
  mounted "$P" "$mi" "$mt"
}
replace() {
  if exists "$dest"; then
    unmounted || return 1
    mv -- "$dest" "$old" || return 1
    if mv -- "$temp" "$dest"; then
      rm -rf -- "$old" || echo "Warning: could not fully remove old copy: $old" >&2
    else
      mv -- "$old" "$dest"
      return 1
    fi
  else
    mv -- "$temp" "$dest"
  fi
}
case $mode in
  new)
    if exists "$dest"; then
      echo "Destination already exists: $dest" >&2
      rm -rf -- "$temp"
      exit 1
    fi
    mv -- "$temp" "$dest" ;;
  replace) replace || { rm -rf -- "$temp"; exit 1; } ;;
  merge)
    if [ -d "$temp" ] && [ ! -L "$dest" ] && [ -d "$dest" ]; then
      if [ -L "$temp" ]; then # a linked source, copied as the link (see local_finalize, #46)
        echo "Cannot merge a symlink into a folder: $src" >&2
        rm -f -- "$temp"
        exit 1
      fi
      sh -c "$MERGE_SH" fs "$temp" "$dest" || { rm -rf -- "$temp"; exit 1; }
    else
      replace || { rm -rf -- "$temp"; exit 1; }
    fi ;;
  *) echo "Unknown mode: $mode" >&2; rm -rf -- "$temp"; exit 1 ;;
esac
'
REMOTE_SCRIPT="MERGE_SH=$(q "$MERGE_SH")
$MOUNT_SH
$REMOTE_BODY"

if [ "$dir" = down ] || [ "$dir" = local ] || [ "$dir" = place ]; then
  local_finalize
  frc=$?
else
  # The script goes in on stdin (see rs), the command line is the constant "sh -s".
  # FILER_PRO_MOUNTINFO / FILER_PRO_MOUNTS: files that stand in for the two mount tables (tests only, empty in
  # production); they travel as arguments, ssh does not pass the environment on.
  rs "$REMOTE_SCRIPT" "$mode" "$temp" "$dest" "$id" "${FILER_PRO_MOUNTINFO:-}" "${FILER_PRO_MOUNTS:-}" "$src"
  printf '%s\n' "$RS" | "$SSH" $SSH_OPTS "$target" "sh -s"
  frc=$?
fi

if [ "$frc" -ne 0 ]; then
  fail "$frc"
fi
write_status done 0
exit 0
