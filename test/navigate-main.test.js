// Issue #59: folder navigation through the real panel (mods/filer-pro/main.js) with stub builders and a fake host:
// Up, Go to /, Back to the terminal's folder, the override per terminal that a cd does not end, and that the
// listing, git and the folder watch use the shown root.
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
  "gpui-base": `${make(["v_flex", "h_flex", "v_resizable", "resizable_panel", "Input", "TextView"])} export class Editor { static new() { return globalThis.__make("editor"); } } export class EditorState {} export class InputState {} export const Scrollbar = { vertical: () => globalThis.__make("scrollbar") };`,
  "fs/promises": `${stub(["exists"])} export const readFile = async () => "", writeFile = readFile, mkdir = readFile, unlink = readFile, stat = readFile;`,
};
const hooks = `export async function resolve(s, c, next) { return s in ${JSON.stringify(STUBS)} ? { url: "stub:" + s, shortCircuit: true } : next(s, c); }
export async function load(u, c, next) { return u.startsWith("stub:") ? { format: "module", shortCircuit: true, source: ${JSON.stringify(STUBS)}[u.slice(5)] } : next(u, c); }`;
register("data:text/javascript," + encodeURIComponent(hooks));
const FilerPro = (await import("../mods/filer-pro/main.js")).default;

// A fake disk: folder → entries ("name/" is a folder). Two terminals p1 and p2; host.focus names the focused one.
const DISK = {
  "/": ["data/", "home/"], "/home": ["u/"], "/home/u": ["git/"], "/home/u/git": ["one/", "two/"],
  "/home/u/git/one": ["src/", "a.md"], "/home/u/git/one/src": ["x.js"], "/home/u/git/two": ["b.md"],
};
const host = { focus: "p1", cwd: { p1: "/home/u/git/one", p2: "/home/u/git/one" }, shared: {}, calls: [], watched: [], notes: [] };
globalThis.__impl = {
  props: () => ({}), shared: (k) => host.shared[k], setShared: (k, v) => { host.shared[k] = v; }, settings: () => ({ dark: false, font_family: "mono" }),
  theme: () => new Proxy({}, { get: (_t, k) => String(k) }), window: () => ({ platform: "macos" }), home: () => "/home/u", appHome: () => "/app",
  spaces: () => [{ active: true, id: "s1", folder: "/space", machine: null }],
  panes: () => Object.entries(host.cwd).map(([pane, cwd]) => ({ pane, cwd, terminal: `t-${pane}` })),
  focused: () => ({ space: "s1", pane: host.focus, terminal: `t-${host.focus}`, cwd: null }),
  notify: (n) => host.notes.push(n), readTextFile: async () => null,
  watchFolder: (root) => { host.watched.push(root); return new Promise(() => {}); },
  exec: async (cmd, args, opts = {}) => {
    if (cmd === "sh" && args[2] === "files") {
      const path = args[3];
      host.calls.push(["list", path]);
      const list = DISK[path];
      if (!list) return { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: list.map((n) => (n.endsWith("/") ? `d\0${n.slice(0, -1)}\0` : `f\0${n}\0`)).join(""), stderr: "" };
    }
    if (cmd === "git") host.calls.push(["git", opts.cwd]);
    return { code: 1, stdout: "", stderr: "" };
  },
};

// A task runs at once; settle lets every task that can finish do so (a folder watch waits forever).
const cx = { notify() {}, sleep: async () => {}, spawn: (fn) => { const p = Promise.resolve().then(() => fn(cx)); p.catch(() => {}); return p; } };
const settle = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); };

async function panel() {
  host.focus = "p1"; host.cwd = { p1: "/home/u/git/one", p2: "/home/u/git/one" }; host.shared = {}; host.calls = []; host.watched = []; host.notes = [];
  const self = Object.create(FilerPro.prototype);
  Object.assign(self, { context: null, saved: new Map(), nav: new Map(), reload: { signal: () => false, take: () => false }, jobs: {}, perf: null, entries: new Map(), folders: new Set(), pending: new Set(), marks: {} });
  self.refresh(cx);
  await settle();
  return self;
}
const names = (self, path = "") => (self.entries.get(path) ?? []).map((e) => e.name);

const idOf = (el) => el.calls.find((c) => c[0] === "id")?.[1];
function findId(el, id) {
  if (!el || typeof el !== "object" || !el.calls) return null;
  if (idOf(el) === id) return el;
  for (const k of el.kids) { const hit = findId(k, id); if (hit) return hit; }
  return null;
}
const called = (el, name) => el.calls.filter((c) => c[0] === name).map((c) => c.slice(1));
const header = (root) => root.kids[0];
const textOf = (el) => (typeof el === "string" ? el : (el?.kids ?? []).map(textOf).join(""));

test("Up lists the parent, runs git and watches there, and keeps the old view open", async () => {
  const self = await panel();
  self.folders.add("src"); self.refresh(cx); await settle();
  assert.equal(self.root, "/home/u/git/one");
  host.calls = []; host.watched = [];
  self.navigate("/home/u/git", cx);
  await settle();
  assert.equal(self.root, "/home/u/git");
  assert.deepEqual(names(self), ["one", "two"]);
  assert.deepEqual([...self.folders], ["one", "one/src"], "the old root and its expanded folder stay open");
  assert.deepEqual(names(self, "one/src"), ["x.js"]);
  assert.deepEqual(host.calls.filter((c) => c[0] === "list").map((c) => c[1]), ["/home/u/git", "/home/u/git/one", "/home/u/git/one/src"]);
  assert.deepEqual(host.calls.filter((c) => c[0] === "git"), [["git", "/home/u/git"]]);
  assert.deepEqual(host.watched, ["/home/u/git"]);
});

test("the override is per terminal; a cd does not move the tree; Back goes to the terminal's current folder", async () => {
  const self = await panel();
  self.navigate("/home/u/git", cx); await settle();
  host.focus = "p2"; self.render(cx); await settle();
  assert.equal(self.root, "/home/u/git/one", "the other terminal in the same folder shows its own folder");
  host.focus = "p1"; self.render(cx); await settle();
  assert.equal(self.root, "/home/u/git", "back on the first terminal: its navigated folder");

  self.navigate("/home/u/git/one", cx); await settle(); // Back to the terminal's folder
  assert.equal(self.root, "/home/u/git/one");
  assert.equal(self.nav.size, 0);

  self.navigate("/home/u/git", cx); await settle();
  self.folders.add("one"); host.calls = [];
  host.cwd.p1 = "/home/u/git/two"; self.render(cx); await settle(); // cd in the terminal
  assert.equal(self.root, "/home/u/git", "the tree stays where the user navigated");
  assert.deepEqual(host.calls, [], "and does not reload");
  assert.ok(self.folders.has("one"), "nor lose its expanded folders");
  const back = findId(self.render(cx), "files-back-terminal");
  called(back, "on_click")[0][0]({}, cx); await settle();
  assert.equal(self.root, "/home/u/git/two", "Back goes to the folder the terminal is in now");
  assert.equal(self.nav.size, 0);
});

test("navigation is refused while the open file has unsaved changes", async () => {
  const self = await panel();
  self.edit = { dirty: true };
  self.navigate("/home/u/git", cx); await settle();
  assert.equal(self.root, "/home/u/git/one");
  assert.equal(self.nav.size, 0);
  assert.equal(host.notes.length, 1);
  self.edit = null;
});

test("a folder above home and / are listed but not watched", async () => {
  const self = await panel();
  host.watched = [];
  self.navigate("/home", cx); await settle();
  self.navigate("/", cx); await settle();
  assert.equal(self.root, "/");
  assert.deepEqual(names(self), ["data", "home"]);
  assert.deepEqual(host.watched, []);
});

test("#112 location line: the ~ path, then Go to /, Back, Up one level and Folder actions; dimmed at /, no line with a file open", async () => {
  const self = await panel();
  const line = (root) => findId(root, "files-line");
  const path = (root) => textOf(findId(root, "files-line-path"));
  let root = self.render(cx);
  assert.deepEqual(ids(root), ORDER);
  assert.deepEqual(called(findId(root, "files-top"), "tooltip"), [["Go to /"]]);
  assert.deepEqual(called(findId(root, "files-up"), "tooltip"), [["Up one level"]]);
  assert.deepEqual(called(findId(root, "files-up"), "accessibility_label"), [["Up one level"]]);
  assert.equal(path(root), "· ~/git/one");
  assert.equal(textOf(header(root)).includes("one"), true, "the header names the shown folder");
  assert.equal(findId(header(root), "files-top"), null, "no navigation in the header");

  self.navigate("/home/u/git", cx); await settle();
  root = self.render(cx);
  assert.deepEqual(ids(root), ORDER);
  assert.equal(path(root), "· ~/git");
  const back = findId(root, "files-back-terminal");
  assert.deepEqual(called(back, "tooltip"), [["Back to the terminal's folder"]]);
  assert.deepEqual(called(back, "bg"), [], "no accent background");
  assert.ok(called(back, "on_click").length, "enabled while navigated away");
  assert.equal(textOf(back), "", "icon only");
  called(back, "on_click")[0][0]({}, cx); await settle();
  assert.equal(self.root, "/home/u/git/one");

  self.lineWidths = { follow: 96 }; // 12 characters
  self.navigate("/home/u/git/one/src", cx); await settle();
  root = self.render(cx);
  assert.ok(path(root).startsWith("· …"), path(root));
  assert.ok(path(root).endsWith("/one/src"), path(root));

  called(findId(root, "files-top"), "on_click")[0][0]({}, cx); await settle(); // Go to /
  assert.equal(self.root, "/");
  root = self.render(cx);
  assert.deepEqual(called(findId(root, "files-up"), "on_click"), [], "Up dimmed at /");
  assert.deepEqual(called(findId(root, "files-top"), "on_click"), [], "Go to / dimmed at /");
  assert.ok(called(findId(root, "files-back-terminal"), "on_click").length, "Back enabled at / when away from the terminal's folder");
  assert.ok(called(findId(root, "files-actions"), "on_click").length, "Folder actions enabled");

  self.navigate("/home/u/git/one", cx); await settle();
  self.show("a.md", null);
  root = self.render(cx);
  assert.equal(line(root), null, "no location line while a file is open");
  assert.ok(findId(root, "files-refresh"), "Refresh stays in the header");
});

test("Go to / from a terminal that reports no folder (the space's folder is the fallback) stays until Back", async () => {
  const self = await panel();
  host.cwd.p1 = null; self.render(cx); await settle();
  assert.equal(self.root, "/space");
  self.navigate("/", cx); await settle();
  host.cwd.p1 = "/home/u/git/one"; self.render(cx); await settle();
  assert.equal(self.root, "/");
});

// Issue #85: the navigation buttons keep their place; the folder tree button is always there. #112: in the location line.
const ORDER = ["files-top", "files-back-terminal", "files-up", "files-actions"];
const ids = (root) => findId(root, "files-line").kids.map(idOf).filter((id) => ORDER.includes(id));
const enabled = (root, id) => called(findId(root, id), "on_click").length > 0;
const color = (root, id) => called(findId(root, id).kids[0], "text_color");

test("location line buttons: same set and order in the terminal's folder, navigated away and at /", async () => {
  const self = await panel();
  let root = self.render(cx);
  assert.deepEqual(ids(root), ORDER);
  self.navigate("/home/u/git", cx); await settle();
  assert.deepEqual(ids(self.render(cx)), ORDER);
  self.navigate("/", cx); await settle();
  assert.deepEqual(ids(self.render(cx)), ORDER);
});

test("location line: in the terminal's folder the folder tree is dimmed, Go to / and Up enabled, the path is the folder", async () => {
  const self = await panel();
  const root = self.render(cx);
  assert.equal(enabled(root, "files-back-terminal"), false);
  assert.equal(enabled(root, "files-top"), true);
  assert.equal(enabled(root, "files-up"), true);
  assert.equal(textOf(findId(root, "files-line-path")), "· ~/git/one");
  assert.deepEqual(color(root, "files-back-terminal"), [["dim"]]);
});

test("location line: navigated away the folder tree is enabled in the neutral color of the other icons", async () => {
  const self = await panel();
  self.navigate("/home/u/git", cx); await settle();
  const root = self.render(cx);
  assert.equal(enabled(root, "files-back-terminal"), true);
  assert.deepEqual(color(root, "files-back-terminal"), color(root, "files-up"));
  assert.deepEqual(color(root, "files-back-terminal"), [["muted"]]);
  assert.deepEqual(called(findId(root, "files-back-terminal"), "bg"), []);
  assert.equal(textOf(findId(root, "files-line-path")), "· ~/git");
  assert.equal(enabled(root, "files-top"), true);
  assert.equal(enabled(root, "files-up"), true);
});

test("location line at /: path /, Go to / and Up dimmed", async () => {
  const self = await panel();
  self.navigate("/", cx); await settle();
  const root = self.render(cx);
  assert.equal(textOf(findId(root, "files-line-path")), "· /");
  assert.equal(enabled(root, "files-top"), false);
  assert.equal(enabled(root, "files-up"), false);
});

test("location line: the terminal's folder is /: folder tree dimmed, Go to / and Up dimmed", async () => {
  const self = await panel();
  host.cwd.p1 = "/"; self.render(cx); await settle();
  assert.equal(self.root, "/");
  const root = self.render(cx);
  assert.equal(textOf(findId(root, "files-line-path")), "· /");
  assert.equal(enabled(root, "files-back-terminal"), false);
  assert.equal(enabled(root, "files-top"), false);
  assert.equal(enabled(root, "files-up"), false);
  assert.deepEqual(ids(root), ORDER);
});
