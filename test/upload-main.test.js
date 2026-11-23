// Issue #27 (Upload File…, derived from editor-menu-main.test.js): the editor name in both right-click menus through the real panel (mods/filer-pro/main.js) with stub
// builders and a fake host: the props the panel hands to the popup, the popup drawn from them (label, truncate, dimming),
// and the click that opens the shown root or the file in the configured editor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

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
const make = (names) => names.map((n) => `export const ${n} = () => globalThis.__make("${n}");`).join("\n");
const STUBS = {
  herdr: stub(["spaces", "panes", "focused", "exec", "hc", "readTextFile", "writeTextFile", "watchFolder", "theme", "settings", "window", "shared", "setShared", "notify", "props", "appHome", "home", "nextCommand", "openOverlay", "closeOverlay", "pickFolder", "pickFiles", "run", "layout"]),
  "gpui-kit": `export class View {}; ${make(["div", "svg", "image"])}`,
  "gpui-base": `${make(["v_flex", "h_flex", "v_resizable", "resizable_panel", "Input", "TextView"])} export class Editor { static new() { return globalThis.__make("editor"); } } export class EditorState {} export class InputState {} export const Scrollbar = { vertical: () => globalThis.__make("scrollbar") };`,
  "fs/promises": `${stub(["exists"])} export const readFile = async () => "", writeFile = readFile, mkdir = readFile, unlink = readFile, stat = readFile;`,
};
const hooks = `export async function resolve(s, c, next) { return s in ${JSON.stringify(STUBS)} ? { url: "stub:" + s, shortCircuit: true } : next(s, c); }
export async function load(u, c, next) { return u.startsWith("stub:") ? { format: "module", shortCircuit: true, source: ${JSON.stringify(STUBS)}[u.slice(5)] } : next(u, c); }`;
register("data:text/javascript," + encodeURIComponent(hooks));
const FilerPro = (await import("../mods/filer-pro/main.js")).default;
const { numbers } = await import("../mods/filer-pro/lib/settings.js");
const { SIZE_SCRIPT, sizeKey } = await import("../mods/filer-pro/lib/sizes.js");

const DISK = { "/r": ["a.md:3200"] };
const host = { requests: [], picks: [], pick: null, shared: {}, notes: [], overlays: [], overlay: null, closed: 0, execs: [], hcs: [], config: null, execFail: null };
globalThis.__impl = {
  pickFiles: async (o) => { host.picks.push(o); return host.pick; },
  props: () => host.overlay ?? {}, shared: (k) => host.shared[k], setShared: (k, v) => { host.shared[k] = v; }, settings: () => ({ dark: false, font_family: "mono" }),
  theme: () => new Proxy({}, { get: (_t, k) => String(k) }), window: () => ({ platform: "macos" }), home: () => "/home/u", appHome: () => "/app",
  spaces: () => [{ active: true, id: "s1", folder: "/r", machine: null }],
  panes: () => [{ pane: "p1", cwd: "/r", terminal: "t-p1" }],
  focused: () => ({ space: "s1", pane: "p1", terminal: "t-p1", cwd: null }),
  notify: (n) => host.notes.push(n), readTextFile: async (path) => (path === "/app/filer-pro.json" ? host.config : null), closeOverlay: () => { host.closed++; },
  openOverlay: (o) => { host.overlays.push(o); return "ov"; },
  watchFolder: () => new Promise(() => {}),
  hc: async (args) => { host.hcs.push(args); return { code: 0, stdout: JSON.stringify({ machines: [{ name: "box", target: "me@box" }] }), stderr: "" }; },
  exec: async (cmd, args, opts = {}) => {
    if (cmd === "sh" && args[2] === "files") {
      const list = DISK[args[3]];
      if (!list) return { code: 1, stdout: "", stderr: "" };
      const pairs = list.map((n) => `f\0${n.split(":")[0]}\0`).join("");
      return { code: 0, stdout: pairs, stderr: "" };
    }
    host.execs.push([cmd, args, opts]);
    if (host.execFail) throw host.execFail;
    return { code: 0, stdout: "", stderr: "" };
  },
};

const cx = { notify() {}, sleep: async () => {}, spawn: (fn) => { const p = Promise.resolve().then(() => fn(cx)); p.catch(() => {}); return p; }, stop_propagation() {} };
const settle = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); };
const CFG = { ...numbers(null), hide_system_files: true, hide_dotfiles: false, show_sizes: false };

async function panel(cfg = {}) {
  Object.assign(host, { config: null, shared: {}, notes: [], overlays: [], overlay: null, closed: 0, execs: [], hcs: [], execFail: null });
  const self = Object.create(FilerPro.prototype);
  Object.assign(self, { cfg: { ...CFG, ...cfg }, context: null, saved: new Map(), nav: new Map(), reload: { signal: () => false, take: () => false }, jobs: {}, perf: null, entries: new Map(), folders: new Set(), pending: new Set(), marks: {} });
  self.refresh(cx);
  await settle();
  return self;
}
// The popup, drawn by a second copy of the mod from props.
function popup(props) {
  host.overlay = { overlay: "ov", view: "menu", machine: null, root: "/r", path: "/r/a.md", isDir: false, folder: "/r", ...props };
  const view = Object.create(FilerPro.prototype).render(cx);
  host.overlay = null;
  return view;
}
const rootPopup = (props = {}) => popup({ scope: "root", path: undefined, isDir: undefined, ...props });

const idOf = (el) => el.calls.find((c) => c[0] === "id")?.[1];
function findId(el, id) {
  if (!el || typeof el !== "object" || !el.calls) return null;
  if (idOf(el) === id) return el;
  for (const k of el.kids) { const hit = findId(k, id); if (hit) return hit; }
  return null;
}
const called = (el, name) => el.calls.filter((c) => c[0] === name).map((c) => c.slice(1));
const textOf = (el) => (typeof el === "string" ? el : (el?.kids ?? []).map(textOf).join(""));
const ED = "filer-pro-menu-open-editor";

FilerPro.prototype.request = async function (r) { host.requests.push(r); };
const rightClick = (el) => called(el, "on_mouse_down").find(([b]) => b === "right")[1]({}, cx);
const { menuHeight, rootMenuItems, rowMenuItems, rowMenuState } = await import("../mods/filer-pro/lib/menuitems.js");
const { dropRequest } = await import("../mods/filer-pro/lib/droptarget.js");
const UP = "filer-pro-menu-upload";
const click = async (view) => { called(findId(view, UP), "on_click")[0][0]({}, cx); await settle(); };
const fresh = () => { host.requests = []; host.picks = []; host.closed = 0; host.pick = null; };

test("the row and free-area menus offer Upload File… and are one entry taller", async () => {
  fresh();
  const self = await panel();
  rightClick(findId(self.render(cx), "file-a.md"));
  const row = host.overlays.at(-1);
  const state = { paste: { enabled: false }, ...rowMenuState({ name: "a.md", isDir: false }) };
  assert.equal(row.height, menuHeight(rowMenuItems({ ...state, upload: true })));
  assert.equal(row.height - menuHeight(rowMenuItems(state)), 28);
  rightClick(findId(self.render(cx), "files-tree"));
  assert.equal(host.overlays.at(-1).height, menuHeight(rootMenuItems({ paste: { enabled: false }, upload: true })));
  assert.equal(host.overlays.at(-1).height, 166 + 28);
  assert.ok(findId(popup({}), UP));
  assert.ok(findId(rootPopup(), UP));
});

test("pick sends exactly the drop request: file row, folder row, free area, machine tree", async () => {
  const paths = ["/Users/m/a.txt", "/Users/m/b.txt"];
  const cases = [
    [{ path: "/r/in/a.md", isDir: false, folder: "/r/in", root: "/r" }, { on: null, root: "/r", rowPath: "in/a.md", rowIsDir: false }],
    [{ path: "/r/in", isDir: true, folder: "/r/in", root: "/r" }, { on: null, root: "/r", rowPath: "in", rowIsDir: true }],
    [{ scope: "root", path: undefined, isDir: undefined, folder: "/r", root: "/r" }, { on: null, root: "/r", rowPath: null, rowIsDir: false }],
    [{ machine: "box", path: "/srv/x.md", isDir: false, folder: "/srv", root: "/srv" }, { on: "box", root: "/srv", rowPath: "x.md", rowIsDir: false }],
    [{ tree: "pinned", root: "/Users/e/Down", path: "/Users/e/Down/s", isDir: true, folder: "/Users/e/Down/s" }, { on: null, root: "/Users/e/Down", rowPath: "s", rowIsDir: true }],
  ];
  for (const [props, drop] of cases) {
    fresh(); host.pick = paths;
    await click(popup(props));
    assert.deepEqual(host.picks, [{ prompt: "Upload", multiple: true }]);
    assert.deepEqual(host.requests, [dropRequest({ ...drop, paths })]);
    assert.equal(host.closed, 1);
  }
});

test("cancel (null or empty) sends nothing, shows no toast and closes the menu", async () => {
  for (const pick of [null, []]) {
    fresh(); host.pick = pick; host.notes = [];
    await click(popup({}));
    assert.deepEqual(host.requests, []);
    assert.deepEqual(host.notes, []);
    assert.equal(host.closed, 1);
  }
});

test("several selected rows: no Upload File… entry", () => {
  assert.equal(rowMenuItems({ ...rowMenuState({ name: "a", count: 3 }), paste: { enabled: false }, upload: true }).some((i) => i.action === "upload"), false);
});
