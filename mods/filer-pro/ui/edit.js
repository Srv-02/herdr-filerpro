// Header buttons, prompt bar and status line of the edit mode in the source view. Builders only: the state and the
// actions live in main.js (a panel copy and the fullscreen dialog each have their own).
import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { BASE } from "../lib/icons.js";

// A text button in the style of the preview's Source/Preview button (the prompt bar). Dimmed: no click.
function button(t, id, label, { enabled = true } = {}, onClick = null) {
  return div().id(id).px(7).py(2).rounded(6).text_size(11).text_color(enabled ? t.muted : t.dim)
    .when(enabled, el => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)))
    .child(label);
}

// The Lucide glyphs of the edit toolbar (shipped beside main.js).
export const EDIT_GLYPHS = { edit: "pencil", undo: "undo-2", redo: "redo-2", cancel: "circle-x", save: "save", copy: "copy-plus" };

// One icon button of the edit toolbar: a 14px glyph in a fixed 24px hit area (as the Settings gear), so hover only
// changes the background. The tooltip names the button and, when dimmed, why; a dimmed button has no click.
function iconButton(t, id, glyph, tip, { enabled = true, active = false } = {}, onClick = null) {
  const color = enabled ? t.muted : t.dim;
  return div().id(id).w(24).h(24).flex_none().flex().items_center().justify_center().rounded(6)
    .when(active, el => el.bg(t.selected))
    .when(enabled, el => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)))
    .tooltip(tip).accessibility_label(tip)
    .child(svg(`${BASE}/${EDIT_GLYPHS[glyph]}.svg`).size(14).flex_none().text_color(color));
}

// The tooltip of a dimmed Edit: the name, then the reason ("Checking…" while the probe runs).
export const editRefusedTip = (reason) => `Edit: ${reason}`;

// model: { check: editCheck | null, edit: edit state | null }; handlers: { onToggle, onUndo, onRedo, onCancel, onSave, onCopy } (cx).
// One group of icon buttons (gap 2), so the header keeps room for its title in a narrow panel.
export function editTools(t, model, handlers) {
  const { check, edit } = model;
  const group = (...buttons) => [h_flex().id("files-edit-tools").flex_none().gap(2).items_center().children(buttons)];
  if (edit) {
    return group(
      iconButton(t, "files-edit", "edit", "Stop editing", { active: true }, handlers.onToggle),
      iconButton(t, "files-undo", "undo", "Undo", { enabled: edit.history.canUndo() }, handlers.onUndo),
      iconButton(t, "files-redo", "redo", "Redo", { enabled: edit.history.canRedo() }, handlers.onRedo),
      iconButton(t, "files-cancel", "cancel", "Cancel editing", {}, handlers.onCancel),
      iconButton(t, "files-save", "save", "Save", { enabled: edit.dirty && !edit.busy }, handlers.onSave),
      iconButton(t, "files-save-copy", "copy", "Save a Copy…", { enabled: !edit.busy }, handlers.onCopy),
    );
  }
  if (!check) return [];
  if (check.state === "ok") return group(iconButton(t, "files-edit", "edit", "Edit", {}, handlers.onToggle));
  return group(iconButton(t, "files-edit", "edit", editRefusedTip(check.state === "checking" ? "Checking…" : check.reason), { enabled: false }));
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
