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
