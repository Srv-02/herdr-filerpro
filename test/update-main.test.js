// Runs the update check wiring of mods/filer-pro/main.js (drive() -> updatePass) on a fake host. main.js imports
// herdr, gpui-kit, gpui-base and fs/promises, which only the host has: a module hook swaps them for stubs that
// forward to globalThis.__impl (as in main-load.test.js), so the real class is loaded unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

const stub = (names) => names.map((n) => `export const ${n} = (...a) => globalThis.__impl.${n}(...a);`).join("\n");
const STUBS = {
  herdr: stub(["spaces", "panes", "focused", "exec", "hc", "readTextFile", "writeTextFile", "watchFolder", "theme", "settings", "window", "shared", "setShared", "notify", "props", "appHome", "home", "nextCommand", "openOverlay", "closeOverlay", "pickFolder", "run", "layout"]),
  "gpui-kit": "export class View {}; export const div = () => ({}), svg = div, image = div;",
  "gpui-base": "export const v_flex = () => ({}), h_flex = v_flex; export class Editor {}; export class EditorState {}; export class InputState {}; export const Input = v_flex, TextView = v_flex;",
  "fs/promises": "export const exists = async () => false, readFile = async () => \"\", writeFile = readFile, mkdir = readFile, unlink = readFile, stat = readFile;",
};
const hooks = `export async function resolve(s, c, next) { return s in ${JSON.stringify(STUBS)} ? { url: "stub:" + s, shortCircuit: true } : next(s, c); }
export async function load(u, c, next) { return u.startsWith("stub:") ? { format: "module", shortCircuit: true, source: ${JSON.stringify(STUBS)}[u.slice(5)] } : next(u, c); }`;
register("data:text/javascript," + encodeURIComponent(hooks));
const FilerPro = (await import("../mods/filer-pro/main.js")).default;

const never = () => new Promise(() => {});

// A fake host: files by path, shared values in `store`, fetch answers with `release` (a tag, or null for a 404).
function host({ config = null, modJson = '{ "place": "none", "version": "1.0.0" }', store = {}, release = "v1.1.0" } = {}) {
  const calls = [], writes = [];
  const files = { "/app/filer-pro.json": config, "/app/mods/filer-pro/mod.json": modJson };
  globalThis.__impl = {
    appHome: () => "/app", home: () => "/home/u", props: () => ({}),
    readTextFile: async (p) => { if (files[p] == null) throw new Error("ENOENT"); return files[p]; },
    shared: (k) => store[k], setShared: (k, v) => { store[k] = v; writes.push([k, v]); },
    exec: async () => ({ code: 0, stdout: "", stderr: "" }), watchFolder: never, nextCommand: never, notify: () => {},
  };
  const fetch = async (url, opts) => {
    calls.push({ url, opts });
    return release ? { status: 200, json: async () => ({ tag_name: release }) } : { status: 404, json: async () => ({ message: "Not Found" }) };
  };
  return { calls, writes, store, fetch };
}

function fakeCx() {
  const timers = [];
  const cx = { sleep: never, notify() {}, spawn: (fn) => { Promise.resolve().then(() => fn(cx)).catch(() => {}); }, timer: { every: (ms, fn) => timers.push({ ms, fn }) } };
  // Some spawned loops (nextCommand, watchFolder) never end: let the microtasks and a few turns run instead of awaiting them.
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  return { cx, timers, settle };
}

const panel = () => Object.assign(Object.create(FilerPro.prototype), { jobs: { recover: async () => {}, tick: async () => {}, clearFinished() {} } });

test("main.js updatePass: a due check asks GitHub once and stores the result", async () => {
  const h = host();
  const { cx } = fakeCx();
  await panel().updatePass(cx, h.fetch);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, "https://api.github.com/repos/Srv-02/herdr-filerpro/releases/latest");
  assert.equal(h.store["filer-pro.update"].latest, "v1.1.0");
  assert.equal(h.store["filer-pro.update"].local, "1.0.0");
});

test("main.js updatePass: update_check false sends no request and clears an old hint", async () => {
  const h = host({ config: '{ "update_check": false }', store: { "filer-pro.update": { at: 1, local: "1.0.0", latest: "v1.1.0" } } });
  const { cx } = fakeCx();
  await panel().updatePass(cx, h.fetch);
  assert.equal(h.calls.length, 0);
  assert.equal(h.store["filer-pro.update"], null);
});

test("main.js updatePass: no release yet (404) is silent and stored, so the next day asks again", async () => {
  const h = host({ release: null });
  const { cx } = fakeCx();
  await panel().updatePass(cx, h.fetch);
  assert.equal(h.calls.length, 1);
  assert.equal(h.store["filer-pro.update"].latest, null);
  await panel().updatePass(cx, h.fetch);
  assert.equal(h.calls.length, 1, "not again within 24 h");
});

test("main.js updatePass: an unreadable mod.json sends no request", async () => {
  const h = host({ modJson: null });
  const { cx } = fakeCx();
  await panel().updatePass(cx, h.fetch);
  assert.equal(h.calls.length, 0);
  assert.equal(h.writes.length, 0);
});

test("main.js drive: the lease holder runs one pass at once, a copy without the lease none", async () => {
  const fetchBefore = globalThis.fetch;
  try {
    const h = host();
    globalThis.fetch = h.fetch;
    const { cx, timers, settle } = fakeCx();
    panel().drive(cx);
    await settle();
    assert.equal(h.calls.length, 1, "the holder checked on its first beat");
    assert.ok(h.store["filer-pro.update"]);
    for (const t of timers.filter((t) => t.ms === 2000)) t.fn(cx);
    await settle();
    assert.equal(h.calls.length, 1, "the next beat within the hour does not ask again");

    const other = host({ store: { "filer-pro.lease": { owner: "someone", at: Date.now() } } });
    globalThis.fetch = other.fetch;
    const second = fakeCx();
    panel().drive(second.cx);
    await second.settle();
    assert.equal(other.calls.length, 0, "a copy without the lease never asks");
  } finally { globalThis.fetch = fetchBefore; }
});

test("main.js: the panel reads its own version for the hint", async () => {
  host({ modJson: '{ "version": "1.2.3" }' });
  assert.equal(await panel().readVersion(), "1.2.3");
  host({ modJson: null });
  assert.equal(await panel().readVersion(), null);
});
