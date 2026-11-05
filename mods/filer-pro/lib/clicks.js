// What a click on a file row or a macOS package row does (issue #21). Pure.
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
