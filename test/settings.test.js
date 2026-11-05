import { test } from "node:test";
import assert from "node:assert/strict";
import { SETTINGS, NUMBERS, numbers, validateField, terminalProblem, guiProblem, editorSlots, saveSettings, changedEdits } from "../mods/filer-pro/lib/settings.js";
import { PREVIEW_MAX_CHARS, MAX_DIAGRAMS, MAX_DIAGRAM_CHARS } from "../mods/filer-pro/preview/prepare.js";
import { MAX_IMAGE, CACHE_LIMIT } from "../mods/filer-pro/preview/images.js";
import { MAX_PDF_LOCAL, MAX_PDF_REMOTE } from "../mods/filer-pro/preview/pdf.js";
import { STALL_MS } from "../mods/filer-pro/lib/progress.js";
import { KEEP_DONE_MS } from "../mods/filer-pro/lib/jobs.js";

const MB = 1024 * 1024;

test("settings: numeric defaults equal today's constants", () => {
  const d = numbers(null);
  assert.deepEqual(d, {
    list_per_folder: 500, list_total: 5000, tree_depth: 40, source_max_chars: 400000, preview_max_chars: 200000,
    image_max_mb: 20, image_cache_mb: 50, pdf_local_max_mb: 100, pdf_remote_max_mb: 20, max_diagrams: 20, max_diagram_chars: 20000,
    ssh_connect_timeout: 15, ssh_alive_interval: 15, ssh_alive_count: 4, stall_seconds: 120, keep_done_seconds: 10, refresh_seconds: 10,
  });
  assert.equal(d.preview_max_chars, PREVIEW_MAX_CHARS);
  assert.equal(d.max_diagrams, MAX_DIAGRAMS);
  assert.equal(d.max_diagram_chars, MAX_DIAGRAM_CHARS);
  assert.equal(d.image_max_mb * MB, MAX_IMAGE);
  assert.equal(d.image_cache_mb * MB, CACHE_LIMIT);
  assert.equal(d.pdf_local_max_mb * MB, MAX_PDF_LOCAL);
  assert.equal(d.pdf_remote_max_mb * MB, MAX_PDF_REMOTE);
  assert.equal(d.stall_seconds * 1000, STALL_MS);
  assert.equal(d.keep_done_seconds * 1000, KEEP_DONE_MS);
  for (const s of NUMBERS) assert.ok(s.min <= s.default && s.default <= s.max, s.key);
});

test("settings: a wrong type or a fraction falls back to the default, an integer out of range is clamped", () => {
  const n = numbers({ list_per_folder: "600", list_total: 1.5, tree_depth: 0, refresh_seconds: 999999, list_per_folder: 600.5, keep_done_seconds: 0, max_diagrams: null, stall_seconds: true });
  assert.equal(n.list_per_folder, 500);
  assert.equal(n.list_total, 5000);
  assert.equal(n.tree_depth, 1);
  assert.equal(n.refresh_seconds, 3600);
  assert.equal(n.keep_done_seconds, 0);
  assert.equal(n.max_diagrams, 20);
  assert.equal(n.stall_seconds, 120);
});

test("settings: every key is listed once with a section and a label", () => {
  const keys = SETTINGS.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const k of ["download_folder", "preview", "mermaid", "perf", "update_check", "node_path", "svg_check", ...NUMBERS.map((s) => s.key)]) assert.ok(keys.includes(k), k);
  for (const s of SETTINGS) assert.ok(s.label && s.section, s.key);
});

test("validateField: numbers must be whole and in range", () => {
  assert.deepEqual(validateField("list_per_folder", " 800 "), { value: 800 });
  assert.deepEqual(validateField("list_per_folder", "8e2"), { error: "Must be a whole number" });
  assert.deepEqual(validateField("list_per_folder", "-5"), { error: "Must be a whole number" });
  assert.deepEqual(validateField("list_per_folder", ""), { error: "Must be a whole number" });
  assert.deepEqual(validateField("list_per_folder", "1.5"), { error: "Must be a whole number" });
  assert.deepEqual(validateField("list_per_folder", "5"), { error: "Must be between 10 and 10,000" });
  assert.deepEqual(validateField("keep_done_seconds", "0"), { value: 0 });
  assert.deepEqual(validateField("ssh_connect_timeout", "15 -o ProxyCommand=x"), { error: "Must be a whole number" });
});

test("validateField: download folder must not be empty, node path is empty or absolute", () => {
  assert.deepEqual(validateField("download_folder", "  ~/Inbox "), { value: "~/Inbox" });
  assert.deepEqual(validateField("download_folder", "   "), { error: "Must not be empty" });
  assert.deepEqual(validateField("node_path", " "), { value: "" });
  assert.deepEqual(validateField("node_path", "/opt/node/bin/node"), { value: "/opt/node/bin/node" });
  assert.deepEqual(validateField("node_path", "node"), { error: "Must be an absolute path, or empty for automatic" });
  assert.deepEqual(validateField("node_path", "/a\nb"), { error: "Must be an absolute path, or empty for automatic" });
  assert.deepEqual(validateField("preview", true), { value: true });
  assert.deepEqual(validateField("preview", "yes"), { error: "Must be on or off" });
});

test("terminalProblem and guiProblem name the reason", () => {
  assert.equal(terminalProblem({ command: "nvim -u NONE" }), null);
  assert.equal(terminalProblem({ command: "  " }), "Command is required");
  assert.equal(terminalProblem({ command: "ed 'x" }), "Unbalanced quote");
  assert.equal(terminalProblem({ command: "nvim {path}" }), "Must not contain {path} (the path is appended)");
  assert.equal(guiProblem({ local: "ed {path}", remote: "" }), null);
  assert.equal(guiProblem({ local: "" }), "Local command is required");
  assert.equal(guiProblem({ local: "ed --new" }), "Local command needs {path} or {path_uri}");
  assert.equal(guiProblem({ local: "ed {target} {path}" }), "Local command must not use {target}");
  assert.equal(guiProblem({ local: "ed {path}", remote: "ed 'x" }), "Remote command: Unbalanced quote");
  assert.equal(guiProblem({ local: "ed {path}", remote: "ed --ssh {target}" }), "Remote command needs {path} or {path_uri}");
});

test("editorSlots: empty slots are dropped, each broken slot gets its reason, names must be unique, the choice must exist", () => {
  const ok = editorSlots("terminal", [{ name: " nvim ", command: "nvim -u NONE" }, { name: "", command: "" }], "nvim");
  assert.deepEqual(ok, { value: { list: [{ name: "nvim", command: "nvim -u NONE" }], choice: "nvim" }, errors: [null, null], choiceError: null });
  const bad = editorSlots("terminal", [{ name: "", command: "x" }, { name: "a", command: "a" }, { name: "a", command: "b" }, { name: "c", command: "c {path}" }], "zzz");
  assert.deepEqual(bad.errors, ["Name is required", null, "Duplicate name", "Must not contain {path} (the path is appended)"]);
  assert.equal(bad.choiceError, "Pick an editor from the list");
  assert.equal(bad.value, null);
  const shipped = editorSlots("gui", [{ name: "", local: "", remote: "" }], "Zed");
  assert.deepEqual(shipped, { value: { list: [], choice: "Zed" }, errors: [null], choiceError: null });
  const gui = editorSlots("gui", [{ name: "Mine", local: "m {path}", remote: " " }], "Mine");
  assert.deepEqual(gui.value, { list: [{ name: "Mine", local: "m {path}" }], choice: "Mine" });
  // A choice that names a broken own entry is refused too.
  assert.equal(editorSlots("gui", [{ name: "Mine", local: "m" }], "Mine").choiceError, "Pick an editor from the list");
});

test("changedEdits: only fields that differ from the values shown at open", () => {
  const initial = { list_total: 5000, preview: true, terminal_editors: [{ name: "a", command: "a" }] };
  assert.deepEqual(changedEdits(initial, { list_total: 5000, preview: false, terminal_editors: [{ name: "a", command: "a" }] }), { preview: false });
  assert.deepEqual(changedEdits(initial, { list_total: 6000, preview: true, terminal_editors: [] }), { list_total: 6000, terminal_editors: [] });
});

// A fake file: text, optional concurrent writers that change it right before our write.
function file(text, { racers = [] } = {}) {
  const f = { text, writes: [], reads: 0 };
  f.readTextFile = async () => { f.reads++; if (f.text === null) throw new Error("ENOENT"); return f.text; };
  f.writeTextFile = async (_path, next, expected) => {
    const racer = racers.shift();
    if (racer) f.text = racer(f.text);
    const current = f.text;
    if (expected === null ? current !== null : current !== expected) throw new Error("file changed");
    f.writes.push(next); f.text = next;
  };
  return f;
}
const io = (f) => ({ readTextFile: f.readTextFile, writeTextFile: f.writeTextFile, path: "/app/filer-pro.json" });

test("saveSettings: creates a missing file with expected null", async () => {
  const f = file(null);
  assert.deepEqual(await saveSettings({ list_total: 6000 }, io(f)), { ok: true });
  assert.deepEqual(JSON.parse(f.text), { list_total: 6000 });
  assert.ok(f.text.endsWith("\n"));
});

test("saveSettings: keeps unknown keys and every key it did not change", async () => {
  const f = file('{"my_key":{"x":1},"preview":false,"list_total":100}');
  assert.deepEqual(await saveSettings({ list_total: 6000 }, io(f)), { ok: true });
  assert.deepEqual(JSON.parse(f.text), { my_key: { x: 1 }, preview: false, list_total: 6000 });
});

test("saveSettings: a concurrent external edit is not lost (re-read and retry)", async () => {
  const f = file('{"preview":true}', { racers: [(t) => JSON.stringify({ ...JSON.parse(t), mermaid: false })] });
  assert.deepEqual(await saveSettings({ list_total: 6000 }, io(f)), { ok: true });
  assert.deepEqual(JSON.parse(f.text), { preview: true, mermaid: false, list_total: 6000 });
  assert.equal(f.writes.length, 1);
});

test("saveSettings: gives up after three tries, writes nothing", async () => {
  const bump = (t) => JSON.stringify({ n: (JSON.parse(t).n ?? 0) + 1 });
  const f = file("{}", { racers: [bump, bump, bump] });
  const out = await saveSettings({ list_total: 6000 }, io(f));
  assert.equal(out.ok, false);
  assert.match(out.error, /^Could not save: the file kept changing/);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(JSON.parse(f.text), { n: 3 });
});

test("saveSettings: a broken or non-object file is never overwritten", async () => {
  for (const text of ["{nope", "[1,2]", "null", '"x"']) {
    const f = file(text);
    const out = await saveSettings({ list_total: 6000 }, io(f));
    assert.deepEqual(out, { ok: false, error: "filer-pro.json is not a valid JSON object; fix or remove it first" }, text);
    assert.deepEqual(f.writes, []);
  }
});

test("saveSettings: a write that fails while the file stays the same reports the real error at once", async () => {
  const f = file("{}");
  let calls = 0;
  const out = await saveSettings({ list_total: 6000 }, { ...io(f), writeTextFile: async () => { calls++; throw new Error("Permission denied"); } });
  assert.deepEqual(out, { ok: false, error: "Could not save: Permission denied" });
  assert.equal(calls, 1);
});

test("saveSettings: nothing changed means no write", async () => {
  const f = file("{}");
  assert.deepEqual(await saveSettings({}, io(f)), { ok: true });
  assert.equal(f.reads, 0);
});
