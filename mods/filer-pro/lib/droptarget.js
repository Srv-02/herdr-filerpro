// Where a drop lands, local and remote alike: the container (outside any row) means the shown
// folder, a folder row that folder, a file row the folder it lies in. Pure.
import { joinPath, parentOf } from "./names.js";

// root: the shown folder; rowPath: path of the row relative to root (null = container).
export function dropTarget(root, rowPath, rowIsDir) {
  if (rowPath == null) return root;
  if (rowIsDir) return joinPath(root, rowPath);
  const parent = parentOf(rowPath);
  return parent ? joinPath(root, parent) : root;
}

// The request file content for a drop; null when there is nothing to do.
export function dropRequest({ on, root, rowPath, rowIsDir, paths }) {
  if (!root || !Array.isArray(paths) || paths.length === 0) return null;
  const folder = dropTarget(root, rowPath, rowIsDir);
  return on ? { action: "upload", machine: on, paths, folder } : { action: "copy", paths, folder };
}
