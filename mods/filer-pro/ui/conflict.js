// The question dialog: a link warning (Transfer anyway / Cancel, or only OK for a symlink loop), a target
// conflict (also for a move: no Merge), the Another volume question of a move ("copy_instead" and "cancel"),
// or the confirmation before a delete (choices "delete" and "cancel").
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { conflictText, crossText, CROSS_NOTE } from "../lib/conflicttext.js";

const LABEL = { replace: "Replace", merge: "Merge", keep_both: "Keep both", copy_instead: "Copy instead", copy: "Copy", cancel: "Cancel", transfer_anyway: "Transfer anyway", ok: "OK" };

// The delete button says what happens: a move to the Trash here, or a final Delete (red) on a machine.
function label(choice, item) {
  if (choice === "delete") return item?.trash ? "Move to Trash" : "Delete";
  return LABEL[choice] ?? choice;
}

function button(choice, t, onChoose, item) {
  const final = choice === "delete" && !item?.trash;
  return div().id(`filer-pro-choice-${choice}`).h(30).px(14).flex().items_center().rounded(6).cursor_pointer().border_1().border_color(t.border)
    .when(final, el => el.text_color(t.ansi1))
    .hover(s => s.bg(t.hover)).on_click((_e, cx) => onChoose(choice, cx)).child(label(choice, item));
}

// The delete question: name, kind and place; the final delete on a machine says so.
function deleteView(t, pending, handlers) {
  const item = pending.item ?? {};
  const kind = item.isDir ? "folder" : "file";
  const text = item.trash ? `Move "${item.name}" to the Trash?` : `Delete "${item.name}" on ${item.machine}? This cannot be undone.`;
  return v_flex().id("filer-pro-conflict").size_full().p(16).gap(12).bg(t.background).text_color(t.foreground).text_size(13)
    .child(div().font_semibold().child(`Delete ${kind}?`))
    .child(v_flex().flex_1().min_h(0).gap(6)
      .child(div().text_color(t.muted).child(text))
      .child(div().text_size(11).text_color(t.dim).truncate().child(item.path ?? "")))
    .child(h_flex().gap(8).justify_end().children((pending.choices ?? []).map(c => button(c, t, handlers.onChoose, item))));
}

// The move that cannot happen: another volume. Copy instead leaves the original where it is.
function volumeView(t, pending, handlers) {
  const item = pending.item ?? {};
  return v_flex().id("filer-pro-conflict").size_full().p(16).gap(12).bg(t.background).text_color(t.foreground).text_size(13)
    .child(div().font_semibold().child("Another volume"))
    .child(v_flex().flex_1().min_h(0).gap(6)
      .child(div().text_color(t.muted).child(`"${item.name}" cannot be moved to another volume. Copy it instead? The original stays where it is.`))
      .child(div().text_size(11).text_color(t.dim).truncate().child(item.path ?? "")))
    .child(h_flex().gap(8).justify_end().children((pending.choices ?? []).map(c => button(c, t, handlers.onChoose, item))));
}

// The warning before a copy between two machines: it goes through this Mac. Copy or Cancel.
function crossView(t, pending, handlers) {
  const item = pending.item ?? {};
  return v_flex().id("filer-pro-conflict").size_full().p(16).gap(12).bg(t.background).text_color(t.foreground).text_size(13)
    .child(div().font_semibold().child("Copy between machines"))
    .child(v_flex().flex_1().min_h(0).gap(6)
      .child(div().text_color(t.muted).child(crossText(item)))
      .child(div().text_size(11).text_color(t.dim).truncate().child(item.path ?? ""))
      .child(div().text_size(11).text_color(t.dim).child(CROSS_NOTE)))
    .child(h_flex().gap(8).justify_end().children((pending.choices ?? []).map(c => button(c, t, handlers.onChoose, item))));
}

// pending: { batch, item, choices, remaining }; state: { all }; handlers: { onChoose(choice, cx), onToggleAll(cx) }
export function conflictView(t, pending, state, handlers) {
  if (pending.choices?.includes("delete")) return deleteView(t, pending, handlers);
  if (pending.choices?.includes("copy_instead")) return volumeView(t, pending, handlers);
  if (pending.choices?.includes("copy")) return crossView(t, pending, handlers);
  const item = pending.item ?? {};
  const isLinks = Boolean(pending.choices?.includes("transfer_anyway") || pending.choices?.includes("ok"));
  const text = isLinks ? item.linkWarning : conflictText(item);
  return v_flex().id("filer-pro-conflict").size_full().p(16).gap(12).bg(t.background).text_color(t.foreground).text_size(13)
    .child(div().font_semibold().child(isLinks ? item.linkTitle ?? "Symlink found!" : "Already exists"))
    .child(div().flex_1().min_h(0).text_color(t.muted).child(text ?? ""))
    .when(pending.remaining > 1, el => el.child(div().id("filer-pro-apply-all").cursor_pointer().on_click((_e, cx) => handlers.onToggleAll(cx))
      .child(`${state.all ? "☑" : "☐"} Apply to all (${pending.remaining})`)))
    .child(h_flex().gap(8).justify_end().children((pending.choices ?? []).map(c => button(c, t, handlers.onChoose, item))));
}
