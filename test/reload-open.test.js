// Issue #31: the open file reloads when it changes, and the panel does no permanent refreshes (no timer, no SSH while
// idle). main.js is loaded with stubbed host modules (as in test/edit-main.test.js); the fake exec runs the real shell
// scripts (listing, probe, save) on a scratch folder, so "a machine" is the same folder reached with `on: "box"`.
// Every exec is logged: the idle tests count them per simulated minute, the latency tests hold them open.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { mkTmpSync } from "./tmp-helper.js";
import { PROBE_SCRIPT } from "../mods/filer-pro/lib/textedit.js";
import { LIST_SCRIPT } from "../mods/filer-pro/lib/tree.js";
import { numbers, validateField } from "../mods/filer-pro/lib/settings.js";

const FAKE_SSH = path.resolve(import.meta.dirname, "fake", "ssh");
const FAKE_SCP = path.resolve(import.meta.dirname, "fake", "scp");
const TRANSFER = path.resolve(import.meta.dirname, "..", "mods", "filer-pro", "bin", "transfer.sh");

globalThis.__make = (kind) => {
  const node = { kind, calls: [], kids: [] };
  const el = new Proxy(node, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop !== "string" || prop === "then") return undefined;
      return (...args) => {
        if (prop === "when") return args[0] ? args[1](el) : el;
        if (prop === "child") { if (args[0] != null) target.kids.push(args[0]); }
        else if (prop === "children") target.kids.push(...args[0].filter((x) => x != null));
        target.calls.push([prop, ...args]);
        return el;
      };
    },
  });
  return el;
};
const stub = (names) => names.map((n) => `export const ${n} = (...a) => globalThis.__impl.${n}(...a);`).join("\n");
const make = (names) => names.map((n) => `export const ${n} = (...a) => { const e = globalThis.__make("${n}"); e.args = a; return e; };`).join("\n");
const STUBS = {
  herdr: stub(["spaces", "panes", "focused", "exec", "hc", "readTextFile", "writeTextFile", "watchFolder", "theme", "settings", "window", "shared", "setShared", "notify", "props", "appHome", "home", "nextCommand", "openOverlay", "closeOverlay", "pickFolder", "run", "layout"]),
  "gpui-kit": `export class View {}; ${make(["div", "svg", "image"])}`,
  "gpui-base": `${make(["v_flex", "h_flex", "TextView"])} export const Input = { new: (s) => { const e = globalThis.__make("input"); e.state = s; return e; } }, Scrollbar = { vertical: () => globalThis.__make("scrollbar") };
export class Editor { static new(s) { const e = globalThis.__make("editor"); e.state = s; return e; } }
export class EditorState { static new(o) { return globalThis.__impl.editorNew(o); } }
export class InputState { static new(o) { return globalThis.__impl.inputNew(o); } }`,
  "fs/promises": `export const exists = async () => false, readFile = async () => "", stat = readFile,
  readdir = (...a) => globalThis.__impl.fsReaddir(...a),
  writeFile = (...a) => globalThis.__impl.fsWrite(...a), mkdir = async () => {}, unlink = async () => {};`,
};
const hooks = `export async function resolve(s, c, next) { return s in ${JSON.stringify(STUBS)} ? { url: "stub:" + s, shortCircuit: true } : next(s, c); }
export async function load(u, c, next) { return u.startsWith("stub:") ? { format: "module", shortCircuit: true, source: ${JSON.stringify(STUBS)}[u.slice(5)] } : next(u, c); }`;
register("data:text/javascript," + encodeURIComponent(hooks));
const FilerPro = (await import("../mods/filer-pro/main.js")).default;

const never = () => new Promise(() => {});
const settle = async (n = 60) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// The clock of main.js (Date.now) is the test's: the idle minute and the reload gate run on simulated time.
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;

// One scratch world. machine: the space's machine ("box": every exec and read carries on "box"). config: filer-pro.json.
// hold: execs wait until the test answers them (w.release), to simulate a slow machine.
function world({ machine = null, config = null } = {}) {
  const base = mkTmpSync("reload-open-");
  const ROOT = path.join(base, "files");
  fs.mkdirSync(ROOT);
  fs.mkdirSync(path.join(base, "app", "filer-pro", "requests"), { recursive: true });
  const env = { ...process.env, HOME: path.join(base, "home"), XDG_CACHE_HOME: path.join(base, "cache"), FILER_PRO_SCP: FAKE_SCP, FILER_PRO_SSH: FAKE_SSH };
  const store = {};
  const log = { execs: [], reads: [], readdirs: [], states: [], notes: [] };
  const state = { hold: false, held: [], inFlight: 0, maxInFlight: 0 };
  const watches = new Map(); // path -> resolve of the pending watchFolder call
  const timers = [];
  const cx = {
    notified: 0,
    notify() { this.notified++; }, sleep: never, stop_propagation() {}, phase: () => "ok",
    spawn: (fn) => { const p = Promise.resolve().then(() => fn(cx)); p.catch(() => {}); return p; },
    focus_handle: () => ({}),
    timer: { after: (ms, fn) => { if (ms === 0) setImmediate(() => fn(cx)); }, every: (ms, fn) => timers.push({ ms, fn }) },
  };
  const rcx = { ...cx, notify() { throw new Error("cx.notify() during render"); } };
  const run = (cmd, args) => {
    if (!["sh", "rm", "env", "git"].includes(cmd)) return { code: 1, stdout: "", stderr: "" };
    if (cmd === "git") return { code: 128, stdout: "", stderr: "not a git repository" };
    const real = args.map((a) => (a === "/app/mods/filer-pro/bin/transfer.sh" ? TRANSFER : a.startsWith("/app/") ? path.join(base, a) : a));
    const r = spawnSync(cmd, real, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  globalThis.fetch = async () => ({ status: 404 });
  globalThis.__impl = {
    props: () => ({}), appHome: () => "/app", home: () => "/Users/example", window: () => ({ platform: "macos" }),
    theme: () => new Proxy({}, { get: (_t, k) => String(k) }), settings: () => ({ dark: true, font_family: "mono" }),
    spaces: () => [{ active: true, id: "s1", folder: ROOT, machine }], panes: () => [], focused: () => ({}),
    shared: (k) => store[k], setShared: (k, v) => { store[k] = v; },
    readTextFile: async (p, opts = {}) => {
      if (p === "/app/filer-pro.json") return config;
      if (p.startsWith("/app/")) return null;
      log.reads.push({ p, on: opts.on ?? null });
      try { return fs.readFileSync(p, "utf8"); } catch { return null; }
    },
    writeTextFile: async () => {}, hc: async () => ({ code: 0, stdout: "{}", stderr: "" }),
    exec: async (cmd, args, opts = {}) => {
      const call = { cmd, args, on: opts.on ?? null };
      log.execs.push(call);
      state.inFlight++; state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        if (state.hold) await new Promise((resolve) => state.held.push(resolve));
        return run(cmd, args);
      } finally { state.inFlight--; }
    },
    openOverlay: () => "ov1", closeOverlay: () => {}, notify: (n) => log.notes.push(n),
    watchFolder: (p) => new Promise((resolve) => watches.set(p, resolve)),
    nextCommand: never, layout: () => ({}), pickFolder: async () => null, run: () => {},
    fsReaddir: async (p) => { log.readdirs.push(p); return fs.readdirSync(path.join(base, p)); },
    fsWrite: async (p, text) => { if (p.startsWith("/app/")) { fs.mkdirSync(path.dirname(path.join(base, p)), { recursive: true }); fs.writeFileSync(path.join(base, p), text); } },
    editorNew: (o) => {
      const s = {
        opts: o, v: o.value, handlers: {}, sets: [],
        value() { return this.v; },
        set_value(v) { this.v = v; this.sets.push(v); this.handlers.change?.({}, cx); },
        on(ev, fn) { this.handlers[ev] = fn; return true; },
        release() { return true; },
      };
      log.states.push(s);
      return s;
    },
    inputNew: (o) => ({ v: o?.value ?? "", value() { return this.v; }, set_value(v) { this.v = v; }, on() {}, set_selected_range() {}, focus() {}, release() {} }),
  };
  const w = {
    base, ROOT, log, store, state, cx, rcx, timers, watches,
    put(name, content) { const p = path.join(ROOT, name); fs.writeFileSync(p, content); fs.chmodSync(p, 0o640); return p; },
    read: (name) => fs.readFileSync(path.join(ROOT, name), "utf8"),
    // Fires the folder watch of `dir` with these changed paths.
    fire(dir, paths) { const r = watches.get(dir); watches.delete(dir); r?.(paths); },
    // Answers the held execs one at a time until none is left.
    async drain() { while (state.held.length) { state.held.shift()(); await settle(5); } },
    // Simulated time: every timer of the copy runs as often as it would in `ms`.
    async run(ms) {
      for (let t = 250; t <= ms; t += 250) {
        clock += 250;
        for (const tm of timers) if (t % tm.ms === 0) tm.fn(cx);
        await settle(4);
      }
    },
  };
  return w;
}

// The panel copy through the real init (timers, lease, request folder watch), settled.
async function boot(w) {
  const self = new FilerPro();
  self.init({}, w.cx);
  await settle(120);
  return self;
}

function* walk(e) {
  if (!e || typeof e !== "object") return;
  yield e;
  for (const k of e.kids ?? []) yield* walk(k);
}
const idOf = (el) => el.calls?.find((c) => c[0] === "id")?.[1];
const byId = (root, id) => [...walk(root)].find((e) => idOf(e) === id);
const handler = (el, name) => el.calls.find(([k]) => k === name).at(-1);
const click = (tree, id, cx) => handler(byId(tree, id), "on_click")({ modifiers: {} }, cx);
const texts = (root) => [...walk(root)].flatMap((e) => (e.kids ?? []).filter((k) => typeof k === "string"));
const LISTS = (w) => w.log.execs.filter((e) => e.cmd === "sh" && e.args[1] === LIST_SCRIPT);
const PROBES = (w) => w.log.execs.filter((e) => e.cmd === "sh" && e.args[1] === PROBE_SCRIPT);
const READS = (w, name) => w.log.reads.filter((r) => r.p === path.join(w.ROOT, name));
const type = (w, state, text) => { state.v = text; state.handlers.change({}, w.cx); };

async function opened(w, self, name = "a.txt") {
  self.show(name, w.cx);
  await settle();
}

// ---- idle: no exec while nothing happens

for (const [where, machine] of [["remote", "box"], ["local", null]]) {
  test(`idle: a ${where} folder makes 0 exec calls per minute, with a file open`, async () => {
    const w = world({ machine });
    w.put("a.txt", "one\n");
    const self = await boot(w);
    await opened(w, self);
    const before = w.log.execs.length;
    await w.run(60_000);
    const calls = w.log.execs.slice(before);
    console.log(`# idle ${where}: ${calls.length} exec calls in 60 s (${calls.filter((c) => c.on).length} with on)`);
    assert.equal(calls.length, 0, calls.map((c) => `${c.cmd} ${c.args.slice(0, 2).join(" ").slice(0, 40)}`).join(" | "));
  });
}

test("settings: refresh_seconds defaults to 0 (off), 0 is allowed, other values are 2–3,600", () => {
  assert.equal(numbers(null).refresh_seconds, 0);
  assert.equal(numbers({ refresh_seconds: 0 }).refresh_seconds, 0);
  assert.equal(numbers({ refresh_seconds: 1 }).refresh_seconds, 2);
  assert.equal(numbers({ refresh_seconds: 9999 }).refresh_seconds, 3600);
  assert.deepEqual(validateField("refresh_seconds", "0"), { value: 0 });
  assert.deepEqual(validateField("refresh_seconds", "30"), { value: 30 });
  assert.deepEqual(validateField("refresh_seconds", "1"), { error: "Enter 0 (off) or a number from 2 to 3,600." });
});

test("refresh_seconds > 0 still polls tree and file, and never overlaps on a slow machine", async () => {
  const w = world({ machine: "box", config: '{"refresh_seconds": 2}' });
  w.put("a.txt", "one\n");
  const self = await boot(w);
  await opened(w, self);
  w.state.hold = true;
  const lists = LISTS(w).length;
  await w.run(20_000); // ten intervals while the first listing still waits for the machine
  assert.equal(w.state.maxInFlight, 1, "one exec in flight at most");
  assert.equal(LISTS(w).length, lists + 1, "the waiting flight is not stacked");
  w.state.hold = false;
  await w.drain();
  await w.run(2_000);
  assert.ok(LISTS(w).length >= lists + 2, "polling goes on once the machine answers");
  w.put("a.txt", "two\n");
  await w.run(4_000);
  assert.equal(self.code.value(), "two\n", "the open file follows");
});

// ---- the open file follows changes

test("local: the open file reloads on a watch event that names it, in place (no Loading file…)", async () => {
  const w = world();
  w.put("a.txt", "one\n");
  const self = await boot(w);
  await opened(w, self);
  const code = self.code;
  w.put("a.txt", "two\n");
  w.fire(w.ROOT, [path.join(w.ROOT, "a.txt")]);
  await settle();
  assert.equal(self.code, code, "the same editor state, updated in place");
  assert.equal(code.value(), "two\n");
  assert.ok(!texts(self.render(w.rcx)).includes("Loading file…"));
  assert.equal(self.file, "a.txt");
});

test("local: a watch event for another file reloads the tree; the open file is only compared (no probe, no set)", async () => {
  const w = world();
  w.put("a.txt", "one\n");
  const self = await boot(w);
  await opened(w, self);
  const probes = PROBES(w).length, lists = LISTS(w).length, sets = self.code.sets.length;
  w.put("b.txt", "x\n");
  w.fire(w.ROOT, [path.join(w.ROOT, "b.txt")]);
  await settle();
  assert.ok(LISTS(w).length > lists, "the tree reloaded");
  assert.equal(PROBES(w).length, probes, "no probe");
  assert.equal(self.code.sets.length, sets, "no set_value");
});

test("local: an image is probed again only when the watch batch names it", async () => {
  const w = world();
  w.put("a.txt", "one\n");
  const self = await boot(w);
  await opened(w, self);
  let loads = 0;
  const doc = { kind: "image", path: "cache/k1.png", width: 1, height: 1 };
  self.images = { load: async () => { loads++; return { kind: "image", path: "cache/k2.png", width: 2, height: 2 }; } };
  Object.assign(self, { doc, previewer: { view: () => null }, mode: "preview" });
  self.code?.release(); self.code = null;
  w.fire(w.ROOT, [path.join(w.ROOT, "b.txt")]);
  await settle();
  assert.equal(loads, 0, "another file: no probe exec for the image");
  w.fire(w.ROOT, [path.join(w.ROOT, "a.txt")]);
  await settle();
  assert.equal(loads, 1);
  assert.equal(self.doc.path, "cache/k2.png", "a new cache key: swapped in place");
});

test("remote: the open file reloads after an own action (filer-pro.changed), in place", async () => {
  const w = world({ machine: "box" });
  w.put("a.txt", "one\n");
  const self = await boot(w);
  await opened(w, self);
  const code = self.code;
  w.put("a.txt", "two\n");
  w.store["filer-pro.changed"] = { at: 1 };
  await w.run(250);
  await settle();
  assert.equal(self.code, code);
  assert.equal(code.value(), "two\n");
  assert.ok(READS(w, "a.txt").every((r) => r.on === "box"));
});

test("remote: an unchanged open file is not probed again after an own action", async () => {
  const w = world({ machine: "box" });
  w.put("a.txt", "one\n");
  const self = await boot(w);
  await opened(w, self);
  const probes = PROBES(w).length, sets = self.code.sets.length;
  w.store["filer-pro.changed"] = { at: 1 };
  await w.run(250);
  await settle();
  assert.equal(PROBES(w).length, probes, "no probe for an unchanged file");
  assert.equal(self.code.sets.length, sets, "no set_value");
});

test("the refresh button reloads the tree and the open file, also on a machine", async () => {
  for (const machine of ["box", null]) {
    const w = world({ machine });
    w.put("a.txt", "one\n");
    const self = await boot(w);
    const lists = LISTS(w).length;
    const tree = self.render(w.rcx);
    const button = byId(tree, "files-refresh");
    assert.ok(button, "a refresh button in the header");
    assert.equal(button.calls.find(([k]) => k === "tooltip")?.[1], "Refresh");
    assert.equal(button.kids.find((k) => k.kind === "svg")?.args[0], "mods/filer-pro/refresh-cw.svg");
    click(tree, "files-refresh", w.cx);
    await settle();
    assert.ok(LISTS(w).length > lists, `${machine}: the tree reloaded`);
    await opened(w, self);
    w.put("a.txt", "two\n");
    click(self.render(w.rcx), "files-refresh", w.cx);
    await settle();
    assert.equal(self.code.value(), "two\n", `${machine}: the file reloaded`);
  }
});

// ---- edit mode

async function editing(w, self) {
  await opened(w, self);
  click(self.render(w.rcx), "files-edit", w.cx);
  await settle();
  assert.ok(self.edit, "edit mode is on");
}

test("edit: the panel's own save does not reload itself in a loop", async () => {
  const w = world();
  w.put("a.txt", "one\n");
  const self = await boot(w);
  await editing(w, self);
  type(w, self.edit.state, "two\n");
  click(self.render(w.rcx), "files-save", w.cx);
  await settle(200);
  assert.equal(w.read("a.txt"), "two\n");
  const at = w.store["filer-pro.changed"]?.at;
  assert.ok(at, "the save signals the change");
  const reads = READS(w, "a.txt").length, probes = PROBES(w).length;
  w.fire(w.ROOT, [path.join(w.ROOT, "a.txt")]); // the folder watch sees the own write too
  await w.run(5_000);
  await settle();
  assert.equal(w.store["filer-pro.changed"].at, at, "no new change signal");
  assert.equal(PROBES(w).length, probes, "no new probe");
  assert.ok(READS(w, "a.txt").length <= reads + 1, "read at most once to compare");
  assert.ok(self.edit && !self.edit.dirty, "still editing, clean");
  assert.equal(self.edit.state.value(), "two\n");
});

test("edit: a dirty buffer is never overwritten, whatever the trigger", async () => {
  const w = world();
  w.put("a.txt", "one\n");
  const self = await boot(w);
  await editing(w, self);
  type(w, self.edit.state, "mine\n");
  w.put("a.txt", "theirs\n");
  w.fire(w.ROOT, [path.join(w.ROOT, "a.txt")]);
  w.store["filer-pro.changed"] = { at: 7 };
  await w.run(1_000);
  click(self.render(w.rcx), "files-refresh", w.cx);
  await settle();
  assert.ok(self.edit?.dirty, "still editing with the unsaved text");
  assert.equal(self.edit.state.value(), "mine\n");
  assert.equal(w.read("a.txt"), "theirs\n", "the file is not touched");
});

test("edit: a clean buffer reloads with the file and stays in edit mode", async () => {
  const w = world();
  w.put("a.txt", "one\n");
  const self = await boot(w);
  await editing(w, self);
  const state = self.edit.state;
  w.put("a.txt", "two\n");
  w.fire(w.ROOT, [path.join(w.ROOT, "a.txt")]);
  await settle(200);
  assert.equal(self.edit?.state, state, "the same edit buffer");
  assert.equal(state.value(), "two\n");
  assert.equal(self.edit.info.text, "two\n", "the save baseline is the new file");
  assert.equal(self.edit.dirty, false);
  // Saving now writes over the new file without a conflict.
  type(w, state, "three\n");
  click(self.render(w.rcx), "files-save", w.cx);
  await settle(200);
  assert.equal(w.read("a.txt"), "three\n");
});

// ---- latency

test("triggers coalesce while the machine is slow: one exec in flight, one more flight at most", async () => {
  const w = world({ machine: "box" });
  w.put("a.txt", "one\n");
  const self = await boot(w);
  await opened(w, self);
  w.state.hold = true;
  w.state.maxInFlight = 0;
  const lists = LISTS(w).length;
  for (let i = 0; i < 10; i++) {
    w.store["filer-pro.changed"] = { at: 100 + i };
    await w.run(1_000);
    click(self.render(w.rcx), "files-refresh", w.cx);
    await settle(5);
  }
  assert.equal(LISTS(w).length, lists + 1, "the first flight still waits; nothing stacked");
  assert.equal(w.state.maxInFlight, 1);
  const tree = self.render(w.rcx); // the panel still draws while it waits
  assert.ok(byId(tree, "files-refresh"));
  w.state.hold = false;
  await w.drain();
  await settle(200);
  await w.drain();
  assert.equal(w.state.maxInFlight, 1);
  assert.ok(LISTS(w).length <= lists + 2, `at most one catch-up flight (${LISTS(w).length - lists})`);
});
