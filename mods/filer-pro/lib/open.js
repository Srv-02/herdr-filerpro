import { BUNDLE_EXTENSIONS } from "./bundles.js";

// "Open in browser", hardened. One sh call resolves the path (symlinks in any component), requires a regular
// file whose resolved name ends in .html or .htm, and then starts the opener with exactly that resolved path.
// So a link can never make the opener start a .command, .app or .sh, and the path that was checked is the path
// that is opened. openChecked below opens any regular file (not a folder or bundle) like the Finder would; the
// resolved path is what is opened. The path travels as an argument, never inside the command string. Herdr's fs module has no
// lstat or realpath, and macOS ships /bin/realpath.
const SCRIPT = 'f=$1; shift; real=$(realpath -- "$f" 2>/dev/null) || exit 3; [ -f "$real" ] || exit 4; '
  + 'case $(printf %s "$real" | LC_ALL=C tr "[:upper:]" "[:lower:]") in *.html|*.htm) ;; *) exit 5 ;; esac; exec "$@" "$real"';

export async function openRegularFile(file, { exec, notify, platform }) {
  const [cmd, args] = platform.openArgs(file);
  // The opener's own arguments, without the path (it is the last one); the shell appends the resolved path.
  const r = await exec("sh", ["-c", SCRIPT, "sh", file, cmd, ...args.slice(0, -1)]).catch(() => null);
  if (r?.code !== 0) notify({ title: "Open in browser", body: "Only HTML files can be opened (not links to other files, programs or folders).", level: "warning" });
}

// `sh -c OPEN_CHECK_SCRIPT sh <file> <opener> [<opener args>...]`: 2 no opener, 3 not found (also a dangling
// link; GNU realpath resolves a missing last component, so -e is checked too), 4 not a regular file (folder,
// bundle), else exec opener with the resolved path. Beyond that no rule on extension or execute permission:
// Open behaves like a double click in the Finder (decision 2026-11-05, spec). A download from a machine gets the
// quarantine flag first, so Gatekeeper judges it like a browser download.
export const OPEN_CHECK_SCRIPT = 'f=$1; shift; [ $# -gt 0 ] || exit 2; '
  + 'real=$(realpath -- "$f" 2>/dev/null) || exit 3; [ -e "$real" ] || exit 3; [ -f "$real" ] || exit 4; '
  + 'exec "$@" "$real"';

const TITLES = { default: "Open", preview: "Open in Preview" };
const REASONS = {
  3: (p) => `Cannot open: ${p} (not found)`,
  4: (p) => `Only files can be opened, not folders or app bundles: ${p}`,
};

// Opens file with the default app ("default") or Preview.app ("preview") after the checks above. The message
// shows the path as given (the resolved one does not exist on exit 3), never shortened. exec is called before
// the first await: jobs.js end() is synchronous and relies on that.
export async function openChecked(file, { app }, { exec, notify, platform }) {
  const [cmd, args] = app === "preview" ? platform.previewArgs(file) : platform.openArgs(file);
  // The opener's own arguments without the path (the last one); the shell appends the resolved path.
  let r = null;
  try {
    r = await exec("sh", ["-c", OPEN_CHECK_SCRIPT, "sh", file, cmd, ...args.slice(0, -1)]);
  } catch {
    r = null;
  }
  if (r?.code === 0) return { ok: true };
  const error = (REASONS[r?.code] ?? ((p) => `Could not open: ${p}`))(file);
  notify({ title: TITLES[app] ?? TITLES.default, body: error, level: "warning" });
  return { ok: false, error };
}

// `sh -c OPEN_BUNDLE_SCRIPT sh <path> <opener> [<opener args>...]` for a macOS package (lib/bundles.js): 2 no opener,
// 3 not found, 4 not a folder, 5 the resolved name has no package extension (a link "Example.app" to another folder),
// else exec opener with the resolved path. Like a double click in the Finder: Gatekeeper and the quarantine flag
// decide, nothing is removed or bypassed.
export const OPEN_BUNDLE_SCRIPT = 'f=$1; shift; [ $# -gt 0 ] || exit 2; '
  + 'real=$(realpath -- "$f" 2>/dev/null) || exit 3; [ -e "$real" ] || exit 3; [ -d "$real" ] || exit 4; '
  + 'case $(printf %s "$real" | LC_ALL=C tr "[:upper:]" "[:lower:]") in ' + BUNDLE_EXTENSIONS.map((e) => `*.${e}`).join("|") + ') ;; *) exit 5 ;; esac; '
  + 'exec "$@" "$real"';

const BUNDLE_REASONS = {
  3: (p) => `Cannot open: ${p} (not found)`,
  4: (p) => `Not a package any more: ${p}`,
  5: (p) => `Not a package (the link leads elsewhere): ${p}`,
};

// Opens a local macOS package with `open` (platform.openArgs) after the checks above; { ok, error? }, never rejects.
export async function openBundle(path, { exec, notify, platform }) {
  const [cmd, args] = platform.openArgs(path);
  let r = null;
  try {
    r = await exec("sh", ["-c", OPEN_BUNDLE_SCRIPT, "sh", path, cmd, ...args.slice(0, -1)]);
  } catch {
    r = null;
  }
  if (r?.code === 0) return { ok: true };
  const error = (BUNDLE_REASONS[r?.code] ?? ((p) => `Could not open: ${p}`))(path);
  notify({ title: TITLES.default, body: error, level: "warning" });
  return { ok: false, error };
}

// Sets the quarantine flag on a fresh download (scp sets none) before it is opened, so Gatekeeper and e.g. Office
// Protected View act as for a browser download. Fail closed: if xattr fails, nothing is opened.
async function openQuarantined(job, app, deps) {
  let code = null;
  try {
    const [cmd, args] = deps.platform.quarantineArgs(job.dest, (deps.now ?? Date.now)());
    code = (await deps.exec(cmd, args))?.code;
  } catch {
    code = null;
  }
  if (code !== 0) {
    deps.notify({ title: TITLES[app] ?? TITLES.default, body: `Not opened, the download could not be marked as downloaded (quarantine): ${job.dest}`, level: "warning" });
    return;
  }
  await openChecked(job.dest, { app }, deps);
}

// After a finished download or local copy (jobs.js end()): reveal true shows the file in the Finder, "open" and
// "preview" open it after the checks above, a download (direction "down") gets the quarantine flag first. The caller does not wait and
// the promise never rejects. A local open from the menu (main.js) calls openChecked directly, without a flag.
export function afterDownload(job, deps) {
  if (job.reveal === "open" || job.reveal === "preview") {
    const app = job.reveal === "preview" ? "preview" : "default";
    // Only a download gets the flag: a local copy (cp -P) keeps links as links, and xattr would follow one
    // and mark the original outside the target folder.
    return (job.direction === "down" ? openQuarantined(job, app, deps) : openChecked(job.dest, { app }, deps)).catch(() => {});
  }
  const [cmd, args] = deps.platform.revealArgs(job.dest);
  let r;
  try { r = deps.exec(cmd, args); } catch { return Promise.resolve(); }
  return Promise.resolve(r).catch(() => {});
}
