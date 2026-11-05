// macOS packages (issue #14): folders the Finder shows and opens as one file. Pure.
//
// Only in a local tree on macOS: a folder whose name ends in one of BUNDLE_EXTENSIONS (any letter case) is a file row
// that opens with `open` (lib/open.js openBundle; a click as double_click_apps says, lib/clicks.js); "Show Package Contents" turns it into a folder row until it is
// collapsed. Developer packages (.xcodeproj, .framework, .bundle, ...) stay folders: people browse into them.
// Everything that changes the file system (copy, cut, download, delete) still treats a package as the folder it is.
import { icon } from "./icons.js";

export const BUNDLE_EXTENSIONS = Object.freeze(["app", "pkg", "rtfd"]);

// The file extension whose icon a package borrows from the shipped icon set: an application, an installer package
// (as .deb), a rich text document (as .rtf).
const ICON_AS = { app: "exe", pkg: "deb", rtfd: "rtf" };

// The lower-case package extension of a name, or null. A bare ".app" is a hidden folder, not a package.
function bundleExt(name) {
  const dot = String(name ?? "").lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return BUNDLE_EXTENSIONS.includes(ext) ? ext : null;
}

// Is a folder of this name a package? on: the machine of the tree (null = this computer); platform: window().platform.
export function isBundle(name, { on, platform }) {
  return !on && platform === "macos" && bundleExt(name) !== null;
}

// The entries of one listing, folders that are packages flagged with bundle: true (a new object; others unchanged).
export function markBundles(entries, where) {
  return entries.map((e) => (e.dir && isBundle(e.name, where) ? { ...e, bundle: true } : e));
}

// Does the row act as a folder (chevron, click expands, drop lands inside)? A package only while its contents are
// shown. path: the row's path relative to the root; packages: the paths whose contents are shown.
export function treeDir(entry, path, packages) {
  return Boolean(entry.dir) && !(entry.bundle && !packages?.has(path));
}

// Folders sort first; a package sorts among the files, so showing its contents does not move the row.
export function sortsAsFolder(entry) {
  return Boolean(entry.dir) && !entry.bundle;
}

// The icon of a package shown as a file.
export function bundleIcon(name, dark) {
  return icon(`package.${ICON_AS[bundleExt(name)] ?? "file"}`, false, false, dark);
}
