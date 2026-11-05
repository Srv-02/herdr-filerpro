// Editors for the row menu entries "Edit in Terminal" and "Open in Editor". Pure: main.js runs the result.
// Commands and templates are split into argv words here, without a shell, and the path is always one whole
// argv element: it is never parsed by a shell, so spaces, quotes, $, backticks and newlines are just characters.

import { parentOf } from "./names.js";
import { cleanText } from "./errors.js";
import { sshTarget } from "./machines.js";

// Shipped terminal editors (config `terminal_editor` picks one by name; `terminal_editors` adds own ones).
export const TERMINAL_EDITORS = Object.freeze([
  { name: "vi", command: "vi" },
  { name: "vim", command: "vim" },
  { name: "nano", command: "nano" },
  { name: "micro", command: "micro" },
  { name: "fresh", command: "fresh" },
  { name: "helix", command: "hx" },
].map((e) => Object.freeze(e)));
export const DEFAULT_TERMINAL_EDITOR = "vi";

// Shipped GUI editors (config `gui_editor`, `gui_editors`). `local` opens a file on this computer, `remote` a
// file on an SSH machine through the editor's own remote mode. VS Code and Cursor get a vscode-remote file URI
// (--file-uri opens a file; --remote with a path expects a folder), Zed an ssh:// URL. Both need the encoded path.
export const GUI_EDITORS = Object.freeze([
  { name: "VS Code", local: "code {path}", remote: "code --file-uri vscode-remote://ssh-remote+{target}{path_uri}" },
  { name: "Cursor", local: "cursor {path}", remote: "cursor --file-uri vscode-remote://ssh-remote+{target}{path_uri}" },
  { name: "Zed", local: "zed {path}", remote: "zed ssh://{target}{path_uri}" },
].map((e) => Object.freeze(e)));
export const DEFAULT_GUI_EDITOR = "VS Code";

// "nvim -u NONE" -> ["nvim", "-u", "NONE"]. Whitespace separates words; '...' and "..." group (quotes are
// removed, there are no escapes). Empty text, an unbalanced quote or a non-string gives null.
export function splitCommand(text) {
  if (typeof text !== "string") return null;
  const words = [];
  let word = null, quote = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === "'" || ch === "\"") {
      quote = ch; word ??= "";
    } else if (/\s/.test(ch)) {
      if (word !== null) { words.push(word); word = null; }
    } else word = (word ?? "") + ch;
  }
  if (quote) return null;
  if (word !== null) words.push(word);
  return words.length ? words : null;
}

// Absolute path as a URI path: every segment UTF-8 percent-encoded, everything but RFC 3986 unreserved
// characters (A-Z a-z 0-9 - . _ ~) encoded; the slashes stay.
export const pathUri = (path) => path.split("/").map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");

// Substitutes {path}, {path_uri} and {target} in each argv word, in one pass: a substituted value is never
// expanded again. Unknown {names} stay as they are.
export function expandTemplate(words, vars) {
  return words.map((w) => w.replace(/\{(path|path_uri|target)\}/g, (_m, k) => vars[k] ?? ""));
}

// argv for a terminal editor: its words, then the path as its own element. A relative path starting with "-"
// gets "./" so it is never read as an option (the menu always passes absolute paths). null: unusable command.
export function terminalArgv(command, path) {
  const words = splitCommand(command);
  if (!words) return null;
  return [...words, path.startsWith("-") ? `./${path}` : path];
}

// argv for a GUI editor entry: target null means a local file (template `local`), else `remote` with the SSH target.
// A target with whitespace or "/" (e.g. a whole "ssh ..." line) cannot stand in a URI authority: refused.
export function guiArgv(entry, { path, target }) {
  if (target != null && (target === "" || /[\s/]/.test(target))) return { error: `Unusable SSH target for ${entry.name}: ${JSON.stringify(target)}` };
  const template = target == null ? entry.local : entry.remote;
  if (typeof template !== "string") return { error: `${entry.name} has no remote template; set "remote" for it in filer-pro.json` };
  const words = splitCommand(template);
  if (!words) return { error: `${entry.name}: the command template is empty or has an unbalanced quote` };
  return { argv: expandTemplate(words, { path, path_uri: pathUri(path), target: target ?? "" }) };
}

// The entry for a chosen name: own entries (config) first, so an own entry can replace a shipped one by name;
// then the shipped list; else the default (config.js already checked the name, this is the safety net).
export function pickEditor(name, own, shipped, fallback) {
  const all = [...(Array.isArray(own) ? own : []), ...shipped];
  return all.find((e) => e.name === name) ?? all.find((e) => e.name === fallback);
}

const machineOf = (m) => (typeof m === "string" && m !== "" ? m : null);

// Where "Edit in Terminal" starts the editor: host commands for run(), tried in order until one does not fail.
// Only the active space counts, and only when it is on the row's machine (null = this computer): its splits and
// tabs run there, so the editor starts on the file's machine. A focused terminal pane gets a split to the
// right (terminal.open fails with place right while no pane is focused, e.g. a layout terminal or a mod
// pane); a new tab in the active space is the fallback. Empty: no safe place (the caller shows a notice).
export function terminalPlan({ focused, spaces, machine, argv, folder }) {
  const active = Array.isArray(spaces) ? spaces.find((s) => s && s.active) : null;
  if (!active || machineOf(active.machine) !== machineOf(machine)) return [];
  const tab = ["tab.new", { space: active.id, folder, argv }];
  return focused?.pane != null ? [["terminal.open", { argv, folder, place: "right" }], tab] : [tab];
}

const message = (e) => String(e?.message ?? e);
const timedOut = (e) => /time[d ]*-?\s*out/i.test(message(e));

// "Edit in Terminal": the editor from the config, the path as its own argv word, started by the host in a new
// terminal on the file's machine (see terminalPlan). No check whether the editor exists: a missing one shows
// the shell's "not found" in the new terminal. deps: loadConfig, focused, spaces, run, notify.
export async function editInTerminal({ machine, path }, { loadConfig, focused, spaces, run, notify }) {
  const title = "Edit in Terminal";
  const cfg = await loadConfig();
  const editor = pickEditor(cfg.terminal_editor, cfg.terminal_editors, TERMINAL_EDITORS, DEFAULT_TERMINAL_EDITOR);
  const argv = terminalArgv(editor.command, path);
  if (!argv) { notify({ title: `${title} failed`, body: `Unusable command for ${editor.name}`, level: "error" }); return; }
  const plan = terminalPlan({ focused: focused(), spaces: spaces(), machine, argv, folder: parentOf(path) || "/" });
  if (!plan.length) {
    notify({ title, body: `Switch to a space on ${machine || "this computer"} to edit this file there.`, level: "info" });
    return;
  }
  let last = null;
  for (const [cmd, args] of plan) {
    try { await run(cmd, args); return; } catch (e) { last = e; }
  }
  notify({ title: `${title} failed`, body: message(last), level: "error" });
}

// Folders a GUI app's PATH often lacks, where the editors install their command line tools.
const cliDirs = (home) => ["/opt/homebrew/bin", "/usr/local/bin", `${home}/.local/bin`];

// "Open in Editor": the GUI editor from the config, always started on this computer; a file on a machine opens
// through the editor's remote mode with the SSH target from `hc machine ls --json`. No check whether the editor
// exists: a failure shows the exec error. deps: loadConfig, hc, exec, notify, home.
export async function openInEditor({ machine, path }, { loadConfig, hc, exec, notify, home }) {
  const fail = (body) => notify({ title: "Open in Editor failed", body, level: "error" });
  const cfg = await loadConfig();
  const editor = pickEditor(cfg.gui_editor, cfg.gui_editors, GUI_EDITORS, DEFAULT_GUI_EDITOR);
  let target = null;
  if (machine) {
    let t;
    try {
      const r = await hc(["machine", "ls", "--json"]);
      t = sshTarget(r && r.code === 0 ? r.stdout : "", machine);
    } catch (e) { fail(message(e)); return; }
    if (t.error) { fail(t.error); return; }
    target = t.target;
  }
  const built = guiArgv(editor, { path, target });
  if (built.error) { fail(built.error); return; }
  const [cmd, ...args] = built.argv;
  // A bare command that cannot be spawned is tried again in the usual CLI folders (only then: no pre-check).
  const order = cmd.includes("/") ? [cmd] : [cmd, ...cliDirs(home()).map((d) => `${d}/${cmd}`)];
  let first = null;
  for (const c of order) {
    let r;
    try { r = await exec(c, args, { on: null }); } catch (e) {
      first ??= e;
      if (timedOut(e)) break;
      continue;
    }
    if (r?.code !== 0) fail(cleanText(r?.stderr) || `${cmd} exited with ${r?.code}`);
    return;
  }
  fail(message(first));
}
