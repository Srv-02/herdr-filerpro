// Name dialog (Rename, New Folder): an InputState created in init (never in render), Enter submits, Esc closes the dialog
// (handled here like the prompt mod does: the field has the focus, so the key arrives on this block).
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { validateName } from "../lib/fileops.js";

// spec: { title, button, id, value, selectEnd, check(value) -> error | null } -> state { input, handle, value, error, focused, busy }
// handlers: { onSubmit(name, cx) } is called only for a name that passes spec.check.
export function createNameDialog(spec, handlers, cx) {
  const { value: name } = spec;
  const state = { spec, value: name, error: null, focused: true, busy: false, handle: cx.focus_handle() };
  state.input = InputState.new({ value: name });
  state.input.set_selected_range({ start: 0, end: spec.selectEnd });
  // A change replaces any message: the typed value is checked again, an answer from the file system is gone.
  // A name that only fails spec.check (unchanged for Rename) shows no message, the button is just off.
  state.input.on("change", (_e, cx) => { state.value = state.input.value(); state.error = validateName(state.value); cx.notify(); });
  state.input.on("submit", (_e, cx) => state.submit(cx));
  state.input.on("focus", (_e, cx) => { state.focused = true; cx.notify(); });
  state.input.on("blur", (_e, cx) => { state.focused = false; cx.notify(); });
  state.submit = (cx) => {
    if (state.busy || spec.check(state.value) !== null) return;
    handlers.onSubmit(state.value, cx);
  };
  state.input.focus();
  cx.timer.after(600, () => state.input.focus());
  return state;
}

// state: from createNameDialog; handlers: { onCancel(), onSubmit() }
export function nameView(t, state, handlers) {
  const { spec } = state;
  const ok = state.error === null && spec.check(state.value) === null && !state.busy;
  const button = (id, text, primary, enabled, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
    .border_1().border_color(primary && enabled ? t.solid : t.input).bg(primary && enabled ? t.solid : t.raised)
    .text_color(primary && enabled ? t.solid_foreground : enabled ? t.foreground : t.dim).text_size(12.5).font_medium()
    .when(enabled, el => el.cursor_pointer().hover(s => s.opacity(0.88)).on_click((_e, cx) => action(cx))).child(text);
  return v_flex().id(`filer-pro-${spec.id}`).track_focus(state.handle)
    .on_key_down((e, cx) => { if (e.key === "escape") { handlers.onCancel(cx); cx.stop_propagation(); } })
    .size_full().p(18).gap(10).bg(t.popover).text_color(t.foreground)
    .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child(spec.title))
      .child(div().id(`filer-pro-${spec.id}-esc`).text_size(11).text_color(t.dim)
        .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip("Close").accessibility_label("Close").on_click((_e, cx) => handlers.onCancel(cx)).child("Esc")))
    .child(Input.new(state.input).h(32).px(10).rounded(8).border_1().border_color(state.focused ? t.accent : t.input).bg(t.background).text_size(12.8).text_color(t.foreground))
    .child(div().h(16).text_size(11).text_color(t.ansi1).truncate().child(state.error ?? ""))
    .child(h_flex().gap(8).justify_end()
      .child(button(`filer-pro-${spec.id}-cancel`, "Cancel", false, true, handlers.onCancel))
      .child(button(`filer-pro-${spec.id}-ok`, spec.button, true, ok, (cx) => state.submit(cx))));
}
