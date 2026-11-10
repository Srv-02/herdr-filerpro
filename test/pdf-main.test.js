// The PDF flow of mods/filer-pro/main.js (zoom, spread, sharper renders) on a fake `this`, with the stubbed host modules
// of test/main-load.test.js and a fake pdfs loader that records its calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import * as zoom from "../mods/filer-pro/preview/zoom.js";
import { bindZoomKeys, ZOOM_KEYS } from "../mods/filer-pro/lib/pdfkeys.js";

const stub = (names) => names.map((n) => `export const ${n} = (...a) => globalThis.__impl.${n}(...a);`).join("\n");
const STUBS = {
  herdr: stub(["spaces", "panes", "focused", "exec", "hc", "readTextFile", "writeTextFile", "watchFolder", "theme", "settings", "window", "shared", "setShared", "notify", "props", "appHome", "home", "nextCommand", "openOverlay", "closeOverlay", "pickFolder", "run", "layout"]),
  "gpui-kit": "export class View {}; export const div = () => ({}), svg = div, image = div;",
  "gpui-base": "export const v_flex = () => ({}), h_flex = v_flex; export class Editor {}; export class EditorState {}; export class InputState {}; export const Input = v_flex, TextView = v_flex, Scrollbar = { vertical: v_flex };",
  "fs/promises": `${stub(["exists"])} export const readFile = async () => "", writeFile = readFile, mkdir = readFile, unlink = readFile, stat = readFile, readdir = async () => [];`,
};
const hooks = `export async function resolve(s, c, next) { return s in ${JSON.stringify(STUBS)} ? { url: "stub:" + s, shortCircuit: true } : next(s, c); }
export async function load(u, c, next) { return u.startsWith("stub:") ? { format: "module", shortCircuit: true, source: ${JSON.stringify(STUBS)}[u.slice(5)] } : next(u, c); }`;
register("data:text/javascript," + encodeURIComponent(hooks));
const FilerPro = (await import("../mods/filer-pro/main.js")).default;

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const page = (a, extra = {}) => ({ kind: "pdf", path: `p${a.page}${a.size ?? ""}.png`, page: a.page, pages: 12, ...(a.size ? { size: a.size } : {}), width: 600, height: 800, ...extra });

// A fake dialog or panel: 12 pages of 600x800 points, loads recorded, timers fired by hand.
function make({ full = true, spread = false, loader } = {}) {
  const store = {}, set = [];
  globalThis.__impl = { shared: (k) => store[k], setShared: (k, v) => { store[k] = v; set.push([k, v]); }, appHome: () => "/app", props: () => ({}) };
  const calls = [], timers = [];
  const pdfs = { load: async (a) => { calls.push(a); return loader ? loader(a) : page(a); } };
  const cx = { notify() {}, spawn: (fn) => fn(cx), timer: { after: (ms, fn) => timers.push({ ms, fn }) } };
  const self = Object.create(FilerPro.prototype);
  Object.assign(self, { context: { fixed: true }, root: "/data", on: null, file: "a.pdf", page: 1, pages: 12, fullView: full, spread, zoom: "fit", previewWidth: 1000,
    pdfs, previewer: zoom, sharp: new Map(), doc2: null, force: false, current: () => true, doc: page({ page: 1 }) });
  return { self, cx, calls, timers, set, store, fire: async () => { timers.splice(0).forEach((x) => x.fn()); await flush(); } };
}

test("main.js show(): the zoom stays for the same path and resets for a new path", () => {
  const { self } = make();
  self.zoom = 150;
  self.show("a.pdf");
  assert.equal(self.zoom, 150);
  self.show("b.pdf");
  assert.equal(self.zoom, "fit");
  assert.equal(self.doc2, null);
  assert.equal(self.sharp.size, 0);
});

test("main.js dialog spread: a turn loads both pages and swaps doc and doc2 together", async () => {
  const m = make({ spread: true });
  m.self.turnPage(4, m.cx);
  assert.equal(m.self.page, 4);
  await flush();
  assert.deepEqual(m.calls.map((c) => c.page).sort(), [4, 5]);
  assert.ok(m.calls.every((c) => c.size === undefined));
  assert.deepEqual([m.self.doc.page, m.self.doc2.page], [4, 5]);
  m.self.turnPage(5, m.cx); // the spread holding 5 is 4-5, already shown
  assert.equal(m.calls.length, 2);
});

test("main.js dialog spread: only the second page failing shows the first alone", async () => {
  const m = make({ spread: true, loader: (a) => (a.page === 5 ? { error: "broken", final: true } : page(a)) });
  m.self.turnPage(4, m.cx);
  await flush();
  assert.equal(m.self.doc.page, 4);
  assert.equal(m.self.doc2, null);
  assert.equal(m.self.fileError ?? null, null);
});

test("main.js a stale turn (older turnGen) is dropped", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const m = make({ loader: async (a) => { if (a.page === 3) await gate; return page(a); } });
  m.self.turnPage(3, m.cx);
  m.self.turnPage(4, m.cx);
  await flush();
  release();
  await flush();
  assert.equal(m.self.page, 4);
  assert.equal(m.self.doc.page, 4, "the late page 3 did not overwrite page 4");
});

test("main.js zoomBy steps the zoom; sharpen asks for the tier after the timer", async () => {
  const m = make();
  m.self.zoomBy("in", m.cx); // Fit at a 1000 px view is 161 %, the next step is 200
  assert.equal(m.self.zoom, 200);
  m.self.zoomBy("out", m.cx);
  assert.equal(m.self.zoom, 150);
  m.self.zoomBy("in", m.cx);
  assert.equal(m.self.zoom, 200);
  assert.equal(m.calls.length, 0, "debounced: no render before the timer");
  assert.equal(m.timers.length, 1, "one pending timer");
  assert.equal(m.timers[0].ms, 250);
  await m.fire();
  // 200 % of 600x800 is 1200x1600 logical px: need 3200, the tier is 4096
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0].size, 4096);
  assert.equal(m.calls[0].page, 1);
  assert.deepEqual(m.self.sharp.get(1), { size: 4096, path: "p14096.png", base: "p1.png" });
});

test("main.js sharpen: nothing is stored while the sized result is pending, and the same size is not asked twice", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const m = make({ loader: async (a) => { if (a.size) await gate; return page(a); } });
  m.self.zoom = 200;
  m.self.sharpen(m.cx);
  await m.fire();
  assert.equal(m.calls.length, 1);
  assert.equal(m.self.sharp.size, 0, "the view keeps doc.path");
  m.self.sharpen(m.cx);
  await m.fire();
  assert.equal(m.calls.length, 1);
  release();
  await flush();
  assert.equal(m.self.sharp.get(1).path, "p14096.png");
});

test("main.js sharpen: tooLarge falls back to a lower tier, then records a null path", async () => {
  const m = make({ loader: (a) => (a.size >= 4096 ? { error: "too big", tooLarge: true } : page(a)) });
  m.self.zoom = 300; // 1800x2400 logical px: need 4800, the tier is 6144
  m.self.sharpen(m.cx);
  await m.fire();
  assert.deepEqual(m.calls.map((c) => c.size), [6144, 4096, 3072]);
  assert.equal(m.self.sharp.get(1).path, "p13072.png");
  const n = make({ loader: () => ({ error: "too big", tooLarge: true }) });
  n.self.zoom = 300;
  n.self.sharpen(n.cx);
  await n.fire();
  assert.deepEqual(n.calls.map((c) => c.size), [6144, 4096, 3072]);
  assert.equal(n.self.sharp.get(1).path, null);
  n.self.sharpen(n.cx);
  await n.fire();
  assert.equal(n.calls.length, 3, "no retry after the null record");
});

test("main.js panel (fullView false): turnPage never passes a size and zoom and sharpen do nothing", async () => {
  const m = make({ full: false });
  m.self.turnPage(2, m.cx);
  await flush();
  assert.equal(m.calls.length, 1);
  assert.equal("size" in m.calls[0], false);
  assert.equal("keep" in m.calls[0], false);
  m.self.zoomBy("in", m.cx);
  m.self.sharpen(m.cx);
  await m.fire();
  assert.equal(m.calls.length, 1);
  assert.equal(m.self.zoom, "fit");
});

test("main.js toggleSpread writes the shared setting and loads the spread", async () => {
  const m = make();
  m.self.page = 3;
  m.self.toggleSpread(m.cx);
  assert.deepEqual(m.set, [["filer-pro.spread", true]]);
  await flush();
  assert.equal(m.self.page, 2);
  assert.deepEqual(m.calls.map((c) => c.page).sort(), [2, 3]);
  m.self.toggleSpread(m.cx);
  assert.deepEqual(m.set.at(-1), ["filer-pro.spread", false]);
  await flush();
  assert.equal(m.self.doc2, null);
});

test("zoom keys are bound once per session, each binding on its own", () => {
  const store = {}, bound = [];
  const cx = { bind_keys: ([b]) => { if (b.keystroke === "cmd-+") throw new Error("bad spelling"); bound.push(b.keystroke); } };
  const get = (k) => store[k], put = (k, v) => { store[k] = v; };
  assert.equal(bindZoomKeys(cx, get, put, () => 42), ZOOM_KEYS.length - 1);
  assert.deepEqual(store["filer-pro.zoomkeys"], { at: 42, bound: ZOOM_KEYS.length - 1 });
  assert.equal(bound.length, ZOOM_KEYS.length - 1, "one failing binding did not drop the rest");
  assert.equal(bindZoomKeys(cx, get, put, () => 43), -1);
  assert.equal(bound.length, ZOOM_KEYS.length - 1, "the second dialog binds nothing");
});
