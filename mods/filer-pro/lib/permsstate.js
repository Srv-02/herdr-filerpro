// The state behind the Permissions dialog (issue #23). Pure: ui/permsdialog.js draws it, main.js runs the commands.
// The checkboxes and the octal text always describe the same mode; a text that is not valid octal keeps the last good
// mode and blocks Apply until it is fixed or a checkbox replaces it.
import { parseOctal, formatOctal, formatChange, getBit, setBit, modeWarnings } from "./perms.js";

export const NOT_OWNER = "Not the owner, permissions cannot be changed";
export const LINK_NOTE = "This is a symbolic link. The permissions of its target are shown; links are never changed.";

export function createPermsState({ name, isDir }) {
  return { phase: "loading", name, isDir: isDir === true, stage: "edit", recursive: false, mode: 0, original: 0, text: "", textError: null, readOnly: null, error: null, busy: false, count: null, owner: "", group: "", ids: "" };
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
  return state;
}

export function setText(state, text) {
  if (!editable(state)) return state;
  state.text = text;
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

// What the confirmation dialog shows. count: the entries inside for a recursive apply (null: unknown).
export function review(state, count) {
  return {
    change: formatChange(state.original, state.mode),
    warnings: modeWarnings({ oldMode: state.original, newMode: state.mode, isDir: state.isDir, recursive: state.recursive, count }),
  };
}
