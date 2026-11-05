// Every user-facing setting of appHome()/filer-pro.json in one place: kind, default, range, label, section. Pure.
// lib/config.js reads with it (wrong type: default, integer out of range: clamped), ui/settings.js shows and checks
// with it, and saveSettings writes the changed keys back without touching anything else in the file.
import { splitCommand, TERMINAL_EDITORS, GUI_EDITORS } from "./editors.js";

const int = (key, def, min, max, label, section, unit = "") => ({ key, kind: "int", default: def, min, max, label, section, unit });
const bool = (key, def, label, section) => ({ key, kind: "bool", default: def, label, section });

// Numbers: whole numbers in units a person types (MB, seconds); the code converts where it uses them.
// Defaults are the values the mod had as constants before they became settings.
export const NUMBERS = Object.freeze([
  int("list_per_folder", 500, 10, 10000, "Entries per folder", "File list"),
  int("list_total", 5000, 100, 20000, "Entries in total", "File list"),
  int("tree_depth", 40, 1, 200, "Folder depth", "File list", "levels"),
  int("refresh_seconds", 10, 2, 3600, "Refresh every", "File list", "s"),
  int("source_max_chars", 400000, 10000, 5000000, "Source view shows at most", "Preview", "characters"),
  int("preview_max_chars", 200000, 10000, 2000000, "Preview shows at most", "Preview", "characters"),
  int("image_max_mb", 20, 1, 500, "Largest image", "Preview", "MB"),
  int("image_cache_mb", 50, 10, 5000, "Image cache", "Preview", "MB"),
  int("pdf_local_max_mb", 100, 1, 2000, "Largest PDF on this computer", "Preview", "MB"),
  int("pdf_remote_max_mb", 20, 1, 500, "Largest PDF on a machine", "Preview", "MB"),
  int("max_diagrams", 20, 1, 100, "Mermaid diagrams per file", "Preview"),
  int("max_diagram_chars", 20000, 1000, 200000, "Characters per diagram", "Preview"),
  int("ssh_connect_timeout", 15, 1, 300, "SSH ConnectTimeout", "Transfers", "s"),
  int("ssh_alive_interval", 15, 1, 300, "SSH ServerAliveInterval", "Transfers", "s"),
  int("ssh_alive_count", 4, 1, 100, "SSH ServerAliveCountMax", "Transfers"),
  int("stall_seconds", 120, 10, 3600, "A transfer is stalled after", "Transfers", "s"),
  int("keep_done_seconds", 10, 0, 3600, "Finished transfers stay visible for", "Transfers", "s"),
].map((s) => Object.freeze(s)));

export const SETTINGS = Object.freeze([
  Object.freeze({ key: "download_folder", kind: "text", default: "~/Downloads", label: "Download folder", section: "General" }),
  bool("preview", true, "Preview Markdown, HTML, images and PDFs", "General"),
  bool("mermaid", true, "Draw Mermaid diagrams", "General"),
  bool("update_check", true, "Check for updates once a day", "General"),
  bool("perf", false, "Write render timings (perf.jsonl; takes effect after a restart)", "General"),
  Object.freeze({ key: "node_path", kind: "path", default: "", label: "Node for Mermaid (empty: automatic)", section: "Preview" }),
  ...NUMBERS,
  bool("svg_check", true, "Check SVG files before drawing them (recommended)", "Security"),
]);

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));
const fmt = (n) => n.toLocaleString("en-US");

// The numeric settings of a parsed config (null: all defaults). A wrong type or a fraction gives the default,
// a whole number out of range the nearest bound.
export function numbers(cfg) {
  const out = {};
  for (const s of NUMBERS) {
    const v = cfg?.[s.key];
    out[s.key] = Number.isInteger(v) ? Math.min(s.max, Math.max(s.min, v)) : s.default;
  }
  return out;
}

// One field of the dialog: { value } or { error }. Numbers come as text, switches as booleans.
export function validateField(key, input) {
  const s = BY_KEY.get(key);
  if (!s) return { error: "Unknown setting" };
  if (s.kind === "bool") return typeof input === "boolean" ? { value: input } : { error: "Must be on or off" };
  const text = typeof input === "string" ? input.trim() : "";
  if (s.kind === "int") {
    if (!/^\d+$/.test(text)) return { error: "Must be a whole number" };
    const n = Number(text);
    return n >= s.min && n <= s.max ? { value: n } : { error: `Must be between ${fmt(s.min)} and ${fmt(s.max)}` };
  }
  if (s.kind === "path") {
    if (text === "") return { value: "" };
    return text.startsWith("/") && !/[\0\n\r]/.test(text) ? { value: text } : { error: "Must be an absolute path, or empty for automatic" };
  }
  return text === "" ? { error: "Must not be empty" } : { value: text };
}

const hasPath = (t) => /\{path(_uri)?\}/.test(t);
const filled = (v) => typeof v === "string" && v.trim() !== "";

// Why an own terminal editor { command } cannot be used, or null. The path is always appended as its own word.
export function terminalProblem(raw) {
  if (!filled(raw?.command)) return "Command is required";
  if (!splitCommand(raw.command)) return "Unbalanced quote";
  if (raw.command.includes("{path}")) return "Must not contain {path} (the path is appended)";
  return null;
}

// Why an own GUI editor { local, remote? } cannot be used, or null. An empty remote is fine (no remote files then);
// lib/config.js drops a broken remote alone, the dialog refuses it so nothing typed is lost silently.
export function guiProblem(raw) {
  if (!filled(raw?.local)) return "Local command is required";
  if (!splitCommand(raw.local)) return "Local command: Unbalanced quote";
  if (!hasPath(raw.local)) return "Local command needs {path} or {path_uri}";
  if (raw.local.includes("{target}")) return "Local command must not use {target}";
  return remoteProblem(raw.remote);
}

export function remoteProblem(remote) {
  if (!filled(remote)) return null;
  if (!splitCommand(remote)) return "Remote command: Unbalanced quote";
  return hasPath(remote) ? null : "Remote command needs {path} or {path_uri}";
}

// The editor slots of the dialog: kind "terminal" ({ name, command }) or "gui" ({ name, local, remote }).
// -> { value: { list, choice } | null, errors: [reason | null per slot], choiceError }. A slot with every field empty is dropped.
export function editorSlots(kind, slots, choice) {
  const fields = kind === "terminal" ? ["name", "command"] : ["name", "local", "remote"];
  const shipped = kind === "terminal" ? TERMINAL_EDITORS : GUI_EDITORS;
  const list = [], errors = [], seen = new Set();
  for (const slot of slots) {
    if (fields.every((f) => !filled(slot[f]))) { errors.push(null); continue; }
    const name = filled(slot.name) ? slot.name.trim() : null;
    const problem = name == null ? "Name is required" : seen.has(name) ? "Duplicate name" : kind === "terminal" ? terminalProblem(slot) : guiProblem(slot);
    errors.push(problem);
    if (name != null) seen.add(name);
    if (problem) continue;
    list.push(kind === "terminal" ? { name, command: slot.command.trim() } : { name, local: slot.local.trim(), ...(filled(slot.remote) ? { remote: slot.remote.trim() } : {}) });
  }
  const pick = typeof choice === "string" ? choice.trim() : "";
  const choiceError = list.some((e) => e.name === pick) || (!seen.has(pick) && shipped.some((e) => e.name === pick)) ? null : "Pick an editor from the list";
  const bad = errors.some(Boolean) || choiceError;
  return { value: bad ? null : { list, choice: pick }, errors, choiceError };
}

// The keys whose value differs from the one shown when the dialog opened (deep, by JSON). Only these are written,
// so a key someone else changed in the file meanwhile keeps their value.
export function changedEdits(initial, current) {
  const out = {};
  for (const [k, v] of Object.entries(current)) if (JSON.stringify(v) !== JSON.stringify(initial[k])) out[k] = v;
  return out;
}

// Read-modify-write of the config file: re-read, apply `edits` (key -> value) onto the parsed object, write only if the
// file is still what was read (writeTextFile's `expected`; null: only if it does not exist), else read again. A file
// that is not a JSON object is never overwritten. -> { ok: true } or { ok: false, error }.
export async function saveSettings(edits, { readTextFile, writeTextFile, path, tries = 3 }) {
  if (!Object.keys(edits).length) return { ok: true };
  // A file that cannot be read counts as missing: the write then only creates it (expected null), never overwrites it.
  const read = async () => { try { return (await readTextFile(path)) ?? null; } catch { return null; } };
  let last = null;
  for (let i = 0; i < tries; i++) {
    const text = await read();
    let obj;
    try { obj = text === null ? {} : JSON.parse(text); } catch { obj = null; }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, error: "filer-pro.json is not a valid JSON object; fix or remove it first" };
    const next = JSON.stringify({ ...obj, ...edits }, null, 2) + "\n";
    try {
      await writeTextFile(path, next, text);
      return { ok: true };
    } catch (e) { last = String(e?.message ?? e); }
    // Only a file that changed in between is worth another try; anything else (no permission, ...) is the answer.
    if ((await read()) === text) return { ok: false, error: `Could not save: ${last}` };
  }
  return { ok: false, error: `Could not save: the file kept changing (${last})` };
}
