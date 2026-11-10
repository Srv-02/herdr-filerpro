// Folder navigation (issue #59): Up, Go to / and Back to the terminal's folder. Pure: main.js keeps the map and draws
// the header.
//
// The shown root is the focused terminal's folder unless that terminal has an override: nav is a Map<pane, { on, root }>,
// one entry per terminal. While it exists the tree stays on that root, also when the terminal changes folder (cd), until
// the user goes back to the terminal's folder. Only a change of machine ends it (the root means nothing there).

// The key of the focused terminal: its pane, or a layout terminal block (no pane) by its terminal id.
export function paneId(f) {
  if (f?.pane) return f.pane;
  return f?.terminal ? `terminal:${f.terminal}` : null;
}

// The root to show for the focused terminal at loc ({ cwd, on }): its override, else its folder. An override of
// another machine is dropped.
export function shownRoot(nav, pane, loc) {
  const o = pane ? nav.get(pane) : null;
  if (!o) return loc.cwd;
  if (o.on === (loc.on ?? null)) return o.root;
  nav.delete(pane);
  return loc.cwd;
}

// Shows root for the focused terminal; the terminal's own folder ends the override (Back to the terminal's folder).
// False when there is nothing to key it to.
export function setRoot(nav, pane, loc, root) {
  if (!pane || !loc?.cwd || !root) return false;
  if (root === loc.cwd) nav.delete(pane);
  else nav.set(pane, { on: loc.on ?? null, root });
  return true;
}

// The top of the file system that holds root: / or a Windows drive root (C:\); null without a root.
export function topOf(root) {
  if (typeof root !== "string" || root === "") return null;
  const drive = /^([A-Za-z]:)([\\/]|$)/.exec(root);
  return drive ? `${drive[1]}${drive[2] || "\\"}` : "/";
}

const DRIVE = /^[A-Za-z]:[\\/]?$/;

// The parent of an absolute root, or null at the top (/, a Windows drive root) and without a root.
export function upOf(root) {
  if (typeof root !== "string" || root === "" || DRIVE.test(root)) return null;
  const p = root.replace(/[\\/]+$/, "");
  if (p === "") return null;
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (i < 0) return null;
  if (i === 0) return "/";
  const parent = p.slice(0, i);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}${p[i]}` : parent;
}

// Without trailing separators; / and a drive root (C:\) stay as they are.
const trim = (p) => (p.length > 1 && !DRIVE.test(p) ? p.replace(/[\\/]+$/, "") : p);
const SEP = /[\\/]$/;

// Where `inner` lies below `outer`: "" for the same folder, "a/b" below it, null when not inside.
function below(outer, inner) {
  const o = trim(outer), i = trim(inner);
  if (o === i) return "";
  const base = SEP.test(o) ? o : `${o}${o.includes("\\") && !o.includes("/") ? "\\" : "/"}`;
  return i.startsWith(base) ? i.slice(base.length).replace(/\\/g, "/") : null;
}

// The tree state ({ folders, packages, file, lastOpened }, paths relative to `from`) relative to `to`. Going up keeps
// everything below the old root and expands the old root with its parents, so the same rows stay visible; going down
// (back to the terminal's folder) keeps what lies inside the new root; an unrelated folder keeps nothing.
export function carry(state, from, to) {
  const up = below(to, from), down = up === null ? below(from, to) : null;
  let map;
  if (up !== null) map = (p) => (up && p ? `${up}/${p}` : up || p);
  else if (down !== null) map = (p) => (p.startsWith(`${down}/`) ? p.slice(down.length + 1) : null);
  else map = () => null;
  const set = (s) => new Set([...(s ?? [])].map(map).filter(Boolean));
  // The old root and its parents first: the tree loads (and counts toward list_total) in this order.
  const parts = up ? up.split("/") : [];
  const folders = new Set([...parts.map((_, n) => parts.slice(0, n + 1).join("/")), ...set(state.folders)]);
  const one = (p) => (p ? map(p) || null : null);
  return { folders, packages: set(state.packages), file: one(state.file), lastOpened: one(state.lastOpened) };
}

// Whether the local root may be watched: not / and not a folder above the home folder (Up can get there; a recursive
// watch would wake for every change on the disk). Such a root reloads on Refresh and after own actions, as a machine does.
export function watchable(root, home) {
  if (typeof root !== "string" || root === "" || /^[\\/]+$/.test(root) || /^[A-Za-z]:[\\/]?$/.test(root)) return false;
  const r = trim(root), h = home ? trim(home) : "";
  return !(h && (h.startsWith(`${r}/`) || h.startsWith(`${r}\\`)));
}

// The navigated root for the header: below the home folder as ~/…
export function headerPath(root, home) {
  if (!home || typeof root !== "string") return root;
  return root === home || root.startsWith(`${home}/`) || root.startsWith(`${home}\\`) ? `~${root.slice(home.length)}` : root;
}

// The text in at most max characters, cut at the front with … (from a folder boundary when the kept tail has one).
export function frontTruncate(text, max) {
  if (text.length <= max) return text;
  if (max < 2) return "…";
  const tail = text.slice(text.length - (max - 1)), slash = tail.indexOf("/");
  return `…${slash > 0 && slash < tail.length - 1 ? tail.slice(slash) : tail}`;
}
