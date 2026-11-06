// The endless loops of mods/filer-pro/main.js (request folder watch, panel commands, button commands) after a reload.
// Herdr ends a replaced build's async loop only at its next `cx` use (gpui-kit.d.ts, AsyncContext: "It throws once its
// build of the script is reloaded or closed, so a replaced build's loop ends at its next `cx` use"). A loop that only
// awaits nextCommand() or watchFolder() would keep running with the old code: these tests make the fake cx refuse
// like a reloaded build's and check that each loop stops at once, without acting on what it was woken with.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

const stub = (names) => names.map((n) => `export const ${n} = (...a) => globalThis.__impl.${n}(...a);`).join("\n");
const STUBS = {
  herdr: stub(["spaces", "panes", "focused", "exec", "hc", "readTextFile", "writeTextFile", "watchFolder", "theme", "settings", "window", "shared", "setShared", "notify", "props", "appHome", "home", "nextCommand", "openOverlay", "closeOverlay", "pickFolder", "run", "layout"]),
  "gpui-kit": "export class View {}; export const div = () => ({}), svg = div, image = div;",
  "gpui-base": "export const v_flex = () => ({}), h_flex = v_flex; export class Editor {}; export class EditorState {}; export class InputState {}; export const Input = v_flex, TextView = v_flex, Scrollbar = { vertical: v_flex };",
  "fs/promises": "export const exists = async () => false, readFile = async () => \"\", writeFile = readFile, mkdir = readFile, unlink = readFile, stat = readFile; export const readdir = (...a) => globalThis.__impl.readdir(...a);",
};
const hooks = `export async function resolve(s, c, next) { return s in ${JSON.stringify(STUBS)} ? { url: "stub:" + s, shortCircuit: true } : next(s, c); }
export async function load(u, c, next) { return u.startsWith("stub:") ? { format: "module", shortCircuit: true, source: ${JSON.stringify(STUBS)}[u.slice(5)] } : next(u, c); }`;
register("data:text/javascript," + encodeURIComponent(hooks));
const FilerPro = (await import("../mods/filer-pro/main.js")).default;

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

// A host call that answers when the test says so; counts how often it was called.
function waiter() {
  const pending = [];
  const w = { calls: 0, fn: () => { w.calls++; return new Promise((resolve) => pending.push(resolve)); }, answer: (v) => pending.shift()(v) };
  return w;
}

function host({ props = {}, store = {} } = {}) {
  const commands = waiter(), watches = waiter(), execs = [];
  globalThis.__impl = {
    appHome: () => "/app", home: () => "/home/u", props: () => props, layout: () => ({}),
    readTextFile: async () => { throw new Error("ENOENT"); }, writeTextFile: async () => {},
    shared: (k) => store[k], setShared: (k, v) => { store[k] = v; }, notify: () => {},
    exec: async (cmd, args) => { execs.push([cmd, ...args].join(" ")); return { code: 0, stdout: "", stderr: "" }; },
    // The request scan lists its folder with fs.readdir (no process, issue #31): logged like an exec.
    readdir: async (dir) => { execs.push(`readdir ${dir}`); return []; },
    nextCommand: commands.fn, watchFolder: watches.fn,
  };
  return { commands, watches, execs };
}

// cx.phase() throws once `dead` is set, as every member of a reloaded build's AsyncContext does.
function fakeCx() {
  const state = { dead: false };
  const cx = {
    phase() { if (state.dead) throw new Error("stale context: the script was reloaded"); return "task"; },
    notify() {}, sleep: () => new Promise(() => {}), timer: { every() {}, after() {} },
    spawn: (fn) => { Promise.resolve().then(() => fn(cx)).catch(() => {}); },
  };
  return { cx, state };
}

const panel = () => Object.assign(Object.create(FilerPro.prototype), { jobs: { recover: async () => {}, tick: async () => {}, clearFinished() {} }, cfg: null });
const scans = (execs) => execs.filter((e) => e.startsWith("readdir ")).length;

test("reload: the panel's command loop ends at the next command and does not act on it", async () => {
  const h = host();
  const { cx, state } = fakeCx();
  panel().drive(cx);
  await settle();
  assert.equal(h.commands.calls, 1);
  const before = scans(h.execs);
  h.commands.answer("scan");
  await settle();
  assert.equal(scans(h.execs), before + 1, "control: a live build scans on 'scan'");
  assert.equal(h.commands.calls, 2);
  state.dead = true;
  h.commands.answer("scan");
  await settle();
  assert.equal(scans(h.execs), before + 1, "the replaced build does not scan");
  assert.equal(h.commands.calls, 2, "and does not wait for another command");
});

test("reload: the request folder watch ends at the next change and does not scan", async () => {
  const h = host();
  const { cx, state } = fakeCx();
  panel().drive(cx);
  await settle();
  assert.equal(h.watches.calls, 1);
  const before = scans(h.execs);
  h.watches.answer(["/app/filer-pro/requests/a.json"]);
  await settle();
  assert.equal(scans(h.execs), before + 1, "control: a live build scans on a change");
  assert.equal(h.watches.calls, 2);
  state.dead = true;
  h.watches.answer(["/app/filer-pro/requests/b.json"]);
  await settle();
  assert.equal(scans(h.execs), before + 1, "the replaced build does not scan");
  assert.equal(h.watches.calls, 2, "and does not watch again");
});

test("reload: the button's command loop ends at the next command and does not reveal", async () => {
  const h = host({ props: { button: true }, store: { "filer-pro.last_download": "/home/u/Downloads/a.txt" } });
  const { cx, state } = fakeCx();
  const self = Object.create(FilerPro.prototype);
  self.init({}, cx);
  await settle();
  assert.equal(h.commands.calls, 1);
  h.commands.answer("reveal");
  await settle();
  const reveals = h.execs.length;
  assert.ok(reveals >= 1, "control: a live button reveals the last download");
  assert.equal(h.commands.calls, 2);
  state.dead = true;
  h.commands.answer("reveal");
  await settle();
  assert.equal(h.execs.length, reveals, "the replaced build does not reveal");
  assert.equal(h.commands.calls, 2, "and does not wait for another command");
});
