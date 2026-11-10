// The member check of a big archive inside herdr's own QuickJS (`herdr-app check`), which interrupts a job after about
// 0.5 s with an error JS cannot catch (follow-up to #68: 5,000 members were already interrupted, and the extract never
// answered). checkListing (lib/archives.js) runs the parse in the job that receives the probe output and then each
// memberCheck(...).step(CHECK_SLICE) in a job of its own; each scenario below is one such job, run as the top level of a
// throwaway mod (`herdr-app check` runs no timers, so the jobs are measured one by one, like the lossy slices of #39).
// Skipped where herdr-app is not installed (CI); `npm run bench` on the Mac runs it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { mkTmpSync } from "../tmp-helper.js";

const MOD = path.resolve(import.meta.dirname, "..", "..", "mods", "filer-pro");
const HAS_HERDR = spawnSync("herdr-app", ["--version"], { encoding: "utf8" }).status === 0;

// A probe output of N members (node_modules paths, one folder per ten), built from one block of 1,000 lines with
// native string ops only, so the setup takes little of the job's time.
const SETUP = `
import { parseProbe, memberCheck, unescapeName, CHECK_SLICE, ARCHIVE_MAX_MEMBERS } from "./lib/archives.js";
import { View, div } from "gpui-kit";
const listing = (n) => {
  const lines = [];
  let types = "";
  for (let i = 0; i < 1000; i++) { const d = i % 10 === 0; types += d ? "d" : "-"; lines.push("node_modules/pkg@/lib/sub" + (i % 13) + "/file-" + i + (d ? "/" : ".js")); }
  const block = lines.join("\\n") + "\\n";
  const parts = [];
  for (let k = 0; k < n / 1000; k++) parts.push(block.replaceAll("@", String(k)));
  return "tool=tar\\ntypes=" + types.repeat(n / 1000) + "\\nsize=1\\nencrypted=0\\n--\\n" + parts.join("");
};
const timed = (f) => { const t = Date.now(); const r = f(); return { r, ms: Date.now() - t }; };
`;
const REPORT = `
export default class Budget extends View { render() { return div(); } }
throw new Error("RESULT " + JSON.stringify(result));
`;

// The limit is wall-clock time and `npm test` runs other files in parallel: an interrupted run is tried again after a
// growing pause, as in test/quickjs-budget.test.js. A pass still needs one complete run inside a single job; the old
// check (one job for the whole list) was interrupted on every try from 5,000 members on.
const PAUSES_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function runInHerdr(body) {
  const dir = mkTmpSync("archive-budget-");
  fs.cpSync(path.join(MOD, "lib"), path.join(dir, "lib"), { recursive: true });
  fs.copyFileSync(path.join(MOD, "icons.js"), path.join(dir, "icons.js")); // lib/icons.js imports it
  fs.writeFileSync(path.join(dir, "mod.json"), '{ "place": "none" }\n');
  fs.writeFileSync(path.join(dir, "main.js"), SETUP + body + REPORT);
  let out = "";
  for (let attempt = 0; attempt <= PAUSES_MS.length; attempt++) {
    if (attempt > 0) pause(PAUSES_MS[attempt - 1]);
    const r = spawnSync("herdr-app", ["check", dir], { encoding: "utf8", timeout: 60000 });
    out = `${r.stdout}\n${r.stderr}`;
    if (!/interrupted/.test(out)) break;
  }
  assert.ok(!/interrupted/.test(out), `herdr interrupted the job:\n${out.slice(0, 2000)}`);
  const m = /RESULT (\{.*\})/.exec(out);
  assert.ok(m, `no result:\n${out.slice(0, 2000)}`);
  return JSON.parse(m[1]);
}

test("in herdr's QuickJS the job that receives the listing parses the most members allowed (200,000)", { skip: !HAS_HERDR && "herdr-app not installed" }, (t) => {
  const res = runInHerdr(`
const stdout = listing(ARCHIVE_MAX_MEMBERS);
const p = timed(() => parseProbe(stdout, { raw: true }));
const result = { n: p.r.names.length, types: p.r.types.length, ms: p.ms };
`);
  t.diagnostic(`parseProbe of ${res.n} members: ${res.ms} ms`);
  assert.equal(res.n, 200000);
  assert.equal(res.types, 200000);
});

test("in herdr's QuickJS each slice of the member check of 100,000 members finishes within one job", { skip: !HAS_HERDR && "herdr-app not installed" }, (t) => {
  // the first slice of the real 100,000-member check (pass one: decode, split, key, sets)
  const first = runInHerdr(`
const p = parseProbe(listing(100000), { raw: true });
const c = memberCheck(p.names, { types: p.types, decode: unescapeName });
const s = timed(() => c.step(CHECK_SLICE));
const result = { done: s.r !== null, ms: s.ms };
`);
  // every slice of a smaller check (pass one, the switch, pass two against the sets and the result), timed one by one;
  // the whole check of 5,000 members fits one job, so each of its slices can be measured
  const passes = runInHerdr(`
const p = parseProbe(listing(5000), { raw: true });
const c = memberCheck(p.names, { types: p.types, decode: unescapeName });
const ms = [];
let r = null;
while (!r) { const s = timed(() => c.step(CHECK_SLICE)); ms.push(s.ms); r = s.r; }
const result = { slices: ms.length, max: Math.max(...ms), tops: r.tops?.length ?? null, error: r.error ?? null };
`);
  // the costliest names per character: every byte an octal escape (a listing without a UTF-8 locale)
  const escaped = runInHerdr(`
const esc = "\\\\303\\\\251".repeat(40);
const names = [];
for (let i = 0; i < 5000; i++) names.push("d" + (i % 7) + "/" + esc + "/" + esc + i);
const c = memberCheck(names, { decode: unescapeName });
const s = timed(() => c.step(CHECK_SLICE));
const result = { done: s.r !== null, ms: s.ms, first: unescapeName(names[0]).slice(0, 4) };
`);
  t.diagnostic(`first slice of 100,000: ${first.ms} ms; 5,000 members: ${passes.slices} slices, max ${passes.max} ms; escaped names slice ${escaped.ms} ms`);
  assert.equal(first.done, false, "100,000 members take more than one slice");
  assert.ok(passes.slices >= 8, `both passes ran in slices: ${passes.slices}`);
  assert.equal(passes.tops, 1);
  assert.equal(passes.error, null);
  assert.equal(escaped.done, false, "a slice of long escaped names stops early");
  assert.equal(escaped.first, "d0/é");
});
