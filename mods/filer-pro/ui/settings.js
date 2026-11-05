// Settings dialog (overlay view "settings"): Updates, Downloads, Editors, Preview, Security and a collapsed Advanced
// part with every number of lib/settings.js, checked field by field and written back with saveSettings (read-modify-write,
// only the changed keys). Every InputState is created here, in the overlay's init (never in render), from the snapshot
// the opener put into shared("filer-pro.settings").
//
// Redraws: an Input draws its own text, so typing does not redraw the dialog. The dialog asks for a redraw only when
// something it shows changes: a message goes away, a field gains or loses the focus ring, a field is checked on blur.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { SETTINGS, ADVANCED, validateField, changedEdits, saveSettings, group } from "../lib/settings.js";
import { TERMINAL_EDITORS, GUI_EDITORS } from "../lib/editors.js";
import { updateHint } from "../lib/update.js";
import { BASE } from "../lib/icons.js";

export const CONFIG_PATH = "~/.config/herdr-app/filer-pro.json";
export const GITHUB_URL = "https://github.com/Srv-02/herdr-filerpro";
export const COFFEE_URL = "https://www.buymeacoffee.com/michaelmayer";
export const EDITORS_DOC_URL = `${GITHUB_URL}#editors`;
export const SVG_WARNING = "A specially prepared SVG image can load content from the internet, slip in code, or grow so large that Filer Pro freezes. With the check off, you open SVG files at your own risk.";
export const FIX_FIELDS = "Check the fields marked in red.";
export const brokenText = (path = CONFIG_PATH) => `Settings can’t be saved: ${path} has a typo. Fix or delete the file, then reopen Settings.`;

const str = (v) => (typeof v === "string" ? v : "");
const ADVANCED_KEYS = new Set(SETTINGS.filter((s) => ADVANCED.includes(s.section)).map((s) => s.key));

// "/Users/u/Downloads" -> "~/Downloads" when it lies in the home folder.
export const tilde = (path, home) => (home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path);

// A text field: its InputState, the typed value (kept from the change event, as ui/namedialog.js does), its message
// and whether it holds the focus. A redraw only when one of the last two changes.
function field(state, key, value, placeholder) {
  const f = { key, value, error: null, focused: false, input: InputState.new(placeholder ? { value, placeholder } : { value }) };
  f.input.on("change", (_e, cx) => {
    f.value = f.input.value();
    const shown = f.error !== null || (state.error !== null && !state.broken);
    f.error = null;
    if (!state.broken) state.error = null;
    if (shown) cx.notify();
  });
  f.input.on("focus", (_e, cx) => { f.focused = true; cx.notify(); });
  f.input.on("blur", (_e, cx) => { f.focused = false; f.error = validateField(key, f.value).error ?? null; cx.notify(); });
  return f;
}

// The names to pick from: the shipped editors, then the valid own ones of the config (an own one with a shipped name
// replaces that one and is listed once).
export function editorNames(shipped, own) {
  return [...new Set([...shipped.map((e) => e.name), ...(Array.isArray(own) ? own : []).map((e) => e?.name).filter((n) => typeof n === "string" && n)])];
}

// snapshot: { config (loadConfig), raw (the parsed file or null), broken, version, configPath, home } -> the dialog state.
export function createSettingsDialog(snapshot, cx) {
  const config = snapshot?.config ?? {}, raw = snapshot?.raw && typeof snapshot.raw === "object" && !Array.isArray(snapshot.raw) ? snapshot.raw : {};
  const configPath = snapshot?.configPath ?? CONFIG_PATH;
  const state = {
    fields: {}, flags: {}, initial: {}, broken: Boolean(snapshot?.broken), busy: false, advanced: false, handle: cx.focus_handle(),
    version: snapshot?.version ?? null, home: snapshot?.home ?? null, configPath, check: { phase: "idle" },
  };
  state.error = state.broken ? brokenText(configPath) : null;
  for (const s of SETTINGS) {
    if (s.kind === "bool") { state.flags[s.key] = config[s.key] ?? s.default; state.initial[s.key] = state.flags[s.key]; continue; }
    // The download folder as written in the file (~/ stays ~/), everything else as loadConfig read it.
    const shown = s.key === "download_folder" ? (str(raw.download_folder).trim() || s.default) : String(config[s.key] ?? s.default);
    state.fields[s.key] = field(state, s.key, shown, s.key === "node_path" ? "Automatic" : null);
    state.initial[s.key] = validateField(s.key, shown).value ?? shown;
  }
  // Editors: only the choice is edited here; own entries come from the config file (see README, Editors).
  state.editors = {
    gui: { key: "gui_editor", names: editorNames(GUI_EDITORS, config.gui_editors), choice: config.gui_editor ?? "VS Code" },
    terminal: { key: "terminal_editor", names: editorNames(TERMINAL_EDITORS, config.terminal_editors), choice: config.terminal_editor ?? "vi" },
  };
  for (const ed of Object.values(state.editors)) state.initial[ed.key] = ed.choice;
  // The dialog itself holds the keyboard (Esc), no field is active at first.
  state.handle.focus();
  cx.timer.after(600, () => state.handle.focus());
  return state;
}

// Checks every field, marks the errors on the state (and opens Advanced when one is there), and returns the changed
// keys, or null when anything is wrong.
export function collect(state) {
  let bad = false;
  const current = { ...state.flags };
  for (const [key, f] of Object.entries(state.fields)) {
    const r = validateField(key, f.value);
    f.error = r.error ?? null;
    if (r.error) { bad = true; if (ADVANCED_KEYS.has(key)) state.advanced = true; } else current[key] = r.value;
  }
  for (const ed of Object.values(state.editors)) current[ed.key] = ed.choice;
  return bad ? null : changedEdits(state.initial, current);
}

// Save: nothing is written while a field is wrong or the file is broken. io: { readTextFile, writeTextFile, path }.
// -> true when saved (the caller closes the dialog and announces the change).
export async function submitSettings(state, io, cx) {
  if (state.busy || state.broken) return false;
  const edits = collect(state);
  if (!edits) { state.error = FIX_FIELDS; cx?.notify(); return false; }
  state.busy = true; state.error = null; cx?.notify();
  const out = await saveSettings(edits, io);
  state.busy = false;
  if (!out.ok) {
    if (out.broken) state.broken = true;
    state.error = out.broken ? brokenText(state.configPath) : out.error;
    cx?.notify();
    return false;
  }
  return true;
}

// --- update status ---

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");

// "today at 09:41", "yesterday at 18:02", "on Nov 3 at 07:15" (local time).
export function checkedAt(at, now) {
  const d = new Date(at), n = new Date(now), hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(n) - day(d)) / 86400000);
  if (days === 0) return `today at ${hm}`;
  if (days === 1) return `yesterday at ${hm}`;
  return `on ${MONTHS[d.getMonth()]} ${d.getDate()} at ${hm}`;
}

// What the Updates row shows. check: the dialog's own Check now ({ phase: idle | checking | failed | done, state });
// stored: shared("filer-pro.update"); local: the installed version.
// -> { kind: checking | failed | available (version, url) | uptodate (at) | unchecked }.
export function updateStatus(check, stored, local) {
  if (check?.phase === "checking") return { kind: "checking" };
  if (check?.phase === "failed") return { kind: "failed" };
  const st = check?.phase === "done" ? check.state : stored;
  const hint = updateHint(st, local);
  if (hint) return { kind: "available", ...hint };
  if (st && typeof st.at === "number") return { kind: "uptodate", at: st.at };
  return { kind: "unchecked" };
}

// --- view ---

const icon = (name, size, color) => svg(`${BASE}/${name}.svg`).size(size).flex_none().text_color(color);
const help = (t, text, color) => div().text_size(12.5).line_height("18px").text_color(color ?? t.muted).child(text);
const errorLine = (t, text) => div().text_size(12).line_height("18px").text_color(t.ansi1).child(text);

function heading(t, text, first) {
  return div().pt(first ? 4 : 22).pb(8).text_size(12).font_semibold().text_color(t.muted).child(text.toUpperCase());
}

function subheading(t, text) {
  return div().pt(18).pb(4).text_size(12.5).font_medium().text_color(t.foreground).child(text);
}

// One setting: the label, its help line in grey below it (never beside), an optional error, the control on the right.
function row(t, id, title, about, controls, { last = false, error = null, dim = false } = {}) {
  return h_flex().id(id).w_full().gap(16).py(12).items_center()
    .when(!last, (el) => el.border_b(1).border_color(t.border))
    .when(dim, (el) => el.opacity(0.45))
    .child(v_flex().flex_1().min_w(0).gap(3)
      .child(div().text_size(14).text_color(t.foreground).child(title))
      .child(about)
      .when(Boolean(error), (el) => el.child(errorLine(t, error))))
    .child(h_flex().flex_none().gap(8).items_center().children(controls));
}

// Herdr's own switch (frame/settings toggle): 36x20, knob 16, accent when on.
function toggle(t, id, on, onClick) {
  return div().id(id).w(36).h(20).flex_none().rounded(10).p(2).flex().bg(on ? t.accent : t.hover)
    .when(on, (el) => el.justify_end())
    .when(Boolean(onClick), (el) => el.cursor_pointer().on_click(onClick))
    .child(div().w(16).h(16).rounded(8).bg(on ? t.accent_foreground : t.muted));
}

function button(t, id, text, onClick, primary = false) {
  return h_flex().id(id).px(12).py(5).gap(6).items_center().rounded(7).cursor_pointer().text_size(13)
    .when(primary, (el) => el.bg(t.accent).text_color(t.accent_foreground).font_semibold())
    .when(!primary, (el) => el.border_1().border_color(t.border).bg(t.raised).text_color(t.foreground))
    .hover((s) => s.opacity(0.88))
    .on_click((_e, cx) => onClick(cx))
    .child(text);
}

const input = (t, f, w) => Input.new(f.input).w(w).h(28).px(8).rounded(6).border_1()
  .border_color(f.error ? t.ansi1 : f.focused ? t.accent : t.input).bg(t.background).text_size(13).text_color(t.foreground);

function switchRow(t, state, key, { last = false, disabled = false } = {}) {
  const s = SETTINGS.find((x) => x.key === key);
  const on = state.flags[key] === true;
  const flip = disabled ? null : (_e, cx) => { state.flags[key] = !on; cx.notify(); };
  return row(t, `filer-pro-settings-${key}`, s.label, help(t, s.help), [toggle(t, `filer-pro-settings-${key}-switch`, on, flip)], { last, dim: disabled });
}

function numberRow(t, state, s, last) {
  const f = state.fields[s.key];
  return row(t, `filer-pro-settings-${s.key}`, s.label, help(t, `${s.help} Default ${group(s.default)}.`),
    [input(t, f, 84), div().w(92).text_size(12.5).text_color(t.muted).child(s.unit)], { last, error: f.error });
}

function updatesRow(t, state, handlers, status) {
  const title = state.version ? `Filer Pro ${state.version}` : "Filer Pro";
  const line = {
    checking: () => help(t, "Asking GitHub for the latest version…"),
    failed: () => help(t, "Could not reach GitHub. Check your connection and try again.", t.ansi1),
    available: () => h_flex().gap(6).items_center().child(div().w(7).h(7).flex_none().rounded(4).bg(t.accent)).child(help(t, `Version ${status.version} is available.`, t.foreground)),
    uptodate: () => h_flex().gap(6).items_center().child(icon("check", 13, t.ansi2)).child(help(t, `You’re up to date. Last checked ${checkedAt(status.at, Date.now())}.`)),
    unchecked: () => help(t, "Not checked yet."),
  }[status.kind]();
  const control = {
    checking: () => h_flex().id("filer-pro-settings-checking").px(12).py(5).gap(6).items_center().text_size(13).text_color(t.muted)
      .child(icon("loader-circle", 13, t.muted).spin(900)).child("Checking…"),
    failed: () => button(t, "filer-pro-settings-retry", "Try again", handlers.onCheck),
    available: () => button(t, "filer-pro-settings-release", h_flex().gap(6).items_center().child(`What’s new in ${status.version}`).child(icon("external-link", 13, t.accent_foreground)),
      (cx) => cx.open_url(status.url), true),
    uptodate: () => button(t, "filer-pro-settings-check", "Check now", handlers.onCheck),
    unchecked: () => button(t, "filer-pro-settings-check", "Check now", handlers.onCheck),
  }[status.kind]();
  return row(t, "filer-pro-settings-version", title, line, [control]);
}

// Herdr's appearancePicker: one segment per name, the chosen one raised.
function segmented(t, state, kind) {
  const ed = state.editors[kind];
  return h_flex().id(`filer-pro-settings-${ed.key}-picker`).self_start().flex_wrap().gap(2).p(2).rounded(8).border_1().border_color(t.border).bg(t.background)
    .children(ed.names.map((name) => {
      const on = name === ed.choice;
      return div().id(`filer-pro-settings-${kind}-${name}`).px(12).py(4).rounded(6).text_size(13).cursor_pointer().border_1()
        .when(on, (el) => el.bg(t.raised).text_color(t.foreground).border_color(t.border))
        .when(!on, (el) => el.border_color("#00000000").text_color(t.muted).hover((s) => s.text_color(t.foreground)))
        .on_click((_e, cx) => { if (ed.choice !== name) { ed.choice = name; cx.notify(); } })
        .child(name);
    }));
}

function editorBlock(t, state, kind, title, about, last) {
  const key = state.editors[kind].key;
  return v_flex().id(`filer-pro-settings-${key}`).gap(8).py(12).when(!last, (el) => el.border_b(1).border_color(t.border))
    .child(v_flex().gap(3).child(div().text_size(14).text_color(t.foreground).child(title)).child(help(t, about)))
    .child(segmented(t, state, kind));
}

function link(t, id, text, iconName, url) {
  return h_flex().id(id).gap(6).items_center().cursor_pointer().text_size(12.5).text_color(t.muted).hover((s) => s.text_color(t.foreground))
    .on_click((_e, cx) => cx.open_url(url))
    .when(Boolean(iconName), (el) => el.child(icon(iconName, 14, t.muted)))
    .child(text);
}

function body(t, state, handlers, stored) {
  const f = state.fields.download_folder, dl = SETTINGS.find((s) => s.key === "download_folder");
  const svgOn = state.flags.svg_check === true, warn = svgOn ? t.ansi3 : t.ansi1;
  const items = [
    heading(t, "Updates", true),
    updatesRow(t, state, handlers, updateStatus(state.check, stored, state.version)),
    switchRow(t, state, "update_check", { last: true }),

    heading(t, "Downloads"),
    row(t, "filer-pro-settings-download_folder", dl.label, help(t, dl.help),
      [input(t, f, 190), button(t, "filer-pro-settings-choose", "Choose…", handlers.onChoose)], { last: true, error: f.error }),

    heading(t, "Editors"),
    editorBlock(t, state, "gui", "Open in Editor", "The app that opens when you pick Open in Editor. Works for files on this Mac and on your SSH machines.", false),
    editorBlock(t, state, "terminal", "Edit in Terminal", "The editor that opens in a new split when you pick Edit in Terminal.", true),
    h_flex().id("filer-pro-settings-editors-info").gap(8).items_start().mt(4).px(12).py(10).rounded(8).bg(t.hover)
      .child(div().mt(2).flex_none().child(icon("info", 14, t.muted)))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(help(t, `Missing your editor? Add it to ${state.configPath}, then reopen Settings.`))
        .child(h_flex().child(div().id("filer-pro-settings-editors-doc").cursor_pointer().text_size(12.5).line_height("18px").text_color(t.accent)
          .on_click((_e, cx) => cx.open_url(EDITORS_DOC_URL)).child("How to add an editor")))),

    heading(t, "Preview"),
    switchRow(t, state, "preview"),
    switchRow(t, state, "mermaid", { last: true, disabled: state.flags.preview !== true }),

    heading(t, "Security"),
    switchRow(t, state, "svg_check", { last: true }),
    // Directly below the SVG switch, always visible: yellow while the check is on, red when it is off.
    h_flex().id("filer-pro-settings-svg-warning").gap(10).items_start().mt(8).px(12).py(10).rounded(8).border_1().border_color(warn).text_color(warn)
      .child(div().mt(1).flex_none().child(icon("shield-exclamation-point", 16, warn)))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().text_size(13).font_semibold().child(svgOn ? "Keep this on" : "The SVG check is off"))
        .child(div().text_size(12.5).line_height("18px").child(SVG_WARNING))),

    h_flex().id("filer-pro-settings-advanced").mt(22).w_full().gap(10).py(12).items_center().cursor_pointer()
      .border_t(1).border_b(1).border_color(t.border)
      .on_click((_e, cx) => { state.advanced = !state.advanced; cx.notify(); })
      .child(icon(state.advanced ? "chevron-down" : "chevron-right", 15, t.muted))
      .child(v_flex().flex_1().gap(3)
        .child(div().text_size(14).text_color(t.foreground).child("Advanced"))
        .child(help(t, "Limits, timeouts and connections. The defaults suit almost everyone."))),
  ];
  if (state.advanced) {
    for (const section of ADVANCED) {
      const list = SETTINGS.filter((s) => s.section === section);
      items.push(subheading(t, section));
      list.forEach((s, i) => {
        const last = i === list.length - 1;
        if (s.kind === "int") { items.push(numberRow(t, state, s, last)); return; }
        const fp = state.fields[s.key];
        items.push(row(t, `filer-pro-settings-${s.key}`, s.label, help(t, s.help), [input(t, fp, 182)], { last, error: fp.error }));
      });
    }
  }
  items.push(h_flex().id("filer-pro-settings-footer").gap(18).pt(26).pb(6).items_center().flex_wrap()
    .child(div().flex_1().text_size(12.5).text_color(t.muted).child("Filer Pro is free and open source."))
    .child(link(t, "filer-pro-settings-github", "GitHub", "github", GITHUB_URL))
    .child(link(t, "filer-pro-settings-coffee", "Buy me a coffee", "coffee", COFFEE_URL)));
  return items;
}

// handlers: { onCancel(), onSave(cx), onCheck(cx), onChoose(cx) }; stored: shared("filer-pro.update").
export function settingsView(t, state, handlers, stored = null) {
  const canSave = !state.busy && !state.broken;
  const bottom = (id, text, primary, enabled, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
    .border_1().border_color(primary && enabled ? t.solid : t.input).bg(primary && enabled ? t.solid : t.raised)
    .text_color(primary && enabled ? t.solid_foreground : enabled ? t.foreground : t.dim).text_size(12.5).font_medium()
    .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => action(cx))).child(text);
  return v_flex().id("filer-pro-settings").track_focus(state.handle)
    .on_key_down((e, cx) => { if (e.key === "escape") { handlers.onCancel(); cx.stop_propagation(); } })
    .size_full().bg(t.popover).text_color(t.foreground)
    .child(h_flex().flex_none().items_center().px(24).pt(18).pb(10)
      .child(div().flex_1().text_size(15).font_semibold().child("Filer Pro Settings"))
      .child(div().px(6).py(2).rounded(5).border_1().border_color(t.border).text_size(11).text_color(t.muted).child("Esc")))
    // A bar that always shows, as in Herdr's settings: the body is taller than the dialog.
    .child(div().relative().flex_1().min_h(0)
      .child(div().id("filer-pro-settings-body").size_full().overflow_y_scroll()
        .child(v_flex().px(24).pt(4).pb(18).children(body(t, state, handlers, stored))))
      .child(Scrollbar.vertical("filer-pro-settings-body").mode("always").absolute().inset_0()))
    .child(h_flex().flex_none().gap(8).px(24).py(12).items_center().border_t(1).border_color(t.border)
      .child(div().flex_1().min_w(0).text_size(11.5).text_color(t.ansi1).child(state.error ?? ""))
      .child(bottom("filer-pro-settings-cancel", "Cancel", false, true, handlers.onCancel))
      .child(bottom("filer-pro-settings-save", state.busy ? "Saving…" : "Save", true, canSave, (cx) => handlers.onSave(cx))));
}
