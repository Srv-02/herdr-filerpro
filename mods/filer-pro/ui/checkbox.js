// The drawn box of a checkbox, shared by the dialogs and the tree rows. The click and the accessible name sit on the
// element around it, which also holds the text label where there is one, so the label toggles too.
import { div, svg } from "gpui-kit";
import { BASE } from "../lib/icons.js";

// size 16 (default) or 14; the check glyph is 11 px in the large box and 10 px in the small one.
export function checkBox(t, on, { size = 16, dim = false } = {}) {
  return div().w(size).h(size).flex_none().rounded(4).border_1().flex().items_center().justify_center()
    .border_color(on ? t.accent : t.input).bg(on ? t.accent : t.background)
    .when(dim, (el) => el.opacity(0.45))
    .when(on, (el) => el.child(svg(`${BASE}/check.svg`).size(size === 14 ? 10 : 11).flex_none().text_color(t.accent_foreground)));
}
