// Right-click popup over a file or folder row, or over the free area below the tree (entries from mods/filer-pro/lib/menuitems.js).
import { div } from "gpui-kit";
import { v_flex } from "gpui-base";

function item(id, label, t, onClick) {
  return div().id(id).h(28).px(10).flex().items_center().rounded(6).cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)).child(label);
}

// An entry that cannot be used right now: dim, no hover, no click.
function disabled(id, label, t) {
  return div().id(id).h(28).px(10).flex().items_center().rounded(6).text_color(t.dim).child(label);
}

const separator = (t) => div().h(1).my(3).bg(t.border);

// items: the entries from mods/filer-pro/lib/menuitems.js; handlers: { [action]: (cx) => void }
export function menuView(t, items, handlers) {
  return v_flex().id("filer-pro-menu").p(4).bg(t.background).text_color(t.foreground).text_size(13)
    .children(items.map((i) => (i.separator ? separator(t) : i.enabled ? item(i.id, i.label, t, handlers[i.action]) : disabled(i.id, i.label, t))));
}
