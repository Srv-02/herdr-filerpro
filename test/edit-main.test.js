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
import { PROBE_SCRIPT, COMMIT_SCRIPT, CHECK_TIMEOUT_MS } from "../mods/filer-pro/lib/textedit.js";
import { numbers } from "../mods/filer-pro/lib/settings.js";

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
  writeFile = (...a) => globalThis.__impl.fsWrite(...a), mkdir = (...a) => globalThis.__impl.fsMkdir(...a), unlink = (...a) => globalThis.__impl.fsUnlink(...a);`,
};
const hooks = `export async function resolve(s, c, next) { return s in ${JSON.stringify(STUBS)} ? { url: "stub:" + s, shortCircuit: true } : next(s, c); }
export async function load(u, c, next) { return u.startsWith("stub:") ? { format: "module", shortCircuit: true, source: ${JSON.stringify(STUBS)}[u.slice(5)] } : next(u, c); }`;
register("data:text/javascript," + encodeURIComponent(hooks));
const FilerPro = (await import("../mods/filer-pro/main.js")).default;

const never = () => new Promise(() => {});
const settle = async (n = 60) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const DEFAULTS = { ...numbers(null), node_path: "", svg_check: true, double_click_files: false, double_click_apps: true };

// One scratch world: ROOT holds the files; HOME and the cache folder of the edit scripts are scratch folders too.
// opts: platform, machine, config (JSON for filer-pro.json), fireOnSet (does set_value fire "change"?), props.
function world({ platform = "linux", machine = null, config = null, fireOnSet = false, props = {} } = {}) {
  const base = mkTmpSync("edit-main-");
  const ROOT = path.join(base, "files");
  fs.mkdirSync(ROOT);
  // transfer.sh (remote saves copy the staged text with scp) finds the fake scp and ssh of test/fake/.
  const env = { ...process.env, HOME: path.join(base, "home"), XDG_CACHE_HOME: path.join(base, "cache"), FILER_PRO_SCP: FAKE_SCP, FILER_PRO_SSH: FAKE_SSH };
  const store = {};
  const log = { execs: [], overlays: [], closed: [], notes: [], writes: [], mkdirs: [], unlinks: [], states: [], inputs: [] };
  const state = { focused: {}, fireOnSet };
  const timers = [];
  // after(): zero-delay timers fire after the current job (as in the host); longer ones are only recorded (afters).
  const afters = [];
  const cx = {
    notified: 0, stopped: 0,
    notify() { this.notified++; }, sleep: never, stop_propagation() { this.stopped++; }, phase: () => "ok",
    spawn: (fn) => { const p = Promise.resolve().then(() => fn(cx)); p.catch(() => {}); return p; },
    focus_handle: () => ({}),
    timer: { after: (ms, fn) => { afters.push({ ms, fn }); if (ms === 0) setImmediate(() => fn(cx)); }, every: (ms, fn) => timers.push({ ms, fn }) },
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
    writeTextFile: async () => {}, hc: async (a) => ({ code: 0, stdout: a[0] === "machine" ? JSON.stringify({ machines: [{ name: "box", target: "box", via: false }] }) : "{}", stderr: "" }),
    exec: async (cmd, args, opts = {}) => {
      log.execs.push({ cmd, args, opts });
      if (state.hangProbe && args[2] === "probe") return never();
      if (!["sh", "rm", "env"].includes(cmd)) return { code: 1, stdout: "", stderr: "" };
      // The fake appHome "/app" lives in the scratch folder for the scripts (saves stage their text there); its
      // transfer.sh is the repo's.
      const real = args.map((a) => (a === "/app/mods/filer-pro/bin/transfer.sh" ? TRANSFER : a.startsWith("/app/") ? path.join(base, a) : a));
      const r = spawnSync(cmd, real, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: state.failScp ? { ...env, FAKE_FAIL: "scp: Connection closed" } : env });
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
    base, ROOT, log, store, state, cx, rcx, timers, afters, props,
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
    assert.equal(tooltipOf(edit), `Edit: ${reason}`, name);
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

// The edit toolbar is a group of icon buttons: a Lucide glyph in a fixed 24px hit area, a tooltip and an accessibility
// label naming it; dimmed buttons keep their tooltip but have no click.
const glyphOf = (el) => el.kids.find((k) => k.kind === "svg")?.args[0];
const sizeOf = (el) => ["w", "h"].map((k) => el.calls.find(([c]) => c === k)?.[1]);
test("the edit toolbar: icon buttons with glyph, tooltip and label, in the panel and in the dialog", async () => {
  const BUTTONS = [
    ["files-edit", "pencil", "Stop editing", true], ["files-undo", "undo-2", "Undo", false], ["files-redo", "redo-2", "Redo", false],
    ["files-cancel", "circle-x", "Cancel editing", true], ["files-save", "save", "Save", false], ["files-save-copy", "copy-plus", "Save a Copy…", true],
  ];
  for (const kind of ["panel", "dialog"]) {
    const w = dialogWorld();
    w.put("a.txt", "one\n");
    const self = kind === "panel" ? await panel(w) : await dialog(w, "a.txt", "source");
    if (kind === "panel") await opened(w, self);
    let edit = byId(render(self, w), "files-edit");
    assert.equal(glyphOf(edit), "mods/filer-pro/pencil.svg", kind);
    assert.equal(tooltipOf(edit), "Edit", kind);
    assert.equal(edit.kids.some((k) => typeof k === "string"), false, `${kind}: no text label`);
    click(render(self, w), "files-edit", w.cx);
    const tree = render(self, w);
    const group = byId(tree, "files-edit-tools");
    assert.ok(group && has("flex_none", group), `${kind}: one group that does not shrink`);
    for (const [id, glyph, tip, enabled] of BUTTONS) {
      const el = byId(group, id);
      assert.equal(glyphOf(el), `mods/filer-pro/${glyph}.svg`, `${kind} ${id}`);
      assert.equal(tooltipOf(el), tip, `${kind} ${id}`);
      assert.equal(el.calls.find(([c]) => c === "accessibility_label")?.[1], tip, `${kind} ${id}`);
      assert.deepEqual(sizeOf(el), [24, 24], `${kind} ${id}: fixed hit area`);
      assert.ok(has("flex_none", el), `${kind} ${id}`);
      assert.equal(has("on_click", el), enabled, `${kind} ${id}: click`);
    }
    assert.ok(has("bg", byId(group, "files-edit")), `${kind}: Edit is marked while on`);
    type(w, lastState(w), "two\n");
    for (const id of ["files-undo", "files-save"]) assert.ok(has("on_click", byId(render(self, w), id)), `${kind} ${id} after typing`);
  }
});

test("a dimmed Edit names itself and the reason: Checking… while the probe runs", async () => {
  const w = world();
  w.put("a.txt", "one\n");
  const self = await panel(w);
  await opened(w, self);
  self.editCheck = { state: "checking" };
  const edit = byId(render(self, w), "files-edit");
  assert.equal(has("on_click", edit), false);
  assert.equal(tooltipOf(edit), "Edit: Checking…");
});

test("a probe without an answer does not stay on Checking…: Edit greys out with Could not check this file", async () => {
  const w = world();
  w.put("a.txt", "one\n");
  const self = await panel(w);
  w.state.hangProbe = true;
  await opened(w, self);
  assert.equal(tooltipOf(byId(render(self, w), "files-edit")), "Edit: Checking…");
  const timeout = w.afters.find((t) => t.ms === CHECK_TIMEOUT_MS);
  assert.ok(timeout, "a timeout is armed for the check");
  timeout.fn(w.cx);
  await settle();
  assert.deepEqual(self.editCheck, { state: "refused", reason: "Could not check this file (no answer)" });
  const edit = byId(render(self, w), "files-edit");
  assert.equal(has("on_click", edit), false);
  assert.equal(tooltipOf(edit), "Edit: Could not check this file (no answer)");
});

test("the panel title Filer Pro does not shrink beside the toolbar", () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "mods/filer-pro/main.js"), "utf8");
  assert.ok(src.includes('div().flex_none().font_semibold().child("Filer Pro")'));
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
    assert.ok(write.p.endsWith("-a.txt.txt"));
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
  assert.ok(w.log.execs.some((x) => x.args[2] === "private" && x.args[3] === "/app/filer-pro/unsaved"), "folder made private through sh");
  assert.equal(fs.statSync(path.join(w.base, "app", "filer-pro", "unsaved")).mode & 0o777, 0o700);
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

// Panel and fullscreen dialog in one world: they share the shared() store; props() decides which copy a call is.
const DIALOG_PROPS = ["overlay", "view", "root", "path", "mode", "full", "page", "pages", "force", "machine"];
const asPanel = (w) => { for (const k of DIALOG_PROPS) delete w.props[k]; };
const asDialog = (w) => { const o = w.log.overlays.at(-1).props; Object.assign(w.props, { ...o, overlay: "ov1", root: w.ROOT }); };
async function openDialogFromPanel(w) {
  const d = new FilerPro();
  asDialog(w);
  d.init(null, w.cx);
  await settle();
  asPanel(w);
  return d;
}
const inDialog = async (w, fn) => { asDialog(w); try { return await fn(); } finally { asPanel(w); } };

test("maximize hands the unsaved panel buffer to the fullscreen dialog; the panel is read-only while it is open", async () => {
  const w = dialogWorld();
  w.put("a.txt", "one\n");
  const self = await panel(w);
  await editing(w, self);
  type(w, lastState(w), "one\ndraft\n");
  const mirrorPath = self.edit.mirrorPath;
  click(render(self, w), "files-full", w.cx);
  await settle();
  // the unsaved text is on disk (the mirror) before it changes hands, and the dialog opens in the source view
  assert.equal(w.log.writes.at(-1).p, mirrorPath);
  assert.equal(w.log.writes.at(-1).text, "one\ndraft\n");
  const opened = w.log.overlays.at(-1).props;
  assert.equal(opened.mode, "source");
  assert.ok(opened.full);
  // read-only at once: Edit dimmed with the reason, no other edit button, maximize dimmed
  let tree = render(self, w);
  assert.equal(tooltipOf(byId(tree, "files-edit")), "Edit: Editing in full screen");
  assert.equal(has("on_click", byId(tree, "files-edit")), false);
  assert.equal(byId(tree, "files-save"), undefined);
  assert.equal(has("on_click", byId(tree, "files-full")), false);

  const d = await openDialogFromPanel(w);
  await inDialog(w, async () => {
    assert.ok(d.edit, "the dialog is in edit mode");
    assert.equal(d.edit.state.value(), "one\ndraft\n");
    assert.equal(d.edit.dirty, true);
    assert.equal(d.edit.mirrorPath, mirrorPath, "the same mirror file");
    assert.equal(d.edit.history.canUndo(), true, "one step back to the file's text");
    assert.equal(PROBES(w).length, 1, "no second probe: the panel's baseline is used");
  });
  self.pollFull(w.cx);
  assert.equal(self.edit, null, "the panel gave its buffer up");
  assert.equal(self.context.fixed, true, "pinned while the dialog is open");
  assert.equal(w.log.unlinks.length, 0, "the mirror stays for the dialog");
  tree = render(self, w);
  assert.equal(tooltipOf(byId(tree, "files-edit")), "Edit: Editing in full screen");

  // Save in the dialog, then close it: the panel shows the file as saved and may edit again
  await inDialog(w, async () => { click(render(d, w), "files-save", w.cx); await settle(); });
  assert.equal(w.read("a.txt").toString(), "one\ndraft\n");
  await inDialog(w, () => d.close());
  self.pollFull(w.cx);
  await settle();
  assert.equal(self.full, null);
  assert.equal(self.code.value(), "one\ndraft\n", "the panel shows the disk state");
  assert.equal(self.context.fixed, false, "follows the focus again");
  tree = render(self, w);
  assert.equal(tooltipOf(byId(tree, "files-edit")), "Edit");
  assert.ok(has("on_click", byId(tree, "files-full")));
});

test("closing the fullscreen dialog with unsaved text keeps it; the panel shows the file on disk", async () => {
  const w = dialogWorld();
  w.put("a.txt", "one\n");
  const self = await panel(w);
  await editing(w, self);
  type(w, lastState(w), "one\nkeep me\n");
  click(render(self, w), "files-full", w.cx);
  await settle();
  const d = await openDialogFromPanel(w);
  self.pollFull(w.cx);
  await inDialog(w, async () => { type(w, d.edit.state, "one\nkeep me\nmore\n"); await d.close(); });
  assert.equal(w.log.notes.at(-1).title, "Unsaved changes kept");
  assert.equal(w.log.writes.at(-1).text, "one\nkeep me\nmore\n");
  assert.equal(w.read("a.txt").toString(), "one\n");
  self.pollFull(w.cx);
  await settle();
  assert.equal(self.full, null);
  assert.equal(self.edit, null);
  assert.equal(self.code.value(), "one\n");
});

test("maximize without edit mode: the panel's Edit is dimmed until the dialog closes or goes quiet", async () => {
  const w = dialogWorld();
  w.put("a.txt", "one\n");
  const self = await panel(w);
  await opened(w, self);
  click(render(self, w), "files-full", w.cx);
  await settle();
  assert.equal(w.store["filer-pro.handover"], undefined, "nothing to hand over");
  assert.equal(tooltipOf(byId(render(self, w), "files-edit")), "Edit: Editing in full screen");
  const d = await openDialogFromPanel(w);
  await inDialog(w, async () => { assert.equal(d.edit ?? null, null); });
  self.pollFull(w.cx);
  assert.ok(self.full, "still open");
  // a dialog that vanished without close(): no report for 8 s ends the read-only state
  w.store["filer-pro.fullscreen"] = { ...w.store["filer-pro.fullscreen"], at: Date.now() - 9000 };
  self.pollFull(w.cx);
  await settle();
  assert.equal(self.full, null);
  assert.equal(tooltipOf(byId(render(self, w), "files-edit")), "Edit");
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

test("on a machine the staged text goes over scp: no content in any argv, nothing left behind", async () => {
  const w = world({ machine: "box" });
  w.put("a.txt", "one\n", 0o600);
  const self = await panel(w);
  await editing(w, self);
  const secret = "TOKEN=" + "r3m0te".repeat(40) + "\n";
  type(w, lastState(w), secret);
  click(render(self, w), "files-save", w.cx);
  await settle(200);
  assert.equal(w.read("a.txt").toString(), secret);
  const b64 = Buffer.from(secret).toString("base64");
  for (const e of w.log.execs) for (const a of e.args) assert.ok(!a.includes(b64.slice(0, 40)) && !a.includes("r3m0te"), "content in argv");
  assert.ok(w.log.execs.some((e) => e.args[0] === "/app/mods/filer-pro/bin/transfer.sh" && e.args[1] === "up"), "scp through transfer.sh");
  assert.deepEqual(fs.readdirSync(path.join(w.base, "app", "filer-pro", "edit")), [], "local staged file removed");
});

test("on a machine a failed transfer keeps the buffer and edit mode and removes the local staged file", async () => {
  const w = world({ machine: "box" });
  w.put("a.txt", "one\n");
  const self = await panel(w);
  await editing(w, self);
  type(w, lastState(w), "two\n");
  w.state.failScp = true; // the fake scp copies, then fails (FAKE_FAIL)
  click(render(self, w), "files-save", w.cx);
  await settle(200);
  assert.equal(w.read("a.txt").toString(), "one\n");
  assert.ok(byId(render(self, w), "files-save"), "still editing");
  assert.equal(lastState(w).value(), "two\n", "buffer kept");
  assert.ok(texts(render(self, w)).some((t) => t.startsWith("Could not copy the text to the machine")));
  assert.deepEqual(fs.readdirSync(path.join(w.base, "app", "filer-pro", "edit")), [], "local staged file removed");
});


test("the mirror file name never leaves the unsaved folder, whatever the remote name", async () => {
  const w = world();
  const self = await panel(w);
  for (const name of ["a\\b:c.txt", ".hidden", "x\ny"]) {
    w.put(name, "one\n");
    await editing(w, self, name);
    const m = self.edit.mirrorPath;
    assert.ok(m.startsWith("/app/filer-pro/unsaved/"), m);
    assert.match(m.slice("/app/filer-pro/unsaved/".length), /^[A-Za-z0-9]+-[A-Za-z0-9_][A-Za-z0-9._-]*\.txt$/, m);
    self.leaveEdit();
  }
});
