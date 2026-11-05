import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createPerf, lagProbe, PERF_DIR, PERF_FILE } from "../mods/filer-pro/lib/perf.js";
import { summary, check } from "../scripts/perf-report.mjs";
import { mkTmp } from "./tmp-helper.js";

const REPO = path.resolve(import.meta.dirname, "..");

test("sample and drain: drain returns the new samples and empties the queue", () => {
  const p = createPerf({ now: () => 7 });
  p.sample("render", 2, { file: "a.md" });
  assert.deepEqual(p.drain(), [{ t: 7, phase: "render", ms: 2, file: "a.md" }]);
  assert.deepEqual(p.drain(), []);
});

test("text() keeps what was drained as JSON lines and is capped", () => {
  const p = createPerf({ now: () => 1, cap: 3 });
  for (let i = 0; i < 5; i++) p.sample("render", i);
  p.drain();
  const lines = p.text().trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.ms), [2, 3, 4]);
});

test("lagProbe logs how late a 100 ms timer fires", () => {
  let clock = 1000;
  const p = createPerf({ now: () => clock }), tick = lagProbe({ now: () => clock, perf: p, interval: 100 });
  tick(); // the first call only sets the reference
  clock += 100; tick();
  clock += 130; tick();
  clock += 60; tick(); // early: no negative lag
  assert.deepEqual(p.drain().map((s) => [s.phase, s.ms]), [["timer.lag", 0], ["timer.lag", 30], ["timer.lag", 0]]);
});

test("summary: p50, p95, max (next higher rank)", () => {
  const s = summary(Array.from({ length: 100 }, (_, i) => ({ phase: "render", ms: i + 1 })));
  assert.deepEqual(s.render, { n: 100, p50: 50, p95: 95, max: 100 });
});

test("check reports violations of the limits", () => {
  const ok = { n: 10, p50: 1, p95: 8, max: 50 };
  assert.deepEqual(check({ "timer.lag": ok }), []);
  assert.deepEqual(check({ "timer.lag": { ...ok, p95: 9 } }), [{ phase: "timer.lag", metric: "p95", value: 9, limit: 8 }]);
  assert.deepEqual(check({ "timer.lag": { ...ok, max: 51 } }), [{ phase: "timer.lag", metric: "max", value: 51, limit: 50 }]);
  assert.deepEqual(check({ "preview.prepare": { n: 1, p50: 3, p95: 3, max: 17 } }), [{ phase: "preview.prepare", metric: "max", value: 17, limit: 16 }]);
  assert.deepEqual(check({ unknown: { n: 1, p50: 999, p95: 999, max: 999 } }), []);
});

test("report CLI: FAIL exits 1, PASS exits 0", async () => {
  const dir = await mkTmp("perf-");
  const line = (phase, ms) => JSON.stringify({ t: 1, phase, ms });
  await fs.writeFile(`${dir}/bad.jsonl`, [line("timer.lag", 80), line("render", 1)].join("\n") + "\n");
  await fs.writeFile(`${dir}/good.jsonl`, [line("timer.lag", 2), line("render", 1)].join("\n") + "\n");
  const run = (f) => spawnSync(process.execPath, [path.join(REPO, "scripts/perf-report.mjs"), f], { encoding: "utf8" });
  const bad = run(`${dir}/bad.jsonl`), good = run(`${dir}/good.jsonl`);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /FAIL/);
  assert.match(bad.stdout, /timer\.lag/);
  assert.equal(good.status, 0);
  assert.match(good.stdout, /PASS/);
  assert.equal(run("/nonexistent.jsonl").status, 2);
});

test("perf file lives under the app's data folder", () => {
  assert.equal(PERF_DIR, "data/filer-pro");
  assert.equal(PERF_FILE, "data/filer-pro/perf.jsonl");
});

test("drain serializes each sample once; text() does not serialize again", () => {
  const p = createPerf({ now: () => 1 });
  for (let i = 0; i < 5; i++) p.sample("render", i);
  const real = JSON.stringify;
  let calls = 0;
  JSON.stringify = (...a) => { calls++; return real(...a); };
  try {
    p.drain();
    p.text(); p.text();
    p.sample("render", 9); p.drain(); p.text();
  } finally { JSON.stringify = real; }
  assert.equal(calls, 6);
});
