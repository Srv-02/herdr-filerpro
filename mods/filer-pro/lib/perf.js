// Perf mode: timings kept in memory, written to a file by the caller. Pure, no Herdr imports.
// Phases: render, preview.prepare, mermaid.exec, timer.lag.

// Relative to appHome().
export const PERF_DIR = "data/filer-pro";
export const PERF_FILE = `${PERF_DIR}/perf.jsonl`;

export function createPerf({ now, cap = 20000 }) {
  let pending = [], kept = []; // kept: JSON lines
  return {
    sample(phase, ms, extra) { pending.push({ t: now(), phase, ms, ...extra }); },
    // Returns the samples since the last call and moves them into the capped log.
    drain() {
      const out = pending;
      pending = [];
      for (const sample of out) kept.push(JSON.stringify(sample));
      if (kept.length > cap) kept.splice(0, kept.length - cap);
      return out;
    },
    // The whole log as JSON lines (for fs.writeFile: appendFile is not documented).
    text() { return kept.length ? kept.join("\n") + "\n" : ""; },
  };
}

// A timer callback that logs how late the timer fired against its interval: the main thread's
// responsiveness (the thread that also draws and handles input). Run it from cx.timer.every(interval).
export function lagProbe({ now, perf, interval }) {
  let last = null;
  return () => {
    const t = now();
    if (last !== null) perf.sample("timer.lag", Math.max(0, t - last - interval));
    last = t;
  };
}
