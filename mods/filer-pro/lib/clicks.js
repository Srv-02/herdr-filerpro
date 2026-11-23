// What a click on a row does: the file row or package row (issue #21), the folder row (issue #90) and which kind of
// click it is, with several rows selectable (rowClick, issue #98). Pure.
//
// event: on_click's ClickEvent. GPUI reports a double click as two clicks, click_count 1 and then 2. double: the
// setting for the row (double_click_files for a file, double_click_apps for a local package, lib/bundles.js).
// -> "open", "select" (mark the row only) or null (nothing). With double on, the first press marks and the second
// opens; with it off, the first press opens. A later press of the same double or triple click never opens again.
// The rows take no keyboard focus, so every click comes from the pointer; an event without a count is one click.
export function fileClick(event, double) {
  const n = typeof event?.click_count === "number" ? event.click_count : 1;
  if (n <= 1) return double ? "select" : "open";
  return double && n === 2 ? "open" : null;
}

// What a click on a folder row does (issue #90). Pure. event: on_click's ClickEvent. double: the double_click_folders setting.
// -> "toggle" (open or close the folder), "root" (show it as the tree's root) or null (nothing). With double on, the first press
// toggles as ever and the second shows the folder as root; a later press of the same double or triple click does nothing.
// With it off every press toggles. An event without a count is one click.
export function folderClick(event, double) {
  const n = typeof event?.click_count === "number" ? event.click_count : 1;
  if (!double || n <= 1) return "toggle";
  return n === 2 ? "root" : null;
}

// Which modifiers a click holds (issue #98): "none", "cmd" (platform), "shift", "cmd_shift", "alt", "alt_shift",
// "cmd_alt" or "other". Ctrl is the macOS context menu and Fn is never a choice, so both are "other", as is Cmd+Option+Shift.
export function modifierKey(mods) {
  if (!mods) return "none";
  if (mods.control || mods.function) return "other";
  const cmd = Boolean(mods.platform);
  const alt = Boolean(mods.alt);
  const shift = Boolean(mods.shift);
  if (cmd && alt) return shift ? "other" : "cmd_alt";
  if (cmd) return shift ? "cmd_shift" : "cmd";
  if (alt) return shift ? "alt_shift" : "alt";
  return shift ? "shift" : "none";
}

// What a click on a tree row does with several rows selectable (issue #98). Pure. event: on_click's ClickEvent.
// multi: the multi_select setting. selecting: the Select Files checkbox mode. toggleKey, rangeKey: modifierKey values
// from the settings. remoteBinary: a remote binary file, which Show in Finder cannot download.
// -> "toggle", "range", "reveal" (Show in Finder), "row" (the plain file or folder click) or null (nothing).
// The reveal shortcut is Cmd, or Option+Cmd while multi is on because Cmd is then the toggle click. A toggle or range
// click with click_count above 1 does nothing, so a double click does not toggle twice.
export function rowClick(event, { multi, selecting, toggleKey, rangeKey, remoteBinary }) {
  const mods = event?.modifiers;
  const key = modifierKey(mods);
  const n = typeof event?.click_count === "number" ? event.click_count : 1;
  const revealHit = multi ? Boolean(mods?.platform && mods?.alt) : Boolean(mods?.platform);
  const reveal = revealHit && !remoteBinary;
  let kind;
  if (selecting) kind = reveal ? "reveal" : key === rangeKey ? "range" : "toggle";
  else if (multi && key === toggleKey) kind = "toggle";
  else if (multi && key === rangeKey) kind = "range";
  else kind = reveal ? "reveal" : "row";
  return (kind === "toggle" || kind === "range") && n > 1 ? null : kind;
}
