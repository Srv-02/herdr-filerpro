// Size probe and byte formatting. Pure; the script runs as `sh -c SIZE_SCRIPT size <path>`
// locally or on the remote (non-login sh, POSIX tools only, GNU and BSD/macOS).

// Prints the summed size of all regular files under <path> (a file counts as itself),
// never following symlinks, or -1 when the path does not exist.
export const SIZE_SCRIPT = [
  'p=$1',
  'case $p in -*) p=./$p ;; esac',
  'if [ ! -e "$p" ] && [ ! -L "$p" ]; then echo -1; exit 0; fi',
  'if stat -c%s / >/dev/null 2>&1; then f=-c%s; else f=-f%z; fi',
  'find -H "$p" -type f -exec stat -L "$f" {} + 2>/dev/null | awk \'{ s += $1 } END { printf "%.0f\\n", s }\'',
].join("\n");

export function parseSize(stdout) {
  const m = /^\s*(-?\d+)\s*$/.exec(String(stdout ?? ""));
  if (!m) return null;
  const n = Number(m[1]);
  return n < 0 ? null : n;
}

const UNITS = ["B", "kB", "MB", "GB", "TB"];

export function formatBytes(n) {
  let v = Number.isFinite(n) && n > 0 ? n : 0;
  let i = 0;
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1000;
    i++;
  }
  let r = i > 0 && v < 10 ? Math.round(v * 10) / 10 : Math.round(v);
  if (r >= 1000 && i < UNITS.length - 1) {
    // rounding carried into the next unit, e.g. 999.6 kB
    r = Math.round((r / 1000) * 10) / 10;
    i++;
  } else if (i > 0 && r >= 10 && r !== Math.round(r)) {
    r = Math.round(r);
  }
  const text = i > 0 && r < 10 ? r.toFixed(1) : String(r);
  return `${text} ${UNITS[i]}`;
}

export function formatRate(bps) {
  return `${formatBytes(bps)}/s`;
}
