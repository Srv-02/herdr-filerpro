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
