const PATTERNS = [
  ["Host key verification failed", (host) => `Unknown host key. Connect once in a terminal: ssh ${host || "<host>"}`],
  ["Permission denied (publickey", () => "SSH login failed (key not loaded?)"],
  ["No space left on device", () => "Disk full"],
  ["Connection timed out", () => "Machine not reachable"],
  ["Could not resolve hostname", () => "Machine not reachable"],
];

// Shown error texts never end in \r or whitespace.
export const cleanText = (t) => (typeof t === "string" ? t.trimEnd() : t);

const FALLBACK = "Transfer failed";

// The shown text for a failed command: a known pattern, else the last non-empty line, never shortened (dialogs and
// toasts shorten themselves, the transfer bar wraps, request results keep the full path). Empty stderr gives the
// caller's fallback (a blank one: "Transfer failed"), so the text is never "" and always counts as an error.
// opts.localPlatform: platform of this computer (macOS when absent; "windows" or "linux" gives the neutral text), decides the text of "Operation not permitted".
// opts.direction: "up" for an upload. scp names the local file in `open local` for both directions: the unreadable
// source on an upload, the target on a download. Only the caller knows which.
export function explainError(stderr, host, fallback = FALLBACK, opts = {}) {
  const text = cleanText(explain(typeof stderr === "string" ? stderr.replaceAll("\r\n", "\n") : "", host, opts?.localPlatform, opts?.direction));
  return text || (typeof fallback === "string" && fallback.trim()) || FALLBACK;
}

// "Operation not permitted" (EPERM) means different things per side. Only on this computer, and only on macOS, can it be
// the privacy protection (TCC); on a remote machine or another OS it is the owner, a sticky folder or a locked item.
// The local side is: no machine (host empty), or a transfer error that names the local file (scp "open local").
const NOT_PERMITTED_LOCAL = "Not permitted: macOS privacy settings, owner, or a locked item.";
const NOT_PERMITTED = "Not permitted (owner, sticky folder or locked item)";
function notPermitted(text, host, localPlatform) {
  const local = !host || /open local "/.test(text);
  return local && localPlatform !== "windows" && localPlatform !== "linux" ? NOT_PERMITTED_LOCAL : NOT_PERMITTED;
}

function explain(text, host, localPlatform, direction) {
  const unknown = /unknown machine "([^"]*)"/.exec(text);
  if (unknown) return `Unknown machine: ${unknown[1]}`;
  for (const [needle, make] of PATTERNS) {
    if (text.includes(needle)) return make(host);
  }
  if (text.includes("Operation not permitted")) return notPermitted(text, host, localPlatform);
  if (direction === "up") {
    const src = /open local "[^"]*": ([^\n]+)/.exec(text);
    if (src) return /No such file or directory/.test(src[1]) ? "The file no longer exists" : `Cannot read the file: ${src[1]}`;
  }
  if (/(?:open local|dest open) "[^"]*": No such file or directory/.test(text)) return "Target folder does not exist";
  const write = /(?:open local|dest open) "[^"]*": ([^\n]+)/.exec(text)
    ?? /^cp: .*\.fs-[^/\n]*\.part'?: (Read-only file system|Permission denied)$/m.exec(text)
    ?? /^cp: .*: (Read-only file system)$/m.exec(text);
  if (write) return `Cannot write to the target folder: ${write[1]}`;
  // cp names the temp file `.<name>.fs-<id>.part` only when the target is the problem
  const read = /^cp: .*: (Permission denied)$/m.exec(text);
  if (read) return `Cannot read the file: ${read[1]}`;
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length === 0 ? "" : lines[lines.length - 1];
}
