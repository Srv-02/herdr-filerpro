// The "Esc" badge at the top right of Settings, Rename / New Folder and Permissions closes the dialog with a click (#89),
// like the Cancel button and the Escape key. Built on the same stubbed gpui modules as test/settings-dialog.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

const GPUI = `
const el = (tag, ...args) => { const e = { tag, args, kids: [], calls: [] };
  return new Proxy(e, { get(t, k) { if (k in t) return t[k]; return (...a) => { t.calls.push([k, a]); if (k === "child") t.kids.push(a[0]); if (k === "children") t.kids.push(...a[0]); if (k === "when" && a[0]) a[1](new Proxy(t, this)); return new Proxy(t, this); }; } }); };
export class View {}
export const div = (...a) => el("div", ...a), svg = (...a) => el("svg", ...a), image = div;
export const v_flex = (...a) => el("v_flex", ...a), h_flex = v_flex, Input = { new: (s) => el("input", s) }, Scrollbar = { vertical: (...a) => el("scrollbar", ...a) };
export class InputState { static new(o) { const s = new InputState(); s.v = o.value; s.handlers = {}; return s; }
  on(ev, fn) { this.handlers[ev] = fn; } value() { return this.v; } set_value(v) { this.v = v; } set_selected_range() {} focus() {} }
`;
const hooks = `const S = ${JSON.stringify(GPUI)};
export async function resolve(s, c, next) { return s === "gpui-kit" || s === "gpui-base" ? { url: "stub:gpui", shortCircuit: true } : next(s, c); }
export async function load(u, c, next) { return u === "stub:gpui" ? { format: "module", shortCircuit: true, source: S } : next(u, c); }`;
register("data:text/javascript," + encodeURIComponent(hooks));
const { settingsView, createSettingsDialog } = await import("../mods/filer-pro/ui/settings.js");
const { nameView, createNameDialog } = await import("../mods/filer-pro/ui/namedialog.js");
const { permsView, createPermsDialog } = await import("../mods/filer-pro/ui/permsdialog.js");
const { loadConfig } = await import("../mods/filer-pro/lib/config.js");

const t = new Proxy({}, { get: (_o, k) => k });
const cx = { notify() {}, focus_handle: () => ({ focus() {} }), timer: { after() {} }, stop_propagation() {} };
function* walk(e) {
  if (!e || typeof e !== "object") return;
  yield e;
  for (const k of e.kids ?? []) yield* walk(k);
}
const byId = (root, id) => [...walk(root)].find((e) => e.calls?.some(([k, a]) => k === "id" && a[0] === id));
const called = (e, name) => e.calls.filter(([k]) => k === name).map(([, a]) => a);

// The badge is found by id, has the close affordances, and its click reaches the dialog's cancel handler once.
function checkBadge(root, id, cancels) {
  const badge = byId(root, id);
  assert.ok(badge, `${id} exists`);
  assert.deepEqual(badge.kids, ["Esc"], "the text stays");
  assert.equal(called(badge, "cursor_pointer").length, 1);
  assert.equal(called(badge, "hover").length, 1);
  assert.deepEqual(called(badge, "tooltip"), [["Close"]]);
  assert.deepEqual(called(badge, "accessibility_label"), [["Close"]]);
  const [[handler]] = called(badge, "on_click");
  assert.equal(cancels.length, 0);
  handler({}, cx);
  assert.equal(cancels.length, 1, "the cancel handler fired once");
}

test("Settings: the Esc badge closes the dialog", async () => {
  const config = await loadConfig(async () => null, () => "/app", () => "/home/u");
  const state = createSettingsDialog({ config, raw: null, broken: false, version: "1.0.0" }, cx);
  const cancels = [];
  checkBadge(settingsView(t, state, { onCancel: () => cancels.push(1), onSave() {}, onCheck() {}, onChoose() {} }), "filer-pro-settings-esc", cancels);
});

test("Rename / New Folder: the Esc badge closes the dialog", () => {
  const spec = { title: "Rename", button: "Rename", id: "rename", value: "a.txt", selectEnd: 1, check: () => null };
  const state = createNameDialog(spec, { onSubmit() {} }, cx);
  const cancels = [];
  checkBadge(nameView(t, state, { onCancel: (c) => cancels.push(c) }), "filer-pro-rename-esc", cancels);
  assert.equal(cancels[0], cx, "the cancel handler gets cx, as for the Cancel button");
});

test("Permissions: the Esc badge closes the dialog", () => {
  const state = createPermsDialog({ name: "a.txt", isDir: false }, cx);
  const cancels = [];
  checkBadge(permsView(t, state, { onCancel: () => cancels.push(1), onApply() {}, onRecursive() {} }), "filer-pro-perms-esc", cancels);
});
