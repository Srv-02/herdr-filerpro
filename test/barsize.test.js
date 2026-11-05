import { test } from "node:test";
import assert from "node:assert/strict";
import { barHeight, rowHeight, errorLines, BAR_MAX_H, ERROR_CHARS_PER_LINE } from "../mods/filer-pro/lib/barsize.js";

const job = (id, state = "running", extra = {}) => ({ id, state, name: `f${id}.txt`, bytes: 0, total: 59000, ...extra });

test("one row is padding, three lines and two gaps: 12 + 20 + 16 + 16 + 6 = 70", () => {
  for (const state of ["running", "done", "cancelled", "failed"]) assert.equal(rowHeight(job(1, state)), 70, state);
});

test("a single job makes the bar as high as its row plus the top border, not the maximum", () => {
  assert.equal(barHeight([job(1, "done")]), 71);
  assert.equal(barHeight({ a: job(1) }), 71);
  assert.ok(barHeight([job(1)]) < BAR_MAX_H);
});

test("no jobs, no bar", () => {
  for (const jobs of [[], {}, null, undefined]) assert.equal(barHeight(jobs), 0);
});

test("rows add up until the maximum of 220, from there the bar keeps 220 and scrolls", () => {
  assert.equal(barHeight([job(1), job(2)]), 141);
  assert.equal(barHeight([job(1), job(2), job(3)]), 211);
  assert.equal(barHeight([job(1), job(2), job(3), job(4)]), BAR_MAX_H);
  assert.equal(barHeight(Array.from({ length: 50 }, (_, i) => job(i))), BAR_MAX_H);
});

test("a failed job with an error adds a gap and its error lines", () => {
  assert.equal(rowHeight(job(1, "failed", { error: "Permission denied" })), 70 + 3 + 16);
  const long = "x".repeat(ERROR_CHARS_PER_LINE * 2 + 1);
  assert.equal(rowHeight(job(1, "failed", { error: long })), 70 + 3 + 3 * 16);
  assert.equal(rowHeight(job(1, "failed", { error: "" })), 70);
  assert.equal(rowHeight(job(1, "done", { error: "stale" })), 70); // the bar shows errors only for failed jobs
  assert.equal(barHeight([job(1, "failed", { error: "a" }), job(2, "done")]), 1 + 89 + 70);
});

test("errorLines counts wrapped and explicit lines", () => {
  assert.equal(errorLines(""), 0);
  assert.equal(errorLines(undefined), 0);
  assert.equal(errorLines("short"), 1);
  assert.equal(errorLines("x".repeat(ERROR_CHARS_PER_LINE)), 1);
  assert.equal(errorLines("x".repeat(ERROR_CHARS_PER_LINE + 1)), 2);
  assert.equal(errorLines("a\nb\n"), 3);
});
