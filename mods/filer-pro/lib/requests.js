// Request files: other programs (herdr-app do ... cannot pass arguments) drop <id>.json into
// appHome()/filer-pro/requests/; the lease holder claims, handles and answers with <id>.result.json.
import { createBatch } from "./batch.js";
import { clipEntry, pastePlan } from "./clipboard.js";
import { badSpelling, normalizePath } from "./fileops.js";
import { baseName, nameKey } from "./names.js";

const CONFLICTS = ["replace", "merge", "keep_both", "cancel"];
const REVEALS = [true, "open", "preview"];
const MODES = ["preview", "source"];

const SPELLING_ERROR = 'Path must not contain ".", ".." or "//"';

// A request path is refused with a "." or ".." component or an empty one from "//" (badSpelling): ".." behind
// a link climbs from the link's target. A trailing slash is fine (normalizePath first), and "/" itself is a
// valid folder (the root folder), never a valid source: then rootError says what it cannot be (rootOk: folders).
function spellingError(path, rootOk = false, rootError = SPELLING_ERROR) {
  const p = normalizePath(path);
  if (p === "/") return rootOk ? null : rootError;
  return badSpelling(p) ? SPELLING_ERROR : null;
}

export function parseRequest(text) {
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    return { error: "Invalid JSON" };
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { error: "Request must be an object" };
  const str = (v) => typeof v === "string" && v !== "";
  const common = () => {
    if (o.conflict !== undefined && !CONFLICTS.includes(o.conflict)) return { error: "conflict must be one of replace, merge, keep_both, cancel" };
    const r = {};
    if (o.conflict !== undefined) r.conflict = o.conflict;
    if (o.links !== undefined) r.links = o.links;
    if (o.reveal !== undefined && o.reveal !== null && o.reveal !== false) {
      if (!REVEALS.includes(o.reveal)) return { error: "reveal must be true, open or preview" };
      r.reveal = o.reveal;
    }
    return r;
  };
  // paths (copy, upload): non-empty list of absolute paths; folder: absolute when given.
  const pathsError = () => {
    if (!Array.isArray(o.paths) || o.paths.length === 0 || !o.paths.every(str)) return "paths is required";
    if (!o.paths.every((p) => p.startsWith("/"))) return "paths must be absolute";
    if (o.folder !== undefined && (!str(o.folder) || !o.folder.startsWith("/"))) return "folder must be absolute";
    for (const p of o.paths) {
      const e = spellingError(p, false, `"/" cannot be ${o.action === "upload" ? "uploaded" : "copied"}`);
      if (e) return e;
    }
    if (o.folder !== undefined && spellingError(o.folder, true)) return SPELLING_ERROR;
    return null;
  };
  // machine: optional (absent or null = this computer); anything but a name is an error, so a
  // mistyped machine can never turn a remote operation into a local one.
  const machineOf = () => {
    if (o.machine === undefined || o.machine === null) return {};
    return str(o.machine) ? { machine: o.machine } : { error: "machine must be a name" };
  };
  const absError = (field, value) => {
    if (!str(value)) return `${field} is required`;
    return value.startsWith("/") ? null : `${field} must be absolute`;
  };
  // As absError, plus the spelling check; rootOk: "/" is allowed (a folder).
  const pathError = (field, value, rootOk = false, rootError) => absError(field, value) ?? spellingError(value, rootOk, rootError);
  switch (o.action) {
    case "download": {
      if (!str(o.machine)) return { error: "machine is required" };
      const pe = pathError("path", o.path, false, '"/" cannot be downloaded');
      if (pe) return { error: pe };
      // dest_dir: absent or null means download_folder; anything else must be an absolute folder (#33).
      const hasDest = o.dest_dir !== undefined && o.dest_dir !== null;
      if (hasDest) {
        if (!str(o.dest_dir) || !o.dest_dir.startsWith("/")) return { error: "dest_dir must be absolute" };
        if (spellingError(o.dest_dir, true)) return { error: SPELLING_ERROR };
      }
      const c = common();
      if (c.error) return c;
      return { action: "download", machine: o.machine, path: o.path, ...(hasDest ? { dest_dir: o.dest_dir } : {}), ...c };
    }
    case "upload": {
      if (!str(o.machine)) return { error: "machine is required" };
      const pe = pathsError();
      if (pe) return { error: pe };
      if (!str(o.folder)) return { error: "folder is required" };
      const c = common();
      if (c.error) return c;
      return { action: "upload", machine: o.machine, paths: o.paths, folder: o.folder, ...c };
    }
    case "copy": {
      const pe = pathsError();
      if (pe) return { error: pe };
      const { links: _links, ...c } = common(); // a local copy never checks links
      if (c.error) return c;
      return { action: "copy", paths: o.paths, ...(o.folder !== undefined ? { folder: o.folder } : {}), ...c };
    }
    case "clip": {
      const m = machineOf();
      if (m.error) return m;
      const pe = pathError("path", o.path, false, '"/" cannot be copied or cut');
      if (pe) return { error: pe };
      return { action: "clip", ...m, path: o.path, is_dir: o.is_dir === true, ...(o.cut === true ? { cut: true } : {}) };
    }
    case "paste": {
      const m = machineOf();
      if (m.error) return m;
      const fe = pathError("folder", o.folder, true);
      if (fe) return { error: fe };
      if (o.root !== undefined) {
        const re = absError("root", o.root);
        if (re) return { error: re };
      }
      const c = common();
      if (c.error) return c;
      return { action: "paste", ...m, folder: o.folder, ...(o.root !== undefined ? { root: o.root } : {}), ...c };
    }
    case "rename": {
      const m = machineOf();
      if (m.error) return m;
      const pe = absError("path", o.path) ?? absError("root", o.root);
      if (pe) return { error: pe };
      if (!str(o.name)) return { error: "name is required" };
      return { action: "rename", ...m, path: o.path, root: o.root, name: o.name };
    }
    case "mkdir": {
      const m = machineOf();
      if (m.error) return m;
      const pe = absError("path", o.path);
      if (pe) return { error: pe };
      if (!str(o.name)) return { error: "name is required" };
      return { action: "mkdir", ...m, path: o.path, name: o.name };
    }
    case "delete": {
      const m = machineOf();
      if (m.error) return m;
      const pe = absError("path", o.path) ?? absError("root", o.root);
      if (pe) return { error: pe };
      return { action: "delete", ...m, path: o.path, root: o.root, confirm: o.confirm === true };
    }
    case "open": {
      const m = machineOf();
      if (m.error) return m;
      const pe = absError("path", o.path);
      if (pe) return { error: pe };
      if (o.mode !== undefined && !MODES.includes(o.mode)) return { error: "mode must be preview or source" };
      return { action: "open", ...m, path: o.path, ...(o.mode !== undefined ? { mode: o.mode } : {}) };
    }
    case "mode":
      if (!MODES.includes(o.mode)) return { error: "mode must be preview or source" };
      return { action: "mode", mode: o.mode };
    case "cancel":
      if (!str(o.job)) return { error: "job is required" };
      return { action: "cancel", job: o.job };
    case "answer":
      if (!str(o.choice)) return { error: "choice is required" };
      return { action: "answer", choice: o.choice, apply_to_all: o.apply_to_all === true };
    case "status":
      return { action: "status" };
    default:
      return { error: `Unknown action: ${o.action}` };
  }
}

// The claim file makes one copy the only handler; a second write with expected=null rejects.
export async function claim(dir, id, writeTextFile) {
  try {
    await writeTextFile(`${dir}/${id}.claim`, "1", null);
    return true;
  } catch {
    return false;
  }
}

export function resultText({ ok, job, jobs, path, trashed, trash_path, moved, noop, warning, shown, mode, errors, error }) {
  const o = { ok: !!ok };
  if (job !== undefined) o.job = job;
  if (jobs !== undefined) o.jobs = jobs;
  if (path !== undefined) o.path = path;
  if (trashed !== undefined) o.trashed = trashed;
  if (trash_path !== undefined) o.trash_path = trash_path;
  if (moved !== undefined) o.moved = moved;
  if (noop !== undefined) o.noop = noop;
  if (warning !== undefined) o.warning = warning;
  if (shown !== undefined) o.shown = shown;
  if (mode !== undefined) o.mode = mode;
  if (errors !== undefined) o.errors = errors;
  if (error !== undefined) o.error = error;
  return JSON.stringify(o, null, 2);
}

// Several paths into one folder: inspect each, ask the batch dialog, start the rest in path order.
// A later entry with the name of an earlier one is started as keep_both without a question (R67),
// unless the first one was cancelled: then it is cancelled too (R71).
// deps: as handleRequest ({ jobs, ask, newBatchId }). reveal: true | "open" | "preview" (jobs.js end, open.js afterDownload).
export async function runTransfers({ direction, machine, paths, destDir, conflict, links, reveal }, deps) {
  const { jobs } = deps;
  const items = [], errors = [], seen = new Map(); // seen: nameKey of the name -> key of the first entry with it
  for (const path of paths) {
    const info = await jobs.inspect({ direction, machine, src: path, destDir });
    if (info.error) {
      errors.push({ path, error: info.error });
      continue;
    }
    // A folder with a symlink loop is never transferred; links: "transfer_anyway" cannot override that.
    if (info.linkBlocked && links === "transfer_anyway") {
      errors.push({ path, error: info.linkWarning });
      continue;
    }
    const key = String(items.length);
    // Same name in any letter case or Unicode normalization (#33): on APFS it is the same entry.
    const first = seen.get(nameKey(info.name));
    if (first === undefined) seen.set(nameKey(info.name), key);
    items.push({
      key, path, first, name: info.name, isDir: info.isDir, direction, machine, exists: first === undefined ? info.exists : false,
      linkWarning: info.linkWarning, linkTitle: info.linkTitle, linkBlocked: info.linkBlocked === true,
      ...(info.destIsDir !== undefined ? { destIsDir: info.destIsDir } : {}),
      ...(info.replaceError ? { replaceError: info.replaceError } : {}),
      ...(info.mergeError ? { mergeError: info.mergeError } : {}),
    });
  }
  const started = [];
  if (items.length > 0) {
    const batch = createBatch(items);
    batch.preset({ links: links === "transfer_anyway" || links === "cancel" ? links : undefined, conflict });
    const id = deps.newBatchId();
    let n = 0;
    for (let item = batch.next(); item; item = batch.next()) {
      // One id per question: a late close of the previous dialog must not match the next one.
      const a = await deps.ask({ batch: `${id}#${++n}`, item, choices: batch.choices(item), remaining: batch.remaining(item) });
      batch.answer(a?.choice ?? "cancel", a?.apply_to_all === true);
    }
    for (const item of items) {
      let choice = batch.decision(item.key);
      // A later same-name entry follows the first one: cancelled with it, else keep_both (R67, R71).
      if (item.first !== undefined) choice = batch.decision(item.first) === "cancel" ? "cancel" : choice && "keep_both";
      if (!choice || choice === "cancel") continue;
      // Like Move: Replace stays a choice, a mount in the old folder refuses it after the answer, per entry.
      if (choice === "replace" && item.replaceError) {
        errors.push({ path: item.path, error: item.replaceError });
        continue;
      }
      // The same for Merge of a linked folder (#46): offered nowhere, but Apply to all or conflict: "merge" can choose it.
      if (choice === "merge" && item.mergeError) {
        errors.push({ path: item.path, error: item.mergeError });
        continue;
      }
      started.push(await jobs.start({
        direction, machine, src: item.path, destDir, choice, isDir: item.isDir, ...(reveal ? { reveal } : {}),
      }));
    }
  }
  if (started.length > 0) return { ok: true, jobs: started, ...(errors.length > 0 ? { errors } : {}) };
  if (errors.length > 0) return { ok: false, error: errors[0].error, errors };
  return { ok: false, error: "Cancelled" };
}

// Paste after Cut: inspect, ask (replace / keep both / cancel; or copy instead on another volume), move.
// Replace is the confirmation, there is no second dialog. conflict answers the dialog up front;
// merge counts as replace. Another volume is never answered up front: it is Copy instead or Cancelled.
// deps: as handleRequest; fileOps.inspectMove / fileOps.move (move.js).
export async function runMove({ on, plan, clip, root, conflict, reveal }, deps) {
  const { getShared, setShared } = deps;
  const now = deps.now ?? Date.now;
  if (typeof root !== "string" || root === "") return { ok: false, error: "root is required" };
  const i = await deps.fileOps.inspectMove({ on, src: plan.src, destDir: plan.destDir, root });
  if (!i.ok) return i;
  if (i.noop) return { ok: true, noop: true };
  const clearClipboard = () => {
    const cur = getShared("filer-pro.clipboard");
    if (cur && cur.path === clip.path && cur.at === clip.at && (cur.machine ?? null) === (clip.machine ?? null)) setShared("filer-pro.clipboard", null);
  };
  const batch = `${deps.newBatchId()}#1`;
  const item = {
    name: i.name, isDir: i.isDir, path: i.src, machine: on, trash: on === null, action: "move", direction: plan.direction, destDir: plan.destDir,
    ...(i.destIsDir !== undefined ? { destIsDir: i.destIsDir } : {}),
  };
  const cancelled = { ok: false, error: "Cancelled" };
  if (i.crossVolume) {
    const a = await deps.ask({ batch, item, choices: ["copy_instead", "cancel"], remaining: 1 });
    if (a?.choice !== "copy_instead") return cancelled;
    const r = await runTransfers({ direction: plan.direction, machine: plan.machine, paths: [plan.src], destDir: plan.destDir, conflict, reveal }, deps);
    // The copy only started: the Cut clipboard stays until it succeeds. jobs.js empties it when a job named in
    // copyJobs ends as done (a failed copy leaves the Cut intact).
    if (r.ok) {
      const ids = r.jobs.map((j) => j.id);
      const cur = getShared("filer-pro.clipboard");
      if (cur && cur.path === clip.path && cur.at === clip.at && (cur.machine ?? null) === (clip.machine ?? null)) {
        setShared("filer-pro.clipboard", { ...cur, copyJobs: ids });
        const jobsNow = getShared("filer-pro.jobs") || {};
        if (ids.length > 0 && ids.every((id) => jobsNow[id]?.state === "done")) clearClipboard();
      }
    }
    return r;
  }
  let choice = "new";
  if (i.exists) {
    if (conflict !== undefined) choice = conflict === "merge" ? "replace" : conflict;
    else {
      const a = await deps.ask({ batch, item, choices: ["replace", "keep_both", "cancel"], remaining: 1 });
      choice = a?.choice ?? "cancel";
    }
    if (choice === "cancel") return cancelled;
    if (choice === "replace" && i.replaceError) return { ok: false, error: i.replaceError };
  }
  // Names a running job already claims in the target folder (target side: up and remote write to a machine).
  const reserved = [];
  for (const j of Object.values(getShared("filer-pro.jobs") || {})) {
    if (j.state !== "running" || typeof j.destDir !== "string" || normalizePath(j.destDir) !== normalizePath(plan.destDir)) continue;
    const target = j.direction === "up" || j.direction === "remote" ? j.machine : null;
    if ((target ?? null) === on && typeof j.dest === "string") reserved.push(baseName(j.dest));
  }
  const out = await deps.fileOps.move({ on, src: plan.src, destDir: plan.destDir, root, choice, expect: i.src, expectDest: i.dest, reserved });
  if (out.ok) clearClipboard();
  changedAfter(setShared, now); // a failed move may have moved the old entry aside already
  return out;
}

// filer-pro.changed after an operation ran, whether it succeeded or not: a failure on a machine (a dropped connection,
// a folder deleted halfway) may still have changed something, and without a timer (issue #31) nothing else reloads the
// tree. Not sent when the user cancelled before anything ran.
function changedAfter(setShared, now, extra = {}) {
  setShared("filer-pro.changed", { at: now(), ...extra });
}

// Processing of one request. A download whose target exists or whose folder holds outside links
// goes through the same batch dialog as a click, unless the request answers it up front
// (conflict / links); the result is written after the answer.
// deps: { jobs, loadConfig: async () => ({download_folder}), getShared, setShared,
//         ask: async ({batch, item, choices, remaining}) => ({choice, apply_to_all}), newBatchId,
//         fileOps: { check, rename, remove, mkdir } (fileops.js), now }
export async function handleRequest(req, deps) {
  const { jobs, getShared, setShared } = deps;
  const now = deps.now ?? Date.now;
  switch (req.action) {
    case "status":
      return { ok: true, jobs: Object.values(getShared("filer-pro.jobs") || {}) };
    case "cancel":
      await jobs.cancel(req.job);
      return { ok: true };
    case "answer":
      setShared("filer-pro.answer", { batch: getShared("filer-pro.pending")?.batch ?? null, choice: req.choice, apply_to_all: req.apply_to_all });
      return { ok: true };
    case "upload":
      return runTransfers({
        direction: "up", machine: req.machine, paths: req.paths, destDir: req.folder, conflict: req.conflict, links: req.links, reveal: req.reveal,
      }, deps);
    case "download": {
      const destDir = req.dest_dir || (await deps.loadConfig()).download_folder;
      const r = await runTransfers({
        direction: "down", machine: req.machine, paths: [req.path], destDir, conflict: req.conflict, links: req.links, reveal: req.reveal,
      }, deps);
      return r.ok ? { ok: true, job: r.jobs[0] } : { ok: false, error: r.error };
    }
    case "copy": {
      const destDir = req.folder || (await deps.loadConfig()).download_folder;
      return runTransfers({ direction: "local", machine: null, paths: req.paths, destDir, conflict: req.conflict, reveal: req.reveal }, deps);
    }
    case "clip":
      setShared("filer-pro.clipboard", clipEntry({ on: req.machine, path: req.path, isDir: req.is_dir, at: now(), cut: req.cut }));
      return { ok: true };
    case "paste": {
      const clip = getShared("filer-pro.clipboard");
      const plan = pastePlan(clip, { on: req.machine ?? null, folder: req.folder });
      if (plan.error) return { ok: false, error: plan.error };
      if (plan.move) return runMove({ on: req.machine ?? null, plan, clip, root: req.root, conflict: req.conflict, reveal: req.reveal }, deps);
      return runTransfers({
        direction: plan.direction, machine: plan.machine, paths: [plan.src], destDir: plan.destDir,
        conflict: req.conflict, links: req.links, reveal: req.reveal,
      }, deps);
    }
    case "rename": {
      const out = await deps.fileOps.rename({ on: req.machine ?? null, path: req.path, root: req.root, name: req.name });
      changedAfter(setShared, now);
      return out;
    }
    case "mkdir": {
      const on = req.machine ?? null;
      const out = await deps.fileOps.mkdir({ on, path: req.path, name: req.name });
      // expand: the panel opens the parent so the new folder is visible.
      changedAfter(setShared, now, out.ok ? { expand: { machine: on, folder: req.path } } : {});
      return out;
    }
    case "delete": {
      const on = req.machine ?? null;
      const found = await deps.fileOps.check({ on, path: req.path, root: req.root });
      if (!found.ok) return { ok: false, error: found.error };
      if (req.confirm !== true) {
        // Only the answer "delete" deletes: everything else, also a closed dialog, is Cancelled.
        const a = await deps.ask({
          batch: `${deps.newBatchId()}#1`,
          item: { name: found.name, isDir: found.isDir, path: found.path, machine: on, trash: on === null },
          choices: ["delete", "cancel"], remaining: 1,
        });
        if (a?.choice !== "delete") return { ok: false, error: "Cancelled" };
      }
      // expect: the physical path shown in the dialog; remove checks again and refuses another one.
      const out = await deps.fileOps.remove({ on, path: req.path, root: req.root, expect: found.path });
      changedAfter(setShared, now); // a failed delete of a folder may have removed part of it
      return out;
    }
    case "open":
    case "mode":
      return askPanel(req, deps);
    default:
      return { ok: false, error: `Unknown action: ${req.action}` };
  }
}

// ---- open and mode: the panel shows a file like a click on its row, and switches Preview/Source.
// The request is handled by the lease holder, but shown by a panel copy: the holder posts it in
// shared("filer-pro.show") = { id, action, on, path, mode }, every panel copy answers in
// shared("filer-pro.shown") = { id, hit, result }. hit: the copy shows that machine and folder; a hit
// without result means "taken, still loading". A miss never overwrites a hit.
// The panel follows the focused terminal (location() in main.js) and a request must not move the
// user's focus: so only files below the folder the panel shows right now can be opened.
const MISS_WAIT_MS = 3000, LOAD_WAIT_MS = 30000;

// deps: { getShared, setShared, newBatchId, sleep(ms), now() }
export async function askPanel(req, deps) {
  const id = deps.newBatchId();
  const show = { id, action: req.action, ...(req.action === "open" ? { on: req.machine ?? null, path: req.path } : {}), ...(req.mode !== undefined ? { mode: req.mode } : {}) };
  deps.setShared("filer-pro.show", show);
  const start = deps.now();
  let answer = null;
  try {
    for (;;) {
      await deps.sleep(100);
      const a = deps.getShared("filer-pro.shown");
      if (a?.id === id) answer = a;
      if (answer?.hit && answer.result) return answer.result;
      const limit = answer?.hit ? LOAD_WAIT_MS : MISS_WAIT_MS;
      if (deps.now() - start >= limit) break;
    }
  } finally {
    // Only its own: a later request may have posted its show meanwhile.
    if (deps.getShared("filer-pro.show")?.id === id) deps.setShared("filer-pro.show", null);
  }
  if (answer?.hit) return { ok: false, error: "The panel did not finish loading the file" };
  return answer?.result ?? { ok: false, error: "The Filer Pro panel is not open" };
}

// A panel copy's answer (bus: { getShared, setShared }); result null = taken, still loading.
export function answerShow(bus, id, hit, result) {
  const cur = bus.getShared("filer-pro.shown");
  if (!hit && cur?.id === id && cur.hit) return;
  bus.setShared("filer-pro.shown", { id, hit, result });
}

// Can this panel copy ({ on, root, file }) serve the request? { hit: true, rel } or { hit: false, error }.
export function panelPlan(panel, show) {
  const where = (on) => on ?? "this computer";
  if (show.action === "mode") return panel.file ? { hit: true, rel: panel.file } : { hit: false, error: "No file is shown" };
  if (!panel.root) return { hit: false, error: "The panel shows no folder" };
  if ((show.on ?? null) !== (panel.on ?? null)) return { hit: false, error: `The panel shows ${where(panel.on)}, not ${where(show.on)}` };
  if (badSpelling(show.path)) return { hit: false, error: 'Path must not contain ".", ".." or "//"' };
  const prefix = panel.root === "/" ? "/" : `${panel.root}/`;
  if (!show.path.startsWith(prefix) || show.path.length === prefix.length) return { hit: false, error: `Not below the shown folder: ${panel.root}` };
  return { hit: true, rel: show.path.slice(prefix.length) };
}

// The result of an open once the file is loaded. state: { error?, mode, preview } of the panel.
export function openResult(shown, want, state) {
  const mode = state.mode ?? "source";
  if (state.error) return { ok: false, error: state.error, shown, mode };
  if (want === "preview" && mode !== "preview") return { ok: false, error: "No preview for this file", shown, mode };
  return { ok: true, shown, mode };
}

// The result of a mode switch; canPreview: the shown file has a preview.
export function modeResult(shown, want, canPreview) {
  if (want === "preview" && !canPreview) return { ok: false, error: "No preview for this file", shown, mode: "source" };
  return { ok: true, shown, mode: want };
}

// Answer written when a dialog is closed without a choice (Esc); null if it must not write anything.
// questionId: id of the question this dialog copy shows; pending/answer: current shared values.
export function closeAnswer(questionId, pending, answer) {
  if (questionId == null || pending?.batch !== questionId || answer?.batch === questionId) return null;
  return { batch: questionId, choice: "cancel", apply_to_all: false };
}

// One claimed request end to end; it never ends without a result file or a released claim.
// io: { readTextFile(path), writeResult(path, text), removeClaim(path), handle(req) }
export async function processRequest(dir, id, io) {
  let out;
  try {
    const text = await Promise.resolve(io.readTextFile(`${dir}/${id}.json`)).catch(() => null);
    if (text == null) out = { ok: false, error: "Cannot read request" };
    else {
      const req = parseRequest(text);
      out = req.error ? { ok: false, error: req.error } : await io.handle(req);
    }
  } catch (e) {
    out = { ok: false, error: String(e?.message ?? e) };
  }
  try {
    await io.writeResult(`${dir}/${id}.result.json`, resultText(out));
    return true;
  } catch {
    await Promise.resolve(io.removeClaim(`${dir}/${id}.claim`)).catch(() => {});
    return false;
  }
}
