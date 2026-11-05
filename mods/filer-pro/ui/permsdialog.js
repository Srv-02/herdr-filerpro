// Permissions dialog (issue #23): the rwx matrix, an octal field kept in sync with it, owner and group (read only), the
// special bits (indicators only), and a confirmation step before anything is changed. The state is lib/permsstate.js;
// this file only creates the InputState (in init, never in render) and draws. Esc closes, like the name dialog.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { BASE } from "../lib/icons.js";
import { formatSymbolic, getBit, specialBits } from "../lib/perms.js";
import { createPermsState, setText, toggleBit, setRecursive, canApply, review } from "../lib/permsstate.js";

export const PERMS_SIZE = { width: 460, height: 540 };
const WHO = [["owner", "Owner"], ["group", "Group"], ["others", "Others"]];
const WHAT = [["r", "Read"], ["w", "Write"], ["x", "Execute"]];

// spec: { name, isDir } -> state (lib/permsstate.js) with input, handle, focused
export function createPermsDialog(spec, cx) {
  const state = createPermsState(spec);
  state.handle = cx.focus_handle();
  state.focused = false;
  state.input = InputState.new({ value: "" });
  state.input.on("change", (_e, cx) => { setText(state, state.input.value()); cx.notify(); });
  state.input.on("focus", (_e, cx) => { state.focused = true; cx.notify(); });
  state.input.on("blur", (_e, cx) => { state.focused = false; cx.notify(); });
  // The dialog holds the keyboard from the start, so Esc works before the octal field is clicked.
  state.handle.focus();
  cx.timer.after(600, () => state.handle.focus());
  return state;
}

// The probe arrived: show its mode in the field.
export function showProbe(state, loadedState) {
  state.input.set_value(loadedState.text);
  return state;
}

export function flip(state, who, what, cx) {
  toggleBit(state, who, what);
  state.input.set_value(state.text);
  cx.notify();
}

export function flipRecursive(state, cx) {
  setRecursive(state, !state.recursive);
  cx.notify();
}

const dimmed = (state) => state.readOnly !== null || state.busy;

function checkbox(t, id, on, locked, onClick) {
  return div().id(id).w(18).h(18).flex_none().rounded(4).border_1().flex().items_center().justify_center()
    .border_color(on ? t.accent : t.input).bg(on ? t.accent : t.background)
    .when(locked, (el) => el.opacity(0.45))
    .when(!locked, (el) => el.cursor_pointer().on_click((_e, cx) => onClick(cx)))
    .when(on, (el) => el.child(svg(`${BASE}/check.svg`).size(12).flex_none().text_color(t.accent_foreground)));
}

function button(t, id, text, primary, enabled, action) {
  return h_flex().id(id).h(32).px(14).items_center().rounded(8)
    .border_1().border_color(primary && enabled ? t.solid : t.input).bg(primary && enabled ? t.solid : t.raised)
    .text_color(primary && enabled ? t.solid_foreground : enabled ? t.foreground : t.dim).text_size(12.5).font_medium()
    .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => action(cx))).child(text);
}

const small = (t, text, color) => div().text_size(11.5).line_height("16px").text_color(color ?? t.muted).child(text);

function matrix(t, state) {
  const locked = dimmed(state);
  const head = h_flex().items_center().child(div().w(80).flex_none())
    .children(WHAT.map(([, label]) => div().flex_1().text_size(11.5).text_color(t.muted).child(label)));
  const rows = WHO.map(([who, label]) => h_flex().id(`filer-pro-perms-row-${who}`).h(30).items_center()
    .child(div().w(80).flex_none().text_size(13).child(label))
    .children(WHAT.map(([what]) => div().flex_1().child(checkbox(t, `filer-pro-perms-${who}-${what}`, getBit(state.mode, who, what), locked, (cx) => flip(state, who, what, cx))))));
  return v_flex().gap(0).child(head).children(rows);
}

function special(t, state) {
  const bits = specialBits(state.mode);
  const chip = (name, on) => div().id(`filer-pro-perms-${name}`).px(8).py(2).rounded(6).border_1().text_size(11.5)
    .border_color(on ? t.ansi3 : t.border).text_color(on ? t.ansi3 : t.dim).child(name);
  return h_flex().gap(6).items_center().child(div().w(80).flex_none().text_size(11.5).text_color(t.muted).child("Special"))
    .children(["setuid", "setgid", "sticky"].map((n) => chip(n, bits[n])));
}

function editView(t, state, handlers) {
  const ok = canApply(state);
  const note = state.readOnly ?? state.error ?? "";
  return v_flex().gap(10).flex_1()
    .child(v_flex().gap(2)
      .child(div().text_size(13).truncate().child(state.name))
      .child(small(t, `Owner ${state.owner}, group ${state.group} (read only)`)))
    .child(matrix(t, state))
    .child(h_flex().gap(8).items_center()
      .child(div().w(80).flex_none().text_size(13).child("Octal"))
      .child(Input.new(state.input).w(84).h(32).px(10).rounded(8).border_1()
        .border_color(state.textError ? t.ansi1 : state.focused ? t.accent : t.input).bg(t.background).text_size(12.8).text_color(t.foreground)
        .when(dimmed(state), (el) => el.opacity(0.45)))
      .child(div().text_size(12.5).text_color(t.muted).child(formatSymbolic(state.mode))))
    .child(special(t, state))
    .when(state.isDir, (el) => el.child(h_flex().id("filer-pro-perms-recursive-row").gap(8).items_center()
      .child(checkbox(t, "filer-pro-perms-recursive", state.recursive, dimmed(state), (cx) => flipRecursive(state, cx)))
      .child(div().text_size(13).child("Apply to enclosed items"))))
    .child(div().min_h(32).text_size(11.5).line_height("16px").text_color(state.readOnly ? t.ansi3 : t.ansi1).child(state.textError ?? note))
    .child(h_flex().gap(8).justify_end()
      .child(button(t, "filer-pro-perms-cancel", "Cancel", false, true, handlers.onCancel))
      .child(button(t, "filer-pro-perms-apply", "Apply", true, ok, handlers.onApply)));
}

function confirmView(t, state, handlers) {
  const r = review(state, state.count);
  return v_flex().gap(10).flex_1()
    .child(div().text_size(13).truncate().child(state.name))
    .child(h_flex().gap(10).items_center()
      .child(div().id("filer-pro-perms-change").text_size(20).font_semibold().child(r.change))
      .child(div().text_size(12.5).text_color(t.muted).child(`${formatSymbolic(state.original)} → ${formatSymbolic(state.mode)}`)))
    .when(state.recursive, (el) => el.child(small(t, "Including everything inside", t.foreground)))
    .child(v_flex().id("filer-pro-perms-warnings").gap(6).flex_1()
      .children(r.warnings.map((w) => h_flex().gap(6).items_start().child(div().text_size(12.5).text_color(t.ansi3).child("!")).child(div().flex_1().min_w(0).text_size(12.5).line_height("18px").child(w)))))
    .child(div().min_h(16).text_size(11.5).text_color(t.ansi1).child(state.error ?? ""))
    .child(h_flex().gap(8).justify_end()
      .child(button(t, "filer-pro-perms-back", "Back", false, !state.busy, handlers.onBack))
      .child(button(t, "filer-pro-perms-confirm", "Change", true, !state.busy, handlers.onConfirm)));
}

// handlers: { onCancel(), onApply(cx), onBack(cx), onConfirm(cx) }
export function permsView(t, state, handlers) {
  const body = state.phase === "loading" ? div().flex_1().text_size(13).text_color(t.muted).child("Reading permissions…")
    : state.phase === "error" ? v_flex().gap(10).flex_1().child(div().flex_1().text_size(13).text_color(t.ansi1).child(state.error))
      .child(h_flex().justify_end().child(button(t, "filer-pro-perms-cancel", "Close", false, true, handlers.onCancel)))
    : state.stage === "confirm" ? confirmView(t, state, handlers) : editView(t, state, handlers);
  return v_flex().id("filer-pro-permissions").track_focus(state.handle)
    .on_key_down((e, cx) => { if (e.key === "escape") { handlers.onCancel(); cx.stop_propagation(); } })
    .size_full().p(18).gap(10).bg(t.popover).text_color(t.foreground)
    .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child(state.stage === "confirm" ? "Change permissions?" : "Permissions"))
      .child(div().text_size(11).text_color(t.dim).child("Esc")))
    .child(body);
}
