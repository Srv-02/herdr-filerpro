const PATTERNS = [
  ["Host key verification failed", (host) => `Unknown host key. Connect once in a terminal: ssh ${host || "<host>"}`],
  ["Permission denied (publickey", () => "SSH login failed (key not loaded?)"],
  ["No space left on device", () => "Disk full"],
  ["Operation not permitted", () => "macOS blocked access. Allow Herdr in System Settings › Privacy & Security › Files and Folders"],
  ["Connection timed out", () => "Machine not reachable"],
  ["Could not resolve hostname", () => "Machine not reachable"],
];

// Shown error texts never end in \r or whitespace.
export const cleanText = (t) => (typeof t === "string" ? t.trimEnd() : t);

const FALLBACK = "Transfer failed";

// The shown text for a failed command: a known pattern, else the last non-empty line, never shortened (dialogs and
// toasts shorten themselves, the transfer bar wraps, request results keep the full path). Empty stderr gives the
// caller's fallback (a blank one: "Transfer failed"), so the text is never "" and always counts as an error.
export function explainError(stderr, host, fallback = FALLBACK) {
  const text = cleanText(explain(typeof stderr === "string" ? stderr.replaceAll("\r\n", "\n") : "", host));
  return text || (typeof fallback === "string" && fallback.trim()) || FALLBACK;
}

function explain(text, host) {
  const unknown = /unknown machine "([^"]*)"/.exec(text);
  if (unknown) return `Unknown machine: ${unknown[1]}`;
  for (const [needle, make] of PATTERNS) {
    if (text.includes(needle)) return make(host);
  }
  if (/(?:open local|dest open) "[^"]*": No such file or directory/.test(text)) return "Target folder does not exist";
  const write = /(?:open local|dest open) "[^"]*": ([^\n]+)/.exec(text) ?? /^cp: .*: (Read-only file system|Permission denied)$/m.exec(text);
  if (write) return `Cannot write to the target folder: ${write[1]}`;
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length === 0 ? "" : lines[lines.length - 1];
}
