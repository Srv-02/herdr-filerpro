// Runs the Load flow of mods/filer-pro/main.js (loadLarge, fetchLoad, waitLoad, showHint) on a fake `this`. main.js imports
// herdr, gpui-kit, gpui-base and fs/promises (with exists), which only the host has: a module hook swaps them for stubs
// that forward to globalThis.__impl, so the real class is loaded unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import * as images from "../mods/filer-pro/preview/images.js";

const stub = (names) => names.map((n) => `export const ${n} = (...a) => globalThis.__impl.${n}(...a);`).join("\n");
const STUBS = {
  herdr: stub(["spaces", "panes", "focused", "exec", "hc", "readTextFile", "writeTextFile", "watchFolder", "theme", "settings", "window", "shared", "setShared", "notify", "props", "appHome", "home", "nextCommand", "openOverlay", "closeOverlay", "pickFolder", "run", "layout"]),
  "gpui-kit": "export class View {}; export const div = () => ({}), svg = div, image = div;",
  "gpui-base": "export const v_flex = () => ({}), h_flex = v_flex; export class Editor {}; export class EditorState {}; export class InputState {}; export const Input = v_flex, TextView = v_flex;",
  "fs/promises": `${stub(["exists"])} export const readFile = async () => "", writeFile = readFile, mkdir = readFile, unlink = readFile, stat = readFile;`,
};
const hooks = `export async function resolve(s, c, next) { return s in ${JSON.stringify(STUBS)} ? { url: "stub:" + s, shortCircuit: true } : next(s, c); }
export async function load(u, c, next) { return u.startsWith("stub:") ? { format: "module", shortCircuit: true, source: ${JSON.stringify(STUBS)}[u.slice(5)] } : next(u, c); }`;
register("data:text/javascript," + encodeURIComponent(hooks));
const FilerPro = (await import("../mods/filer-pro/main.js")).default;

// One run: the host answers from `opts`; returns what the flow did.
async function run(method, opts) {
  const log = { jobs: [], shows: [], execs: [] }, store = { "filer-pro.jobs": opts.jobs ?? {} };
  globalThis.__impl = {
    appHome: () => "/app", props: () => ({ overlay: opts.overlay }), shared: (k) => store[k],
    exec: async (cmd, args) => { log.execs.push([cmd, ...args]); return { code: 0, stdout: "", stderr: "" }; },
    exists: async () => opts.present ?? false,
  };
  const context = { fixed: true }, self = Object.create(FilerPro.prototype);
  Object.assign(self, { context, root: opts.root ?? "/data", on: opts.on ?? null, file: opts.file, page: 1, pages: 1, loadKey: "k1", loadName: opts.name, fileError: opts.error,
    jobs: { start: async (spec) => { log.jobs.push(spec); return { id: "j1" }; } },
    show: (path, cx, o) => log.shows.push({ path, ...o }) });
  const tasks = [], cx = { notify() {}, sleep: async () => {}, spawn: (fn) => { const p = fn(cx); tasks.push(p); return p; } };
  const previewer = { ...images, clearLoads: async () => {}, resolveFile: async ({ path }) => path.replace("/link.png", "/real/target.png") };
  self.loader = method === "hint" ? null : previewer;
  if (method === "hint") self.showHint(previewer, { error: "Too large", key: "k1", name: opts.name }, opts.file, cx);
  else self.loadLarge(cx);
  for (let i = 0; i < 5; i++) { await Promise.all(tasks); store["filer-pro.jobs"] = { j1: { state: "done", ...opts.end } }; }
  return { self, log };
}

test("main.js Load: a local image starts a local job with the resolved source, then shows with force", async () => {
  const { log } = await run("load", { file: "link.png", name: "k1.png" });
  assert.deepEqual(log.jobs, [{ direction: "local", machine: null, src: "/data/real/target.png", destDir: `/app/${images.loadDir("k1")}`, choice: "new", preview: true, as: "k1.png" }]);
  assert.deepEqual(log.shows, [{ path: "link.png", force: true, page: 1, pages: 1 }]);
});

test("main.js Load: a local PDF starts no job and shows with force", async () => {
  const { log } = await run("load", { file: "doc.pdf", name: "k1.pdf" });
  assert.deepEqual(log.jobs, []);
  assert.deepEqual(log.shows, [{ path: "doc.pdf", force: true, page: 1, pages: 1 }]);
});

test("main.js Load: from a machine the job is a down job with the remote path", async () => {
  const { log } = await run("load", { file: "pic.png", name: "k1.png", on: "box", root: "/home/u" });
  assert.equal(log.jobs.length, 1);
  assert.equal(log.jobs[0].direction, "down");
  assert.equal(log.jobs[0].machine, "box");
  assert.equal(log.jobs[0].src, "/home/u/pic.png");
  const pdf = await run("load", { file: "doc.pdf", name: "k1.pdf", on: "box", root: "/home/u" });
  assert.equal(pdf.log.jobs[0]?.direction, "down", "a remote PDF is loaded by the job too");
  assert.deepEqual(pdf.log.shows.map((s) => s.force), [true]);
});

test("main.js Load: a copy that is already in loads/ is shown without a job", async () => {
  const { log } = await run("load", { file: "pic.png", name: "k1.png", present: true });
  assert.deepEqual(log.jobs, []);
  assert.equal(log.shows.length, 1);
});

test("main.js dialog: a local image points to the panel without a Load button; a local PDF does not", async () => {
  const img = await run("hint", { file: "pic.png", name: "k1.png", overlay: true });
  assert.equal(img.self.fileError, "Too large · Load it in the panel");
  assert.equal(img.self.loader, null, "no Load button in the dialog");
  assert.deepEqual(img.log.jobs, []);
  const pdf = await run("hint", { file: "doc.pdf", name: "k1.pdf", overlay: true });
  assert.equal(pdf.self.fileError, "Too large");
  assert.ok(pdf.self.loader, "a local PDF keeps its button (show(force) needs no job)");
  const panel = await run("hint", { file: "pic.png", name: "k1.png", overlay: false });
  assert.ok(panel.self.loader, "the panel shows the Load button");
});

test("main.js dialog: a cancelled or failed Load ends with the pointer to the panel; the panel keeps its Load button", async () => {
  for (const [state, error, text] of [["cancelled", undefined, "Load cancelled"], ["error", "cp failed", "cp failed"]]) {
    for (const [on, name, file] of [[null, "k1.png", "pic.png"], ["box", "k1.pdf", "doc.pdf"]]) {
      const dlg = await run("load", { file, name, on, overlay: true, jobs: { j1: { state: "running" } }, end: { state, error }, running: true });
      assert.equal(dlg.self.fileError, `${text} · Load it in the panel`, `${state} ${file} on ${on}`);
      assert.equal(dlg.self.loader, null);
      const panel = await run("load", { file, name, on, overlay: false, jobs: { j1: { state: "running" } }, end: { state, error }, running: true });
      assert.equal(panel.self.fileError, text);
      assert.ok(panel.self.loader, "the panel shows the Load button again");
    }
  }
});
