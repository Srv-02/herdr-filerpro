// The zoom actions of the PDF view in the fullscreen dialog and the key bindings that dispatch them. Pure, no Herdr
// imports: main.js binds ZOOM_KEYS once per app session, the preview module declares PDF_CONTEXT and handles ACTIONS.
export const ACTIONS = { in: "filer_pro_zoom_in", out: "filer_pro_zoom_out", fit: "filer_pro_zoom_fit" };
export const PDF_CONTEXT = "FilerProPdf";

// Each is bound on its own (one bad spelling must not drop the rest). The plain keys are the guaranteed path: whether a
// global cmd-+ binding of the app wins over the context binding cannot be measured without real keystrokes.
export const ZOOM_KEYS = [
  { keystroke: "cmd-+", action: ACTIONS.in }, { keystroke: "cmd-=", action: ACTIONS.in },
  { keystroke: "cmd--", action: ACTIONS.out }, { keystroke: "cmd-0", action: ACTIONS.fit },
  { keystroke: "+", action: ACTIONS.in }, { keystroke: "=", action: ACTIONS.in },
  { keystroke: "-", action: ACTIONS.out }, { keystroke: "0", action: ACTIONS.fit },
].map((b) => ({ ...b, context: PDF_CONTEXT }));

// Binds ZOOM_KEYS once per app session (the first dialog does it, a later one finds the shared flag). Every binding is
// tried on its own; returns the number bound, or -1 when this session already did it.
export function bindZoomKeys(cx, getShared, setShared, now) {
  if (getShared("filer-pro.zoomkeys")) return -1;
  let bound = 0;
  for (const b of ZOOM_KEYS) { try { cx.bind_keys([b]); bound++; } catch {} }
  setShared("filer-pro.zoomkeys", { at: now(), bound });
  return bound;
}
