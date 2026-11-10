// The mod's clipboard (shared("filer-pro.clipboard")) and where a paste goes. Pure.

import { parentOf } from "./names.js";

const CUT_ERROR = "Cut and Paste work only within one machine";

// machine: null is this computer. cut: true marks a Cut entry; a Copy entry has no cut field at all.
export function clipEntry({ on, path, isDir, at, cut }) {
  const entry = { machine: on ?? null, path, isDir: isDir === true, at };
  if (cut === true) entry.cut = true;
  return entry;
}

// What a paste into `folder` on `on` (null = this computer) means for the copied entry.
export function pastePlan(clip, { on, folder }) {
  if (!clip || typeof clip.path !== "string" || clip.path === "") return { error: "Nothing to paste" };
  const from = clip.machine ?? null, to = on ?? null;
  if (clip.cut === true) {
    if (from !== to) return { error: CUT_ERROR };
    return { direction: from === null ? "local" : "remote", machine: from, src: clip.path, destDir: folder, move: true };
  }
  // A copy from one machine to another runs through this computer (scp -3); machine is the one that holds the target.
  if (from !== null && to !== null && from !== to) return { direction: "cross", from, machine: to, src: clip.path, destDir: folder };
  const direction = from === null ? (to === null ? "local" : "up") : to === null ? "down" : "remote";
  return { direction, machine: from ?? to, src: clip.path, destDir: folder };
}

// folder (optional): the target folder, only to dim a Cut that would land in its own folder.
export function pasteState(clip, on, folder) {
  const plan = pastePlan(clip, { on, folder: folder ?? "/" });
  if (plan.error) return { enabled: false, reason: plan.error };
  if (plan.move && typeof folder === "string" && parentOf(clip.path) === (folder.replace(/\/+$/, "") || "/")) return { enabled: false, reason: "Already in this folder" };
  return { enabled: true, reason: null };
}
