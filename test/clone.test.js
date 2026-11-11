import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (p) => fs.readFileSync(new URL(`../mods/filer-pro/${p}`, import.meta.url), "utf8");

test("mod.json keeps place none and its origin, and carries the mod's own version", () => {
  assert.deepEqual(JSON.parse(read("mod.json")), {
    place: "none",
    version: "1.3.2",
    cloned_from: { name: "files", version: "0.1.12" },
  });
});

test("main.js points to the assets of filer-pro", () => {
  const src = read("main.js");
  assert.ok(!src.includes("mods/files/"));
  assert.ok(src.includes("${BASE}/chevron-"));
  assert.ok(src.includes("icon(path, entry.dir, open, dark)"));
  assert.match(read("lib/icons.js"), /export const BASE = "mods\/filer-pro"/);
});

test("class and header are named Filer Pro", () => {
  const src = read("main.js");
  assert.match(src, /export default class FilerPro extends View/);
  assert.ok(src.includes('.child("Filer Pro")'));
  assert.ok(!src.includes('.child("Files")'));
});

test("the preview is only loaded dynamically and can be turned off", () => {
  const src = read("main.js");
  assert.doesNotMatch(src, /^import .* from "\.\/preview\//m);
  assert.ok(src.includes('import("./preview/index.js")') && src.includes(".catch(() => null)"));
  assert.ok(src.includes("cfg.preview") && src.includes("cfg.mermaid") && src.includes("cfg.perf"));
  assert.ok(src.includes("soft_wrap: true"));
  assert.doesNotMatch(src, /mermaid\.bundle/);
  assert.doesNotMatch(read("preview/index.js"), /mermaid\.bundle/);
});

test("every TextView in the preview catches link clicks", () => {
  // All TextViews come from one helper (text) that sets on_link_click; otherwise one would be unguarded.
  const src = read("preview/index.js");
  assert.equal((src.match(/TextView\.(html|markdown)\(/g) ?? []).length, 2);
  const helper = /const text = [\s\S]*?\n\};/.exec(src)?.[0] ?? "";
  assert.equal((helper.match(/TextView\.(html|markdown)\(/g) ?? []).length, 2);
  assert.equal((src.match(/\.on_link_click\(/g) ?? []).length, 1);
  assert.ok(helper.includes(".on_link_click(onLink)"));
  assert.ok(src.includes("safeLink(") && src.includes("cx.open_url"));
});

test("main.js uses the syntax table from langs.js and has none of its own", () => {
  const src = read("main.js");
  assert.match(src, /import \{ langOf, previewKind \} from "\.\/lib\/langs\.js"/);
  assert.doesNotMatch(src, /const LANG = /);
});

test("preview module: the folder can be deleted, nothing outside imports it statically", () => {
  const lib = fs.readdirSync(new URL("../mods/filer-pro/lib/", import.meta.url));
  for (const f of lib) assert.doesNotMatch(read(`lib/${f}`), /preview\//, f);
  for (const f of fs.readdirSync(new URL("../mods/filer-pro/ui/", import.meta.url))) assert.doesNotMatch(read(`ui/${f}`), /\.\.\/preview\//, f);
});

test("perf mode: no timer and no measuring without cfg.perf, no appendFile", () => {
  const src = read("main.js");
  assert.doesNotMatch(src, /appendFile/);
  assert.ok(src.includes("if (cfg.perf)"));
  assert.ok(src.includes("this.perf?.sample") || src.includes("if (this.perf)"));
});

test("a theme change discards diagram runs through the color key", () => {
  assert.ok(read("main.js").includes("this.doc === doc && this.colorKey === key"));
});

test("prepare runs in pieces with a pause between them, the source view appears first", () => {
  const src = read("main.js");
  assert.doesNotMatch(src, /previewer\.prepare\(/, "no synchronous prepare on the UI thread");
  assert.ok(src.includes("previewer.prepareAsync("));
  assert.ok(src.includes("cx.sleep("));
  const show = src.indexOf("  show(path, cx, opts = {}) {");
  assert.ok(src.indexOf("cx.notify(); // the source is on screen", show) < src.indexOf("this.preparePreview(", show), "the source shows before preparing");
  assert.ok(src.includes("const alive = () => this.file === path && this.current(context) && this.shownText === text;"), "a preview of older text is never swapped in");
});

test("mods/filer-pro/ uses no setTimeout (the Herdr runtime has none): cx.sleep or cx.timer", () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = `${dir}/${e.name}`;
    return e.isDirectory() ? walk(p) : /\.m?js$/.test(e.name) && e.name !== "mermaid.bundle.js" ? [p] : [];
  });
  const hits = walk(new URL("../mods/filer-pro", import.meta.url).pathname).filter((f) => /\bsetTimeout\b/.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(hits, []);
});

test("the old names fileshare and file-pro no longer appear under mods/filer-pro/", () => {
  const skip = new Set(["mermaid.bundle.js", "THIRD_PARTY_NOTICES.md"]);
  // Exceptions: mods/filer-pro/lib/panels.js removes the stale legacy entry from workspace.panels (withoutLegacy) and must name it;
  // mods/filer-pro/lib/lease.js lists the legacy shared keys that are cleared once (staleLegacyKeys).
  const allowed = new Set(["mods/filer-pro/lib/panels.js", "mods/filer-pro/lib/lease.js"]);
  const hits = [];
  const root = new URL("..", import.meta.url).pathname;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (!skip.has(e.name) && !allowed.has(path.relative(root, p)) && /fileshare|file-pro/i.test(e.name + "\n" + fs.readFileSync(p, "latin1"))) hits.push(path.relative(root, p));
    }
  };
  walk(path.join(root, "mods/filer-pro"));
  assert.deepEqual(hits, []);
});

test("main.js builds paths with joinPath, never as root/path (issue #14)", () => {
  const src = read("main.js");
  assert.ok(!/\$\{(this\.)?root\}\/\$\{/.test(src), "root/path by concatenation");
  assert.ok(!src.includes("${top.stdout.trim()}/"));
});
