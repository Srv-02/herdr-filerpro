// Right-click popup over a file or folder row, or over the free area below the tree (entries from mods/filer-pro/lib/menuitems.js).
import { div } from "gpui-kit";
import { v_flex } from "gpui-base";

// detail: a short text at the right of the entry (text 11, muted), e.g. the result of Calculate Size. Every label is cut with
// an ellipsis at the popup width (a long editor name in "Open in <editor>").
const withDetail = (el, id, label, detail, t) => (detail ? el.justify_between().gap(8).child(div().min_w(0).truncate().child(label))
  .child(div().id(`${id}-detail`).flex_none().text_size(11).text_color(t.muted).child(detail)) : el.child(div().min_w(0).truncate().child(label)));

const tip = (el, title) => (title ? el.tooltip(title) : el);

function item(id, label, t, onClick, detail, title) {
  return withDetail(tip(div().id(id).h(28).px(10).flex().items_center().rounded(6).cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)), title), id, label, detail, t);
}

// An entry that cannot be used right now: dim, no hover, no click.
function disabled(id, label, t, detail, title) {
  return withDetail(tip(div().id(id).h(28).px(10).flex().items_center().rounded(6).text_color(t.dim), title), id, label, detail, t);
}

const separator = (t) => div().h(1).my(3).bg(t.border);

// items: the entries from mods/filer-pro/lib/menuitems.js; handlers: { [action]: (cx) => void }
export function menuView(t, items, handlers) {
  return v_flex().id("filer-pro-menu").p(4).bg(t.background).text_color(t.foreground).text_size(13)
    .children(items.map((i) => (i.separator ? separator(t) : i.enabled ? item(i.id, i.label, t, handlers[i.action], i.detail, i.title) : disabled(i.id, i.label, t, i.detail, i.title))));
}
