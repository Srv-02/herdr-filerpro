// Patches a COPY of the mod (the one in the demo instance's HERDR_APP_HOME, never the repo and never the installed mod) so every
// screenshot state can be set from outside without mouse or keyboard: the panel polls $HERDR_APP_HOME/demo-cmd.json and
// sets the state a click or hover would set, through the real code paths (row menu popup, Settings dialog, fullscreen dialog).
// Usage: node scripts/screenshots/demo-hook.mjs <path of the copied mods/filer-pro>
// Commands (one JSON object, a new "id" each time): { id, op: "expand", paths: ["docs"] } | { op: "size", path } |
// { op: "row", path } (hover look of a tree row) | { op: "menu", path, x, y, hover: "<menu entry id>" } |
// { op: "rootmenu", x, y, hover } | { op: "settings", from: 0 | 9 } | { op: "full", zoom } | { op: "close" } | { op: "back" }
import fs from "node:fs";

const dir = process.argv[2];
if (!dir) { console.error("usage: demo-hook.mjs <mod folder>"); process.exit(2); }

function patch(file, edits) {
  const p = `${dir}/${file}`;
  let s = fs.readFileSync(p, "utf8");
  for (const [from, to] of edits) {
    if (s.split(from).length !== 2) throw new Error(`${file}: anchor not found exactly once: ${from.slice(0, 60)}`);
    s = s.replace(from, () => to);
  }
  fs.writeFileSync(p, s);
}

patch("ui/menu.js", [
  ['import { v_flex } from "gpui-base";', 'import { v_flex } from "gpui-base";\nimport { props } from "herdr";'],
  ['.rounded(6).cursor_pointer().hover(s => s.bg(t.hover))', '.rounded(6).when(props()?.hover === id, el => el.bg(t.hover)).cursor_pointer().hover(s => s.bg(t.hover))'],
]);

patch("ui/settings.js", [
  ['import { div, svg } from "gpui-kit";', 'import { div, svg } from "gpui-kit";\nimport { props } from "herdr";'],
  ['.children(body(t, state, handlers, stored))', '.children(body(t, state, handlers, stored).slice(props()?.demoFrom ?? 0))'],
]);

const hook = `
  demoPoll(cx) {
    if (this.demoBusy) return;
    this.demoBusy = true;
    readTextFile(\`\${appHome()}/demo-cmd.json\`).then(async (text) => {
      const c = JSON.parse(text);
      if (!c || c.id === this.demoSeen) return;
      this.demoSeen = c.id;
      await this.demoRun(c, cx);
    }).catch(() => {}).finally(() => { this.demoBusy = false; });
  }

  async demoRun(c, cx) {
    if (c.op === "expand") { for (const p of c.paths) if (!this.folders.has(p)) this.toggle(p, cx); }
    else if (c.op === "collapse") { for (const p of c.paths) if (this.folders.has(p)) this.toggle(p, cx); }
    else if (c.op === "size") setShared("filer-pro.sizes", requestSize(shared("filer-pro.sizes"), null, joinPath(this.root, c.path), this.newId(), Date.now()));
    else if (c.op === "row") { this.demoRow = c.path ?? null; cx.notify(); }
    else if (c.op === "back") { this.show(null, cx); cx.notify(); }
    else if (c.op === "close") { if (DEMO_LAST) { try { closeOverlay(DEMO_LAST); } catch {} } DEMO_LAST = null; }
    else if (c.op === "settings") { this.demoSettings = { demoFrom: c.from ?? 0 }; await this.openSettings(); }
    else if (c.op === "full") { this.demoFull = { demoSpread: true, demoZoom: c.zoom }; await this.openFull(cx); }
    else if (c.op === "rootmenu") {
      openOverlay({ mod: "filer-pro", props: { view: "menu", scope: "root", machine: this.on, root: this.root, folder: this.root, editor: editorMenu(this.conf), hover: c.hover }, kind: "popup", at: { x: c.x, y: c.y }, width: MENU_WIDTH, height: menuHeight(rootMenuItems({ paste: { enabled: false } })) });
    } else if (c.op === "menu") {
      const entry = this.entryAt(c.path);
      if (!entry) return;
      const dir = treeDir(entry, c.path, this.packages), bundle = entry.bundle === true, contents = bundle && dir;
      const menuState = { paste: { enabled: false }, ...rowMenuState({ name: entry.name, isDir: entry.dir, machine: this.on, platform: window()?.platform, bundle, contents }) };
      openOverlay({ mod: "filer-pro", props: { view: "menu", machine: this.on, root: this.root, path: joinPath(this.root, c.path), isDir: entry.dir, bundle, contents, folder: dropTarget(this.root, c.path, dir), editor: editorMenu(this.conf), hover: c.hover }, kind: "popup", at: { x: c.x, y: c.y }, width: MENU_WIDTH, height: menuHeight(rowMenuItems(menuState)) });
    }
  }
`;

patch("main.js", [
  [" openOverlay, closeOverlay,", " openOverlay as __openOverlay, closeOverlay,"],
  ["export default class FilerPro extends View {", "let DEMO_LAST = null;\nfunction openOverlay(spec) { const id = __openOverlay(spec); DEMO_LAST = id; return id; }\n\nexport default class FilerPro extends View {"],
  ["this.pollFull(cx); });", "this.pollFull(cx); this.demoPoll(cx); });"],
  ["  // The current settings of this copy:", hook + "\n  // The current settings of this copy:"],
  ['props: { view: "settings" }, kind: "dialog"', 'props: { view: "settings", ...(this.demoSettings ?? {}) }, kind: "dialog"'],
  ["configPath: tilde(`${appHome()}/filer-pro.json`, home()) });", 'configPath: "~/.config/herdr-app/filer-pro.json" });'],
  ["force: this.force, full: id }", "force: this.force, full: id, ...(this.demoFull ?? {}) }"],
  ["        this.startFullscreen(cx);\n", "        this.startFullscreen(cx);\n        if (props().demoSpread) cx.timer.after(3000, () => { this.setLayout(true, cx); cx.timer.after(1500, () => this.showPages(2, cx)); if (props().demoZoom) this.zoomBy(props().demoZoom, cx); });\n"],
  [".when(path === this.lastOpened, el => el.bg(t.selected)).hover(s => s.bg(t.hover))", ".when(path === this.lastOpened, el => el.bg(t.selected)).when(path === this.demoRow, el => el.bg(t.hover)).hover(s => s.bg(t.hover))"],
]);
console.log("patched", dir);
