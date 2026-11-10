// The settings dialog (mods/filer-pro/ui/settings.js) on stubbed gpui modules: fields from the snapshot, validation, the
// edits it writes, the redraws it asks for, and the view (order of the parts, Advanced, the SVG warning, texts of the spec).
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// A tiny element tree: every builder call is recorded, children are kept, so the view can be searched.
const GPUI = `
const el = (tag, ...args) => { const e = { tag, args, kids: [], calls: [] };
  return new Proxy(e, { get(t, k) { if (k in t) return t[k]; return (...a) => { t.calls.push([k, a]); if (k === "child") t.kids.push(a[0]); if (k === "children") t.kids.push(...a[0]); if (k === "when" && a[0]) a[1](new Proxy(t, this)); return new Proxy(t, this); }; } }); };
export class View {}
export const div = (...a) => el("div", ...a), svg = (...a) => el("svg", ...a), image = div;
export const v_flex = (...a) => el("v_flex", ...a), h_flex = v_flex, Input = { new: (s) => el("input", s) }, Scrollbar = { vertical: (...a) => el("scrollbar", ...a) };
export class InputState { static new(o) { const s = new InputState(); s.v = o.value; s.placeholder = o.placeholder; s.handlers = {}; s.focused = 0; return s; }
  on(ev, fn) { this.handlers[ev] = fn; } value() { return this.v; } set_value(v) { this.v = v; } focus() { this.focused++; }
  type(v, cx) { this.v = v; this.handlers.change?.({}, cx); } fire(ev, cx) { this.handlers[ev]?.({}, cx); } }
`;
const hooks = `const S = ${JSON.stringify(GPUI)};
export async function resolve(s, c, next) { return s === "gpui-kit" || s === "gpui-base" ? { url: "stub:gpui", shortCircuit: true } : next(s, c); }
export async function load(u, c, next) { return u === "stub:gpui" ? { format: "module", shortCircuit: true, source: S } : next(u, c); }`;
register("data:text/javascript," + encodeURIComponent(hooks));
const ui = await import("../mods/filer-pro/ui/settings.js");
const { createSettingsDialog, collect, submitSettings, settingsView, editorNames, updateStatus, checkedAt, tilde, brokenText, SVG_WARNING, FIX_FIELDS, GITHUB_URL, COFFEE_URL } = ui;
const { loadConfig } = await import("../mods/filer-pro/lib/config.js");
const { SETTINGS, NUMBERS } = await import("../mods/filer-pro/lib/settings.js");
const { GUI_EDITORS } = await import("../mods/filer-pro/lib/editors.js");

function makeCx() {
  const cx = { notes: 0, focused: 0, notify() { cx.notes++; }, focus_handle: () => ({ focus() { cx.focused++; } }), timer: { after() {} } };
  return cx;
}
const cx = makeCx();
async function snapshot(raw, extra = {}) {
  const text = raw === undefined ? null : JSON.stringify(raw);
  const config = await loadConfig(async () => text, () => "/app", () => "/home/u");
  return { config, raw: raw ?? null, broken: false, version: "1.0.0", ...extra };
}
const type = (state, key, v, c = cx) => state.fields[key].input.type(v, c);
const t = new Proxy({}, { get: (_o, k) => k });
const noop = { onCancel() {}, onSave() {}, onCheck() {}, onChoose() {} };

// Depth-first list of every element's text children and ids.
function texts(e, out = []) {
  if (typeof e === "string") { out.push(e); return out; }
  if (!e || typeof e !== "object") return out;
  for (const [k, a] of e.calls ?? []) if (k === "id") out.push(`#${a[0]}`);
  for (const k of e.kids ?? []) texts(k, out);
  return out;
}
function* walk(e) {
  if (!e || typeof e !== "object") return;
  yield e;
  for (const k of e.kids ?? []) yield* walk(k);
}
const byId = (root, id) => [...walk(root)].find((e) => e.calls?.some(([k, a]) => k === "id" && a[0] === id));
const called = (e, name) => e.calls.filter(([k]) => k === name).map(([, a]) => a);
const view = (s, stored) => settingsView(t, s, noop, stored);

test("dialog: every setting starts with its current value; ~/ stays as written; the dialog holds the keyboard", async () => {
  const c = makeCx();
  const s = createSettingsDialog(await snapshot({ download_folder: "~/Inbox", list_total: 7000, svg_check: false }), c);
  assert.equal(s.fields.download_folder.value, "~/Inbox");
  assert.equal(s.fields.list_total.value, "7000");
  assert.equal(s.fields.tree_depth.value, "40");
  assert.equal(s.fields.node_path.value, "");
  assert.equal(s.fields.node_path.input.placeholder, "Automatic");
  assert.equal(s.flags.svg_check, false);
  assert.equal(s.flags.update_check, true);
  for (const k of SETTINGS.map((x) => x.key)) assert.ok(k in s.fields || k in s.flags, k);
  assert.ok(!("perf" in s.flags), "perf is not in the dialog");
  assert.equal(s.editors.terminal.choice, "vi");
  assert.equal(s.editors.gui.choice, "VS Code");
  assert.equal(s.advanced, false, "Advanced starts closed");
  assert.equal(c.focused, 1, "the dialog's own focus handle");
  assert.equal(s.fields.download_folder.input.focused, 0, "no field is active at first");
});

test("dialog: nothing changed writes nothing; changed fields, switches and editor choices are the only edits", async () => {
  const s = createSettingsDialog(await snapshot({ my_key: 1, list_total: 7000 }), cx);
  assert.deepEqual(collect(s), {});
  type(s, "list_total", "8000");
  s.flags.preview = false;
  s.editors.gui.choice = "Zed";
  assert.deepEqual(collect(s), { list_total: 8000, preview: false, gui_editor: "Zed" });
});

test("dialog: invalid values get the messages of the spec, nothing is written, Advanced opens", async () => {
  const s = createSettingsDialog(await snapshot(undefined), cx);
  type(s, "list_per_folder", "abc");
  type(s, "list_total", "5");
  type(s, "ssh_connect_timeout", "15 -o ProxyCommand=x");
  type(s, "download_folder", " ");
  type(s, "node_path", "node");
  const writes = [];
  const io = { readTextFile: async () => "{}", writeTextFile: async (...a) => { writes.push(a); }, path: "/app/filer-pro.json" };
  assert.equal(await submitSettings(s, io, cx), false);
  assert.deepEqual(writes, []);
  assert.equal(s.error, FIX_FIELDS);
  assert.equal(FIX_FIELDS, "Check the fields marked in red.");
  assert.equal(s.fields.list_per_folder.error, "Enter a whole number.");
  assert.equal(s.fields.list_total.error, "Enter a number from 100 to 20,000.");
  assert.equal(s.fields.ssh_connect_timeout.error, "Enter a whole number.");
  assert.equal(s.fields.download_folder.error, "Enter a folder.");
  assert.equal(s.fields.node_path.error, "Enter a full path that starts with /, or leave it empty.");
  assert.equal(s.advanced, true);
  type(s, "list_per_folder", "600");
  assert.equal(s.fields.list_per_folder.error, null, "typing clears the field's message");
  assert.equal(s.error, null, "and the save bar's");
});

test("dialog: a wrong field outside Advanced leaves Advanced closed", async () => {
  const s = createSettingsDialog(await snapshot(undefined), cx);
  type(s, "download_folder", "");
  assert.equal(collect(s), null);
  assert.equal(s.advanced, false);
});

test("dialog: save writes only the changed keys and keeps the rest of the file", async () => {
  const s = createSettingsDialog(await snapshot({ my_key: { a: 1 }, preview: false }), cx);
  type(s, "refresh_seconds", "30");
  let file = '{"my_key":{"a":1},"preview":false,"mermaid":false}';
  const io = { readTextFile: async () => file, writeTextFile: async (_p, text, expected) => { assert.equal(expected, file); file = text; }, path: "/app/filer-pro.json" };
  assert.equal(await submitSettings(s, io, cx), true);
  assert.deepEqual(JSON.parse(file), { my_key: { a: 1 }, preview: false, mermaid: false, refresh_seconds: 30 });
});

test("dialog: own editors of the config are choices, listed once; the lists themselves are never written", async () => {
  const raw = { terminal_editors: [{ name: "nvim", command: "nvim" }, { name: "bad", command: "x {path}" }], terminal_editor: "nvim", gui_editors: [{ name: "Zed", local: "zed-preview {path}" }, { name: "Sublime", local: "subl {path}" }] };
  const s = createSettingsDialog(await snapshot(raw), cx);
  assert.deepEqual(s.editors.terminal.names, ["vi", "vim", "nano", "micro", "fresh", "helix", "nvim"], "the broken own entry is not offered");
  assert.deepEqual(s.editors.gui.names, ["VS Code", "Cursor", "Zed", "Sublime"], "an own Zed replaces the shipped one, listed once");
  assert.equal(s.editors.terminal.choice, "nvim");
  s.editors.gui.choice = "Sublime";
  assert.deepEqual(collect(s), { gui_editor: "Sublime" });
  assert.deepEqual(editorNames(GUI_EDITORS, null), ["VS Code", "Cursor", "Zed"]);
});

test("dialog: a broken file is reported at once with the spec's text, and Save writes nothing", async () => {
  const s = createSettingsDialog({ config: (await snapshot(undefined)).config, raw: null, broken: true }, cx);
  assert.equal(s.error, "Settings can’t be saved: ~/.config/herdr-app/filer-pro.json has a typo. Fix or delete the file, then reopen Settings.");
  const writes = [];
  assert.equal(await submitSettings(s, { readTextFile: async () => "{nope", writeTextFile: async (...a) => writes.push(a), path: "x" }, cx), false);
  assert.deepEqual(writes, []);
});

test("dialog: a file that broke after opening is reported like a broken one and Save stays off", async () => {
  const s = createSettingsDialog(await snapshot({}, { configPath: "~/cfg/filer-pro.json" }), cx);
  type(s, "list_total", "6000");
  assert.equal(await submitSettings(s, { readTextFile: async () => "{nope", writeTextFile: async () => {}, path: "x" }, cx), false);
  assert.equal(s.error, brokenText("~/cfg/filer-pro.json"));
  assert.equal(s.broken, true);
});

test("redraws: typing asks for none; a message going away, focus and blur ask for one each", async () => {
  const c = makeCx();
  const s = createSettingsDialog(await snapshot(undefined), c);
  for (const ch of ["1", "12", "99"]) type(s, "list_total", ch, c);
  assert.equal(c.notes, 0, "the Input draws its own text");
  const f = s.fields.list_total;
  f.input.fire("focus", c);
  assert.equal(f.focused, true);
  assert.equal(c.notes, 1);
  f.input.fire("blur", c);
  assert.equal(f.error, "Enter a number from 100 to 20,000.", "checked when leaving the field");
  assert.equal(c.notes, 2);
  type(s, "list_total", "1234", c);
  assert.equal(c.notes, 3, "the message goes away: one redraw");
  type(s, "list_total", "12345", c);
  assert.equal(c.notes, 3, "nothing visible changed");
});

test("view: the parts in the order of the design, help lines below the labels, perf not shown", async () => {
  const s = createSettingsDialog(await snapshot(undefined), cx);
  const root = view(s);
  const out = texts(root);
  const order = ["UPDATES", "Filer Pro 1.0.0", "Check for updates automatically", "DOWNLOADS", "Download folder", "Choose…", "EDITORS", "Open in Editor", "Edit in Terminal",
    "Missing your editor? Add it to ~/.config/herdr-app/filer-pro.json, then reopen Settings.", "How to add an editor", "FILE LIST", "Hide system files", "Hide hidden files", "Open files with a double click", "Open apps with a double click", "PREVIEW", "Show previews", "Draw diagrams",
    "SECURITY", "Check SVG images before showing them", "Keep this on", SVG_WARNING, "Advanced", "Limits, timeouts and connections. The defaults suit almost everyone.",
    "Filer Pro is free and open source.", "GitHub", "Buy me a coffee", "Cancel", "Save"];
  let at = -1;
  for (const x of order) { const i = out.indexOf(x, at + 1); assert.ok(i > at, `${x} after the previous part`); at = i; }
  assert.ok(!out.includes("#filer-pro-settings-perf"));
  // A row: the left column holds the label and then its help line, never beside it.
  const row = byId(root, "filer-pro-settings-preview");
  const left = row.kids[0];
  assert.equal(left.tag, "v_flex");
  assert.deepEqual(texts(left), ["Show previews", "Markdown, HTML, images and PDFs open formatted. Turn off to always see the raw text."]);
  for (const s2 of NUMBERS) assert.ok(!out.includes(`#filer-pro-settings-${s2.key}`), `${s2.key} hidden while Advanced is closed`);
});

test("view: Advanced opens with its three groups, every number with its unit and default, then Node.js", async () => {
  const s = createSettingsDialog(await snapshot(undefined), cx);
  s.advanced = true;
  const root = view(s), out = texts(root);
  for (const x of SETTINGS) assert.ok(out.includes(`#filer-pro-settings-${x.key}`), x.key);
  const groups = ["File list limits", "Preview limits", "Transfers & connections"].map((g) => out.indexOf(g));
  assert.ok(groups.every((i, n) => i > 0 && (n === 0 || i > groups[n - 1])));
  assert.ok(out.includes("Bigger folders are cut off with a note. Default 500."));
  assert.ok(out.includes("Across all open folders together. Default 5,000."));
  assert.ok(out.includes("missed checks"));
  assert.ok(out.indexOf("Node.js for diagrams") > out.indexOf("Largest diagram") && out.indexOf("Node.js for diagrams") < groups[2]);
  const chevron = [...walk(byId(root, "filer-pro-settings-advanced"))].find((e) => e.tag === "svg");
  assert.match(chevron.args[0], /chevron-down\.svg$/);
  s.advanced = false;
  assert.match([...walk(byId(view(s), "filer-pro-settings-advanced"))].find((e) => e.tag === "svg").args[0], /chevron-right\.svg$/);
});

test("view: the SVG warning follows its switch, yellow while on, red with another title when off", async () => {
  const s = createSettingsDialog(await snapshot(undefined), cx);
  const out = texts(view(s));
  const sw = out.indexOf("#filer-pro-settings-svg_check"), warn = out.indexOf("#filer-pro-settings-svg-warning");
  assert.ok(sw >= 0 && warn > sw);
  assert.ok(out.slice(sw + 1, warn).every((x) => x === "#filer-pro-settings-svg_check-switch" || !x.startsWith("#")), "nothing in between");
  assert.deepEqual(called(byId(view(s), "filer-pro-settings-svg-warning"), "border_color"), [["ansi3"]]);
  s.flags.svg_check = false;
  const off = byId(view(s), "filer-pro-settings-svg-warning");
  assert.deepEqual(called(off, "border_color"), [["ansi1"]]);
  assert.ok(texts(off).includes("The SVG check is off"));
});

test("view: Draw diagrams is dimmed and cannot be switched while previews are off", async () => {
  const s = createSettingsDialog(await snapshot({ preview: false }), cx);
  const row = byId(view(s), "filer-pro-settings-mermaid");
  assert.deepEqual(called(row, "opacity"), [[0.45]]);
  assert.equal(called(byId(view(s), "filer-pro-settings-mermaid-switch"), "on_click").length, 0);
  s.flags.preview = true;
  assert.equal(called(byId(view(s), "filer-pro-settings-mermaid"), "opacity").length, 0);
  assert.equal(called(byId(view(s), "filer-pro-settings-mermaid-switch"), "on_click").length, 1);
});

test("view: editors are segmented buttons; a click picks one", async () => {
  const s = createSettingsDialog(await snapshot(undefined), cx);
  const c = makeCx();
  const zed = byId(view(s), "filer-pro-settings-gui-Zed");
  called(zed, "on_click")[0][0]({}, c);
  assert.equal(s.editors.gui.choice, "Zed");
  assert.equal(c.notes, 1);
  assert.ok(texts(view(s)).includes("#filer-pro-settings-terminal-helix"));
});

test("view: the footer links open GitHub and Buy me a coffee", async () => {
  const s = createSettingsDialog(await snapshot(undefined), cx);
  const opened = [], c = { open_url: (u) => opened.push(u) };
  for (const id of ["filer-pro-settings-github", "filer-pro-settings-coffee", "filer-pro-settings-editors-doc"]) called(byId(view(s), id), "on_click")[0][0]({}, c);
  assert.deepEqual(opened, [GITHUB_URL, COFFEE_URL, `${GITHUB_URL}#editors`]);
  assert.equal(GITHUB_URL, "https://github.com/Srv-02/herdr-filerpro");
  assert.equal(COFFEE_URL, "https://www.buymeacoffee.com/michaelmayer");
});

test("view: the update row in its four states", async () => {
  const s = createSettingsDialog(await snapshot(undefined), cx);
  const at = (x) => texts(view(s, x));
  assert.ok(at(null).includes("Not checked yet.") && at(null).includes("Check now"));
  assert.ok(at({ at: Date.now(), local: "1.0.0", latest: "v1.0.0" }).some((x) => /^You’re up to date\. Last checked today at \d\d:\d\d\.$/.test(x)));
  const newer = at({ at: 1, local: "1.0.0", latest: "v1.1.0" });
  assert.ok(newer.includes("Version 1.1.0 is available.") && newer.includes("What’s new in 1.1.0"));
  s.check = { phase: "checking" };
  assert.ok(at(null).includes("Asking GitHub for the latest version…") && at(null).includes("Checking…"));
  s.check = { phase: "failed" };
  assert.ok(at(null).includes("Could not reach GitHub. Check your connection and try again.") && at(null).includes("Try again"));
});

test("updateStatus: the dialog's own result wins over the stored one", () => {
  assert.deepEqual(updateStatus({ phase: "done", state: { at: 9, local: "1.0.0", latest: null } }, { at: 1, local: "1.0.0", latest: "v2.0.0" }, "1.0.0"), { kind: "uptodate", at: 9 });
  assert.equal(updateStatus({ phase: "idle" }, { at: 1, local: "1.0.0", latest: "v2.0.0" }, "1.0.0").kind, "available");
  assert.equal(updateStatus({ phase: "idle" }, null, "1.0.0").kind, "unchecked");
});

test("checkedAt: today, yesterday, else the date, in local time", () => {
  const now = new Date(2026, 10, 5, 18, 30).getTime();
  assert.equal(checkedAt(new Date(2026, 10, 5, 9, 41).getTime(), now), "today at 09:41");
  assert.equal(checkedAt(new Date(2026, 10, 4, 23, 5).getTime(), now), "yesterday at 23:05");
  assert.equal(checkedAt(new Date(2026, 10, 3, 7, 0).getTime(), now), "on Nov 3 at 07:00");
});

test("tilde: only paths in the home folder get ~", () => {
  assert.equal(tilde("/home/u/Downloads", "/home/u"), "~/Downloads");
  assert.equal(tilde("/home/user2/x", "/home/u"), "/home/user2/x");
  assert.equal(tilde("/tmp", null), "/tmp");
});

test("view: the File list switches start at their defaults, flip on click, and only a flipped one is written (issue #17)", async () => {
  const s = createSettingsDialog(await snapshot(undefined), cx);
  assert.deepEqual([s.flags.hide_system_files, s.flags.hide_dotfiles], [true, false]);
  assert.deepEqual(collect(s), {});
  const sw = byId(view(s), "filer-pro-settings-hide_dotfiles-switch");
  called(sw, "on_click")[0][0]({}, makeCx());
  assert.equal(s.flags.hide_dotfiles, true);
  assert.deepEqual(collect(s), { hide_dotfiles: true });
  const row = byId(view(s), "filer-pro-settings-hide_system_files");
  assert.deepEqual(texts(row.kids[0]), ["Hide system files", "Hides clutter that macOS and Windows leave in folders, such as .DS_Store and Thumbs.db. Copying or deleting a folder still includes them."]);
  const off = createSettingsDialog(await snapshot({ hide_system_files: false }), cx);
  assert.equal(off.flags.hide_system_files, false);
});

test("view: while Hide hidden files is on, Hide system files shows on, is dimmed and cannot be switched; the stored value stays", async () => {
  const s = createSettingsDialog(await snapshot({ hide_system_files: false, hide_dotfiles: true }), cx);
  const row = byId(view(s), "filer-pro-settings-hide_system_files");
  assert.deepEqual(called(row, "opacity"), [[0.45]]);
  const sw = byId(view(s), "filer-pro-settings-hide_system_files-switch");
  assert.equal(called(sw, "on_click").length, 0);
  assert.deepEqual(called(sw, "bg"), [["accent"]], "drawn as on");
  assert.deepEqual(texts(row.kids[0]), ["Hide system files", "Hides clutter that macOS and Windows leave in folders, such as .DS_Store and Thumbs.db. Copying or deleting a folder still includes them."], "no extra help text");
  assert.equal(s.flags.hide_system_files, false, "the stored value is not overwritten");
  assert.deepEqual(collect(s), {});
  // Hide hidden files off again: the stored value (off) applies and the switch works.
  called(byId(view(s), "filer-pro-settings-hide_dotfiles-switch"), "on_click")[0][0]({}, makeCx());
  const back = byId(view(s), "filer-pro-settings-hide_system_files");
  assert.equal(called(back, "opacity").length, 0);
  const sw2 = byId(view(s), "filer-pro-settings-hide_system_files-switch");
  assert.deepEqual(called(sw2, "bg"), [["hover"]], "drawn as off");
  assert.equal(called(sw2, "on_click").length, 1);
  assert.deepEqual(collect(s), { hide_dotfiles: false });
});

test("view: the two double click switches start at their defaults, flip on their own, are never dimmed, and only a flipped one is written (issue #21)", async () => {
  const s = createSettingsDialog(await snapshot(undefined), cx);
  assert.deepEqual([s.flags.double_click_files, s.flags.double_click_apps], [false, true]);
  assert.deepEqual(collect(s), {});
  for (const key of ["double_click_files", "double_click_apps"]) assert.equal(called(byId(view(s), `filer-pro-settings-${key}`), "opacity").length, 0, key);
  called(byId(view(s), "filer-pro-settings-double_click_files-switch"), "on_click")[0][0]({}, makeCx());
  assert.deepEqual([s.flags.double_click_files, s.flags.double_click_apps], [true, true]);
  assert.deepEqual(collect(s), { double_click_files: true });
  called(byId(view(s), "filer-pro-settings-double_click_apps-switch"), "on_click")[0][0]({}, makeCx());
  assert.deepEqual([s.flags.double_click_files, s.flags.double_click_apps], [true, false]);
  assert.deepEqual(collect(s), { double_click_files: true, double_click_apps: false });
  for (const key of ["double_click_files", "double_click_apps"]) {
    assert.equal(called(byId(view(s), `filer-pro-settings-${key}`), "opacity").length, 0, key);
    assert.equal(called(byId(view(s), `filer-pro-settings-${key}-switch`), "on_click").length, 1, key);
  }
  const row = byId(view(s), "filer-pro-settings-double_click_apps");
  assert.deepEqual(texts(row.kids[0]), ["Open apps with a double click", "Apps, installers and other packages on this Mac. A double click keeps a downloaded app from starting by accident."]);
});

test("view: Warn before copying between machines is a switch in Transfers & connections; it toggles and saves", async () => {
  const id = "#filer-pro-settings-warn_cross_copy-switch";
  const s = createSettingsDialog(await snapshot(undefined), cx);
  assert.equal(s.flags.warn_cross_copy, true);
  s.advanced = true;
  const out = texts(view(s));
  const sw = out.indexOf(id);
  assert.ok(sw > out.indexOf("Transfers & connections"), "under the Transfers & connections subheading");
  assert.ok(out.includes("Warn before copying between machines"));
  assert.ok(out.includes("Asks once per paste when the data has to travel through this computer."));
  // Approved design: the first row of the group, above the numbers, with the same switch as the basic switches.
  assert.ok(sw < out.indexOf("#filer-pro-settings-ssh_connect_timeout"), "first row of Transfers & connections");
  const look = (e) => JSON.stringify(e.calls.filter(([k]) => k !== "id" && k !== "on_click"));
  assert.equal(look(byId(view(s), "filer-pro-settings-warn_cross_copy-switch")), look(byId(view(s), "filer-pro-settings-svg_check-switch")));
  const c = makeCx();
  called(byId(view(s), "filer-pro-settings-warn_cross_copy-switch"), "on_click")[0][0]({}, c);
  assert.equal(s.flags.warn_cross_copy, false);
  assert.deepEqual(collect(s), { warn_cross_copy: false });
  const off = createSettingsDialog(await snapshot({ warn_cross_copy: false }), cx);
  assert.equal(off.flags.warn_cross_copy, false);
  assert.deepEqual(collect(off), {});
});
