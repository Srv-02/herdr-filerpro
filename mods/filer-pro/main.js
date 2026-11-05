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
import { openRegularFile, openChecked } from "./lib/open.js";
import { icon, BASE } from "./lib/icons.js";
import { withPanel, withoutLegacy, panelShown } from "./lib/panels.js";
import { dropRequest, dropTarget } from "./lib/droptarget.js";
import { createFileOps, successToast } from "./lib/fileops.js";
import { createMoveOps, moveToasts } from "./lib/move.js";
import { rowMenuItems, rootMenuItems, menuHeight, MENU_WIDTH } from "./lib/menuitems.js";
import { pasteState } from "./lib/clipboard.js";
import { pruneFolder, folderMissing, expandPath, visibleRows, ROW_H, TREE_PAD, LIST_SCRIPT, psListCommand, limitText } from "./lib/tree.js";
import { numbers } from "./lib/settings.js";
import { createReloadGate } from "./lib/reload.js";
import { baseName, joinPath, relativePath, shellPath } from "./lib/names.js";
import { writeClipboard } from "./lib/pasteboard.js";
import { createNameDialog, nameView } from "./ui/namedialog.js";
import { renameSpec, newFolderSpec } from "./lib/namespecs.js";
import { transfersBar } from "./ui/bar.js";
import { menuView } from "./ui/menu.js";
import { conflictView } from "./ui/conflict.js";
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
const DEFAULTS = { ...numbers(null), node_path: "", svg_check: true };
const MB = 1024 * 1024;
// Title of the error toast per failed request action.
const FAILED = { download: "Download failed", upload: "Upload failed", copy: "Copy failed", paste: "Paste failed", rename: "Rename failed", mkdir: "New folder failed", delete: "Delete failed", clip: "Copy failed" };

// perFolder: the setting list_per_folder; the listing returns at most one entry more, so a cut folder is noticed.
async function directory(path, on, perFolder) {
  if (!on && window()?.platform === "windows") {
    const r = await exec("powershell", ["-NoProfile", "-Command", psListCommand(path, perFolder)]);
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  }
  const r = await exec("sh", ["-c", LIST_SCRIPT, "files", path, String(perFolder)], { on });
  if (r.code !== 0) throw Object.assign(new Error(r.stderr || "Cannot list this folder"), { missing: folderMissing(r) });
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
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
        this.fileOps = createFileOps({ exec });
        const spec = props().view === "rename" ? renameSpec({ name: baseName(props().path), isDir: props().isDir === true }) : newFolderSpec();
        this.dialog = createNameDialog(spec, { onSubmit: (name, cx) => this.submitName(name, cx) }, cx);
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
      exec, hc, readTextFile, getShared: shared, setShared, notify, now: Date.now, appHome, home, settings: () => this.cfg,
      newId: () => (Math.random().toString(36).slice(2) + "00000000").slice(0, 8),
    });
    const base = createFileOps({ exec });
    this.fileOps = { ...base, ...createMoveOps({ exec, check: base.check, trashDir: platform.trashDir(home()) }) };
    this.reload = createReloadGate({ now: Date.now, at: shared("filer-pro.changed")?.at ?? null });
    this.doc = null; this.mode = "source"; this.previewer = null; this.previewWidth = 0; this.colorKey = null; this.perf = null; this.diagrams = null;
    this.configSeen = shared("filer-pro.config")?.at ?? null;
    cx.spawn(async (cx) => {
      const cfg = this.cfg = await loadConfig(readTextFile, appHome, home);
      // The first listing ran with the defaults: other list settings reload the tree at the next tick.
      if (["list_per_folder", "list_total", "tree_depth"].some((k) => cfg[k] !== DEFAULTS[k])) this.refreshedAt = 0;
      this.version = await this.readVersion();
      if (cfg.perf) await this.startPerf(cx);
    });
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    // The periodic reload, every refresh_seconds (setting): a 1 s tick that checks the time itself, so a changed
    // interval applies without a restart. The config is read again on the way, which picks up hand edits.
    this.refreshedAt = Date.now();
    cx.timer.every(1000, cx => {
      if (Date.now() - this.refreshedAt < this.conf.refresh_seconds * 1000) return;
      this.refreshedAt = Date.now();
      this.reloadConfig(cx);
    });
    cx.timer.every(250, cx => { this.checkShow(cx); this.pollReload(cx); this.checkConfig(cx); });
    this.drive(cx);
  }

  // The current settings of this copy: the config read last, or the defaults before the first read.
  get conf() { return this.cfg ?? DEFAULTS; }

  // Reads the config again, then reloads the tree, so new list limits apply to the folders already shown.
  reloadConfig(cx) {
    cx.spawn(async (cx) => {
      try { this.cfg = await loadConfig(readTextFile, appHome, home); } catch {}
      this.refresh(cx);
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
          const r = await exec("sh", ["-c", 'cd -- "$1" && ls -1', "x", dir]).catch(() => null);
          const names = r?.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
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
      const state = { paste: pasteState(shared("filer-pro.clipboard"), p.machine ?? null, p.folder), isDir: p.isDir === true, remote: Boolean(p.machine) };
      const items = p.scope === "root" ? rootMenuItems(state) : rowMenuItems(state);
      // Open and Open in Preview: locally after the checks in open.js (the popup closes once open returned);
      // remote the file is downloaded first (download_folder, conflict dialog) and opened by afterDownload.
      const openWith = (app) => {
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
        download: () => send({}),
        download_to: () => { pickFolder({ prompt: "Download here" }).then(dir => { if (dir) send({ dest_dir: dir }); else close(); }).catch(close); },
        copy: () => act({ action: "clip", path: p.path, is_dir: p.isDir === true }),
        cut: () => act({ action: "clip", path: p.path, is_dir: p.isDir === true, cut: true }),
        paste: () => act({ action: "paste", folder: p.folder, root: p.root }),
        copy_path: (cx) => toClipboard(shellPath(p.path), cx),
        copy_relative_path: (cx) => toClipboard(shellPath(relativePath(p.root, p.path)), cx),
        new_folder: () => { close(); openOverlay({ mod: "filer-pro", props: { view: "mkdir", machine: p.machine, path: p.folder }, kind: "dialog", modal: true, width: 440, height: 220 }); },
        rename: () => { close(); openOverlay({ mod: "filer-pro", props: { view: "rename", machine: p.machine, path: p.path, root: p.root, isDir: p.isDir === true }, kind: "dialog", modal: true, width: 440, height: 220 }); },
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
    if (!out.ok) { r.error = out.error; cx?.notify(); return; }
    // expand: the panel opens the parent folder, so the new folder is visible.
    setShared("filer-pro.changed", { at: Date.now(), ...(mkdir ? { expand: { machine: p.machine ?? null, folder: p.path } } : {}) });
    const toast = successToast({ action: mkdir ? "mkdir" : "rename", path: p.path }, out);
    if (toast) notify(toast);
    try { closeOverlay(p.overlay); } catch {}
  }

  // Esc or closing the dialog without a choice counts as Cancel.
  async close() {
    if (props()?.view === "file") { this.code?.release(); this.code = null; this.file = null; this.doc = null; this.loader = null; return; }
    if (props()?.view !== "conflict") return;
    const a = closeAnswer(this.batchId, shared("filer-pro.pending"), shared("filer-pro.answer"));
    if (a) setShared("filer-pro.answer", a);
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
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
      entries = await directory(path ? joinPath(root, path) : root, on, this.conf.list_per_folder);
    } catch (e) {
      // An open subfolder that was renamed or deleted just leaves the tree, with everything below it.
      if (path && e?.missing && this.current(context)) { pruneFolder(this.folders, this.entries, path); return; }
      throw e;
    }
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const { list_per_folder: perFolder, list_total: total } = this.conf;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(perFolder, total - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > perFolder || used + entries.length > total) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file, lastOpened: this.lastOpened });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false; this.lastOpened = saved?.lastOpened ?? null;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
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
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
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
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    if (path) this.lastOpened = path; // marked in the tree after back (show(null) keeps it)
    this.doc = null; this.mode = "source"; this.previewer = null; this.previewWidth = 0; this.colorKey = null;
    this.page = opts.page ?? 1; this.pages = opts.pages ?? null; this.force = Boolean(opts.force); this.loader = null; this.loadKey = null; this.loadName = null;
    if (!path || !cx) return;
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
        const text = await readTextFile(joinPath(root, path), { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme();
        this.code = EditorState.new({ language: langOf(path), readonly: true, soft_wrap: true,
          value: text.length > cfg.source_max_chars ? text.slice(0, cfg.source_max_chars) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
        if (previewer) {
          // The source is on screen now; the preview follows in small steps, so typing and drawing never wait for it.
          cx.notify(); // the source is on screen
          try {
            const doc = await previewer.prepareAsync(text, { kind, mermaid: cfg.mermaid, maxChars: cfg.preview_max_chars, maxDiagrams: cfg.max_diagrams }, {
              sleep: () => cx.sleep(1), alive: () => this.file === path && this.current(context),
              now: Date.now, onStep: (ms) => this.perf?.sample("preview.prepare", ms, { file: path }),
            });
            if (doc && this.file === path && this.current(context)) {
              this.previewer = previewer; this.doc = doc; this.mode = opts.mode === "source" ? "source" : "preview";
              if (doc.diagrams) this.renderDiagrams(cx);
            }
          } catch { this.previewer = null; this.doc = null; }
        }
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally {
        cx.notify();
        const mine = this.file === path && this.current(context);
        opts.onDone?.(mine ? { error: this.fileError, mode: this.mode, preview: Boolean(this.doc) } : { error: "Another file was opened meanwhile", mode: "source" });
      }
    });
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
  waitLoad(previewer, id, path, cx) {
    const context = this.context;
    this.fileError = "Loading… · progress in the transfers bar"; this.loader = null; cx.notify();
    cx.spawn(async (cx) => {
      let j = shared("filer-pro.jobs")?.[id];
      while (j?.state === "running" && this.file === path && this.current(context)) { await cx.sleep(250); j = shared("filer-pro.jobs")?.[id]; }
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
    if (!this.previewer || !this.doc || !this.file) return [];
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
    if (!this.code) return div().p(12).text_color(t.dim).child(this.fileError || ({ image: "Loading image…", pdf: "Loading PDF…" }[previewKind(this.file)] ?? "Loading file…"));
    return Editor.new(this.code).flex_1().min_h(0);
  }

  // Icon and name of the open file: the panel's header (end: right-aligned before the buttons) and the dialog's title.
  fileTitle(t, dark, end) {
    return h_flex().flex_1().min_w(0).gap(6).items_center().text_size(12).text_color(t.dim).when(end, el => el.justify_end())
      .when(Boolean(this.file), el => el.child(image(icon(this.file, false, false, dark)).size(14).flex_none()))
      .child(div().min_w(0).truncate().child(this.file ?? this.root?.split(/[\\/]/).pop() ?? ""));
  }

  // A header button in the style of the preview's Source/Preview button; `child` is a text or an element.
  tool(id, child, t, onClick) {
    return div().id(id).px(7).py(2).rounded(6).text_size(11).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => onClick(cx)).child(child);
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
      .on_key_down((e, cx) => { if (e.key === "escape") { close(); cx.stop_propagation(); } })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(this.fileTitle(t, dark, false))
        .children(this.previewTools(t))
        .child(this.tool("files-full-close", "✕", t, close)))
      .child(this.viewer(t));
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
    return visibleRows(this.entries, this.folders, { limit: this.conf.list_total, maxDepth: this.conf.tree_depth });
  }

  // The tree rows; the last opened file is marked with t.selected (issue #5).
  rows(t, dark) {
    return this.visible().map(({ path, entry, depth }) => {
      const open = this.folders.has(path), mark = this.marks[joinPath(this.root, path)];
      return h_flex().id(`file-${path}`).h(ROW_H).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer()
        .when(path === this.lastOpened, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
        .on_click((e, cx) => e.modifiers.platform ? this.reveal(path) : entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          openOverlay({ mod: "filer-pro", props: { view: "menu", machine: this.on, root: this.root, path: joinPath(this.root, path), isDir: entry.dir, folder: dropTarget(this.root, path, entry.dir) }, kind: "popup", at: "pointer", width: MENU_WIDTH, height: menuHeight(rowMenuItems({ paste: { enabled: false } })) });
        })
        .on_drop((e, cx) => this.drop(e.paths, path, entry.dir))
        .child(entry.dir ? svg(`${BASE}/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(image(icon(path, entry.dir, open, dark)).size(16).flex_none())
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark)));
    });
  }

  // A rename, a delete or a finished job changed the file system: reload soon, not at the next periodic reload.
  // The gate (lib/reload.js) makes a burst of signals one reload and catches up a signal from during a load.
  pollReload(cx) {
    const changed = shared("filer-pro.changed");
    if (this.reload.signal(changed?.at ?? null)) {
      const open = expandPath(changed?.expand, this.root, this.on);
      if (open) this.folders.add(open);
    }
    if (this.context && this.reload.take(this.loading)) this.refresh(cx);
  }

  render(cx) {
    if (props()?.overlay) return this.overlayView(cx);
    if (this.button) return this.toolbar(theme());
    const t0 = this.perf ? Date.now() : 0;
    if (key() !== this.context?.key) this.refresh(cx);
    this.pollReload(cx);
    const t = theme(), dark = Boolean(settings().dark);
    if (this.doc?.diagrams && this.previewer && this.colorKey !== this.previewer.colorKey(t)) this.renderDiagrams(cx);
    // update_check false hides the hint at once; the stored result is cleared by the next hourly pass.
    const update = this.conf.update_check ? updateHint(shared("filer-pro.update"), this.version) : null;
    const bar = transfersBar(shared("filer-pro.jobs"), t, { onCancel: (id) => this.jobs.cancel(id).catch(() => {}), onDismiss: (id) => this.jobs.dismiss(id) });
    const root = v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Filer Pro"))
        .when(Boolean(update), el => el.child(this.tool("files-update", div().text_color(t.ansi4).child(`● ${update.version} available`), t, (cx) => cx.open_url(update.url)).flex_none()))
        .child(this.fileTitle(t, dark, true))
        .when(!this.file, el => el.child(this.gear(t)))
        .children(this.previewTools(t))
        .when(Boolean(this.file), el => el.child(this.tool("files-full", svg(`${BASE}/maximize.svg`).size(13), t,
          () => openOverlay({ mod: "filer-pro", props: { view: "file", machine: this.on, root: this.root, path: this.file, mode: this.doc ? this.mode : "preview", page: this.page, pages: this.pages, force: this.force }, kind: "dialog", width: 0.86, height: 0.9 })))))
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
