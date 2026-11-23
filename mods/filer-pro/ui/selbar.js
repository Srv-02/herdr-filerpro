// The selection bar above the transfers bar: how many rows are selected, plus Clear (or Done in checkbox mode).
// `actions` is where the file actions of the selection go. Nothing to show with an empty selection outside the mode.
import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { BASE } from "../lib/icons.js";

export function selectionBar(t, { count, selecting }, { onDone, onClear, actions = [] }) {
  if (!selecting && count === 0) return null;
  const pill = (id, label, on) => h_flex().id(id).h(22).px(7).gap(4).items_center().rounded(6).flex_none().cursor_pointer().text_size(11)
    .accessibility_label(label).on_click((_e, cx) => on(cx));
  return h_flex().id("files-selection").h(40).flex_none().px(10).gap(4).items_center().border_t(1).border_color(t.border)
    .child(div().id("files-selection-count").text_size(12).font_medium().text_color(t.foreground).child(`${count} selected`))
    .child(div().flex_1())
    .children(actions)
    .child(selecting
      ? pill("files-selection-done", "Done", onDone).bg(t.selected).text_color(t.foreground)
        .child(svg(`${BASE}/check.svg`).size(12).flex_none()).child("Done")
      : pill("files-selection-clear", "Clear", onClear).text_color(t.muted).hover((s) => s.bg(t.hover)).child("Clear"));
}
