// The mod's clipboard (shared("filer-pro.clipboard")) and where a paste goes. Pure.
// An entry is { machine, items: [{ path, isDir }], at, cut? }; an older entry { machine, path, isDir, at } reads as a list of one (#99).

import { parentOf } from "./names.js";

// A Cut across two sides deletes the original afterwards (#100): the delete guards need the folder shown at Cut time.
export const MOVE_ROOT_ERROR = "Cut it again to move it to another machine";

// machine: null is this computer. cut: true marks a Cut entry; a Copy entry has no cut field at all.
// root: the folder the tree showed at Cut time, kept only when it is a non-empty absolute path.
export function clipEntry({ on, items, at, cut, root }) {
  const entry = { machine: on ?? null, items: (items ?? []).map((i) => ({ path: i.path, isDir: i.isDir === true })), at };
  if (cut === true) entry.cut = true;
  if (typeof root === "string" && root.startsWith("/")) entry.root = root;
  return entry;
}

// The items of an entry: the list, or an old single entry as a list of one; entries without a path are dropped.
export function clipItems(clip) {
  const ok = (i) => Boolean(i) && typeof i.path === "string" && i.path !== "";
  if (Array.isArray(clip?.items)) return clip.items.filter(ok).map((i) => ({ path: i.path, isDir: i.isDir === true }));
  return ok(clip) ? [{ path: clip.path, isDir: clip.isDir === true }] : [];
}

// The same entry: same machine, time and item paths.
export function sameClip(a, b) {
  if (!a || !b || a.at !== b.at || (a.machine ?? null) !== (b.machine ?? null)) return false;
  const x = clipItems(a), y = clipItems(b);
  return x.length === y.length && x.every((i, n) => i.path === y[n].path);
}

// What a paste into `folder` on `on` (null = this computer) means for the copied entry.
export function pastePlan(clip, { on, folder }) {
  const srcs = clipItems(clip).map((i) => i.path);
  if (srcs.length === 0) return { error: "Nothing to paste" };
  const from = clip.machine ?? null, to = on ?? null;
  if (clip.cut === true) {
    if (from === to) return { direction: from === null ? "local" : "remote", machine: from, srcs, destDir: folder, move: true };
    // Across sides: the copy directions plus move. Without the Cut's root nothing is moved: the delete would have no guard.
    if (typeof clip.root !== "string" || !clip.root.startsWith("/")) return { error: MOVE_ROOT_ERROR };
    const direction = from !== null && to !== null ? "cross" : from === null ? "up" : "down";
    return { direction, ...(direction === "cross" ? { from } : {}), machine: direction === "cross" ? to : from ?? to, srcs, destDir: folder, move: true, root: clip.root };
  }
  // A copy from one machine to another runs through this computer (scp -3); machine is the one that holds the target.
  if (from !== null && to !== null && from !== to) return { direction: "cross", from, machine: to, srcs, destDir: folder };
  const direction = from === null ? (to === null ? "local" : "up") : to === null ? "down" : "remote";
  return { direction, machine: from ?? to, srcs, destDir: folder };
}

// folder (optional): the target folder, only to dim a Cut that would land in its own folder (every item already there).
export function pasteState(clip, on, folder) {
  const plan = pastePlan(clip, { on, folder: folder ?? "/" });
  if (plan.error) return { enabled: false, reason: plan.error };
  if (plan.move && (plan.direction === "local" || plan.direction === "remote") && typeof folder === "string") {
    const here = folder.replace(/\/+$/, "") || "/";
    if (plan.srcs.every((s) => parentOf(s) === here)) return { enabled: false, reason: "Already in this folder" };
  }
  return { enabled: true, reason: null };
}
