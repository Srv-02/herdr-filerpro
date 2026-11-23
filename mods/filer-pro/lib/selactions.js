// Request fields for an action on the selected rows (#99), shared by the menu and the selection bar. Pure.
import { shellPath } from "./names.js";
import { group } from "./numbers.js";

// action: "download" | "download_to" | "copy" | "cut" | "delete". on: machine name or null (this computer). items: [{ path, isDir }]
// (the collapsed selection, absolute paths). dest: the folder of Download to…. Null without items or for another action.
export function selectionRequest(action, { on = null, root, items, dest }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const paths = items.map((i) => i.path);
  const machine = on ? { machine: on } : {};
  switch (action) {
    case "download":
    case "download_to":
      return on
        ? { action: "download", machine: on, paths, ...(dest ? { dest_dir: dest } : {}) }
        : { action: "copy", paths, ...(dest ? { folder: dest } : {}) };
    case "copy":
    case "cut":
      return { action: "clip", ...machine, items: items.map((i) => ({ path: i.path, is_dir: i.isDir === true })), ...(action === "cut" ? { cut: true } : {}), ...(root ? { root } : {}) };
    case "delete":
      return { action: "delete", ...machine, paths, root };
    default:
      return null;
  }
}

// Copy N Paths: one shell-quoted path per line.
export const pathsText = (items) => items.map((i) => shellPath(i.path)).join("\n");

// The tooltip and label of a bar button; without a selection (the Select Files mode with nothing checked) the plain verb.
export function barLabel(action, count) {
  const verb = { download: "Download", copy: "Copy", cut: "Cut", delete: "Delete" }[action];
  if (count < 1) return action === "delete" ? "Delete…" : verb;
  const what = count === 1 ? "1 Item" : `${group(count)} Items`;
  return action === "delete" ? `Delete ${what}…` : `${verb} ${what}`;
}
