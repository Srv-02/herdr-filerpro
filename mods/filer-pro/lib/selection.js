// Which tree rows are selected (issue #98). Pure. Paths are relative to the tree root and "/"-separated.
// State: selected (Set), anchor (the last toggled row, start of a range) and base (the selection at the last toggle,
// so a range adds to the toggled rows and moving its end never loses them).

const parent = (path) => {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
};

export function toggle(set, path) {
  const next = new Set(set);
  if (!next.delete(path)) next.add(path);
  return next;
}

// order: the visible rows top to bottom. Inclusive; just the clicked path when either end is not in order.
export function range(order, anchor, path) {
  const a = order.indexOf(anchor);
  const b = order.indexOf(path);
  if (a < 0 || b < 0) return [path];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

export function clearSelection() {
  return { selected: new Set(), anchor: null, base: null };
}

// kind: "toggle" or "range". A range without a usable anchor (none, or hidden by a collapse) acts as a toggle.
// base is cut to order so paths that were pruned or collapsed away never come back.
export function applyClick(state, kind, path, order) {
  const { selected, anchor, base } = state;
  if (kind === "range" && anchor != null && order.includes(anchor)) {
    const kept = [...(base ?? [])].filter((p) => order.includes(p));
    return { selected: new Set([...kept, ...range(order, anchor, path)]), anchor, base };
  }
  const next = toggle(selected, path);
  return { selected: next, anchor: path, base: next };
}

// Drops every path that has an ancestor in the list, so a folder stands for what is inside it. Keeps input order.
export function collapse(paths) {
  const set = new Set(paths);
  return paths.filter((p) => {
    for (let q = parent(p); q !== ""; q = parent(q)) if (set.has(q)) return false;
    return true;
  });
}

// Keeps a path only while its parent's listing still holds a real (non-note) entry with that name.
export function prune(set, entries) {
  const out = new Set();
  for (const p of set) {
    const name = p.slice(parent(p).length + (p.includes("/") ? 1 : 0));
    if ((entries.get(parent(p)) ?? []).some((e) => !e.note && e.name === name)) out.add(p);
  }
  return out;
}
