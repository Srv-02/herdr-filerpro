// Texts of the target conflict dialog. Pure, so tests can reach them without the UI kit.
// item: { name, isDir, action?, destIsDir?, direction?, machine?, mergeError? } as the dialog gets it.
import { formatBytes } from "./sizes.js";

// Texts of the warning before a copy between two machines (ui/conflict.js crossView). item: { from, machine, count?,
// size? } with the herdr machine names; count is the number of pasted entries, size their bytes (null: unknown, left out).
export const THIS_COMPUTER = "this computer";
export const CROSS_DONT_SHOW = "Don't show again";
export const crossTitle = (item) => `Copy from ${item.from} to ${item.machine}?`;
export function crossText(item) {
  const n = Number.isInteger(item.count) && item.count > 0 ? item.count : 1;
  const amount = `${n} ${n === 1 ? "item" : "items"}${typeof item.size === "number" ? `, ${formatBytes(item.size)}` : ""}`;
  return `${amount}. The data travels through ${THIS_COMPUTER}: ${item.from} → ${THIS_COMPUTER} → ${item.machine}. Slower than a direct copy, and it uses ${THIS_COMPUTER}'s connection twice.`;
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
