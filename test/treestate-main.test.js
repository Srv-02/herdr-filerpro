import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// A recording element: every builder call is logged, child/children/when behave like the real builders.
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

// The host: one space whose folder is `where.folder`; theme tokens come back as their own names.
const where = { folder: "/data/project" };
globalThis.__impl = {
  props: () => ({}), shared: () => undefined, settings: () => ({ dark: false, font_family: "mono" }),
  theme: () => new Proxy({}, { get: (_t, k) => String(k) }),
  spaces: () => [{ active: true, id: "s1", folder: where.folder, machine: null }], panes: () => [], focused: () => ({}),
  window: () => ({ platform: "macos" }), exec: async () => ({ code: 1, stdout: "", stderr: "" }), readTextFile: async () => null, appHome: () => "/app", home: () => "/home/u",
};
const cx = { notify() {}, spawn() {}, sleep: async () => {} };

test("the tree fields of the view live on trees.follow", () => {
  const self = Object.create(FilerPro.prototype);
  Object.assign(self, { root: "/data", folders: new Set(["a"]), selecting: true });
  assert.equal(self.trees.follow.root, "/data");
  assert.deepEqual([...self.trees.follow.folders], ["a"]);
  assert.equal(self.trees.follow.selecting, true);
  assert.equal(self.trees.pinned, null);
});

test("refresh stores the upper context on trees.follow", () => {
  const self = Object.create(FilerPro.prototype);
  Object.assign(self, { context: null, saved: new Map(), reload: { signal: () => false, take: () => false }, jobs: {}, perf: null });
  self.refresh(cx);
  assert.equal(self.trees.follow.context, self.context);
  assert.equal(self.trees.follow.root, "/data/project");
});
