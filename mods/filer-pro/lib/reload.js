import { hiddenPath } from "./hidden.js";

// Tree reloads after filer-pro.changed (New Folder, Rename, Delete, every finished job): a batch of 100 jobs
// must not reload every open folder 100 times. At most one reload per gapMs and never while a load runs; a
// signal that arrives meanwhile is kept and caught up afterwards, so none is lost.
// signal(at): the current filer-pro.changed.at; true when it is new. mark(): a local trigger (a relevant folder watch
// batch, issue #42), gated the same way, so an own action and the watch events it causes give one reload.
// take(loading): true when a reload starts now. The panel's 250 ms tick calls take(), so a trigger kept back by the
// gap is caught up then.
export function createReloadGate({ now, gapMs = 1000, at = null }) {
  let seen = at, dirty = false, last = -Infinity;
  return {
    signal(next) {
      if (next === seen) return false;
      seen = next;
      dirty = true;
      return true;
    },
    mark() { dirty = true; },
    take(loading) {
      if (!dirty || loading || now() - last < gapMs) return false;
      dirty = false;
      last = now();
      return true;
    },
  };
}

// A batch of watchFolder paths (absolute) touches the file at `abs` when it names the file itself or a folder above it
// (the watched root in a batch means "refresh everything"). Separators: / and \ (Windows).
export function fileHit(paths, abs) {
  if (!abs || !Array.isArray(paths)) return false;
  const norm = (p) => String(p).replace(/[\\/]+$/, "");
  const file = norm(abs);
  return paths.some((p) => {
    const q = norm(p);
    return q === file || (q !== "" && (file.startsWith(q + "/") || file.startsWith(q + "\\")));
  });
}

// ---- issue #42: only folder watch batches that can change what the panel shows refresh it.

// A Windows root (drive letter or backslash): backslashes are separators there; elsewhere they are part of a name.
const windowsPath = (p) => /^[A-Za-z]:/.test(p) || p.includes("\\");
const trim = (p) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
const absOf = (root, file) => `${trim(root) === "/" ? "" : trim(root)}/${file}`;

// The path relative to the shown root ("" for the root itself), trying each root in turn: herdr watches the
// canonical root (/tmp/w arrives as /private/tmp/w, symlinks resolved), so the root as resolved by cd -P is
// passed too. null when the path is below none of them. Relative paths use / (as the tree does).
export function watchRel(p, roots) {
  if (typeof p !== "string") return null;
  for (const root of roots ?? []) {
    if (typeof root !== "string" || root === "") continue;
    const win = windowsPath(root);
    const norm = (x) => trim(win ? x.replace(/^\\\\\?\\/, "").replace(/\\/g, "/") : x);
    const r = norm(root), q = norm(p);
    if (q === r) return "";
    const base = r === "/" ? "/" : r + "/";
    if (q.startsWith(base)) return q.slice(base.length);
  }
  return null;
}

// What the panel's git marks come from: the index, HEAD and refs of a repository at the root. Objects, logs and
// lock files change on every git command and never change a mark by themselves. ".git" itself: a parent report.
const gitRelevant = (rel) => rel === ".git" || rel === ".git/index" || rel === ".git/HEAD" || rel.startsWith(".git/refs/");

// Which refresh a batch of watchFolder paths needs. roots: the shown root as given and as resolved; links: [rel, real]
// pairs, an expanded folder (or the open file's folder) and its real path as cd -P gives it: herdr reports a change
// below a symlinked folder under the link's target, so such a path counts as one below the folder too (a target
// outside the root is not watched at all); folders: the expanded folders (relative, also those whose first load runs);
// file: the open file (relative) or null; fileKnown: the open file's real folder is known (it lies in the root
// itself, or links holds its folder), so it is matched exactly; hide: the hide settings. Returns { refresh, file }:
// file "named" when the batch names the open file or a folder above it (read it again), "text" when the paths cannot
// be compared (read and compare the text), else null.
// Rules, per path: the root (overflow: herdr bounds pending paths) refreshes everything; the open file or a folder
// above it; while the open file's real folder is not known, a path with its name (compare its text: it may lie
// behind a symlinked folder); .git index, HEAD, refs; a shown folder or one above it; a .gitignore in a shown folder;
// anything else hidden by the hide settings is ignored; a direct child of the root or of a shown folder refreshes;
// everything else (collapsed subtrees, package contents, ignored folders like node_modules) is ignored. A path below
// no root and no link, or a batch without paths, falls back to the old behaviour: refresh and compare the open file.
export function watchPlan(paths, { roots, links = [], folders = [], file = null, fileKnown = false, hide = null } = {}) {
  const shown = new Set(folders);
  // Every name a path has in the tree: below the root, and below each linked folder whose real path holds it.
  const namesOf = (p) => {
    const out = [];
    const direct = watchRel(p, roots);
    if (direct !== null) out.push(direct);
    for (const [rel, real] of links) {
      const below = typeof real === "string" && real !== "" ? watchRel(p, [real]) : null;
      if (below !== null) out.push(below === "" ? rel : rel === "" ? below : `${rel}/${below}`);
    }
    return out;
  };
  const named = Array.isArray(paths) ? paths.map(namesOf) : [];
  if (!named.length || named.some((n) => !n.length)) {
    const abs = file && typeof roots?.[0] === "string" ? absOf(roots[0], file) : null;
    return { refresh: true, file: !file ? null : Array.isArray(paths) && fileHit(paths, abs) ? "named" : "text" };
  }
  let refresh = false, text = false;
  const name = file && !fileKnown && file.includes("/") ? file.slice(file.lastIndexOf("/") + 1) : null;
  for (const rel of named.flat()) {
    if (rel === "" || (file && (rel === file || file.startsWith(rel + "/")))) return { refresh: true, file: file ? "named" : null };
    const i = rel.lastIndexOf("/"), parent = i < 0 ? "" : rel.slice(0, i), base = rel.slice(i + 1);
    // The open file behind a symlinked folder whose real path is not known yet: same name, compare the text.
    if (name && base === name) { refresh = text = true; continue; }
    if (refresh) continue;
    if (gitRelevant(rel) || [...shown].some((f) => f === rel || f.startsWith(rel + "/"))) { refresh = true; continue; }
    const listed = parent === "" || shown.has(parent);
    // A .gitignore decides which shown rows are marked untracked, also while dot files are hidden.
    if (listed && base === ".gitignore") { refresh = true; continue; }
    if (hiddenPath(rel, hide)) continue;
    if (listed) refresh = true;
  }
  return { refresh, file: text ? "text" : null };
}

// ---- issue #41: a chmod from the Permissions dialog (filer-pro.changed perms: { machine, path, recursive }, path
// absolute) covers the open file of a copy that shows the same machine when it is the file itself, a folder above it
// changed recursively, or its direct folder (the edit probe refuses a file whose folder anyone may write without the
// sticky bit, lib/textedit.js GUARDS). Only that copy probes again; any other keeps comparing the text.
export function permsCover(perms, { on, root, file }) {
  if (!perms || typeof perms.path !== "string" || !file || typeof root !== "string") return false;
  if ((perms.machine ?? null) !== (on ?? null)) return false;
  const target = trim(perms.path), abs = absOf(root, file);
  if (abs === target) return true;
  if (!abs.startsWith(target === "/" ? "/" : target + "/")) return false;
  return perms.recursive === true || abs.slice(0, abs.lastIndexOf("/")) === target;
}
