// Rows as drag sources (#102). The payload of an in-app drop is unmeasured (Herdr 0.1.17): a drop of a remote
// row may arrive with remote paths, local copies or the source machine, so it is matched against the last press.
import { dropTarget } from "./droptarget.js";

// What a row drags: absolute paths on `on` (null = this computer).
export function dragSpec({ on, paths }) {
  if (!Array.isArray(paths) || paths.length === 0) return null;
  return { paths, on: on ?? null };
}

// The last mouse-down on a remote row; null for a local row.
export function pressMemory(on, paths, dirs, at) {
  return on ? { machine: on, paths, dirs, at } : null;
}

const same = (a, b) => a.length === b.length && a.every((p, i) => p === b[i]);

// What a drop on `dest` ({ on, root, rowPath, rowIsDir }) means. kind "local": handle as a Finder drop.
// kind "requests": the transfers of a remembered remote drag. kind "check": no remembered drag matches; the caller
// refuses when a path does not exist on this computer (it can only be a remote path).
export function dropPlan({ press, paths, dest }) {
  if (!Array.isArray(paths) || paths.length === 0) return { kind: "local" };
  if (!press || !same(press.paths, paths)) return { kind: "check" };
  const folder = dropTarget(dest.root, dest.rowPath, dest.rowIsDir);
  const src = press.machine;
  if (!dest.on) return { kind: "requests", requests: [{ action: "download", machine: src, paths, dest_dir: folder }] };
  const clip = { action: "clip", machine: src, items: paths.map((path, i) => ({ path, is_dir: press.dirs?.[i] === true })) };
  return { kind: "requests", requests: [clip, { action: "paste", machine: dest.on, folder }] };
}
