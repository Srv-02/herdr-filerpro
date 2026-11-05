// Permissions dialog (issue #23): the rwx matrix, an octal field kept in sync with it, owner and group (read only), the
// special bits (indicators only) and, for a folder, "Apply to enclosed items". Apply writes at once; what used to be a
// confirmation step is the notes area under the fields, updated live (lib/permsstate.js notes()).
// Every part has a fixed height, so the dialog keeps its exact size in every state: loading, editing, warnings, the
// recursive count, read only and errors. PERMS_SIZE is the sum of those heights; the notes area holds three lines and
// scrolls inside itself when there are more. The state is lib/permsstate.js; this file only creates the InputState
// (in init, never in render) and draws. Esc closes, like the name dialog.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { BASE } from "../lib/icons.js";
import { formatSymbolic, getBit, specialBits } from "../lib/perms.js";
import { createPermsState, setText, toggleBit, setRecursive, canApply, notes } from "../lib/permsstate.js";

const WHO = [["owner", "Owner"], ["group", "Group"], ["others", "Others"]];
const WHAT = [["r", "Read"], ["w", "Write"], ["x", "Execute"]];
const DIGIT = { r: 4, w: 2, x: 1 };

// The layout, top to bottom. The dialog height is computed from it, so a change here moves PERMS_SIZE with it.
export const LAYOUT = {
  pad: 18, gap: 12,
  head: 20 + 4 + 18 + 2 + 16, // title row, name, owner line
  matrix: 2 + 2 * 3 + 24 + 3 * 28, // border, padding, column heads, three rows
  octal: 28,
  notes: 2 * 7 + 3 * 18, // padding and three 18px lines
  footer: 32,
};
const sum = (l) => 2 * l.pad + 4 * l.gap + l.head + l.matrix + l.octal + l.notes + l.footer;
export const PERMS_SIZE = { width: 420, height: sum(LAYOUT) };

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

const locked = (state) => state.phase !== "ready" || state.readOnly !== null || state.busy;

// The drawn box of a checkbox (16px). The click and the accessible name sit on the element around it, which also holds
// the text label where there is one, so the label toggles too.
function box(t, on, dim) {
  return div().w(16).h(16).flex_none().rounded(4).border_1().flex().items_center().justify_center()
    .border_color(on ? t.accent : t.input).bg(on ? t.accent : t.background)
    .when(dim, (el) => el.opacity(0.45))
    .when(on, (el) => el.child(svg(`${BASE}/check.svg`).size(11).flex_none().text_color(t.accent_foreground)));
}

// A clickable checkbox target: role, accessible name with its state, hover, and the click (not when locked).
function toggle(el, t, { id, label, on, dim, onClick }) {
  return el.id(id).role("check_box").accessibility_label(`${label}, ${on ? "checked" : "not checked"}`)
    .when(!dim, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)));
}

function button(t, id, text, primary, enabled, action) {
  return h_flex().id(id).h(32).px(14).items_center().rounded(8)
    .border_1().border_color(primary && enabled ? t.solid : t.input).bg(primary && enabled ? t.solid : t.raised)
    .text_color(primary && enabled ? t.solid_foreground : enabled ? t.foreground : t.dim).text_size(12.5).font_medium()
    .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => action(cx))).child(text);
}

const COL = 62, DIG = 22;

// Owner / Group / Others by Read / Write / Execute in an inset card; each cell is the click target, the octal digit of
// the row at the right shows how the three digits come about.
function matrix(t, state) {
  const dim = locked(state);
  const head = h_flex().h(24).items_center()
    .child(div().flex_1())
    .children(WHAT.map(([, label]) => div().w(COL).flex_none().flex().justify_center().text_size(11).text_color(t.muted).child(label)))
    .child(div().w(DIG).flex_none());
  const rows = WHO.map(([who, label]) => {
    const digit = WHAT.reduce((n, [what]) => n + (getBit(state.mode, who, what) ? DIGIT[what] : 0), 0);
    return h_flex().id(`filer-pro-perms-row-${who}`).h(28).items_center().border_t(1).border_color(t.border)
      .child(div().flex_1().text_size(13).child(label))
      .children(WHAT.map(([what, whatLabel]) => {
        const on = getBit(state.mode, who, what);
        return toggle(h_flex().w(COL).h(24).flex_none().items_center().justify_center().rounded(6), t,
          { id: `filer-pro-perms-${who}-${what}`, label: `${label} ${whatLabel.toLowerCase()}`, on, dim, onClick: (cx) => flip(state, who, what, cx) })
          .child(box(t, on, dim));
      }))
      .child(div().w(DIG).flex_none().flex().justify_end().text_size(12.5).text_color(t.muted).child(state.phase === "ready" ? String(digit) : ""));
  });
  return v_flex().h(LAYOUT.matrix).flex_none().px(12).py(3).rounded(8).border_1().border_color(t.border).bg(t.background)
    .child(head).children(rows);
}

// Octal field, the ls style text, and the special bits as chips at the right (lit in t.ansi3 when set).
function octalRow(t, state) {
  const bits = specialBits(state.mode);
  const chip = (name) => div().id(`filer-pro-perms-${name}`).h(20).px(6).flex().items_center().rounded(5).border_1().text_size(11)
    .border_color(bits[name] ? t.ansi3 : t.border).text_color(bits[name] ? t.ansi3 : t.dim).child(name);
  return h_flex().h(LAYOUT.octal).flex_none().gap(8).items_center()
    .child(div().text_size(12.5).text_color(t.muted).child("Octal"))
    .child(Input.new(state.input).w(64).h(28).px(8).rounded(6).border_1()
      .border_color(state.textError ? t.ansi1 : state.focused ? t.accent : t.input).bg(t.background).text_size(13).text_color(t.foreground)
      .when(locked(state), (el) => el.opacity(0.45)))
    .child(div().flex_1().min_w(0).text_size(12.5).text_color(t.muted).child(state.phase === "ready" ? formatSymbolic(state.mode) : ""))
    .child(h_flex().gap(4).items_center().child(chip("setuid")).child(chip("setgid")).child(chip("sticky")));
}

const MARK = {
  error: (t) => ["shield-exclamation-point.svg", t.ansi1, t.ansi1],
  warning: (t) => ["shield-exclamation-point.svg", t.ansi3, t.foreground],
  note: (t) => ["info.svg", t.ansi3, t.foreground],
  info: (t) => ["info.svg", t.dim, t.muted],
  ok: (t) => ["check.svg", t.muted, t.muted],
};

// The notes: fixed height, three lines visible, scrolls inside when there are more.
function notesArea(t, state) {
  const lines = notes(state).map(({ level, text }) => {
    const [icon, mark, color] = MARK[level](t);
    return h_flex().gap(7).items_start()
      .child(div().h(18).flex_none().flex().items_center().child(svg(`${BASE}/${icon}`).size(12).flex_none().text_color(mark)))
      .child(div().flex_1().min_w(0).text_size(12).line_height("18px").text_color(color).child(text));
  });
  return v_flex().id("filer-pro-perms-notes").h(LAYOUT.notes).flex_none().px(10).py(7).rounded(8).bg(t.hover).overflow_y_scroll()
    .children(lines);
}

// handlers: { onCancel(), onApply(cx), onRecursive(cx) }
export function permsView(t, state, handlers) {
  const dim = locked(state);
  const ok = canApply(state);
  const owner = state.phase === "ready" ? `Owner ${state.owner} · Group ${state.group}` : "";
  const recursive = toggle(h_flex().h(28).px(6).ml(-6).gap(8).items_center().rounded(6), t,
    { id: "filer-pro-perms-recursive", label: "Apply to enclosed items", on: state.recursive, dim, onClick: (cx) => handlers.onRecursive(cx) })
    .child(box(t, state.recursive, dim))
    .child(div().text_size(12.5).text_color(dim ? t.dim : t.foreground).child("Apply to enclosed items"));
  return v_flex().id("filer-pro-permissions").track_focus(state.handle)
    .on_key_down((e, cx) => { if (e.key === "escape") { handlers.onCancel(); cx.stop_propagation(); } })
    .size_full().p(LAYOUT.pad).gap(LAYOUT.gap).bg(t.popover).text_color(t.foreground)
    .child(v_flex().h(LAYOUT.head).flex_none()
      .child(h_flex().h(20).items_center().child(div().flex_1().text_size(15).font_semibold().child("Permissions"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().mt(4).h(18).text_size(13).truncate().child(state.name))
      .child(div().mt(2).h(16).text_size(11.5).text_color(t.muted).truncate().child(owner)))
    .child(matrix(t, state))
    .child(octalRow(t, state))
    .child(notesArea(t, state))
    .child(h_flex().h(LAYOUT.footer).flex_none().gap(8).items_center()
      .child(div().flex_1().min_w(0).child(state.isDir ? recursive : div()))
      .child(button(t, "filer-pro-perms-cancel", state.phase === "error" ? "Close" : "Cancel", false, true, handlers.onCancel))
      .child(button(t, "filer-pro-perms-apply", "Apply", true, ok, handlers.onApply)));
}
