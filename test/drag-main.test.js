// Issue #102: rows as drag sources, drop routing (main.js stubbed as in localtree-main.test.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { dragSpec, dropPlan, pressMemory } from "../mods/filer-pro/lib/dragsource.js";
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

const UP = "/home/u/project", LOW = "/Users/example/Downloads";
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
function* walk(e) { if (!e || typeof e !== "object") return; yield e; for (const k of e.kids ?? []) yield* walk(k); }
const idOf = (el) => el.calls?.find((c) => c[0] === "id")?.[1];
const byId = (root, id) => [...walk(root)].find((e) => idOf(e) === id);
const called = (el, name) => el.calls.filter(([k]) => k === name).map(([, ...a]) => a);
const handlerOf = (el, name, ...first) => el.calls.find(([k, a]) => k === name && (first.length === 0 || a === first[0])).at(-1);

// A panel with two trees (upper on machine box, lower local) and a recorded request sink.
function panel() {
  const notes = [], reqs = [];
  globalThis.__impl = {
    theme: () => new Proxy({}, { get: (_t, k) => String(k) }), settings: () => ({ dark: true, font_family: "mono" }),
    shared: () => undefined, notify: (n) => notes.push(n), window: () => ({ platform: "macos" }),
    exists: async (p) => p.startsWith("/Users/"),
  };
  const mk = (id, on, root, entries) => ({ id, on, root, entries, folders: new Set(), packages: new Set(), marks: {}, selected: new Set(), lastOpened: null });
  const e = (name, dir = false) => ({ name, dir });
  const up = mk("follow", "box", UP, { "": [e("report.pdf"), e("src", true)] });
  const low = mk("pinned", null, LOW, { "": [e("a.txt")] });
  const self = Object.assign(Object.create(FilerPro.prototype), {
    _trees: { follow: up, pinned: low }, cfg: {}, saved: new Map(), request: (r) => reqs.push(r),
    visible: (tree) => (tree === up ? [{ path: "report.pdf", entry: e("report.pdf"), depth: 0 }, { path: "src", entry: e("src", true), depth: 0 }] : [{ path: "a.txt", entry: e("a.txt"), depth: 0 }]),
    clickRow() { this.clicked = true; }, dropOtherSelection: () => false, chevron: () => null, sizeCell: () => null,
  });
  return { self, up, low, notes, reqs };
}
const row = (self, tree, id) => byId({ kids: self.rows({ selected: "s" }, true, tree), calls: [] }, id);

test("pure: dragSpec and pressMemory", () => {
  assert.deepEqual(dragSpec({ on: null, paths: ["/a/b"] }), { paths: ["/a/b"], on: null });
  assert.equal(dragSpec({ on: "box", paths: [] }), null);
  assert.equal(pressMemory(null, ["/a"], [false], 1), null);
  assert.deepEqual(pressMemory("box", ["/a"], [true], 5), { machine: "box", paths: ["/a"], dirs: [true], at: 5 });
});

test("rows drag their paths, local and remote; a plain click still works", () => {
  const { self, up } = panel();
  const r = row(self, up, "file-report.pdf");
  assert.deepEqual(called(r, "drag_paths"), [[[`${UP}/report.pdf`], { on: "box" }]]);
  const l = row(self, self.trees.pinned, "local-file-a.txt");
  assert.deepEqual(called(l, "drag_paths"), [[[`${LOW}/a.txt`], { on: null }]]);
  handlerOf(r, "on_click")({}, { stop_propagation() {} });
  assert.equal(self.clicked, true);
  assert.equal(called(r, "on_mouse_down").some(([k]) => k === "left"), true);
});

test("a selected row drags the whole selection of its tree", () => {
  const { self, up } = panel();
  up.selected = new Set(["report.pdf", "src"]);
  self.selectedItems = () => [{ path: `${UP}/report.pdf`, isDir: false }, { path: `${UP}/src`, isDir: true }];
  const r = row(self, up, "file-report.pdf");
  assert.deepEqual(called(r, "drag_paths")[0][0], [`${UP}/report.pdf`, `${UP}/src`]);
});

test("this.drag can switch rows off", () => {
  const { self, up } = panel();
  self.drag = { rows: false };
  assert.equal(called(row(self, up, "file-report.pdf"), "drag_paths").length, 0);
});

test("a local drop onto a local and a machine tree is today's drop request", async () => {
  const { self, reqs } = panel();
  self.drop([`/Users/example/x.txt`], null, false, self.trees.pinned);
  self.drop([`/Users/example/x.txt`], "src", true, self.trees.follow);
  await settle();
  assert.deepEqual(reqs, [{ action: "copy", paths: ["/Users/example/x.txt"], folder: LOW }, { action: "upload", machine: "box", paths: ["/Users/example/x.txt"], folder: `${UP}/src` }]);
});

test("a drop equal to a remembered remote drag downloads or copies, never local", () => {
  const { self, reqs } = panel();
  const paths = [`${UP}/report.pdf`];
  const press = () => { self.press = pressMemory("box", paths, [false], 1); };
  press(); self.drop(paths, "a.txt", false, self.trees.pinned);
  assert.deepEqual(reqs.pop(), { action: "download", machine: "box", paths, dest_dir: LOW });
  press(); self.drop(paths, "src", true, self.trees.follow);
  assert.deepEqual(reqs.splice(0), [{ action: "clip", machine: "box", items: [{ path: paths[0], is_dir: false }] }, { action: "paste", machine: "box", folder: `${UP}/src` }]);
  assert.equal(self.press, null);
});

test("remote-looking paths without a remembered drag are refused", async () => {
  const { self, reqs, notes } = panel();
  self.drop([`${UP}/report.pdf`], null, false, self.trees.pinned);
  await settle();
  assert.equal(reqs.length, 0);
  assert.equal(notes[0].title, "Drop refused");
  self.press = pressMemory("box", [`${UP}/other`], [false], 1);
  self.drop([`${UP}/report.pdf`], null, false, self.trees.pinned);
  await settle();
  assert.equal(reqs.length, 0);
  assert.equal(dropPlan({ press: null, paths: ["/x"], dest: {} }).kind, "check");
});
