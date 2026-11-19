// Ctrl/Cmd-click on a file link in a terminal (Herdr's link handlers, ../link.js): which file on which machine.
// Pure, no Herdr imports.

// Does the raw link start at the home folder (~/…, $HOME/…)? Then link.js asks the machine for it first.
export function wantsHome(link) {
  return link?.kind === "file" && !link.path && /^(~|\$HOME)(\/|$)/.test(String(link.raw ?? ""));
}

// { machine, path } of the clicked file, or null when there is none to show.
// link: { kind, raw, path } from Herdr; path is the file it found on this computer, null for a remote terminal.
// source: { machine, cwd } of the clicked terminal; home: that machine's home folder (null: unknown).
export function linkTarget(link, source, home = null) {
  if (link?.kind !== "file") return null;
  const machine = source?.machine ?? null;
  if (typeof link.path === "string" && link.path.startsWith("/")) return { machine, path: normal(link.path) };
  // A local link Herdr could not find: nothing to show, the click goes on to the next handler.
  if (machine === null) return null;
  const path = remotePath(String(link.raw ?? ""), source?.cwd ?? null, home);
  return path ? { machine, path } : null;
}

// A remote terminal's link as Herdr spells it: a file: URI, or a path with an optional sentence period and
// :line[:column] suffix (as Herdr's own without_suffix), relative to the terminal's folder or the home folder.
function remotePath(raw, cwd, home) {
  let s;
  const uri = /^file:\/\/[^/]*(\/.*)$/i.exec(raw);
  if (uri) {
    try { s = decodeURIComponent(uri[1]); } catch { return null; }
  } else if (/^file:/i.test(raw)) return null;
  else {
    s = raw.replace(/\.$/, "");
    for (let i = 0; i < 2; i++) s = s.replace(/:\d+$/, "");
  }
  let base = "";
  const at = /^(~|\$HOME|\$PWD)(?:\/|$)/.exec(s);
  if (at) { base = at[1] === "$PWD" ? cwd : home; s = s.slice(at[0].length); }
  else if (!s.startsWith("/")) base = cwd;
  if (base !== "" && !(typeof base === "string" && base.startsWith("/"))) return null;
  const path = normal(`${base}/${s}`);
  return path === "/" ? null : path;
}

// Without empty and "." parts, with ".." applied (lexically: the panel shows the path, it never follows it).
function normal(path) {
  const out = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}
