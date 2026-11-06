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
import { PROBE_SCRIPT, READ_SCRIPT, VERIFY_SCRIPT } from "../mods/filer-pro/lib/textedit.js";
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
// git: the git calls run the real git (otherwise: not a repository).
// link: the space folder is a symbolic link to the real folder (herdr reports watch paths under the real one).
function world({ machine = null, config = null, link = false, git = false } = {}) {
  const base = mkTmpSync("reload-open-");
  const ROOT = path.join(base, "files");
  const REAL = link ? path.join(base, "real-files") : ROOT;
  fs.mkdirSync(REAL);
  if (link) fs.symlinkSync(REAL, ROOT);
  fs.mkdirSync(path.join(base, "app", "filer-pro", "requests"), { recursive: true });
  const env = { ...process.env, HOME: path.join(base, "home"), XDG_CACHE_HOME: path.join(base, "cache"), FILER_PRO_SCP: FAKE_SCP, FILER_PRO_SSH: FAKE_SSH };
  const store = {};
  const log = { execs: [], reads: [], readdirs: [], states: [], notes: [], watches: [] };
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
  const run = (cmd, args, cwd) => {
    if (!["sh", "rm", "env", "git"].includes(cmd)) return { code: 1, stdout: "", stderr: "" };
    if (cmd === "git" && git) { const r = spawnSync(cmd, args, { encoding: "utf8", cwd, env }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; }
    if (cmd === "git") return { code: 128, stdout: "", stderr: "not a git repository" };
    const real = args.map((a) => (a === "/app/mods/filer-pro/bin/transfer.sh" ? TRANSFER : a.startsWith("/app/") ? path.join(base, a) : a));
    const r = spawnSync(cmd, real, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  globalThis.fetch = async () => ({ status: 404 });
  globalThis.__impl = {
    props: () => ({}), appHome: () => "/app", home: () => "/Users/example", window: () => ({ platform: "macos" }),
    theme: () => new Proxy({}, { get: (_t, k) => String(k) }), settings: () => ({ dark: true, font_family: "mono" }),
    spaces: () => [{ active: true, id: "s1", folder: state.folder ?? ROOT, machine }], panes: () => [], focused: () => ({}),
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
        return run(cmd, args, opts.cwd);
      } finally { state.inFlight--; }
    },
    openOverlay: () => "ov1", closeOverlay: () => {}, notify: (n) => log.notes.push(n),
    watchFolder: (p) => { log.watches.push(p); return new Promise((resolve) => watches.set(p, resolve)); },
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
    base, ROOT, REAL, log, store, state, cx, rcx, timers, watches,
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
// Every read of a file: herdr's readTextFile (locally) or the bounded READ_SCRIPT exec (on a machine, issue #39).
const READS = (w, name) => [...w.log.reads.filter((r) => r.p === path.join(w.ROOT, name)),
  ...w.log.execs.filter((e) => e.cmd === "sh" && e.args[1] === READ_SCRIPT && e.args[3] === path.join(w.ROOT, name)).map((e) => ({ p: e.args[3], on: e.on }))];
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
  await w.run(1000); // past the gap of 1 s between watch refreshes (#42)
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
  assert.ok(READS(w, "a.txt").length > 0 && READS(w, "a.txt").every((r) => r.on === "box"));
  assert.equal(w.log.reads.filter((r) => r.p === path.join(w.ROOT, "a.txt")).length, 0, "no readTextFile on a machine");
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

// ---- the Markdown or HTML preview follows the text on screen (regression of #29 with #31)

const previewText = (self) => self.doc?.parts?.map((p) => p.text ?? "").join("");
// The preview is prepared in small steps between cx.sleep calls: here they resolve, so it ends.
const quickSleep = (w) => { w.cx.sleep = () => new Promise((r) => setImmediate(r)); };

test("preview: after an own save the preview shows the saved text, also after leaving edit mode and Refresh", async () => {
  const w = world();
  quickSleep(w);
  w.put("a.md", "# one\n");
  const self = await boot(w);
  await opened(w, self, "a.md");
  await settle(100);
  assert.match(previewText(self), /# one/, "the preview of the file");
  self.mode = "source";
  click(self.render(w.rcx), "files-edit", w.cx);
  await settle();
  assert.ok(self.edit, "edit mode is on");
  type(w, self.edit.state, "# two\n");
  click(self.render(w.rcx), "files-save", w.cx);
  await settle(200);
  assert.equal(w.read("a.md"), "# two\n");
  click(self.render(w.rcx), "files-edit", w.cx); // leave edit mode (clean)
  await settle(100);
  assert.equal(self.edit, null);
  assert.match(previewText(self), /# two/, "the preview follows the save");
  click(self.render(w.rcx), "files-refresh", w.cx); // drawn in the source view: the stubs have no Markdown view
  await settle(200);
  assert.match(previewText(self), /# two/, "and stays right after Refresh");
});

test("preview: a clean edit buffer that reloads a changed file updates the preview too", async () => {
  const w = world();
  quickSleep(w);
  w.put("a.md", "# one\n");
  const self = await boot(w);
  await opened(w, self, "a.md");
  await settle(100);
  self.mode = "source";
  click(self.render(w.rcx), "files-edit", w.cx);
  await settle();
  assert.ok(self.edit);
  w.put("a.md", "# three\n");
  w.fire(w.ROOT, [path.join(w.ROOT, "a.md")]);
  await settle(200);
  assert.equal(self.edit.state.value(), "# three\n");
  assert.match(previewText(self), /# three/, "the preview of the reloaded text");
});

test("preview: Refresh re-renders a preview that does not match the text on screen", async () => {
  const w = world();
  quickSleep(w);
  w.put("a.md", "# one\n");
  const self = await boot(w);
  await opened(w, self, "a.md");
  await settle(100);
  self.doc = { ...self.doc, parts: [{ kind: "markdown", text: "# stale\n" }] }; // a preview from older text
  self.mode = "source"; // drawn in the source view: the stubs have no Markdown view
  click(self.render(w.rcx), "files-refresh", w.cx);
  await settle(200);
  assert.match(previewText(self), /# one/);
});

// ---- a file in an error state is not read again on every change signal (regression of #31 with #32/#33)

for (const [where, machine] of [["remote", "box"], ["local", null]]) {
  test(`error state (${where}): filer-pro.changed does not read the file again; Refresh and a click do`, async () => {
    const w = world({ machine });
    w.put("bin.txt", "a\0b\n"); // a NUL: shown as an error, no editor
    const self = await boot(w);
    await opened(w, self, "bin.txt");
    assert.ok(self.fileError, "the file is in an error state");
    const reads = READS(w, "bin.txt").length, probes = PROBES(w).length;
    const nonList = () => w.log.execs.filter((e) => !(e.cmd === "sh" && e.args[1] === LIST_SCRIPT) && e.cmd !== "git").length;
    const execs = nonList();
    for (let i = 0; i < 5; i++) {
      w.store["filer-pro.changed"] = { at: 1000 + i };
      await w.run(1_000);
      await settle();
    }
    console.log(`# error state ${where}: ${READS(w, "bin.txt").length - reads} reads, ${nonList() - execs} execs besides the listing after 5 signals`);
    assert.equal(READS(w, "bin.txt").length, reads, "no readTextFile per signal");
    assert.equal(PROBES(w).length, probes, "no probe per signal");
    assert.equal(nonList(), execs, "no exec besides the tree reload");
    click(self.render(w.rcx), "files-refresh", w.cx);
    await settle(200);
    assert.equal(READS(w, "bin.txt").length, reads + 1, "Refresh reads it again");
    await opened(w, self, "bin.txt");
    assert.equal(READS(w, "bin.txt").length, reads + 2, "a click reads it again");
  });
}

test("error state (local): a watch event that names the file reads it again", async () => {
  const w = world();
  w.put("bin.txt", "a\0b\n");
  const self = await boot(w);
  await opened(w, self, "bin.txt");
  assert.ok(self.fileError);
  const reads = READS(w, "bin.txt").length;
  w.fire(w.ROOT, [path.join(w.ROOT, "other.txt")]);
  await settle(100);
  assert.equal(READS(w, "bin.txt").length, reads, "another file: not read");
  await w.run(1000); // past the gap of 1 s between watch refreshes (#42)
  w.put("bin.txt", "fine now\n");
  w.fire(w.ROOT, [path.join(w.ROOT, "bin.txt")]);
  await settle(100);
  assert.equal(READS(w, "bin.txt").length, reads + 1);
  assert.equal(self.fileError, null);
  assert.equal(self.code.value(), "fine now\n");
});

test("loading a large file through a job: signals and Refresh read nothing and leave one wait loop", async () => {
  const w = world({ machine: "box" });
  w.put("a.txt", "one\n");
  const self = await boot(w);
  await opened(w, self);
  quickSleep(w);
  let outcomes = 0;
  const previewer = { loadOutcome: () => { outcomes++; return { show: false, error: "Load failed" }; } };
  w.store["filer-pro.jobs"] = { j1: { id: "j1", state: "running" } };
  self.waitLoad(previewer, "j1", "a.txt", w.cx);
  await settle();
  assert.equal(self.fileError, "Loading… · progress in the transfers bar");
  const reads = READS(w, "a.txt").length, execs = w.log.execs.length;
  w.store["filer-pro.changed"] = { at: 4242 };
  await w.run(1_000);
  click(self.render(w.rcx), "files-refresh", w.cx);
  await settle(200);
  self.waitLoad(previewer, "j1", "a.txt", w.cx); // joined again, as showHint does when it finds the running job
  await settle();
  assert.equal(READS(w, "a.txt").length, reads, "no read of the file meanwhile");
  assert.equal(self.fileError, "Loading… · progress in the transfers bar", "still waiting");
  assert.ok(w.log.execs.slice(execs).every((e) => e.cmd === "git" || e.args[1] === LIST_SCRIPT), "only the tree reloads");
  w.store["filer-pro.jobs"] = { j1: { id: "j1", state: "failed" } };
  await settle(100);
  assert.equal(outcomes, 1, "one wait loop ends, not two");
  assert.equal(self.fileError, "Load failed");
});

// ---- issue #42: only watch batches that can change what the panel shows refresh it

const REFRESHES = (w) => w.log.execs.filter((e) => e.cmd === "git" && e.args[0] === "rev-parse").length;
const shownNames = (self, folder = "") => (self.entries.get(folder) ?? []).map((e) => e.name);
// What a home folder as the root reports all the time: caches, shell history, editor state, git objects.
const NOISE = ["Library/Caches/com.example.app/Cache.db-wal", ".zsh_history", "Library/Application Support/Code/User/state.vscdb",
  "src/node_modules/pkg/index.js", "Downloads/sub/part.crdownload", ".git/objects/ab/cdef01", ".git/logs/HEAD", ".DS_Store"];

async function home(w) {
  w.put("a.txt", "one\n");
  fs.mkdirSync(path.join(w.ROOT, "src"));
  w.put("src/b.txt", "b\n");
  const self = await boot(w);
  self.toggle("src", w.cx); // one expanded folder
  await settle();
  await opened(w, self);
  return self;
}

test("watch filter (~ case): 2 batches/s of irrelevant paths for a minute cause no refresh, no exec and no read", async () => {
  const w = world({ config: '{"hide_dotfiles": true}' });
  const self = await home(w);
  const refreshes = REFRESHES(w), execs = w.log.execs.length, reads = READS(w, "a.txt").length;
  for (let i = 0; i < 120; i++) {
    w.fire(w.ROOT, NOISE.map((p) => path.join(w.ROOT, p)));
    await w.run(500);
  }
  const r = REFRESHES(w) - refreshes, e = w.log.execs.length - execs, f = READS(w, "a.txt").length - reads;
  console.log(`# watch noise: ${r} refreshes/min, ${e} exec spawns/min, ${f} reads of the open file/min (120 batches)`);
  // A relevant change still shows: a new file in the root, after the noise.
  w.put("new.txt", "n\n");
  w.fire(w.ROOT, [path.join(w.ROOT, "Library/Caches/x"), path.join(w.ROOT, "new.txt")]);
  let ms = 0;
  await settle();
  while (!shownNames(self).includes("new.txt") && ms < 3000) { await w.run(250); ms += 250; }
  console.log(`# watch noise: a new file in the root shows after ${ms} ms (simulated)`);
  assert.equal(r, 0, "no refresh for irrelevant paths");
  assert.equal(e, 0, "no exec for irrelevant paths");
  assert.equal(f, 0, "the open file is not read for irrelevant paths");
  assert.ok(shownNames(self).includes("new.txt") && ms <= 1000, `shown within 1 s (${ms} ms)`);
});

test("watch filter: a change in an expanded folder and the open file still refresh; collapsed ones do not", async () => {
  const w = world();
  const self = await home(w);
  fs.mkdirSync(path.join(w.ROOT, "closed"));
  await w.run(1000);
  let n = REFRESHES(w);
  w.put("closed/c.txt", "c\n");
  w.fire(w.ROOT, [path.join(w.ROOT, "closed/c.txt")]);
  await w.run(1000);
  assert.equal(REFRESHES(w), n, "a collapsed folder: nothing");
  w.put("src/new.txt", "x\n");
  w.fire(w.ROOT, [path.join(w.ROOT, "src/new.txt")]);
  await settle();
  assert.equal(REFRESHES(w), n + 1, "an expanded folder: refreshed");
  assert.ok(shownNames(self, "src").includes("new.txt"));
  await w.run(1000);
  w.put("a.txt", "two\n");
  w.fire(w.ROOT, [path.join(w.ROOT, "a.txt")]);
  await settle();
  assert.equal(self.code.value(), "two\n", "the open file follows (#31)");
});

test("watch filter: a burst of relevant batches gives one refresh at once and one trailing refresh, none lost", async () => {
  const w = world();
  const self = await home(w);
  await w.run(1000);
  const n = REFRESHES(w);
  for (let i = 0; i < 10; i++) {
    w.put(`f${i}.txt`, "x\n");
    w.fire(w.ROOT, [path.join(w.ROOT, `f${i}.txt`)]);
    await settle(10);
  }
  assert.equal(REFRESHES(w), n + 1, "one refresh at once");
  await w.run(1250);
  assert.equal(REFRESHES(w), n + 2, "one trailing refresh after the gap of 1 s");
  await w.run(3000);
  assert.equal(REFRESHES(w), n + 2, "no more");
  assert.ok(shownNames(self).includes("f9.txt"), "the last change shows");
});

test("watch filter: with a symlinked root, paths under the real folder are compared (no refresh-all)", async () => {
  const w = world({ link: true, config: '{"hide_dotfiles": true}' });
  const self = await home(w);
  await w.run(1000);
  const n = REFRESHES(w), reads = READS(w, "a.txt").length;
  w.fire(w.ROOT, NOISE.map((p) => path.join(w.REAL, p)));
  await w.run(1000);
  assert.equal(REFRESHES(w), n, "noise under the real path: nothing");
  assert.equal(READS(w, "a.txt").length, reads, "and no read of the open file");
  w.put("new.txt", "n\n");
  w.fire(w.ROOT, [path.join(w.REAL, "new.txt")]);
  await settle();
  assert.equal(REFRESHES(w), n + 1);
  assert.ok(shownNames(self).includes("new.txt"));
  await w.run(1000);
  w.put("a.txt", "two\n");
  w.fire(w.ROOT, [path.join(w.REAL, "a.txt")]);
  await settle();
  assert.equal(self.code.value(), "two\n", "the open file named under the real path reloads");
});

test("watch filter: .git index changes refresh the marks, .git objects do not; hidden entries only while hidden", async () => {
  const w = world({ config: '{"hide_dotfiles": true}' });
  await home(w);
  await w.run(1000);
  const n = REFRESHES(w);
  w.fire(w.ROOT, [path.join(w.ROOT, ".git/objects/12/3456"), path.join(w.ROOT, ".zsh_history")]);
  await w.run(1000);
  assert.equal(REFRESHES(w), n);
  w.fire(w.ROOT, [path.join(w.ROOT, ".git/index")]);
  await settle();
  assert.equal(REFRESHES(w), n + 1);
  const v = world();
  await home(v);
  await v.run(1000);
  const m = REFRESHES(v);
  v.fire(v.ROOT, [path.join(v.ROOT, ".zsh_history")]);
  await settle();
  assert.equal(REFRESHES(v), m + 1, "dot files shown: a change to one refreshes");
});

// ---- issue #41: a chmod in the Permissions dialog re-probes the open file of the copy it covers, and only that one

async function chmodded(w, perms, mode) {
  if (mode !== undefined) fs.chmodSync(path.join(w.REAL, "a.txt"), mode);
  w.store["filer-pro.changed"] = { at: 9000 + Math.random(), perms };
  await w.run(1000);
  await settle(100);
}

test("chmod: a chmod of the open file re-probes it; the edit check follows the new mode", async () => {
  const w = world();
  w.put("a.txt", "one\n");
  const self = await boot(w);
  await opened(w, self);
  await settle(100);
  assert.equal(self.editCheck?.state, "ok");
  const probes = PROBES(w).length;
  await chmodded(w, { machine: null, path: path.join(w.ROOT, "a.txt"), recursive: false }, 0o440);
  assert.equal(PROBES(w).length, probes + 1, "one new probe");
  assert.equal(self.editCheck?.state, "refused", "read only now");
});

test("chmod: an unrelated chmod does not re-probe the open file", async () => {
  const w = world();
  w.put("a.txt", "one\n");
  w.put("b.txt", "b\n");
  const self = await boot(w);
  await opened(w, self);
  await settle(100);
  const probes = PROBES(w).length;
  await chmodded(w, { machine: null, path: path.join(w.ROOT, "b.txt"), recursive: false });
  assert.equal(PROBES(w).length, probes, "no probe");
  assert.equal(self.editCheck?.state, "ok");
});

test("chmod: a recursive chmod of a folder above the open file re-probes it", async () => {
  const w = world();
  fs.mkdirSync(path.join(w.ROOT, "src"));
  w.put("src/a.txt", "one\n");
  const self = await boot(w);
  await opened(w, self, "src/a.txt");
  await settle(100);
  assert.equal(self.editCheck?.state, "ok");
  const probes = PROBES(w).length;
  fs.chmodSync(path.join(w.ROOT, "src/a.txt"), 0o440);
  await chmodded(w, { machine: null, path: w.ROOT, recursive: true });
  assert.equal(PROBES(w).length, probes + 1);
  assert.equal(self.editCheck?.state, "refused");
});

test("chmod: the same path on another machine does not re-probe the open file", async () => {
  for (const [machine, other] of [["box", null], [null, "box"]]) {
    const w = world({ machine });
    w.put("a.txt", "one\n");
    const self = await boot(w);
    await opened(w, self);
    await settle(100);
    const probes = PROBES(w).length;
    await chmodded(w, { machine: other, path: path.join(w.ROOT, "a.txt"), recursive: false });
    assert.equal(PROBES(w).length, probes, `shown on ${machine}, chmod on ${other}: no probe`);
  }
});

test("chmod: a clean edit buffer whose file became read only leaves edit mode", async () => {
  const w = world();
  w.put("a.txt", "one\n");
  const self = await boot(w);
  await editing(w, self);
  await chmodded(w, { machine: null, path: path.join(w.ROOT, "a.txt"), recursive: false }, 0o440);
  assert.equal(self.edit, null, "edit mode ended");
  assert.equal(self.editCheck?.state, "refused");
});

test("chmod: a Markdown file shown as source is probed again too (its preview is prepared in the background)", async () => {
  const w = world();
  quickSleep(w);
  w.put("a.md", "# one\n");
  const self = await boot(w);
  await opened(w, self, "a.md");
  await settle(100);
  self.mode = "source";
  self.checkEdit("a.md", self.fileCfg, w.cx);
  await settle(100);
  assert.equal(self.editCheck?.state, "ok");
  assert.ok(self.previewer && self.doc, "a previewer is set in the source view too");
  fs.chmodSync(path.join(w.ROOT, "a.md"), 0o440);
  w.store["filer-pro.changed"] = { at: 9100, perms: { machine: null, path: path.join(w.ROOT, "a.md"), recursive: false } };
  await w.run(1000);
  await settle(100);
  assert.equal(self.editCheck?.state, "refused", "the edit check follows the new mode");
});

// ---- #39: one bounded exec per read on a machine, a local file that is not UTF-8 is shown

const FILE_EXECS = (w) => w.log.execs.filter((e) => !(e.cmd === "sh" && e.args[1] === LIST_SCRIPT) && e.cmd !== "git");

test("#39 remote: opening a text file and Refresh each cost one exec for the file (was cat + probe)", async () => {
  const w = world({ machine: "box" });
  w.put("a.txt", "one\n");
  const self = await boot(w);
  const before = FILE_EXECS(w).length;
  await opened(w, self);
  await settle(50);
  assert.equal(FILE_EXECS(w).length - before, 1, "open: one exec");
  assert.equal(self.editCheck.state, "ok", "the edit decision came with the read");
  w.put("a.txt", "two\n");
  const mid = FILE_EXECS(w).length;
  click(self.render(w.rcx), "files-refresh", w.cx);
  await settle(200);
  assert.equal(self.code.value(), "two\n");
  assert.equal(FILE_EXECS(w).length - mid, 1, "Refresh: one exec for the file");
  assert.equal(PROBES(w).length, 0, "no separate edit probe");
});

test("#39 remote: a clean edit buffer reloads with one exec and takes the new baseline", async () => {
  const w = world({ machine: "box" });
  w.put("a.txt", "one\n");
  const self = await boot(w);
  await opened(w, self);
  await settle(50);
  assert.ok(self.enterEdit(w.cx));
  w.put("a.txt", "two\n");
  const mid = FILE_EXECS(w).length;
  w.store["filer-pro.changed"] = { at: 77 };
  await w.run(250);
  await settle(100);
  assert.equal(FILE_EXECS(w).length - mid, 1);
  assert.equal(self.edit.state.value(), "two\n");
  assert.equal(self.edit.info.text, "two\n");
});

test("#39 local: a Latin-1 file is shown with U+FFFD; only a watch batch that names it reads it again", async () => {
  const w = world();
  const p = w.put("l.txt", Buffer.from("caf\xe9\n", "latin1"));
  const self = await boot(w);
  globalThis.__impl.readTextFile = async (q) => { if (q === p) { w.log.reads.push({ p: q, on: null }); throw new Error("stream did not contain valid UTF-8"); } return null; };
  await opened(w, self, "l.txt");
  await settle(50);
  assert.equal(self.fileError, null);
  assert.equal(self.code.value(), "caf\ufffd\n");
  assert.equal(self.editCheck.reason, "Not UTF-8 (Latin-1 or other), use Edit in Terminal");
  const execs = FILE_EXECS(w).length;
  w.put("other.txt", "x\n");
  w.fire(w.ROOT, [path.join(w.ROOT, "other.txt")]);
  await settle(100);
  await w.run(1000);
  assert.equal(FILE_EXECS(w).length, execs, "an unrelated batch: no exec for the file");
  fs.writeFileSync(p, Buffer.from("caf\xe8\n", "latin1"));
  w.fire(w.ROOT, [p]);
  await settle(100);
  await w.run(1000);
  assert.equal(FILE_EXECS(w).length, execs + 1, "named: one local exec");
  assert.ok(FILE_EXECS(w).slice(execs).every((e) => e.on === null));
  assert.equal(self.code.value(), "caf\ufffd\n");
});

// ---- PR #44 x #45: a chmod of an open file that this session saved above 1 MiB (it is verified by size and hash,
// herdr's readTextFile refuses it, so the reload never reads it)

const BIG = "0123456789abcdef".repeat(70000) + "\n"; // about 1.07 MB
const VERIFIES = (w) => w.log.execs.filter((e) => e.cmd === "sh" && e.args[1] === VERIFY_SCRIPT);
// herdr's readTextFile refuses a file above 1 MiB.
function refuseBig(w) {
  const read = globalThis.__impl.readTextFile;
  globalThis.__impl.readTextFile = async (p, o) => { if (!p.startsWith("/app/") && fs.existsSync(p) && fs.statSync(p).size > 1048576) { w.log.reads.push({ p, on: o?.on ?? null }); throw new Error("File too large"); } return read(p, o); };
}
async function savedBig(w, self) {
  await editing(w, self);
  type(w, self.edit.state, BIG);
  click(self.render(w.rcx), "files-save", w.cx);
  await settle(300);
  assert.equal(w.read("a.txt"), BIG);
  assert.ok(texts(self.render(w.rcx)).includes("Saved"), "no conflict message");
}
const A = (w) => ({ machine: null, path: path.join(w.ROOT, "a.txt"), recursive: false });

test("R2: chmod 444 of a file saved above 1 MiB refuses Edit, 644 allows it again; one exec each, the saved text stays", async () => {
  const w = world();
  refuseBig(w);
  w.put("a.txt", "one\n");
  const self = await boot(w);
  await savedBig(w, self);
  self.leaveEdit();
  assert.equal(self.editCheck.state, "ok");
  let n = FILE_EXECS(w).length, v = VERIFIES(w).length;
  await chmodded(w, A(w), 0o444);
  assert.equal(VERIFIES(w).length, v + 1, "the size and hash check");
  assert.equal(FILE_EXECS(w).length, n + 1, "and no other exec for the file");
  assert.deepEqual(self.editCheck, { state: "refused", reason: "No write permission" });
  assert.equal(self.code.value(), BIG, "the saved text stays");
  assert.equal(self.fileError, null);
  assert.equal(self.enterEdit(w.cx), false, "Edit refused");
  n = FILE_EXECS(w).length;
  await chmodded(w, A(w), 0o644);
  assert.equal(FILE_EXECS(w).length, n + 1);
  assert.equal(self.editCheck.state, "ok");
  assert.equal(self.editCheck.info.mode, "644", "the mode follows");
  assert.equal(self.editCheck.info.text, BIG);
  assert.ok(self.enterEdit(w.cx), "Edit allowed");
  type(w, self.edit.state, BIG + "more\n");
  click(self.render(w.rcx), "files-save", w.cx);
  await settle(300);
  assert.equal(w.read("a.txt"), BIG + "more\n", "saved from the kept baseline, no conflict");
});

test("R2: a clean edit buffer above 1 MiB whose file became read only leaves edit mode, the text stays", async () => {
  const w = world();
  refuseBig(w);
  w.put("a.txt", "one\n");
  const self = await boot(w);
  await savedBig(w, self);
  assert.ok(self.edit && !self.edit.dirty);
  await chmodded(w, A(w), 0o444);
  assert.equal(self.edit, null, "edit mode ended");
  assert.equal(self.editCheck.reason, "No write permission");
  assert.equal(self.code.value(), BIG);
});

test("R2: a chmod of a clean edit buffer above 1 MiB that still may write keeps edit mode and shows the new mode", async () => {
  const w = world();
  refuseBig(w);
  w.put("a.txt", "one\n");
  const self = await boot(w);
  await savedBig(w, self);
  const e = self.edit;
  await chmodded(w, A(w), 0o600);
  assert.equal(self.edit, e, "still editing");
  assert.equal(e.info.mode, "600");
  assert.equal(self.editCheck.info, e.info);
});

test("R2: a file saved above 1 MiB whose folder then loses search permission drops the saved text and says why (noaccess)", { skip: process.getuid?.() === 0 && "root ignores permission bits" }, async () => {
  const w = world();
  refuseBig(w);
  w.put("a.txt", "one\n");
  const self = await boot(w);
  await savedBig(w, self);
  self.leaveEdit();
  assert.ok(self.bigSaved, "the saved text is kept before the chmod");
  fs.chmodSync(w.ROOT, 0o444); // read without search: the file cannot be reached
  try {
    const v = VERIFIES(w).length;
    await chmodded(w, A(w));
    assert.equal(VERIFIES(w).length, v + 1, "the reload went through VERIFY_SCRIPT");
    assert.equal(self.bigSaved ?? null, null, "the saved text is dropped");
    assert.equal(self.fileError, "No search permission on its folder \u00b7 cannot show this file");
    assert.ok(!texts(self.render(w.rcx)).includes("This file is no longer available"));
  } finally { fs.chmodSync(w.ROOT, 0o755); }
});

test("R5: a chmod of a local file that is not UTF-8 reads it again (forced, lossy) and gives its edit check", async () => {
  const w = world();
  const p = w.put("l.txt", Buffer.from("caf\xe9\n", "latin1"));
  const self = await boot(w);
  const read = globalThis.__impl.readTextFile;
  globalThis.__impl.readTextFile = async (q, o) => { if (q === p) { w.log.reads.push({ p: q, on: null }); throw new Error("stream did not contain valid UTF-8"); } return read(q, o); };
  await opened(w, self, "l.txt");
  await settle(50);
  self.editCheck = null; // the next decision must come from the chmod
  const n = FILE_EXECS(w).length;
  fs.chmodSync(p, 0o444);
  w.store["filer-pro.changed"] = { at: 9300, perms: { machine: null, path: p, recursive: false } };
  await w.run(1000);
  await settle(100);
  assert.equal(FILE_EXECS(w).length, n + 1, "one bounded read, locally");
  assert.equal(self.code.value(), "caf\ufffd\n");
  assert.equal(self.editCheck?.reason, "Not UTF-8 (Latin-1 or other), use Edit in Terminal");
});

test("R5: a chmod of a remote file that is not UTF-8 gives its edit check with one exec", async () => {
  const w = world({ machine: "box" });
  w.put("l.txt", Buffer.from("caf\xe9\n", "latin1"));
  const self = await boot(w);
  await opened(w, self, "l.txt");
  await settle(50);
  assert.equal(self.code.value(), "caf\ufffd\n");
  self.editCheck = null;
  const n = FILE_EXECS(w).length;
  w.store["filer-pro.changed"] = { at: 9400, perms: { machine: "box", path: path.join(w.ROOT, "l.txt"), recursive: false } };
  await w.run(1000);
  await settle(100);
  assert.equal(FILE_EXECS(w).length, n + 1);
  assert.ok(FILE_EXECS(w).slice(n).every((e) => e.on === "box"));
  assert.equal(self.editCheck?.reason, "Not UTF-8 (Latin-1 or other), use Edit in Terminal");
});

test("R5: a remote chmod covered by perms costs one exec for the open file; the edit check follows", async () => {
  const w = world({ machine: "box" });
  w.put("a.txt", "one\n");
  const self = await boot(w);
  await opened(w, self);
  await settle(50);
  assert.equal(self.editCheck.state, "ok");
  const n = FILE_EXECS(w).length;
  fs.chmodSync(path.join(w.ROOT, "a.txt"), 0o440);
  w.store["filer-pro.changed"] = { at: 9500, perms: { machine: "box", path: path.join(w.ROOT, "a.txt"), recursive: false } };
  await w.run(1000);
  await settle(100);
  assert.equal(FILE_EXECS(w).length, n + 1, "one exec");
  assert.equal(PROBES(w).length, 0, "no separate probe");
  assert.equal(self.editCheck.state, "refused");
});

// ---- #42: a folder reached through a symlink (l -> a, both in the root, a collapsed)

async function linked(w) {
  fs.mkdirSync(path.join(w.ROOT, "a"));
  w.put("a/x.txt", "x\n");
  fs.symlinkSync("a", path.join(w.ROOT, "l"));
  w.put("top.txt", "t\n");
  const self = await boot(w);
  self.toggle("l", w.cx);
  await settle();
  await w.run(1000);
  return self;
}

test("R3: an expanded symlinked folder refreshes on a change reported under its real path; its real path came with the listing", async () => {
  const w = world();
  const self = await linked(w);
  assert.ok(shownNames(self, "l").includes("x.txt"));
  assert.equal(self.realFolders.get("l"), fs.realpathSync(path.join(w.ROOT, "a")));
  const n = REFRESHES(w), execs = w.log.execs.length;
  w.put("a/new.txt", "n\n");
  w.fire(w.ROOT, [path.join(fs.realpathSync(w.ROOT), "a/new.txt")]);
  await settle();
  assert.equal(REFRESHES(w), n + 1, "refreshed");
  assert.ok(shownNames(self, "l").includes("new.txt"), "the new file shows below the link");
  assert.ok(!w.log.execs.slice(execs).some((e) => e.cmd === "sh" && e.args[1] !== LIST_SCRIPT && e.cmd !== "git"), "no extra exec to resolve");
});

test("R3: the open file below an expanded symlinked folder is named by its real path and read", async () => {
  const w = world();
  const self = await linked(w);
  await opened(w, self, "l/x.txt");
  await w.run(1000);
  w.put("a/x.txt", "y\n");
  w.fire(w.ROOT, [path.join(fs.realpathSync(w.ROOT), "a/x.txt")]);
  await settle(100);
  assert.equal(self.code.value(), "y\n");
});

test("R3: a file with the open file's name elsewhere (node_modules/**/index.js) neither refreshes nor reads after one resolve", async () => {
  const w = world();
  fs.mkdirSync(path.join(w.ROOT, "src"));
  w.put("src/index.js", "a\n");
  fs.mkdirSync(path.join(w.ROOT, "node_modules/pkg"), { recursive: true });
  w.put("node_modules/pkg/index.js", "b\n");
  const self = await boot(w);
  await opened(w, self, "src/index.js");
  await w.run(1000);
  const n = REFRESHES(w), reads = READS(w, "src/index.js").length, execs = w.log.execs.length;
  for (let i = 0; i < 20; i++) {
    w.fire(w.ROOT, [path.join(w.ROOT, "node_modules/pkg/index.js")]);
    await w.run(500);
  }
  assert.equal(REFRESHES(w), n, "no refresh");
  assert.equal(READS(w, "src/index.js").length, reads, "no read of the open file");
  assert.equal(w.log.execs.length - execs, 1, "one exec: the open file's folder resolved once");
  w.put("src/index.js", "c\n");
  w.fire(w.ROOT, [path.join(w.ROOT, "src/index.js")]);
  await settle(100);
  assert.equal(self.code.value(), "c\n", "the open file itself still follows");
});

test("R3: the open file behind a symlinked folder that is not expanded is matched once its folder is resolved", async () => {
  const w = world();
  fs.mkdirSync(path.join(w.ROOT, "a"));
  w.put("a/x.txt", "x\n");
  fs.symlinkSync("a", path.join(w.ROOT, "l"));
  const self = await boot(w);
  await opened(w, self, "l/x.txt");
  await w.run(1000);
  w.put("a/x.txt", "y\n");
  w.fire(w.ROOT, [path.join(fs.realpathSync(w.ROOT), "a/x.txt")]);
  await settle(100);
  await w.run(1000);
  assert.equal(self.code.value(), "y\n");
  assert.equal(self.fileReal?.dir, fs.realpathSync(path.join(w.ROOT, "a")));
});

test("R5: realRoot failing (null): the watch compares the root as given", async () => {
  const w = world();
  const exec = globalThis.__impl.exec;
  globalThis.__impl.exec = async (cmd, args, o) => (cmd === "sh" && /pwd -P/.test(args[1]) && args[1] !== LIST_SCRIPT ? { code: 1, stdout: "", stderr: "no" } : exec(cmd, args, o));
  const self = await home(w);
  assert.equal(await self.realRoot(w.ROOT), null);
  await w.run(1000);
  const n = REFRESHES(w);
  w.fire(w.ROOT, [path.join(w.ROOT, "Library/Caches/x")]);
  await w.run(1000);
  assert.equal(REFRESHES(w), n, "a collapsed path under the root as given: nothing (no fallback refresh)");
  w.put("new.txt", "n\n");
  w.fire(w.ROOT, [path.join(w.ROOT, "new.txt")]);
  await settle();
  assert.equal(REFRESHES(w), n + 1);
});

// ---- issue #48: git marks do not depend on whether the root is a symlink

const sh = (cwd, ...args) => { const r = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); };
const GITS = (w) => w.log.execs.filter((e) => e.cmd === "git");
function repo(dir) {
  fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
  sh(dir, "init", "-q");
  fs.writeFileSync(path.join(dir, "kept.txt"), "k\n");
  fs.writeFileSync(path.join(dir, "sub", "a.txt"), "a\n");
  sh(dir, "add", "."); sh(dir, "commit", "-qm", "init");
  fs.appendFileSync(path.join(dir, "kept.txt"), "more\n");
  fs.writeFileSync(path.join(dir, "sub", "new.txt"), "n\n");
}
const marksOf = (self) => Object.fromEntries(Object.entries(self.marks).map(([k, v]) => [path.relative(self.root, k), v]));

for (const [where, machine] of [["local", null], ["remote", "box"]]) {
  test(`marks: a repository reached through a symlinked root shows its marks (${where})`, async () => {
    const w = world({ machine, link: true, git: true });
    repo(w.REAL);
    const self = await boot(w);
    assert.deepEqual(marksOf(self), { "kept.txt": "M", "sub/new.txt": "A" });
    assert.equal(self.marks[path.join(w.ROOT, "kept.txt")], "M", "keyed by the logical root the rows look up");
  });

  test(`marks: a normal root keeps its marks (${where})`, async () => {
    const w = world({ machine, git: true });
    repo(w.ROOT);
    const self = await boot(w);
    assert.deepEqual(marksOf(self), { "kept.txt": "M", "sub/new.txt": "A" });
  });

  test(`marks: the root is a symlink to a folder inside a repository above it; paths outside are dropped (${where})`, async () => {
    const w = world({ machine, git: true });
    const top = path.join(w.base, "top");
    repo(top);
    fs.writeFileSync(path.join(top, "sub", "mod.txt"), "x\n"); // untracked sibling, shown
    fs.rmSync(w.ROOT, { recursive: true }); fs.symlinkSync(path.join(top, "sub"), w.ROOT);
    const self = await boot(w);
    assert.deepEqual(marksOf(self), { "mod.txt": "A", "new.txt": "A" }, "kept.txt lies outside the root");
  });
}

test("marks: a .git/index change under a symlinked root refreshes the tree, and the marks stay keyed under the logical root", async () => {
  const w = world({ link: true, git: true });
  repo(w.REAL);
  const self = await boot(w);
  assert.deepEqual(marksOf(self), { "kept.txt": "M", "sub/new.txt": "A" });
  sh(w.REAL, "commit", "-qam", "more"); // kept.txt is clean now; the index and HEAD changed
  const n = REFRESHES(w);
  w.fire(w.ROOT, [path.join(w.REAL, ".git", "index")]); // herdr reports the real path
  await settle(60);
  assert.equal(REFRESHES(w), n + 1, "one refresh");
  assert.deepEqual(marksOf(self), { "sub/new.txt": "A" });
  assert.equal(self.marks[path.join(w.ROOT, "sub", "new.txt")], "A", "keyed by this.root");
  assert.ok(Object.keys(self.marks).every((k) => k.startsWith(self.root + "/")), "no key under the physical path");
});

test("marks: a refresh makes one git rev-parse and one git status, with a symlinked root as with a normal one", async () => {
  for (const link of [false, true]) {
    const w = world({ link, git: true });
    repo(w.REAL);
    const self = await boot(w);
    const before = GITS(w).length;
    self.refresh(w.cx);
    await settle(40);
    const calls = GITS(w).slice(before).map((e) => e.args[0] === "--no-optional-locks" ? "status" : e.args[0]);
    assert.deepEqual(calls, ["rev-parse", "status"], `link=${link}`);
  }
});

// ---- the git dir watch: the root is a subfolder of a repository, whose .git the root watch never reports

// A repository at <base>/top whose subfolder sub/ is the root (the space folder is <base>/top/sub). kept.txt above the
// root and a.txt in it are modified.
function subRepo(w, name = "top") {
  const top = path.join(fs.realpathSync(w.base), name);
  fs.mkdirSync(path.join(top, "sub"), { recursive: true });
  sh(top, "init", "-q");
  fs.writeFileSync(path.join(top, "kept.txt"), "k\n");
  fs.writeFileSync(path.join(top, "sub", "a.txt"), "a\n");
  sh(top, "add", "."); sh(top, "commit", "-qm", "init");
  fs.appendFileSync(path.join(top, "kept.txt"), "more\n");
  fs.appendFileSync(path.join(top, "sub", "a.txt"), "more\n");
  w.state.folder = path.join(top, "sub");
  return { top, sub: path.join(top, "sub"), git: path.join(top, ".git") };
}
const gitWatchesOf = (w, dir) => w.log.watches.filter((p) => p === dir).length;
async function until(w, ok, ms = 2000) { let t = 0; await settle(); while (!ok() && t < ms) { await w.run(250); t += 250; } return t; }

test("git dir watch: a commit in a subfolder root refreshes the marks via the git dir watch, and reset --soft brings them back", async () => {
  const w = world({ git: true });
  const r = subRepo(w);
  const self = await boot(w);
  assert.deepEqual(marksOf(self), { "a.txt": "M" });
  assert.equal(gitWatchesOf(w, r.git), 1, "the repository's .git is watched");
  sh(r.sub, "add", "a.txt"); sh(r.sub, "commit", "-qm", "c");
  await w.run(1000);
  const n = REFRESHES(w);
  w.fire(r.git, [path.join(r.git, "objects", "ab", "cdef"), path.join(r.git, "index"), path.join(r.git, "refs", "heads", "main")]);
  const ms = await until(w, () => !Object.keys(self.marks).length);
  console.log(`# git dir watch: marks clear ${ms} ms (simulated) after the commit batch`);
  assert.deepEqual(marksOf(self), {}, "the commit cleared the mark");
  assert.equal(REFRESHES(w), n + 1, "one refresh");
  assert.ok(ms <= 1000);
  assert.equal(gitWatchesOf(w, r.git), 2, "the loop waits again, no second loop");
  sh(r.sub, "reset", "-q", "--soft", "HEAD~1");
  await w.run(1000);
  w.fire(r.git, [path.join(r.git, "HEAD"), path.join(r.git, "logs", "HEAD")]);
  await until(w, () => Object.keys(self.marks).length > 0);
  assert.deepEqual(marksOf(self), { "a.txt": "M" }, "reset --soft: staged again");
  sh(r.sub, "restore", "--staged", "a.txt");
  fs.writeFileSync(path.join(r.sub, "n.txt"), "n\n"); sh(r.sub, "add", "n.txt");
  await w.run(1000);
  w.fire(r.git, [path.join(r.git, "index")]);
  await until(w, () => self.marks[path.join(self.root, "n.txt")] === "A");
  assert.deepEqual(marksOf(self), { "a.txt": "M", "n.txt": "A" });
});

test("git dir watch: objects/ and logs/ events are ignored (no refresh, no exec)", async () => {
  const w = world({ git: true });
  const r = subRepo(w);
  await boot(w);
  await w.run(1000);
  const execs = w.log.execs.length;
  for (let i = 0; i < 20; i++) {
    w.fire(r.git, [path.join(r.git, "objects", "ab", `c${i}`), path.join(r.git, "logs", "HEAD"), path.join(r.git, "logs", "refs", "heads", "main"), path.join(r.git, "index.lock"), path.join(r.git, "ORIG_HEAD")]);
    await w.run(500);
  }
  assert.equal(w.log.execs.length - execs, 0, "no exec for objects, logs and locks");
  assert.equal(gitWatchesOf(w, r.git), 21, "the loop kept waiting");
});

test("git dir watch: restarted for another repository and stopped when the root changes or becomes the repository top", async () => {
  const w = world({ git: true });
  const a = subRepo(w, "one"), b = subRepo(w, "two");
  w.state.folder = a.sub;
  const self = await boot(w);
  assert.equal(gitWatchesOf(w, a.git), 1);
  w.state.folder = b.sub; // another terminal folder: the other repository
  self.refresh(w.cx); await settle(80);
  assert.equal(gitWatchesOf(w, b.git), 1, "restarted on the new repository");
  await w.run(1000);
  let n = REFRESHES(w);
  w.fire(a.git, [path.join(a.git, "index")]);
  await w.run(1000);
  assert.equal(REFRESHES(w), n, "the old loop ends at its next batch without refreshing");
  assert.equal(gitWatchesOf(w, a.git), 1, "and does not wait again");
  w.state.folder = b.top; // the repository top: the root watch covers .git
  self.refresh(w.cx); await settle(80);
  await w.run(1000);
  n = REFRESHES(w);
  w.fire(b.git, [path.join(b.git, "index")]);
  await w.run(1000);
  assert.equal(REFRESHES(w), n, "no git dir watch at the repository top");
  assert.equal(gitWatchesOf(w, b.git), 1);
  w.state.folder = a.sub; // back to the first subfolder: a new context starts a new loop
  self.refresh(w.cx); await settle(80);
  assert.equal(gitWatchesOf(w, a.git), 2, "started again after coming back");
});

test("git dir watch: stopped when the same root becomes the top of its own repository (prefix empty)", async () => {
  const w = world({ git: true });
  const r = subRepo(w);
  const self = await boot(w);
  sh(r.sub, "init", "-q"); // a repository of its own: the prefix is "" now
  self.refresh(w.cx); await settle(80);
  await w.run(1000);
  const n = REFRESHES(w);
  w.fire(r.git, [path.join(r.git, "index")]);
  await w.run(1000);
  assert.equal(REFRESHES(w), n, "the old git dir watch no longer refreshes");
  assert.equal(gitWatchesOf(w, r.git), 1, "and is not restarted");
});

test("git dir watch: a linked worktree watches the common dir; its refs/ and its own index count, the main worktree's index does not", async () => {
  const w = world({ git: true });
  const r = subRepo(w);
  const wt = path.join(fs.realpathSync(w.base), "wt");
  sh(r.top, "worktree", "add", "-q", wt, "-b", "side");
  fs.appendFileSync(path.join(wt, "sub", "a.txt"), "w\n");
  w.state.folder = path.join(wt, "sub");
  const self = await boot(w);
  assert.deepEqual(marksOf(self), { "a.txt": "M" });
  assert.equal(gitWatchesOf(w, r.git), 1, "the common dir");
  assert.equal(gitWatchesOf(w, path.join(r.git, "worktrees", "wt")), 0, "its git dir lies inside: not watched twice");
  await w.run(1000);
  let n = REFRESHES(w);
  w.fire(r.git, [path.join(r.git, "index"), path.join(r.git, "HEAD")]);
  await w.run(1000);
  assert.equal(REFRESHES(w), n, "the main worktree's index and HEAD: nothing");
  sh(path.join(wt, "sub"), "commit", "-qam", "w");
  w.fire(r.git, [path.join(r.git, "refs", "heads", "side")]);
  await until(w, () => !Object.keys(self.marks).length);
  assert.equal(REFRESHES(w), n + 1, "refs/ in the common dir: one refresh");
  assert.deepEqual(marksOf(self), {});
  await w.run(1000);
  n = REFRESHES(w);
  w.fire(r.git, [path.join(r.git, "worktrees", "wt", "index")]);
  await settle(60);
  assert.equal(REFRESHES(w), n + 1, "the worktree's own index: one refresh");
});

test("git dir watch: a subfolder root stays at 0 exec calls per minute while idle", async () => {
  const w = world({ git: true });
  subRepo(w);
  const self = await boot(w);
  w.put = (name, content) => fs.writeFileSync(path.join(w.state.folder, name), content);
  self.show("a.txt", w.cx); await settle();
  const before = w.log.execs.length;
  await w.run(60_000);
  assert.equal(w.log.execs.length - before, 0);
});

test("git dir watch: one rev-parse per refresh (locally with the git dir, on a machine the plain prefix call)", async () => {
  for (const machine of [null, "box"]) {
    const w = world({ machine, git: true });
    subRepo(w);
    const self = await boot(w);
    const before = GITS(w).length;
    self.refresh(w.cx);
    await settle(40);
    const calls = GITS(w).slice(before);
    assert.deepEqual(calls.map((e) => e.args[0] === "--no-optional-locks" ? "status" : e.args[0]), ["rev-parse", "status"], `machine=${machine}`);
    assert.deepEqual(calls[0].args, machine ? ["rev-parse", "--show-prefix"] : ["rev-parse", "--show-prefix", "--absolute-git-dir", "--git-common-dir", "--show-toplevel"]);
    if (machine) assert.equal(w.log.watches.length - w.log.watches.filter((p) => p.includes("/app/")).length, 0, "no watch on a machine");
  }
});
