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
