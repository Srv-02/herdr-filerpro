import { test } from "node:test";
import assert from "node:assert/strict";
import { createReloadGate } from "../mods/filer-pro/lib/reload.js";

const clock = () => { let t = 0; return { now: () => t, tick: (ms) => { t += ms; } }; };

test("reload gate: the value at start is no change, a new signal reloads at once", () => {
  const c = clock(), g = createReloadGate({ now: c.now, at: 5 });
  assert.equal(g.signal(5), false);
  assert.equal(g.take(false), false);
  assert.equal(g.signal(6), true);
  assert.equal(g.take(false), true);
  assert.equal(g.take(false), false); // done once
});

test("reload gate: 100 finished jobs in a burst give one reload now and one after the gap", () => {
  const c = clock(), g = createReloadGate({ now: c.now, at: null });
  let reloads = 0;
  for (let i = 1; i <= 100; i++) {
    g.signal(i);
    if (g.take(false)) reloads++;
    c.tick(5); // 100 signals within 500 ms
  }
  assert.equal(reloads, 1);
  c.tick(400); // still inside the gap of 1 s
  assert.equal(g.take(false), false);
  c.tick(100);
  assert.equal(g.take(false), true);
  assert.equal(g.take(false), false);
});

test("reload gate: a signal during a running load is kept and done after it", () => {
  const c = clock(), g = createReloadGate({ now: c.now, at: null });
  g.signal(1);
  assert.equal(g.take(false), true);
  c.tick(2000);
  g.signal(2); // arrives while the load runs
  assert.equal(g.take(true), false);
  c.tick(3000);
  assert.equal(g.take(true), false);
  assert.equal(g.take(false), true); // the load is over: caught up
  assert.equal(g.take(false), false);
});
