// Height of the transfers bar (mods/filer-pro/ui/bar.js): as high as its rows, at most BAR_MAX_H (from there it scrolls).
// Pure. Every line in a row has a fixed height so that the sum here is the height drawn; only an error text
// can wrap, its line count is estimated from its length (too few lines: the bar scrolls, nothing is cut off).
export const BAR_MAX_H = 220;
export const BAR_BORDER = 1;
export const ROW_PAD_Y = 6, ROW_GAP = 3;
export const NAME_LINE_H = 20, TRACK_LINE_H = 16, SMALL_LINE_H = 16;
export const ERROR_CHARS_PER_LINE = 45;

export function errorLines(text) {
  if (typeof text !== "string" || text === "") return 0;
  return text.split("\n").reduce((n, part) => n + Math.max(1, Math.ceil(part.length / ERROR_CHARS_PER_LINE)), 0);
}

// One row: padding, name line, bar line, detail line, gaps between them, and the error lines of a failed job.
export function rowHeight(job) {
  const lines = [NAME_LINE_H, TRACK_LINE_H, SMALL_LINE_H];
  const err = job?.state === "failed" ? errorLines(job.error) : 0;
  if (err > 0) lines.push(err * SMALL_LINE_H);
  return 2 * ROW_PAD_Y + lines.reduce((a, b) => a + b, 0) + (lines.length - 1) * ROW_GAP;
}

// jobs: array or the object of shared("filer-pro.jobs"); 0 without jobs (no bar).
export function barHeight(jobs) {
  const list = Array.isArray(jobs) ? jobs : Object.values(jobs ?? {});
  if (list.length === 0) return 0;
  return Math.min(BAR_MAX_H, BAR_BORDER + list.reduce((h, job) => h + rowHeight(job), 0));
}
