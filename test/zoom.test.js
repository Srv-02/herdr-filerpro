import { test } from "node:test";
import assert from "node:assert/strict";
import { ZOOM_STEPS, ZOOM_MIN, ZOOM_MAX, MAX_EDGE, RENDER_TIERS, SPREAD_GAP, VIEW_PAD, VIEW_PAD_Y, spreadPages, spreadStart, pageLabel, turnTargets, layout, zoomStep, presetOf, canZoom, renderSize, wheelZoom } from "../mods/filer-pro/preview/zoom.js";
import { ACTIONS, PDF_CONTEXT, ZOOM_KEYS } from "../mods/filer-pro/lib/pdfkeys.js";

test("constants and key table", () => {
  assert.deepEqual(ZOOM_STEPS, [50, 75, 100, 125, 150, 200, 300]);
  assert.deepEqual([ZOOM_MIN, ZOOM_MAX, MAX_EDGE, SPREAD_GAP, VIEW_PAD, VIEW_PAD_Y], [50, 300, 6144, 8, 16, 10]);
  assert.deepEqual(RENDER_TIERS, [3072, 4096, 6144]);
  assert.deepEqual(ACTIONS, { in: "filer_pro_zoom_in", out: "filer_pro_zoom_out", page: "filer_pro_zoom_page" });
  assert.equal(PDF_CONTEXT, "FilerProPdf");
  assert.equal(ZOOM_KEYS.length, 8);
  assert.ok(ZOOM_KEYS.every((b) => b.context === PDF_CONTEXT && Object.values(ACTIONS).includes(b.action)));
  assert.deepEqual(ZOOM_KEYS.map((b) => b.keystroke), ["cmd-+", "cmd-=", "cmd--", "cmd-0", "+", "=", "-", "0"]);
  assert.deepEqual(ZOOM_KEYS.filter((b) => b.action === ACTIONS.page).map((b) => b.keystroke), ["cmd-0", "0"], "cmd-0 and 0 fit the page");
});

test("spreadPages and spreadStart", () => {
  assert.deepEqual(spreadPages(1, 12), [1]);
  assert.deepEqual(spreadPages(2, 12), [2, 3]);
  assert.deepEqual(spreadPages(3, 12), [2, 3]);
  assert.deepEqual(spreadPages(12, 12), [12], "even last page alone");
  assert.deepEqual(spreadPages(11, 11), [10, 11]);
  assert.deepEqual(spreadPages(1, 1), [1]);
  assert.deepEqual(spreadPages(2, 2), [2]);
  assert.deepEqual([1, 2, 3, 4, 5].map(spreadStart), [1, 2, 2, 4, 4]);
});

test("pageLabel", () => {
  assert.equal(pageLabel(3, 12, false), "3 / 12");
  assert.equal(pageLabel(3, 12, true), "2–3 / 12");
  assert.equal(pageLabel(1, 12, true), "1 / 12");
  assert.equal(pageLabel(12, 12, true), "12 / 12");
  assert.equal(pageLabel(11, 11, true), "10–11 / 11");
});

test("turnTargets single and spread", () => {
  assert.deepEqual(turnTargets(1, 5, false), { prev: 0, next: 2 });
  assert.deepEqual(turnTargets(3, 5, false), { prev: 2, next: 4 });
  assert.deepEqual(turnTargets(5, 5, false), { prev: 4, next: 0 });
  assert.deepEqual(turnTargets(1, 1, false), { prev: 0, next: 0 });
  assert.deepEqual(turnTargets(1, 12, true), { prev: 0, next: 2 });
  assert.deepEqual(turnTargets(2, 12, true), { prev: 1, next: 4 });
  assert.deepEqual(turnTargets(3, 12, true), { prev: 1, next: 4 });
  assert.deepEqual(turnTargets(4, 12, true), { prev: 2, next: 6 });
  assert.deepEqual(turnTargets(12, 12, true), { prev: 10, next: 0 });
  assert.deepEqual(turnTargets(10, 11, true), { prev: 8, next: 0 });
  assert.deepEqual(turnTargets(1, 1, true), { prev: 0, next: 0 });
});

test("layout: width mode uses the true width, upscales, floors and clamps", () => {
  const page = [{ width: 600, height: 800 }];
  const f = layout(page, "width", 1032);
  assert.deepEqual(f.items, [{ w: 1000, h: 1333 }]);
  assert.equal(f.percent, 167);
  assert.equal(f.width, 1000);
  assert.equal(f.height, 1333);
  const g = layout([{ width: 100, height: 100 }], "width", 1032);
  assert.equal(g.percent, 300, "width is clamped to ZOOM_MAX");
  assert.deepEqual(g.items, [{ w: 300, h: 300 }]);
  const fl = layout([{ width: 300, height: 700 }], "width", 100 + 2 * VIEW_PAD + 0.9);
  assert.ok(fl.width <= 100.9);
  assert.deepEqual(layout(page, "width", 0).items, [{ w: 600, h: 800 }], "unknown width: factor 1");
  assert.deepEqual(layout(page, "page", 0, 500).items, [{ w: 600, h: 800 }], "unknown width: factor 1 for page too");
  assert.equal(layout(page, "width", 10).width, 80, "room is at least 80");
  assert.equal(layout(page, "width", 1032, 100).height, 1333, "the height is ignored in width mode");
});

test("layout: page mode fits the whole page or spread into the view", () => {
  const page = [{ width: 600, height: 800 }];
  assert.deepEqual(layout(page, "page", 1032, 5000).items, [{ w: 1000, h: 1333 }], "tall view: the width limits");
  const s = layout(page, "page", 1032, 400 + 2 * VIEW_PAD_Y); // the height limits: 400 of 800 points
  assert.equal(s.percent, 50);
  assert.deepEqual(s.items, [{ w: 300, h: 400 }]);
  assert.ok(s.height <= 400 && s.width <= 1032 - 2 * VIEW_PAD);
  const odd = layout([{ width: 601, height: 800 }], "page", 1032, 400 + 2 * VIEW_PAD_Y);
  assert.deepEqual(odd.items, [{ w: 300, h: 400 }], "widths and heights are floored");
  assert.deepEqual(layout(page, "page", 1032, 0).items, [{ w: 1000, h: 1333 }], "no height known yet: width mode");
  assert.equal(layout([{ width: 100, height: 100 }], "page", 2000, 2000).percent, 300, "clamped at ZOOM_MAX");
  const two = layout([{ width: 500, height: 500 }, { width: 500, height: 500 }], "page", 1000 + 2 * VIEW_PAD + SPREAD_GAP, 5000);
  assert.deepEqual(two.items, [{ w: 500, h: 500 }, { w: 500, h: 500 }]);
  assert.equal(two.width, 1008);
  const short = layout([{ width: 500, height: 500 }, { width: 500, height: 500 }], "page", 2000, 250 + 2 * VIEW_PAD_Y);
  assert.deepEqual(short.items, [{ w: 250, h: 250 }, { w: 250, h: 250 }]);
});

test("layout: zoom, spread heights and gap", () => {
  const page = [{ width: 600, height: 800 }];
  assert.deepEqual(layout(page, 200, 500).items, [{ w: 1200, h: 1600 }]);
  assert.equal(layout(page, 200, 500).percent, 200);
  const two = layout([{ width: 600, height: 800 }, { width: 800, height: 800 }], 100, 5000);
  assert.deepEqual(two.items, [{ w: 600, h: 800 }, { w: 800, h: 800 }]);
  assert.equal(two.width, 1400 + SPREAD_GAP);
  assert.equal(two.height, 800);
  const diff = layout([{ width: 600, height: 800 }, { width: 400, height: 400 }], 100, 5000);
  assert.deepEqual(diff.items.map((i) => i.h), [800, 800], "same height");
  assert.deepEqual(diff.items.map((i) => i.w), [600, 800]);
  const fit = layout([{ width: 500, height: 500 }, { width: 500, height: 500 }], "width", 1000 + 2 * VIEW_PAD + SPREAD_GAP);
  assert.deepEqual(fit.items, [{ w: 500, h: 500 }, { w: 500, h: 500 }]);
  assert.equal(fit.width, 1008);
});

test("zoomStep, presetOf and canZoom", () => {
  assert.equal(zoomStep("page", 167, "in"), 200);
  assert.equal(zoomStep("width", 167, "out"), 150);
  assert.equal(zoomStep(100, 100, "in"), 125);
  assert.equal(zoomStep(100, 100, "out"), 75);
  assert.equal(zoomStep(50, 50, "out"), 50);
  assert.equal(zoomStep(300, 300, "in"), 300);
  assert.equal(zoomStep("width", 280, "in"), 300);
  assert.equal(zoomStep("page", 300, "in"), "page", "unchanged");
  assert.equal(zoomStep("page", 30, "out"), "page", "unchanged below the minimum");
  assert.equal(presetOf("page"), "page");
  assert.equal(presetOf("width"), "width");
  assert.equal(presetOf(100), "actual");
  assert.equal(presetOf(125), null);
  assert.equal(presetOf(50), null);
  assert.deepEqual(canZoom(100), { in: true, out: true });
  assert.deepEqual(canZoom(300), { in: false, out: true });
  assert.deepEqual(canZoom(50), { in: true, out: false });
});

test("renderSize", () => {
  const a4 = { width: 595, height: 842 };
  assert.equal(renderSize({ w: 400, h: 566 }, a4), null, "small: base suffices");
  assert.equal(renderSize({ w: 842, h: 595 }, { width: 842, height: 595 }), null);
  assert.equal(renderSize({ w: 1100, h: 1556 }, a4), 4096, "need 3112 px: above the first tier");
  assert.equal(renderSize({ w: 1400, h: 1500 }, a4), 3072);
  assert.equal(renderSize({ w: 1785, h: 2526 }, a4), 6144, "300 % of A4: capped");
  assert.equal(renderSize({ w: 9000, h: 100 }, a4), 6144);
});

test("wheelZoom", () => {
  assert.deepEqual(wheelZoom(0, { delta_lines: { x: 0, y: 1 }, delta: { x: 0, y: 0 } }), { acc: 0, dir: "in" });
  assert.deepEqual(wheelZoom(0, { delta_lines: { x: 0, y: -1 }, delta: { x: 0, y: 0 } }), { acc: 0, dir: "out" });
  let r = wheelZoom(0, { delta: { x: 0, y: 15 } });
  assert.deepEqual(r, { acc: 15, dir: null });
  r = wheelZoom(r.acc, { delta: { x: 0, y: 15 } });
  assert.deepEqual(r, { acc: 30, dir: null });
  r = wheelZoom(r.acc, { delta: { x: 0, y: 15 } });
  assert.deepEqual(r, { acc: 0, dir: "in" });
  assert.deepEqual(wheelZoom(-30, { delta: { x: 0, y: -15 } }), { acc: 0, dir: "out" });
  assert.deepEqual(wheelZoom(20, { delta: { x: 0, y: 1 }, touch_phase: "ended" }), { acc: 0, dir: null });
  assert.deepEqual(wheelZoom(20, { delta: { x: 0, y: 1 }, touch_phase: "cancelled" }), { acc: 0, dir: null });
  assert.deepEqual(wheelZoom(20, { delta: { x: 0, y: 5 }, touch_phase: "started" }), { acc: 5, dir: null }, "started resets");
  assert.deepEqual(wheelZoom(30, { delta: { x: 0, y: -5 } }), { acc: -5, dir: null }, "sign change resets");
  assert.deepEqual(wheelZoom(0, { delta: { x: 0, y: 0 } }), { acc: 0, dir: null });
});
