// Issue #23 in mods/filer-pro/main.js: the menu entry opens the dialog, the dialog reads the mode, Apply only shows the
// confirmation, and only Change runs chmod. main.js is loaded with stubbed host modules (as in test/bundles-main.test.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { GUARD_SCRIPT } from "../mods/filer-pro/lib/fileops.js";
import { PROBE_SCRIPT, CHMOD_SCRIPT, COUNT_SCRIPT } from "../mods/filer-pro/lib/perms.js";
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
const make = (names) => names.map((n) => `export const ${n} = (...a) => { const e = globalThis.__make("${n}"); e.args = a; return e; };`).join("\n");
const STUBS = {
  herdr: stub(["spaces", "panes", "focused", "exec", "hc", "readTextFile", "writeTextFile", "watchFolder", "theme", "settings", "window", "shared", "setShared", "notify", "props", "appHome", "home", "nextCommand", "openOverlay", "closeOverlay", "pickFolder", "run", "layout"]),
  "gpui-kit": `export class View {}; ${make(["div", "svg", "image"])}`,
  "gpui-base": `${make(["v_flex", "h_flex", "TextView"])} export const Input = { new: () => globalThis.__make("input") }, Scrollbar = { vertical: () => globalThis.__make("scrollbar") };
export class Editor { static new() { return globalThis.__make("editor"); } } export class EditorState { static new() { return { release() {} }; } }
export class InputState { static new(o) { const s = new InputState(); s.v = o.value; s.h = {}; return s; } on(e, f) { this.h[e] = f; } value() { return this.v; } set_value(v) { this.v = v; } set_selected_range() {} focus() {} }`,
  "fs/promises": `${stub(["exists"])} export const readFile = async () => "", writeFile = async () => {}, mkdir = readFile, unlink = readFile, stat = readFile;`,
};
const hooks = `export async function resolve(s, c, next) { return s in ${JSON.stringify(STUBS)} ? { url: "stub:" + s, shortCircuit: true } : next(s, c); }
export async function load(u, c, next) { return u.startsWith("stub:") ? { format: "module", shortCircuit: true, source: ${JSON.stringify(STUBS)}[u.slice(5)] } : next(u, c); }`;
register("data:text/javascript," + encodeURIComponent(hooks));
const FilerPro = (await import("../mods/filer-pro/main.js")).default;

const never = () => new Promise(() => {});
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const ROOT = "/Users/example/Downloads", FILE = `${ROOT}/report.txt`, DIR = `${ROOT}/photos`;
const nul = (...f) => f.map((x) => `${x}\0`).join("");
const FILE_PROBE = nul("f", "0644", "501", "20", "alice", "staff", "501");
const DIR_PROBE = nul("d", "0755", "501", "20", "alice", "staff", "501");

function host({ props = {}, platform = "macos", answer = () => undefined } = {}) {
  const log = { execs: [], shared: [], overlays: [], closed: [], notes: [] };
  const store = {};
  globalThis.__impl = {
    props: () => props, appHome: () => "/app", home: () => "/Users/example", window: () => ({ platform }),
    theme: () => new Proxy({}, { get: (_t, k) => String(k) }), settings: () => ({ dark: true }),
    spaces: () => [], panes: () => [], focused: () => ({}), shared: (k) => store[k], setShared: (k, v) => { store[k] = v; log.shared.push([k, v]); },
    readTextFile: async () => null,
    exec: async (cmd, args, opts) => {
      log.execs.push({ cmd, args, opts });
      return answer(cmd, args, opts) ?? { code: 0, stdout: "", stderr: "" };
    },
    openOverlay: (o) => { log.overlays.push(o); return "ov1"; }, closeOverlay: (id) => log.closed.push(id),
    notify: (n) => log.notes.push(n), watchFolder: never, nextCommand: never, layout: () => ({}), exists: async () => false, hc: async () => ({ code: 0, stdout: "{}", stderr: "" }),
  };
  return log;
}
function fakeCx() {
  const cx = { notes: 0, notify() { cx.notes++; }, sleep: never, stop_propagation() {}, focus_handle: () => ({ focus() {} }), timer: { after() {} }, spawn: (fn) => { const p = Promise.resolve().then(() => fn(cx)); p.catch(() => {}); return p; } };
  return cx;
}
function* walk(e) {
  if (!e || typeof e !== "object") return;
  yield e;
  for (const k of e.kids ?? []) yield* walk(k);
}
const idOf = (el) => el.calls?.find((c) => c[0] === "id")?.[1];
const byId = (root, id) => [...walk(root)].find((e) => idOf(e) === id);
const click = (root, id, cx) => { const el = byId(root, id); const c = el.calls.find(([k]) => k === "on_click"); if (!c) return false; c.at(-1)({}, cx); return true; };
const execsOf = (log, script) => log.execs.filter((e) => e.cmd === "sh" && e.args[1] === script);

// The overlay copy of the dialog, opened for `path`.
async function dialog(over = {}) {
  const p = { overlay: "ov1", view: "permissions", machine: null, path: FILE, root: ROOT, isDir: false, ...(over.props ?? {}) };
  const log = host({ props: p, answer: (cmd, args) => {
    if (args[1] === PROBE_SCRIPT) return { code: 0, stdout: over.probe ?? FILE_PROBE, stderr: "" };
    return over.answer?.(cmd, args);
  } });
  const cx = fakeCx();
  const self = Object.assign(Object.create(FilerPro.prototype), {});
  self.init(null, cx);
  await settle();
  return { self, log, cx, view: () => self.render(cx) };
}

test("the row menu entry Permissions… opens the dialog with the entry, its root and machine", () => {
  const log = host({ props: { overlay: "m1", view: "menu", machine: "box", root: ROOT, path: FILE, isDir: false, folder: ROOT } });
  const cx = fakeCx();
  const self = Object.assign(Object.create(FilerPro.prototype), {});
  self.init(null, cx);
  click(self.render(cx), "filer-pro-menu-permissions", cx);
  const o = log.overlays.at(-1);
  assert.equal(o.props.view, "permissions");
  assert.deepEqual([o.props.machine, o.props.path, o.props.root, o.props.isDir], ["box", FILE, ROOT, false]);
  assert.equal(o.kind, "dialog");
  assert.equal(o.modal, true);
  assert.deepEqual(log.closed, ["m1"], "the popup closes");
});

test("on local Windows the menu entry is dimmed and does nothing", () => {
  const log = host({ platform: "windows", props: { overlay: "m1", view: "menu", root: ROOT, path: FILE, isDir: false, folder: ROOT } });
  const cx = fakeCx();
  const self = Object.assign(Object.create(FilerPro.prototype), {});
  self.init(null, cx);
  assert.equal(click(self.render(cx), "filer-pro-menu-permissions", cx), false);
  assert.equal(log.overlays.length, 0);
});

test("the dialog reads the mode with the probe script, path as argv, on the machine", async () => {
  const { log, self } = await dialog({ props: { machine: "box" } });
  assert.deepEqual(execsOf(log, PROBE_SCRIPT).map((e) => [e.args, e.opts]), [[["-c", PROBE_SCRIPT, "x", FILE], { on: "box" }]]);
  assert.equal(self.perms.phase, "ready");
  assert.equal(self.perms.text, "644");
  assert.equal(self.perms.input.value(), "644");
});

test("Apply shows the confirmation with old and new mode and runs no chmod", async () => {
  const { log, cx, view, self } = await dialog();
  click(view(), "filer-pro-perms-others-w", cx);
  assert.equal(self.perms.input.value(), "646", "the octal field follows the box");
  click(view(), "filer-pro-perms-apply", cx);
  await settle();
  assert.equal(self.perms.stage, "confirm");
  assert.equal(execsOf(log, CHMOD_SCRIPT).length, 0);
  const change = byId(view(), "filer-pro-perms-change");
  assert.deepEqual(change.kids, ["644 → 646"]);
  assert.ok(byId(view(), "filer-pro-perms-warnings").kids.length >= 1, "world writable is listed");
});

test("Back returns to the form, Cancel changes nothing", async () => {
  const { log, cx, view, self } = await dialog();
  click(view(), "filer-pro-perms-others-r", cx);
  click(view(), "filer-pro-perms-apply", cx);
  click(view(), "filer-pro-perms-back", cx);
  assert.equal(self.perms.stage, "edit");
  click(view(), "filer-pro-perms-cancel", cx);
  assert.deepEqual(log.closed, ["ov1"]);
  assert.equal(execsOf(log, CHMOD_SCRIPT).length, 0);
});

test("Change runs chmod with the five digit mode and the path as argv, reloads and closes", async () => {
  const { log, cx, view } = await dialog({ answer: (cmd, args) => (args[1] === CHMOD_SCRIPT ? { code: 0, stdout: "0600\n", stderr: "" } : undefined) });
  click(view(), "filer-pro-perms-group-r", cx);
  click(view(), "filer-pro-perms-others-r", cx);
  click(view(), "filer-pro-perms-apply", cx);
  click(view(), "filer-pro-perms-confirm", cx);
  await settle();
  assert.deepEqual(execsOf(log, CHMOD_SCRIPT).map((e) => e.args), [["-c", CHMOD_SCRIPT, "x", "00600", FILE, "0"]]);
  assert.ok(log.shared.some(([k]) => k === "filer-pro.changed"), "the row reloads");
  assert.deepEqual(log.closed, ["ov1"]);
  assert.deepEqual(log.notes.map((n) => [n.title, n.level, n.body]), [["Permissions changed", "success", "report.txt: 644 → 600"]]);
});

test("a result that differs from the request is a warning notice (the system dropped a bit)", async () => {
  const { log, cx, view, self } = await dialog({ probe: DIR_PROBE, props: { path: DIR, isDir: true }, answer: (cmd, args) => (args[1] === CHMOD_SCRIPT ? { code: 0, stdout: "0755\n", stderr: "" } : undefined) });
  self.perms.input.v = "2755"; // typed into the octal field
  self.perms.input.h.change({}, cx);
  click(view(), "filer-pro-perms-apply", cx);
  click(view(), "filer-pro-perms-confirm", cx);
  await settle();
  assert.deepEqual(execsOf(log, CHMOD_SCRIPT).map((e) => e.args[3]), ["02755"]);
  assert.deepEqual(log.notes.map((n) => [n.title, n.level, n.body]), [["Permissions differ from the request", "warning", "photos: asked for 2755, the system set 755"]]);
  assert.ok(log.shared.some(([k]) => k === "filer-pro.changed"), "the row reloads anyway");
});

test("a refusal by the system stays in the dialog, which stays open", async () => {
  const { log, cx, view, self } = await dialog({ answer: (cmd, args) => (args[1] === CHMOD_SCRIPT ? { code: 1, stdout: "", stderr: "chmod: cannot access 'x': Permission denied\n" } : undefined) });
  click(view(), "filer-pro-perms-others-r", cx);
  click(view(), "filer-pro-perms-apply", cx);
  click(view(), "filer-pro-perms-confirm", cx);
  await settle();
  assert.equal(self.perms.error, "chmod: cannot access 'x': Permission denied");
  assert.deepEqual(log.closed, []);
  assert.equal(log.notes.length, 0);
  assert.equal(self.perms.busy, false);
});

test("a recursive apply counts the entries first and names them in the confirmation", async () => {
  const { log, cx, view, self } = await dialog({ probe: DIR_PROBE, props: { path: DIR, isDir: true }, answer: (cmd, args) => (args[1] === COUNT_SCRIPT ? { code: 0, stdout: "  17\n", stderr: "" } : args[1] === GUARD_SCRIPT ? { code: 0, stdout: nul("y", "d", ROOT, ROOT, "/Users/example", "n", "n", "n", "n"), stderr: "" } : undefined) });
  click(view(), "filer-pro-perms-recursive", cx);
  click(view(), "filer-pro-perms-apply", cx);
  await settle();
  assert.deepEqual(execsOf(log, COUNT_SCRIPT).map((e) => e.args), [["-c", COUNT_SCRIPT, "x", DIR]]);
  assert.equal(self.perms.stage, "confirm");
  assert.equal(execsOf(log, CHMOD_SCRIPT).length, 0);
  const text = [...walk(byId(view(), "filer-pro-perms-warnings"))].flatMap((e) => e.kids).filter((k) => typeof k === "string").join("\n");
  assert.match(text, /17 items/);
  assert.equal(self.perms.count, 17);
  click(view(), "filer-pro-perms-confirm", cx);
  await settle();
  assert.equal(execsOf(log, CHMOD_SCRIPT)[0].args[5], "1");
});

test("not the owner: the form is read only, the note says why, Apply does nothing", async () => {
  const { log, cx, view, self } = await dialog({ probe: nul("f", "0644", "0", "0", "root", "wheel", "501") });
  assert.equal(self.perms.readOnly, "Not the owner, permissions cannot be changed");
  click(view(), "filer-pro-perms-others-w", cx);
  assert.equal(self.perms.mode, 0o644);
  assert.equal(click(view(), "filer-pro-perms-apply", cx), false, "the button has no click handler");
  assert.equal(execsOf(log, CHMOD_SCRIPT).length, 0);
});

test("a probe that fails shows its message and offers only Close", async () => {
  const { view, self } = await dialog({ answer: () => undefined, probe: "garbage" });
  assert.equal(self.perms.phase, "error");
  assert.ok(byId(view(), "filer-pro-perms-cancel"));
  assert.equal(byId(view(), "filer-pro-perms-apply"), undefined);
});
