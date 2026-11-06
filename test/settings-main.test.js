// Issue #3: how mods/filer-pro/main.js applies the settings (list limits, tree depth, refresh interval, the dialog's
// change signal, keep_done_seconds, the preview limits) and drives the settings dialog. main.js is loaded with stubbed
// host modules (as in test/tree-scroll.test.js); the builders record their calls so the drawn tree can be searched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import fs from "node:fs/promises";
import { LIST_SCRIPT } from "../mods/filer-pro/lib/tree.js";
import { numbers } from "../mods/filer-pro/lib/settings.js";

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
  "gpui-base": `${make(["v_flex", "h_flex", "TextView"])} export const Input = { new: () => globalThis.__make("input") }, Scrollbar = { vertical: () => globalThis.__make("scrollbar") };
export class Editor { static new() { return globalThis.__make("editor"); } } export class EditorState {}
export class InputState { static new(o) { const s = new InputState(); s.v = o.value; s.handlers = {}; return s; }
  on(ev, fn) { this.handlers[ev] = fn; } value() { return this.v; } set_value(v) { this.v = v; } focus() {} type(v, cx) { this.v = v; this.handlers.change?.({}, cx); } }`,
  "fs/promises": `${stub(["exists"])} export const readFile = async () => "", writeFile = async () => {}, mkdir = readFile, unlink = readFile, stat = readFile;`,
};
const hooks = `export async function resolve(s, c, next) { return s in ${JSON.stringify(STUBS)} ? { url: "stub:" + s, shortCircuit: true } : next(s, c); }
export async function load(u, c, next) { return u.startsWith("stub:") ? { format: "module", shortCircuit: true, source: ${JSON.stringify(STUBS)}[u.slice(5)] } : next(u, c); }`;
register("data:text/javascript," + encodeURIComponent(hooks));
const FilerPro = (await import("../mods/filer-pro/main.js")).default;

const never = () => new Promise(() => {});
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const DEFAULTS = { ...numbers(null), node_path: "", svg_check: true, hide_system_files: true, hide_dotfiles: false };

// A fake host; `files` by path, shared values in `store`, every call logged.
function host({ files = {}, store = {}, platform = "macos", props = {} } = {}) {
  const log = { execs: [], writes: [], shared: [], overlays: [], closed: [], notes: [], fetches: [] };
  // A panel that init starts as lease holder runs the daily update pass with globalThis.fetch (main.js updatePass).
  // GitHub answers at once with "no release": a real request would land in the store of a later test (issue #24).
  globalThis.fetch = async (url) => { log.fetches.push(String(url)); return { status: 404 }; };
  globalThis.__impl = {
    props: () => props, appHome: () => "/app", home: () => "/home/u", window: () => ({ platform }),
    theme: () => new Proxy({}, { get: (_t, k) => String(k) }), settings: () => ({ dark: false, font_family: "mono" }),
    spaces: () => [{ active: true, id: "s1", folder: "/data", machine: null }], panes: () => [], focused: () => ({}),
    shared: (k) => store[k], setShared: (k, v) => { store[k] = v; log.shared.push([k, v]); },
    readTextFile: async (p) => { if (files[p] == null) throw new Error("ENOENT"); return files[p]; },
    writeTextFile: async (p, text, expected) => { log.writes.push({ p, text, expected }); if ((files[p] ?? null) !== expected) throw new Error("mismatch"); files[p] = text; },
    exec: async (cmd, args, opts) => { log.execs.push({ cmd, args, opts }); return { code: 0, stdout: "", stderr: "" }; },
    hc: async () => ({ code: 0, stdout: "{}", stderr: "" }),
    openOverlay: (o) => { log.overlays.push(o); return "ov1"; }, closeOverlay: (id) => log.closed.push(id),
    notify: (n) => log.notes.push(n), watchFolder: never, nextCommand: never, layout: () => ({}), exists: async () => false,
  };
  return { log, store, files };
}
function fakeCx() {
  const timers = [];
  const cx = { notify() {}, sleep: never, focus_handle: () => ({ focus() {} }), stop_propagation() {}, timer: { every: (ms, fn) => timers.push({ ms, fn }), after() {} },
    spawn: (fn) => { const p = Promise.resolve().then(() => fn(cx)); p.catch(() => {}); return p; } };
  return { cx, timers };
}
const panel = (cfg) => Object.assign(Object.create(FilerPro.prototype), { cfg: { ...DEFAULTS, ...cfg }, entries: new Map(), folders: new Set() });

// Every element of a drawn tree, depth first.
function* walk(e) {
  if (!e || typeof e !== "object") return;
  yield e;
  for (const k of e.kids ?? []) yield* walk(k);
}
const byId = (root, id) => [...walk(root)].find((e) => e.calls?.some(([k, a]) => k === "id" && a === id));
const click = (el, cx) => el.calls.find(([k]) => k === "on_click")[1]({}, cx);
const texts = (root) => [...walk(root)].flatMap((e) => (e.kids ?? []).filter((k) => typeof k === "string"));

test("settings: the folder listing gets list_per_folder, on Windows as -First N+1", async () => {
  const { log } = host();
  const self = panel({ list_per_folder: 20 }), context = { key: "k", cwd: "/data", on: null };
  Object.assign(self, { context });
  self.current = () => true;
  await self.loadFolder("", context);
  assert.deepEqual(log.execs[0].args, ["-c", LIST_SCRIPT, "files", "/data", "20", "1", "0"], "system files hidden by default, dot files shown");
  const win = host({ platform: "windows" });
  win.log.execs.length = 0;
  globalThis.__impl.exec = async (cmd, args) => { win.log.execs.push({ cmd, args }); return { code: 0, stdout: "[]", stderr: "" }; };
  await self.loadFolder("", context);
  assert.match(win.log.execs[0].args[2], /Select-Object -First 21 /);
});

test("settings: list limits cut the entries, tree_depth stops the rows, the limit text names the numbers", async () => {
  host();
  const self = panel({ list_per_folder: 10, list_total: 100, tree_depth: 1 }), context = { key: "k", cwd: "/data", on: null };
  globalThis.__impl.exec = async () => ({ code: 0, stdout: Array.from({ length: 11 }, (_, i) => `f\0n${i}\0`).join(""), stderr: "" });
  Object.assign(self, { context, limited: false });
  self.current = () => true;
  await self.loadFolder("", context);
  assert.equal(self.entries.get("").length, 10);
  assert.equal(self.limited, true);
  self.entries = new Map([["", [{ name: "a", dir: true }]], ["a", [{ name: "b", dir: true }]], ["a/b", [{ name: "c", dir: false }]]]);
  self.folders = new Set(["a", "a/b"]);
  assert.deepEqual(self.visible().map((r) => r.path), ["a", "a/b"], "depth 1: a/b shows, its content not");
  Object.assign(self, { reload: { signal: () => false, take: () => false }, saved: new Map(), jobs: {}, perf: null, root: "/data", on: null, file: null, marks: {} });
  self.context = { key: JSON.stringify({ cwd: "/data", on: null, space: "s1" }), cwd: "/data", on: null };
  const { cx } = fakeCx();
  self.limited = true;
  assert.ok(texts(self.render(cx)).includes("File list limited to 10 entries per folder and 100 total"));
});

test("settings: update_check false hides the update hint in the header at the next render", () => {
  const release = { at: 1, local: "1.0.0", latest: "v9.9.9" };
  const draw = (cfg) => {
    host({ files: { "/app/mods/filer-pro/mod.json": '{"version":"1.0.0"}' }, store: { "filer-pro.update": release } });
    const self = panel(cfg);
    Object.assign(self, { reload: { signal: () => false, take: () => false }, saved: new Map(), jobs: {}, perf: null, root: "/data", on: null, file: null, marks: {}, version: "1.0.0" });
    self.context = { key: JSON.stringify({ cwd: "/data", on: null, space: "s1" }), cwd: "/data", on: null };
    return texts(self.render(fakeCx().cx));
  };
  assert.ok(draw({ update_check: true }).includes("● 9.9.9 available"), "control: the hint shows while the check is on");
  assert.ok(!draw({ update_check: false }).some((t) => String(t).includes("available")), "no hint once update_check is false");
});

test("settings: the refresh tick follows refresh_seconds, and a saved dialog reloads the config at once", async () => {
  const h = host({ files: { "/app/filer-pro.json": '{"refresh_seconds": 5}', "/app/mods/filer-pro/mod.json": '{"version":"1.0.0"}' } });
  const { cx, timers } = fakeCx();
  const self = Object.create(FilerPro.prototype);
  self.init({}, cx);
  await settle();
  assert.equal(self.conf.refresh_seconds, 5);
  let reloads = 0;
  self.reloadConfig = () => { reloads++; };
  const tick = timers.find((t) => t.ms === 1000).fn;
  self.refreshedAt = Date.now() - 4000; tick(cx);
  assert.equal(reloads, 0);
  self.refreshedAt = Date.now() - 6000; tick(cx);
  assert.equal(reloads, 1);
  const fast = timers.find((t) => t.ms === 250).fn;
  fast(cx);
  assert.equal(reloads, 1, "no signal, no reload");
  h.store["filer-pro.config"] = { at: 42 };
  fast(cx); fast(cx);
  assert.equal(reloads, 2, "one reload per signal");
});

test("settings: reloadConfig reads the file again and refreshes the tree", async () => {
  const h = host({ files: { "/app/filer-pro.json": '{"list_total": 300}' } });
  const self = panel({});
  let refreshed = 0;
  self.refresh = () => { refreshed++; };
  const { cx } = fakeCx();
  self.reloadConfig(cx);
  await settle();
  assert.equal(self.conf.list_total, 300);
  assert.equal(refreshed, 1);
  h.files["/app/filer-pro.json"] = "{nope";
});

test("settings: finished transfers are cleared after keep_done_seconds", async () => {
  const now = Date.now();
  const h = host({ store: { "filer-pro.jobs": { a: { id: "a", state: "done", finishedAt: now - 6000 } } } });
  const run = async (cfg) => {
    const kept = [];
    const self = panel(cfg);
    self.jobs = { recover: async () => {}, tick: async () => {}, clearFinished: (k) => kept.push(k) };
    h.store["filer-pro.lease"] = undefined;
    const { cx, timers } = fakeCx();
    self.drive(cx);
    await settle();
    timers.find((t) => t.ms === 1000).fn(cx);
    return kept;
  };
  assert.deepEqual(await run({}), [], "10 s default: not yet");
  assert.deepEqual(await run({ keep_done_seconds: 5 }), [5000]);
});

test("settings: openSettings stores a snapshot and opens the modal dialog; a broken file is flagged", async () => {
  const h = host({ files: { "/app/filer-pro.json": '{"x":1,"terminal_editors":[{"name":"n","command":"nvim"}]}' } });
  await panel({}).openSettings();
  const snap = h.store["filer-pro.settings"];
  assert.deepEqual(snap.raw, { x: 1, terminal_editors: [{ name: "n", command: "nvim" }] });
  assert.equal(snap.broken, false);
  assert.equal(snap.config.list_total, 5000);
  assert.equal(snap.version, null, "no mod.json in this fake: no version");
  assert.equal(snap.configPath, "/app/filer-pro.json", "outside the home folder the path stays absolute");
  assert.equal(snap.home, "/home/u");
  assert.deepEqual(h.log.overlays[0], { mod: "filer-pro", props: { view: "settings" }, kind: "dialog", modal: true, width: 620, height: 0.86 });
  for (const text of ["{nope", "[1]"]) {
    const b = host({ files: { "/app/filer-pro.json": text } });
    await panel({}).openSettings();
    assert.equal(b.store["filer-pro.settings"].broken, true, text);
  }
  const none = host();
  await panel({}).openSettings();
  assert.deepEqual([none.store["filer-pro.settings"].raw, none.store["filer-pro.settings"].broken], [null, false]);
});

test("settings: the free-area menu opens the dialog and then closes itself", async () => {
  const h = host({ props: { overlay: "menu1", view: "menu", scope: "root", root: "/data", folder: "/data" } });
  const self = Object.create(FilerPro.prototype);
  const { cx } = fakeCx();
  const el = byId(self.overlayView(cx), "filer-pro-menu-settings");
  click(el, cx);
  await settle();
  assert.equal(h.log.overlays[0].props.view, "settings");
  assert.deepEqual(h.log.closed, ["menu1"]);
});

test("settings: the panel header has a gear with the tooltip Settings while no file is open", async () => {
  const h = host();
  const self = panel({});
  Object.assign(self, { reload: { signal: () => false, take: () => false }, saved: new Map(), jobs: {}, perf: null, root: "/data", on: null, file: null, marks: {} });
  self.context = { key: JSON.stringify({ cwd: "/data", on: null, space: "s1" }), cwd: "/data", on: null };
  const { cx } = fakeCx();
  const gear = byId(self.render(cx), "files-settings");
  assert.ok(gear.calls.some(([k, a]) => k === "tooltip" && a === "Settings"), "tooltip");
  assert.ok(gear.kids.some((k) => k.kind === "svg" && k.calls.some(([m, a]) => m === "size" && a === 14)), "a 14px icon");
  assert.ok(!texts(gear).includes("Settings"), "no text button any more");
  click(gear, cx);
  await settle();
  assert.equal(h.log.overlays[0].props.view, "settings");
  self.file = "a.txt";
  assert.equal(byId(self.render(cx), "files-settings"), undefined);
});

test("settings dialog in main.js: Save writes the changed key with expected, signals the panels and closes", async () => {
  const before = '{"mine":true}';
  const h = host({ props: { overlay: "dlg1", view: "settings" }, files: { "/app/filer-pro.json": before } });
  const { cx } = fakeCx();
  const opener = panel({});
  await opener.openSettings();
  const self = Object.create(FilerPro.prototype);
  self.init({}, cx);
  self.settings.fields.list_total.input.type("6000", cx);
  click(byId(self.overlayView(cx), "filer-pro-settings-save"), cx);
  await settle();
  assert.equal(h.log.writes.length, 1);
  assert.equal(h.log.writes[0].expected, before);
  assert.deepEqual(JSON.parse(h.files["/app/filer-pro.json"]), { mine: true, list_total: 6000 });
  assert.ok(h.store["filer-pro.config"]?.at > 0);
  assert.deepEqual(h.log.closed, ["dlg1"]);
});

test("settings dialog in main.js: an invalid field writes nothing and keeps the dialog open", async () => {
  const h = host({ props: { overlay: "dlg1", view: "settings" } });
  const { cx } = fakeCx();
  await panel({}).openSettings();
  const self = Object.create(FilerPro.prototype);
  self.init({}, cx);
  self.settings.fields.list_total.input.type("lots", cx);
  click(byId(self.overlayView(cx), "filer-pro-settings-save"), cx);
  await settle();
  assert.deepEqual(h.log.writes, []);
  assert.deepEqual(h.log.closed, []);
  assert.equal(h.store["filer-pro.config"], undefined);
  assert.ok(texts(self.overlayView(cx)).includes("Enter a whole number."));
  assert.equal(self.settings.advanced, true, "a wrong field in Advanced opens it");
});

test("settings: preview limits travel per call (source guard and loadLimits)", async () => {
  const main = await fs.readFile(new URL("../mods/filer-pro/main.js", import.meta.url), "utf8");
  const body = (name) => { const i = main.indexOf(`  ${name}(`); return main.slice(i, main.indexOf("\n  }\n", i)); };
  assert.ok(body("show").includes("cfg.source_max_chars") && !main.includes("400000"), "source truncation from the settings");
  assert.ok(body("show").includes("this.fileCfg = cfg") && body("async preparePreview").includes("cfg = this.fileCfg ?? DEFAULTS") && body("async preparePreview").includes("maxChars: cfg.preview_max_chars, maxDiagrams: cfg.max_diagrams"), "the preview with the settings the file was read with");
  assert.ok(body("show").includes("...this.loadLimits(cfg)") && body("turnPage").includes("...this.loadLimits()"), "images and PDFs, also when turning pages");
  assert.ok(body("renderDiagrams").includes("node: cfg.node_path") && body("renderDiagrams").includes("this.fileCfg"));
  const MB = 1024 * 1024;
  assert.deepEqual(panel({}).loadLimits({ ...DEFAULTS, image_max_mb: 3, image_cache_mb: 70, pdf_local_max_mb: 8, pdf_remote_max_mb: 9, svg_check: false, ssh_connect_timeout: 30, ssh_alive_interval: 5, ssh_alive_count: 9 }),
    { maxImage: 3 * MB, cacheLimit: 70 * MB, maxLocal: 8 * MB, maxRemote: 9 * MB, svgCheck: false, ssh: { ssh_connect_timeout: 30, ssh_alive_interval: 5, ssh_alive_count: 9 } });
  assert.deepEqual(panel({}).loadLimits(), { maxImage: 20 * MB, cacheLimit: 50 * MB, maxLocal: 100 * MB, maxRemote: 20 * MB, svgCheck: true, ssh: { ssh_connect_timeout: 15, ssh_alive_interval: 15, ssh_alive_count: 4 } }, "defaults before a file was shown");
});

// The first listing runs with the defaults; once the config is read, other list settings list the tree once more, at
// once (with refresh_seconds 0 there is no timer to wait for, issue #31).
const listings = (h) => h.log.execs.filter((e) => e.cmd === "sh" && e.args[1] === LIST_SCRIPT && e.args[3] === "/data").length;
async function booted(cfg) {
  const h = host({ files: { ...(cfg ? { "/app/filer-pro.json": cfg } : {}), "/app/mods/filer-pro/mod.json": '{"version":"1.0.0"}' } });
  const { cx } = fakeCx();
  const self = Object.create(FilerPro.prototype);
  self.init({}, cx);
  await settle();
  return listings(h);
}

test("settings: a file holding null is broken; non-default list settings reload the tree once the config is read", async () => {
  const b = host({ files: { "/app/filer-pro.json": "null" } });
  await panel({}).openSettings();
  assert.equal(b.store["filer-pro.settings"].broken, true);
  assert.equal(await booted(null), 1, "control: defaults list once");
  assert.equal(await booted('{"list_total": 300}'), 2);
});

// The settings overlay of main.js on a fake host, opened through openSettings like the real one.
async function dialog(files = {}, store = {}) {
  const h = host({ props: { overlay: "dlg1", view: "settings" }, files: { "/app/mods/filer-pro/mod.json": '{"version":"1.0.0"}', ...files }, store });
  const { cx } = fakeCx();
  await panel({}).openSettings();
  const self = Object.create(FilerPro.prototype);
  self.init({}, cx);
  return { h, cx, self };
}

test("settings dialog: Check now asks GitHub, shows a newer release, and stores it for the panels", async () => {
  const { h, cx, self } = await dialog();
  assert.equal(self.settings.version, "1.0.0");
  const calls = [];
  let answer;
  const fetchFn = (url) => { calls.push(url); return new Promise((r) => { answer = r; }); };
  self.checkNow(cx, fetchFn);
  assert.equal(self.settings.check.phase, "checking");
  assert.ok(texts(self.overlayView(cx)).includes("Asking GitHub for the latest version…"));
  self.checkNow(cx, fetchFn);
  await settle();
  assert.equal(calls.length, 1, "one request while checking");
  answer({ status: 200, json: async () => ({ tag_name: "v1.1.0" }) });
  await settle();
  assert.equal(h.store["filer-pro.update"].latest, "v1.1.0");
  assert.equal(h.store["filer-pro.update"].local, "1.0.0");
  const out = texts(self.overlayView(cx));
  assert.ok(out.includes("Version 1.1.0 is available."));
  assert.ok(out.includes("What’s new in 1.1.0"));
});

test("settings dialog: Check now offline shows the failure and keeps the last known release", async () => {
  const known = { at: 5, local: "1.0.0", latest: "v1.0.0" };
  const { h, cx, self } = await dialog({}, { "filer-pro.update": known });
  self.checkNow(cx, async () => { throw new Error("offline"); });
  await settle();
  assert.equal(self.settings.check.phase, "failed");
  assert.equal(h.store["filer-pro.update"], known);
  assert.ok(texts(self.overlayView(cx)).includes("Could not reach GitHub. Check your connection and try again."));
  assert.ok(texts(self.overlayView(cx)).includes("Try again"));
});

test("settings dialog: with the daily check off, Check now answers in the dialog but stores nothing", async () => {
  const { h, cx, self } = await dialog({ "/app/filer-pro.json": '{"update_check": false}' });
  self.checkNow(cx, async () => ({ status: 200, json: async () => ({ tag_name: "v1.0.0" }) }));
  await settle();
  assert.equal(h.store["filer-pro.update"], undefined);
  assert.ok(texts(self.overlayView(cx)).some((x) => x.startsWith("You’re up to date. Last checked today at ")));
});

test("settings dialog: Choose… puts the picked folder into the field, with ~/ inside the home folder", async () => {
  const { cx, self } = await dialog();
  globalThis.__impl.pickFolder = async () => "/home/u/Inbox";
  self.chooseDownloadFolder(cx);
  await settle();
  assert.equal(self.settings.fields.download_folder.value, "~/Inbox");
  assert.equal(self.settings.fields.download_folder.input.value(), "~/Inbox");
  globalThis.__impl.pickFolder = async () => null;
  self.chooseDownloadFolder(cx);
  await settle();
  assert.equal(self.settings.fields.download_folder.value, "~/Inbox", "cancel keeps the field");
});

// Issue #17: the hide switches reach the listing (this Mac, an SSH machine, Windows), apply live, and an open folder
// that becomes hidden leaves the tree.
test("hide settings: the listing gets both switches as 1/0 words, on an SSH machine too; on Windows a Where-Object before -First", async () => {
  const { log } = host();
  const self = panel({ hide_system_files: false, hide_dotfiles: true }), context = { key: "k", cwd: "/srv", on: "box" };
  Object.assign(self, { context });
  self.current = () => true;
  await self.loadFolder("", context);
  assert.deepEqual([log.execs[0].args, log.execs[0].opts], [["-c", LIST_SCRIPT, "files", "/srv", "500", "1", "1"], { on: "box" }], "hidden files include the system files");
  assert.equal(self.cfg.hide_system_files, false, "the stored switch is not changed");
  const win = host({ platform: "windows" });
  globalThis.__impl.exec = async (cmd, args) => { win.log.execs.push({ cmd, args }); return { code: 0, stdout: "[]", stderr: "" }; };
  self.cfg = { ...DEFAULTS };
  await self.loadFolder("", { key: "k", cwd: "C:\\data", on: null });
  assert.match(win.log.execs[0].args[2], /Where-Object \{ -not \(.*DS_Store.*\) \} \| Select-Object -First 501 /);
});

test("hide settings: a saved change applies at once; an open folder that is now hidden leaves the tree, the others reload", async () => {
  const h = host({ files: { "/app/filer-pro.json": "{}" } });
  const listed = [];
  globalThis.__impl.exec = async (cmd, args) => {
    if (cmd !== "sh") return { code: 1, stdout: "", stderr: "" };
    listed.push(args.slice(3));
    const dir = args[3], dots = args[6] === "1";
    const names = dir === "/data" ? [["d", ".github"], ["d", "src"], ["f", ".env"]] : dir === "/data/.github" ? [["d", "workflows"], ["f", "x"]] : [["f", "x"]];
    return { code: 0, stdout: names.filter(([, n]) => !(dots && n.startsWith("."))).map(([k, n]) => `${k}\0${n}\0`).join(""), stderr: "" };
  };
  const self = panel({});
  Object.assign(self, { reload: { signal: () => false, take: () => false }, saved: new Map(), marks: {}, pending: new Set(), show() {}, watch() {} });
  self.context = { key: JSON.stringify({ cwd: "/data", on: null, space: "s1" }), cwd: "/data", on: null };
  self.folders = new Set([".github", ".github/workflows", "src"]);
  const { cx } = fakeCx();
  self.refresh(cx);
  await settle();
  assert.deepEqual(self.visible().map((r) => r.path), [".github", ".github/workflows", ".github/workflows/x", ".github/x", "src", "src/x", ".env"]);
  h.files["/app/filer-pro.json"] = '{"hide_dotfiles": true}';
  h.store["filer-pro.config"] = { at: 1 };
  listed.length = 0;
  self.checkConfig(cx);
  await settle();
  assert.equal(self.conf.hide_dotfiles, true);
  assert.deepEqual(listed, [["/data", "500", "1", "1"], ["/data/src", "500", "1", "1"]], "the hidden open folders are not listed again");
  assert.deepEqual([...self.folders], ["src"]);
  assert.deepEqual(self.visible().map((r) => r.path), ["src", "src/x"]);
});

test("hide settings: non-default switches reload the tree once the config was read", async () => {
  for (const cfg of ['{"hide_system_files": false}', '{"hide_dotfiles": true}']) {
    assert.equal(await booted(cfg), 2, cfg);
  }
});
