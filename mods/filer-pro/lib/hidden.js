// Which entries the file list hides (settings hide_system_files and hide_dotfiles, issue #17). Pure.
// The names are a fixed constant, never read from the config: the shell and PowerShell listings (lib/tree.js) are built
// from them, and the only thing a setting adds to a listing is the word 1 or 0 (hideArgs). Hiding changes the view
// only: copy, move, delete and download of a folder work on the folder itself and still include every entry.

// exact: compared as written. These are written by macOS in exactly this form; on a case-sensitive Linux machine a
// ".ds_store" would be someone's own file. "Icon\r" is the custom folder icon file (its name ends in a carriage return).
// prefixes: AppleDouble files ("._" + the name of the file they belong to).
// anyCase: written by Windows, whose file systems ignore case; both "Thumbs.db" and "thumbs.db", "desktop.ini" and
// "Desktop.ini" occur in the wild.
export const SYSTEM_FILES = Object.freeze({
  exact: Object.freeze([".DS_Store", ".Spotlight-V100", ".Trashes", ".fseventsd", ".TemporaryItems", ".DocumentRevisions-V100", ".apdisk", "Icon\r"]),
  prefixes: Object.freeze(["._"]),
  anyCase: Object.freeze(["Thumbs.db", "desktop.ini"]),
});

const EXACT = new Set(SYSTEM_FILES.exact), ANY_CASE = new Set(SYSTEM_FILES.anyCase.map((n) => n.toLowerCase()));

export function isSystemFile(name) {
  return EXACT.has(name) || SYSTEM_FILES.prefixes.some((p) => name.startsWith(p)) || ANY_CASE.has(name.toLowerCase());
}

// hide: the settings { hide_system_files, hide_dotfiles }; only true switches a filter on.
export function isHidden(name, hide) {
  return (hide?.hide_dotfiles === true && name.startsWith(".")) || (hide?.hide_system_files === true && isSystemFile(name));
}

// A path relative to the shown root is hidden when its name or any folder above it is (an open folder that became hidden).
export function hiddenPath(path, hide) {
  return path !== "" && path.split("/").some((name) => isHidden(name, hide));
}

// The switches as the listing script's $3 (system files) and $4 (dot files).
export const hideArgs = (hide) => [hide?.hide_system_files === true ? "1" : "0", hide?.hide_dotfiles === true ? "1" : "0"];

// --- shell: one `case` pattern. Every name is double-quoted (literal); a carriage return is the variable $cr the
// listing script sets; a letter of an anyCase name is a bracket of both cases. ---
const shQuoted = (name) => `"${name.replaceAll("\r", "$cr")}"`;
const anyCase = (name) => name.split("").map((c) => (/[a-z]/i.test(c) ? `[${c.toUpperCase()}${c.toLowerCase()}]` : shQuoted(c))).join("");
export const SYSTEM_CASE = [...SYSTEM_FILES.exact.map(shQuoted), ...SYSTEM_FILES.prefixes.map((p) => `${shQuoted(p)}*`), ...SYSTEM_FILES.anyCase.map(anyCase)].join("|");

// --- PowerShell: a Where-Object stage, or "" when nothing is hidden. -ccontains compares case-sensitively,
// -contains ignores case, StartsWith with Ordinal is case-sensitive. ---
const psString = (name) => {
  const parts = name.split("\r").map((p) => `'${p}'`);
  return parts.length === 1 ? parts[0] : `(${parts.join(" + [char]13 + ").replace(/ \+ ''/g, "").replace(/'' \+ /g, "")})`;
};
const psList = (names) => `@(${names.map(psString).join(", ")})`;

export function psHideFilter(hide) {
  const tests = [];
  if (hide?.hide_dotfiles === true) tests.push("$_.Name.StartsWith('.', [StringComparison]::Ordinal)");
  if (hide?.hide_system_files === true) {
    tests.push(`${psList(SYSTEM_FILES.exact)} -ccontains $_.Name`);
    for (const p of SYSTEM_FILES.prefixes) tests.push(`$_.Name.StartsWith(${psString(p)}, [StringComparison]::Ordinal)`);
    tests.push(`${psList(SYSTEM_FILES.anyCase)} -contains $_.Name`);
  }
  return tests.length ? ` | Where-Object { -not (${tests.join(" -or ")}) }` : "";
}
