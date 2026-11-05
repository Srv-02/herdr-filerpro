// Issue #14: how mods/filer-pro/main.js shows and opens macOS packages. main.js is loaded with stubbed host modules (as in
// test/settings-main.test.js); the builders record their calls so the drawn rows can be searched and clicked.
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
const DEFAULTS = { ...numbers(null), node_path: "", svg_check: true };
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

test("local tree on macOS: packages are file rows among the files, developer packages and folders stay folders", async () => {
  host();
  const cx = fakeCx();
  const self = await loaded(cx);
  const tree = self.render(cx);
  assert.deepEqual(rowNames(tree), ["src", "Tool.xcodeproj", "a.txt", "Example.app", "Setup.PKG"], "folders first, packages sorted with the files");
  const app = byId(tree, "file-Example.app"), pkg = byId(tree, "file-Setup.PKG");
  assert.equal(chevron(app), undefined, "no chevron");
  assert.equal(chevron(pkg), undefined);
  assert.ok(chevron(byId(tree, "file-Tool.xcodeproj")), "a developer package keeps its chevron");
  assert.ok(chevron(byId(tree, "file-src")));
  assert.equal(iconOf(app), "mods/filer-pro/icons/exe.svg");
  assert.equal(iconOf(pkg), "mods/filer-pro/icons/zip.svg");
});

test("a single click on a package only marks its row; it neither opens, expands nor previews", async () => {
  const { log } = host();
  const cx = fakeCx();
  const self = await loaded(cx);
  log.execs.length = 0;
  handler(byId(self.render(cx), "file-Example.app"), "on_click")({ modifiers: {}, click_count: 1 }, cx);
  await settle();
  assert.deepEqual(log.execs, [], "nothing ran");
  assert.equal(self.lastOpened, "Example.app", "the row is marked");
  assert.deepEqual(byId(self.render(cx), "file-Example.app").calls.filter(([k]) => k === "bg"), [["bg", "selected"]]);
  assert.equal(self.folders.has("Example.app"), false);
  assert.equal(self.file, null, "the viewer stays closed");
  assert.deepEqual(log.reads, [], "the package is never read as a file");
});

test("a double click on a package opens it with open (resolved, checked), once", async () => {
  const { log } = host();
  const cx = fakeCx();
  const self = await loaded(cx);
  log.execs.length = 0;
  // GPUI reports a double click as two clicks: click_count 1, then 2.
  const row = () => handler(byId(self.render(cx), "file-Example.app"), "on_click");
  row()({ modifiers: {}, click_count: 1 }, cx);
  row()({ modifiers: {}, click_count: 2 }, cx);
  await settle();
  assert.deepEqual(execsOf(log, OPEN_BUNDLE_SCRIPT).map((e) => e.args), [["-c", OPEN_BUNDLE_SCRIPT, "sh", `${ROOT}/Example.app`, "open"]]);
  assert.equal(log.execs.length, 1, "nothing else ran");
  // A third press of a triple click does not start it a second time.
  row()({ modifiers: {}, click_count: 3 }, cx);
  await settle();
  assert.equal(log.execs.length, 1);
  assert.equal(self.folders.has("Example.app"), false);
  assert.equal(self.file, null);
});

test("files and folders still act on a single click", async () => {
  host();
  const cx = fakeCx();
  const self = await loaded(cx);
  handler(byId(self.render(cx), "file-src"), "on_click")({ modifiers: {}, click_count: 1 }, cx);
  assert.equal(self.folders.has("src"), true, "a folder expands");
  handler(byId(self.render(cx), "file-a.txt"), "on_click")({ modifiers: {}, click_count: 1 }, cx);
  assert.equal(self.file, "a.txt", "a file opens in the viewer");
});

test("Cmd+click on a package still reveals it in the Finder", async () => {
  const { log } = host();
  const cx = fakeCx();
  const self = await loaded(cx);
  log.execs.length = 0;
  handler(byId(self.render(cx), "file-Example.app"), "on_click")({ modifiers: { platform: true }, click_count: 1 }, cx);
  assert.deepEqual(log.execs.map((e) => [e.cmd, e.args]), [["open", ["-R", `${ROOT}/Example.app`]]]);
});

test("on a machine and on Linux the same folders are plain folders", async () => {
  for (const opts of [{ machine: "server" }, { platform: "linux" }]) {
    host(opts);
    const cx = fakeCx();
    const self = await loaded(cx);
    const tree = self.render(cx);
    assert.deepEqual(rowNames(tree), ["Example.app", "Setup.PKG", "src", "Tool.xcodeproj", "a.txt"], JSON.stringify(opts));
    assert.ok(chevron(byId(tree, "file-Example.app")), "a chevron");
    handler(byId(tree, "file-Example.app"), "on_click")({ modifiers: {} }, cx);
    assert.equal(self.folders.has("Example.app"), true, "a click expands it");
  }
});

test("the row menu of a package gets bundle props, its parent as paste target, and room for the extra entry", async () => {
  const { log } = host();
  const cx = fakeCx();
  const self = await loaded(cx);
  handler(byId(self.render(cx), "file-Example.app"), "on_mouse_down", "right")({}, cx);
  const o = log.overlays.at(-1);
  assert.equal(o.props.view, "menu");
  assert.equal(o.props.path, `${ROOT}/Example.app`);
  assert.equal(o.props.isDir, true, "copy, cut and delete still treat it as a folder");
  assert.equal(o.props.bundle, true);
  assert.equal(o.props.contents, false);
  assert.equal(o.props.folder, ROOT, "paste and new folder land beside it, as for a file");
  assert.equal(o.height, menuHeight(rowMenuItems({ paste: { enabled: false }, isDir: true, bundle: true })));
  handler(byId(self.render(cx), "file-src"), "on_mouse_down", "right")({}, cx);
  assert.equal(log.overlays.at(-1).props.bundle, false);
  assert.equal(log.overlays.at(-1).height, menuHeight(rowMenuItems({ paste: { enabled: false } })));
});

test("a drop onto a closed package lands in its folder, onto shown package contents inside it", async () => {
  const { log } = host();
  const cx = fakeCx();
  const self = await loaded(cx);
  handler(byId(self.render(cx), "file-Example.app"), "on_drop")({ paths: ["/Users/example/x.txt"] }, cx);
  await settle();
  assert.equal(JSON.parse(log.writes.at(-1).text).folder, ROOT);
  self.showPackage("Example.app", true, cx);
  handler(byId(self.render(cx), "file-Example.app"), "on_drop")({ paths: ["/Users/example/x.txt"] }, cx);
  await settle();
  assert.equal(JSON.parse(log.writes.at(-1).text).folder, `${ROOT}/Example.app`);
});

test("menu: Open runs open on the package, Open on a file keeps the regular-file check", async () => {
  const props = { overlay: "menu1", view: "menu", root: ROOT, path: `${ROOT}/Example.app`, isDir: true, bundle: true, folder: ROOT };
  const { log } = host({ props });
  const cx = fakeCx();
  const self = Object.create(FilerPro.prototype);
  handler(byId(self.overlayView(cx), "filer-pro-menu-open"), "on_click")({}, cx);
  await settle();
  assert.deepEqual(execsOf(log, OPEN_BUNDLE_SCRIPT).map((e) => e.args.slice(3)), [[`${ROOT}/Example.app`, "open"]]);
  assert.deepEqual(execsOf(log, OPEN_CHECK_SCRIPT), []);
  assert.deepEqual(log.closed, ["menu1"]);
  assert.equal(byId(self.overlayView(cx), "filer-pro-menu-open-preview").calls.some(([k]) => k === "on_click"), false, "Open in Preview is dimmed");
});

test("menu: Show Package Contents asks the panel to expand the package, Hide collapses it again", async () => {
  const props = { overlay: "menu1", view: "menu", root: ROOT, path: `${ROOT}/Example.app`, isDir: true, bundle: true, folder: ROOT };
  const { log, store } = host({ props });
  const cx = fakeCx();
  const menu = Object.create(FilerPro.prototype);
  const item = byId(menu.overlayView(cx), "filer-pro-menu-package-contents");
  assert.equal(item.kids.at(-1), "Show Package Contents");
  handler(item, "on_click")({}, cx);
  const req = store["filer-pro.package"];
  assert.deepEqual({ ...req, id: undefined }, { id: undefined, machine: null, path: `${ROOT}/Example.app`, show: true });
  assert.ok(req.id);
  assert.deepEqual(log.closed, ["menu1"]);

  // The panel picks it up at its next render: the package is a folder with a chevron, its contents load.
  globalThis.__impl.props = () => ({});
  const self = await loaded(cx);
  store["filer-pro.package"] = { ...req, id: "p2" };
  self.render(cx);
  await settle();
  assert.equal(self.packages.has("Example.app"), true);
  assert.equal(self.folders.has("Example.app"), true);
  let tree = self.render(cx);
  assert.ok(chevron(byId(tree, "file-Example.app")), "shown as a folder now");
  assert.match(iconOf(byId(tree, "file-Example.app")), /-open\.svg$/, "an open folder icon");
  assert.ok(log.execs.some((e) => e.args[1] === LIST_SCRIPT && e.args[3] === `${ROOT}/Example.app`), "contents listed");

  // Collapsing with the chevron (a click on the row) turns it back into a file row; a double click opens it again.
  handler(byId(tree, "file-Example.app"), "on_click")({ modifiers: {} }, cx);
  assert.equal(self.packages.has("Example.app"), false);
  assert.equal(self.folders.has("Example.app"), false);
  tree = self.render(cx);
  assert.equal(chevron(byId(tree, "file-Example.app")), undefined);

  // Hide Package Contents from the menu collapses it too; the same id is applied only once.
  self.showPackage("Example.app", true, cx);
  store["filer-pro.package"] = { id: "p3", machine: null, path: `${ROOT}/Example.app`, show: false };
  self.render(cx);
  await settle();
  assert.equal(self.folders.has("Example.app"), false);
  self.showPackage("Example.app", true, cx);
  self.render(cx);
  await settle();
  assert.equal(self.folders.has("Example.app"), true, "p3 is not applied twice");
});

test("a package request for another machine or outside the shown folder is ignored", async () => {
  const { store } = host();
  const cx = fakeCx();
  const self = await loaded(cx);
  store["filer-pro.package"] = { id: "x1", machine: "server", path: `${ROOT}/Example.app`, show: true };
  self.render(cx);
  store["filer-pro.package"] = { id: "x2", machine: null, path: "/elsewhere/Example.app", show: true };
  self.render(cx);
  await settle();
  assert.deepEqual([...self.packages], []);
  assert.equal(self.folders.has("Example.app"), false);
});

test("shown package contents are kept per location", async () => {
  host();
  const cx = fakeCx();
  const self = await loaded(cx);
  self.showPackage("Example.app", true, cx);
  globalThis.__impl.spaces = () => [{ active: true, id: "s1", folder: "/Users/example/other", machine: null }];
  self.refresh(cx);
  assert.deepEqual([...self.packages], []);
  globalThis.__impl.spaces = () => [{ active: true, id: "s1", folder: ROOT, machine: null }];
  self.refresh(cx);
  assert.deepEqual([...self.packages], ["Example.app"]);
});

test("rename of a package selects the name without the extension", async () => {
  const props = { overlay: "menu1", view: "menu", root: ROOT, path: `${ROOT}/Example.app`, isDir: true, bundle: true, folder: ROOT };
  const { log } = host({ props });
  const cx = fakeCx();
  handler(byId(Object.create(FilerPro.prototype).overlayView(cx), "filer-pro-menu-rename"), "on_click")({}, cx);
  assert.equal(log.overlays.at(-1).props.view, "rename");
  assert.equal(log.overlays.at(-1).props.isDir, false, "selected like a file name: Example");
});

test("an open request for a package does not read it as a file", async () => {
  const { log } = host();
  const cx = fakeCx();
  const self = await loaded(cx);
  self.show("Example.app", cx);
  await settle();
  assert.deepEqual(log.reads.filter((p) => p.includes("Example.app")), []);
  assert.match(self.fileError, /package/i);
});

// The real host throws when render calls cx.notify() (gpui-kit.d.ts Context.notify); the panel's render has to stay
// free of it, else Show and Hide Package Contents flash an error toast.
function renderCx() {
  const cx = fakeCx();
  cx.notify = () => { throw new Error("cx.notify() is not allowed during the `render` phase; request a re-render from an event handler instead"); };
  return cx;
}

test("Show and Hide Package Contents are applied without cx.notify() during render", async () => {
  const { store } = host();
  const self = await loaded(fakeCx());
  let notified = 0;
  const rcx = renderCx();
  rcx.spawn = (fn) => { const a = { ...fakeCx(), notify: () => { notified++; } }; const p = Promise.resolve().then(() => fn(a)); p.catch(() => {}); return p; };
  store["filer-pro.package"] = { id: "r1", machine: null, path: `${ROOT}/Example.app`, show: true };
  self.render(rcx);
  await settle();
  assert.equal(self.folders.has("Example.app"), true, "shown");
  assert.ok(notified > 0, "redrawn from a task");
  store["filer-pro.package"] = { id: "r2", machine: null, path: `${ROOT}/Example.app`, show: false };
  notified = 0;
  self.render(rcx);
  await settle();
  assert.equal(self.folders.has("Example.app"), false, "hidden again");
  assert.ok(notified > 0, "redrawn from a task");
});
