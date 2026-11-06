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
