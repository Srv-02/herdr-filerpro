// Bookkeeping of the file tree. Pure.

// A folder that was open is gone (renamed or deleted): it and everything below it leave the open
// folders and the loaded entries, without an error message.
export function pruneFolder(folders, entries, path) {
  const gone = (p) => p === path || p.startsWith(`${path}/`);
  for (const p of [...folders]) if (gone(p)) folders.delete(p);
  for (const p of [...entries.keys()]) if (gone(p)) entries.delete(p);
}

// The listing script ends with `test -d`: it fails silently exactly when the folder is not there.
// Any message (unreachable machine, no access) is a real error.
export function folderMissing(result) {
  return result.code !== 0 && String(result.stderr ?? "").trim() === "";
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
export function visibleRows(entries, folders, { limit = 5000, maxDepth = 40 } = {}) {
  const out = [];
  const walk = (prefix, depth) => {
    if (out.length >= limit || depth > maxDepth) return;
    for (const entry of entries.get(prefix) ?? []) {
      if (out.length >= limit) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      out.push({ path, entry, depth });
      if (entry.dir && folders.has(path)) walk(path, depth + 1);
    }
  };
  walk("", 0);
  return out;
}
