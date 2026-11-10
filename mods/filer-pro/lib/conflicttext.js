// Texts of the target conflict dialog. Pure, so tests can reach them without the UI kit.
// item: { name, isDir, action?, destIsDir?, direction?, machine?, mergeError? } as the dialog gets it.

// Texts of the warning before a copy between two machines (ui/conflict.js crossView). item: { from, machine }.
export const CROSS_NOTE = "You can turn this warning off in Settings, Advanced, Transfers & connections.";
export function crossText(item) {
  return `Copied through this Mac: the data travels from ${item.from} to this Mac and on to ${item.machine}, twice over your connection.`;
}

// Machine that holds the target: an upload, a copy on one machine and a copy between machines write there.
function targetMachine(item) {
  return item.direction === "up" || item.direction === "remote" || item.direction === "cross" ? item.machine ?? null : null;
}

// kind of the entry in the way: the dialog knows it as destIsDir (a move always, a copy since #54).
// Without it (older callers) a copy falls back to the kind of the source.
export function conflictKind(item) {
  return (item.action === "move" ? item.destIsDir : item.destIsDir ?? item.isDir) ? "folder" : "file";
}

// What Replace (and for folders Merge) does to the existing entry. Replace goes to the Trash on the Mac
// and is final on a machine; Merge overwrites same-named files for good and exists for no move.
export function conflictHint(item) {
  const kind = conflictKind(item);
  const machine = targetMachine(item);
  const replace = machine === null
    ? `Replace moves the existing ${kind} to the Trash.`
    : `Replace deletes the existing ${kind} on ${machine} permanently.`;
  if (item.isDir !== true || kind !== "folder" || item.action === "move") return replace;
  // A linked folder is copied as the link: the dialog offers no Merge and says why (#46).
  return item.mergeError ? `${replace} A symlink cannot be merged.` : `${replace} Merge overwrites files with the same name.`;
}

export function conflictText(item) {
  return `A ${conflictKind(item)} named "${item.name}" already exists in the target folder. ${conflictHint(item)}`;
}
