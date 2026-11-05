// Prints p50, p95 and max per phase of a perf.jsonl and PASS/FAIL against the limits.
//   node scripts/perf-report.mjs <perf.jsonl>     exit 1 on FAIL, 2 when the file cannot be read
import fs from "node:fs";
import { pathToFileURL } from "node:url";

// ms. timer.lag is what input lag feels like: how late a 100 ms timer fires on the thread that also draws.
export const LIMITS = {
  "timer.lag": { p95: 8, max: 50 },
  "preview.prepare": { max: 16 },
  render: { p95: 4, max: 16 },
  "mermaid.exec": { p95: 3000 },
};

const rank = (sorted, p) => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];

export function summary(samples) {
  const by = {};
  for (const s of samples) (by[s.phase] ??= []).push(s.ms);
  return Object.fromEntries(Object.entries(by).map(([phase, v]) => {
    const sorted = v.sort((a, b) => a - b);
    return [phase, { n: sorted.length, p50: rank(sorted, 50), p95: rank(sorted, 95), max: sorted[sorted.length - 1] }];
  }));
}

export function check(sum) {
  const out = [];
  for (const [phase, limits] of Object.entries(LIMITS))
    for (const [metric, limit] of Object.entries(limits))
      if (sum[phase] && sum[phase][metric] > limit) out.push({ phase, metric, value: sum[phase][metric], limit });
  return out;
}

function main(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { console.error(`cannot read ${file}`); return 2; }
  const samples = text.split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const sum = summary(samples), bad = check(sum);
  console.log("phase".padEnd(18) + "n".padStart(7) + "p50".padStart(8) + "p95".padStart(8) + "max".padStart(8) + "  limit");
  for (const [phase, s] of Object.entries(sum).sort()) {
    const lim = LIMITS[phase] ? Object.entries(LIMITS[phase]).map(([k, v]) => `${k} <= ${v}`).join(", ") : "-";
    console.log(phase.padEnd(18) + String(s.n).padStart(7) + String(s.p50).padStart(8) + String(s.p95).padStart(8) + String(s.max).padStart(8) + `  ${lim}`);
  }
  for (const b of bad) console.log(`FAIL ${b.phase} ${b.metric} ${b.value} > ${b.limit}`);
  console.log(bad.length ? "FAIL" : "PASS");
  return bad.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) { console.error("usage: node scripts/perf-report.mjs <perf.jsonl>"); process.exitCode = 2; }
  else process.exitCode = main(process.argv[2]);
}
