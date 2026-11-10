// The question dialog: a link warning (Transfer anyway / Cancel, or only OK for a symlink loop), a target
// conflict (also for a move: no Merge), the Another volume question of a move ("copy_instead" and "cancel"),
// or the confirmation before a delete (choices "delete" and "cancel").
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { conflictText, crossTitle, crossText, THIS_COMPUTER, CROSS_DONT_SHOW } from "../lib/conflicttext.js";
import { BASE } from "../lib/icons.js";

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

// The warning before a copy between two machines (approved design, #60): title, amount and route as text, the route as
// a strip of chips, and in the footer "Don't show again" (left; sent as apply_to_all, it counts only with Copy) and the
// buttons Cancel (outline) and Copy (accent). The machines are named by their herdr names.
function crossView(t, pending, state, handlers) {
  const item = pending.item ?? {};
  const chip = (name) => div().px(6).py(2).rounded(4).bg(t.hover).text_color(t.foreground).truncate().child(name ?? "");
  const on = state?.all === true;
  const box = div().w(14).h(14).flex_none().rounded(4).border_1().flex().items_center().justify_center()
    .border_color(on ? t.accent : t.input).bg(on ? t.accent : t.background)
    .when(on, (el) => el.child(svg(`${BASE}/check.svg`).size(10).flex_none().text_color(t.accent_foreground)));
  const action = (choice) => div().id(`filer-pro-choice-${choice}`).h(30).px(14).flex().items_center().rounded(6).cursor_pointer()
    .when(choice === "copy", (el) => el.bg(t.accent).text_color(t.accent_foreground).font_medium())
    .when(choice !== "copy", (el) => el.border_1().border_color(t.border))
    .hover((s) => s.opacity(0.88)).on_click((_e, cx) => handlers.onChoose(choice, cx)).child(label(choice, item));
  return v_flex().id("filer-pro-conflict").size_full().p(20).gap(14).bg(t.background).text_color(t.foreground).text_size(13)
    .child(div().text_size(15).font_medium().truncate().child(crossTitle(item)))
    .child(div().line_height("19.5px").text_color(t.muted).child(crossText(item)))
    .child(h_flex().id("filer-pro-cross-route").gap(8).px(10).py(8).items_center().rounded(6).bg(t.chrome).text_size(12).text_color(t.muted)
      .child(chip(item.from)).child("→").child(div().flex_none().child(THIS_COMPUTER)).child("→").child(chip(item.machine)))
    .child(div().flex_1().min_h(0))
    .child(h_flex().gap(8).items_center()
      .child(h_flex().id("filer-pro-cross-dont-show").role("check_box").accessibility_label(`${CROSS_DONT_SHOW}, ${on ? "checked" : "not checked"}`)
        .flex_1().gap(7).items_center().cursor_pointer().text_size(12).text_color(t.muted)
        .on_click((_e, cx) => handlers.onToggleAll(cx)).child(box).child(CROSS_DONT_SHOW))
      .children(["cancel", "copy"].filter((c) => (pending.choices ?? []).includes(c)).map(action)));
}

// pending: { batch, item, choices, remaining }; state: { all }; handlers: { onChoose(choice, cx), onToggleAll(cx) }
export function conflictView(t, pending, state, handlers) {
  if (pending.choices?.includes("delete")) return deleteView(t, pending, handlers);
  if (pending.choices?.includes("copy_instead")) return volumeView(t, pending, handlers);
  if (pending.choices?.includes("copy")) return crossView(t, pending, state, handlers);
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
