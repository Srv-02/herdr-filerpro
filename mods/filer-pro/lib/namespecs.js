// Settings of the name dialog (mods/filer-pro/ui/namedialog.js), kept pure so they run under node --test.
import { validateName, renameCheck } from "./fileops.js";
import { stemEnd } from "./names.js";

// Rename: starts with the name, selects its stem, the button stays off while the name is unchanged.
export function renameSpec({ name, isDir }) {
  return { title: "Rename", button: "Rename", id: "rename", value: name, selectEnd: stemEnd(name, isDir), check: (v) => renameCheck(v, name) };
}

// New Folder: starts with "New Folder", all of it selected, any valid name is fine.
export function newFolderSpec() {
  const value = "New Folder";
  return { title: "New Folder", button: "Create", id: "mkdir", value, selectEnd: value.length, check: (v) => validateName(v) };
}
