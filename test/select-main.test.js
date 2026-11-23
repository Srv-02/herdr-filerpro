// Issue #98: selecting several rows (main.js stubbed as in show-as-root.test.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { LIST_SCRIPT } from "../mods/filer-pro/lib/tree.js";
import { numbers } from "../mods/filer-pro/lib/settings.js";
import { OPEN_BUNDLE_SCRIPT, OPEN_CHECK_SCRIPT } from "../mods/filer-pro/lib/open.js";
import { rowMenuItems, rootMenuItems, menuHeight } from "../mods/filer-pro/lib/menuitems.js";

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
  "gpui-base": `${make(["v_flex", "h_flex", "TextView"])} export const Input = { new: () => globalThis.__make("input") }, Scrollbar = { vertical: () => globalThis.__make("scrollbar") };
export class Editor { static new() { return globalThis.__make("editor"); } } export class EditorState { static new() { return { release() {} }; } } export class InputState {}`,
  "fs/promises": `${stub(["exists"])} export const readFile = async () => "", writeFile = async (...a) => globalThis.__impl.writeFile(...a), mkdir = readFile, unlink = readFile, stat = readFile;`,
};
const hooks = `export async function resolve(s, c, next) { return s in ${JSON.stringify(STUBS)} ? { url: "stub:" + s, shortCircuit: true } : next(s, c); }
export async function load(u, c, next) { return u.startsWith("stub:") ? { format: "module", shortCircuit: true, source: ${JSON.stringify(STUBS)}[u.slice(5)] } : next(u, c); }`;
register("data:text/javascript," + encodeURIComponent(hooks));
const FilerPro = (await import("../mods/filer-pro/main.js")).default;

const never = () => new Promise(() => {});
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const DEFAULTS = { ...numbers(null), node_path: "", svg_check: true, double_click_files: false, double_click_apps: true, double_click_folders: true };
const ROOT = "/Users/example/Downloads";
const LISTING = ["d", "Example.app", "d", "Tool.xcodeproj", "d", "Setup.PKG", "d", "src", "f", "a.txt"].join("\0") + "\0";

// A fake host: one local (or remote) space at ROOT; shared values in `store`, every call logged.
function host({ platform = "macos", machine = null, props = {}, listing = LISTING, store = {} } = {}) {
  const log = { execs: [], shared: [], overlays: [], closed: [], notes: [], writes: [], reads: [] };
  globalThis.__impl = {
    props: () => props, appHome: () => "/app", home: () => "/Users/example", window: () => ({ platform }),
    theme: () => new Proxy({}, { get: (_t, k) => String(k) }), settings: () => ({ dark: true, font_family: "mono" }),
    spaces: () => [{ active: true, id: "s1", folder: ROOT, machine }], panes: () => [], focused: () => ({}),
    shared: (k) => store[k], setShared: (k, v) => { store[k] = v; log.shared.push([k, v]); },
    readTextFile: async (p) => { log.reads.push(p); return null; }, writeFile: async (p, text) => { log.writes.push({ p, text }); },
    exec: async (cmd, args, opts) => {
      log.execs.push({ cmd, args, opts });
      if (cmd === "sh" && args[1] === LIST_SCRIPT) return { code: 0, stdout: args[3] === ROOT ? listing : "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    hc: async () => ({ code: 0, stdout: "{}", stderr: "" }),
    openOverlay: (o) => { log.overlays.push(o); return "ov1"; }, closeOverlay: (id) => log.closed.push(id),
    notify: (n) => log.notes.push(n), watchFolder: never, nextCommand: never, layout: () => ({}), exists: async () => false,
  };
  return { log, store };
}
function fakeCx() {
  const cx = { notify() {}, sleep: never, stop_propagation() {}, spawn: (fn) => { const p = Promise.resolve().then(() => fn(cx)); p.catch(() => {}); return p; } };
  return cx;
}
// A panel copy that has loaded ROOT through main.js's own listing.
async function loaded(cx) {
  const self = Object.assign(Object.create(FilerPro.prototype), { cfg: DEFAULTS, saved: new Map(), reload: { signal: () => false, take: () => false }, jobs: {}, perf: null });
  self.refresh(cx);
  await settle();
  return self;
}

function* walk(e) {
  if (!e || typeof e !== "object") return;
  yield e;
  for (const k of e.kids ?? []) yield* walk(k);
}
const idOf = (el) => el.calls?.find((c) => c[0] === "id")?.[1];
const byId = (root, id) => [...walk(root)].find((e) => idOf(e) === id);
const handler = (el, name, ...first) => el.calls.find(([k, ...a]) => k === name && first.every((f, i) => a[i] === f)).at(-1);
const rowNames = (root) => [...walk(root)].map(idOf).filter((id) => String(id ?? "").startsWith("file-")).map((id) => id.slice(5));
const chevron = (row) => row.kids.find((k) => k.kind === "svg" && String(k.args?.[0]).includes("chevron"));
const iconOf = (row) => row.kids.find((k) => k.kind === "image")?.args[0];
const execsOf = (log, script) => log.execs.filter((e) => e.cmd === "sh" && e.args[1] === script);

const menuFor = (extra) => ({ overlay: "menu1", view: "menu", root: ROOT, path: `${ROOT}/src`, isDir: true, folder: `${ROOT}/src`, ...extra });
const clickRow = (self, cx, name, n, modifiers = {}) => handler(byId(self.render(cx), `file-${name}`), "on_click")({ modifiers, click_count: n }, cx);


test("#98 menu: Select Files sets the shared select request for a row and closes the menu", () => {
  for (const machine of [null, "box"]) {
    const { log, store } = host({ props: menuFor(machine ? { machine } : {}) });
    const menu = Object.create(FilerPro.prototype);
    handler(byId(menu.overlayView(fakeCx()), "filer-pro-menu-select-files"), "on_click")({}, fakeCx());
    const req = store["filer-pro.select"];
    assert.deepEqual({ ...req, id: undefined }, { id: undefined, mode: "start", machine, root: ROOT, path: `${ROOT}/src` });
    assert.ok(req.id);
    assert.deepEqual(log.closed, ["menu1"]);
  }
});

test("#98 menu: the free area menu starts the mode without a row", () => {
  const { log, store } = host({ props: { overlay: "menu1", view: "menu", scope: "root", root: ROOT, folder: ROOT } });
  const menu = Object.create(FilerPro.prototype);
  handler(byId(menu.overlayView(fakeCx()), "filer-pro-menu-select-files"), "on_click")({}, fakeCx());
  assert.deepEqual({ ...store["filer-pro.select"], id: undefined }, { id: undefined, mode: "start", machine: null, root: ROOT, path: null });
  assert.deepEqual(log.closed, ["menu1"]);
});

test("#98 menu: no Select Files entry in the popup while the mode is on", () => {
  host({ props: menuFor({ selecting: true }) });
  assert.equal(byId(Object.create(FilerPro.prototype).overlayView(fakeCx()), "filer-pro-menu-select-files"), undefined);
  host({ props: menuFor({}) });
  assert.ok(byId(Object.create(FilerPro.prototype).overlayView(fakeCx()), "filer-pro-menu-select-files"));
});

test("#98 right click: both popups carry selecting and are sized from it", async () => {
  const { log } = host();
  const cx = fakeCx();
  const self = await loaded(cx);
  const rightRow = () => handler(byId(self.render(cx), "file-src"), "on_mouse_down", "right")({}, cx);
  const rightFree = () => handler(byId(self.render(cx), "files-tree"), "on_mouse_down", "right")({}, cx);
  for (const selecting of [undefined, true]) {
    self.selecting = selecting;
    rightRow();
    const row = log.overlays.at(-1);
    assert.equal(row.props.selecting, selecting === true);
    assert.equal(row.height, menuHeight(rowMenuItems({ paste: { enabled: false }, isDir: true, selecting: selecting === true })));
    rightFree();
    const free = log.overlays.at(-1);
    assert.equal(free.props.selecting, selecting === true);
    assert.equal(free.height, menuHeight(rootMenuItems({ paste: { enabled: false }, selecting: selecting === true })));
  }
});

// ---- Task 7: panel state and click wiring ----
const LIST3 = ["f", "a.txt", "f", "b.txt", "f", "c.txt", "d", "src"].join("\0") + "\0";
const CMD = { platform: true }, SHIFT = { shift: true }, CMD_ALT = { platform: true, alt: true };
async function multi(opts = {}, cfg = {}) {
  const h = host({ listing: LIST3, ...opts });
  const cx = fakeCx();
  const self = await loaded(cx);
  self.cfg = { ...DEFAULTS, multi_select: true, select_toggle_click: "cmd", select_range_click: "shift", ...cfg };
  self.selected = new Set(); self.anchor = null; self.base = null; self.selecting = false;
  return { ...h, cx, self };
}
const names = (set) => [...set].sort();
const revealExecs = (log) => log.execs.filter((e) => e.cmd !== "sh" && e.cmd !== "git");

test("#98 clicks: with multi_select off Cmd+click reveals and selects nothing", async () => {
  const { self, cx, log } = await multi({}, { multi_select: false });
  const before = revealExecs(log).length;
  clickRow(self, cx, "a.txt", 1, CMD);
  assert.equal(revealExecs(log).length, before + 1);
  assert.equal(self.selected.size, 0);
});

test("#98 clicks: Cmd+click toggles a file and a folder, no reveal, no expand, no file shown", async () => {
  const { self, cx, log } = await multi();
  const before = revealExecs(log).length;
  clickRow(self, cx, "a.txt", 1, CMD);
  assert.deepEqual(names(self.selected), ["a.txt"]);
  assert.equal(self.anchor, "a.txt");
  clickRow(self, cx, "src", 1, CMD);
  assert.deepEqual(names(self.selected), ["a.txt", "src"]);
  assert.ok(!self.folders.has("src"));
  assert.equal(revealExecs(log).length, before);
  assert.ok(!self.file);
});

test("#98 clicks: Shift+click selects a range, moves its end, and toggles without an anchor", async () => {
  const { self, cx } = await multi();
  clickRow(self, cx, "b.txt", 1, SHIFT);
  assert.deepEqual(names(self.selected), ["b.txt"]);
  assert.equal(self.anchor, "b.txt");
  self.setSelection({ selected: new Set(["a.txt"]), anchor: "a.txt", base: new Set(["a.txt"]) });
  clickRow(self, cx, "c.txt", 1, SHIFT);
  assert.deepEqual(names(self.selected), ["a.txt", "b.txt", "c.txt"]);
  clickRow(self, cx, "b.txt", 1, SHIFT);
  assert.deepEqual(names(self.selected), ["a.txt", "b.txt"]);
});

test("#98 clicks: Option+Cmd+click reveals while multi is on; on a machine it writes a reveal request", async () => {
  const local = await multi();
  const n = revealExecs(local.log).length;
  clickRow(local.self, local.cx, "a.txt", 1, CMD_ALT);
  assert.equal(revealExecs(local.log).length, n + 1);
  assert.equal(local.self.selected.size, 0);
  const remote = await multi({ machine: "box" });
  clickRow(remote.self, remote.cx, "a.txt", 1, CMD_ALT);
  await settle();
  assert.ok(remote.log.writes.some((w) => String(w.text).includes('"reveal":true')));
});

test("#98 clicks: a plain click with a selection clears it and acts as before", async () => {
  const { self, cx } = await multi();
  self.setSelection({ selected: new Set(["b.txt"]), anchor: "b.txt", base: new Set(["b.txt"]) });
  clickRow(self, cx, "src", 1);
  assert.equal(self.selected.size, 0);
  assert.equal(self.anchor, null);
  assert.ok(self.folders.has("src"));
});

test("#98 clicks: a plain click or the free area clears a lone anchor, so the next Shift+click starts fresh", async () => {
  const { self, cx } = await multi();
  const lone = () => { clickRow(self, cx, "a.txt", 1, CMD); clickRow(self, cx, "a.txt", 1, CMD); assert.equal(self.selected.size, 0); assert.equal(self.anchor, "a.txt"); };
  lone();
  clickRow(self, cx, "src", 1); // a folder, so no file view hides the rows
  assert.equal(self.anchor, null);
  clickRow(self, cx, "c.txt", 1, SHIFT);
  assert.deepEqual(names(self.selected), ["c.txt"]);
  self.clearSelected();
  lone();
  handler(byId(self.render(cx), "files-tree"), "on_click")({}, cx);
  assert.equal(self.anchor, null);
});

test("#98 clicks: the row stops propagation; the free area clears outside the mode only", async () => {
  const { self, cx } = await multi();
  let stopped = 0;
  const spy = { ...cx, stop_propagation: () => stopped++ };
  handler(byId(self.render(cx), "file-a.txt"), "on_click")({ modifiers: {}, click_count: 1 }, spy);
  assert.equal(stopped, 1);
  self.setSelection({ selected: new Set(["a.txt"]), anchor: "a.txt", base: new Set(["a.txt"]) });
  self.selecting = true;
  handler(byId(self.render(cx), "files-tree"), "on_click")({}, cx);
  assert.equal(self.selected.size, 1);
  self.selecting = false;
  handler(byId(self.render(cx), "files-tree"), "on_click")({}, cx);
  assert.equal(self.selected.size, 0);
  assert.equal(self.anchor, null);
});

test("#98 right click: an unselected row clears outside the mode, keeps inside, a selected row keeps", async () => {
  const { self, cx } = await multi();
  const right = (name) => handler(byId(self.render(cx), `file-${name}`), "on_mouse_down", "right")({}, cx);
  self.setSelection({ selected: new Set(["a.txt"]), anchor: "a.txt", base: new Set(["a.txt"]) });
  right("a.txt");
  assert.equal(self.selected.size, 1);
  right("b.txt");
  assert.equal(self.selected.size, 0);
  self.setSelection({ selected: new Set(["a.txt"]), anchor: "a.txt", base: new Set(["a.txt"]) });
  self.selecting = true;
  right("b.txt");
  assert.equal(self.selected.size, 1);
});

test("#98 pollSelect: start adds the row and turns the mode on, once per id", async () => {
  const { self, cx, store } = await multi();
  self.selectSeen = null;
  self.setSelection({ selected: new Set(["b.txt"]), anchor: "b.txt", base: new Set(["b.txt"]) });
  store["filer-pro.select"] = { id: "s1", mode: "start", machine: null, root: ROOT, path: `${ROOT}/a.txt` };
  self.pollSelect(cx);
  await settle();
  assert.equal(self.selecting, true);
  assert.deepEqual(names(self.selected), ["a.txt", "b.txt"]);
  assert.equal(self.anchor, "a.txt");
  self.setSelection({ selected: new Set(), anchor: null, base: null });
  self.pollSelect(cx);
  await settle();
  assert.equal(self.selected.size, 0);
});

test("#98 pollSelect: other machine or root ignored; no path keeps the selection; clear keeps the mode", async () => {
  const { self, cx, store } = await multi();
  self.selectSeen = null;
  const send = async (r) => { store["filer-pro.select"] = r; self.pollSelect(cx); await settle(); };
  await send({ id: "s1", mode: "start", machine: "other", root: ROOT, path: `${ROOT}/a.txt` });
  await send({ id: "s2", mode: "start", machine: null, root: "/elsewhere", path: "/elsewhere/a.txt" });
  assert.equal(self.selecting, false);
  assert.equal(self.selected.size, 0);
  self.setSelection({ selected: new Set(["b.txt"]), anchor: "b.txt", base: new Set(["b.txt"]) });
  await send({ id: "s3", mode: "start", machine: null, root: ROOT, path: null });
  assert.equal(self.selecting, true);
  assert.deepEqual(names(self.selected), ["b.txt"]);
  assert.equal(self.anchor, null);
  await send({ id: "s4", mode: "clear", machine: null, root: ROOT });
  assert.equal(self.selected.size, 0);
  assert.equal(self.selecting, true);
});

test("#98 checkbox mode: a plain click toggles, the chevron expands, a double click toggles once", async () => {
  const { self, cx } = await multi({}, { multi_select: false });
  self.selecting = true;
  clickRow(self, cx, "src", 1);
  assert.deepEqual(names(self.selected), ["src"]);
  assert.ok(!self.folders.has("src"));
  const chev = byId(self.render(cx), "chevron-src");
  let stopped = 0;
  handler(chev, "on_click")({ click_count: 2 }, { ...cx, stop_propagation: () => stopped++ });
  assert.ok(!self.folders.has("src"));
  handler(chev, "on_click")({ click_count: 1 }, { ...cx, stop_propagation: () => stopped++ });
  assert.ok(self.folders.has("src"));
  assert.equal(stopped, 2);
  assert.deepEqual(names(self.selected), ["src"]);
  clickRow(self, cx, "a.txt", 1);
  clickRow(self, cx, "a.txt", 2);
  assert.deepEqual(names(self.selected), ["a.txt", "src"]);
});

test("#98 prune: collapsing a folder drops the rows below it from the selection and the anchor", async () => {
  const { self, cx } = await multi();
  const base = globalThis.__impl.exec;
  globalThis.__impl.exec = async (c, a, o) => (c === "sh" && a[1] === LIST_SCRIPT && a[3] === `${ROOT}/src` ? { code: 0, stdout: "f\0x.js\0", stderr: "" } : base(c, a, o));
  clickRow(self, cx, "src", 1);
  await settle();
  clickRow(self, cx, "src/x.js", 1, CMD);
  assert.deepEqual(names(self.selected), ["src/x.js"]);
  clickRow(self, cx, "src", 1);
  assert.equal(self.selected.size, 0);
  assert.equal(self.anchor, null);
});

test("#98 prune: a reload drops a row that is gone, and the count follows", async () => {
  const { self, cx } = await multi();
  self.setSelection({ selected: new Set(["a.txt", "b.txt"]), anchor: "b.txt", base: new Set(["a.txt", "b.txt"]) });
  const base = globalThis.__impl.exec;
  globalThis.__impl.exec = async (c, a, o) => (c === "sh" && a[1] === LIST_SCRIPT && a[3] === ROOT ? { code: 0, stdout: ["f", "a.txt", "f", "c.txt"].join("\0") + "\0", stderr: "" } : base(c, a, o));
  self.refresh(cx);
  await settle();
  assert.deepEqual(names(self.selected), ["a.txt"]);
  assert.equal(self.anchor, null);
});

test("#98 context: the selection is saved and restored, the anchor is not; navigate carries it", async () => {
  const { self, cx } = await multi();
  self.setSelection({ selected: new Set(["b.txt"]), anchor: "b.txt", base: new Set(["b.txt"]) });
  self.selecting = true;
  const spaces = globalThis.__impl.spaces;
  globalThis.__impl.spaces = () => [{ active: true, id: "s2", folder: "/Users/example/Other", machine: null }];
  self.refresh(cx);
  await settle();
  assert.equal(self.selected.size, 0);
  assert.equal(self.selecting, false);
  globalThis.__impl.spaces = spaces;
  self.refresh(cx);
  await settle();
  assert.deepEqual(names(self.selected), ["b.txt"]);
  assert.equal(self.selecting, true);
  assert.equal(self.anchor, null);
  globalThis.__impl.focused = () => ({ pane: "p1" });
  globalThis.__impl.panes = () => [{ pane: "p1", cwd: ROOT }];
  self.refresh(cx);
  await settle();
  self.setSelection({ selected: new Set(["b.txt"]), anchor: "b.txt", base: new Set(["b.txt"]) });
  self.navigate("/Users/example", cx);
  await settle();
  assert.deepEqual(names(self.selected), ["Downloads/b.txt"]);
  assert.equal(self.anchor, null);
  assert.equal(self.selecting, true);
});

const callsOf = (el, k) => el.calls.filter(([n]) => n === k).map((c) => c.slice(1));

test("#98 look: a selected row is marked; the last opened row only while nothing is selected and the mode is off", async () => {
  const { self, cx } = await multi();
  self.lastOpened = "a.txt";
  assert.deepEqual(callsOf(byId(self.render(cx), "file-a.txt"), "bg"), [["selected"]]);
  clickRow(self, cx, "src", 1, CMD);
  const root = self.render(cx);
  assert.deepEqual(callsOf(byId(root, "file-src"), "bg"), [["selected"]]);
  assert.deepEqual(callsOf(byId(root, "file-a.txt"), "bg"), [], "the last opened mark gives way to the selection");
  self.clearSelected();
  self.selecting = true;
  assert.deepEqual(callsOf(byId(self.render(cx), "file-a.txt"), "bg"), [], "no mark in the mode");
});

test("#98 look: checkbox mode puts a 16 px box first, a fixed pl and an indent spacer", async () => {
  const { self, cx } = await multi({}, { multi_select: false });
  self.selecting = true;
  clickRow(self, cx, "src", 1);
  self.folders.add("src");
  self.entries.set("src", [{ name: "b.txt", dir: false }]);
  const root = self.render(cx);
  const src = byId(root, "file-src"), a = byId(root, "file-a.txt");
  for (const row of [src, a]) {
    assert.deepEqual(callsOf(row.kids[0], "w"), [[16]]);
    assert.deepEqual(callsOf(row.kids[0], "h"), [[16]]);
    assert.deepEqual(callsOf(row, "pl"), [[8]]);
    assert.deepEqual(callsOf(row, "role"), [["check_box"]]);
  }
  assert.deepEqual(callsOf(src.kids[0], "bg"), [["accent"]], "checked");
  assert.deepEqual(callsOf(a.kids[0], "bg"), [["background"]], "unchecked");
  assert.match(callsOf(src, "accessibility_label")[0][0], /, checked$/);
  assert.match(callsOf(a, "accessibility_label")[0][0], /, not checked$/);
  const sub = byId(root, "file-src/b.txt");
  assert.deepEqual(callsOf(sub, "pl"), [[8]]);
  assert.deepEqual(callsOf(sub.kids[1], "w"), [[18]]);
});

test("#98 bar: hidden without a selection, counts and clears with one, Done ends the mode", async () => {
  const { self, cx } = await multi();
  const ids = (root) => [...walk(root)].map(idOf);
  assert.ok(!ids(self.render(cx)).includes("files-selection"));
  clickRow(self, cx, "a.txt", 1, CMD);
  clickRow(self, cx, "src", 1, CMD);
  const root = self.render(cx);
  assert.deepEqual(byId(root, "files-selection-count").kids, ["2 selected"]);
  assert.ok(!byId(root, "files-selection-done"));
  handler(byId(root, "files-selection-clear"), "on_click")({}, cx);
  assert.equal(self.selected.size, 0);
  assert.ok(!ids(self.render(cx)).includes("files-selection"));
  self.selecting = true;
  const mode = self.render(cx);
  assert.deepEqual(byId(mode, "files-selection-count").kids, ["0 selected"]);
  assert.ok(!byId(mode, "files-selection-clear"));
  handler(byId(mode, "files-selection-done"), "on_click")({}, cx);
  assert.equal(self.selecting, false);
  assert.equal(self.selected.size, 0);
  assert.ok(!ids(self.render(cx)).includes("files-selection"));
});

test("#98 bar: not while a file is open; before the transfers bar otherwise", async () => {
  const { self, cx } = await multi({ store: { "filer-pro.jobs": [{ id: "j1", kind: "copy", name: "x", state: "running", direction: "local", bytes: 1, total: 2, rate: 1, percent: 50 }] } });
  clickRow(self, cx, "a.txt", 1, CMD);
  const order = self.render(cx).kids.map(idOf);
  assert.equal(order.indexOf("files-selection") + 1, order.indexOf("transfers"));
  assert.ok(order.indexOf("files-selection") > order.indexOf("files-tree"));
  self.file = "a.txt";
  assert.ok(![...walk(self.render(cx))].map(idOf).includes("files-selection"));
});
