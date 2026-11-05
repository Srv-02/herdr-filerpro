// Progress math for the job manager. Pure. The returned object is fed back as `prev`.

const ALPHA = 0.3;
export const STALL_MS = 120_000;

export function progressOf(prev, bytes, total, now) {
  let rate = 0;
  let lastGrowthAt = now;
  if (prev) {
    lastGrowthAt = bytes > prev.bytes ? now : prev.lastGrowthAt;
    const dt = (now - prev.at) / 1000;
    if (dt > 0) {
      const inst = Math.max(0, bytes - prev.bytes) / dt;
      rate = ALPHA * inst + (1 - ALPHA) * (prev.rate ?? inst);
    } else {
      rate = prev.rate ?? 0;
    }
  }
  const percent =
    total == null || !(total > 0) ? null : Math.min(99, Math.max(0, Math.floor((bytes / total) * 100)));
  return { bytes, at: now, lastGrowthAt, percent, rate, stalled: now - lastGrowthAt > STALL_MS };
}

// Fill of a transfer bar. A failed job shows a full red bar (it may have failed before the first byte).
export function barFill(job) {
  if (job.state === "failed") return { width: "100%", tone: "error", pulse: false };
  if (job.state === "done") return { width: "100%", tone: "accent", pulse: false };
  if (job.state === "running" && job.percent == null) return { width: "40%", tone: "accent", pulse: true };
  const pct = Math.max(0, Math.min(100, job.percent ?? 0));
  return { width: `${pct}%`, tone: "accent", pulse: false };
}
