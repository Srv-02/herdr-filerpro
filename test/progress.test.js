import { test } from "node:test";
import assert from "node:assert/strict";
import { progressOf, barFill } from "../mods/filer-pro/lib/progress.js";

test("first sample", () => {
  const p = progressOf(null, 0, 1000, 5000);
  assert.deepEqual(p, { bytes: 0, at: 5000, lastGrowthAt: 5000, percent: 0, rate: 0, stalled: false });
});

test("growth sets lastGrowthAt and rate is smoothed", () => {
  const a = progressOf(null, 0, 1000, 0);
  const b = progressOf(a, 100, 1000, 1000); // inst 100/s, prev rate 0
  assert.equal(b.lastGrowthAt, 1000);
  assert.equal(b.rate, 0.3 * 100 + 0.7 * 0);
  assert.equal(b.percent, 10);
  const c = progressOf(b, 200, 1000, 2000);
  assert.equal(c.rate, 0.3 * 100 + 0.7 * b.rate);
});

test("prev without rate uses the instantaneous rate", () => {
  const p = progressOf({ bytes: 0, at: 0, lastGrowthAt: 0 }, 500, null, 1000);
  assert.equal(p.rate, 500);
  assert.equal(p.percent, null);
});

test("no growth keeps lastGrowthAt; stalled after 120000 ms", () => {
  const a = progressOf(null, 50, 100, 0);
  const b = progressOf(a, 50, 100, 120_000);
  assert.equal(b.lastGrowthAt, 0);
  assert.equal(b.stalled, false);
  const c = progressOf(b, 50, 100, 120_001);
  assert.equal(c.stalled, true);
  const d = progressOf(c, 51, 100, 130_000);
  assert.equal(d.stalled, false);
  assert.equal(d.lastGrowthAt, 130_000);
});

test("percent is capped at 99 and null without total", () => {
  assert.equal(progressOf(null, 100, 100, 0).percent, 99);
  assert.equal(progressOf(null, 250, 100, 0).percent, 99);
  assert.equal(progressOf(null, 99, 100, 0).percent, 99);
  assert.equal(progressOf(null, 5, 0, 0).percent, null);
  assert.equal(progressOf(null, 5, null, 0).percent, null);
  assert.equal(progressOf(null, -5, 100, 0).percent, 0);
});

test("non-positive dt keeps the previous rate; negative delta gives zero instantaneous", () => {
  const a = { bytes: 100, at: 1000, lastGrowthAt: 1000, rate: 40 };
  assert.equal(progressOf(a, 200, 1000, 1000).rate, 40);
  assert.equal(progressOf(a, 200, 1000, 900).rate, 40);
  assert.equal(progressOf(a, 50, 1000, 2000).rate, 0.7 * 40);
});

test("barFill", () => {
  const err = { width: "100%", tone: "error", pulse: false };
  assert.deepEqual(barFill({ state: "failed", percent: null }), err);
  assert.deepEqual(barFill({ state: "failed", percent: 37 }), err);
  assert.deepEqual(barFill({ state: "running", percent: null }), { width: "40%", tone: "accent", pulse: true });
  assert.deepEqual(barFill({ state: "running", percent: 37 }), { width: "37%", tone: "accent", pulse: false });
  assert.equal(barFill({ state: "running", percent: 140 }).width, "100%");
  assert.equal(barFill({ state: "running", percent: -5 }).width, "0%");
  assert.deepEqual(barFill({ state: "done", percent: 99 }), { width: "100%", tone: "accent", pulse: false });
  assert.deepEqual(barFill({ state: "cancelled", percent: 20 }), { width: "20%", tone: "accent", pulse: false });
});
