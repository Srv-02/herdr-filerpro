// All local (macOS) specifics live here.
export function revealArgs(path) {
  return ["open", ["-R", path]];
}

// Opens a file with the system's default program (an HTML file opens in the browser).
export function openArgs(path) {
  return ["open", [path]];
}

export function trashDir(home) {
  return `${home}/.Trash`;
}

// Key for comparing local paths: the default macOS volume (APFS) ignores letter case and Unicode
// normalization (NFD "U\u0308" and NFC "\u00dc" name the same entry).
export function pathKey(path) {
  return path.normalize("NFC").toLowerCase();
}

// Opens a file in Preview.app (the macOS app, not the panel's own preview).
export function previewArgs(path) {
  return ["open", ["-a", "Preview", path]];
}

// Marks a downloaded file like a browser download (flags 0081, time in hex seconds, app name), so Gatekeeper
// and e.g. Office Protected View treat it as downloaded. scp sets no such flag. The path is only an argument.
export function quarantineArgs(path, nowMs) {
  return ["xattr", ["-w", "com.apple.quarantine", `0081;${Math.floor(nowMs / 1000).toString(16)};Filer Pro;`, path]];
}

// Fallback for the clipboard when cx.write_to_clipboard is missing: the text travels as an argument,
// printf %s adds no newline and interprets nothing in it (also not a leading "-n" or a "%"). pbcopy reads its
// input in the locale's encoding; a process started by the app often has no LANG, so UTF-8 is set here.
export function clipboardArgs(text) {
  return ["sh", ["-c", 'printf %s "$1" | LC_ALL=en_US.UTF-8 pbcopy', "sh", text]];
}

export const platform = { revealArgs, openArgs, previewArgs, quarantineArgs, clipboardArgs, trashDir, pathKey };
