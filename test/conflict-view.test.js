// The question dialog (mods/filer-pro/ui/conflict.js) on stubbed gpui modules: the Move question before a move across sides (#100).
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// A tiny element tree: every builder call is recorded, children are kept, so the view can be searched.
const GPUI = `
const el = (tag, ...args) => { const e = { tag, args, kids: [], calls: [] };
  return new Proxy(e, { get(t, k) { if (k in t) return t[k]; return (...a) => { t.calls.push([k, a]); if (k === "child") t.kids.push(a[0]); if (k === "children") t.kids.push(...a[0]); if (k === "when" && a[0]) a[1](new Proxy(t, this)); return new Proxy(t, this); }; } }); };
export class View {}
export const div = (...a) => el("div", ...a), svg = (...a) => el("svg", ...a), image = div;
export const v_flex = (...a) => el("v_flex", ...a), h_flex = v_flex, Input = { new: (s) => el("input", s) }, Scrollbar = { vertical: (...a) => el("scrollbar", ...a) };
export class InputState { static new(o) { const s = new InputState(); s.v = o.value; s.placeholder = o.placeholder; s.handlers = {}; s.focused = 0; return s; }
  on(ev, fn) { this.handlers[ev] = fn; } value() { return this.v; } set_value(v) { this.v = v; } focus() { this.focused++; }
  type(v, cx) { this.v = v; this.handlers.change?.({}, cx); } fire(ev, cx) { this.handlers[ev]?.({}, cx); } }
`;
const hooks = `const S = ${JSON.stringify(GPUI)};
export async function resolve(s, c, next) { return s === "gpui-kit" || s === "gpui-base" ? { url: "stub:gpui", shortCircuit: true } : next(s, c); }
export async function load(u, c, next) { return u === "stub:gpui" ? { format: "module", shortCircuit: true, source: S } : next(u, c); }`;
register("data:text/javascript," + encodeURIComponent(hooks));
const { conflictView } = await import("../mods/filer-pro/ui/conflict.js");
const { moveNote, moveTitle } = await import("../mods/filer-pro/lib/conflicttext.js");

const t = new Proxy({}, { get: (_o, k) => k });
const handlers = { onChoose() {}, onToggleAll() {} };
function* walk(e) {
  if (!e || typeof e !== "object") return;
  yield e;
  for (const k of e.kids ?? []) yield* walk(k);
}
function texts(e, out = []) {
  if (typeof e === "string") { out.push(e); return out; }
  if (!e || typeof e !== "object") return out;
  for (const k of e.kids ?? []) texts(k, out);
  return out;
}
const byId = (root, id) => [...walk(root)].find((e) => e.calls?.some(([k, a]) => k === "id" && a[0] === id));
const called = (e, name) => e.calls.filter(([k]) => k === name).map(([, a]) => a);
const A = "host-a.example.com", B = "host-b.example.com";
const ask = (item) => conflictView(t, { batch: "b#0", item: { name: "a.txt", isDir: false, count: 1, size: null, ...item }, choices: ["move", "cancel"], remaining: 1 }, {}, handlers);

test("move dialog: a remote source has a red Move and the permanent note", () => {
  const item = { from: A, machine: null, direction: "down", trash: false };
  const v = ask(item);
  const move = byId(v, "filer-pro-choice-move");
  assert.ok(called(move, "text_color").some(([c]) => c === "ansi1"));
  assert.equal(called(move, "bg").length, 0);
  const note = byId(v, "filer-pro-move-note");
  assert.equal(texts(note).join(""), moveNote({ ...item, count: 1 }));
  assert.ok(called(note, "border_color").some(([c]) => c === "ansi1"));
  assert.ok(texts(v).includes(moveTitle(item)));
});
test("move dialog: a local source has an accent Move and the Trash note", () => {
  const item = { from: null, machine: A, direction: "up", trash: true };
  const v = ask(item);
  const move = byId(v, "filer-pro-choice-move");
  assert.ok(called(move, "bg").some(([c]) => c === "accent"));
  assert.ok(called(move, "text_color").some(([c]) => c === "accent_foreground"));
  assert.equal(called(move, "text_color").some(([c]) => c === "ansi1"), false);
  const note = byId(v, "filer-pro-move-note");
  assert.equal(texts(note).join(""), "You can put the original back from the Trash.");
  assert.equal(called(note, "border_1").length, 0);
});
test("move dialog: no Don't show again, Cancel and Move only", () => {
  const v = ask({ from: A, machine: null, direction: "down", trash: false });
  assert.equal(byId(v, "filer-pro-cross-dont-show"), undefined);
  assert.equal(texts(v).some((x) => x.includes("Don't show again")), false);
  const ids = [...walk(v)].flatMap((e) => (e.calls ?? []).filter(([k]) => k === "id").map(([, a]) => a[0])).filter((i) => i.startsWith("filer-pro-choice-"));
  assert.deepEqual(ids.sort(), ["filer-pro-choice-cancel", "filer-pro-choice-move"]);
  assert.deepEqual(texts(byId(v, "filer-pro-choice-move")), ["Move"]);
});
test("move dialog: the cross route names both machines and this computer", () => {
  const v = ask({ from: A, machine: B, direction: "cross", trash: false });
  assert.deepEqual(texts(byId(v, "filer-pro-cross-route")), [A, "→", "this computer", "→", B]);
  const d = ask({ from: A, machine: null, direction: "down", trash: false });
  assert.deepEqual(texts(byId(d, "filer-pro-cross-route")), [A, "→", "this computer"]);
  const u = ask({ from: null, machine: A, direction: "up", trash: true });
  assert.deepEqual(texts(byId(u, "filer-pro-cross-route")), ["this computer", "→", A]);
});
