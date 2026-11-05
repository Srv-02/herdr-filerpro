import { splitCommand, TERMINAL_EDITORS, GUI_EDITORS, DEFAULT_TERMINAL_EDITOR, DEFAULT_GUI_EDITOR } from "./editors.js";

// Config: appHome()/filer-pro.json. Keys: download_folder, preview, mermaid, perf, update_check, terminal_editor,
// terminal_editors, gui_editor, gui_editors. A missing or broken file, or a value of the wrong type, means the default.

const trimmed = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

// Own entries, each checked alone: a broken one is dropped, the others stay; the first of a name wins.
function entries(list, check) {
  if (!Array.isArray(list)) return [];
  const out = [], seen = new Set();
  for (const raw of list) {
    const name = raw && typeof raw === "object" ? trimmed(raw.name) : null;
    const entry = name == null || seen.has(name) ? null : check(raw, name);
    if (entry) { seen.add(name); out.push(entry); }
  }
  return out;
}

// terminal_editors: [{ name, command }]; command: the program and its own arguments, split without a shell.
// The path is always appended as its own word, so a command with {path} is refused (it would get the file twice).
const terminalEntry = (raw, name) => (typeof raw.command === "string" && splitCommand(raw.command) && !raw.command.includes("{path}") ? { name, command: raw.command.trim() } : null);

// gui_editors: [{ name, local, remote? }]; each template needs {path} or {path_uri}; local must not use {target}
// (a local file has none); a missing or broken remote is null (this editor then cannot open files on a machine).
function guiEntry(raw, name) {
  const usable = (t) => typeof t === "string" && splitCommand(t) != null && /\{path(_uri)?\}/.test(t);
  if (!usable(raw.local) || raw.local.includes("{target}")) return null;
  return { name, local: raw.local.trim(), remote: usable(raw.remote) ? raw.remote.trim() : null };
}

// The chosen name if a shipped or own entry has it, else the default.
function choice(value, own, shipped, fallback) {
  const name = trimmed(value);
  return name != null && (own.some((e) => e.name === name) || shipped.some((e) => e.name === name)) ? name : fallback;
}

function editors(cfg) {
  const terminal_editors = entries(cfg?.terminal_editors, terminalEntry), gui_editors = entries(cfg?.gui_editors, guiEntry);
  return {
    terminal_editor: choice(cfg?.terminal_editor, terminal_editors, TERMINAL_EDITORS, DEFAULT_TERMINAL_EDITOR), terminal_editors,
    gui_editor: choice(cfg?.gui_editor, gui_editors, GUI_EDITORS, DEFAULT_GUI_EDITOR), gui_editors,
  };
}

export async function loadConfig(readTextFile, appHome, home) {
  const fallback = `${home()}/Downloads`;
  let folder = null, cfg = null;
  try {
    const text = await readTextFile(`${appHome()}/filer-pro.json`);
    cfg = text == null ? null : JSON.parse(text);
    if (cfg && typeof cfg.download_folder === "string" && cfg.download_folder.trim() !== "") folder = cfg.download_folder.trim();
  } catch {
    folder = null; cfg = null;
  }
  const flag = (key, fallbackValue) => (cfg && typeof cfg[key] === "boolean" ? cfg[key] : fallbackValue);
  const flags = { preview: flag("preview", true), mermaid: flag("mermaid", true), perf: flag("perf", false), update_check: flag("update_check", true), ...editors(cfg) };
  if (folder == null) return { download_folder: fallback, ...flags };
  if (folder === "~" || folder.startsWith("~/")) folder = home() + folder.slice(1);
  return { download_folder: folder, ...flags };
}
