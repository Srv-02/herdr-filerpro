// Issue #75: the editor name in both right-click menus through the real panel (mods/filer-pro/main.js) with stub
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
  herdr: stub(["spaces", "panes", "focused", "exec", "hc", "readTextFile", "writeTextFile", "watchFolder", "theme", "settings", "window", "shared", "setShared", "notify", "props", "appHome", "home", "nextCommand", "openOverlay", "closeOverlay", "pickFolder", "run", "layout"]),
  "gpui-kit": `export class View {}; ${make(["div", "svg", "image"])}`,
  "gpui-base": `${make(["v_flex", "h_flex", "Input", "TextView"])} export class Editor { static new() { return globalThis.__make("editor"); } } export class EditorState {} export class InputState {} export const Scrollbar = { vertical: () => globalThis.__make("scrollbar") };`,
  "fs/promises": `${stub(["exists"])} export const readFile = async () => "", writeFile = readFile, mkdir = readFile, unlink = readFile, stat = readFile;`,
};
const hooks = `export async function resolve(s, c, next) { return s in ${JSON.stringify(STUBS)} ? { url: "stub:" + s, shortCircuit: true } : next(s, c); }
export async function load(u, c, next) { return u.startsWith("stub:") ? { format: "module", shortCircuit: true, source: ${JSON.stringify(STUBS)}[u.slice(5)] } : next(u, c); }`;
register("data:text/javascript," + encodeURIComponent(hooks));
const FilerPro = (await import("../mods/filer-pro/main.js")).default;
const { numbers } = await import("../mods/filer-pro/lib/settings.js");
const { SIZE_SCRIPT, sizeKey } = await import("../mods/filer-pro/lib/sizes.js");

const DISK = { "/r": ["a.md:3200"] };
const host = { shared: {}, notes: [], overlays: [], overlay: null, closed: 0, execs: [], hcs: [], config: null, execFail: null };
globalThis.__impl = {
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
const rightClick = (el) => called(el, "on_mouse_down").find(([b]) => b === "right")[1]({}, cx);
const { menuHeight, rootMenuItems } = await import("../mods/filer-pro/lib/menuitems.js");

test("the row's right click passes the configured editor to the popup, and the next one follows a config change", async () => {
  const self = await panel({ gui_editor: "Zed" });
  rightClick(findId(self.render(cx), "file-a.md"));
  assert.deepEqual(host.overlays.at(-1).props.editor, { name: "Zed", remote: true, remoteFolder: true });
  self.cfg = { ...self.cfg, gui_editor: "Cursor" };
  rightClick(findId(self.render(cx), "file-a.md"));
  assert.deepEqual(host.overlays.at(-1).props.editor, { name: "Cursor", remote: true, remoteFolder: true });
});

test("the free-area right click passes the editor and sizes the popup for five rows", async () => {
  const self = await panel();
  rightClick(findId(self.render(cx), "files-tree"));
  const o = host.overlays.at(-1);
  assert.equal(o.props.scope, "root");
  assert.equal(o.props.root, "/r");
  assert.deepEqual(o.props.editor, { name: "VS Code", remote: true, remoteFolder: true });
  assert.equal(o.height, menuHeight(rootMenuItems({ paste: { enabled: false } })));
  assert.equal(o.height, 138);
});

test("the popup draws Open in <name> from its props, cut by truncate", () => {
  const editor = { name: "Sublime Text Development Build", remote: false, remoteFolder: false };
  const el = findId(popup({ editor }), ED);
  assert.equal(textOf(el), "Open in Sublime Text Development Build");
  assert.equal(called(el, "on_click").length, 1, "clickable locally");
  const label = el.kids[0];
  assert.equal(called(label, "truncate").length, 1);
  assert.deepEqual(called(label, "min_w"), [[0]]);
  assert.equal(textOf(findId(popup({}), ED)), "Open in VS Code", "no editor in the props: the default");
});

test("every menu label is wrapped in truncate, with and without detail", () => {
  const view = popup({ isDir: true, path: "/r/src", editor: { name: "VS Code", remote: true, remoteFolder: true } });
  const open = findId(view, "filer-pro-menu-open");
  assert.equal(called(open.kids[0], "truncate").length, 1, "Open (a dimmed entry for a folder)");
  const editor = findId(view, ED);
  assert.equal(called(editor.kids[0], "truncate").length, 1, "dimmed for a folder");
  const calc = findId(view, "filer-pro-menu-calculate-size");
  assert.equal(called(calc.kids[0], "truncate").length, 1);
  const file = popup({ editor: { name: "VS Code", remote: true, remoteFolder: true } });
  assert.equal(called(findId(file, "filer-pro-menu-open").kids[0], "truncate").length, 1, "an enabled entry without detail");
});

test("free area, local: Open in <editor> opens the shown root as a folder and closes the popup", async () => {
  for (const root of ["/r", "/"]) {
    host.execs = []; host.hcs = []; host.closed = 0; host.config = null;
    called(findId(rootPopup({ root, folder: root }), ED), "on_click")[0][0]({}, cx);
    await settle();
    assert.deepEqual(host.execs, [["code", [root], { on: null }]]);
    assert.equal(host.closed, 1);
    assert.deepEqual(host.hcs, []);
  }
});

test("free area, machine: the remote_folder template with the SSH target", async () => {
  host.execs = []; host.hcs = []; host.config = null;
  called(findId(rootPopup({ machine: "box" }), ED), "on_click")[0][0]({}, cx);
  await settle();
  assert.deepEqual(host.execs, [["code", ["--folder-uri", "vscode-remote://ssh-remote+me@box/r"], { on: null }]]);
});

test("the row entry opens the file, on a machine with the remote template", async () => {
  host.execs = []; host.config = null;
  called(findId(popup({ machine: "box" }), ED), "on_click")[0][0]({}, cx);
  await settle();
  assert.deepEqual(host.execs, [["code", ["--file-uri", "vscode-remote://ssh-remote+me@box/r/a.md"], { on: null }]]);
});

test("dimmed on a machine without the template, in both menus", () => {
  const none = { name: "Sublime Text", remote: false, remoteFolder: false };
  const dim = (el) => [called(el, "on_click").length, called(el, "text_color").some(([c]) => c === "dim")];
  assert.deepEqual(dim(findId(rootPopup({ machine: "box", editor: none }), ED)), [0, true]);
  assert.deepEqual(dim(findId(popup({ machine: "box", editor: none }), ED)), [0, true]);
  assert.deepEqual(dim(findId(rootPopup({ machine: null, editor: none }), ED))[0], 1);
  assert.deepEqual(dim(findId(popup({ machine: null, editor: none }), ED))[0], 1);
  const fileOnly = { name: "Mine", remote: true, remoteFolder: false };
  assert.equal(called(findId(popup({ machine: "box", editor: fileOnly }), ED), "on_click").length, 1);
  assert.equal(called(findId(rootPopup({ machine: "box", editor: fileOnly }), ED), "on_click").length, 0);
});

test("a failing start is titled with the editor name", async () => {
  host.execFail = new Error("spawn code ENOENT"); host.notes = []; host.config = null;
  called(findId(rootPopup({ editor: { name: "VS Code", remote: true, remoteFolder: true } }), ED), "on_click")[0][0]({}, cx);
  await settle();
  host.execFail = null;
  assert.equal(host.notes.at(-1).title, "Open in VS Code failed");
});
