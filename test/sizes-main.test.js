// Issue #58: file sizes and Calculate Size through the real panel (mods/filer-pro/main.js) with stub builders and a fake
// host: the listing call with and without sizes, the size column, the menu entry and its detail, the shared request
// that the panel runs with the 120 s limit, Too large, a failure, and Refresh.
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

// A fake disk: folder → entries ("name/" is a folder, "name:bytes" a file with its size); `box` is an SSH machine.
const DISK = { "/r": ["src/", "Tool.app/", "a.md:3200", "b.txt:812"], "/r/src": ["x.js:5"] };
const host = { shared: {}, calls: [], notes: [], overlay: null, closed: 0, on: null, size: null };
globalThis.__impl = {
  props: () => host.overlay ?? {}, shared: (k) => host.shared[k], setShared: (k, v) => { host.shared[k] = v; }, settings: () => ({ dark: false, font_family: "mono" }),
  theme: () => new Proxy({}, { get: (_t, k) => String(k) }), window: () => ({ platform: "macos" }), home: () => "/home/u", appHome: () => "/app",
  spaces: () => [{ active: true, id: "s1", folder: "/r", machine: host.on }],
  panes: () => [{ pane: "p1", cwd: "/r", terminal: "t-p1" }],
  focused: () => ({ space: "s1", pane: "p1", terminal: "t-p1", cwd: null }),
  notify: (n) => host.notes.push(n), readTextFile: async (path) => (path === "/app/filer-pro.json" ? host.config : null), closeOverlay: () => { host.closed++; }, openOverlay: () => "ov",
  watchFolder: () => new Promise(() => {}),
  exec: async (cmd, args, opts = {}) => {
    host.calls.push([cmd, args.slice(2), opts]);
    if (cmd === "sh" && args[2] === "files") {
      const list = DISK[args[3]];
      if (!list) return { code: 1, stdout: "", stderr: "" };
      const pairs = list.map((n) => (n.endsWith("/") ? `d\0${n.slice(0, -1)}\0` : `f\0${n.split(":")[0]}\0`)).join("");
      const sizes = list.filter((n) => !n.endsWith("/")).map((n) => n.split(":")[1]).join("\n");
      return { code: 0, stdout: args[8] === "1" ? `${pairs}S\0${sizes}\0` : pairs, stderr: "" };
    }
    if (cmd === "sh" && args[1] === SIZE_SCRIPT) return host.size(args[3], opts, args.slice(2));
    return { code: 1, stdout: "", stderr: "" };
  },
};

const cx = { notify() {}, sleep: async () => {}, spawn: (fn) => { const p = Promise.resolve().then(() => fn(cx)); p.catch(() => {}); return p; } };
const settle = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); };
const CFG = { ...numbers(null), hide_system_files: true, hide_dotfiles: false };

async function panel({ sizes = true, on = null } = {}) {
  Object.assign(host, { config: JSON.stringify({ show_sizes: sizes }), shared: {}, calls: [], notes: [], overlay: null, closed: 0, on, size: async () => ({ code: 0, stdout: "2400000\n", stderr: "" }) });
  const self = Object.create(FilerPro.prototype);
  Object.assign(self, { cfg: { ...CFG, show_sizes: sizes }, context: null, saved: new Map(), nav: new Map(), reload: { signal: () => false, take: () => false }, jobs: {}, perf: null, entries: new Map(), folders: new Set(), pending: new Set(), marks: {} });
  self.refresh(cx);
  await settle();
  return self;
}
// The menu, drawn by a second copy of the mod as the popup over a row.
function menu(path, extra = {}) {
  host.overlay = { overlay: "ov", view: "menu", machine: host.on, root: "/r", path, isDir: true, folder: path, ...extra };
  const view = Object.create(FilerPro.prototype).render(cx);
  host.overlay = null;
  return view;
}

const idOf = (el) => el.calls.find((c) => c[0] === "id")?.[1];
function findId(el, id) {
  if (!el || typeof el !== "object" || !el.calls) return null;
  if (idOf(el) === id) return el;
  for (const k of el.kids) { const hit = findId(k, id); if (hit) return hit; }
  return null;
}
const called = (el, name) => el.calls.filter((c) => c[0] === name).map((c) => c.slice(1));
const textOf = (el) => (typeof el === "string" ? el : (el?.kids ?? []).map(textOf).join(""));
const cell = (root, path) => findId(root, `file-${path}-size`);
const lists = () => host.calls.filter((c) => c[1][0] === "files");

test("show_sizes off: the listing gets no size argument and the rows have no size column", async () => {
  const self = await panel({ sizes: false });
  self.folders.add("src"); self.refresh(cx); await settle();
  assert.deepEqual(lists().map((c) => c[1].slice(1)), [["/r", "500", "1", "0"], ["/r", "500", "1", "0"], ["/r/src", "500", "1", "0", "1"]]);
  const root = self.render(cx);
  assert.equal(cell(root, "a.md"), null);
  assert.equal(cell(root, "src"), null);
  assert.equal(self.entryAt("a.md").size, undefined);
});

test("show_sizes is on before the config was read (issue #73)", async () => {
  Object.assign(host, { config: null, shared: {}, calls: [], notes: [], overlay: null, closed: 0, on: null });
  const self = Object.create(FilerPro.prototype);
  Object.assign(self, { cfg: null, context: null, saved: new Map(), nav: new Map(), reload: { signal: () => false, take: () => false }, jobs: {}, perf: null, entries: new Map(), folders: new Set(), pending: new Set(), marks: {} });
  self.refresh(cx);
  await settle();
  assert.deepEqual(lists()[0][1].slice(1), ["/r", "500", "1", "0", "0", "1"]);
});

test("show_sizes on: one listing call per folder carries the sizes; files show them, folders a dash, a package nothing", async () => {
  const self = await panel();
  self.folders.add("src"); self.refresh(cx); await settle();
  const calls = lists();
  assert.equal(calls.length, 3, "no extra exec per file or folder");
  assert.deepEqual(calls.map((c) => c[1].slice(1)), [["/r", "500", "1", "0", "0", "1"], ["/r", "500", "1", "0", "0", "1"], ["/r/src", "500", "1", "0", "1", "1"]]);
  const root = self.render(cx);
  assert.equal(textOf(cell(root, "a.md")), "3.2 kB");
  assert.equal(textOf(cell(root, "b.txt")), "812 B");
  assert.equal(textOf(cell(root, "src/x.js")), "5 B");
  assert.equal(textOf(cell(root, "src")), "—");
  assert.equal(textOf(cell(root, "Tool.app")), "", "a package shows no size before Calculate Size");
  assert.deepEqual(called(cell(root, "a.md"), "text_size"), [[11]]);
  assert.deepEqual(called(cell(root, "a.md"), "font_family"), [["mono"]], "the terminal font: digits line up");
  // The size sits directly left of the git mark slot, which keeps a fixed width at the row's edge.
  const row = findId(root, "file-a.md"), kids = row.kids;
  assert.equal(idOf(kids.at(-2)), "file-a.md-size");
  assert.deepEqual(called(kids.at(-1), "w"), [[12]]);
});

test("Calculate Size: the menu asks, the panel runs SIZE_SCRIPT once with a 120 s limit, the size shows in the row and the menu", async () => {
  const self = await panel();
  const asked = [];
  host.size = async (_path, opts, argv) => { asked.push([argv, opts]); return { code: 0, stdout: "2400000\n", stderr: "" }; };
  const before = menu("/r/src");
  const entry = findId(before, "filer-pro-menu-calculate-size");
  assert.equal(textOf(entry), "Calculate Size");
  called(entry, "on_click")[0][0]({}, cx);
  assert.equal(host.closed, 1, "the popup closes");
  const key = sizeKey(null, "/r/src");
  assert.equal(host.shared["filer-pro.sizes"][key].state, "requested");
  assert.equal(textOf(findId(menu("/r/src"), "filer-pro-menu-calculate-size-detail")), "…", "reopened while it waits");
  self.pollSizes(cx);
  assert.equal(host.shared["filer-pro.sizes"][key].state, "running");
  assert.ok(called(findId(self.render(cx), "file-src-size"), "child").some(([c]) => called(c, "spin").length), "a spinner while it runs");
  await settle();
  assert.deepEqual(asked, [[["size", "/r/src", "120"], { on: null, timeout: 125000 }]]);
  self.pollSizes(cx); await settle();
  assert.equal(asked.length, 1, "claimed once");
  assert.equal(textOf(cell(self.render(cx), "src")), "~2.4 MB");
  assert.equal(textOf(findId(menu("/r/src"), "filer-pro-menu-calculate-size-detail")), "~2.4 MB");
  assert.deepEqual(host.notes, []);
  // Refresh forgets it: the size is a snapshot.
  called(findId(self.render(cx), "files-refresh"), "on_click")[0][0]({}, cx); await settle();
  assert.equal(textOf(cell(self.render(cx), "src")), "—");
});

test("Calculate Size on a package shows its size; on a machine it runs there", async () => {
  const self = await panel({ on: "box" });
  const asked = [];
  host.size = async (path, opts) => { asked.push([path, opts.on]); return { code: 0, stdout: "1500\n", stderr: "" }; };
  called(findId(menu("/r/src"), "filer-pro-menu-calculate-size"), "on_click")[0][0]({}, cx);
  self.pollSizes(cx); await settle();
  assert.deepEqual(asked, [["/r/src", "box"]]);
  assert.equal(textOf(cell(self.render(cx), "src")), "~1.5 kB");

  const local = await panel();
  called(findId(menu("/r/Tool.app", { bundle: true }), "filer-pro-menu-calculate-size"), "on_click")[0][0]({}, cx);
  local.pollSizes(cx); await settle();
  assert.equal(textOf(cell(local.render(cx), "Tool.app")), "~2.4 MB");
});

test("Calculate Size that uses up the time limit shows Too large to calculate; a failure a toast and the dash again", async () => {
  const self = await panel();
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    host.size = async () => { now += 120000; return { code: 143, stdout: "", stderr: "" }; };
    called(findId(menu("/r/src"), "filer-pro-menu-calculate-size"), "on_click")[0][0]({}, cx);
    self.pollSizes(cx); await settle();
  } finally { Date.now = realNow; }
  const c = cell(self.render(cx), "src");
  assert.equal(textOf(c), "Too large");
  assert.deepEqual(called(c, "tooltip"), [["Too large to calculate"]]);
  assert.match(host.notes.at(-1).body, /^Too large to calculate/);

  host.size = async () => ({ code: 255, stdout: "", stderr: "ssh: connect to host example.com: Connection refused\n" });
  called(findId(menu("/r/src"), "filer-pro-menu-calculate-size"), "on_click")[0][0]({}, cx);
  self.pollSizes(cx); await settle();
  assert.equal(textOf(cell(self.render(cx), "src")), "—");
  assert.deepEqual([host.notes.at(-1).title, host.notes.at(-1).level], ["Calculate Size failed", "error"]);
});

test("Calculate Size with an unreadable subfolder: ~size and the tooltip in the column and on the menu entry, no toast", async () => {
  const self = await panel();
  host.size = async () => ({ code: 0, stdout: "2400000 partial\n", stderr: "" });
  called(findId(menu("/r/src"), "filer-pro-menu-calculate-size"), "on_click")[0][0]({}, cx);
  self.pollSizes(cx); await settle();
  const c = cell(self.render(cx), "src");
  assert.equal(textOf(c), "~2.4 MB");
  assert.deepEqual(called(c, "tooltip"), [["Some folders could not be read"]]);
  const entry = findId(menu("/r/src"), "filer-pro-menu-calculate-size");
  assert.deepEqual(called(entry, "tooltip"), [["Some folders could not be read"]]);
  assert.equal(textOf(findId(menu("/r/src"), "filer-pro-menu-calculate-size-detail")), "~2.4 MB");
  assert.deepEqual(host.notes, []);
  // a complete sum has no tooltip on either
  host.size = async () => ({ code: 0, stdout: "2400000\n", stderr: "" });
  called(findId(menu("/r/src"), "filer-pro-menu-calculate-size"), "on_click")[0][0]({}, cx);
  self.pollSizes(cx); await settle();
  assert.deepEqual(called(cell(self.render(cx), "src"), "tooltip"), []);
  assert.deepEqual(called(findId(menu("/r/src"), "filer-pro-menu-calculate-size"), "tooltip"), []);
});

test("Calculate Size: the script's timeout answer shows Too large", async () => {
  const self = await panel();
  host.size = async () => ({ code: 0, stdout: "0 timeout\n", stderr: "" });
  called(findId(menu("/r/src"), "filer-pro-menu-calculate-size"), "on_click")[0][0]({}, cx);
  self.pollSizes(cx); await settle();
  const c = cell(self.render(cx), "src");
  assert.equal(textOf(c), "Too large");
  assert.deepEqual(called(c, "tooltip"), [["Too large to calculate"]]);
  assert.match(host.notes.at(-1).body, /^Too large to calculate/);
  assert.equal(host.notes.at(-1).level, "info");
});

test("a panel that does not show the folder leaves the request to the one that does", async () => {
  const self = await panel();
  host.shared["filer-pro.sizes"] = { [sizeKey("box", "/r/src")]: { state: "requested", id: "x" }, [sizeKey(null, "/elsewhere/a")]: { state: "requested", id: "y" } };
  self.pollSizes(cx); await settle();
  assert.equal(host.calls.filter((c) => c[1][0] === SIZE_SCRIPT).length, 0);
  assert.equal(host.shared["filer-pro.sizes"][sizeKey("box", "/r/src")].state, "requested");
});
