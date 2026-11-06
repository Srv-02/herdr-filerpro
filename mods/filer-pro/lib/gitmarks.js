// Git marks are keyed by the path of a row, relative to the panel root: the root itself can be a symlink, and then
// `git rev-parse --show-toplevel` prints the physical path, which never equals the logical root of the rows (issue #48).
// `git rev-parse --show-prefix` (the root's place inside the repository, "" at the top, else "sub/dir/") does not
// depend on that. One exec answers "is this a repository" and where the root is in it.

// The stdout of `git rev-parse --show-prefix` as a prefix: one trailing newline off, nothing else touched.
export const gitPrefix = (stdout) => stdout.replace(/\n$/, "");

// A `git status --porcelain=v1 -z` path (relative to the repository top) as a path relative to the root, or null
// when it lies outside the root (the repository is above it): no row of the tree can show it.
export const rootRelative = (prefix, statusPath) => {
  if (!statusPath.startsWith(prefix)) return null;
  const rel = statusPath.slice(prefix.length);
  return rel === "" ? null : rel;
};

// ---- the git dir watch: a repository above the root (prefix not "")
// The folder watch covers the root only, so the .git of a repository above it (the index, HEAD and refs that git add,
// commit, reset and restore --staged change) is never reported. Locally the same rev-parse exec also prints where that
// repository keeps them: `git rev-parse --show-prefix --absolute-git-dir --git-common-dir --show-toplevel`.
// --git-common-dir is relative to the physical working folder when git found it by walking up ("../.git"), so it is
// resolved against --show-toplevel plus the prefix (both physical). Remote copies keep the plain --show-prefix call:
// they have no watch, and an older git on a machine may not know --absolute-git-dir (git 2.13).
export const GIT_PLACE_ARGS = ["rev-parse", "--show-prefix", "--absolute-git-dir", "--git-common-dir", "--show-toplevel"];

const isAbs = (p) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
// A path joined and normalised lexically (. and .. folded). base is physical (git prints it), so .. is safe.
function resolveFrom(base, rel) {
  if (isAbs(rel)) return rel.length > 1 ? rel.replace(/[\\/]+$/, "") : rel;
  const drive = base.match(/^[A-Za-z]:/)?.[0] ?? "";
  const parts = [];
  for (const seg of `${base.slice(drive.length)}/${rel}`.split(/[\\/]+/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop(); else parts.push(seg);
  }
  return `${drive}/${parts.join("/")}`;
}

// The stdout of GIT_PLACE_ARGS: { prefix, gitDir, commonDir } with both dirs absolute, or null when it does not have
// the four lines (an older git printed the option names back, for example).
export function gitPlace(stdout) {
  const lines = String(stdout ?? "").split("\n");
  const [prefix, gitDir, common, top] = lines;
  if (lines.length < 4 || !gitDir || !common || !top || !isAbs(gitDir) || !isAbs(top)) return null;
  const cwd = resolveFrom(top, prefix);
  return { prefix, gitDir: resolveFrom(gitDir, "."), commonDir: resolveFrom(cwd, common) };
}

const below = (p, dir) => {
  const norm = (x) => String(x).replace(/\\/g, "/").replace(/\/+$/, "");
  const q = norm(p), d = norm(dir);
  return q === d ? "" : q.startsWith(d + "/") ? q.slice(d.length + 1) : null;
};

// The folders to watch for a place: none at the top of the repository (the root watch sees its .git); else the common
// dir, which also holds the git dir of a linked worktree (worktrees/<name>), and the git dir when it lies elsewhere.
export function gitWatchDirs(place) {
  if (!place || !place.prefix || !place.gitDir || !place.commonDir) return [];
  return below(place.gitDir, place.commonDir) !== null ? [place.commonDir] : [place.gitDir, place.commonDir];
}

// True when a batch from a git dir watch can change a mark: the watched folder itself (overflow), index or HEAD of this
// worktree's git dir, refs/ or packed-refs of the common dir. Objects, logs, locks, ORIG_HEAD and the index of another
// worktree never do by themselves. A path below neither folder (a path form not compared) counts, as in watchPlan.
export function gitWatchHit(paths, place) {
  if (!Array.isArray(paths) || !paths.length) return true;
  return paths.some((p) => {
    const g = below(p, place.gitDir), c = below(p, place.commonDir);
    if (g === null && c === null) return true;
    if (g === "" || g === "index" || g === "HEAD") return true;
    return c !== null && (c === "" || c === "packed-refs" || c === "refs" || c.startsWith("refs/"));
  });
}
