// The PDF part of mods/filer-pro/preview/index.js on stubbed gpui modules: the header buttons (panel and dialog) and the two
// views (picture in the panel, pages in the dialog). Every builder call is recorded so the tree can be searched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

const GPUI = `
const el = (tag, ...args) => { const e = { tag, args, kids: [], calls: [] };
  return new Proxy(e, { get(t, k) { if (k in t) return t[k]; return (...a) => { t.calls.push([k, a]); if (k === "child") t.kids.push(a[0]); if (k === "children") t.kids.push(...a[0]); if (k === "when" && a[0]) a[1](new Proxy(t, this)); return new Proxy(t, this); }; } }); };
export class View {}
export const div = (...a) => el("div", ...a), svg = (...a) => el("svg", ...a), image = (...a) => el("image", ...a);
export const v_flex = (...a) => el("v_flex", ...a), h_flex = (...a) => el("h_flex", ...a);
export const TextView = { markdown: (...a) => el("markdown", ...a), html: (...a) => el("html", ...a) };
`;
const hooks = `const S = ${JSON.stringify(GPUI)};
export async function resolve(s, c, next) { return s === "gpui-kit" || s === "gpui-base" ? { url: "stub:gpui", shortCircuit: true } : next(s, c); }
export async function load(u, c, next) { return u === "stub:gpui" ? { format: "module", shortCircuit: true, source: S } : next(u, c); }`;
register("data:text/javascript," + encodeURIComponent(hooks));
const { tools, view } = await import("../mods/filer-pro/preview/index.js");
const { ACTIONS, PDF_CONTEXT } = await import("../mods/filer-pro/lib/pdfkeys.js");

const t = { muted: "muted", dim: "dim", hover: "hover", selected: "selected", border: "border", raised: "raised", ansi1: "red", foreground: "fg" };
const calls = (e, name) => e.calls.filter(([k]) => k === name);
const has = (e, name) => calls(e, name).length > 0;
const arg = (e, name) => calls(e, name).at(-1)?.[1][0];
const all = (e) => [e, ...e.kids.flatMap((k) => (k && typeof k === "object" && "kids" in k ? all(k) : []))];
const byId = (els, id) => els.flatMap(all).find((e) => calls(e, "id").some(([, [v]]) => v === id));
const textOf = (e) => calls(e, "child").map(([, [c]]) => c).filter((c) => typeof c === "string").join("");
const doc = { kind: "pdf", path: "x.png", page: 3, pages: 12, width: 300, height: 400 };
const noop = () => {};
const hs = () => { const log = []; return { log, onToggle: noop, onOpen: noop, onPage: (n) => log.push(["page", n]), onZoom: (d) => log.push(["zoom", d]), onLayout: (v) => log.push(["layout", v]) }; };
const model = (over = {}) => ({ mode: "preview", canOpen: false, page: 3, pages: 12, full: false, spread: false, percent: 100, preset: "page", ...over });

test("panel: previous, counter, next only, as icon buttons with ids, tooltips and chevrons", () => {
  const h = hs(), out = tools(doc, model(), t, h);
  assert.equal(out.length, 3);
  const [prev, counter, next] = out;
  assert.equal(arg(prev, "id"), "files-page-prev");
  assert.equal(arg(next, "id"), "files-page-next");
  assert.equal(arg(prev, "tooltip"), "Previous page");
  assert.equal(arg(prev, "accessibility_label"), "Previous page");
  assert.equal(arg(next, "tooltip"), "Next page");
  assert.equal(arg(next, "accessibility_label"), "Next page");
  assert.equal(all(prev).find((e) => e.tag === "svg").args[0], "mods/filer-pro/chevron-left.svg");
  assert.equal(all(next).find((e) => e.tag === "svg").args[0], "mods/filer-pro/chevron-right.svg");
  assert.equal(textOf(counter), "3 / 12");
  assert.equal(arg(counter, "text_size"), 11);
  assert.equal(arg(counter, "text_color"), "muted");
  calls(prev, "on_click")[0][1][0]({}, {});
  calls(next, "on_click")[0][1][0]({}, {});
  assert.deepEqual(h.log, [["page", 2], ["page", 4]]);
  for (const id of ["files-layout", "files-layout-single", "files-layout-spread", "files-zoom-presets", "files-zoom-page", "files-zoom-width", "files-zoom-actual", "files-zoom-out", "files-zoom-level", "files-zoom-in"]) assert.equal(byId(out, id), undefined, `${id} not in the panel`);
});

test("panel ignores spread and zoom fields without full", () => {
  const out = tools(doc, model({ spread: true }), t, hs());
  assert.equal(out.length, 3);
  assert.equal(textOf(out[1]), "3 / 12", "no spread label in the panel");
});

test("edge buttons are dimmed and have no click", () => {
  const first = tools(doc, model({ page: 1 }), t, hs()), last = tools(doc, model({ page: 12 }), t, hs());
  const prev = first[0], next = last[2];
  for (const b of [prev, next]) {
    assert.equal(has(b, "on_click"), false);
    assert.equal(has(b, "cursor_pointer"), false);
    assert.equal(has(b, "hover"), false);
    assert.equal(all(b).find((e) => e.tag === "svg").calls.find(([k]) => k === "text_color")[1][0], "dim");
  }
  assert.equal(has(first[2], "on_click"), true, "the other end still clicks");
  const live = all(first[2]).find((e) => e.tag === "svg").calls.find(([k]) => k === "text_color")[1][0];
  assert.equal(live, "muted");
});

const seg = (out, id) => byId(out, id);
const IDS = ["files-layout-single", "files-layout-spread", "files-zoom-page", "files-zoom-width", "files-zoom-actual", "files-zoom-out", "files-zoom-level", "files-zoom-in"];

test("dialog adds the layout control and the zoom controls after the page buttons", () => {
  const h = hs(), out = tools(doc, model({ full: true, percent: 125, preset: null }), t, h);
  assert.deepEqual(["files-page-prev", "files-page-next", "files-layout", "files-zoom-presets"].map((id) => Boolean(byId(out, id))), [true, true, true, true]);
  for (const id of IDS) assert.ok(byId(out, id), id);
  const order = out.flatMap(all).map((e) => calls(e, "id")[0]?.[1][0]).filter(Boolean);
  assert.ok(order.indexOf("files-page-next") < order.indexOf("files-layout-single"));
  assert.deepEqual(IDS.map((id) => order.indexOf(id)), IDS.map((id) => order.indexOf(id)).sort((a, b) => a - b), "left to right");
  assert.equal(textOf(byId(out, "files-zoom-level")), "125 %");
  const glyph = (id) => all(byId(out, id)).find((e) => e.tag === "svg").args[0];
  assert.equal(glyph("files-layout-single"), "mods/filer-pro/rectangle-vertical.svg");
  assert.equal(glyph("files-layout-spread"), "mods/filer-pro/book-open.svg");
  assert.equal(glyph("files-zoom-out"), "mods/filer-pro/zoom-out.svg");
  assert.equal(glyph("files-zoom-in"), "mods/filer-pro/zoom-in.svg");
  assert.equal(out.flatMap(all).some((e) => e.args[0] === "mods/filer-pro/move-horizontal.svg"), false, "move-horizontal is gone");
  assert.deepEqual(["files-layout-single", "files-layout-spread", "files-zoom-out", "files-zoom-in"].map((id) => arg(byId(out, id), "tooltip")), ["Single page", "Two pages", "Zoom out", "Zoom in"]);
  assert.deepEqual(["files-layout-single", "files-layout-spread", "files-zoom-out", "files-zoom-in"].map((id) => arg(byId(out, id), "accessibility_label")), ["Single page", "Two pages", "Zoom out", "Zoom in"]);
  assert.deepEqual(["files-zoom-page", "files-zoom-width", "files-zoom-actual"].map((id) => textOf(byId(out, id))), ["Page", "Width", "100 %"]);
  for (const id of ["files-zoom-page", "files-zoom-width", "files-zoom-actual"]) assert.ok(arg(byId(out, id), "tooltip"), `${id} has a tooltip`);
  for (const id of ["files-zoom-out", "files-zoom-in"]) assert.equal(has(byId(out, id), "bg"), false, `${id} not selected`);
  for (const id of ["files-layout-single", "files-layout-spread", "files-zoom-page", "files-zoom-width", "files-zoom-actual", "files-zoom-out", "files-zoom-in"]) calls(byId(out, id), "on_click")[0][1][0]({}, {});
  assert.deepEqual(h.log, [["layout", false], ["layout", true], ["zoom", "page"], ["zoom", "width"], ["zoom", "actual"], ["zoom", "out"], ["zoom", "in"]]);
});

test("segmented groups: bordered, rounded, gapless; the active segment is selected and foreground", () => {
  const out = tools(doc, model({ full: true }), t, hs());
  for (const id of ["files-layout", "files-zoom-presets"]) {
    const g = byId(out, id);
    assert.equal(has(g, "border_1"), true, `${id} border`);
    assert.equal(arg(g, "border_color"), "border");
    assert.equal(arg(g, "rounded"), 6);
    assert.equal(has(g, "gap"), false, "segments touch");
  }
  // single page + Page preset: those two are on, the others are not
  const on = (id) => arg(seg(out, id), "bg") === "selected";
  assert.deepEqual(["files-layout-single", "files-layout-spread", "files-zoom-page", "files-zoom-width", "files-zoom-actual"].map(on), [true, false, true, false, false]);
  const color = (id) => (has(seg(out, id), "text_color") ? arg(seg(out, id), "text_color") : all(seg(out, id)).find((e) => e.tag === "svg").calls.find(([k]) => k === "text_color")[1][0]);
  assert.equal(color("files-zoom-page"), "fg");
  assert.equal(color("files-zoom-width"), "muted");
  assert.equal(color("files-layout-single"), "fg");
  assert.equal(color("files-layout-spread"), "muted");
  assert.equal(has(seg(out, "files-zoom-width"), "hover"), true, "an inactive segment has a hover");
});

test("preset highlighting: Width, 100 %, and none while stepped away from a preset", () => {
  const sel = (over) => {
    const out = tools(doc, model({ full: true, ...over }), t, hs());
    return ["files-zoom-page", "files-zoom-width", "files-zoom-actual"].filter((id) => arg(seg(out, id), "bg") === "selected");
  };
  assert.deepEqual(sel({ preset: "width" }), ["files-zoom-width"]);
  assert.deepEqual(sel({ preset: "actual", percent: 100 }), ["files-zoom-actual"]);
  assert.deepEqual(sel({ preset: null, percent: 125 }), []);
  assert.deepEqual(sel({ preset: "page", percent: 62 }), ["files-zoom-page"]);
});

test("the value shows the effective percent with and without a preset", () => {
  assert.equal(textOf(byId(tools(doc, model({ full: true, preset: "page", percent: 62 }), t, hs()), "files-zoom-level")), "62 %");
  assert.equal(textOf(byId(tools(doc, model({ full: true, preset: null, percent: 150 }), t, hs()), "files-zoom-level")), "150 %");
});

test("zoom-in is dimmed at 300, zoom-out at 50", () => {
  const max = tools(doc, model({ full: true, percent: 300, preset: null }), t, hs());
  assert.equal(has(byId(max, "files-zoom-in"), "on_click"), false);
  assert.equal(has(byId(max, "files-zoom-out"), "on_click"), true);
  const min = tools(doc, model({ full: true, percent: 50, preset: null }), t, hs());
  assert.equal(has(byId(min, "files-zoom-out"), "on_click"), false);
  assert.equal(has(byId(min, "files-zoom-in"), "on_click"), true);
});

test("two pages: the counter shows both, the spread segment is selected, turning moves by spreads", () => {
  const out = tools(doc, model({ full: true, spread: true }), t, hs());
  assert.equal(textOf(out[1]), "2–3 / 12");
  assert.equal(arg(byId(out, "files-layout-spread"), "bg"), "selected");
  assert.equal(has(byId(out, "files-layout-single"), "bg"), false);
  const h = hs(), again = tools(doc, model({ full: true, spread: true }), t, h);
  calls(again[0], "on_click")[0][1][0]({}, {});
  calls(again[2], "on_click")[0][1][0]({}, {});
  assert.deepEqual(h.log, [["page", 1], ["page", 4]]);
  assert.equal(has(tools(doc, model({ full: true, spread: true, page: 1 }), t, hs())[0], "on_click"), false, "cover: no previous");
});

test("images and the other documents keep their buttons", () => {
  assert.deepEqual(tools({ kind: "image" }, model(), t, hs()), []);
  const md = tools({ kind: "markdown" }, model(), t, hs());
  assert.equal(md.length, 1);
  assert.equal(arg(md[0], "id"), "files-mode");
});

test("picture (panel PDF and image): the child is centered with mx_auto and an explicit width, the container is not", () => {
  const el = view(doc, { t, font: "m", file: "a.pdf", width: 400 }, { onWidth: noop });
  assert.equal(arg(el, "id"), "files-preview");
  assert.equal(has(el, "overflow_y_scrollbar"), true);
  for (const bad of ["items_center", "justify_center", "overflow_scrollbar"]) assert.equal(has(el, bad), false, bad);
  const child = el.kids[0];
  assert.equal(arg(child, "id"), "files-image");
  assert.equal(has(child, "mx_auto"), true);
  assert.equal(arg(child, "w"), arg(child.kids[0], "w"));
  assert.ok(arg(child, "w") > 0);
});

const ITEMS = [{ path: "a.png", w: 300, h: 400 }, { path: "b.png", w: 200, h: 400 }];
function pagesView(over = {}) {
  const log = [], h = { onWidth: (w, _cx, h) => log.push(["width", w, h]), onZoom: (d) => log.push(["zoom", d]), onWheel: () => log.push(["wheel"]) };
  const focus = over.focus;
  return { log, el: view(doc, { t, font: "m", file: "a.pdf", width: 400, pdf: { items: ITEMS, focus } }, h) };
}

test("dialog pages view: key context, three actions, scrolls both ways, no centering on the container", () => {
  const focus = { id: "focus" }, { el, log } = pagesView({ focus });
  assert.equal(arg(el, "id"), "files-preview");
  assert.equal(arg(el, "key_context"), PDF_CONTEXT);
  assert.equal(arg(el, "track_focus"), focus);
  assert.equal(has(el, "overflow_scrollbar"), true);
  for (const bad of ["items_center", "justify_center", "overflow_y_scrollbar"]) assert.equal(has(el, bad), false, bad);
  const actions = calls(el, "on_action");
  assert.deepEqual(actions.map(([, [a]]) => a), [ACTIONS.in, ACTIONS.out, ACTIONS.page]);
  actions.forEach(([, [, fn]]) => fn({}, {}));
  assert.deepEqual(log, [["zoom", "in"], ["zoom", "out"], ["zoom", "page"]]);
});

test("dialog pages view without a focus handle draws without track_focus; width and height are reported exactly", () => {
  const { el, log } = pagesView();
  assert.equal(has(el, "track_focus"), false);
  calls(el, "on_size_change")[0][1][0]({ width: 1037.6, height: 500 }, {});
  assert.deepEqual(log, [["width", 1037, 500]], "floored, not in 32 px steps");
});

test("dialog pages view: wrapper with the wheel, row centered with explicit size and one image per item", () => {
  const { el, log } = pagesView();
  const wrap = el.kids[0];
  assert.equal(arg(wrap, "id"), "files-pages");
  assert.equal(has(wrap, "min_w_full"), true);
  assert.equal(has(wrap, "min_h_full"), true);
  const row = wrap.kids[0];
  assert.equal(arg(row, "id"), "files-image");
  assert.equal(has(row, "mx_auto"), true);
  assert.equal(arg(row, "w"), 300 + 200 + 8);
  assert.equal(arg(row, "h"), 400);
  assert.equal(arg(row, "gap"), 8);
  assert.deepEqual(row.kids.map((k) => [k.args[0], arg(k, "w"), arg(k, "h")]), [["a.png", 300, 400], ["b.png", 200, 400]]);
  const wheel = calls(wrap, "on_scroll_wheel")[0][1][0];
  let stopped = 0;
  wheel({ modifiers: { platform: false } }, { stop_propagation: () => stopped++ });
  wheel({}, { stop_propagation: () => stopped++ });
  assert.deepEqual([log.length, stopped], [0, 0], "without cmd the container scrolls on its own");
  wheel({ modifiers: { platform: true } }, { stop_propagation: () => stopped++ });
  assert.deepEqual([log, stopped], [[["wheel"]], 1]);
});

test("the pages view serves the panel too: no focus handle, same centering", () => {
  const { el } = pagesView();
  assert.equal(has(el, "track_focus"), false);
  assert.equal(has(el.kids[0].kids[0], "mx_auto"), true);
});

test("a PDF without ctx.pdf still gets the picture", () => {
  const el = view(doc, { t, font: "m", file: "a.pdf", width: 400 }, { onWidth: noop });
  assert.equal(has(el, "overflow_y_scrollbar"), true);
});
