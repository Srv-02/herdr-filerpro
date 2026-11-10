#!/bin/sh
# filer-pro extract: unpack an archive next to itself (this computer or a machine) and put the result in place (#57).
# Usage: extract.sh <target|-> <tool> <need|-> <archive> <sub|-> <file|-> <temp> <dest_dir> <status_file> <trash_dir> [<entry> <mode> <name>]...
#   target   "-" for this computer, else the ssh target of the machine that holds the archive (everything below runs there)
#   tool     tar | bsdtar | unzip | gzip | bzip2 | xz | zstd (what the probe in lib/archives.js picked)
#   need     the helper a compressed tar needs (gzip|bzip2|xz|zstd) or "-"; only used for the "is not installed" message
#   archive  path of the archive (never changed)
#   sub      "-" for Extract Here, else the folder name for Extract to: the extraction dir x is <temp>/d or <temp>/d/<sub>
#   file     output name for gzip|bzip2|xz|zstd (<x>/<file>), "-" otherwise
#   temp     work folder, must not exist yet (named .<name>.fs-<id>.part like the temp of transfer.sh; the id names the job)
#   dest_dir folder the extracted entries go to
#   status_file, trash_dir   as for transfer.sh
#   plan triples: <entry> top-level name in <temp>/d, <mode> skip | new | replace | merge, <name> target name in dest_dir.
#     An entry that no triple names is moved as "new" under its own name; a triple whose entry does not exist is a no-op.
# Steps: extract into <temp>/d; count links that point outside; move "new" entries (an existing target is an error, nothing is
# overwritten); hand every replace / merge entry to transfer.sh (place, or rplace on a machine: Trash, merge and the mount
# guard stay in one place); remove <temp>.
# Env: FILER_PRO_SSH (default ssh), FILER_PRO_SSH_CONNECT_TIMEOUT / _ALIVE_INTERVAL / _ALIVE_COUNT (digits only),
#   FILER_PRO_MACHINE (machine name for messages, default "this computer"), FILER_PRO_TRANSFER (default: transfer.sh next to this).
# Writes <status_file> (state=done|failed|cancelled, code=<n>, last 20 stderr lines) like transfer.sh. Exit 0 only for done,
# 130 for cancelled. stderr text: "Warning: <n> link(s) point(s) outside the extracted files" (comes before anything that
# finalization prints), "<tool> is not installed on <machine>", "Encrypted archives are not supported",
# "Destination already exists: <path>", else the tool's own messages.
# Must stay POSIX sh (dash and macOS sh).

usage() {
  echo "usage: extract.sh <target|-> <tool> <need|-> <archive> <sub|-> <file|-> <temp> <dest_dir> <status_file> <trash_dir> [<entry> <mode> <name>]..." >&2
  exit 2
}
[ $# -ge 10 ] && [ $((($# - 10) % 3)) -eq 0 ] || usage

target=$1 tool=$2 need=$3 archive=$4 sub=$5 file=$6 temp=$7 destdir=$8 status=$9
shift 9
trash=$1
shift
case $tool in tar|bsdtar|unzip|gzip|bzip2|xz|zstd) ;; *) usage ;; esac
case $sub in .|..|*/*|'') usage ;; esac
# A plan name never has a slash: it would leave the folders below <temp>/d and <dest_dir>.
check_plan() {
  while [ $# -ge 3 ]; do
    case $1 in ''|.|..|*/*) usage ;; esac
    case $2 in skip|new|replace|merge) ;; *) usage ;; esac
    case $3 in ''|.|..|*/*) usage ;; esac
    shift 3
  done
}
check_plan "$@"

SSH=${FILER_PRO_SSH:-ssh}
TRANSFER=${FILER_PRO_TRANSFER:-$(dirname "$0")/transfer.sh}
machine=${FILER_PRO_MACHINE:-this computer}
num() { case $1 in ''|*[!0-9]*) R=$2 ;; *) R=$1 ;; esac; }
num "${FILER_PRO_SSH_CONNECT_TIMEOUT-}" 15; ssh_ct=$R
num "${FILER_PRO_SSH_ALIVE_INTERVAL-}" 15; ssh_ai=$R
num "${FILER_PRO_SSH_ALIVE_COUNT-}" 4; ssh_ac=$R
SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=$ssh_ct -o ServerAliveInterval=$ssh_ai -o ServerAliveCountMax=$ssh_ac"

# Relative paths get "./" so a leading "-" can never be read as an option (see transfer.sh).
abs() {
  case $1 in
    /*) R=$1 ;;
    *) R=./$1 ;;
  esac
}
abs "$archive"; archive=$R
abs "$temp"; temp=$R
abs "$destdir"; destdir=$R
abs "$status"; status=$R
abs "$trash"; trash=$R
err="$status.err"
out="$status.out"

q() { _q=$(printf '%s.' "$1" | sed "s/'/'\\\\''/g"); printf "'%s'" "${_q%.}"; }

# rs: the stdin script for a remote sh in RS, see transfer.sh (only the constant "sh -s" travels in the ssh command line).
rs() {
  _s=$1
  shift
  _a=
  for _x; do _a="$_a $(q "$_x")"; done
  RS="set --$_a
{ $_s
} </dev/null"
}

# id from .<name>.fs-<id>.part, as in transfer.sh
tb=${temp##*/}
case $tb in
  .*.fs-*.part) id=${tb%.part}; id=${id##*.fs-} ;;
  *) id=$$ ;;
esac
# The side shell carries "fs-<id>" in its arguments, so EXTRACT_STOP_SCRIPT can tell it from a reused pid. Over ssh the
# argument travels in the command line, which the login shell parses: only a plain [a-z0-9] id is safe for csh.
case $id in
  ""|*[!a-z0-9]*) sshcmd="sh -s" ;;
  *) sshcmd="sh -s fs-$id" ;;
esac

: > "$err"

write_status() { # state code
  {
    printf 'state=%s\ncode=%s\n' "$1" "$2"
    tail -n 20 "$err" 2>/dev/null
  } > "$status.tmp" && mv -f -- "$status.tmp" "$status"
  rm -f -- "$err" "$out"
}

# EXTRACT_STOP_SCRIPT of mods/filer-pro/lib/archives.js (this script is standalone sh and cannot import it;
# test/extract.test.js checks that both stay the same text). Run on the side: sh -c SCRIPT x <temp> <id>
# BEGIN EXTRACT_STOP_SCRIPT
stop_sh() {
  cat <<'EOF'
[ -n "$1" ] && [ -n "$2" ] || exit 1
p=$(cat -- "$1/pid" 2>/dev/null)
case "$p" in ''|*[!0-9]*) ;; *)
  a=$(ps -p "$p" -o args= 2>/dev/null)
  case "$a" in *" fs-$2 "*|*" fs-$2") kill "$p" 2>/dev/null
    i=0; while [ "$i" -lt 5 ] && kill -0 "$p" 2>/dev/null; do sleep 1; i=$((i+1)); done;; esac;;
esac
rm -rf -- "$1"
exit 0
EOF
}
# END EXTRACT_STOP_SCRIPT
STOP_SH=$(stop_sh)

# remove_side: remove <temp> on the side after the work is done (or failed).
remove_side() {
  if [ "$target" = - ]; then
    rm -rf -- "$temp"
  else
    rs 'rm -rf -- "$1"' "$temp"
    printf '%s\n' "$RS" | "$SSH" $SSH_OPTS "$target" "sh -s" >/dev/null 2>&1
  fi
}

# stop_side: end the side shell of this job and remove <temp> (cancel).
stop_side() {
  if [ "$target" = - ]; then
    sh -c "$STOP_SH" x "$temp" "$id" >/dev/null 2>&1
  else
    rs "$STOP_SH" "$temp" "$id"
    printf '%s\n' "$RS" | "$SSH" $SSH_OPTS "$target" "sh -s" >/dev/null 2>&1
  fi
}

pid=
on_cancel() {
  trap '' HUP INT TERM
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
  fi
  stop_side
  write_status cancelled 130
  exit 130
}
trap on_cancel HUP INT TERM

fail() { # code
  trap '' HUP INT TERM
  write_status failed "$1"
  exit "$1"
}

# The side body: one script text, run by `sh -c BODY fs-<id> <args>` here or as `sh -s` over ssh.
#   args: <machine> <tool> <need> <archive> <sub> <file> <temp> <dest_dir> [<entry> <mode> <name>]...
#   stdout: the 1-based numbers of the plan triples with mode replace/merge whose entry exists (extract.sh hands them to
#           transfer.sh); everything else the user should read goes to stderr
#   exit 0 ok, 1 extraction failed (temp removed), 2 <temp> could not be created (nothing touched), 4 an entry could not
#   be moved (the rest is done), 130 stopped
body_sh() {
  cat <<'EOF'
m=$1 tool=$2 need=$3 a=$4 sub=$5 file=$6 temp=$7 dest=$8
shift 8
L=$(locale -a 2>/dev/null | grep -i -m1 -E '^(C|en_US)\.utf-?8$'); [ -n "$L" ] && LC_ALL=$L && export LC_ALL
# <temp> must not exist: a leftover of someone else is never reused or removed
mkdir -- "$temp" || exit 2
printf '%s\n' "$$" > "$temp/pid"
c=
stopped() {
  [ -n "$c" ] && kill "$c" 2>/dev/null
  [ -n "$c" ] && wait "$c" 2>/dev/null
  exit 130
}
trap stopped HUP INT TERM
x=$temp/d
mkdir -- "$x" || exit 1
if [ "$sub" != - ]; then
  x=$x/$sub
  mkdir -- "$x" || exit 1
fi
if ! command -v "$tool" >/dev/null 2>&1; then
  printf '%s is not installed on %s\n' "$tool" "$m" >&2
  rm -rf -- "$temp"
  exit 1
fi
# One background process, so a stop can end exactly this one. stdin is /dev/null, the messages go to <temp>/err.
# bsdtar always gets a dummy passphrase ("--passphrase ''" is refused by bsdtar: "Empty passphrase is unacceptable"): on an
# encrypted zip it must fail, not ask on the terminal (for a tar it is ignored).
case $tool in
  tar) ( exec tar -x -o --no-same-permissions -f "$a" -C "$x" </dev/null >"$temp/err" 2>&1 ) & ;;
  bsdtar) ( exec bsdtar -x -o --no-same-permissions --passphrase x -f "$a" -C "$x" </dev/null >"$temp/err" 2>&1 ) & ;;
  unzip) ( exec unzip -o -q -P '' "$a" -d "$x" </dev/null >"$temp/err" 2>&1 ) & ;;
  *) ( exec "$tool" -dc < "$a" > "$x/$file" 2>"$temp/err" ) & ;;
esac
c=$!
wait "$c"
rc=$?
c=
# unzip: 1 is a warning (for example a repeated name), 82 a wrong or missing password
[ "$tool" = unzip ] && [ "$rc" -eq 1 ] && rc=0
e=$(cat -- "$temp/err" 2>/dev/null)
if [ "$tool" = unzip ] && [ "$rc" -eq 82 ]; then e="password $e"; rc=1; fi
if [ "$rc" -ne 0 ]; then
  case $e in
    *[Pp]assword*|*[Pp]assphrase*|*[Ee]ncrypt*) echo 'Encrypted archives are not supported' >&2 ;;
    *)
      if [ "$need" != - ] && ! command -v "$need" >/dev/null 2>&1; then
        printf '%s is not installed on %s\n' "$need" "$m" >&2
      elif [ -n "$e" ]; then
        printf '%s\n' "$e" >&2
      else
        printf '%s failed (exit %s)\n' "$tool" "$rc" >&2
      fi ;;
  esac
  rm -rf -- "$temp"
  exit 1
fi
rm -f -- "$temp/err"

# From here on a signal is deferred: moving the entries is short and must not be left half done.
trap '' HUP INT TERM

# Links in the result that point outside (an absolute target or a "..") are extracted as they are; the job only says so.
n=$(find "$temp/d" -type l -exec sh -c 'for l; do t=$(readlink "$l"); case $t in /*|..|../*|*/..|*/../*) echo x ;; esac; done' sh {} + 2>/dev/null | wc -l)
n=$((n + 0))
if [ "$n" -eq 1 ]; then
  echo 'Warning: 1 link points outside the extracted files' >&2
elif [ "$n" -gt 1 ]; then
  echo "Warning: $n links point outside the extracted files" >&2
fi

# look <entry> <triples...>: M = mode, N = target name (not named: new, own name)
look() {
  k=$1
  shift
  M=new N=$k
  while [ $# -ge 3 ]; do
    if [ "$1" = "$k" ]; then M=$2 N=$3; return; fi
    shift 3
  done
}
bad=0
# The check before mv leaves a window: a symlink to a folder created at <dest>/<name> in between would make mv put the
# entry INTO the link's target. -n never replaces anything; GNU mv -T renames onto the path itself (never into it), BSD
# and macOS mv -h do not follow a symlink there. A source that is still in place afterwards was not moved: the target
# appeared in between. (Busybox and others get -n only.)
if mv --version 2>/dev/null | grep -q GNU; then MV="-n -T"
else case $(uname -s 2>/dev/null) in Darwin|*BSD) MV="-n -h" ;; *) MV=-n ;; esac
fi
# The three globs cover every name (dotfiles too); the existence check drops a pattern that matched nothing.
for e in "$temp/d"/* "$temp/d"/.[!.]* "$temp/d"/..?*; do
  [ -e "$e" ] || [ -L "$e" ] || continue
  look "${e##*/}" "$@"
  [ "$M" = new ] || continue # skip stays, replace / merge go to transfer.sh
  t=$dest/$N
  if [ -e "$t" ] || [ -L "$t" ]; then
    printf 'Destination already exists: %s\n' "$t" >&2
    bad=1
  else
    # newer GNU mv exits 1 when -n skipped the move; its own message says why for any other failure
    f=0
    mv $MV -- "$e" "$t" 2>/dev/null || [ -e "$t" ] || [ -L "$t" ] || mv $MV -- "$e" "$t" || f=1
    if [ -e "$e" ] || [ -L "$e" ]; then
      [ "$f" -eq 1 ] || printf 'Destination already exists: %s\n' "$t" >&2
      f=1
    fi
    [ "$f" -eq 0 ] || bad=1
  fi
done
i=0
while [ $# -ge 3 ]; do
  i=$((i + 1))
  case $2 in
    replace|merge) if [ -e "$temp/d/$1" ] || [ -L "$temp/d/$1" ]; then echo "$i"; fi ;;
  esac
  shift 3
done
[ "$bad" -eq 0 ] || exit 4
exit 0
EOF
}
BODY=$(body_sh)

if [ "$target" = - ]; then
  sh -c "$BODY" "fs-$id" "$machine" "$tool" "$need" "$archive" "$sub" "$file" "$temp" "$destdir" "$@" </dev/null >"$out" 2>>"$err" &
else
  rs "$BODY" "$machine" "$tool" "$need" "$archive" "$sub" "$file" "$temp" "$destdir" "$@"
  printf '%s\n' "$RS" | "$SSH" $SSH_OPTS "$target" "$sshcmd" >"$out" 2>>"$err" &
fi
pid=$!
wait "$pid"
rc=$?
pid=

# From here on stderr goes to the status file, and signals are deferred (finalization must not be left half done).
exec 2>>"$err"
trap '' HUP INT TERM

case $rc in
  0|4) ;;
  2) fail 1 ;; # <temp> was not ours, leave it alone
  *) remove_side; fail 1 ;;
esac
bad=0
[ "$rc" -eq 0 ] || bad=1

# replace / merge: transfer.sh finalizes <temp>/d/<entry> -> <dest_dir>/<name>. $out lists the triples whose entry exists.
if [ "$target" = - ]; then dirn=place; else dirn=rplace; fi
i=0
while [ $# -ge 3 ]; do
  entry=$1 mode=$2 name=$3
  shift 3
  i=$((i + 1))
  case $mode in replace|merge) ;; *) continue ;; esac
  grep -qx "$i" "$out" 2>/dev/null || continue
  sf="$status.$i"
  sh "$TRANSFER" "$dirn" "$mode" "$target" "$archive" "$destdir/$name" "$temp/d/$entry" "$sf" "$trash" </dev/null
  trc=$?
  # The status file of transfer.sh: state= and code= first, then the stderr lines (also the warning of a replace whose
  # old copy could not be removed completely).
  [ -f "$sf" ] && sed '1,2d' "$sf" >> "$err"
  [ "$trc" -eq 0 ] || bad=1
  rm -f -- "$sf" "$sf.err" "$sf.tmp"
done

remove_side
if [ "$bad" -ne 0 ]; then
  fail 1
fi
write_status done 0
exit 0
