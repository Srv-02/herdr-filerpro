// Bookkeeping of the file tree. Pure.
import { psQuoted } from "./names.js";
import { group } from "./numbers.js";
import { SYSTEM_CASE, psHideFilter } from "./hidden.js";

// `files <dir> <limit> [<system> <dots> [<real> [<sizes>]]]`: NUL-separated kind (d/f) and name of each entry but .git, at most <limit> + 1
// of them (one past the limit tells main.js that the folder was cut); ends with `test -d`, see folderMissing.
// <system> and <dots> are 1 or 0 (lib/hidden.js hideArgs): 1 skips system files or dot names before they are counted;
// <dots> 1 skips the system files too (lib/hidden.js effectiveHide), also for a caller that passes the raw settings.
// A folder that is there but cannot be read or searched ends with exit code LIST_DENIED (3) instead of an empty listing.
// <real> 1 (local listings, issue #42): the first pair is P and the folder's real path (cd -P, pwd -P; empty when it
// cannot be entered), so a folder reached through a symlink can match the folder watch's paths without another exec.
// <sizes> 1 (setting show_sizes, issue #58): after the pairs comes S and the sizes in bytes of the f entries, one per line
// in listing order, from one batched stat (xargs) in the same sh -c: never one stat per file. A symlink counts as the
// link itself (no -L). Without <sizes> the script runs no other command than before (the paths go to /dev/null).
export const LIST_SCRIPT = 'if [ "$5" = 1 ]; then printf "P\\0%s\\0" "$(cd -P -- "$1" 2>/dev/null && pwd -P)"; fi; if [ -d "$1" ] && { [ ! -r "$1" ] || [ ! -x "$1" ]; }; then exit 3; fi; n=0; cr=$(printf \'\\r\'); l() { for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ "$4" = 1 ]; then case $name in .*) continue;; esac; fi; if [ "$3" = 1 ] || [ "$4" = 1 ]; then case $name in ' + SYSTEM_CASE + ') continue;; esac; fi; if [ -d "$p" ]; then kind=d; else kind=f; printf "%s\\0" "$p" >&3; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt "$2" ] && break; done; }; if [ "$6" = 1 ]; then if stat -c%s / >/dev/null 2>&1; then f=-c%s; else f=-f%z; fi; exec 4>&1; s=$(l "$@" 3>&1 >&4 | xargs -0 stat "$f" -- 2>/dev/null); printf "S\\0%s\\0" "$s"; else l "$@" 3>/dev/null; fi; test -d "$1"';

// The Windows listing: JSON of { name, dir } for at most `limit` + 1 entries. Windows PowerShell otherwise uses the
// console code page; exec decodes UTF-8. Reparse points keep directory attributes even when dangling; check their target.
// `limit` is a whole number from lib/settings.js; `hide` the switches of lib/hidden.js, filtered before the limit.
// sizes (show_sizes): each entry also carries size, the Length of a file (null for a folder).
export function psListCommand(path, limit, hide, sizes = false) {
  return "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git'" + psHideFilter(hide) + " | Select-Object -First " + (Math.trunc(limit) + 1) + " | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0]))))))" + (sizes ? "; size=$_.Length" : "") + " } }) | ConvertTo-Json -Compress } '" + psQuoted(path) + "'";
}

// The entries of a LIST_SCRIPT output: [{ name, dir, size? }] with real ("" unknown) set. size (bytes) only on files and
// only when the S block has exactly one number per file: a file that vanished between the listing and the stat would
// shift every size, so a count that does not match leaves the whole folder without sizes.
export function parseListing(stdout) {
  const fields = String(stdout ?? "").split("\0"), out = [];
  const first = fields[0] === "P" && fields.length > 1 ? 2 : 0;
  let sizes = null;
  for (let i = first; i + 1 < fields.length; i += 2) {
    if (fields[i] === "S") { sizes = fields[i + 1]; break; }
    out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  }
  if (sizes !== null) {
    const files = out.filter((e) => !e.dir), list = sizes === "" ? [] : sizes.split("\n");
    if (list.length === files.length && list.every((v) => /^\d+$/.test(v))) files.forEach((e, i) => { e.size = Number(list[i]); });
  }
  out.real = first ? fields[1] : "";
  return out;
}

// The entries of the Windows listing (psListCommand): size kept only as a number on a file.
export function psEntries(result) {
  return (Array.isArray(result) ? result : [result]).filter((e) => e && typeof e === "object").map((e) => {
    const out = { name: e.name, dir: e.dir === true };
    if (!out.dir && Number.isFinite(e.size) && e.size >= 0) out.size = e.size;
    return out;
  });
}

export const limitText = (perFolder, total) => `File list limited to ${group(perFolder)} entries per folder and ${group(total)} total`;

// A folder that was open is gone (renamed or deleted): it and everything below it leave the open
// folders and the loaded entries, without an error message.
export function pruneFolder(folders, entries, path) {
  const gone = (p) => p === path || p.startsWith(`${path}/`);
  for (const p of [...folders]) if (gone(p)) folders.delete(p);
  for (const p of [...entries.keys()]) if (gone(p)) entries.delete(p);
}

export const LIST_DENIED = 3;
export const NO_LIST_MESSAGE = "No permission to list this folder";

// The listing script ends with `test -d`: it fails silently exactly when the folder is not there.
// Any message (unreachable machine, no access) is a real error.
export function folderMissing(result) {
  return result.code !== 0 && result.code !== LIST_DENIED && String(result.stderr ?? "").trim() === "";
}

// The folder to open after a new folder was created, as a path relative to the shown root; null when
// there is nothing to open (other machine, outside the shown folder, the shown folder itself).
// expand: { machine, folder } from filer-pro.changed.
export function expandPath(expand, root, on) {
  if (!expand || typeof expand.folder !== "string" || typeof root !== "string") return null;
  if ((expand.machine ?? null) !== (on ?? null)) return null;
  const base = root.replace(/\/+$/, "");
  return expand.folder.startsWith(`${base}/`) ? expand.folder.slice(base.length + 1).replace(/\/+$/, "") || null : null;
}

// Height of one tree row and the tree's padding on each side, in px (main.js rows() and render()).
export const ROW_H = 28, TREE_PAD = 6;

// The rows of the tree in display order: the entries of "" and, depth first, of every open folder.
// Stops at `limit` rows; a folder deeper than `maxDepth` is not descended into (rows up to depth maxDepth show).
// isDir(entry, path): does the row act as a folder (a macOS package only while its contents are shown, lib/bundles.js).
// A folder whose loaded list has `denied` set shows one note row below it instead of looking empty (issue #49).
export function visibleRows(entries, folders, { limit = 5000, maxDepth = 40, isDir = (entry) => entry.dir } = {}) {
  const out = [];
  const walk = (prefix, depth) => {
    if (out.length >= limit || depth > maxDepth) return;
    const list = entries.get(prefix) ?? [];
    if (list.denied && prefix && out.length < limit) out.push({ path: `${prefix}/`, entry: { name: NO_LIST_MESSAGE, dir: false, note: true }, depth });
    for (const entry of list) {
      if (out.length >= limit) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      out.push({ path, entry, depth });
      if (isDir(entry, path) && folders.has(path)) walk(path, depth + 1);
    }
  };
  walk("", 0);
  return out;
}
