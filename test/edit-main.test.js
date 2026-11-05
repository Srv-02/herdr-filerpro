// Issue #22: edit mode of the source view in mods/filer-pro/main.js. main.js is loaded with stubbed host modules (as in
// test/bundles-main.test.js); the builders record their calls so the drawn tree can be searched and clicked. The fake exec runs
// the textedit scripts with the real sh, so a save really changes a file in a scratch folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { mkTmpSync } from "./tmp-helper.js";
import { PROBE_SCRIPT, COMMIT_SCRIPT } from "../mods/filer-pro/lib/textedit.js";
import { numbers } from "../mods/filer-pro/lib/settings.js";

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
  writeFile = (...a) => globalThis.__impl.fsWrite(...a), mkdir = (...a) => globalThis.__impl.fsMkdir(...a), unlink = (...a) => globalThis.__impl.fsUnlink(...a);`,
};
const hooks = `export async function resolve(s, c, next) { return s in ${JSON.stringify(STUBS)} ? { url: "stub:" + s, shortCircuit: true } : next(s, c); }
export async function load(u, c, next) { return u.startsWith("stub:") ? { format: "module", shortCircuit: true, source: ${JSON.stringify(STUBS)}[u.slice(5)] } : next(u, c); }`;
register("data:text/javascript," + encodeURIComponent(hooks));
const FilerPro = (await import("../mods/filer-pro/main.js")).default;

const never = () => new Promise(() => {});
const settle = async () => { for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r)); };
const DEFAULTS = { ...numbers(null), node_path: "", svg_check: true, double_click_files: false, double_click_apps: true };

// One scratch world: ROOT holds the files; HOME and the cache folder of the edit scripts are scratch folders too.
// opts: platform, machine, config (JSON for filer-pro.json), fireOnSet (does set_value fire "change"?), props.
function world({ platform = "linux", machine = null, config = null, fireOnSet = false, props = {} } = {}) {
  const base = mkTmpSync("edit-main-");
  const ROOT = path.join(base, "files");
  fs.mkdirSync(ROOT);
  const env = { ...process.env, HOME: path.join(base, "home"), XDG_CACHE_HOME: path.join(base, "cache") };
  const store = {};
  const log = { execs: [], overlays: [], closed: [], notes: [], writes: [], mkdirs: [], unlinks: [], states: [], inputs: [] };
  const state = { focused: {}, fireOnSet };
  const timers = [];
  const cx = {
    notified: 0, stopped: 0,
    notify() { this.notified++; }, sleep: never, stop_propagation() { this.stopped++; }, phase: () => "ok",
    spawn: (fn) => { const p = Promise.resolve().then(() => fn(cx)); p.catch(() => {}); return p; },
    focus_handle: () => ({}),
    timer: { after: () => {}, every: (ms, fn) => timers.push({ ms, fn }) },
  };
  // notify during render throws, as it does in the host
  const rcx = { ...cx, notify() { throw new Error("cx.notify() during render"); } };
  globalThis.__impl = {
    props: () => props, appHome: () => "/app", home: () => "/Users/example", window: () => ({ platform }),
    theme: () => new Proxy({}, { get: (_t, k) => String(k) }), settings: () => ({ dark: true, font_family: "mono" }),
    spaces: () => [{ active: true, id: "s1", folder: ROOT, machine }], panes: () => [], focused: () => state.focused,
    shared: (k) => store[k], setShared: (k, v) => { store[k] = v; },
    readTextFile: async (p) => {
      if (p === "/app/filer-pro.json") return config;
      try { return fs.readFileSync(p, "utf8"); } catch { return null; }
    },
    writeTextFile: async () => {}, hc: async () => ({ code: 0, stdout: "{}", stderr: "" }),
    exec: async (cmd, args, opts = {}) => {
      log.execs.push({ cmd, args, opts });
      if (cmd !== "sh") return { code: 1, stdout: "", stderr: "" };
      // The fake appHome "/app" lives in the scratch folder for the scripts (the local save stages its text there).
      const real = args.map((a) => (a.startsWith("/app/") ? path.join(base, a) : a));
      const r = spawnSync("sh", real, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env });
      return { code: r.status, stdout: r.stdout, stderr: r.stderr };
    },
    openOverlay: (o) => { log.overlays.push(o); return "ov1"; }, closeOverlay: (id) => log.closed.push(id),
    notify: (n) => log.notes.push(n), watchFolder: never, nextCommand: never, layout: () => ({}), pickFolder: async () => null, run: () => {},
    fsWrite: async (p, text) => {
      log.writes.push({ p, text });
      if (p.startsWith("/app/filer-pro/edit/")) fs.writeFileSync(path.join(base, p), text);
    }, fsMkdir: async (p) => { log.mkdirs.push(p); }, fsUnlink: async (p) => { log.unlinks.push(p); },
    editorNew: (o) => {
      const s = {
        opts: o, v: o.value, handlers: {}, released: false, sets: [],
        value() { return this.v; },
        set_value(v) { this.v = v; this.sets.push(v); if (state.fireOnSet) this.handlers.change?.({}, cx); },
        on(ev, fn) { this.handlers[ev] = fn; return true; },
        release() { this.released = true; return true; },
      };
      log.states.push(s);
      return s;
    },
    inputNew: (o) => {
      const s = {
        opts: o, v: o?.value ?? "", handlers: {},
        value() { return this.v; }, set_value(v) { this.v = v; }, on(ev, fn) { this.handlers[ev] = fn; return true; },
        set_selected_range() {}, focus() {}, release() { return true; },
      };
      log.inputs.push(s);
      return s;
    },
  };
  const w = {
    base, ROOT, log, store, state, cx, rcx, timers, props,
    put(name, content, mode = 0o640) { const p = path.join(ROOT, name); fs.writeFileSync(p, content); fs.chmodSync(p, mode); return p; },
    read: (name) => fs.readFileSync(path.join(ROOT, name)),
  };
  return w;
}

// A panel copy that knows ROOT (refresh reads the real folder through the same sh listing as the host).
async function panel(w) {
  const self = Object.assign(Object.create(FilerPro.prototype), { cfg: DEFAULTS, saved: new Map(), reload: { signal: () => false, take: () => false }, jobs: {}, perf: null });
  self.refresh(w.cx);
  await settle();
  return self;
}
// A fullscreen dialog copy through the real init.
async function dialog(w, file, mode) {
  const self = new FilerPro();
  w.props.overlay = "ov1"; w.props.view = "file"; w.props.root = w.ROOT; w.props.path = file; w.props.mode = mode;
  self.init(null, w.cx);
  await settle();
  return self;
}
// world() with props the dialog can fill in
function dialogWorld(opts = {}) { const props = {}; if (opts.machine) props.machine = opts.machine; return world({ ...opts, props }); }

function* walk(e) {
  if (!e || typeof e !== "object") return;
  yield e;
  for (const k of e.kids ?? []) yield* walk(k);
}
const idOf = (el) => el.calls?.find((c) => c[0] === "id")?.[1];
const byId = (root, id) => [...walk(root)].find((e) => idOf(e) === id);
const has = (call, el) => el.calls.some(([k]) => k === call);
const handler = (el, name) => el.calls.find(([k]) => k === name).at(-1);
const texts = (root) => [...walk(root)].flatMap((e) => (e.kids ?? []).filter((k) => typeof k === "string"));
const editorOf = (root) => [...walk(root)].find((e) => e.kind === "editor");
const click = (tree, id, cx) => handler(byId(tree, id), "on_click")({ modifiers: {} }, cx);
const tooltipOf = (el) => el.calls.find(([k]) => k === "tooltip")?.[1];
const type = (w, state, text) => { state.v = text; state.handlers.change({}, w.cx); };
const lastState = (w) => w.log.states.at(-1);
const PROBES = (w) => w.log.execs.filter((e) => e.cmd === "sh" && e.args[1] === PROBE_SCRIPT);
const COMMITS = (w) => w.log.execs.filter((e) => e.cmd === "sh" && e.args[1] === COMMIT_SCRIPT);
const render = (self, w) => self.render(w.rcx);

async function opened(w, self, name = "a.txt") {
  self.show(name, w.cx);
  await settle();
}
async function editing(w, self, name = "a.txt") {
  await opened(w, self, name);
  click(render(self, w), "files-edit", w.cx);
  await settle();
}

test("a UTF-8 file: after the probe Edit is enabled and the status line shows encoding, line ends and mode", async () => {
  const w = world();
  w.put("a.txt", "héllo\nwörld\n", 0o640);
  const self = await panel(w);
  await opened(w, self);
  const tree = render(self, w);
  const edit = byId(tree, "files-edit");
  assert.ok(edit && has("on_click", edit), "Edit is enabled");
  assert.ok(texts(tree).includes("UTF-8 · LF · 640"), texts(tree).join("|"));
  assert.equal(PROBES(w).length, 1);
});

test("refused files: Edit is dimmed with the reason as tooltip", async () => {
  const cases = [
    ["Latin-1", async (w) => { w.put("a.txt", Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])); }, {}, "Not UTF-8 (Latin-1 or other), use Edit in Terminal", true],
    ["symlink", async (w) => { w.put("real.txt", "x\n"); fs.symlinkSync("real.txt", path.join(w.ROOT, "a.txt")); }, {}, "Symbolic link", true],
    ["truncated", async (w) => { w.put("a.txt", "x".repeat(10001) + "\n"); }, { config: JSON.stringify({ source_max_chars: 10000 }) }, "Display truncated", false],
    ["windows", async (w) => { w.put("a.txt", "x\n"); }, { platform: "windows" }, "Editing is not available on Windows", false],
  ];
  for (const [name, setup, opts, reason, probed] of cases) {
    const w = world(opts);
    await setup(w);
    const self = await panel(w);
    await opened(w, self);
    const edit = byId(render(self, w), "files-edit");
    assert.ok(edit, name);
    assert.equal(has("on_click", edit), false, `${name}: no click`);
    assert.equal(tooltipOf(edit), reason, name);
    assert.equal(PROBES(w).length, probed ? 1 : 0, `${name}: probe`);
    self.enterEdit(w.cx);
    assert.equal(self.edit ?? null, null, `${name}: no edit mode`);
  }
});

test("Edit on: an editable state with the text, and the edit buttons in the panel and in the dialog", async () => {
  for (const kind of ["panel", "dialog"]) {
    const w = dialogWorld();
    w.put("a.txt", "one\ntwo\n");
    const self = kind === "panel" ? await panel(w) : await dialog(w, "a.txt", "source");
    if (kind === "panel") await opened(w, self);
    const before = lastState(w);
    assert.equal(before.opts.readonly, true);
    click(render(self, w), "files-edit", w.cx);
    const s = lastState(w);
    assert.notEqual(s, before, kind);
    assert.equal(s.opts.readonly, false, kind);
    assert.equal(s.v, "one\ntwo\n", kind);
    const tree = render(self, w);
    for (const id of ["files-edit", "files-undo", "files-redo", "files-cancel", "files-save", "files-save-copy"]) assert.ok(byId(tree, id), `${kind} ${id}`);
    assert.equal(editorOf(tree).state, s, "the editable state is drawn");
  }
});

test("typing shows the dirty marker in the header, in the panel and in the dialog", async () => {
  for (const kind of ["panel", "dialog"]) {
    const w = dialogWorld();
    w.put("a.txt", "one\n");
    const self = kind === "panel" ? await panel(w) : await dialog(w, "a.txt", "source");
    if (kind === "panel") await opened(w, self);
    click(render(self, w), "files-edit", w.cx);
    assert.equal(texts(render(self, w)).some((t) => t.startsWith("● ")), false, "clean");
    type(w, lastState(w), "one more\n");
    assert.ok(texts(render(self, w)).some((t) => t.startsWith("● ")), kind);
  }
});

test("Save writes the exact bytes into the same inode, stays in edit mode and clears the dirty marker", async () => {
  const w = world();
  const p = w.put("a.txt", "one\n", 0o640);
  const ino = fs.statSync(p).ino;
  const self = await panel(w);
  await editing(w, self);
  type(w, lastState(w), "héllo\nneu\n");
  click(render(self, w), "files-save", w.cx);
  await settle();
  assert.deepEqual(w.read("a.txt"), Buffer.from("héllo\nneu\n"));
  assert.equal(fs.statSync(p).ino, ino);
  assert.equal(fs.statSync(p).mode & 0o777, 0o640);
  const tree = render(self, w);
  assert.ok(byId(tree, "files-save"), "still editing");
  assert.equal(texts(tree).some((t) => t.startsWith("● ")), false, "not dirty");
  assert.ok(texts(tree).includes("Saved"));
  assert.equal(w.store["filer-pro.changed"] != null, true, "the trees reload");
  // the read-only copy shows the new text
  assert.ok(self.code.sets.includes("héllo\nneu\n"));
  // a second edit and save works from the new baseline
  type(w, lastState(w), "zwei\n");
  click(render(self, w), "files-save", w.cx);
  await settle();
  assert.equal(w.read("a.txt").toString(), "zwei\n");
});

test("a CRLF file keeps its line ends when edited and saved", async () => {
  const w = world();
  w.put("a.txt", "a\r\nb\r\n");
  const self = await panel(w);
  await editing(w, self);
  assert.equal(lastState(w).v, "a\nb\n");
  type(w, lastState(w), "a\nb\nc\n");
  click(render(self, w), "files-save", w.cx);
  await settle();
  assert.equal(w.read("a.txt").toString(), "a\r\nb\r\nc\r\n");
});

test("the Edit toggle with unsaved changes asks: Discard, Cancel and Save", async () => {
  const w = world();
  w.put("a.txt", "one\n");
  const self = await panel(w);
  await editing(w, self);
  type(w, lastState(w), "changed\n");
  click(render(self, w), "files-edit", w.cx);
  let tree = render(self, w);
  for (const id of ["files-prompt-save", "files-prompt-discard", "files-prompt-cancel"]) assert.ok(byId(tree, id), id);
  // Cancel keeps editing
  click(tree, "files-prompt-cancel", w.cx);
  tree = render(self, w);
  assert.equal(byId(tree, "files-prompt-save"), undefined);
  assert.ok(byId(tree, "files-save"));
  assert.equal(lastState(w).v, "changed\n");
  // Discard leaves, the file is unchanged
  click(tree, "files-edit", w.cx);
  click(render(self, w), "files-prompt-discard", w.cx);
  tree = render(self, w);
  assert.equal(byId(tree, "files-undo"), undefined, "read only again");
  assert.equal(self.file, "a.txt");
  assert.equal(w.read("a.txt").toString(), "one\n");
  assert.ok(lastState(w).released);
  // Save saves, then leaves
  click(tree, "files-edit", w.cx);
  await settle();
  type(w, lastState(w), "kept\n");
  click(render(self, w), "files-edit", w.cx);
  click(render(self, w), "files-prompt-save", w.cx);
  await settle();
  assert.equal(w.read("a.txt").toString(), "kept\n");
  assert.equal(byId(render(self, w), "files-undo"), undefined);
});

test("the Cancel button: clean leaves at once, dirty asks to discard", async () => {
  const w = world();
  w.put("a.txt", "one\n");
  const self = await panel(w);
  await editing(w, self);
  click(render(self, w), "files-cancel", w.cx);
  assert.equal(byId(render(self, w), "files-undo"), undefined, "clean: left");
  click(render(self, w), "files-edit", w.cx);
  type(w, lastState(w), "x\n");
  click(render(self, w), "files-cancel", w.cx);
  const tree = render(self, w);
  assert.ok(byId(tree, "files-prompt-discard"));
  assert.ok(byId(tree, "files-prompt-cancel"));
  assert.equal(byId(tree, "files-prompt-save"), undefined, "no Save in the discard prompt");
  click(tree, "files-prompt-discard", w.cx);
  assert.equal(byId(render(self, w), "files-undo"), undefined);
  assert.equal(w.read("a.txt").toString(), "one\n");
});

test("back with unsaved changes asks; Discard shows the tree", async () => {
  const w = world();
  w.put("a.txt", "one\n");
  const self = await panel(w);
  await editing(w, self);
  type(w, lastState(w), "x\n");
  click(render(self, w), "files-back", w.cx);
  assert.equal(self.file, "a.txt");
  assert.ok(byId(render(self, w), "files-prompt-discard"));
  click(render(self, w), "files-prompt-discard", w.cx);
  assert.equal(self.file, null);
  assert.equal(self.edit ?? null, null);
  assert.equal(w.read("a.txt").toString(), "one\n");
});

test("dialog keys: cmd-s saves, cmd-z undoes, cmd-shift-z redoes", async () => {
  for (const fireOnSet of [false, true]) {
    const w = dialogWorld({ fireOnSet });
    w.put("a.txt", "one\n");
    const self = await dialog(w, "a.txt", "source");
    click(render(self, w), "files-edit", w.cx);
    const s = lastState(w);
    const key = (keystroke) => { handler(byId(render(self, w), "files-full"), "on_key_down")({ key: keystroke.split("-").at(-1), keystroke, modifiers: {} }, w.cx); };
    const stopped = w.cx.stopped;
    type(w, s, "two\n");
    key("cmd-z");
    assert.equal(s.v, "one\n", `undo (fire ${fireOnSet})`);
    assert.equal(self.edit.dirty, false);
    key("cmd-shift-z");
    assert.equal(s.v, "two\n", `redo (fire ${fireOnSet})`);
    assert.equal(self.edit.dirty, true);
    // the set_value change event must not have recorded a step: one undo returns to the start
    key("cmd-z");
    assert.equal(s.v, "one\n", `single step (fire ${fireOnSet})`);
    key("cmd-shift-z");
    key("cmd-s");
    await settle();
    assert.equal(w.read("a.txt").toString(), "two\n", `save (fire ${fireOnSet})`);
    assert.ok(w.cx.stopped > stopped, "the keys are stopped");
  }
});

test("dialog Esc and the close button with unsaved changes ask first", async () => {
  const w = dialogWorld();
  w.put("a.txt", "one\n");
  const self = await dialog(w, "a.txt", "source");
  const esc = () => handler(byId(render(self, w), "files-full"), "on_key_down")({ key: "escape", keystroke: "escape", modifiers: {} }, w.cx);
  click(render(self, w), "files-edit", w.cx);
  esc();
  assert.deepEqual(w.log.closed, ["ov1"], "clean edit mode: Esc closes");
  w.log.closed.length = 0;
  click(render(self, w), "files-edit", w.cx);
  type(w, lastState(w), "x\n");
  esc();
  assert.deepEqual(w.log.closed, [], "dirty: no close");
  assert.ok(byId(render(self, w), "files-prompt-discard") || byId(render(self, w), "files-prompt-save"));
  click(render(self, w), "files-prompt-cancel", w.cx);
  click(render(self, w), "files-full-close", w.cx);
  assert.deepEqual(w.log.closed, [], "dirty: the close button asks");
  assert.ok(byId(render(self, w), "files-prompt-save"));
  click(render(self, w), "files-prompt-discard", w.cx);
  assert.deepEqual(w.log.closed, ["ov1"], "Discard closes the dialog");
  assert.equal(w.read("a.txt").toString(), "one\n");
});

test("dialog Esc without edit mode and with a clean buffer still closes", async () => {
  const w = dialogWorld();
  w.put("a.txt", "one\n");
  const self = await dialog(w, "a.txt", "source");
  handler(byId(render(self, w), "files-full"), "on_key_down")({ key: "escape", keystroke: "escape", modifiers: {} }, w.cx);
  assert.deepEqual(w.log.closed, ["ov1"]);
});

test("the panel has no key handler that reacts to cmd-s or cmd-z", async () => {
  const w = world();
  w.put("a.txt", "one\n");
  const self = await panel(w);
  await editing(w, self);
  const s = lastState(w);
  type(w, s, "two\n");
  for (const el of walk(render(self, w))) {
    for (const [k, fn] of el.calls.filter(([k]) => k === "on_key_down")) {
      for (const keystroke of ["cmd-s", "cmd-z", "cmd-shift-z"]) fn({ key: keystroke.at(-1), keystroke, modifiers: { platform: true } }, w.cx);
    }
  }
  await settle();
  assert.equal(s.v, "two\n");
  assert.equal(w.read("a.txt").toString(), "one\n");
  assert.equal(COMMITS(w).length, 0);
});

test("a file changed on disk after entering edit mode: Save shows the conflict and keeps buffer and file", async () => {
  const w = world();
  w.put("a.txt", "one\n");
  const self = await panel(w);
  await editing(w, self);
  fs.writeFileSync(path.join(w.ROOT, "a.txt"), "someone else\n");
  type(w, lastState(w), "mine\n");
  click(render(self, w), "files-save", w.cx);
  await settle();
  const tree = render(self, w);
  assert.ok(texts(tree).some((t) => t.includes("The file changed since it was opened")), texts(tree).join("|"));
  assert.equal(w.read("a.txt").toString(), "someone else\n");
  assert.equal(lastState(w).v, "mine\n");
  assert.ok(byId(tree, "files-save"), "still editing");
  assert.equal(self.edit.dirty, true);
});

test("Save a Copy: the form takes a new name, an existing name is refused without overwriting", async () => {
  const w = world();
  w.put("a.txt", "one\n", 0o640);
  w.put("c.txt", "keep\n");
  const self = await panel(w);
  await editing(w, self);
  type(w, lastState(w), "copy text\n");
  click(render(self, w), "files-save-copy", w.cx);
  assert.ok(byId(render(self, w), "filer-pro-copy"), "form shown");
  const form = self.edit.copy;
  assert.equal(form.value, "a copy.txt");
  const enter = (name) => { form.input.set_value(name); form.input.handlers.change({}, w.cx); };
  enter("c.txt");
  form.submit(w.cx);
  await settle();
  assert.equal(w.read("c.txt").toString(), "keep\n", "no overwrite");
  assert.ok(texts(render(self, w)).some((t) => t.includes("already exists")));
  assert.ok(self.edit.copy, "form stays open");
  enter("b.txt");
  form.submit(w.cx);
  await settle();
  assert.equal(w.read("b.txt").toString(), "copy text\n");
  assert.equal(fs.statSync(path.join(w.ROOT, "b.txt")).mode & 0o777, 0o640);
  assert.equal(w.read("a.txt").toString(), "one\n", "the open file is untouched");
  assert.equal(self.edit.copy, null);
  assert.equal(self.edit.dirty, true, "the buffer stays dirty");
  assert.ok(texts(render(self, w)).some((t) => t.includes("Saved a copy as b.txt")));
});

test("an open request while the buffer is dirty is answered with an error and the file stays", async () => {
  const w = world();
  w.put("a.txt", "one\n");
  w.put("b.txt", "two\n");
  const self = await panel(w);
  await editing(w, self);
  type(w, lastState(w), "x\n");
  w.store["filer-pro.show"] = { id: "r1", action: "open", path: path.join(w.ROOT, "b.txt"), on: null };
  self.checkShow(w.cx);
  await settle();
  const shown = w.store["filer-pro.shown"];
  assert.equal(shown.id, "r1");
  assert.deepEqual(shown.result, { ok: false, error: "Unsaved changes in the open file" });
  assert.equal(self.file, "a.txt");
  assert.equal(lastState(w).v, "x\n");
});

test("refresh with a changed focus keeps the context while the buffer is dirty", async () => {
  const w = world();
  w.put("a.txt", "one\n");
  const self = await panel(w);
  await editing(w, self);
  const context = self.context;
  w.state.focused = { cwd: path.join(w.base, "elsewhere") };
  type(w, lastState(w), "x\n");
  self.refresh(w.cx);
  render(self, w);
  assert.equal(self.context, context);
  assert.equal(self.file, "a.txt");
  assert.equal(self.root, w.ROOT);
  // clean: the panel follows the focus again
  click(render(self, w), "files-cancel", w.cx);
  click(render(self, w), "files-prompt-discard", w.cx);
  self.refresh(w.cx);
  assert.notEqual(self.context, context);
});

test("close() with a dirty buffer keeps the text under unsaved/ and notifies", async () => {
  for (const kind of ["panel", "dialog"]) {
    const w = dialogWorld();
    w.put("a.txt", "one\n");
    const self = kind === "panel" ? await panel(w) : await dialog(w, "a.txt", "source");
    if (kind === "panel") await opened(w, self);
    click(render(self, w), "files-edit", w.cx);
    await self.close();
    assert.equal(w.log.writes.length, 0, "clean: nothing kept");
    assert.equal(w.log.notes.length, 0);
    const w2 = dialogWorld();
    w2.put("a.txt", "one\n");
    const s2 = kind === "panel" ? await panel(w2) : await dialog(w2, "a.txt", "source");
    if (kind === "panel") await opened(w2, s2);
    click(render(s2, w2), "files-edit", w2.cx);
    type(w2, lastState(w2), "unsaved text\n");
    await s2.close();
    const write = w2.log.writes.at(-1);
    assert.ok(write.p.startsWith("/app/filer-pro/unsaved/"), kind + " " + write?.p);
    assert.ok(write.p.endsWith("a.txt"));
    assert.equal(write.text, "unsaved text\n");
    assert.equal(w2.log.notes.length, 1);
    assert.equal(w2.log.notes[0].level, "warning");
    assert.ok(w2.log.notes[0].body.includes("/filer-pro/unsaved/"));
    assert.equal(w2.read("a.txt").toString(), "one\n");
  }
});

test("the mirror timer writes while dirty and the file is removed after a save", async () => {
  const w = dialogWorld();
  w.put("a.txt", "one\n");
  const self = await dialog(w, "a.txt", "source");
  const tick = () => w.timers.filter((t) => t.ms === 2000).forEach((t) => t.fn(w.cx));
  click(render(self, w), "files-edit", w.cx);
  tick();
  await settle();
  assert.equal(w.log.writes.length, 0, "clean: no mirror");
  type(w, lastState(w), "draft\n");
  tick();
  await settle();
  assert.equal(w.log.writes.length, 1);
  const mirror = w.log.writes[0].p;
  assert.ok(mirror.startsWith("/app/filer-pro/unsaved/"));
  assert.ok(w.log.mkdirs.includes("/app/filer-pro/unsaved"));
  assert.equal(w.log.writes[0].text, "draft\n");
  tick();
  await settle();
  assert.equal(w.log.writes.length, 1, "unchanged: not written again");
  click(render(self, w), "files-save", w.cx);
  await settle();
  assert.ok(w.log.unlinks.includes(mirror), "removed after the save");
});

test("the panel mirrors from its own tick", async () => {
  const w = world();
  w.put("a.txt", "one\n");
  const self = await panel(w);
  await editing(w, self);
  type(w, lastState(w), "draft\n");
  await self.mirrorUnsaved(w.cx);
  assert.equal(w.log.writes.at(-1).text, "draft\n");
  click(render(self, w), "files-cancel", w.cx);
  click(render(self, w), "files-prompt-discard", w.cx);
  await settle();
  assert.equal(w.log.unlinks.length, 1, "removed after Discard");
});

test("the maximize button is dimmed while the panel buffer is dirty", async () => {
  const w = world();
  w.put("a.txt", "one\n");
  const self = await panel(w);
  await editing(w, self);
  assert.ok(has("on_click", byId(render(self, w), "files-full")));
  type(w, lastState(w), "x\n");
  const full = byId(render(self, w), "files-full");
  assert.equal(has("on_click", full), false);
  assert.equal(tooltipOf(full), "Save or cancel first");
});

test("on a machine the probe and the save carry the machine", async () => {
  const w = world({ machine: "box" });
  w.put("a.txt", "one\n");
  const self = await panel(w);
  assert.equal(self.on, "box");
  await editing(w, self);
  type(w, lastState(w), "two\n");
  click(render(self, w), "files-save", w.cx);
  await settle();
  assert.equal(w.read("a.txt").toString(), "two\n");
  const scripts = w.log.execs.filter((e) => e.cmd === "sh" && e.args[0] === "-c" && ["probe", "begin", "commit"].includes(e.args[2]));
  assert.ok(scripts.some((e) => e.args[2] === "probe") && scripts.some((e) => e.args[2] === "commit"));
  for (const e of scripts) assert.equal(e.opts.on, "box", e.args[2]);
});

test("a local save stages the text in a private file under appHome: no content in any argv", async () => {
  const w = world();
  w.put("a.txt", "one\n", 0o600);
  const self = await panel(w);
  await editing(w, self);
  const secret = "TOKEN=" + "s3cr3t".repeat(50) + "\n";
  type(w, lastState(w), secret);
  click(render(self, w), "files-save", w.cx);
  await settle();
  assert.equal(w.read("a.txt").toString(), secret);
  const b64 = Buffer.from(secret).toString("base64");
  for (const e of w.log.execs) for (const a of e.args) assert.ok(!a.includes(b64.slice(0, 40)), `content in argv of ${e.args[2]}`);
  assert.ok(w.log.writes.some((x) => x.p.startsWith("/app/filer-pro/edit/") && x.text === b64), "staged under appHome");
  const stage = path.join(w.base, "app", "filer-pro", "edit");
  assert.equal(fs.statSync(stage).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(stage), [], "the save script removed the staged file");
});

test("on a machine nothing is staged locally", async () => {
  const w = world({ machine: "box" });
  w.put("a.txt", "one\n");
  const self = await panel(w);
  await editing(w, self);
  type(w, lastState(w), "two\n");
  click(render(self, w), "files-save", w.cx);
  await settle();
  assert.equal(w.read("a.txt").toString(), "two\n");
  assert.equal(w.log.writes.some((x) => x.p.startsWith("/app/filer-pro/edit/")), false);
});
