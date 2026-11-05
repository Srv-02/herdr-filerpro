// Header buttons, prompt bar and status line of the edit mode in the source view. Builders only: the state and the
// actions live in main.js (a panel copy and the fullscreen dialog each have their own).
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";

// One header button in the style of the preview's Source/Preview button. Dimmed: no click, the tooltip says why.
function button(t, id, label, { enabled = true, active = false, tip = null } = {}, onClick = null) {
  return div().id(id).px(7).py(2).rounded(6).text_size(11).text_color(enabled ? t.muted : t.dim)
    .when(active, el => el.bg(t.selected))
    .when(enabled, el => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)))
    .when(Boolean(tip), el => el.tooltip(tip))
    .child(label);
}

// model: { check: editCheck | null, edit: edit state | null }; handlers: { onToggle, onUndo, onRedo, onCancel, onSave, onCopy } (cx).
export function editTools(t, model, handlers) {
  const { check, edit } = model;
  if (edit) {
    return [
      button(t, "files-edit", "Edit", { active: true, tip: "Stop editing" }, handlers.onToggle),
      button(t, "files-undo", "Undo", { enabled: edit.history.canUndo() }, handlers.onUndo),
      button(t, "files-redo", "Redo", { enabled: edit.history.canRedo() }, handlers.onRedo),
      button(t, "files-cancel", "Cancel", {}, handlers.onCancel),
      button(t, "files-save", "Save", { enabled: edit.dirty && !edit.busy }, handlers.onSave),
      button(t, "files-save-copy", "Save a Copy…", { enabled: !edit.busy }, handlers.onCopy),
    ];
  }
  if (!check) return [];
  if (check.state === "ok") return [button(t, "files-edit", "Edit", {}, handlers.onToggle)];
  return [button(t, "files-edit", "Edit", { enabled: false, tip: check.state === "checking" ? "Checking…" : check.reason })];
}

// The question above the editor. prompt: { kind: "leave" | "discard" }; handlers: { onSave, onDiscard, onCancel } (cx).
export function promptBar(t, prompt, name, handlers) {
  const leave = prompt.kind === "leave";
  return h_flex().id("files-prompt").flex_none().px(14).py(6).gap(8).items_center().border_b(1).border_color(t.border).bg(t.raised).text_size(12)
    .child(div().flex_1().min_w(0).truncate().child(leave ? `Save changes to ${name}?` : `Discard the changes to ${name}?`))
    .when(leave, el => el.child(button(t, "files-prompt-save", "Save", {}, handlers.onSave)))
    .child(button(t, "files-prompt-discard", "Discard", {}, handlers.onDiscard))
    .child(button(t, "files-prompt-cancel", leave ? "Cancel" : "Keep editing", {}, handlers.onCancel));
}

// One line below the editor: the status text, then a message ({ text, error }) when there is one.
export function statusBar(t, text, message) {
  return h_flex().id("files-status").h(22).flex_none().px(14).gap(10).items_center().border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
    .child(div().flex_none().child(text))
    .when(Boolean(message), el => el.child(div().flex_1().min_w(0).truncate().text_color(message.error ? t.ansi1 : t.dim).child(message.text)));
}
