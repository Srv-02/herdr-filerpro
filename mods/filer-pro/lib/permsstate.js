// The state behind the Permissions dialog (issue #23). Pure: ui/permsdialog.js draws it, main.js runs the commands.
// There is no confirmation step: Apply writes at once, so everything worth knowing before is in notes(), shown live under
// the fields.
// The checkboxes and the octal text always describe the same mode; a text that is not valid octal keeps the last good
// mode and blocks Apply until it is fixed or a checkbox replaces it.
import { parseOctal, formatOctal, formatChange, getBit, setBit, modeWarnings, insideText } from "./perms.js";

export const NOT_OWNER = "Not the owner, permissions cannot be changed";
export const LINK_NOTE = "This is a symbolic link. The permissions of its target are shown; links are never changed.";

export function createPermsState({ name, isDir }) {
  return { phase: "loading", name, isDir: isDir === true, recursive: false, mode: 0, original: 0, text: "", textError: null, readOnly: null, error: null, busy: false, count: null, counting: false, counted: false, owner: "", group: "", ids: "" };
}

// Why nothing can be changed, or null. A link wins over the owner check.
export function readOnlyReason(probe) {
  if (probe.isLink) return LINK_NOTE;
  return probe.owned ? null : NOT_OWNER;
}

export function loaded(state, probe) {
  Object.assign(state, {
    phase: "ready", isDir: probe.isDir, mode: probe.mode, original: probe.mode, text: formatOctal(probe.mode), textError: null,
    readOnly: readOnlyReason(probe), owner: probe.user, group: probe.group, ids: `${probe.uid}:${probe.gid}`,
  });
  return state;
}

export function failed(state, error) {
  Object.assign(state, { phase: "error", error });
  return state;
}

const editable = (s) => s.phase === "ready" && !s.readOnly && !s.busy;

export function toggleBit(state, who, what) {
  if (!editable(state)) return state;
  state.mode = setBit(state.mode, who, what, !getBit(state.mode, who, what));
  state.text = formatOctal(state.mode);
  state.textError = null;
  state.error = null; // an edit replaces the message of a refused apply
  return state;
}

export function setText(state, text) {
  if (!editable(state)) return state;
  state.text = text;
  state.error = null;
  const r = parseOctal(text);
  if (r.ok) { state.mode = r.mode; state.textError = null; } else state.textError = r.error;
  return state;
}

export function setRecursive(state, on) {
  if (editable(state) && state.isDir) state.recursive = on === true;
  return state;
}

export function canApply(state) {
  return editable(state) && state.textError === null && (state.mode !== state.original || state.recursive);
}

// The recursive count arrived (null: could not be told).
export function counted(state, count) {
  Object.assign(state, { count, counting: false, counted: true });
  return state;
}

// Whether ticking "Apply to enclosed items" has to start the count: once per dialog.
export const needsCount = (state) => state.recursive && !state.counted && !state.counting;

// The lines under the fields, in order: what blocks (load error, apply error, read only, bad octal text), the warnings
// of the edited mode, the recursive count. level: error | note | warning | info | ok. Never empty: without anything to
// say it names the change (or that there is none), so the area keeps its place and reads as a summary.
export function notes(state) {
  if (state.phase === "loading") return [{ level: "info", text: "Reading permissions…" }];
  if (state.phase === "error") return [{ level: "error", text: state.error }];
  const out = [];
  if (state.error) out.push({ level: "error", text: state.error });
  if (state.readOnly) return [...out, { level: "note", text: state.readOnly }];
  if (state.textError) out.push({ level: "error", text: state.textError });
  for (const text of modeWarnings({ oldMode: state.original, newMode: state.mode, isDir: state.isDir, recursive: state.recursive })) out.push({ level: "warning", text });
  if (state.recursive) out.push({ level: "info", text: insideText(state.count, state.counting) });
  if (out.length) return out;
  return [state.mode === state.original ? { level: "info", text: "No changes." } : { level: "ok", text: `${formatChange(state.original, state.mode)}, no warnings.` }];
}
