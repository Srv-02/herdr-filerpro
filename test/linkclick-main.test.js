// Ctrl/Cmd-click on a file link (link.js and pollLink in main.js) with stub builders and a fake host.
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
const { handleLink } = await import("../mods/filer-pro/link.js");

const DISK = { "/": ["home/", "tmp/"], "/home/u": ["one/"], "/home/u/one": ["shots/", "a.md"], "/home/u/one/shots": ["x.png"], "/tmp": ["y.png"] };
const STACK = { id: "root", children: [{ id: "panel", hidden: true, children: [{ id: "panel-body", type: "stack", active: "files", children: [{ id: "files" }, { id: "filer-pro" }] }] }] };
const host = {};
globalThis.__impl = {
  props: () => ({}), shared: (k) => host.shared[k], setShared: (k, v) => { host.shared[k] = v; }, settings: () => ({ dark: false, font_family: "mono" }),
  theme: () => new Proxy({}, { get: (_t, k) => String(k) }), window: () => ({ platform: "macos" }), home: () => "/home/u", appHome: () => "/app",
  spaces: () => [{ active: true, id: "s1", folder: "/space", machine: host.machine }],
  panes: () => [{ pane: "p1", cwd: "/home/u/one", terminal: "t-p1" }],
  focused: () => ({ space: "s1", pane: "p1", terminal: "t-p1", cwd: null }),
  notify: (n) => host.notes.push(n), readTextFile: async () => null, layout: () => host.layout,
  run: (cmd, args) => host.runs.push([cmd, args]),
  watchFolder: () => new Promise(() => {}),
  exec: async (cmd, args, opts = {}) => {
    if (cmd === "sh" && args[2] === "files") {
      const list = DISK[args[3]];
      return list ? { code: 0, stdout: list.map((n) => (n.endsWith("/") ? `d\0${n.slice(0, -1)}\0` : `f\0${n}\0`)).join(""), stderr: "" } : { code: 1, stdout: "", stderr: "" };
    }
    if (cmd === "sh" && args[1].includes("$HOME")) { host.homes.push(opts.on); return { code: 0, stdout: "/home/u", stderr: "" }; }
    return { code: 1, stdout: "", stderr: "" };
  },
};

const cx = { notify() {}, sleep: async () => {}, spawn: (fn) => { const p = Promise.resolve().then(() => fn(cx)); p.catch(() => {}); return p; } };
const settle = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); };

function reset(machine = "studio") {
  Object.assign(host, { machine, shared: {}, notes: [], runs: [], homes: [], layout: structuredClone(STACK) });
}
async function panel(machine) {
  reset(machine);
  const self = Object.create(FilerPro.prototype);
  Object.assign(self, { context: null, saved: new Map(), nav: new Map(), reload: { signal: () => false, take: () => false }, jobs: {}, perf: null, entries: new Map(), folders: new Set(), pending: new Set(), marks: {} });
  self.refresh(cx);
  await settle();
  return self;
}
const click = (raw, machine = "studio", path = null) => handleLink({ link: { kind: "file", raw, path }, source: { terminal: "t-p1", machine, cwd: "/home/u/one", pane: "p1", tab: null, space: "s1" } });

test("a click on a remote file below the shown folder shows it and reveals the panel", async () => {
  const self = await panel("studio");
  assert.equal(await click("shots/x.png:3"), "handled");
  assert.deepEqual(host.runs, [["layout.select", { stack: "panel-body", child: "filer-pro" }], ["layout.show", { id: "panel" }]]);
  assert.deepEqual({ ...host.shared["filer-pro.link"], id: 0, at: 0 }, { id: 0, at: 0, machine: "studio", path: "/home/u/one/shots/x.png" });
  self.pollLink(cx); await settle();
  assert.equal(self.root, "/home/u/one");
  assert.equal(self.file, "shots/x.png");
  self.file = null; self.pollLink(cx);
  assert.equal(self.file, null, "once");
});

test("a file outside the shown folder is shown from its own folder", async () => {
  const self = await panel("studio");
  await click("~/../../tmp/y.png");
  assert.deepEqual(host.homes, ["studio"], "~ asks the clicked terminal's machine");
  self.pollLink(cx); await settle();
  assert.equal(self.root, "/tmp");
  assert.equal(self.file, "y.png");
  assert.deepEqual(host.notes, []);
});

test("a copy that shows another machine, or a stale click, leaves it", async () => {
  const self = await panel(null);
  await click("/tmp/y.png", "studio");
  self.pollLink(cx); await settle();
  assert.equal(self.file ?? null, null);
  assert.equal(self.linkSeen, undefined, "another copy can still take it");
  host.shared["filer-pro.link"] = { id: "old", at: Date.now() - 60000, machine: null, path: "/home/u/one/a.md" };
  self.pollLink(cx); await settle();
  assert.equal(self.file ?? null, null);
});

test("a local click uses Herdr's path; no panel or no file: pass", async () => {
  const self = await panel(null);
  assert.equal(await click("./a.md:7", null, "/home/u/one/a.md"), "handled");
  self.pollLink(cx); await settle();
  assert.equal(self.file, "a.md");
  assert.equal(await click("./gone.png", null, null), "pass", "a missing local file goes to the next handler");
  host.layout = { id: "root", children: [] };
  assert.equal(await click("/tmp/y.png"), "pass", "no filer-pro block");
});

test("unsaved changes keep the open file", async () => {
  const self = await panel("studio");
  self.file = "a.md"; self.edit = { dirty: true };
  await click("/tmp/y.png");
  self.pollLink(cx); await settle();
  assert.equal(self.file, "a.md");
  assert.equal(self.root, "/home/u/one");
  assert.equal(host.notes.length, 1);
  self.edit = null;
});
