// Issue #101: the lower tree on this computer (main.js stubbed as in show-as-root.test.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { LIST_SCRIPT } from "../mods/filer-pro/lib/tree.js";
import { SIZE_SCRIPT, requestSize, sizeKey } from "../mods/filer-pro/lib/sizes.js";
import { numbers } from "../mods/filer-pro/lib/settings.js";
import { OPEN_BUNDLE_SCRIPT, OPEN_CHECK_SCRIPT } from "../mods/filer-pro/lib/open.js";

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
  "gpui-base": `${make(["v_flex", "h_flex", "v_resizable", "resizable_panel", "TextView"])} export const Input = { new: () => globalThis.__make("input") }, Scrollbar = { vertical: () => globalThis.__make("scrollbar") };
export class Editor { static new() { return globalThis.__make("editor"); } } export class EditorState { static new() { return { release() {} }; } } export class InputState {}`,
  "fs/promises": `${stub(["exists"])} export const readFile = async () => "", writeFile = async (...a) => globalThis.__impl.writeFile(...a), mkdir = readFile, unlink = readFile, stat = readFile;`,
};
const hooks = `export async function resolve(s, c, next) { return s in ${JSON.stringify(STUBS)} ? { url: "stub:" + s, shortCircuit: true } : next(s, c); }
export async function load(u, c, next) { return u.startsWith("stub:") ? { format: "module", shortCircuit: true, source: ${JSON.stringify(STUBS)}[u.slice(5)] } : next(u, c); }`;
register("data:text/javascript," + encodeURIComponent(hooks));
const FilerPro = (await import("../mods/filer-pro/main.js")).default;


const never = () => new Promise(() => {});
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
const DEFAULTS = { ...numbers(null), node_path: "", svg_check: true, double_click_files: false, double_click_apps: true, double_click_folders: true, show_sizes: true };
const UP = "/home/u/project", LOW = "/Users/example/Downloads", INBOX = "/Users/example/Inbox", KEY = "filer-pro.localtree";
const list = (...names) => names.flatMap((n) => (n.endsWith("/") ? ["d", n.slice(0, -1)] : ["f", n])).join("\0") + "\0";

// A fake host: the focused space is on machine `box` at UP (or local); listings per path, every exec and watch logged.
function host({ machine = "box", folder = UP, store = {}, listings = {}, fail = {}, props = {}, terminal = false } = {}) {
  const log = { execs: [], overlays: [], watched: [], writes: [] };
  const state = { machine, folder };
  globalThis.__impl = {
    props: () => props, appHome: () => "/app", home: () => "/Users/example", window: () => ({ platform: "macos" }),
    theme: () => new Proxy({}, { get: (_t, k) => String(k) }), settings: () => ({ dark: true, font_family: "mono" }),
    spaces: () => [{ active: true, id: "s1", folder: state.folder, machine: state.machine }],
    panes: () => (terminal ? [{ pane: "p1", cwd: state.folder, terminal: "t-p1" }] : []), focused: () => (terminal ? { space: "s1", pane: "p1", terminal: "t-p1", cwd: null } : {}),
    shared: (k) => store[k], setShared: (k, v) => { store[k] = v; },
    readTextFile: async (p) => (p.endsWith("notes.txt") ? "hello\n" : null), writeFile: async () => {},
    exec: async (cmd, args, opts) => {
      log.execs.push({ cmd, args, opts });
      if (cmd === "sh" && args[1] === LIST_SCRIPT) {
        const path = args[3];
        if (fail[path]) return { code: 1, stdout: "", stderr: fail[path] };
        return { code: 0, stdout: listings[path] ?? "", stderr: "" };
      }
      if (cmd === "sh" && args[1] === SIZE_SCRIPT) return { code: 0, stdout: "2400000\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    },
    hc: async () => ({ code: 0, stdout: "{}", stderr: "" }),
    openOverlay: (o) => { log.overlays.push(o); return "ov1"; }, closeOverlay: () => {},
    notify: () => {}, watchFolder: (p) => { log.watched.push(p); return never(); }, nextCommand: never, layout: () => ({}), exists: async () => false,
  };
  return { log, store, state };
}
function fakeCx() {
  const cx = { notify() {}, sleep: never, stop_propagation() {}, phase: () => "ok", spawn: (fn) => { const p = Promise.resolve().then(() => fn(cx)); p.catch(() => {}); return p; }, timer: { after() {}, every() {} } };
  return cx;
}
function panel(cfg = {}) {
  return Object.assign(Object.create(FilerPro.prototype), { cfg: { ...DEFAULTS, download_folder: LOW, local_tree_folder: LOW, ...cfg }, saved: new Map(), reload: { signal: () => false, take: () => false, mark() {} }, jobs: {}, perf: null });
}
const listsOf = (log, path) => log.execs.filter((e) => e.cmd === "sh" && e.args[1] === LIST_SCRIPT && e.args[3] === path);

function* walk(e) {
  if (!e || typeof e !== "object") return;
  yield e;
  for (const k of e.kids ?? []) yield* walk(k);
}
const idOf = (el) => el.calls?.find((c) => c[0] === "id")?.[1];
const byId = (root, id) => [...walk(root)].find((e) => idOf(e) === id);
const ids = (root) => [...walk(root)].map(idOf).filter(Boolean);
const called = (el, name) => el.calls.filter(([k]) => k === name).map(([, ...a]) => a);
const handler = (el, name) => el.calls.find(([k]) => k === name).at(-1);
const splitOf = (root) => [...walk(root)].find((e) => e.kind === "v_resizable");
const texts = (root) => [...walk(root)].flatMap((e) => (e.kids ?? []).filter((k) => typeof k === "string"));

// Renders until the trees settled (listings are async); the split needs its measured height.
async function show(self, cx, { height = 500 } = {}) {
  let tree = self.render(cx);
  await settle();
  const frame = byId(tree, "files-split-frame");
  if (frame && height) { handler(frame, "on_size_change")({ width: 300, height }, cx); }
  tree = self.render(cx);
  await settle();
  return self.render(cx);
}

test("#101 hidden by default: one tree, the toggle shows This Mac", async () => {
  const { log } = host({ listings: { [UP]: list("a.txt") } });
  const cx = fakeCx(), self = panel();
  self.refresh(cx);
  await settle();
  const tree = self.render(cx);
  assert.equal(byId(tree, "files-tree-local"), undefined);
  assert.equal([...walk(tree)].some((e) => e.kind === "v_resizable"), false);
  assert.deepEqual(called(byId(tree, "files-local-toggle"), "tooltip"), [["Show This Mac"]]);
  assert.equal(listsOf(log, LOW).length, 0);
});

test("#101 #112 the toggle shows a lower tree at local_tree_folder, else the home folder", async () => {
  for (const [cfg, folder] of [[{ local_tree_folder: INBOX }, INBOX], [{ local_tree_folder: "" }, "/Users/example"]]) {
    const { log, store } = host({ listings: { [UP]: list("a.txt"), [folder]: list("b.txt") } });
    const cx = fakeCx(), self = panel(cfg);
    self.refresh(cx);
    await settle();
    handler(byId(self.render(cx), "files-local-toggle"), "on_click")({}, cx);
    assert.equal(store[KEY].shown, true);
    const tree = await show(self, cx);
    const lists = listsOf(log, folder);
    assert.equal(lists.length >= 1, true);
    assert.ok(!lists[0].opts?.on, "listed on this computer");
    assert.ok(byId(tree, "local-file-b.txt"));
    assert.ok(byId(tree, "file-a.txt"));
    assert.ok(log.execs.some((e) => e.opts?.on === "box" && e.args[3] === UP), "the upper tree still lists on the machine");
  }
});

test("#101 no listing before the config is read", async () => {
  const { log } = host({ store: { [KEY]: { shown: true, root: null, sizes: null } }, listings: { [UP]: list("a.txt"), [LOW]: list("b.txt") } });
  const cx = fakeCx(), self = panel();
  self.cfgPending = true;
  self.refresh(cx);
  self.render(cx);
  await settle();
  assert.equal(listsOf(log, LOW).length, 0);
  assert.equal(listsOf(log, INBOX).length, 0);
  self.cfgPending = false;
  self.render(cx);
  await settle();
  assert.equal(listsOf(log, LOW).length, 1);
});

test("#101 the split: two panels of at least 120px, sizes from shared and stored on resize", async () => {
  const { store } = host({ store: { [KEY]: { shown: true, root: null, sizes: [300, 200] } }, listings: { [UP]: list("a.txt"), [LOW]: list("b.txt") } });
  const cx = fakeCx(), self = panel();
  self.refresh(cx);
  const tree = await show(self, cx, { height: 0 });
  const split = splitOf(tree);
  assert.equal(split.kind, "v_resizable");
  const panels = split.kids;
  assert.equal(panels.length, 2);
  for (const p of panels) assert.deepEqual(called(p, "size_range"), [[120]]);
  assert.deepEqual(called(panels[0], "size"), [[300]]);
  handler(split, "on_resize")([280, 220], cx);
  assert.deepEqual(store[KEY].sizes, [280, 220]);
});

test("#101 the split waits for its height and then starts at 60 percent", async () => {
  host({ store: { [KEY]: { shown: true, root: null, sizes: null } }, listings: { [UP]: list("a.txt"), [LOW]: list("b.txt") } });
  const cx = fakeCx(), self = panel();
  self.refresh(cx);
  const first = self.render(cx);
  await settle();
  assert.equal(splitOf(first), undefined);
  const tree = await show(self, cx, { height: 500 });
  assert.deepEqual(called(splitOf(tree).kids[0], "size"), [[300]]);
});

test("#101 navigating the lower tree stores its root once for all spaces", async () => {
  const { store } = host({ store: { [KEY]: { shown: true, root: null, sizes: null } }, listings: { [UP]: list("a.txt"), [LOW]: list("sub/"), "/Users/example": list("x/") } });
  const cx = fakeCx(), self = panel();
  self.refresh(cx);
  await show(self, cx);
  self.navigate("/Users/example", cx, self.trees.pinned);
  await settle();
  assert.equal(store[KEY].root, "/Users/example");
  assert.equal(self.nav?.size ?? 0, 0);
  assert.equal(self.trees.pinned.root, "/Users/example");
  assert.equal(self.trees.pinned.context.key, "pinned:/Users/example");
});

test("#101 a focus change moves only the upper tree", async () => {
  const { log, state } = host({ listings: { [UP]: list("a.txt"), [LOW]: list("b.txt"), "/srv": list("c.txt") }, store: { [KEY]: { shown: true, root: null, sizes: null } } });
  const cx = fakeCx(), self = panel();
  self.refresh(cx);
  await show(self, cx);
  const key = self.trees.pinned.context.key, before = listsOf(log, LOW).length;
  state.machine = "other"; state.folder = "/srv";
  await show(self, cx);
  assert.equal(self.trees.pinned.context.key, key);
  assert.equal(listsOf(log, LOW).length, before);
  assert.ok(log.execs.some((e) => e.opts?.on === "other" && e.args[3] === "/srv"));
});

test("#101 Paste from the lower tree's menu goes to this computer", async () => {
  const { log, store } = host({ store: { [KEY]: { shown: true, root: null, sizes: null } }, listings: { [UP]: list("a.txt"), [LOW]: list("sub/") } });
  const cx = fakeCx(), self = panel();
  self.refresh(cx);
  const tree = await show(self, cx);
  handler(byId(tree, "local-file-sub"), "on_mouse_down")({}, cx);
  const p = log.overlays.at(-1).props;
  assert.equal(p.machine, null);
  assert.equal(p.root, LOW);
  assert.equal(p.tree, "pinned");
  assert.equal(p.folder, `${LOW}/sub`);
  const up = byId(tree, "file-a.txt");
  handler(up, "on_mouse_down")({}, cx);
  assert.equal(log.overlays.at(-1).props.tree, "follow");
  assert.equal(log.overlays.at(-1).props.machine, "box");
  // the menu copy: Paste asks for this computer
  store["filer-pro.clipboard"] = { machine: "box", items: [{ path: "/home/u/project/a.txt", isDir: false }], at: 1 };
  host({ props: { overlay: "m1", view: "menu", tree: "pinned", root: LOW, path: `${LOW}/sub`, isDir: true, folder: `${LOW}/sub` }, store });
  const menu = Object.create(FilerPro.prototype), mcx = fakeCx();
  const paste = byId(menu.overlayView(mcx), "filer-pro-menu-paste");
  assert.ok(paste, "the menu has Paste");
  const reqs = [];
  menu.request = (r) => reqs.push(r);
  handler(paste, "on_click")({}, mcx);
  assert.deepEqual(reqs, [{ action: "paste", folder: `${LOW}/sub`, root: LOW }]);
});

test("#101 a missing lower folder shows its error", async () => {
  host({ store: { [KEY]: { shown: true, root: "/gone", sizes: null } }, listings: { [UP]: list("a.txt") }, fail: { "/gone": "No such file or directory" } });
  const cx = fakeCx(), self = panel();
  self.refresh(cx);
  const tree = await show(self, cx);
  assert.ok(texts(byId(tree, "files-tree-local")).some((x) => /No such file or directory/.test(x)));
});

test("#101 a file opened from the lower tree hides both trees; back shows both at their old height", async () => {
  host({ store: { [KEY]: { shown: true, root: null, sizes: null } }, listings: { [UP]: list("a.txt"), [LOW]: list("notes.txt") } });
  const cx = fakeCx(), self = panel();
  self.refresh(cx);
  const tree0 = await show(self, cx);
  handler(byId(tree0, "local-file-notes.txt"), "on_click")({ modifiers: {}, click_count: 1 }, cx);
  await settle();
  assert.equal(self.fileSide().tree, self.trees.pinned);
  const tree = self.render(cx);
  for (const id of ["files-tree", "files-tree-local"]) {
    const t = byId(tree, id);
    assert.ok(t, id);
    assert.deepEqual(called(t, "h"), [[0]]);
    assert.equal(t.kids.filter((k) => k.calls.some(([n]) => n === "h")).length, 1, "one spacer");
  }
  assert.deepEqual(called(byId(tree, "files-split-frame"), "h"), [[0]]);
  self.show(null, cx);
  const back = self.render(cx);
  for (const id of ["files-tree", "files-tree-local"]) assert.equal(called(byId(back, id), "flex_1").length, 1, id);
  const row = byId(back, "local-file-notes.txt");
  assert.ok(called(row, "bg").some(([c]) => c === "selected"));
  assert.ok(!called(byId(back, "file-a.txt"), "bg").some(([c]) => c === "selected"));
});

test("#101 both trees watch their own folder; hiding the lower tree ends its loop", async () => {
  const { log, store } = host({ machine: null, store: { [KEY]: { shown: true, root: null, sizes: null } }, listings: { [UP]: list("a.txt"), [LOW]: list("b.txt") } });
  const cx = fakeCx(), self = panel();
  self.refresh(cx);
  await show(self, cx);
  assert.deepEqual([...new Set(log.watched)].sort(), [LOW, UP].sort());
  store[KEY] = { shown: false, root: null, sizes: null };
  self.render(cx);
  assert.equal(self.trees.pinned.context, null);
});

const SHOWN = { shown: true, root: null, sizes: null };
const iconOf = (line) => [...walk(line)].filter((e) => e.kind === "svg").map((e) => e.args[0]);
const idsIn = (el) => ids(el);

test("#101 #112 split: server + machine above, laptop + This Mac below, each with its own navigation and Folder actions", async () => {
  host({ store: { [KEY]: SHOWN }, listings: { [UP]: list("a.txt"), [LOW]: list("b.txt") } });
  const cx = fakeCx(), self = panel();
  self.refresh(cx);
  const tree = await show(self, cx);
  const up = byId(tree, "files-line"), low = byId(tree, "local-files-line");
  assert.ok(iconOf(up)[0].endsWith("/server.svg"));
  assert.ok(texts(up).includes("box"));
  assert.deepEqual(idsIn(up).filter((id) => !id.endsWith("-line") && !id.endsWith("-line-path")), ["files-top", "files-back-terminal", "files-up", "files-actions"]);
  assert.ok(iconOf(low)[0].endsWith("/laptop.svg"));
  assert.ok(texts(low).includes("This Mac"));
  assert.deepEqual(idsIn(low).filter((id) => !id.endsWith("-line") && !id.endsWith("-line-path")), ["local-files-top", "local-files-up", "local-files-actions", "local-files-close"]);
  const header = idsIn(byId(tree, "files")).slice(0, idsIn(byId(tree, "files")).indexOf("files-split-frame"));
  assert.deepEqual(header.slice(1), ["files-refresh", "files-local-toggle", "files-settings"]);
});

test("#112 one machine tree: the header has Refresh, the toggle and the gear; the location line has the navigation and Folder actions", async () => {
  host({ listings: { [UP]: list("a.txt") } });
  const cx = fakeCx(), self = panel();
  self.refresh(cx);
  await settle();
  const tree = self.render(cx);
  const line = byId(tree, "files-line");
  assert.ok(iconOf(line)[0].endsWith("/server.svg"));
  assert.ok(texts(line).includes("box"));
  assert.deepEqual(idsIn(line).filter((id) => !id.endsWith("-line") && !id.endsWith("-line-path")), ["files-top", "files-back-terminal", "files-up", "files-actions"]);
  const header = idsIn(tree).slice(0, idsIn(tree).indexOf("files-line"));
  assert.deepEqual(header.slice(1), ["files-refresh", "files-local-toggle", "files-settings"]);
  assert.deepEqual(argsOf(byId(tree, "files-refresh"), "tooltip")[0], ["Refresh all trees"]);
  assert.deepEqual(argsOf(byId(tree, "files-actions"), "tooltip")[0], ["Folder actions"]);
  assert.ok(iconOf(byId(tree, "files-actions"))[0].endsWith("/ellipsis.svg"));
});

test("#112 local terminal: laptop + This Mac, Back stays, no close button", async () => {
  host({ machine: null, listings: { [UP]: list("a.txt") } });
  const cx = fakeCx(), self = panel();
  self.refresh(cx);
  await settle();
  const tree = self.render(cx);
  const line = byId(tree, "files-line");
  assert.ok(iconOf(line)[0].endsWith("/laptop.svg"));
  assert.ok(texts(line).includes("This Mac"));
  assert.deepEqual(idsIn(line).filter((id) => !id.endsWith("-line") && !id.endsWith("-line-path")), ["files-top", "files-back-terminal", "files-up", "files-actions"]);
  assert.deepEqual(idsIn(tree).slice(1, idsIn(tree).indexOf("files-line")), ["files-refresh", "files-local-toggle", "files-settings"]);
});

test("#112 Refresh in the header reloads every shown tree and drops their sizes", async () => {
  const { log, store } = host({ store: { [KEY]: SHOWN }, listings: { [UP]: list("a.txt"), [LOW]: list("b.txt") } });
  const cx = fakeCx(), self = panel();
  self.refresh(cx);
  const tree = await show(self, cx);
  store["filer-pro.sizes"] = { [sizeKey(null, `${LOW}/x`)]: { state: "done", bytes: 5, at: Date.now() }, [sizeKey("box", `${UP}/y`)]: { state: "done", bytes: 6, at: Date.now() } };
  const upBefore = listsOf(log, UP).length, lowBefore = listsOf(log, LOW).length;
  handler(byId(tree, "files-refresh"), "on_click")({}, cx);
  await settle();
  assert.ok(listsOf(log, LOW).length > lowBefore);
  assert.ok(log.execs.filter((e) => e.args?.[3] === UP).length > 0 && listsOf(log, UP).length >= upBefore);
  assert.equal(Object.keys(store["filer-pro.sizes"]).length, 0);
});

test("#112 Folder actions opens the folder menu of its own tree, the same as the free-area menu", async () => {
  const { log } = host({ store: { [KEY]: SHOWN }, listings: { [UP]: list("a.txt"), [LOW]: list("b.txt") } });
  const cx = fakeCx(), self = panel();
  self.refresh(cx);
  const tree = await show(self, cx);
  for (const [btn, area, want] of [["files-actions", "files-tree", { tree: "follow", machine: "box", root: UP }], ["local-files-actions", "files-tree-local", { tree: "pinned", machine: null, root: LOW }]]) {
    log.overlays.length = 0;
    handler(byId(tree, btn), "on_click")({}, cx);
    handler(byId(tree, area), "on_mouse_down")({}, cx);
    const [a, b] = log.overlays;
    assert.deepEqual(a, b);
    assert.deepEqual({ scope: a.props.scope, tree: a.props.tree, machine: a.props.machine ?? null, root: a.props.root, folder: a.props.folder, hidden: a.props.hidden }, { scope: "root", ...want, folder: want.root, hidden: false });
  }
  log.overlays.length = 0;
  handler(byId(tree, "files-actions"), "on_click")({}, cx);
  handler(byId(tree, "local-files-actions"), "on_click")({}, cx);
  // machine tree: Upload Folder… (Upload File… needs pickFiles), New Folder…, Paste, Open in, Select Files, Show Hidden Files
  assert.equal(log.overlays[0].height, 12 + 6 * 28 + 3 * 7);
  // This Mac: New Folder…, Paste, Show in Finder, Open in, Select Files, Show Hidden Files
  assert.equal(log.overlays[1].height, 12 + 6 * 28 + 2 * 7);
});

test("#101 the toggle sits left of the gear and does not move when the lower tree opens", async () => {
  const { store } = host({ listings: { [UP]: list("a.txt"), [LOW]: list("b.txt") } });
  const cx = fakeCx(), self = panel();
  self.refresh(cx);
  await settle();
  const at = (tree) => { const l = idsIn(tree); return l.indexOf("files-settings") - l.indexOf("files-local-toggle"); };
  const before = at(self.render(cx));
  store[KEY] = SHOWN;
  assert.equal(at(await show(self, cx)), before);
  assert.equal(before, 1);
});

test("#101 upper tree local: laptop + This Mac in both lines", async () => {
  host({ machine: null, store: { [KEY]: SHOWN }, listings: { [UP]: list("a.txt"), [LOW]: list("b.txt") } });
  const cx = fakeCx(), self = panel();
  self.refresh(cx);
  const tree = await show(self, cx);
  for (const id of ["files-line", "local-files-line"]) {
    assert.ok(iconOf(byId(tree, id))[0].endsWith("/laptop.svg"), id);
    assert.ok(texts(byId(tree, id)).includes("This Mac"), id);
  }
});

test("#101 Show as Root from the lower tree's menu moves only the lower tree, also when both trees show the folder", async () => {
  for (const which of ["pinned", "follow"]) {
    const { store, log } = host({ machine: null, folder: LOW, terminal: true, store: { [KEY]: SHOWN }, listings: { [UP]: list("a.txt"), [LOW]: list("sub/"), [`${LOW}/sub`]: list("c.txt") } });
    const cx = fakeCx(), self = panel();
    self.refresh(cx);
    await show(self, cx);
    const upperRoot = self.trees.follow.root;
    // the menu copy
    host({ machine: null, folder: LOW, store, props: { overlay: "m1", view: "menu", tree: which, root: LOW, path: `${LOW}/sub`, isDir: true, folder: `${LOW}/sub` } });
    const menu = Object.create(FilerPro.prototype), mcx = fakeCx();
    handler(byId(menu.overlayView(mcx), "filer-pro-menu-show-as-root"), "on_click")({}, mcx);
    assert.equal(store["filer-pro.goto"].tree, which);
    host({ machine: null, folder: LOW, terminal: true, store, listings: { [LOW]: list("sub/"), [`${LOW}/sub`]: list("c.txt") } });
    self.render(cx);
    await settle();
    if (which === "pinned") {
      assert.equal(self.trees.pinned.root, `${LOW}/sub`);
      assert.equal(self.trees.follow.root, upperRoot);
      assert.equal(store[KEY].root, `${LOW}/sub`);
    } else {
      assert.equal(self.trees.follow.root, `${LOW}/sub`);
      assert.equal(self.trees.pinned.root, LOW);
    }
    void log;
  }
});

test("#101 Calculate Size in the lower tree: claimed once, shown in both trees when both show the folder", async () => {
  const { log, store } = host({ machine: null, folder: LOW, store: { [KEY]: SHOWN }, listings: { [LOW]: list("sub/") } });
  const cx = fakeCx(), self = panel();
  self.refresh(cx);
  await show(self, cx);
  store["filer-pro.sizes"] = requestSize(store["filer-pro.sizes"], null, `${LOW}/sub`, "id1", Date.now());
  self.pollSizes(cx);
  await settle();
  assert.equal(log.execs.filter((e) => e.args?.[1] === SIZE_SCRIPT).length, 1);
  self.pollSizes(cx);
  await settle();
  assert.equal(log.execs.filter((e) => e.args?.[1] === SIZE_SCRIPT).length, 1, "claimed once");
  const tree = self.render(cx);
  assert.ok(texts(byId(tree, "file-sub-size")).length + [...walk(byId(tree, "file-sub-size"))].length > 0);
  const a = texts(byId(tree, "file-sub-size")).join(""), b = texts(byId(tree, "local-file-sub-size")).join("");
  assert.equal(a, b);
  assert.notEqual(a, "—");
});

// A selection is in one tree at a time, also after a switch of terminal restores the upper tree's saved selection.
const MULTI = { multi_select: true, select_toggle_click: "cmd", select_range_click: "shift" };
const CMD = { modifiers: { platform: true }, click_count: 1 };
async function twoTrees(cfg = {}) {
  const h = host({ store: { [KEY]: { shown: true, root: null, sizes: null } }, listings: { [UP]: list("a.txt"), [LOW]: list("p.txt"), "/srv": list("c.txt") } });
  const cx = fakeCx(), self = panel({ ...MULTI, ...cfg });
  self.refresh(cx);
  await show(self, cx);
  return { ...h, cx, self };
}
const names = (tree) => [...(tree.selected ?? [])].sort();
const barOf = (root) => byId(root, "files-selection-count")?.kids;

test("#103 after a terminal switch the lower tree's live selection stays the only one; the bar follows it", async () => {
  const { self, cx, state } = await twoTrees();
  handler(byId(self.render(cx), "file-a.txt"), "on_click")(CMD, cx);
  state.folder = "/srv"; await show(self, cx);
  handler(byId(self.render(cx), "local-file-p.txt"), "on_click")(CMD, cx);
  assert.deepEqual(names(self.trees.pinned), ["p.txt"]);
  state.folder = UP; const root = await show(self, cx);
  assert.deepEqual(names(self.trees.follow), []);
  assert.deepEqual(names(self.trees.pinned), ["p.txt"]);
  assert.equal(self.selectionTree(), self.trees.pinned);
  assert.deepEqual(barOf(root), ["1 selected"]);
});

test("#103 a restored selection or checkbox mode of the upper tree gives way to the lower tree's live one", async () => {
  const { self, cx, state } = await twoTrees();
  handler(byId(self.render(cx), "file-a.txt"), "on_click")(CMD, cx);
  state.folder = "/srv"; await show(self, cx);
  self.trees.pinned.selecting = true;
  state.folder = UP; await show(self, cx);
  assert.equal(self.trees.pinned.selecting, true);
  assert.deepEqual(names(self.trees.follow), []);
  assert.equal(self.selectionTree(), self.trees.pinned);
  // checkbox mode saved in the upper tree, a selection in the lower one
  self.trees.pinned.selecting = false;
  self.trees.follow.selecting = true; self.clearSelected(self.trees.follow);
  state.folder = "/srv"; await show(self, cx);
  handler(byId(self.render(cx), "local-file-p.txt"), "on_click")(CMD, cx);
  state.folder = UP; await show(self, cx);
  assert.equal(self.trees.follow.selecting, false);
  assert.deepEqual(names(self.trees.pinned), ["p.txt"]);
  assert.equal(self.selectionTree(), self.trees.pinned);
});

test("#103 bar in the lower tree: count and Clear act on the lower tree", async () => {
  const { self, cx } = await twoTrees();
  handler(byId(self.render(cx), "local-file-p.txt"), "on_click")(CMD, cx);
  const root = self.render(cx);
  assert.deepEqual(barOf(root), ["1 selected"]);
  assert.equal(self.selectionTree(), self.trees.pinned);
  handler(byId(root, "files-selection-clear"), "on_click")({}, cx);
  assert.deepEqual(names(self.trees.pinned), []);
  assert.equal(barOf(self.render(cx)), undefined);
});

test("#101 a changed local_tree_folder resets the lower tree's root, also after navigating; an unchanged one does not", async () => {
  const { store } = host({ store: { [KEY]: { shown: true, root: null, sizes: null } }, listings: { [UP]: list("a.txt"), [LOW]: list("b.txt"), [INBOX]: list("c.txt"), "/Users/example": list("x/") } });
  const cx = fakeCx(), self = panel();
  self.refresh(cx);
  await show(self, cx);
  assert.equal(store[KEY].seed, LOW);
  self.navigate("/Users/example", cx, self.trees.pinned);
  await show(self, cx);
  assert.equal(self.trees.pinned.root, "/Users/example");
  await show(self, cx);
  assert.equal(self.trees.pinned.root, "/Users/example", "the same setting keeps the navigated root");
  self.cfg.local_tree_folder = INBOX;
  await show(self, cx);
  assert.equal(self.trees.pinned.root, INBOX);
  assert.equal(store[KEY].root, null);
  assert.equal(store[KEY].seed, INBOX);
  self.navigate("/Users/example", cx, self.trees.pinned);
  await show(self, cx);
  assert.equal(self.trees.pinned.root, "/Users/example", "navigating again sticks");
});

const argsOf = (el, name) => el.calls.filter(([k]) => k === name).map(([, ...a]) => a);
const sizesOf = (line) => ({
  own: ["h", "px", "gap", "text_size"].map((k) => argsOf(line, k)[0]),
  icons: [...walk(line)].filter((e) => e.kind === "svg").map((e) => argsOf(e, "size")[0]),
  buttons: [...walk(line)].filter((e) => e.kind === "div" && /^(local-)?files-(top|up|actions|back-terminal|close)$/.test(idOf(e) ?? "")).map((e) => [argsOf(e, "w")[0], argsOf(e, "h")[0]]),
});

test("#101 both location lines are built with the same size parameters (height, padding, gap, text, glyphs, buttons)", async () => {
  for (const machine of ["box", null]) {
    host({ machine, store: { [KEY]: SHOWN }, listings: { [UP]: list("a.txt"), [LOW]: list("b.txt") } });
    const cx = fakeCx(), self = panel();
    self.refresh(cx);
    const tree = await show(self, cx);
    const up = sizesOf(byId(tree, "files-line")), low = sizesOf(byId(tree, "local-files-line"));
    assert.deepEqual(up.own, [[26], [14], [6], [12]]);
    assert.deepEqual(up.own, low.own);
    assert.deepEqual(up.icons, low.icons.slice(0, up.icons.length));
    assert.ok(up.buttons.length >= 3 && up.buttons.every(([w, h]) => w[0] === 20 && h[0] === 20));
    assert.deepEqual(low.buttons.map(([w]) => w), low.buttons.map(() => [20]));
  }
});

test("#101 the lower line ends in a x that hides the lower tree like the header toggle", async () => {
  const { store } = host({ store: { [KEY]: SHOWN }, listings: { [UP]: list("a.txt"), [LOW]: list("b.txt") } });
  const cx = fakeCx(), self = panel();
  self.refresh(cx);
  const tree = await show(self, cx);
  const low = byId(tree, "local-files-line");
  assert.equal(idsIn(low).at(-1), "local-files-close");
  assert.ok(!idsIn(byId(tree, "files-line")).includes("local-files-close"));
  const close = byId(tree, "local-files-close");
  assert.ok(iconOf(close)[0].endsWith("/x.svg"));
  assert.deepEqual(argsOf(close, "tooltip")[0], ["Hide This Mac"]);
  handler(close, "on_click")({}, cx);
  assert.equal(store[KEY].shown, false);
  assert.equal(byId(self.render(cx), "local-files-line"), undefined);
  assert.ok(byId(self.render(cx), "files-line"), "the upper line stays (#112)");
  assert.equal(argsOf(byId(self.render(cx), "files-local-toggle"), "tooltip")[0][0], "Show This Mac");
  handler(byId(self.render(cx), "files-local-toggle"), "on_click")({}, cx);
  assert.equal(store[KEY].shown, true);
});
