// Pure zoom, spread and paging maths of the PDF view (no gpui, no Herdr imports). Sizes are "points": the base page
// render is PNG px / 2, and that stays the unit of 100 %.

export const ZOOM_STEPS = [50, 75, 100, 125, 150, 200, 300]; // percent; "page" and "width" are the fit presets
export const ZOOM_MIN = 50, ZOOM_MAX = 300;
export const MAX_EDGE = 6144;                                // longest raster edge in px, hard cap
export const RENDER_TIERS = [3072, 4096, 6144];              // sharper renders; the base render is the 2048 one
export const SPREAD_GAP = 8;                                 // px between the two pages of a spread
export const VIEW_PAD = 16;                                  // horizontal padding of the preview
export const VIEW_PAD_Y = 10;                                // vertical padding of the preview (py(10))

// Spreads: the cover alone, then 2-3, 4-5 ...; an odd last page may stand alone.
export const spreadStart = (page) => (page <= 1 ? 1 : page % 2 === 0 ? page : page - 1);
export function spreadPages(page, pages) {
  const s = spreadStart(page);
  return s === 1 ? [1] : s + 1 <= pages ? [s, s + 1] : [s];
}

export function pageLabel(page, pages, spread) {
  const list = spread ? spreadPages(page, pages) : [page];
  return `${list.length > 1 ? `${list[0]}–${list[1]}` : list[0]} / ${pages}`; // en dash
}

// { prev, next }: the page to go to, 0 = none (the button is dimmed).
export function turnTargets(page, pages, spread) {
  if (!spread) return { prev: page > 1 ? page - 1 : 0, next: page < pages ? page + 1 : 0 };
  const s = spreadStart(page);
  return { prev: s === 1 ? 0 : s === 2 ? 1 : s - 2, next: s === 1 ? (pages >= 2 ? 2 : 0) : (s + 2 <= pages ? s + 2 : 0) };
}

// sizes: [{ width, height }] in points (one or two pages), width/height: the last reported view size (0 = unknown).
// zoom: a percent, "width" (fill the view width) or "page" (the whole page or spread inside the view, nothing to scroll).
// All pages get the common height. Both fit modes floor widths and heights (so the row never overflows into a stray
// scrollbar) and stop at ZOOM_MAX, which keeps the 6144 px render cap meaningful; an unknown width is factor 1, an unknown
// height makes "page" behave like "width".
export function layout(sizes, zoom, width, height = 0) {
  const H = Math.max(...sizes.map((s) => s.height)), natural = sizes.map((s) => s.width * H / s.height);
  const N = natural.reduce((a, b) => a + b, 0), gaps = SPREAD_GAP * (sizes.length - 1);
  const fit = zoom === "page" || zoom === "width", roomW = Math.max(80, width - 2 * VIEW_PAD) - gaps;
  let f = fit ? 1 : zoom / 100;
  if (fit && width > 0) {
    f = Math.min(roomW / N, ZOOM_MAX / 100);
    if (zoom === "page" && height > 0) f = Math.min(f, Math.max(80, height - 2 * VIEW_PAD_Y) / H);
  }
  const round = fit ? Math.floor : Math.round;
  const items = natural.map((n) => ({ w: round(n * f), h: round(H * f) }));
  return { percent: Math.round(f * 100), items, width: items.reduce((a, i) => a + i.w, 0) + gaps, height: items[0].h };
}

// dir: "in" | "out", stepped from the effective `percent` (a preset has none of its own). Unchanged = same zoom back.
export function zoomStep(zoom, percent, dir) {
  if (dir === "in") {
    const next = ZOOM_STEPS.find((s) => s > percent);
    return next ?? (percent < ZOOM_MAX ? ZOOM_MAX : zoom);
  }
  const prev = [...ZOOM_STEPS].reverse().find((s) => s < percent);
  return prev ?? zoom;
}

// The preset button to highlight: "page", "width", "actual" (exactly 100 %) or null (stepped away from all of them).
export const presetOf = (zoom) => (zoom === "page" || zoom === "width" ? zoom : zoom === 100 ? "actual" : null);

export const canZoom = (percent) => ({ in: percent < ZOOM_MAX, out: percent > ZOOM_MIN });

// The sharper render a drawn item needs: item {w,h} in logical px, size = base page {width,height} in points.
// 2x display; null when the base render (longest edge up to 2048) already has that many pixels.
export function renderSize(item, size) {
  const need = 2 * Math.max(item.w, item.h), base = 2 * Math.max(size.width, size.height);
  if (need <= base) return null;
  return RENDER_TIERS.find((t) => t >= need) ?? MAX_EDGE;
}

// cmd + wheel: one step per line, or per 40 px accumulated. Positive y (scroll up/away) zooms in.
export function wheelZoom(acc, event) {
  const phase = event.touch_phase;
  if (phase === "ended" || phase === "cancelled") return { acc: 0, dir: null };
  if (event.delta_lines?.y) return { acc: 0, dir: event.delta_lines.y > 0 ? "in" : "out" };
  const dy = event.delta?.y ?? 0;
  const base = phase === "started" || Math.sign(dy) * Math.sign(acc) < 0 ? 0 : acc, next = base + dy;
  return Math.abs(next) >= 40 ? { acc: 0, dir: next > 0 ? "in" : "out" } : { acc: next, dir: null };
}
