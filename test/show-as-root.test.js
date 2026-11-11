// Issue #90: Show as Root, from the folder menu and by a double click on a folder row (main.js stubbed as in bundles-main.test.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { LIST_SCRIPT } from "../mods/filer-pro/lib/tree.js";
import { numbers } from "../mods/filer-pro/lib/settings.js";
import { OPEN_BUNDLE_SCRIPT, OPEN_CHECK_SCRIPT } from "../mods/filer-pro/lib/open.js";
import { rowMenuItems, menuHeight } from "../mods/filer-pro/lib/menuitems.js";

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

test("#90 menu: folders get Show as Root after Show in Finder and before Calculate Size; files and packages do not", () => {
  host({ props: menuFor() });
  const menu = Object.create(FilerPro.prototype);
  const cx = fakeCx();
  const item = byId(menu.overlayView(cx), "filer-pro-menu-show-as-root");
  assert.equal(item.kids.at(-1).kids.at(-1), "Show as Root");
  const on = { paste: { enabled: false } };
  const actions = (s) => rowMenuItems({ ...on, ...s }).map((i) => i.action);
  const folder = actions({ isDir: true });
  assert.equal(folder.indexOf("show_as_root"), folder.indexOf("reveal") + 1);
  assert.equal(folder.indexOf("calculate_size"), folder.indexOf("show_as_root") + 1);
  assert.equal(actions({ isDir: false }).includes("show_as_root"), false, "not on a file");
  const pkg = actions({ isDir: true, bundle: true });
  assert.equal(pkg.includes("show_as_root"), false, "not on a package");
  assert.equal(pkg.includes("package_contents"), true);
  assert.equal(folder.includes("package_contents"), false, "never both");
  assert.equal(actions({ isDir: true, remote: true }).includes("show_as_root"), true, "works on a machine");
  assert.equal(rowMenuItems({ ...on, isDir: true }).find((i) => i.action === "show_as_root").enabled, true);
});

test("#90 menu: Show as Root sets the shared goto request with machine and absolute path and closes the menu", () => {
  for (const machine of [null, "box"]) {
    const { log, store } = host({ props: menuFor(machine ? { machine } : {}) });
    const menu = Object.create(FilerPro.prototype);
    handler(byId(menu.overlayView(fakeCx()), "filer-pro-menu-show-as-root"), "on_click")({}, fakeCx());
    const req = store["filer-pro.goto"];
    assert.deepEqual({ ...req, id: undefined }, { id: undefined, machine, path: `${ROOT}/src` });
    assert.ok(req.id);
    assert.deepEqual(log.closed, ["menu1"]);
  }
});

test("#90 pollGoto: navigates once for the matching machine and a path below the root, ignores seen ids", async () => {
  const { store } = host();
  const cx = fakeCx();
  const self = await loaded(cx);
  self.gotoSeen = null;
  const calls = [];
  self.navigate = (path) => calls.push(path);
  store["filer-pro.goto"] = { id: "g1", machine: null, path: `${ROOT}/src` };
  self.render(cx); self.render(cx);
  await settle();
  assert.deepEqual(calls, [`${ROOT}/src`], "applied once");
  store["filer-pro.goto"] = { id: "g2", machine: "other", path: `${ROOT}/src` };
  self.render(cx);
  store["filer-pro.goto"] = { id: "g3", machine: null, path: "/elsewhere/src" };
  self.render(cx);
  store["filer-pro.goto"] = { id: "g4", machine: null, path: ROOT };
  self.render(cx);
  await settle();
  assert.deepEqual(calls, [`${ROOT}/src`], "other machine, outside the root and the root itself are ignored");
});

test("#90 double click on a folder row: click 1 toggles, click 2 navigates, click 3 does nothing", async () => {
  host();
  const cx = fakeCx();
  const self = await loaded(cx);
  const calls = [];
  self.navigate = (path) => calls.push(path);
  clickRow(self, cx, "src", 1);
  assert.equal(self.folders.has("src"), true, "click 1 opens");
  assert.deepEqual(calls, []);
  clickRow(self, cx, "src", 2);
  assert.deepEqual(calls, [`${ROOT}/src`]);
  clickRow(self, cx, "src", 3);
  assert.deepEqual(calls, [`${ROOT}/src`], "click 3 does nothing");
  assert.equal(self.folders.has("src"), true, "click 3 does not toggle");
});

test("#90 double_click_folders off: a double click toggles twice as before", async () => {
  host();
  const cx = fakeCx();
  const self = await loaded(cx);
  self.cfg = { ...DEFAULTS, double_click_folders: false };
  const calls = [];
  self.navigate = (path) => calls.push(path);
  clickRow(self, cx, "src", 1);
  assert.equal(self.folders.has("src"), true);
  clickRow(self, cx, "src", 2);
  assert.equal(self.folders.has("src"), false);
  assert.deepEqual(calls, []);
});

test("#90 double click: packages and files are not shown as root, Cmd+click still reveals", async () => {
  const { log } = host();
  const cx = fakeCx();
  const self = await loaded(cx);
  const calls = [];
  self.navigate = (path) => calls.push(path);
  clickRow(self, cx, "Example.app", 1); clickRow(self, cx, "Example.app", 2);
  clickRow(self, cx, "a.txt", 1); self.show(null); clickRow(self, cx, "a.txt", 2); self.show(null);
  assert.deepEqual(calls, []);
  self.show(null);
  log.execs.length = 0;
  clickRow(self, cx, "src", 2, { platform: true });
  assert.deepEqual(calls, [], "Cmd+click is Show in Finder");
});
