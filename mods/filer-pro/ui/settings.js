// Settings dialog (overlay view "settings"): every setting of lib/settings.js plus the editors, checked field by field
// and written back with saveSettings (read-modify-write, only the changed keys). Every InputState is created here, in
// the overlay's init (never in render), from the snapshot the opener put into shared("filer-pro.settings").
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { SETTINGS, validateField, editorSlots, changedEdits, saveSettings } from "../lib/settings.js";
import { TERMINAL_EDITORS, GUI_EDITORS } from "../lib/editors.js";

export const SECTIONS = ["General", "Editors", "File list", "Preview", "Transfers", "Security"];
export const SVG_WARNING = "Security boundary: a crafted SVG can load external content or inject code, and can set its own size in CSS past the 100-megapixel limit. Turning this check off is at your own risk.";
export const BROKEN = "filer-pro.json is not a valid JSON object; fix or remove it first";
const EXTRA_SLOTS = 2;

const str = (v) => (typeof v === "string" ? v : "");

// A text field: its InputState and the typed value (kept from the change event, as ui/namedialog.js does).
function field(value, onChange) {
  const f = { value, error: null, input: InputState.new({ value }) };
  f.input.on("change", (_e, cx) => { f.value = f.input.value(); f.error = null; onChange?.(); cx.notify(); });
  return f;
}

// snapshot: { config (loadConfig), raw (the parsed file or null), broken } -> the dialog state.
export function createSettingsDialog(snapshot, cx) {
  const config = snapshot?.config ?? {}, raw = snapshot?.raw && typeof snapshot.raw === "object" && !Array.isArray(snapshot.raw) ? snapshot.raw : {};
  const state = { fields: {}, flags: {}, initial: {}, error: snapshot?.broken ? BROKEN : null, broken: Boolean(snapshot?.broken), busy: false, handle: cx.focus_handle() };
  const clear = () => { if (!state.broken) state.error = null; };
  for (const s of SETTINGS) {
    if (s.kind === "bool") { state.flags[s.key] = config[s.key] ?? s.default; state.initial[s.key] = state.flags[s.key]; continue; }
    // The download folder as written in the file (~/ stays ~/), everything else as loadConfig read it.
    const shown = s.key === "download_folder" ? (str(raw.download_folder).trim() || s.default) : String(config[s.key] ?? s.default);
    state.fields[s.key] = field(shown, clear);
    state.initial[s.key] = validateField(s.key, shown).value ?? shown;
  }
  // Own editors: the entries as written in the file (a broken one shows with its reason instead of vanishing), plus empty slots.
  const editors = (kind, listKey, choiceKey, names) => {
    const list = Array.isArray(raw[listKey]) ? raw[listKey] : [];
    const slot = (e) => Object.fromEntries(names.map((n) => [n, field(str(e?.[n]), clear)]));
    const slots = [...list.map(slot), ...Array.from({ length: EXTRA_SLOTS }, () => slot(null))];
    state.initial[listKey] = list; state.initial[choiceKey] = config[choiceKey];
    const ed = { kind, listKey, choiceKey, names, slots, errors: [], choice: config[choiceKey], choiceError: null };
    ed.opened = JSON.stringify(slotValues(ed)); // the slots as shown: untouched, the list is neither checked nor written
    return ed;
  };
  state.terminal = editors("terminal", "terminal_editors", "terminal_editor", ["name", "command"]);
  state.gui = editors("gui", "gui_editors", "gui_editor", ["name", "local", "remote"]);
  state.fields.download_folder.input.focus();
  cx.timer.after(600, () => state.fields.download_folder.input.focus());
  return state;
}

const slotValues = (ed) => ed.slots.map((s) => Object.fromEntries(ed.names.map((n) => [n, s[n].value])));

// The names to pick from: shipped ones and the own slots with a name (an own one replaces a shipped one of that name).
export function editorChoices(ed) {
  const shipped = (ed.kind === "terminal" ? TERMINAL_EDITORS : GUI_EDITORS).map((e) => e.name);
  const own = slotValues(ed).map((s) => s.name.trim()).filter(Boolean);
  return [...new Set([...shipped, ...own])];
}

// Checks every field, marks the errors on the state, and returns the changed keys, or null when anything is wrong.
export function collect(state) {
  let bad = false;
  const current = { ...state.flags };
  for (const [key, f] of Object.entries(state.fields)) {
    const r = validateField(key, f.value);
    f.error = r.error ?? null;
    if (r.error) bad = true; else current[key] = r.value;
  }
  for (const ed of [state.terminal, state.gui]) {
    // Untouched slots and choice: nothing to write, and an entry the file holds by hand (a duplicate name, a broken
    // remote that loadConfig drops alone) does not block saving the other settings.
    if (ed.choice === state.initial[ed.choiceKey] && JSON.stringify(slotValues(ed)) === ed.opened) { ed.errors = []; ed.choiceError = null; continue; }
    const r = editorSlots(ed.kind, slotValues(ed), ed.choice);
    ed.errors = r.errors; ed.choiceError = r.choiceError;
    if (!r.value) { bad = true; continue; }
    current[ed.listKey] = r.value.list; current[ed.choiceKey] = r.value.choice;
  }
  return bad ? null : changedEdits(state.initial, current);
}

// Save: nothing is written while a field is wrong or the file is broken. io: { readTextFile, writeTextFile, path }.
// -> true when saved (the caller closes the dialog and announces the change).
export async function submitSettings(state, io, cx) {
  if (state.busy || state.broken) return false;
  const edits = collect(state);
  if (!edits) { state.error = "Fix the marked fields"; cx?.notify(); return false; }
  state.busy = true; state.error = null; cx?.notify();
  const out = await saveSettings(edits, io);
  state.busy = false;
  if (!out.ok) { state.error = out.error; cx?.notify(); return false; }
  return true;
}

// --- view ---

const label = (t, text) => div().text_size(12).text_color(t.foreground).child(text);
const hint = (t, text) => div().text_size(11).text_color(t.dim).child(text);
const errorLine = (t, text) => div().text_size(11).text_color(t.ansi1).child(text ?? "");
const input = (t, f) => Input.new(f.input).h(28).px(8).rounded(6).border_1().border_color(f.error ? t.ansi1 : t.input).bg(t.background).text_size(12.5).text_color(t.foreground);

function textRow(t, s, f) {
  const range = s.kind === "int" ? `${s.min.toLocaleString("en-US")}–${s.max.toLocaleString("en-US")}${s.unit ? ` ${s.unit}` : ""} · default ${s.default.toLocaleString("en-US")}` : s.kind === "path" ? "absolute path, empty: node from the login shell, /opt/homebrew/bin, /usr/local/bin" : "~/ is your home folder";
  return v_flex().id(`filer-pro-settings-${s.key}`).gap(3)
    .child(h_flex().gap(8).items_center().child(label(t, s.label)).child(hint(t, range)))
    .child(input(t, f))
    .when(Boolean(f.error), (el) => el.child(errorLine(t, f.error)));
}

function toggleRow(t, s, state) {
  const on = state.flags[s.key] === true;
  return h_flex().id(`filer-pro-settings-${s.key}`).gap(8).items_center().cursor_pointer()
    .on_click((_e, cx) => { state.flags[s.key] = !on; if (!state.broken) state.error = null; cx.notify(); })
    .child(div().w(16).h(16).flex_none().rounded(4).border_1().border_color(on ? t.solid : t.input).bg(on ? t.solid : t.background)
      .text_size(11).text_color(t.solid_foreground).flex().items_center().justify_center().child(on ? "✓" : ""))
    .child(label(t, s.label));
}

function chips(t, ed) {
  return h_flex().flex_wrap().gap(6).children(editorChoices(ed).map((name) => {
    const picked = name === ed.choice;
    return div().id(`filer-pro-settings-${ed.kind}-${name}`).px(8).py(3).rounded(6).text_size(12).cursor_pointer()
      .border_1().border_color(picked ? t.solid : t.input).bg(picked ? t.solid : t.raised).text_color(picked ? t.solid_foreground : t.foreground)
      .on_click((_e, cx) => { ed.choice = name; ed.choiceError = null; cx.notify(); }).child(name);
  }));
}

function editorBlock(t, ed, title, help) {
  const placeholders = { name: "Name", command: "Command (the path is appended)", local: "Local: e.g. myed {path}", remote: "Remote (optional): e.g. myed ssh://{target}{path_uri}" };
  return v_flex().gap(6)
    .child(label(t, title)).child(chips(t, ed))
    .when(Boolean(ed.choiceError), (el) => el.child(errorLine(t, ed.choiceError)))
    .child(hint(t, help))
    .children(ed.slots.map((slot, i) => v_flex().id(`filer-pro-settings-${ed.kind}-slot-${i}`).gap(3)
      .child(h_flex().gap(6).children(ed.names.map((n) => v_flex().flex_1().min_w(0).gap(2).child(hint(t, placeholders[n])).child(input(t, slot[n])))))
      .when(Boolean(ed.errors[i]), (el) => el.child(errorLine(t, ed.errors[i])))));
}

const heading = (t, text) => div().pt(10).pb(2).text_size(13).font_semibold().text_color(t.foreground).border_b(1).border_color(t.border).child(text);

// handlers: { onCancel(), onSave(cx) }
export function settingsView(t, state, handlers) {
  const rows = (section) => SETTINGS.filter((s) => s.section === section).map((s) => (s.kind === "bool" ? toggleRow(t, s, state) : textRow(t, s, state.fields[s.key])));
  const items = SECTIONS.flatMap((section) => [
    heading(t, section),
    ...(section === "Editors" ? [
      editorBlock(t, state.gui, "Open in Editor", "Own GUI editors: {path} or {path_uri} for the file, {target} for the SSH target (remote only). Empty slots are ignored; save and reopen for more."),
      editorBlock(t, state.terminal, "Edit in Terminal", "Own terminal editors: the program and its arguments; the path is appended. Empty slots are ignored."),
    ] : rows(section)),
    // Directly below the SVG switch, always visible.
    ...(section === "Security" ? [div().id("filer-pro-settings-svg-warning").p(8).rounded(6).border_1().border_color(t.ansi1).text_size(12).text_color(t.ansi1).child(SVG_WARNING)] : []),
  ]);
  const body = v_flex().id("filer-pro-settings-body").flex_1().min_h(0).overflow_y_scrollbar().pr(6).gap(8).children(items);
  const canSave = !state.busy && !state.broken;
  const button = (id, text, primary, enabled, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
    .border_1().border_color(primary && enabled ? t.solid : t.input).bg(primary && enabled ? t.solid : t.raised)
    .text_color(primary && enabled ? t.solid_foreground : enabled ? t.foreground : t.dim).text_size(12.5).font_medium()
    .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => action(cx))).child(text);
  return v_flex().id("filer-pro-settings").track_focus(state.handle)
    .on_key_down((e, cx) => { if (e.key === "escape") { handlers.onCancel(); cx.stop_propagation(); } })
    .size_full().p(18).gap(10).bg(t.popover).text_color(t.foreground)
    .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child("Filer Pro Settings")).child(hint(t, "Esc")))
    .child(body)
    .child(h_flex().gap(8).items_center()
      .child(div().flex_1().min_w(0).text_size(11).text_color(t.ansi1).child(state.error ?? ""))
      .child(button("filer-pro-settings-cancel", "Cancel", false, true, handlers.onCancel))
      .child(button("filer-pro-settings-save", state.busy ? "Saving…" : "Save", true, canSave, (cx) => handlers.onSave(cx))));
}
