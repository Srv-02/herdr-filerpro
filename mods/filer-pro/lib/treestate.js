// The state of one file tree (the upper one that follows the terminal, the lower one pinned to this computer) and
// the shared state of the lower tree (issue #101). Pure.

// The fields of the view that belong to one tree. main.js exposes the upper tree's through accessors on the view.
// selected, anchor, base and selecting are the selection (lib/selection.js): per tree.
export const TREE_FIELDS = Object.freeze(["context", "root", "on", "entries", "realFolders", "fileReal", "folders", "packages", "pending", "marks", "watched", "gitWatch", "error", "limited", "loading", "again", "lastOpened", "fileWanted", "fileForce", "selected", "anchor", "base", "selecting"]);

export const LOCAL_TREE_KEY = "filer-pro.localtree";
export const MIN_TREE_PX = 120;
export const DEFAULT_SPLIT = 0.6;
// The location line above each tree of the split (#101): one set of sizes for both lines (height, side padding, gap, text,
// glyph and hit area of its small buttons).
export const LINE = Object.freeze({ height: 26, padX: 14, gap: 6, text: 12, icon: 12, hit: 20 });

export function createTree(id) {
  return {
    id, context: null, root: null, on: null, entries: new Map(), realFolders: new Map(), fileReal: null, folders: new Set(), packages: new Set(),
    pending: new Set(), marks: {}, watched: null, gitWatch: null, error: null, limited: false, loading: false, again: false, lastOpened: null,
    fileWanted: 0, fileForce: false, selected: new Set(), anchor: null, base: null, selecting: false,
  };
}

// The context of the lower tree: fixed (the focus never changes it), always this computer, keyed by its root.
export function pinnedContext(root) {
  return { key: "pinned:" + root, cwd: root, on: null, fixed: true, tree: "pinned" };
}

const sizesOf = (v) => (Array.isArray(v) && v.length === 2 && v.every((n) => Number.isFinite(n) && n > 0) ? [v[0], v[1]] : null);

// seed: the start folder (setting) the root was last taken from; a changed setting resets the root (syncPinned).
// raw: the shared value, anything. Wrong types give the defaults.
export function readLocalTree(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return { shown: r.shown === true, root: typeof r.root === "string" && r.root.startsWith("/") ? r.root : null, sizes: sizesOf(r.sizes), seed: typeof r.seed === "string" && r.seed !== "" ? r.seed : null };
}

// The state with patch merged in; the same reference when nothing changes, so a caller skips setShared.
export function writeLocalTree(state, patch) {
  const next = readLocalTree({ ...state, ...patch });
  const same = next.shown === state.shown && next.root === state.root && next.seed === state.seed && (next.sizes === state.sizes || (next.sizes && state.sizes && next.sizes[0] === state.sizes[0] && next.sizes[1] === state.sizes[1]));
  return same ? state : next;
}

// The folder the lower tree opens in; both settings are expanded by loadConfig.
export function startFolder(cfg) {
  return cfg?.local_tree_folder || cfg?.download_folder || null;
}
