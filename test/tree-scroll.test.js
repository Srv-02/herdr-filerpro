// Issue #5: the tree must keep its scroll position while a file is shown. The offset is GPUI's retained state of the
// `files-tree` scroll container and lives only as long as that element is rendered every frame, so these tests render
// the real panel (mods/filer-pro/main.js) with recording stub builders and check that the element stays in the tree,
// at zero height and with the same content height, while a file is open. The scroll offset itself only exists in the
// Herdr app: that part is a hand test.
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
  "gpui-base": `${make(["v_flex", "h_flex", "Input", "TextView"])} export class Editor { static new() { return globalThis.__make("editor"); } } export class EditorState {} export class InputState {}`,
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
  exec: async () => ({ code: 1, stdout: "", stderr: "" }), readTextFile: async () => null, appHome: () => "/app", home: () => "/home/u",
};
const cx = { notify() {}, spawn() {}, sleep: async () => {} };
const dir = (name) => ({ name, dir: true }), file = (name) => ({ name, dir: false });

// A panel copy with a loaded tree: 3 entries at the root, folder "pics" open with 40 images (43 rows).
function panel() {
  const self = Object.create(FilerPro.prototype);
  const pics = Array.from({ length: 40 }, (_, i) => file(`img${String(i).padStart(2, "0")}.png`));
  Object.assign(self, { context: null, saved: new Map(), reload: { signal: () => false, take: () => false }, jobs: {}, perf: null });
  self.refresh(cx); // takes the focused location as its context (and resets the tree, as a location switch does)
  self.entries = new Map([["", [dir("docs"), dir("pics"), file("readme.md")]], ["pics", pics]]);
  self.folders = new Set(["pics"]);
  return self;
}

const idOf = (el) => el.calls.find((c) => c[0] === "id")?.[1];
function findId(el, id) {
  if (!el || typeof el !== "object" || !el.calls) return null;
  if (idOf(el) === id) return el;
  for (const k of el.kids) { const hit = findId(k, id); if (hit) return hit; }
  return null;
}
const called = (el, name) => el.calls.filter((c) => c[0] === name).map((c) => c.slice(1));
const rowsOf = (tree) => tree.kids.filter((k) => String(idOf(k) ?? "").startsWith("file-"));

test("issue #5: the tree stays mounted at zero height while a file is open, with the same content height", () => {
  const self = panel();
  const open = findId(self.render(cx), "files-tree");
  assert.ok(open, "tree shown without a file");
  assert.equal(rowsOf(open).length, 43);
  assert.deepEqual(called(open, "flex_1"), [[]]);

  self.show("pics/img30.png", cx);
  const hidden = findId(self.render(cx), "files-tree");
  assert.ok(hidden, "the tree element is still rendered while the preview is open (else GPUI drops its scroll offset)");
  assert.deepEqual(called(hidden, "h").at(-1), [0], "zero height");
  assert.deepEqual(called(hidden, "p").at(-1), [0], "no padding (padding would give it a minimum height)");
  assert.deepEqual(called(hidden, "flex_1"), [], "does not take the viewer's space");
  assert.ok(called(hidden, "overflow_y_scrollbar").length, "still the same scroll container");
  assert.equal(rowsOf(hidden).length, 0, "no row elements are built while hidden");
  const spacer = hidden.kids.find((k) => k.calls && called(k, "h").length);
  assert.deepEqual(called(spacer, "h"), [[43 * 28 + 12]], "a spacer keeps the content height: 43 rows plus the p(6) padding");
});

test("issue #5: back shows the rows again and marks the file that was just opened", () => {
  const self = panel();
  self.show("pics/img30.png", cx);
  self.render(cx);
  self.show(null); // the back button
  assert.equal(self.file, null);
  assert.equal(self.lastOpened, "pics/img30.png");
  assert.deepEqual([...self.folders], ["pics"], "expanded folders unchanged");
  const tree = findId(self.render(cx), "files-tree");
  assert.deepEqual(called(tree, "flex_1"), [[]]);
  const rows = rowsOf(tree);
  assert.equal(rows.length, 43);
  const marked = rows.filter((r) => called(r, "bg").some((a) => a[0] === "selected"));
  assert.deepEqual(marked.map(idOf), ["file-pics/img30.png"], "only the last opened row is marked");
});

test("issue #5: the mark moves to the next opened file and is kept per location", () => {
  const self = panel();
  self.show("pics/img01.png", cx); self.show(null);
  self.show("readme.md", cx); self.show(null);
  assert.equal(self.lastOpened, "readme.md");

  where.folder = "/data/other";
  self.refresh(cx);
  assert.equal(self.lastOpened, null, "another location starts without a mark");
  self.show("notes.txt", cx); self.show(null);
  where.folder = "/data/project";
  self.refresh(cx);
  assert.equal(self.lastOpened, "readme.md", "coming back restores the mark of this location");
  where.folder = "/data/other";
  self.refresh(cx);
  assert.equal(self.lastOpened, "notes.txt");
  where.folder = "/data/project";
});
