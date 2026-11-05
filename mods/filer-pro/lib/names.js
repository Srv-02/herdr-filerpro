// Pure POSIX string helpers; no node:path so this also runs in the Herdr runtime.

// Key for comparing entry names without letter case and Unicode normalization (NFD "U\u0308" and NFC "\u00dc"
// are the same name), like APFS. Keep both uses it on every side, also on a machine: at worst a name is avoided
// that a case-sensitive file system would have allowed.
export const nameKey = (name) => name.normalize("NFC").toLowerCase();

// First free name for Keep both. taken holds keys: key(name) and every candidate are looked up through key
// (default: the name itself, an exact comparison).
export function keepBothName(name, taken, key = (n) => n) {
  if (!taken.has(key(name))) return name;
  let dot = name.indexOf(".", 1);
  if (dot === name.length - 1) dot = -1; // trailing dot is no extension: "x." -> "x.-1"
  const stem = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? "" : name.slice(dot);
  for (let i = 1; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!taken.has(key(candidate))) return candidate;
  }
}

export function tempName(name, id) {
  return `.${name}.fs-${id}.part`;
}

function trimSlashes(p) {
  let end = p.length;
  while (end > 1 && p[end - 1] === "/") end--;
  return p.slice(0, end);
}

export function joinPath(dir, name) {
  const d = trimSlashes(dir);
  return d === "/" ? `/${name}` : `${d}/${name}`;
}

export function parentOf(path) {
  const p = trimSlashes(path);
  const i = p.lastIndexOf("/");
  if (i < 0) return "";
  return i === 0 ? "/" : p.slice(0, i);
}

export function baseName(path) {
  const p = trimSlashes(path);
  if (p === "/") return "";
  return p.slice(p.lastIndexOf("/") + 1);
}

// path relative to root for Copy Relative Path: "data/a.txt" below "/srv", "." for the root itself, the path
// unchanged when it is not below the root or there is no root. Exact comparison: both come from one panel.
export function relativePath(root, path) {
  if (typeof root !== "string" || root === "") return path;
  const r = trimSlashes(root), p = trimSlashes(path);
  if (p === r) return ".";
  const prefix = r === "/" ? "/" : `${r}/`;
  return p.startsWith(prefix) ? p.slice(prefix.length) : path;
}

// Copy Path and Copy Relative Path: a path that pastes into a shell (zsh, bash, sh) as one word. Raw when every
// character is a letter (also non-ASCII, with combining marks for NFD names), a digit or one of / . _ - + , : @ % =
// and it does not start with = (zsh equals expansion); otherwise in single quotes, a ' inside as '\''.
// A relative path starting with - gets ./ in front so that it is no option. No trailing newline.
const SHELL_SAFE = /^[\p{L}\p{M}\p{N}\/._\-+,:@%=]+$/u;
export function shellPath(path) {
  const p = !path.startsWith("/") && path.startsWith("-") ? `./${path}` : path;
  if (SHELL_SAFE.test(p) && !p.startsWith("=")) return p;
  return `'${p.replace(/'/g, "'\\''")}'`;
}

// Text for a PowerShell single-quoted string ('...'). PowerShell reads the curly quotes U+2018, U+2019, U+201A
// and U+201B as single quotes too, so each of them is doubled like ' itself; otherwise a name could close the
// string and run code.
export const psQuoted = (text) => text.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&");

// End of the part of a name that the rename dialog selects: folders whole, files up to the last dot
// (a leading dot is no extension: ".env" is selected whole).
export function stemEnd(name, isDir) {
  if (isDir) return name.length;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? dot : name.length;
}
