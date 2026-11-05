// The settings dialog state (mods/filer-pro/ui/settings.js) on stubbed gpui modules: fields from the snapshot,
// validation, the edits it writes, and the view (SVG warning right below the switch, every setting listed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// A tiny element tree: every builder call is recorded, children are kept, so the view can be searched.
const GPUI = `
const el = (tag, ...args) => { const e = { tag, args, kids: [], calls: [] };
  return new Proxy(e, { get(t, k) { if (k in t) return t[k]; return (...a) => { t.calls.push([k, a]); if (k === "child") t.kids.push(a[0]); if (k === "children") t.kids.push(...a[0]); if (k === "when" && a[0]) a[1](new Proxy(t, this)); return new Proxy(t, this); }; } }); };
export class View {}
export const div = (...a) => el("div", ...a), svg = div, image = div;
export const v_flex = (...a) => el("v_flex", ...a), h_flex = v_flex, Input = { new: (s) => el("input", s) };
export class InputState { static new(o) { const s = new InputState(); s.v = o.value; s.handlers = {}; s.focused = 0; return s; }
  on(ev, fn) { this.handlers[ev] = fn; } value() { return this.v; } focus() { this.focused++; }
  type(v, cx) { this.v = v; this.handlers.change?.({}, cx); } }
`;
const hooks = `const S = ${JSON.stringify(GPUI)};
export async function resolve(s, c, next) { return s === "gpui-kit" || s === "gpui-base" ? { url: "stub:gpui", shortCircuit: true } : next(s, c); }
export async function load(u, c, next) { return u === "stub:gpui" ? { format: "module", shortCircuit: true, source: S } : next(u, c); }`;
register("data:text/javascript," + encodeURIComponent(hooks));
const { createSettingsDialog, collect, submitSettings, settingsView, editorChoices, SVG_WARNING, BROKEN } = await import("../mods/filer-pro/ui/settings.js");
const { loadConfig } = await import("../mods/filer-pro/lib/config.js");
const { SETTINGS } = await import("../mods/filer-pro/lib/settings.js");

const cx = { notify() {}, focus_handle: () => ({}), timer: { after() {} } };
async function snapshot(raw) {
  const text = raw === undefined ? null : JSON.stringify(raw);
  const config = await loadConfig(async () => text, () => "/app", () => "/home/u");
  return { config, raw: raw ?? null, broken: false };
}
const type = (state, key, v) => state.fields[key].input.type(v, cx);

test("dialog: every setting starts with its current value; ~/ stays as written", async () => {
  const s = createSettingsDialog(await snapshot({ download_folder: "~/Inbox", list_total: 7000, svg_check: false }), cx);
  assert.equal(s.fields.download_folder.value, "~/Inbox");
  assert.equal(s.fields.list_total.value, "7000");
  assert.equal(s.fields.tree_depth.value, "40");
  assert.equal(s.fields.node_path.value, "");
  assert.equal(s.flags.svg_check, false);
  assert.equal(s.flags.update_check, true);
  for (const k of SETTINGS.map((x) => x.key)) assert.ok(k in s.fields || k in s.flags, k);
  assert.equal(s.terminal.choice, "vi");
  assert.equal(s.gui.choice, "VS Code");
  assert.equal(s.terminal.slots.length, 2, "two empty slots");
  assert.ok(s.fields.download_folder.input.focused > 0);
});

test("dialog: nothing changed writes nothing; a changed field is the only edit", async () => {
  const s = createSettingsDialog(await snapshot({ my_key: 1, list_total: 7000 }), cx);
  assert.deepEqual(collect(s), {});
  type(s, "list_total", "8000");
  s.flags.preview = false;
  assert.deepEqual(collect(s), { list_total: 8000, preview: false });
});

test("dialog: invalid values are marked and nothing is written", async () => {
  const s = createSettingsDialog(await snapshot(undefined), cx);
  type(s, "list_per_folder", "abc");
  type(s, "ssh_connect_timeout", "15 -o ProxyCommand=x");
  type(s, "download_folder", " ");
  type(s, "node_path", "node");
  const writes = [];
  const io = { readTextFile: async () => "{}", writeTextFile: async (...a) => { writes.push(a); }, path: "/app/filer-pro.json" };
  assert.equal(await submitSettings(s, io, cx), false);
  assert.deepEqual(writes, []);
  assert.equal(s.error, "Fix the marked fields");
  assert.equal(s.fields.list_per_folder.error, "Must be a whole number");
  assert.equal(s.fields.ssh_connect_timeout.error, "Must be a whole number");
  assert.equal(s.fields.download_folder.error, "Must not be empty");
  assert.equal(s.fields.node_path.error, "Must be an absolute path, or empty for automatic");
  type(s, "list_per_folder", "600");
  assert.equal(s.fields.list_per_folder.error, null, "typing clears the field's message");
});

test("dialog: save writes only the changed keys and keeps the rest of the file", async () => {
  const s = createSettingsDialog(await snapshot({ my_key: { a: 1 }, preview: false }), cx);
  type(s, "refresh_seconds", "30");
  let file = '{"my_key":{"a":1},"preview":false,"mermaid":false}';
  const io = { readTextFile: async () => file, writeTextFile: async (_p, text, expected) => { assert.equal(expected, file); file = text; }, path: "/app/filer-pro.json" };
  assert.equal(await submitSettings(s, io, cx), true);
  assert.deepEqual(JSON.parse(file), { my_key: { a: 1 }, preview: false, mermaid: false, refresh_seconds: 30 });
});

test("dialog: own editors from the file, a broken one shows its reason, a new one can be picked", async () => {
  const s = createSettingsDialog(await snapshot({ terminal_editors: [{ name: "nvim", command: "nvim" }, { name: "bad", command: "x {path}" }], terminal_editor: "nvim" }), cx);
  assert.equal(s.terminal.slots.length, 4);
  assert.equal(s.terminal.slots[1].command.value, "x {path}");
  assert.equal(s.terminal.choice, "nvim");
  assert.equal(collect(s), null);
  assert.deepEqual(s.terminal.errors, [null, "Must not contain {path} (the path is appended)", null, null]);
  s.terminal.slots[1].name.input.type("", cx); s.terminal.slots[1].command.input.type("", cx);
  s.gui.slots[0].name.input.type("Mine", cx); s.gui.slots[0].local.input.type("mine {path}", cx);
  assert.ok(editorChoices(s.gui).includes("Mine"));
  s.gui.choice = "Mine";
  assert.deepEqual(collect(s), { terminal_editors: [{ name: "nvim", command: "nvim" }], gui_editors: [{ name: "Mine", local: "mine {path}" }], gui_editor: "Mine" });
});

test("dialog: a broken file is reported at once and Save writes nothing", async () => {
  const s = createSettingsDialog({ config: (await snapshot(undefined)).config, raw: null, broken: true }, cx);
  assert.equal(s.error, BROKEN);
  const writes = [];
  assert.equal(await submitSettings(s, { readTextFile: async () => "{nope", writeTextFile: async (...a) => writes.push(a), path: "x" }, cx), false);
  assert.deepEqual(writes, []);
});

// Depth-first list of every element's text children and ids.
function texts(e, out = []) {
  if (typeof e === "string") { out.push(e); return out; }
  if (!e || typeof e !== "object") return out;
  for (const [k, a] of e.calls ?? []) if (k === "id") out.push(`#${a[0]}`);
  for (const k of e.kids ?? []) texts(k, out);
  return out;
}

test("view: every setting is listed, the SVG warning comes right after the SVG switch", async () => {
  const s = createSettingsDialog(await snapshot(undefined), cx);
  const t = new Proxy({}, { get: (_o, k) => k });
  const out = texts(settingsView(t, s, { onCancel() {}, onSave() {} }));
  for (const x of SETTINGS) assert.ok(out.includes(`#filer-pro-settings-${x.key}`), x.key);
  const sw = out.indexOf("#filer-pro-settings-svg_check"), warn = out.indexOf("#filer-pro-settings-svg-warning");
  assert.ok(sw >= 0 && warn > sw, "the warning follows the switch");
  assert.ok(out.slice(sw + 1, warn).every((x) => !x.startsWith("#")), "nothing in between");
  assert.ok(out.includes(SVG_WARNING));
  assert.ok(out.includes("Save") && out.includes("Cancel"));
});
