// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { spaces, panes, focused, exec, hc, readTextFile, writeTextFile, watchFolder, theme, settings, window, shared, setShared, notify, props, appHome, home, nextCommand, openOverlay, closeOverlay, pickFolder, run, layout } from "herdr";
import * as fs from "fs/promises";
import { createJobs } from "./lib/jobs.js";
import { leaseNext, staleLegacyKeys } from "./lib/lease.js";
import { claim, processRequest, handleRequest, closeAnswer, panelPlan, answerShow, openResult, modeResult } from "./lib/requests.js";
import { loadConfig } from "./lib/config.js";
import { editInTerminal, openInEditor } from "./lib/editors.js";
import { createUpdateGate, updateCheck, fetchLatest, fetchRelease, localVersion, updateHint } from "./lib/update.js";
import { langOf, previewKind } from "./lib/langs.js";
import { extOf } from "./lib/langs.js";
import { createPerf, lagProbe, PERF_DIR, PERF_FILE } from "./lib/perf.js";
import { platform } from "./lib/platform.js";
import { openRegularFile, openChecked, openBundle } from "./lib/open.js";
import { markBundles, treeDir, sortsAsFolder, bundleIcon } from "./lib/bundles.js";
import { fileClick } from "./lib/clicks.js";
import { isBinaryName, explainUnreadable, nulReason, BINARY_MESSAGE } from "./lib/binary.js";
import { icon, BASE } from "./lib/icons.js";
import { withPanel, withoutLegacy, panelShown } from "./lib/panels.js";
import { dropRequest, dropTarget } from "./lib/droptarget.js";
import { createFileOps, successToast, validateName } from "./lib/fileops.js";
import { createMoveOps, moveToasts } from "./lib/move.js";
import { rowMenuItems, rootMenuItems, menuHeight, MENU_WIDTH } from "./lib/menuitems.js";
import { pasteState } from "./lib/clipboard.js";
import { pruneFolder, folderMissing, expandPath, visibleRows, ROW_H, TREE_PAD, LIST_SCRIPT, psListCommand, limitText } from "./lib/tree.js";
import { numbers } from "./lib/settings.js";
import { hideArgs, hiddenPath } from "./lib/hidden.js";
import { createReloadGate, fileHit } from "./lib/reload.js";
import { baseName, joinPath, parentOf, relativePath, shellPath, stemEnd } from "./lib/names.js";
import { PROBE_SCRIPT, parseProbe, probeFileGuarded, saveFile, saveCopy, bufferBytes, statusText, copyName, createHistory, mirrorName, scpSender } from "./lib/textedit.js";
import { equalBytes, bytesToBase64, base64ToBytes } from "./lib/textcodec.js";
import { writeClipboard } from "./lib/pasteboard.js";
import { createNameDialog, nameView } from "./ui/namedialog.js";
import { createPermsDialog, permsView, showProbe, PERMS_SIZE } from "./ui/permsdialog.js";
import { loaded, failed, canApply, setRecursive, counted, needsCount } from "./lib/permsstate.js";
import { formatChange, mismatchText } from "./lib/perms.js";
import { renameSpec, newFolderSpec } from "./lib/namespecs.js";
import { transfersBar } from "./ui/bar.js";
import { menuView } from "./ui/menu.js";
import { conflictView } from "./ui/conflict.js";
import { editTools, promptBar, statusBar } from "./ui/edit.js";
import { createSettingsDialog, settingsView, submitSettings, tilde } from "./ui/settings.js";

// The preview lives in ./preview/ and is only ever loaded here, with import(): a deleted or broken folder
// gives null and files open as plain source. A failure is not remembered, so putting the folder back works at the next click.
let previewModule = null;
const loadPreview = async () => (previewModule ??= await import("./preview/index.js").catch(() => null));

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
// The settings before the config file was read (and in copies that never read it): today's defaults.
const DEFAULTS = { ...numbers(null), node_path: "", svg_check: true, hide_system_files: true, hide_dotfiles: false, double_click_files: false, double_click_apps: true };
const MB = 1024 * 1024;
// How much of the open file a refresh flight reloads at its end (refresh opts.file, this.fileWanted): TEXT only reads and
// compares text (a watch batch that did not name the file: no exec), ALL also probes an image or PDF again (a change
// signal), NAMED also reads a file in an error state again (Refresh, a watch batch that names it, the opt-in timer): a
// change signal names no path, so it never re-reads a file that could not be shown (one more read over SSH each time).
const FILE_TEXT = 1, FILE_ALL = 2, FILE_NAMED = 3;
const lf = (text) => String(text ?? "").replace(/\r\n?/g, "\n");
// A wait for a timer: herdr gives a job about 0.5 s; a timer starts a new job, an awaited resolved promise does not.
const pauseOf = (cx) => () => new Promise((r) => cx.timer.after(0, () => r()));
// Title of the error toast per failed request action.
const FAILED = { download: "Download failed", upload: "Upload failed", copy: "Copy failed", paste: "Paste failed", rename: "Rename failed", mkdir: "New folder failed", delete: "Delete failed", clip: "Copy failed" };

// perFolder: the setting list_per_folder; the listing returns at most one entry more, so a cut folder is noticed.
// hide: the settings hide_system_files and hide_dotfiles; the listing leaves those entries out before it counts.
async function directory(path, on, perFolder, hide) {
  if (!on && window()?.platform === "windows") {
    const r = await exec("powershell", ["-NoProfile", "-Command", psListCommand(path, perFolder, hide)]);
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  }
  const r = await exec("sh", ["-c", LIST_SCRIPT, "files", path, String(perFolder), ...hideArgs(hide)], { on });
  if (r.code !== 0) throw Object.assign(new Error(r.stderr || "Cannot list this folder"), { missing: folderMissing(r) });
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return markBundles(out, { on, platform: window()?.platform }); // macOS packages (lib/bundles.js), local only
}

// False once this build of the mod was reloaded or closed. Herdr ends an old build's async loop only at its next cx use
// (AsyncContext throws then); a loop that only awaits nextCommand() or watchFolder() calls this after every wait, so it
// stops instead of running on with the old code. cx.phase() is a plain read: no redraw, no side effect.
function live(cx) {
  try { cx.phase(); return true; } catch { return false; }
}

export default class FilerPro extends View {
  init(_props, cx) {
    if (props()?.overlay) {
      this.batchId = shared("filer-pro.pending")?.batch ?? null;
      if (props().view === "rename" || props().view === "mkdir") {
        this.fileOps = createFileOps({ exec, localPlatform: () => window()?.platform });
        const spec = props().view === "rename" ? renameSpec({ name: baseName(props().path), isDir: props().isDir === true }) : newFolderSpec();
        this.dialog = createNameDialog(spec, { onSubmit: (name, cx) => this.submitName(name, cx) }, cx);
      }
      if (props().view === "permissions") {
        this.fileOps = createFileOps({ exec, localPlatform: () => window()?.platform });
        this.perms = createPermsDialog({ name: baseName(props().path), isDir: props().isDir === true }, cx);
        this.loadPermissions(cx);
      }
      if (props().view === "settings") {
        // Every InputState of the dialog is created here, from the snapshot the opener stored (openSettings).
        this.settings = createSettingsDialog(shared("filer-pro.settings"), cx);
      }
      if (props().view === "file") {
        // The fullscreen copy of one file: reads it itself with the panel's show(), under a fixed context.
        this.context = { key: null, cwd: props().root, on: props().machine ?? null, fixed: true };
        this.root = this.context.cwd; this.on = this.context.on;
        this.show(props().path, cx, { mode: props().mode, page: props().page, pages: props().pages, force: props().force });
        this.startFullscreen(cx);
      }
      return;
    }
    if (props()?.button) {
      // The tab bar shows a button only for ids in workspace.panels.
      // The renamed predecessor entry is dropped once its layout blocks are gone (only a mod can change shared values).
      const panels = withoutLegacy(withPanel(shared("workspace.panels"), "filer-pro"), layout());
      if (panels !== shared("workspace.panels")) setShared("workspace.panels", panels);
      this.button = true;
      // `<mod>.<command>` reaches only shown copies: when the panel is hidden, this copy answers "reveal".
      cx.spawn(async (cx) => {
        for (;;) {
          let command;
          try { command = await nextCommand(); } catch { await cx.sleep(1000); continue; }
          if (!live(cx)) return;
          if (command === "reveal" && !panelShown(layout(), "filer-pro")) this.revealLast();
        }
      });
      return;
    }
    this.cfg = DEFAULTS;
    this.jobs = createJobs({
      exec, hc, readTextFile, localPlatform: () => window()?.platform, getShared: shared, setShared, notify, now: Date.now, appHome, home, settings: () => this.cfg,
      newId: () => (Math.random().toString(36).slice(2) + "00000000").slice(0, 8),
    });
    const base = createFileOps({ exec, localPlatform: () => window()?.platform });
    this.fileOps = { ...base, ...createMoveOps({ exec, localPlatform: () => window()?.platform, check: base.check, trashDir: platform.trashDir(home()) }) };
    this.reload = createReloadGate({ now: Date.now, at: shared("filer-pro.changed")?.at ?? null });
    this.doc = null; this.mode = "source"; this.previewer = null; this.previewWidth = 0; this.colorKey = null; this.perf = null; this.diagrams = null;
    this.configSeen = shared("filer-pro.config")?.at ?? null;
    this.packageSeen = shared("filer-pro.package")?.id ?? null; // an old Show Package Contents request is not applied again
    cx.spawn(async (cx) => {
      const cfg = this.cfg = await loadConfig(readTextFile, appHome, home);
      // The first listing ran with the defaults: other list settings reload the tree once more (no timer to wait for).
      if (["list_per_folder", "list_total", "tree_depth", "hide_system_files", "hide_dotfiles"].some((k) => cfg[k] !== DEFAULTS[k])) this.refresh(cx);
      this.version = await this.readVersion();
      if (cfg.perf) await this.startPerf(cx);
    });
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    // The optional periodic reload, every refresh_seconds (setting, 0 = off, the default: issue #31, no exec while idle):
    // a 1 s tick that checks the time itself, so a changed interval applies without a restart. It skips while a reload
    // runs, so a slow machine never gets a second one stacked. The config is read again on the way (hand edits).
    this.refreshedAt = Date.now();
    cx.timer.every(1000, cx => {
      const every = this.conf.refresh_seconds;
      if (!every || this.loading || Date.now() - this.refreshedAt < every * 1000) return;
      this.refreshedAt = Date.now();
      this.reloadConfig(cx, { file: FILE_NAMED });
    });
    cx.timer.every(250, cx => { this.checkShow(cx); this.pollReload(cx); this.checkConfig(cx); this.mirrorUnsaved(cx); this.pollFull(cx); });
    this.drive(cx);
  }

  // The current settings of this copy: the config read last, or the defaults before the first read.
  get conf() { return this.cfg ?? DEFAULTS; }

  // Reads the config again, then reloads the tree, so new list limits apply to the folders already shown.
  // opts (refresh): file also reloads the open file, force probes it again even when its text is unchanged.
  reloadConfig(cx, opts) {
    cx.spawn(async (cx) => {
      try { this.cfg = await loadConfig(readTextFile, appHome, home); } catch {}
      this.refresh(cx, opts);
      cx.notify();
    });
  }

  // The settings dialog saved (shared filer-pro.config): read the config at once instead of at the next periodic reload.
  checkConfig(cx) {
    const at = shared("filer-pro.config")?.at ?? null;
    if (at === this.configSeen) return;
    this.configSeen = at;
    this.reloadConfig(cx);
  }

  // Opens the settings dialog with a snapshot of the config: the parsed file (unknown keys, ~/ as written), what
  // loadConfig made of it, the installed version and the config path to show. The dialog's init reads it from shared, synchronously.
  async openSettings() {
    let raw = null, broken = false;
    try {
      const text = await readTextFile(`${appHome()}/filer-pro.json`).catch(() => null);
      raw = text == null ? null : JSON.parse(text);
      broken = text != null && (raw === null || typeof raw !== "object" || Array.isArray(raw));
    } catch { broken = true; raw = null; }
    const config = await loadConfig(readTextFile, appHome, home);
    const version = await this.readVersion();
    setShared("filer-pro.settings", { config, raw: broken ? null : raw, broken, version, home: home(), configPath: tilde(`${appHome()}/filer-pro.json`, home()) });
    openOverlay({ mod: "filer-pro", props: { view: "settings" }, kind: "dialog", modal: true, width: 620, height: 0.86 });
  }

  // Perf mode ("perf": true): timings in memory, rewritten to PERF_FILE every 5 s (only documented file calls are used).
  // Off by default: then there is no timer, no measurement and no file.
  async startPerf(cx) {
    await fs.mkdir(`${appHome()}/${PERF_DIR}`, { recursive: true }).catch(() => {});
    const perf = createPerf({ now: Date.now }), probe = lagProbe({ now: Date.now, perf, interval: 100 });
    this.perf = perf;
    cx.timer.every(100, () => probe());
    cx.timer.every(5000, () => { if (perf.drain().length) fs.writeFile(`${appHome()}/${PERF_FILE}`, perf.text()).catch(() => {}); });
  }

  // Exactly one mod copy (the lease holder) recovers and ticks jobs and handles request files.
  drive(cx) {
    if (props()?.overlay) return;
    const me = (Math.random().toString(36).slice(2) + "00000000").slice(0, 8);
    const dir = `${appHome()}/filer-pro/requests`;
    const jobs = this.jobs;
    const wakers = [];
    const nap = () => new Promise((resolve) => wakers.push(resolve));
    let holding = false, busy = false, scanning = false, again = false;
    const updates = createUpdateGate(Date.now);

    const scan = async () => {
      if (scanning) { again = true; return; }
      scanning = true;
      try {
        do {
          again = false;
          // fs.readdir, not an `ls` exec: this safety scan runs every 2 s and must not start a process (issue #31).
          const names = ((await fs.readdir(dir).catch(() => null)) ?? []).filter((n) => !n.startsWith(".")).sort(); // as ls -1
          const have = new Set(names);
          for (const name of names) {
            if (!name.endsWith(".json") || name.endsWith(".result.json")) continue;
            const id = name.slice(0, -5);
            if (have.has(`${id}.claim`) || have.has(`${id}.result.json`)) continue;
            if (!(await claim(dir, id, writeTextFile))) continue;
            // Not awaited: a request that waits for the dialog must not block the `answer` request.
            const ui = id.startsWith("ui-");
            processRequest(dir, id, {
              readTextFile: (path) => readTextFile(path).catch(() => null),
              writeResult: (path, text) => fs.writeFile(path, text),
              removeClaim: (path) => exec("rm", ["-f", "--", path], { on: null }),
              handle: async (req) => {
                let out;
                const failed = FAILED[req.action];
                try {
                  out = await handleRequest(req, {
                    jobs, getShared: shared, setShared, loadConfig: () => loadConfig(readTextFile, appHome, home),
                    ask: (pending) => this.ask(pending), newBatchId: () => this.newId(),
                    fileOps: this.fileOps, now: Date.now, sleep: (ms) => cx.sleep(ms),
                  });
                } catch (e) {
                  if (ui) notify({ title: failed ?? "Request failed", body: String(e?.message ?? e), level: "error" });
                  throw e;
                }
                if (ui && out.errors) {
                  for (const e of out.errors) notify({ title: failed, body: e.error, level: "error" });
                } else if (ui && !out.ok && out.error !== "Cancelled") notify({ title: failed ?? "Request failed", body: out.error, level: "error" });
                const toast = ui && out.ok ? successToast(req, out) : null;
                if (toast) notify(toast);
                if (ui && out.ok) for (const t of moveToasts(out)) notify(t);
                return out;
              },
            }).then(() => ui && exec("rm", ["-f", "--", `${dir}/${id}.json`, `${dir}/${id}.claim`, `${dir}/${id}.result.json`], { on: null })).catch(() => {});
          }
        } while (again);
      } finally { scanning = false; }
    };

    let cleaned = false;
    const beat = () => {
      wakers.splice(0).forEach((w) => w());
      const next = leaseNext(shared("filer-pro.lease"), me, Date.now());
      if (!next.mine) { holding = false; updates.take(false); return; }
      if (next.write) setShared("filer-pro.lease", { owner: next.owner, at: next.at });
      if (!cleaned) { cleaned = true; for (const k of staleLegacyKeys(shared)) setShared(k, null); }
      if (updates.take(true)) cx.spawn(async (cx) => { try { await this.updatePass(cx); } catch {} finally { updates.done(); } });
      if (holding) { scan().catch(() => {}); return; }
      holding = true;
      busy = true;
      jobs.recover().catch(() => {}).then(() => { busy = false; return scan(); }).catch(() => {});
    };

    beat();
    cx.timer.every(2000, () => beat());
    cx.timer.every(1000, () => {
      if (!holding || busy) return;
      busy = true;
      const keep = this.conf.keep_done_seconds * 1000; // the same setting as clearFinished's, not a second number
      if (Object.values(shared("filer-pro.jobs") || {}).some(j => (j.state === "done" || j.state === "cancelled") && Date.now() - j.finishedAt > keep)) jobs.clearFinished(keep);
      jobs.tick().catch(() => {}).then(() => { busy = false; });
    });
    cx.timer.every(300, () => this.checkAnswer());
    // Both loops check cx after every wait (live): they would outlive a reload of the mod otherwise.
    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", dir], { on: null }).catch(() => {});
      if (!live(cx)) return;
      if (holding) scan().catch(() => {});
      for (;;) {
        try { await watchFolder(dir); } catch { await nap(); if (!live(cx)) return; continue; }
        if (!live(cx)) return;
        if (holding) scan().catch(() => {});
      }
    });
    cx.spawn(async (cx) => {
      for (;;) {
        let command;
        try { command = await nextCommand(); } catch { await nap(); if (!live(cx)) return; continue; }
        if (!live(cx)) return;
        if (command === "scan" && holding) scan().catch(() => {});
        else if (command === "reveal") this.revealLast();
      }
    });
  }

  // The installed version from this mod's own mod.json (null when unreadable: then no check and no hint).
  readVersion() {
    return readTextFile(`${appHome()}/${BASE}/mod.json`).then(localVersion, () => null);
  }

  // Lease holder, at most hourly (lib/update.js): reads the config fresh, so update_check false means no request;
  // a request goes out only when the last one is 24 h old. The result goes to shared, for every panel copy.
  async updatePass(cx, fetchFn = globalThis.fetch) {
    const cfg = await loadConfig(readTextFile, appHome, home);
    const local = cfg.update_check ? await this.readVersion() : null;
    const out = await updateCheck({ enabled: cfg.update_check, state: shared("filer-pro.update"), local, now: Date.now(), fetch: () => fetchLatest(fetchFn, (ms) => cx.sleep(ms)) });
    if (out.state !== undefined) setShared("filer-pro.update", out.state);
  }

  // The Filer Pro button beside the tab bar's Files and Changes (props { button: true }).
  toolbar(t) {
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    // panel-body is a stack (one panel at a time) or a column (panels stacked, each toggled).
    const stack = body?.type === "stack", ids = stack ? [body?.active] : (body?.children ?? []).filter((c) => !c.hidden).map((c) => c.id);
    const on = !!panel && !panel.hidden && ids.includes("filer-pro");
    return h_flex().size_full().pr(10).items_center().justify_end().bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().id("panel-filer-pro").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => {
          if (!panel || !body) { notify({ title: "Filer Pro", body: "Add the filer-pro block to panel-body", level: "error" }); return; }
          if (stack) {
            if (on) run("layout.hide", { id: "panel" });
            else { run("layout.select", { stack: "panel-body", child: "filer-pro" }); run("layout.show", { id: "panel" }); }
            return;
          }
          const now = panel?.hidden ? [] : ids, want = on ? now.filter((x) => x !== "filer-pro") : [...now, "filer-pro"];
          if (!want.length) { run("layout.hide", { id: "panel" }); return; }
          for (const c of body.children) run(want.includes(c.id) ? "layout.show" : "layout.hide", { id: c.id });
          run("layout.show", { id: "panel" });
        })
        .child(svg(`${BASE}/folder.svg`).size(14).flex_none()).child("Filer Pro"));
  }

  // Shows the last download in the Finder (toast action "filer-pro.reveal").
  revealLast() {
    const last = shared("filer-pro.last_download");
    if (last) { const [cmd, args] = platform.revealArgs(last); exec(cmd, args).catch(() => {}); }
  }

  newId() { return (Math.random().toString(36).slice(2) + "00000000").slice(0, 8); }

  // A UI action is a request file for the lease holder: one code path for clicks and test requests.
  async request(fields) {
    const action = fields.action ?? "download";
    await fs.writeFile(`${appHome()}/filer-pro/requests/ui-${this.newId()}.json`, JSON.stringify({ action, ...fields }))
      .catch((e) => notify({ title: FAILED[action] ?? "Request failed", body: String(e?.message ?? e), level: "error" }));
  }

  // Lease holder: shows the dialog and waits for shared("filer-pro.answer") of this batch (5 minutes at most).
  ask(pending) {
    const turn = (this.asking ?? Promise.resolve()).then(() => new Promise((resolve) => {
      setShared("filer-pro.answer", null);
      setShared("filer-pro.pending", pending);
      const overlay = openOverlay({ mod: "filer-pro", props: { view: "conflict" }, kind: "dialog", modal: true, width: 440, height: 240 });
      this.waiter = { batch: pending.batch, overlay, at: Date.now(), resolve };
    }));
    this.asking = turn.catch(() => {});
    return turn;
  }

  checkAnswer() {
    const w = this.waiter, a = shared("filer-pro.answer");
    if (!w) return;
    const answered = a?.batch === w.batch, expired = Date.now() - w.at > 300000;
    if (!answered && !expired) return;
    this.waiter = null;
    setShared("filer-pro.pending", null);
    setShared("filer-pro.answer", null);
    try { closeOverlay(w.overlay); } catch {}
    w.resolve(answered ? { choice: a.choice, apply_to_all: a.apply_to_all === true } : { choice: "cancel" });
  }

  // Overlay copies draw only their own view (menu, conflict).
  overlayView(cx) {
    const t = theme(), p = props();
    const close = () => { try { closeOverlay(p.overlay); } catch {} };
    if (p.view === "menu") {
      const send = (fields) => {
        this.request(p.machine ? { machine: p.machine, path: p.path, ...fields } : { action: "copy", paths: [p.path], ...(fields.dest_dir ? { folder: fields.dest_dir } : {}) });
        close();
      };
      const act = (fields) => { this.request({ ...(p.machine ? { machine: p.machine } : {}), ...fields }); close(); };
      const state = { paste: pasteState(shared("filer-pro.clipboard"), p.machine ?? null, p.folder), isDir: p.isDir === true, remote: Boolean(p.machine), windows: window()?.platform === "windows", bundle: p.bundle === true, contents: p.contents === true };
      const items = p.scope === "root" ? rootMenuItems(state) : rowMenuItems(state);
      // Open and Open in Preview: locally after the checks in open.js (the popup closes once open returned);
      // remote the file is downloaded first (download_folder, conflict dialog) and opened by afterDownload.
      const openWith = (app) => {
        // A local macOS package (lib/bundles.js) opens like a double click in the Finder; Open in Preview is dimmed for it.
        if (!p.machine && p.bundle === true && app === "default") { openBundle(p.path, { exec, notify, platform }).finally(close); return; }
        if (!p.machine) { openChecked(p.path, { app }, { exec, notify, platform }).finally(close); return; }
        this.request({ machine: p.machine, path: p.path, reveal: app === "preview" ? "preview" : "open" });
        close();
      };
      const toClipboard = (text, cx) => { writeClipboard(text, { cx, exec, notify, platform }).finally(close); };
      // Open in Editor and Edit in Terminal (lib/editors.js): the popup closes once the lookup and the start returned.
      const config = () => loadConfig(readTextFile, appHome, home);
      const editor = (action, title, deps) => {
        action({ machine: p.machine ?? null, path: p.path }, { loadConfig: config, notify, ...deps })
          .catch((e) => notify({ title: `${title} failed`, body: String(e?.message ?? e), level: "error" })).finally(close);
      };
      return menuView(t, items, {
        open: () => openWith("default"),
        open_preview: () => openWith("preview"),
        open_editor: () => editor(openInEditor, "Open in Editor", { hc, exec, home }),
        edit_terminal: () => editor(editInTerminal, "Edit in Terminal", { focused, spaces, run }),
        // dimmed on a machine (rowMenuItems remote): Show in Finder would download first; Cmd+click still does
        reveal: () => {
          if (p.machine) { close(); return; }
          const [cmd, args] = platform.revealArgs(p.path);
          Promise.resolve(exec(cmd, args)).catch(() => {}).finally(close);
        },
        // The panel that shows the package expands or collapses it (pollPackage).
        package_contents: () => { setShared("filer-pro.package", { id: this.newId(), machine: p.machine ?? null, path: p.path, show: p.contents !== true }); close(); },
        download: () => send({}),
        download_to: () => { pickFolder({ prompt: "Download here" }).then(dir => { if (dir) send({ dest_dir: dir }); else close(); }).catch(close); },
        copy: () => act({ action: "clip", path: p.path, is_dir: p.isDir === true }),
        cut: () => act({ action: "clip", path: p.path, is_dir: p.isDir === true, cut: true }),
        paste: () => act({ action: "paste", folder: p.folder, root: p.root }),
        copy_path: (cx) => toClipboard(shellPath(p.path), cx),
        copy_relative_path: (cx) => toClipboard(shellPath(relativePath(p.root, p.path)), cx),
        new_folder: () => { close(); openOverlay({ mod: "filer-pro", props: { view: "mkdir", machine: p.machine, path: p.folder }, kind: "dialog", modal: true, width: 440, height: 220 }); },
        // isDir only picks the selection: a package's name is selected without its extension, as for a file.
        rename: () => { close(); openOverlay({ mod: "filer-pro", props: { view: "rename", machine: p.machine, path: p.path, root: p.root, isDir: p.isDir === true && p.bundle !== true }, kind: "dialog", modal: true, width: 440, height: 220 }); },
        permissions: () => { close(); openOverlay({ mod: "filer-pro", props: { view: "permissions", machine: p.machine, path: p.path, root: p.root, isDir: p.isDir === true }, kind: "dialog", modal: true, ...PERMS_SIZE }); },
        delete: () => act({ action: "delete", path: p.path, root: p.root }),
        // The popup closes once the dialog is open (the snapshot is read first, as editor() does).
        settings: () => { this.openSettings().catch((e) => notify({ title: "Settings", body: String(e?.message ?? e), level: "error" })).finally(close); },
      });
    }
    if (p.view === "settings" && this.settings) {
      return settingsView(t, this.settings, {
        onCancel: close,
        onSave: (cx) => submitSettings(this.settings, { readTextFile, writeTextFile, path: `${appHome()}/filer-pro.json` }, cx).then((saved) => {
          if (!saved) return;
          setShared("filer-pro.config", { at: Date.now() }); // every panel copy reads the config again (checkConfig)
          close();
        }),
        onCheck: (cx) => this.checkNow(cx),
        onChoose: (cx) => this.chooseDownloadFolder(cx),
      }, shared("filer-pro.update"));
    }
    if (p.view === "rename" || p.view === "mkdir") return nameView(t, this.dialog, { onCancel: close, onSubmit: (name, cx) => this.submitName(name, cx) });
    if (p.view === "permissions" && this.perms) {
      return permsView(t, this.perms, {
        onCancel: close,
        onApply: (cx) => this.applyPermissions(cx),
        onRecursive: (cx) => this.toggleRecursive(cx),
      });
    }
    if (p.view === "file") return this.fileOverlay(t, cx);
    const pending = shared("filer-pro.pending");
    if (p.view !== "conflict" || !pending) return div();
    return conflictView(t, pending, { all: this.all }, {
      onChoose: (choice) => { setShared("filer-pro.answer", { batch: pending.batch, choice, apply_to_all: this.all === true }); close(); },
      onToggleAll: (cx) => { this.all = !this.all; cx.notify(); },
    });
  }

  // Settings dialog, Check now: one request to GitHub from this copy, also with the daily check off (a click asks
  // for it). A result is stored in shared filer-pro.update for the panels while the daily check is on (the lease
  // holder's next pass then sees a fresh check); a failure keeps the last known release.
  checkNow(cx, fetchFn = globalThis.fetch) {
    const s = this.settings;
    if (!s || s.check.phase === "checking") return;
    s.check = { phase: "checking" };
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await fetchRelease(fetchFn, (ms) => cx.sleep(ms));
      if (r.error) s.check = { phase: "failed" };
      else {
        const state = { at: Date.now(), local: s.version, latest: r.tag };
        if (s.version && shared("filer-pro.settings")?.config?.update_check !== false) setShared("filer-pro.update", state);
        s.check = { phase: "done", state };
      }
      cx.notify();
    });
  }

  // Settings dialog, Choose…: the system folder picker; a folder in the home folder is written with ~/.
  chooseDownloadFolder(cx) {
    const f = this.settings?.fields.download_folder;
    if (!f) return;
    cx.spawn(async (cx) => {
      const dir = await pickFolder({ prompt: "Choose" }).catch(() => null);
      if (!dir) return;
      f.value = tilde(dir, this.settings.home);
      f.input.set_value(f.value);
      f.error = null;
      cx.notify();
    });
  }

  // The rename and new-folder dialogs do the work themselves (not through a request file): they must show a
  // refusal in their own error line and stay open with the typed name, and only a success closes them.
  async submitName(name, cx) {
    const p = props(), r = this.dialog, mkdir = p.view === "mkdir";
    if (r.busy) return;
    r.busy = true; r.error = null; cx?.notify();
    let out;
    try { out = mkdir ? await this.fileOps.mkdir({ on: p.machine ?? null, path: p.path, name }) : await this.fileOps.rename({ on: p.machine ?? null, path: p.path, root: p.root, name }); }
    catch (e) { out = { ok: false, error: String(e?.message ?? e) }; }
    r.busy = false;
    // Also after a failure: on a machine it may still have happened (lib/requests.js changedAfter).
    if (!out.ok) { setShared("filer-pro.changed", { at: Date.now() }); r.error = out.error; cx?.notify(); return; }
    // expand: the panel opens the parent folder, so the new folder is visible.
    setShared("filer-pro.changed", { at: Date.now(), ...(mkdir ? { expand: { machine: p.machine ?? null, folder: p.path } } : {}) });
    const toast = successToast({ action: mkdir ? "mkdir" : "rename", path: p.path }, out);
    if (toast) notify(toast);
    try { closeOverlay(p.overlay); } catch {}
  }

  // Permissions dialog: read the mode and owner of the entry (behind a link: of its target).
  loadPermissions(cx) {
    const p = props(), s = this.perms;
    cx.spawn(async (cx) => {
      let out;
      try { out = await this.fileOps.permissions({ on: p.machine ?? null, path: p.path }); }
      catch (e) { out = { ok: false, error: String(e?.message ?? e) }; }
      if (!out.ok) failed(s, out.error);
      else { loaded(s, out); showProbe(s, s); }
      cx.notify();
    });
  }

  // "Apply to enclosed items": the first tick counts the entries inside (bounded, may stay unknown) for the notes; Apply
  // does not wait for it.
  toggleRecursive(cx) {
    const p = props(), s = this.perms;
    setRecursive(s, !s.recursive);
    if (needsCount(s)) {
      s.counting = true;
      cx.spawn(async (cx) => {
        let n = null;
        try { n = await this.fileOps.permissionsCount({ on: p.machine ?? null, path: p.path }); } catch {}
        counted(s, n);
        cx.notify();
      });
    }
    cx.notify();
  }

  // Apply: writes at once (the warnings were shown live). A refusal stays in the dialog; a result that differs from the
  // request (the system dropped or kept a bit) is reported as a warning after the row reloaded.
  async applyPermissions(cx) {
    const p = props(), s = this.perms;
    if (!canApply(s)) return;
    s.busy = true; s.error = null; cx?.notify();
    let out;
    try { out = await this.fileOps.chmod({ on: p.machine ?? null, path: p.path, root: p.root, mode: s.mode, recursive: s.recursive }); }
    catch (e) { out = { ok: false, error: String(e?.message ?? e) }; }
    s.busy = false;
    setShared("filer-pro.changed", { at: Date.now() }); // also after a failure: a recursive change may have run halfway
    if (!out.ok) { s.error = out.error; cx?.notify(); return; }
    const name = baseName(p.path);
    if (out.mismatch) notify({ title: "Permissions differ from the request", body: mismatchText(name, out.requested, out.mode), level: "warning" });
    else notify({ title: "Permissions changed", body: `${name}: ${formatChange(s.original, s.mode)}${s.recursive ? " (with everything inside)" : ""}`, level: "success" });
    try { closeOverlay(p.overlay); } catch {}
  }

  // Esc or closing the dialog without a choice counts as Cancel.
  // A dirty edit buffer is written to unsaved/ first (the app closes the dialog or panel without asking).
  async close() {
    const e = this.edit;
    if (e) {
      if (e.dirty) await this.keepUnsaved(e);
      else this.dropMirror(e);
      this.edit = null;
      this.releaseEdit(e);
    }
    if (props()?.view === "file") {
      if (props().full) { this.fullState = "closed"; setShared("filer-pro.fullscreen", { id: props().full, state: "closed", at: Date.now() }); }
      this.code?.release(); this.code = null; this.file = null; this.doc = null; this.loader = null; return;
    }
    if (props()?.view !== "conflict") return;
    const a = closeAnswer(this.batchId, shared("filer-pro.pending"), shared("filer-pro.answer"));
    if (a) setShared("filer-pro.answer", a);
  }

  // Local only (a machine has no folder watch; it reloads on the triggers of refresh, issue #31). A batch that names
  // the open file or a folder above it reloads the file too.
  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try {
        while (this.context === context) {
          const paths = await watchFolder(root);
          if (!this.current(context)) continue;
          // Text is read and compared on every batch (a local read, no exec: a symlinked root may name the file
          // differently); an image or PDF is probed again only when the batch names it or a folder above it.
          this.refresh(cx, { file: !this.file ? 0 : fileHit(paths, joinPath(this.root, this.file)) ? FILE_NAMED : FILE_TEXT });
        }
      }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  // An overlay copy has a fixed context: the focused terminal may change while it is open.
  current(context) {
    return this.context === context && (context.fixed || key() === context.key);
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    let entries;
    try {
      entries = await directory(path ? joinPath(root, path) : root, on, this.conf.list_per_folder, this.conf);
    } catch (e) {
      // An open subfolder that was renamed or deleted just leaves the tree, with everything below it.
      if (path && e?.missing && this.current(context)) { pruneFolder(this.folders, this.entries, path); return; }
      throw e;
    }
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const { list_per_folder: perFolder, list_total: total } = this.conf;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(perFolder, total - used))).sort((a, b) => Number(sortsAsFolder(b)) - Number(sortsAsFolder(a)) || a.name.localeCompare(b.name)));
    if (entries.length > perFolder || used + entries.length > total) this.limited = true;
  }

  // Reloads the tree (listing and git marks) of the shown folder; opts.file also the open file afterwards (reloadOpen),
  // opts.force probes it even when its text is unchanged. One flight at a time: a call during a reload is remembered
  // and runs once when it ends, so triggers never stack and none is lost (issue #31). All in cx.spawn: a slow machine
  // never blocks drawing.
  refresh(cx, { file = 0, force = false } = {}) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.edit?.dirty) return; // the buffer stays with its file until it is saved or discarded
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, packages: this.packages, file: this.file, lastOpened: this.lastOpened });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders); this.packages = new Set(saved?.packages);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false; this.again = false; this.fileWanted = 0; this.fileForce = false; this.lastOpened = saved?.lastOpened ?? null;
      if (saved?.file) this.show(saved.file, cx); // read fresh: no file reload needed
      file = 0; force = false;
    }
    this.fileWanted = Math.max(this.fileWanted ?? 0, file === true ? FILE_ALL : file || 0);
    if (force) this.fileForce = true;
    if (!cwd) return;
    if (this.loading) { this.again = true; return; }
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        // An open folder that a hide setting now hides leaves the tree, with everything below it (it would still use up list_total).
        for (const path of [...this.folders]) if (hiddenPath(path, this.conf)) pruneFolder(this.folders, this.entries, path);
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, this.conf.list_total)) {
            const xy = entry.slice(0, 2);
            marks[joinPath(top.stdout.trim(), entry.slice(3))] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally {
        if (this.context === context) this.loading = false;
        cx.notify();
        // The end of a flight: a trigger from meanwhile runs the next one; else the open file follows (after the tree,
        // so this copy never has two commands on a machine at once).
        if (this.context === context && this.current(context)) {
          if (this.again) { this.again = false; this.refresh(cx); }
          else if (this.fileWanted) {
            const opts = { force: Boolean(this.fileForce), textOnly: this.fileWanted === FILE_TEXT, named: this.fileWanted === FILE_NAMED };
            this.fileWanted = 0; this.fileForce = false;
            this.reloadOpen(cx, opts);
          }
        }
      }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
      // A collapsed package is a file row again (lib/bundles.js), and so is every package shown below it.
      for (const p of [...(this.packages ?? [])]) if (p === path || p.startsWith(path + "/")) this.packages.delete(p);
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  // Show Package Contents (show true) expands a macOS package like a folder; Hide (false) collapses it, and it is a
  // file row again. path: relative to the root.
  showPackage(path, show, cx) {
    this.packages ??= new Set();
    if (show) {
      this.packages.add(path);
      if (!this.folders.has(path)) this.toggle(path, cx);
    } else if (this.folders.has(path)) this.toggle(path, cx);
    else this.packages.delete(path);
  }

  // The menu copy asks through shared("filer-pro.package") = { id, machine, path, show }: this copy applies it once,
  // when it shows that machine and a folder above the path. Called from render, where cx.notify() throws (and the
  // host shows that as an error toast): showPackage runs in a task, whose cx may redraw.
  pollPackage(cx) {
    const r = shared("filer-pro.package");
    if (!r?.id || r.id === this.packageSeen) return;
    this.packageSeen = r.id;
    const rel = expandPath({ machine: r.machine ?? null, folder: r.path }, this.root, this.on);
    if (rel) cx.spawn(async (cx) => this.showPackage(rel, r.show === true, cx));
  }

  // The loaded entry of a path relative to the root, or undefined.
  entryAt(path) {
    const name = baseName(path);
    return this.entries?.get(parentOf(path) ?? "")?.find((e) => e.name === name);
  }

  // Request actions open and mode (askPanel in lib/requests.js): this copy answers when it shows the machine
  // and a folder above the file. It never changes what the panel follows (the focused terminal).
  checkShow(cx) {
    const s = shared("filer-pro.show");
    if (!s?.id || s.id === this.showSeen) return;
    this.showSeen = s.id;
    if (key() !== this.context?.key) this.refresh(cx);
    const bus = { getShared: shared, setShared };
    const plan = panelPlan({ on: this.on, root: this.root, file: this.file }, s);
    if (!plan.hit) { answerShow(bus, s.id, false, { ok: false, error: plan.error }); return; }
    if (s.action === "mode" && this.edit) { answerShow(bus, s.id, true, { ok: false, error: "Leave edit mode first" }); return; }
    if (s.action !== "mode" && this.edit?.dirty) { answerShow(bus, s.id, true, { ok: false, error: "Unsaved changes in the open file" }); return; }
    if (s.action === "mode") {
      if (this.doc?.kind === "image" || this.doc?.kind === "pdf") { answerShow(bus, s.id, true, { ok: false, error: this.doc.kind === "pdf" ? "PDFs have no source view" : "Images have no source view", mode: "preview" }); return; }
      const out = modeResult(joinPath(this.root, this.file), s.mode, Boolean(this.previewer && this.doc));
      if (out.ok) { this.mode = out.mode; cx.notify(); }
      answerShow(bus, s.id, true, out);
      return;
    }
    answerShow(bus, s.id, true, null); // taken, the file is loading
    this.show(plan.rel, cx, { mode: s.mode, onDone: (state) => answerShow(bus, s.id, true, openResult(s.path, s.mode, state)) });
    cx.notify();
  }

  // opts (request action open): mode "source" keeps the source although a preview exists; onDone(state)
  // gets { error, mode, preview } once the file is on screen (or could not be shown).
  show(path, cx, opts = {}) {
    this.leaveEdit(); this.editCheck = null;
    this.code?.release(); this.code = null; this.file = path; this.fileError = null; this.openable = false; this.shownText = null; this.docText = null; this.waiting = null;
    if (path) this.lastOpened = path; // marked in the tree after back (show(null) keeps it)
    this.doc = null; this.mode = "source"; this.previewer = null; this.previewWidth = 0; this.colorKey = null;
    this.page = opts.page ?? 1; this.pages = opts.pages ?? null; this.force = Boolean(opts.force); this.loader = null; this.loadKey = null; this.loadName = null;
    if (!path || !cx) return;
    // A macOS package is a folder: the viewer never reads it as a file (a double click opens it, see rows()).
    if (this.entryAt(path)?.bundle) {
      this.fileError = "This is a package: use Open, or Show Package Contents";
      cx.notify();
      opts.onDone?.({ error: this.fileError, mode: "source" });
      return;
    }
    // A known binary extension (lib/binary.js) is never read: no 1 MiB over SSH, no launch either. Locally the
    // message has an Open button; whoever wants to start an app does it before show() (clickFile).
    if (isBinaryName(path)) {
      this.fileError = BINARY_MESSAGE; this.openable = !this.on;
      cx.notify();
      opts.onDone?.({ error: this.fileError, mode: "source" });
      return;
    }
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        // Read at every click: "preview": false works from the next file on, without a restart.
        const cfg = await loadConfig(readTextFile, appHome, home), kind = previewKind(path);
        this.fileCfg = cfg; // the limits this file was prepared with: diagrams and page turns use the same
        let previewer = kind && cfg.preview ? await loadPreview() : null;
        if ((kind === "image" || kind === "pdf") && previewer) {
          // Images and PDFs never go through readTextFile: the probe decides, the file or its page lands in the cache.
          const loader = kind === "pdf"
            ? (this.pdfs ??= previewer.createPdfs({ exec, hc, exists: fs.exists, unlink: fs.unlink, mkdir: fs.mkdir, readFile: fs.readFile, appHome, platform: window()?.platform }))
            : (this.images ??= previewer.createImages({ exec, hc, exists: fs.exists, unlink: fs.unlink, appHome }));
          const doc = await loader.load({ on, path: joinPath(root, path), page: this.page, pages: this.pages, force: opts.force, ...this.loadLimits(cfg) });
          if (this.file !== path || !this.current(context)) return;
          if (doc.load) { this.showHint(previewer, doc, path, cx); return; }
          if (doc.error && (doc.final || extOf(path) !== "svg")) { this.fileError = doc.error; return; }
          if (!doc.error) { this.previewer = previewer; this.doc = doc; this.mode = "preview"; if (doc.pages) { this.page = doc.page; this.pages = doc.pages; } return; }
          previewer = null; // an SVG without a size: its source in the editor
        }
        let text;
        try {
          text = await readTextFile(joinPath(root, path), { on });
        } catch {
          // Over 1 MiB, not UTF-8 or unreadable: one more exec, only now (lib/binary.js), says which.
          const why = await explainUnreadable({ exec, on, path: joinPath(root, path) });
          if (this.file === path && this.current(context)) { this.fileError = why.message; this.openable = why.binary && !on; }
          return;
        }
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { const why = nulReason(text); this.fileError = why.message; this.openable = why.binary && !on; return; }
        this.shownText = text; // what reloadOpen compares with
        this.code = EditorState.new(this.editorOptions(path, text.length > cfg.source_max_chars ? text.slice(0, cfg.source_max_chars) + "\n… (file truncated)" : text, true));
        if (text.length > cfg.source_max_chars) this.editCheck = { state: "refused", reason: "Display truncated" };
        else this.checkEdit(path, cfg, cx);
        if (previewer) {
          // The source is on screen now; the preview follows in small steps, so typing and drawing never wait for it.
          cx.notify(); // the source is on screen
          try { await this.preparePreview(path, text, previewer, cx, opts.mode === "source" ? "source" : "preview"); }
          catch { this.previewer = null; this.doc = null; }
        }
      } catch (e) { if (this.file === path && this.current(context)) this.fileError = `Cannot show this file: ${String(e?.message ?? e)}`; }
      finally {
        cx.notify();
        const mine = this.file === path && this.current(context);
        opts.onDone?.(mine ? { error: this.fileError, mode: this.mode, preview: Boolean(this.doc) } : { error: "Another file was opened meanwhile", mode: "source" });
      }
    });
  }

  // The Markdown or HTML preview of text, prepared in small steps, so typing and drawing never wait for it. It replaces
  // the shown one only while the file and the text on screen are still the ones it was made from; this.docText is that
  // text, so a preview never lags behind the source (own save, reload of a clean edit buffer). mode: set with it.
  async preparePreview(path, text, previewer, cx, mode = null) {
    const context = this.context, cfg = this.fileCfg ?? DEFAULTS;
    const alive = () => this.file === path && this.current(context) && this.shownText === text;
    const doc = await previewer.prepareAsync(text, { kind: previewKind(path), mermaid: cfg.mermaid, maxChars: cfg.preview_max_chars, maxDiagrams: cfg.max_diagrams }, {
      sleep: () => cx.sleep(1), alive, now: Date.now, onStep: (ms) => this.perf?.sample("preview.prepare", ms, { file: path }),
    });
    if (!doc || !alive()) return false;
    this.previewer = previewer; this.doc = doc; this.docText = text;
    if (mode) this.mode = mode;
    if (doc.diagrams) this.renderDiagrams(cx);
    return true;
  }

  // The text on screen changed in place: the Markdown or HTML preview follows (in the background). force: prepare it
  // again although it was made from this text (Refresh).
  syncPreview(cx, force = false) {
    const path = this.file, text = this.shownText, previewer = this.previewer, doc = this.doc;
    if (!path || text === null || !previewer || !doc || doc.kind === "image" || doc.kind === "pdf") return;
    if (!force && this.docText === text) return;
    cx.spawn(async (cx) => {
      try { await this.preparePreview(path, text, previewer, cx); } catch {}
      cx.notify();
    });
  }

  // The options of the source editor, read only for the display and editable for the edit mode.
  editorOptions(path, value, readonly) {
    const t = theme();
    return { language: langOf(path), readonly, soft_wrap: true, value, font_family: settings().font_family, font_size: 12,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } };
  }

  // Is the read-only editor what the viewer shows (no preview, image, PDF or error in its place)?
  sourceShown() {
    if (!this.code || this.fileError || this.loader) return false;
    return !(this.previewer && this.doc && (this.mode === "preview" || this.doc.kind === "image" || this.doc.kind === "pdf"));
  }

  // Probes the open file in the background (lib/textedit.js): this.editCheck says whether Edit is possible and why not.
  checkEdit(path, cfg, cx) {
    if (this.takeHandover(path, cx)) return;
    const context = this.context, root = this.root, on = this.on;
    if (!on && window()?.platform === "windows") { this.editCheck = { state: "refused", reason: "Editing is not available on Windows" }; return; }
    const check = this.editCheck = { state: "checking" };
    cx.spawn(async (cx) => {
      // Guarded: an interrupted, failed or unanswered check still ends, as a refusal with its reason, never "Checking…".
      const after = (ms, f) => cx.timer.after(ms, () => f());
      const r = await new Promise((done) => probeFileGuarded({ exec, on, path: joinPath(root, path), maxChars: cfg.source_max_chars, after }, done));
      if (this.editCheck !== check || this.file !== path || !this.current(context)) return;
      this.editCheck = r.ok ? { state: "ok", info: r.info } : { state: "refused", reason: r.reason };
      cx.notify();
    });
  }

  // Edit on: a second, editable EditorState with the file's text (the read-only one stays for the display).
  // from (the fullscreen handover, see openFull): { text, id, mirrorPath, wroteFile } of the panel's buffer, so the
  // unsaved text, its dirty state and its mirror file carry over. -> true when edit mode is on.
  enterEdit(cx, from = null) {
    const c = this.editCheck;
    if (this.edit || c?.state !== "ok" || !this.sourceShown() || this.full) return false;
    const info = c.info, text = from ? from.text : info.text, state = EditorState.new(this.editorOptions(this.file, text, false));
    // An editor that rewrites the text (tabs, line ends) would make every file look changed.
    if (state.value() !== text) {
      state.release();
      this.editCheck = { state: "refused", reason: "The editor changes this file's text" };
      cx.notify();
      return false;
    }
    const history = createHistory();
    history.reset(info.text);
    if (text !== info.text) history.record(text, 0); // one Undo step back to the file's text
    const e = this.edit = { state, history, info, dirty: text !== info.text, applying: null, prompt: null, message: null, modeBefore: null, busy: false, copy: null,
      mirrored: null, mirrorAt: 0, wroteFile: Boolean(from?.wroteFile), id: from?.id ?? this.newId(), context: this.context, wasFixed: Boolean(this.context?.fixed) };
    e.mirrorPath = from?.mirrorPath ?? `${appHome()}/filer-pro/unsaved/${mirrorName(e.id, baseName(this.file))}`;
    if (this.context) this.context.fixed = true; // the file stays open while the focus moves
    state.on("change", (_ev, cx) => this.editChanged(cx));
    // The dialog has no other timer (it stays passive until editing starts): this one runs the mirror for it.
    if (props()?.overlay && !this.mirrorTimer) { this.mirrorTimer = true; cx.timer.every(2000, (cx) => this.mirrorUnsaved(cx)); }
    cx.notify();
    return true;
  }

  // ---- fullscreen handover: the dialog edits, the panel is read-only while it is open
  //
  // Maximize hands the panel's edit buffer to the fullscreen dialog (a separate mod copy) through shared values:
  // "filer-pro.handover" { id, path, text, info (bytes as base64), mirrorPath, wroteFile } and "filer-pro.fullscreen"
  // { id, state: open | taken | closed, at } (the dialog renews `at` every 2 s). The panel keeps its buffer, with the
  // unsaved text written to its mirror file first, until the dialog reports "taken"; while the dialog is open the
  // panel's edit controls are dimmed ("Editing in full screen"). Once it reports "closed" (or goes quiet for 8 s) the
  // panel shows the file as it is on disk again.

  async openFull(cx) {
    if (this.full) return;
    const e = this.edit;
    if (e && (e.busy || e.prompt || e.copy)) return;
    const id = this.newId(), path = this.file;
    let mode = this.doc ? this.mode : "preview";
    // wasFixed: the pin from before edit mode (edit mode pins the panel itself)
    this.full = { id, path, at: Date.now(), took: false, handing: Boolean(e), wasFixed: e ? e.wasFixed : Boolean(this.context?.fixed) };
    if (this.context) this.context.fixed = true; // the panel stays on the file while the dialog is open
    if (e) {
      mode = "source";
      if (e.dirty) await this.mirrorUnsaved(null, true); // the unsaved text is on disk before it changes hands
      const i = e.info;
      setShared("filer-pro.handover", { id, path, text: e.state.value(), mirrorPath: e.mirrorPath, wroteFile: e.wroteFile,
        info: { b64: bytesToBase64(i.bytes), hash: i.hash ?? null, text: i.text, eol: i.eol, mode: i.mode, size: i.size } });
    }
    setShared("filer-pro.fullscreen", { id, state: "opening", at: Date.now() });
    openOverlay({ mod: "filer-pro", props: { view: "file", machine: this.on, root: this.root, path, mode, page: this.page, pages: this.pages, force: this.force, full: id }, kind: "dialog", width: 0.86, height: 0.9 });
    cx.notify();
  }

  // The panel's side (250 ms timer): give up the buffer once the dialog took it, end read-only when it closed.
  pollFull(cx) {
    const f = this.full;
    if (!f) return;
    const s = shared("filer-pro.fullscreen"), mine = s?.id === f.id ? s : null;
    if (mine?.state === "taken" && !f.took) {
      f.took = true;
      const e = this.edit;
      if (e) { this.edit = null; this.releaseEdit(e); } // the mirror file now belongs to the dialog
      if (this.context) this.context.fixed = true; // still pinned while the dialog is open
      cx.notify();
    }
    if (mine?.state === "closed" || Date.now() - (mine?.at ?? f.at) > 8000) {
      this.full = null;
      if (this.context) this.context.fixed = f.wasFixed || Boolean(this.edit);
      if (shared("filer-pro.handover")?.id === f.id) setShared("filer-pro.handover", null);
      if (!this.edit && this.file === f.path) this.reloadOpen(cx, { force: true });
      cx.notify();
    }
  }

  // The dialog's side: report open and alive; the handover is taken in checkEdit once the source is on screen.
  startFullscreen(cx) {
    const id = props().full;
    if (!id) return;
    const h = shared("filer-pro.handover");
    this.handover = h?.id === id && h.path === props().path ? h : null;
    this.fullState = "open";
    const report = () => setShared("filer-pro.fullscreen", { id, state: this.fullState, at: Date.now() });
    report();
    cx.timer.every(2000, () => { if (this.fullState !== "closed") report(); });
  }

  takeHandover(path, cx) {
    const h = this.handover;
    if (!h || h.path !== path) return false;
    this.handover = null;
    const bytes = base64ToBytes(h.info.b64);
    if (!bytes) return false;
    this.editCheck = { state: "ok", info: { bytes, hash: h.info.hash ?? undefined, text: h.info.text, eol: h.info.eol, mode: h.info.mode, size: h.info.size } };
    if (!this.enterEdit(cx, h)) return false;
    this.fullState = "taken";
    setShared("filer-pro.fullscreen", { id: props().full, state: "taken", at: Date.now() });
    return true;
  }

  // The open file again as it is on disk (issue #31), without flicker and never over unsaved text. Runs at the end of a
  // refresh flight and when the fullscreen dialog closed (pollFull). Plain source (and every file in edit mode): read,
  // compare with the text on screen, set in place, probe again; a clean edit buffer takes the new text and save baseline.
  // Markdown and HTML that changed are shown anew; an image or PDF is probed and swapped only when its cache key (size,
  // mtime) changed. opts.force: probe although the text is unchanged (Refresh, after the dialog); opts.textOnly: leave
  // images and PDFs alone (their probe is an exec); opts.named: the trigger names this file (FILE_NAMED), so a file in
  // an error state is read again; on a bare change signal it is not. While a Load job runs nothing is read: the job
  // shows the file when it ends. One read at a time: a call meanwhile runs once afterwards. The Markdown or HTML preview
  // always follows the text on screen (syncPreview).
  reloadOpen(cx, { force = false, textOnly = false, named = false } = {}) {
    const path = this.file, context = this.context, cfg = this.fileCfg, e = this.edit, code = this.code, doc = this.doc;
    const busy = (e) => Boolean(e && (e.dirty || e.busy || e.prompt || e.copy));
    if (!path || !context || this.full || busy(e) || this.waiting) return; // the save's hash check guards unsaved text
    if (this.fileLoading) {
      const prev = this.fileAgain;
      this.fileAgain = { force: force || Boolean(prev?.force), textOnly: textOnly && (prev ? prev.textOnly : true), named: named || Boolean(prev?.named) };
      return;
    }
    if (this.loader) { if (force) this.show(path, cx, { page: this.page, pages: this.pages }); return; }
    if (this.fileError) { if (force || named) this.show(path, cx, { mode: this.mode }); return; }
    if (!code && !doc) return; // the first read still runs
    const image = !e && (doc?.kind === "image" || doc?.kind === "pdf");
    if (image && textOnly) return;
    const root = this.root, on = this.on;
    // Anything that changed the view meanwhile (another file, edit mode, the dialog, a new show) ends this reload.
    const still = () => this.file === path && this.current(context) && !this.full && this.edit === e && !busy(e) && this.code === code && this.doc === doc && !this.loader;
    const retry = () => { if (this.file === path && this.current(context)) this.fileAgain ??= { force, textOnly, named }; };
    this.fileLoading = true;
    cx.spawn(async (cx) => {
      try {
        if (image) {
          const loader = doc.kind === "pdf" ? this.pdfs : this.images;
          if (!loader) return;
          const fresh = await loader.load({ on, path: joinPath(root, path), page: this.page, pages: this.pages, force: this.force, ...this.loadLimits(cfg ?? undefined) });
          if (!still()) { retry(); return; }
          if (fresh.error || fresh.load) { this.show(path, cx, { page: this.page, pages: this.pages, force: this.force }); return; }
          if (fresh.path !== doc.path) { this.doc = fresh; if (fresh.pages) { this.page = fresh.page; this.pages = fresh.pages; } }
          return;
        }
        let text = null;
        try { text = await readTextFile(joinPath(root, path), { on }); } catch {}
        if (!still()) { retry(); return; }
        const same = text !== null && this.shownText !== null && lf(text) === lf(this.shownText);
        if (same && !force) return;
        if (!e && this.previewer && doc) { if (!same) this.show(path, cx, { mode: this.mode }); else this.syncPreview(cx, force); return; }
        // Gone, binary or too long for the source view: shown anew (a clean edit buffer loses nothing).
        if (!cfg || text === null || text.includes("\0") || text.length > cfg.source_max_chars) { this.show(path, cx, { mode: this.mode }); return; }
        if (!same) { code.set_value(text); this.shownText = text; }
        if (!e) { this.checkEdit(path, cfg, cx); return; }
        // A clean edit buffer: the probe gives the new text and the new save baseline.
        const after = (ms, f) => cx.timer.after(ms, () => f());
        const r = await new Promise((done) => probeFileGuarded({ exec, on, path: joinPath(root, path), maxChars: cfg.source_max_chars, after }, done));
        if (!still()) { retry(); return; }
        if (!r.ok) { this.show(path, cx, { mode: this.mode }); return; } // no longer editable: shown anew
        const info = r.info;
        this.editCheck = { state: "ok", info }; // the same object as e.info, as enterEdit makes it
        const changed = info.text !== e.info.text;
        e.info = info;
        if (changed) {
          e.applying = info.text;
          e.state.set_value(info.text);
          e.history.reset(info.text);
          e.dirty = false; e.message = null;
        }
        this.syncPreview(cx);
      } finally {
        this.fileLoading = false;
        const again = this.fileAgain;
        this.fileAgain = null;
        cx.notify();
        if (again && this.file === path && this.current(context)) this.reloadOpen(cx, again);
      }
    });
  }

  // A change of the editable buffer. The value that undo or redo just set is not a new step.
  editChanged(cx) {
    const e = this.edit;
    if (!e) return;
    const v = e.state.value();
    if (v !== e.applying) e.history.record(v, Date.now());
    e.applying = null;
    e.dirty = v !== e.info.text;
    if (e.message?.error) e.message = null;
    cx.notify();
  }

  step(dir, cx) {
    const e = this.edit, v = e?.history[dir]();
    if (v == null) return;
    e.applying = v;
    e.state.set_value(v);
    e.dirty = v !== e.info.text;
    cx.notify();
  }

  // Ends edit mode without asking (the callers ask first); the unsaved mirror file goes with it.
  leaveEdit() {
    const e = this.edit;
    if (!e) return;
    this.edit = null;
    this.dropMirror(e);
    this.releaseEdit(e);
  }

  releaseEdit(e) {
    try { e.state.release(); e.copy?.input.release(); } catch {}
    if (e.context) e.context.fixed = e.wasFixed;
  }

  // Leaves edit mode, then runs then(cx). Unsaved changes: asks Save / Discard / Cancel first.
  requestLeave(then, cx) {
    const e = this.edit;
    if (!e) { then?.(cx); return; }
    if (e.busy) return;
    if (!e.dirty) { this.leaveEdit(); then?.(cx); cx.notify(); return; }
    e.prompt = { kind: "leave", then };
    cx.notify();
  }

  // The Cancel button: clean leaves at once, dirty asks whether to discard.
  cancelEdit(cx) {
    const e = this.edit;
    if (!e || e.busy) return;
    if (!e.dirty) { this.leaveEdit(); cx.notify(); return; }
    e.prompt = { kind: "discard", then: null };
    cx.notify();
  }

  // Writes the buffer into the file (lib/textedit.js saveFile). The saved bytes are the new baseline. after(cx) runs
  // once it is saved and the buffer is still clean. A failure keeps the buffer, edit mode and the message.
  save(cx, after) {
    const e = this.edit;
    if (!e || e.busy) return;
    const value = e.state.value(), bytes = bufferBytes(value, e.info);
    if (!bytes) { e.message = { text: "Text contains characters that cannot be saved as UTF-8", error: true }; cx.notify(); return; }
    e.busy = true; e.message = null; e.prompt = null;
    cx.notify();
    const file = this.file, full = joinPath(this.root, file), on = this.on;
    cx.spawn(async (cx) => {
      let r;
      try { r = await saveFile({ exec, on, path: full, info: e.info, bytes, stage: (b64) => this.stageLocal(b64), send: this.sender(), pause: pauseOf(cx), localPlatform: window()?.platform }); }
      catch (err) { r = { ok: false, error: String(err?.message ?? err) }; }
      e.busy = false;
      if (!r.ok) { e.message = { text: r.error, error: true }; cx.notify(); return; }
      const text = value.replace(/\r\n?/g, "\n"), modeBefore = e.info.mode;
      if (this.file === file) this.shownText = text; // the own write: a reload (watch event, signal) finds it unchanged
      Object.assign(e.info, { bytes: r.bytes, hash: r.hash, text, size: r.bytes.length });
      e.message = { text: "Saved", error: false };
      // The mode is read again; bytes that are not the ones just sent mean someone wrote in between.
      try {
        const res = await exec("sh", ["-c", PROBE_SCRIPT, "probe", full], { on });
        const p = res?.code === 0 ? parseProbe(res.stdout) : null;
        if (p?.kind === "file") {
          e.info.mode = p.mode;
          if (!equalBytes(p.bytes, r.bytes)) e.message = { text: "Changed by someone else right after saving", error: true };
        }
      } catch {}
      e.modeBefore = modeBefore;
      this.signalOwn();
      if (this.edit === e) {
        e.dirty = e.state.value() !== text;
        if (this.file === file) this.code?.set_value(text);
        if (!e.dirty) this.dropMirror(e);
      }
      if (this.file === file) this.syncPreview(cx); // the Markdown or HTML preview shows the saved text
      cx.notify();
      if (this.edit === e && !e.dirty && !e.message.error) after?.(cx);
    });
  }

  // filer-pro.changed from this copy's own write (save, save a copy): the other copies reload as usual; this one
  // reloads its tree but not the open file, its buffer already is the file (pollReload compares the `at`).
  signalOwn() {
    const at = Date.now();
    this.ownChanged = at;
    setShared("filer-pro.changed", { at });
  }

  // Every save stages the base64 in a file in a private folder under appHome, so the text is never in argv, where other
  // users could read it. Locally the save script decodes and removes it; for a machine sender() copies it there first.
  async stageLocal(b64) {
    const dir = `${appHome()}/filer-pro/edit`;
    await this.privateDir(dir);
    const path = `${dir}/${this.newId()}.b64`;
    await fs.writeFile(path, b64);
    return path;
  }

  // The scp copy of a staged save to a machine (lib/textedit.js scpSender): bin/transfer.sh with the SSH settings of the
  // config, as transfer jobs run it.
  sender() {
    return scpSender({ exec, hc, script: `${appHome()}/mods/filer-pro/bin/transfer.sh`, trashDir: platform.trashDir(home()), limits: () => this.fileCfg ?? this.conf, localPlatform: window()?.platform });
  }

  // A local folder only this user can enter (0700): herdr's fs.mkdir and fs.writeFile take no mode.
  async privateDir(dir) {
    const r = await exec("sh", ["-c", 'umask 077 && mkdir -p "$1" && chmod 700 "$1"', "private", dir]);
    if (r.code !== 0) throw new Error(r.stderr || "Cannot create a private folder");
  }

  // Save a Copy…: the name form is shown above the editor (an InputState is created here, in a click).
  openCopy(cx) {
    const e = this.edit;
    if (!e || e.busy || e.copy) return;
    const name = copyName(baseName(this.file));
    e.prompt = null;
    e.copy = createNameDialog({ title: "Save a Copy", button: "Save", id: "copy", value: name, selectEnd: stemEnd(name, false), check: (v) => validateName(v) },
      { onSubmit: (n, cx) => this.submitCopy(n, cx) }, cx);
    cx.notify();
  }

  closeCopy(cx) {
    const e = this.edit;
    if (!e?.copy) return;
    try { e.copy.input.release(); } catch {}
    e.copy = null;
    cx.notify();
  }

  // The copy goes into the file's folder and never replaces a file. The form stays open on an error.
  submitCopy(name, cx) {
    const e = this.edit, c = e?.copy;
    if (!c || c.busy) return;
    const bytes = bufferBytes(e.state.value(), e.info), dir = parentOf(joinPath(this.root, this.file)), on = this.on;
    c.busy = true; c.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let r;
      try { r = await saveCopy({ exec, on, dir, name, bytes, mode: e.info.mode, stage: (b64) => this.stageLocal(b64), send: this.sender(), pause: pauseOf(cx), localPlatform: window()?.platform }); }
      catch (err) { r = { ok: false, error: String(err?.message ?? err) }; }
      c.busy = false;
      if (!r.ok) { c.error = r.error; cx.notify(); return; }
      this.signalOwn(); // a new file beside the open one: the tree reloads, the open file is not read again
      if (this.edit === e && e.copy === c) { this.closeCopy(cx); e.message = { text: `Saved a copy as ${name}`, error: false }; }
      cx.notify();
    });
  }

  // The unsaved-text mirror: while the buffer is dirty it is copied to unsaved/ (at most every 1.5 s, only when it
  // changed), so a close without asking (Esc handled by the app, a crash) loses nothing.
  async mirrorUnsaved(_cx, force = false) {
    const e = this.edit;
    if (!e?.dirty || (e.writing && !force)) return;
    const v = e.state.value();
    if (v === e.mirrored || (!force && Date.now() - e.mirrorAt < 1500)) return;
    e.mirrorAt = Date.now();
    e.writing = true;
    try {
      await this.privateDir(parentOf(e.mirrorPath)); // fs has no mode option: the folder is made 0700 through sh
      await fs.writeFile(e.mirrorPath, v);
      e.mirrored = v; e.wroteFile = true;
    } catch {} finally { e.writing = false; }
  }

  dropMirror(e) {
    if (e.wroteFile) fs.unlink(e.mirrorPath).catch(() => {});
    e.wroteFile = false; e.mirrored = null;
  }

  // close() with a dirty buffer: one last write and a toast with the place.
  async keepUnsaved(e) {
    await this.mirrorUnsaved(null, true);
    if (e.wroteFile && e.mirrored === e.state.value()) notify({ title: "Unsaved changes kept", body: tilde(e.mirrorPath, home()), level: "warning" });
    else notify({ title: "Unsaved changes lost", body: `Could not write ${tilde(e.mirrorPath, home())}`, level: "error" });
  }

  // Header buttons of the edit mode (ui/edit.js), only while the plain source is shown.
  editTools(t) {
    if (!this.sourceShown()) return [];
    if (this.full) return editTools(t, { check: { state: "refused", reason: "Editing in full screen" }, edit: null }, {});
    return editTools(t, { check: this.editCheck, edit: this.edit }, {
      onToggle: (cx) => (this.edit ? this.requestLeave(null, cx) : this.enterEdit(cx)),
      onUndo: (cx) => this.step("undo", cx), onRedo: (cx) => this.step("redo", cx),
      onCancel: (cx) => this.cancelEdit(cx), onSave: (cx) => this.save(cx), onCopy: (cx) => this.openCopy(cx),
    });
  }

  // The editor with the prompt or the name form above and the status line below.
  editView(t) {
    const e = this.edit, p = e.prompt;
    return v_flex().flex_1().min_h(0)
      .when(Boolean(p), el => el.child(promptBar(t, p, baseName(this.file), {
        onSave: (cx) => { e.prompt = null; this.save(cx, (cx) => { this.leaveEdit(); p.then?.(cx); cx.notify(); }); },
        onDiscard: (cx) => { this.leaveEdit(); p.then?.(cx); cx.notify(); },
        onCancel: (cx) => { e.prompt = null; cx.notify(); },
      })))
      .when(Boolean(e.copy), el => el.child(div().h(190).flex_none().child(nameView(t, e.copy, { onCancel: (cx) => this.closeCopy(cx) }))))
      .child(Editor.new(e.state).flex_1().min_h(0))
      .child(statusBar(t, statusText(e.info, e.modeBefore), e.message));
  }

  // The fullscreen dialog's keys: cmd-s, cmd-z and cmd-shift-z while editing; Esc asks before it closes over unsaved text.
  fileKey(ev, cx, close) {
    const e = this.edit, stroke = ev.keystroke ?? ev.key;
    if (e && ["cmd-s", "cmd-z", "cmd-shift-z"].includes(stroke)) {
      if (stroke === "cmd-s") this.save(cx); else this.step(stroke === "cmd-z" ? "undo" : "redo", cx);
      cx.stop_propagation();
      return;
    }
    if (ev.key !== "escape" && stroke !== "escape") return;
    if (e?.copy) return; // the name form has its own Esc
    cx.stop_propagation();
    if (!e?.prompt) this.requestLeave(close, cx);
  }

  // The size limits of images and PDFs in bytes and the SSH options of their download from a machine, from the settings
  // of the open file (per call: the loaders live per view).
  loadLimits(cfg = this.fileCfg ?? DEFAULTS) {
    const ssh = { ssh_connect_timeout: cfg.ssh_connect_timeout, ssh_alive_interval: cfg.ssh_alive_interval, ssh_alive_count: cfg.ssh_alive_count };
    return { maxImage: cfg.image_max_mb * MB, cacheLimit: cfg.image_cache_mb * MB, maxLocal: cfg.pdf_local_max_mb * MB, maxRemote: cfg.pdf_remote_max_mb * MB, svgCheck: cfg.svg_check, ssh };
  }

  // A file over the limit: a running preview job for its loads folder is joined (the panel's, while the dialog opens);
  // else the panel shows the Load button, the dialog points to the panel (it never starts jobs; only a local PDF needs none).
  showHint(previewer, doc, path, cx) {
    this.fileError = doc.error; this.loadKey = doc.key; this.loadName = doc.name;
    const running = previewer.previewJob(shared("filer-pro.jobs"), `${appHome()}/${previewer.loadDir(doc.key)}`);
    if (running) this.waitLoad(previewer, running.id, path, cx);
    else if (this.viaJob(doc.name) && props()?.overlay) this.fileError = doc.error + " · Load it in the panel";
    else this.loader = previewer;
  }

  // Does Load run as a transfer job? Everything from a machine and every local image; a local PDF is rastered from the file itself.
  viaJob(name) { return Boolean(this.on) || extOf(name ?? "") !== "pdf"; }

  // The Load button: lifts the size limit for the shown file. Other loads go first (a running preview job keeps its
  // folder); a local PDF is shown with force, anything else the transfer job copies (fetchLoad).
  loadLarge(cx) {
    const previewer = this.loader, key = this.loadKey, name = this.loadName, path = this.file, context = this.context;
    if (!previewer || !key) return;
    this.loader = null; cx.notify();
    cx.spawn(async (cx) => {
      await previewer.clearLoads({ exec, appHome, jobs: shared("filer-pro.jobs") }).catch(() => {});
      if (this.file !== path || !this.current(context)) return;
      if (this.viaJob(name)) this.fetchLoad(previewer, key, name, path, cx);
      else this.show(path, cx, { force: true, page: this.page, pages: this.pages });
    });
  }

  // The Load job (panel only): joins a running job for the folder, shows a file that is already there, else starts
  // the transfer job into loads/<key>/<name> (transfers bar, progress, ✕ cancels) and waits. Quiet job: no toast.
  fetchLoad(previewer, key, name, path, cx) {
    const context = this.context, root = this.root, on = this.on, destDir = `${appHome()}/${previewer.loadDir(key)}`, dest = `${destDir}/${name}`;
    this.fileError = "Loading… · progress in the transfers bar"; this.loader = null; cx.notify();
    cx.spawn(async (cx) => {
      const running = previewer.previewJob(shared("filer-pro.jobs"), destDir);
      if (running) { this.waitLoad(previewer, running.id, path, cx); return; }
      if (await fs.exists(dest)) { if (this.file === path && this.current(context)) this.show(path, cx, { force: true, page: this.page, pages: this.pages }); return; }
      await exec("mkdir", ["-p", destDir], { on: null }).catch(() => {});
      // Locally the job copies with cp -P: a link is resolved first, so a real file lands in loads/.
      const src = on ? joinPath(root, path) : await previewer.resolveFile({ exec, path: joinPath(root, path) });
      const job = await this.jobs.start({ direction: on ? "down" : "local", machine: on, src, destDir, choice: "new", preview: true, as: name });
      this.waitLoad(previewer, job.id, path, cx);
    });
  }

  // Polls the job until it ends or the file changes; then loadOutcome (images.js) decides: show with force, or the
  // error with the Load button again.
  // One wait at a time (this.waiting): a newer one or show() ends the older loop, so a job's end shows the file once.
  waitLoad(previewer, id, path, cx) {
    const context = this.context, wait = this.waiting = { id, path };
    this.fileError = "Loading… · progress in the transfers bar"; this.loader = null; cx.notify();
    cx.spawn(async (cx) => {
      let j = shared("filer-pro.jobs")?.[id];
      while (j?.state === "running" && this.waiting === wait && this.file === path && this.current(context)) { await cx.sleep(250); j = shared("filer-pro.jobs")?.[id]; }
      if (this.waiting !== wait) return;
      this.waiting = null;
      if (this.file !== path || !this.current(context)) return;
      const out = previewer.loadOutcome(j);
      if (out.show) { this.show(path, cx, { force: true, page: this.page, pages: this.pages }); return; }
      const dialog = this.viaJob(this.loadName) && props()?.overlay; // the dialog never starts jobs: it points to the panel, as showHint does
      this.fileError = dialog ? out.error + " · Load it in the panel" : out.error; this.loader = dialog ? null : previewer;
      cx.notify();
    });
  }

  // Previous/Next: the counter jumps at once, the old page stays until the new one is rastered or found in the cache.
  turnPage(n, cx) {
    const path = this.file, context = this.context, on = this.on, previewer = this.previewer;
    if (!this.pdfs || !this.pages || n < 1 || n > this.pages || n === this.page) return;
    this.page = n; cx.notify();
    cx.spawn(async (cx) => {
      const doc = await this.pdfs.load({ on, path: joinPath(this.root, path), page: n, pages: this.pages, force: this.force, ...this.loadLimits() });
      if (this.file !== path || this.page !== n || !this.current(context)) return;
      if (doc.load) this.showHint(previewer, doc, path, cx); // the loaded copy was cleared meanwhile
      else if (doc.error) this.fileError = doc.error;
      else { this.doc = doc; this.fileError = null; }
      cx.notify();
    });
  }

  // Draws the diagrams of the open preview one after the other (a Node child process, see preview/diagrams.js).
  // A run ends when the document changes or the theme's colors do.
  renderDiagrams(cx) {
    const doc = this.doc, t = theme(), key = this.previewer.colorKey(t);
    this.colorKey = key;
    this.diagrams ??= this.previewer.createDiagrams({ exec, readTextFile, writeFile: fs.writeFile, mkdir: fs.mkdir, unlink: fs.unlink, appHome, now: Date.now, perf: this.perf });
    cx.spawn(async (cx) => {
      const cfg = this.fileCfg ?? DEFAULTS;
      await this.diagrams.renderAll(doc.parts, t, () => this.doc === doc && this.colorKey === key, () => cx.notify(), { maxDiagrams: cfg.max_diagrams, maxChars: cfg.max_diagram_chars, node: cfg.node_path });
      cx.notify();
    });
  }

  // Header buttons of the preview module: Preview/Source and Open in browser (local HTML).
  previewTools(t) {
    if (!this.previewer || !this.doc || !this.file || this.edit) return [];
    return this.previewer.tools(this.doc, { mode: this.mode, canOpen: !this.on, page: this.page, pages: this.pages }, t, {
      onToggle: (cx) => { this.mode = this.mode === "preview" ? "source" : "preview"; cx.notify(); },
      onOpen: (cx) => cx.spawn(async () => { await openRegularFile(joinPath(this.root, this.file), { exec, notify, platform }); }),
      onPage: (n, cx) => this.turnPage(n, cx),
    });
  }

  viewer(t) {
    if (this.loader) return this.loader.largeNote(this.fileError, t, (cx) => this.loadLarge(cx));
    // An image or a PDF page has no EditorState: its view comes first and ignores mode (a "mode" request may set source).
    if (!this.fileError && this.previewer && this.doc && (this.mode === "preview" || this.doc.kind === "image" || this.doc.kind === "pdf"))
      return this.previewer.view(this.doc, { t, font: settings().font_family, file: this.file, width: this.previewWidth },
        { onWidth: (w, cx) => { if (w !== this.previewWidth) { this.previewWidth = w; cx.notify(); } } });
    if (!this.code && this.openable && this.fileError) return this.binaryView(t);
    if (!this.code) return div().p(12).text_color(t.dim).child(this.fileError || ({ image: "Loading image…", pdf: "Loading PDF…" }[previewKind(this.file)] ?? "Loading file…"));
    if (this.edit) return this.editView(t);
    const editor = Editor.new(this.code).flex_1().min_h(0);
    if (this.editCheck?.state !== "ok") return editor;
    return v_flex().flex_1().min_h(0).child(editor).child(statusBar(t, statusText(this.editCheck.info, null), null));
  }

  // Icon and name of the open file: the panel's header (end: right-aligned before the buttons) and the dialog's title.
  fileTitle(t, dark, end) {
    return h_flex().flex_1().min_w(0).overflow_hidden().gap(6).items_center().text_size(12).text_color(t.dim).when(end, el => el.justify_end())
      .when(Boolean(this.file), el => el.child(image(icon(this.file, false, false, dark)).size(14).flex_none()))
      .child(div().min_w(0).truncate().child((this.edit?.dirty ? "● " : "") + (this.file ?? this.root?.split(/[\\/]/).pop() ?? "")));
  }

  // A header button in the style of the preview's Source/Preview button; `child` is a text or an element.
  tool(id, child, t, onClick) {
    return div().id(id).px(7).py(2).rounded(6).text_size(11).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => onClick(cx)).child(child);
  }

  // The Refresh button in the panel header, always shown: reads the config again (hand edits), then reloads the tree and
  // the open file (issue #31: without refresh_seconds nothing polls; this is how an outside change on a machine shows).
  refreshButton(t) {
    return div().id("files-refresh").w(24).h(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).tooltip("Refresh").accessibility_label("Refresh")
      .on_click((_e, cx) => this.reloadConfig(cx, { file: FILE_NAMED, force: true }))
      .child(svg(`${BASE}/refresh-cw.svg`).size(14).text_color(t.muted));
  }

  // The Settings button in the panel header while no file is open: a gear in a 24px hit area, muted at rest.
  gear(t) {
    return div().id("files-settings").w(24).h(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).tooltip("Settings").accessibility_label("Settings")
      .on_click(() => { this.openSettings().catch((e) => notify({ title: "Settings", body: String(e?.message ?? e), level: "error" })); })
      .child(svg(`${BASE}/settings.svg`).size(14).text_color(t.muted));
  }

  // The fullscreen dialog (props view "file"): the same header buttons and viewer as the panel, plus Close. Esc closes a
  // dialog through the app; the root hears it too in case the editor holds the keyboard (as the name dialog does).
  fileOverlay(t, cx) {
    const p = props(), dark = Boolean(settings().dark);
    if (this.doc?.diagrams && this.previewer && this.colorKey !== this.previewer.colorKey(t)) this.renderDiagrams(cx);
    const close = () => { try { closeOverlay(p.overlay); } catch {} };
    return v_flex().id("files-full").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => this.fileKey(e, cx, close))
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(this.fileTitle(t, dark, false))
        .children(this.previewTools(t))
        .children(this.editTools(t))
        .child(this.tool("files-full-close", "✕", t, (cx) => this.requestLeave(close, cx))))
      .child(this.viewer(t));
  }

  // A click on a file row or a macOS package row (local only, lib/bundles.js) under double_click_files or
  // double_click_apps, read at each click (lib/clicks.js fileClick). "select" marks the row as the tree marks the last
  // opened file; "open" shows a file in the viewer and starts a package like the Finder does (lib/open.js openBundle).
  clickFile(path, bundle, event, cx) {
    // Local archives and Office documents (lib/binary.js) are apps for the click: double_click_apps decides. A single
    // click shows the message with an Open button; the double click starts the default app (binaryView). On a machine
    // nothing is ever downloaded or opened by a click: the regular file click shows the message (show() skips the read).
    if (!bundle && !this.on && isBinaryName(path)) {
      const a = fileClick(event, this.conf.double_click_apps);
      if (a === "open") { this.lastOpened = path; cx.notify(); this.openBinary(path); }
      else if (a) this.show(path, cx);
      return;
    }
    const action = fileClick(event, bundle ? this.conf.double_click_apps : this.conf.double_click_files);
    if (action === "open" && !bundle) { this.show(path, cx); return; }
    if (!action) return;
    this.lastOpened = path; cx.notify();
    if (action === "open") openBundle(joinPath(this.root, path), { exec, notify, platform }).catch(() => {});
  }

  // Opens a local file with the default app after the checks of lib/open.js (like Open in the menu). Never on a machine.
  openBinary(path) {
    if (this.on) return;
    openChecked(joinPath(this.root, path), { app: "default" }, { exec, notify, platform }).catch(() => {});
  }

  // The message of a file that is not text. Locally (openable) with an Open button, and a double click on it (the first
  // click showed this view in place of the tree) starts the default app when double_click_apps is on.
  binaryView(t) {
    const path = this.file;
    return v_flex().id("files-binary").flex_1().min_h(0).p(12).gap(8).items_start().text_color(t.dim)
      .on_click((e, cx) => { if (this.openable && this.file === path && this.conf.double_click_apps && e.click_count === 2) this.openBinary(path); })
      .child(div().child(this.fileError))
      .when(this.openable, el => el.child(this.tool("files-open-binary", "Open", t, (cx) => { cx.stop_propagation(); this.openBinary(path); })));
  }

  // Cmd+click: remote rows are downloaded and shown in the Finder, local rows are only shown there.
  reveal(path) {
    if (this.on) { this.request({ machine: this.on, path: joinPath(this.root, path), reveal: true }); return; }
    const [cmd, args] = platform.revealArgs(joinPath(this.root, path));
    exec(cmd, args).catch(() => {});
  }

  // Dropped Finder items: upload (remote tree) or local copy into the folder the drop landed on.
  drop(paths, rowPath, rowIsDir) {
    const r = dropRequest({ on: this.on, root: this.root, rowPath, rowIsDir, paths });
    if (r) this.request(r);
  }

  // The visible tree rows under the list settings; rows() and the spacer of an open file use the same (issue #5).
  visible() {
    return visibleRows(this.entries, this.folders, { limit: this.conf.list_total, maxDepth: this.conf.tree_depth, isDir: (entry, path) => treeDir(entry, path, this.packages) });
  }

  // The tree rows; the last opened file is marked with t.selected (issue #5).
  rows(t, dark) {
    return this.visible().map(({ path, entry, depth }) => {
      const open = this.folders.has(path), mark = this.marks[joinPath(this.root, path)];
      // A macOS package acts as a file until its contents are shown (lib/bundles.js); `dir` decides chevron, click and drop.
      const dir = treeDir(entry, path, this.packages), bundle = entry.bundle === true, contents = bundle && dir;
      const menuState = { paste: { enabled: false }, isDir: entry.dir, bundle, contents };
      return h_flex().id(`file-${path}`).h(ROW_H).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer()
        .when(path === this.lastOpened, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
        .on_click((e, cx) => e.modifiers.platform && !(this.on && !dir && isBinaryName(path)) ? this.reveal(path) : dir ? this.toggle(path, cx) : this.clickFile(path, bundle, e, cx))
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          openOverlay({ mod: "filer-pro", props: { view: "menu", machine: this.on, root: this.root, path: joinPath(this.root, path), isDir: entry.dir, bundle, contents, folder: dropTarget(this.root, path, dir) }, kind: "popup", at: "pointer", width: MENU_WIDTH, height: menuHeight(rowMenuItems(menuState)) });
        })
        .on_drop((e, cx) => this.drop(e.paths, path, dir))
        .child(dir ? svg(`${BASE}/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(image(bundle && !dir ? bundleIcon(entry.name, dark) : icon(path, entry.dir, open, dark)).size(16).flex_none())
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark)));
    });
  }

  // A rename, a delete or a finished job changed the file system: reload the tree and the open file soon.
  // The gate (lib/reload.js) makes a burst of signals one reload and catches up a signal from during a load.
  pollReload(cx) {
    const changed = shared("filer-pro.changed");
    if (this.reload.signal(changed?.at ?? null)) {
      const open = expandPath(changed?.expand, this.root, this.on);
      if (open) this.folders.add(open);
      // Kept on the copy, not passed along: take() may only let the reload through later (gap, running load).
      if (changed?.at !== this.ownChanged) this.fileWanted = Math.max(this.fileWanted ?? 0, FILE_ALL);
    }
    if (this.context && this.reload.take(this.loading)) this.refresh(cx);
  }

  render(cx) {
    if (props()?.overlay) return this.overlayView(cx);
    if (this.button) return this.toolbar(theme());
    const t0 = this.perf ? Date.now() : 0;
    if (key() !== this.context?.key) this.refresh(cx);
    this.pollReload(cx);
    this.pollPackage(cx);
    const t = theme(), dark = Boolean(settings().dark);
    if (this.doc?.diagrams && this.previewer && this.colorKey !== this.previewer.colorKey(t)) this.renderDiagrams(cx);
    // update_check false hides the hint at once; the stored result is cleared by the next hourly pass.
    const update = this.conf.update_check ? updateHint(shared("filer-pro.update"), this.version) : null;
    const bar = transfersBar(shared("filer-pro.jobs"), t, { onCancel: (id) => this.jobs.cancel(id).catch(() => {}), onDismiss: (id) => this.jobs.dismiss(id) });
    const root = v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => this.requestLeave((cx) => { this.show(null); cx.notify(); }, cx)).child("←")))
        .child(div().flex_none().font_semibold().child("Filer Pro"))
        .when(Boolean(update), el => el.child(this.tool("files-update", div().text_color(t.ansi4).child(`● ${update.version} available`), t, (cx) => cx.open_url(update.url)).flex_none()))
        .child(this.fileTitle(t, dark, true))
        .child(this.refreshButton(t))
        .when(!this.file, el => el.child(this.gear(t)))
        .children(this.previewTools(t))
        .children(this.editTools(t))
        .when(Boolean(this.file) && Boolean(this.full), el => el.child(div().id("files-full").px(7).py(2).rounded(6).text_color(t.dim).tooltip("Open in full screen").child(svg(`${BASE}/maximize.svg`).size(13))))
        .when(Boolean(this.file) && !this.full, el => el.child(this.tool("files-full", svg(`${BASE}/maximize.svg`).size(13), t, (cx) => this.openFull(cx)))))
      // The tree stays mounted while a file is open, at zero height with a spacer of the same content height:
      // GPUI keeps a scroll offset only for elements rendered every frame (issue #5).
      .child(v_flex().id("files-tree").min_h(0).overflow_y_scrollbar()
        .when(!this.file, el => el.flex_1().p(TREE_PAD).children(this.rows(t, dark)))
        .when(Boolean(this.file), el => el.flex_none().h(0).p(0).child(div().flex_none().h(this.visible().length * ROW_H + 2 * TREE_PAD)))
        .on_drop((e, cx) => this.drop(e.paths, null, false))
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          if (!this.root) return;
          openOverlay({ mod: "filer-pro", props: { view: "menu", scope: "root", machine: this.on, root: this.root, folder: this.root }, kind: "popup", at: "pointer", width: MENU_WIDTH, height: menuHeight(rootMenuItems({ paste: { enabled: false } })) });
        })
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child(limitText(this.conf.list_per_folder, this.conf.list_total)))))
      .when(Boolean(bar), el => el.child(bar))
      .when(Boolean(this.file), el => el.child(this.viewer(t)));
    if (this.perf) this.perf.sample("render", Date.now() - t0);
    return root;
  }
}
