// Every setting of the dialog in one place: kind, default, range, label, help line, section and unit. Pure.
// lib/config.js reads with it (wrong type: default, integer out of range: clamped), ui/settings.js shows and checks
// with it, and saveSettings writes the changed keys back without touching anything else in the file. Not listed:
// the editor lists (config file only) and perf (a developer switch, config file only); lib/config.js reads both.
import { splitCommand } from "./editors.js";
import { group } from "./numbers.js";

const int = (key, def, min, max, label, help, section, unit) => ({ key, kind: "int", default: def, min, max, label, help, section, unit });
const bool = (key, def, label, help, section) => ({ key, kind: "bool", default: def, label, help, section });

// ui/settings.js takes group from here, with the rest of the dialog's helpers.
export { group };

// The Advanced part of the dialog, in this order.
export const ADVANCED = Object.freeze(["File list limits", "Preview limits", "Transfers & connections"]);

// Numbers: whole numbers in units a person types (MB, seconds); the code converts where it uses them.
// Defaults are the values the mod had as constants before they became settings.
export const NUMBERS = Object.freeze([
  int("list_per_folder", 500, 10, 10000, "Files shown per folder", "Bigger folders are cut off with a note.", "File list limits", "files"),
  int("list_total", 5000, 100, 20000, "Files shown in total", "Across all open folders together.", "File list limits", "files"),
  int("tree_depth", 40, 1, 200, "Deepest folder level", "Folders nested deeper than this are not listed.", "File list limits", "levels"),
  int("refresh_seconds", 10, 2, 3600, "Look for changes every", "The list also updates right after your own actions.", "File list limits", "seconds"),
  int("preview_max_chars", 200000, 10000, 2000000, "Longest formatted preview", "Longer Markdown and HTML files are cut off.", "Preview limits", "characters"),
  int("source_max_chars", 400000, 10000, 5000000, "Longest plain text view", "Longer text is cut off.", "Preview limits", "characters"),
  int("image_max_mb", 20, 1, 500, "Show images right away up to", "Bigger images show a Load button first.", "Preview limits", "MB"),
  int("pdf_local_max_mb", 100, 1, 2000, "Show PDFs on this Mac right away up to", "Bigger PDFs show a Load button first.", "Preview limits", "MB"),
  int("pdf_remote_max_mb", 20, 1, 500, "Show PDFs on SSH machines right away up to", "Bigger PDFs show a Load button first. They have to be copied over the network.", "Preview limits", "MB"),
  int("image_cache_mb", 50, 10, 5000, "Disk space for the image cache", "Images and PDF pages are kept here so they open faster next time.", "Preview limits", "MB"),
  int("max_diagrams", 20, 1, 100, "Diagrams per file", "Diagrams after this number stay as code.", "Preview limits", "diagrams"),
  int("max_diagram_chars", 20000, 1000, 200000, "Largest diagram", "Bigger diagrams stay as code.", "Preview limits", "characters"),
  int("ssh_connect_timeout", 15, 1, 300, "Give up connecting after", "How long to wait for an SSH machine to answer, for transfers and previews.", "Transfers & connections", "seconds"),
  int("ssh_alive_interval", 15, 1, 300, "Check the connection every", "Keeps long transfers and preview downloads from being dropped by routers.", "Transfers & connections", "seconds"),
  int("ssh_alive_count", 4, 1, 100, "Drop the connection after", "Missed checks in a row before a transfer or preview download counts as disconnected.", "Transfers & connections", "missed checks"),
  int("stall_seconds", 120, 10, 3600, "Stop a stuck transfer after", "A transfer that makes no progress this long is stopped.", "Transfers & connections", "seconds"),
  int("keep_done_seconds", 10, 0, 3600, "Keep finished transfers visible for", "Set to 0 to hide them right away.", "Transfers & connections", "seconds"),
].map((s) => Object.freeze(s)));

export const SETTINGS = Object.freeze([
  bool("update_check", true, "Check for updates automatically", "Once a day, Filer Pro asks GitHub whether a new version exists. Nothing about you or your files is sent, but GitHub sees your IP address.", "Updates"),
  Object.freeze({ key: "download_folder", kind: "text", default: "~/Downloads", label: "Download folder", help: "Where Download and Download to… put files.", section: "Downloads" }),
  bool("double_click_files", false, "Open files with a double click", "A single click only marks a file. Folders still open with a single click.", "File list"),
  bool("double_click_apps", true, "Open apps with a double click", "Apps, installers and other packages on this Mac. A double click keeps a downloaded app from starting by accident.", "File list"),
  bool("preview", true, "Show previews", "Markdown, HTML, images and PDFs open formatted. Turn off to always see the raw text.", "Preview"),
  bool("mermaid", true, "Draw diagrams", "Turns Mermaid code in Markdown files into diagrams. Needs Node.js.", "Preview"),
  bool("svg_check", true, "Check SVG images before showing them", "Recommended. Blocks SVG files that try to load content from the internet.", "Security"),
  ...NUMBERS,
  Object.freeze({ key: "node_path", kind: "path", default: "", label: "Node.js for diagrams", help: "Leave empty to find Node.js automatically. Otherwise the full path, for example /opt/homebrew/bin/node.", section: "Preview limits" }),
]);

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

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
    if (!/^\d+$/.test(text)) return { error: "Enter a whole number." };
    const n = Number(text);
    return n >= s.min && n <= s.max ? { value: n } : { error: `Enter a number from ${group(s.min)} to ${group(s.max)}.` };
  }
  if (s.kind === "path") {
    if (text === "") return { value: "" };
    return text.startsWith("/") && !/[\0\n\r]/.test(text) ? { value: text } : { error: "Enter a full path that starts with /, or leave it empty." };
  }
  return text === "" ? { error: "Enter a folder." } : { value: text };
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

// The keys whose value differs from the one shown when the dialog opened (deep, by JSON). Only these are written,
// so a key someone else changed in the file meanwhile keeps their value.
export function changedEdits(initial, current) {
  const out = {};
  for (const [k, v] of Object.entries(current)) if (JSON.stringify(v) !== JSON.stringify(initial[k])) out[k] = v;
  return out;
}

// Read-modify-write of the config file: re-read, apply `edits` (key -> value) onto the parsed object, write only if the
// file is still what was read (writeTextFile's `expected`; null: only if it does not exist), else read again. A file
// that is not a JSON object is never overwritten. -> { ok: true } or { ok: false, error, broken? } (broken: not a JSON object).
export async function saveSettings(edits, { readTextFile, writeTextFile, path, tries = 3 }) {
  if (!Object.keys(edits).length) return { ok: true };
  // A file that cannot be read counts as missing: the write then only creates it (expected null), never overwrites it.
  const read = async () => { try { return (await readTextFile(path)) ?? null; } catch { return null; } };
  let last = null;
  for (let i = 0; i < tries; i++) {
    const text = await read();
    let obj;
    try { obj = text === null ? {} : JSON.parse(text); } catch { obj = null; }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, broken: true, error: "filer-pro.json is not a valid JSON object; fix or remove it first" };
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
