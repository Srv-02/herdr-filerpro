import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { mkTmp } from "./tmp-helper.js";
import { isPdf, pageName, parseRender, createPdfs, RENDER_SCRIPT, MAX_PDF_LOCAL, MAX_PDF_REMOTE } from "../mods/filer-pro/preview/pdf.js";
import { evictPlan, cacheKey, DIR, LOADS, loadDir, PROBE_SCRIPT, FETCH_SSH, LIST_SCRIPT } from "../mods/filer-pro/preview/images.js";

const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const KEY = cacheKey({ on: null, path: "/Users/m/doc.pdf", size: 500, mtime: 7 });

test("isPdf finds %PDF- within the first 1024 bytes only", () => {
  assert.equal(isPdf(ascii("%PDF-1.4\n")), true);
  assert.equal(isPdf(ascii(" ".repeat(1024) + "%PDF-1.4")), true, "a header may start at byte 1024");
  assert.equal(isPdf(ascii(" ".repeat(1025) + "%PDF-1.4")), false);
  assert.equal(isPdf(ascii("%PDF")), false);
  assert.equal(isPdf(new Uint8Array(0)), false);
  assert.equal(isPdf(ascii("MZ\x90\x00")), false);
});

test("pageName fits the eviction name rule and evictPlan keeps page and fetched PDF", () => {
  assert.equal(pageName(KEY, 12), `${KEY}p12.png`);
  assert.match(pageName(KEY, 1), /^[a-z0-9]+\.[a-z]+$/);
  const row = (size, name) => `-rw-r--r--  1 501  20  ${size} Nov  5 15:00 ${name}\n`;
  const list = row(10, pageName(KEY, 3)) + row(60, `${KEY}.pdf`) + row(10, pageName(KEY, 2)) + row(10, "old.png");
  assert.deepEqual(evictPlan(list, 50, [pageName(KEY, 3), `${KEY}.pdf`]), [pageName(KEY, 2), "old.png"]);
  assert.deepEqual(evictPlan(list, 50, []), [`${KEY}.pdf`, pageName(KEY, 2), "old.png"], "without keep the PDF goes too");
});

test("RENDER_SCRIPT names no path, page or target: they travel as argv", () => {
  assert.ok(RENDER_SCRIPT.includes('ObjC.import("PDFKit")'));
  assert.ok(RENDER_SCRIPT.includes("function run(argv)"));
  assert.doesNotMatch(RENDER_SCRIPT, /\/Users|\/home|\.pdf|\.png/, "no file name in the script text");
  assert.ok(RENDER_SCRIPT.includes("whiteColor"), "the page is drawn on white");
  assert.ok(RENDER_SCRIPT.includes("writeToFileAtomically(out, true)"), "two copies rastering the same page never leave half a file");
  assert.ok(RENDER_SCRIPT.includes("page.rotation) % 180"), "a rotated page swaps width and height");
  assert.ok(RENDER_SCRIPT.includes("2048") && RENDER_SCRIPT.includes("Math.min(2,"), "longest edge 2048 px, scale at most 2");
  assert.equal(MAX_PDF_LOCAL, 100 * 1024 * 1024);
  assert.equal(MAX_PDF_REMOTE, 20 * 1024 * 1024);
});

test("parseRender reads the JSON line behind stderr noise and maps the error codes", () => {
  assert.deepEqual(parseRender('{"pages":3,"page":2,"width":1224,"height":1584,"scale":2}\n'), { pages: 3, page: 2, width: 1224, height: 1584 });
  assert.deepEqual(parseRender('CoreGraphics PDF has logged an error.\n{"pages":1,"page":1,"width":10,"height":20,"scale":2}\n'), { pages: 1, page: 1, width: 10, height: 20 });
  assert.deepEqual(parseRender('{"error":"locked"}'), { error: "PDF is password-protected · no preview", final: true });
  assert.deepEqual(parseRender('{"error":"empty"}'), { error: "PDF has no pages · no preview", final: true });
  assert.deepEqual(parseRender('{"error":"broken"}'), { error: "Cannot read this PDF · no preview", final: true });
  assert.deepEqual(parseRender('{"error":"write"}'), { error: "Cannot write the page image · no preview", final: true });
  assert.equal(parseRender("").error, "Cannot load this PDF: unknown error");
  assert.equal(parseRender("execution error: boom (-1)").error, "Cannot load this PDF: execution error: boom (-1)");
  assert.equal(parseRender('{"pages":0}').error, "Cannot load this PDF: unknown error", "JSON without a page is no result");
});

const APP = "/Users/m/.config/herdr-app";
const be32 = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const PNG = (w, h) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, ...be32(w), ...be32(h), 8, 6, 0, 0, 0]);
const PDF = ascii("%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n");
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" ");
const probeOut = (size, mtime, bytes) => `${size} ${mtime}\n   ${hex(bytes)}\n`;
const row = (size, name) => `-rw-r--r--  1 501  20  ${size} Nov  5 15:00 ${name}\n`;
const ok = { code: 0, stdout: "", stderr: "" };
const rendered = (pages, page, w, h) => ({ code: 0, stdout: `${JSON.stringify({ pages, page, width: w, height: h, scale: 2 })}\n`, stderr: "CoreGraphics PDF has logged an error.\n" });

// Fakes in the style of test/images.test.js. behave(call) answers every exec; hc knows the machine "box".
function fake(behave, over = {}) {
  const f = { calls: [], unlinks: [], mkdirs: [], present: new Set(), files: {} };
  f.exec = async (cmd, args, options) => { f.calls.push({ cmd, args, options }); return behave(f.calls.at(-1)); };
  f.hc = async (args) => { f.calls.push({ cmd: "hc", args }); return { code: 0, stdout: JSON.stringify({ machines: [{ name: "box", target: "u@box" }] }), stderr: "" }; };
  f.exists = async (p) => f.present.has(p);
  f.unlink = async (p) => { f.unlinks.push(p); };
  f.mkdir = async (p) => { f.mkdirs.push(p); };
  f.readFile = async (p) => { if (!(p in f.files)) throw new Error(`ENOENT ${p}`); return f.files[p]; };
  f.make = () => createPdfs({ exec: f.exec, hc: f.hc, exists: f.exists, unlink: f.unlink, mkdir: f.mkdir, readFile: f.readFile, appHome: () => APP, platform: "macos", rand: () => "r1", ...over });
  f.kinds = () => f.calls.map((c) => c.cmd === "hc" ? "hc" : c.cmd === "osascript" ? "render" : c.cmd === "rm" ? "rm" : c.args[1] === PROBE_SCRIPT ? "probe" : c.args[1] === FETCH_SSH ? "ssh" : c.args[1] === LIST_SCRIPT ? "list" : c.cmd);
  return f;
}
const LOCAL = "/Users/m/doc.pdf", REMOTE = "/home/u/doc.pdf";
const local = (size, extra) => fake((c) => c.args?.[1] === PROBE_SCRIPT ? { code: 0, stdout: probeOut(size, 7, PDF), stderr: "" } : c.cmd === "osascript" ? rendered(3, +c.args[5], 1224, 1584) : c.args?.[1] === LIST_SCRIPT ? { code: 0, stdout: row(10, "x.png"), stderr: "" } : ok, extra);

test("a local PDF: probe, one osascript with path, page and target as argv, PNG in the cache, the page kept", async () => {
  const key = cacheKey({ on: null, path: LOCAL, size: 500, mtime: 7 }), png = `${APP}/${DIR}/${pageName(key, 1)}`;
  const f = fake((c) => c.args?.[1] === PROBE_SCRIPT ? { code: 0, stdout: probeOut(500, 7, PDF), stderr: "" }
    : c.cmd === "osascript" ? rendered(3, 1, 1224, 1584)
    : c.args?.[1] === LIST_SCRIPT ? { code: 0, stdout: row(10, pageName(key, 1)) + row(60e6, "old.png"), stderr: "" } : ok);
  const doc = await f.make().load({ on: null, path: LOCAL });
  assert.deepEqual(doc, { kind: "pdf", path: `${DIR}/${pageName(key, 1)}`, page: 1, pages: 3, width: 612, height: 792 });
  assert.deepEqual(f.kinds(), ["probe", "render", "list", "rm"]);
  assert.equal(f.calls[0].options.on, null);
  assert.deepEqual(f.calls[1].args, ["-l", "JavaScript", "-e", RENDER_SCRIPT, LOCAL, "1", png]);
  assert.equal(f.calls[1].options.on, null, "osascript runs on this computer");
  assert.deepEqual(f.mkdirs, [`${APP}/${DIR}`]);
  assert.deepEqual(f.calls[3].args, ["-f", "--", `${APP}/${DIR}/old.png`], "the page stays, the old file goes");
});

test("limits: exactly 100 MB local renders, one byte more is a Load hint without osascript, force renders", async () => {
  const at = local(MAX_PDF_LOCAL);
  assert.equal((await at.make().load({ on: null, path: LOCAL })).kind, "pdf");
  const over = local(MAX_PDF_LOCAL + 1), key = cacheKey({ on: null, path: LOCAL, size: MAX_PDF_LOCAL + 1, mtime: 7 });
  assert.deepEqual(await over.make().load({ on: null, path: LOCAL }), { error: "File is larger than 100 MB", load: true, final: true, key, name: `${key}.pdf` });
  assert.deepEqual(over.kinds(), ["probe"]);
  over.calls.length = 0;
  const doc = await over.make().load({ on: null, path: LOCAL, force: true });
  assert.equal(doc.kind, "pdf");
  assert.deepEqual(over.kinds(), ["probe", "render", "list"], "force: rastered from the source path, nothing copied");
  assert.equal(over.calls[1].args[4], LOCAL);
});

test("remote up to 20 MB: fetched as <key>.pdf through ssh, rastered from the cache, page and PDF kept", async () => {
  const key = cacheKey({ on: "box", path: REMOTE, size: MAX_PDF_REMOTE, mtime: 7 }), pdf = `${APP}/${DIR}/${key}.pdf`;
  let list = "";
  const f = fake((c) => c.args?.[1] === PROBE_SCRIPT ? { code: 0, stdout: probeOut(MAX_PDF_REMOTE, 7, PDF), stderr: "" }
    : c.cmd === "osascript" ? rendered(2, +c.args[5], 1000, 500)
    : c.args?.[1] === LIST_SCRIPT ? { code: 0, stdout: list, stderr: "" } : ok);
  list = row(10, pageName(key, 1)) + row(MAX_PDF_REMOTE, `${key}.pdf`) + row(40e6, "old.png");
  const doc = await f.make().load({ on: "box", path: REMOTE });
  assert.deepEqual(doc, { kind: "pdf", path: `${DIR}/${pageName(key, 1)}`, page: 1, pages: 2, width: 500, height: 250 });
  assert.deepEqual(f.kinds(), ["probe", "hc", "ssh", "render", "list", "rm"]);
  assert.equal(f.calls[0].options.on, "box", "the probe runs on the machine");
  assert.deepEqual(f.calls[2].args.slice(2), ["x", REMOTE, `${pdf}.r1.part`, pdf, String(MAX_PDF_REMOTE), "u@box"]);
  assert.equal(f.calls[3].args[4], pdf, "rastered from the fetched copy");
  assert.deepEqual(f.calls[5].args, ["-f", "--", `${APP}/${DIR}/old.png`], "page and PDF are kept");
  // page 2 with the page count known and its PNG present: only the probe, the size from the PNG header
  f.present.add(pdf); f.present.add(`${APP}/${DIR}/${pageName(key, 2)}`); f.files[`${APP}/${DIR}/${pageName(key, 2)}`] = PNG(1000, 500); f.calls.length = 0;
  assert.deepEqual(await f.make().load({ on: "box", path: REMOTE, page: 2, pages: 2 }), { kind: "pdf", path: `${DIR}/${pageName(key, 2)}`, page: 2, pages: 2, width: 500, height: 250 });
  assert.deepEqual(f.kinds(), ["probe"], "a cached page: no hc, no ssh, no osascript");
  // page 2 without its PNG but with the PDF in the cache: one osascript, no fetch, and the PDF stays in the keep list
  f.present.delete(`${APP}/${DIR}/${pageName(key, 2)}`); f.calls.length = 0;
  list = row(10, pageName(key, 2)) + row(MAX_PDF_REMOTE, `${key}.pdf`) + row(40e6, "old.png");
  assert.equal((await f.make().load({ on: "box", path: REMOTE, page: 2, pages: 2 })).page, 2);
  assert.deepEqual(f.kinds(), ["probe", "render", "list", "rm"]);
  assert.deepEqual(f.calls[3].args, ["-f", "--", `${APP}/${DIR}/old.png`], "the PDF is kept although it was not fetched this time (review W2)");
  // without the page count the page is rastered even if its PNG exists (the count only comes from osascript)
  f.present.add(`${APP}/${DIR}/${pageName(key, 2)}`); f.calls.length = 0;
  await f.make().load({ on: "box", path: REMOTE, page: 2 });
  assert.deepEqual(f.kinds(), ["probe", "render", "list", "rm"]);
  // a PNG that vanished between exists and readFile (evicted by another copy): rastered, no error
  delete f.files[`${APP}/${DIR}/${pageName(key, 2)}`]; f.calls.length = 0;
  assert.equal((await f.make().load({ on: "box", path: REMOTE, page: 2, pages: 2 })).error, undefined);
  assert.deepEqual(f.kinds(), ["probe", "render", "list", "rm"]);
});

test("remote over 20 MB: a Load hint without hc or ssh, also with force; a loaded file is rastered from loads/", async () => {
  const size = MAX_PDF_REMOTE + 1, key = cacheKey({ on: "box", path: REMOTE, size, mtime: 7 }), loaded = `${APP}/${loadDir(key)}/${key}.pdf`;
  const f = fake((c) => c.args?.[1] === PROBE_SCRIPT ? { code: 0, stdout: probeOut(size, 7, PDF), stderr: "" }
    : c.cmd === "osascript" ? rendered(5, 1, 100, 100) : c.args?.[1] === LIST_SCRIPT ? { code: 0, stdout: row(10, pageName(key, 1)) + row(60e6, `${key}.pdf`), stderr: "" } : ok);
  for (const force of [false, true]) {
    assert.deepEqual(await f.make().load({ on: "box", path: REMOTE, force }), { error: "File is larger than 20 MB", load: true, final: true, key, name: `${key}.pdf` }, `force ${force}`);
    assert.deepEqual(f.kinds(), ["probe"]);
    f.calls.length = 0;
  }
  f.present.add(loaded);
  const doc = await f.make().load({ on: "box", path: REMOTE });
  assert.deepEqual([doc.kind, doc.pages], ["pdf", 5], "present in loads/: shown without force");
  assert.deepEqual(f.kinds(), ["probe", "render", "list", "rm"]);
  assert.equal(f.calls[1].args[4], loaded);
  assert.deepEqual(f.calls[3].args, ["-f", "--", `${APP}/${DIR}/${key}.pdf`], "keep list without <key>.pdf: it was never fetched into the cache");
});

test("remote PDF under 20 MB: a timed-out ssh becomes a Load hint", async () => {
  const key = cacheKey({ on: "box", path: REMOTE, size: 500, mtime: 7 });
  const f = fake((c) => { if (c.args?.[1] === PROBE_SCRIPT) return { code: 0, stdout: probeOut(500, 7, PDF), stderr: "" }; throw new Error("command timed out after 30s"); });
  assert.deepEqual(await f.make().load({ on: "box", path: REMOTE }), { error: "Download timed out (30 s limit)", load: true, final: true, key, name: `${key}.pdf` });
  assert.deepEqual(f.kinds(), ["probe", "hc", "ssh"]);
});

test("remote PDF under 20 MB: a copy in loads/<key>/ is rastered without hc or ssh", async () => {
  const key = cacheKey({ on: "box", path: REMOTE, size: 500, mtime: 7 }), loaded = `${APP}/${loadDir(key)}/${key}.pdf`;
  const f = fake((c) => c.args?.[1] === PROBE_SCRIPT ? { code: 0, stdout: probeOut(500, 7, PDF), stderr: "" }
    : c.cmd === "osascript" ? rendered(2, 1, 100, 100) : c.args?.[1] === LIST_SCRIPT ? { code: 0, stdout: row(10, pageName(key, 1)), stderr: "" } : ok);
  f.present.add(loaded);
  const doc = await f.make().load({ on: "box", path: REMOTE });
  assert.deepEqual([doc.kind, doc.pages], ["pdf", 2]);
  assert.deepEqual(f.kinds(), ["probe", "render", "list"]);
  assert.equal(f.calls[1].args[4], loaded);
});

test("not macOS: a hint before any exec", async () => {
  const f = local(500, { platform: "linux" });
  assert.deepEqual(await f.make().load({ on: null, path: LOCAL }), { error: "PDF preview needs macOS", final: true });
  assert.deepEqual(f.calls, []);
  const g = local(500, { platform: undefined });
  assert.equal((await g.make().load({ on: null, path: LOCAL })).error, "PDF preview needs macOS", "unknown platform fails closed");
});

test("locked, empty, broken, write, timeout and junk: a hint, no eviction", async () => {
  const cases = [['{"error":"locked"}', "PDF is password-protected · no preview"], ['{"error":"empty"}', "PDF has no pages · no preview"],
    ['{"error":"broken"}', "Cannot read this PDF · no preview"], ['{"error":"write"}', "Cannot write the page image · no preview"], ["", "Cannot load this PDF: unknown error"]];
  for (const [stdout, error] of cases) {
    const f = fake((c) => c.args?.[1] === PROBE_SCRIPT ? { code: 0, stdout: probeOut(500, 7, PDF), stderr: "" } : c.cmd === "osascript" ? { code: 0, stdout, stderr: "" } : ok);
    assert.deepEqual(await f.make().load({ on: null, path: LOCAL }), { error, final: true }, stdout);
    assert.deepEqual(f.kinds(), ["probe", "render"], "no list, no rm after a failed render");
  }
  const t = fake((c) => c.args?.[1] === PROBE_SCRIPT ? { code: 0, stdout: probeOut(500, 7, PDF), stderr: "" } : (() => { throw new Error("command timed out after 30s"); })());
  assert.deepEqual(await t.make().load({ on: null, path: LOCAL }), { error: "Rendering timed out (30 s limit) · no preview", final: true });
  const e = fake((c) => c.args?.[1] === PROBE_SCRIPT ? { code: 0, stdout: probeOut(500, 7, PDF), stderr: "" } : { code: 1, stdout: "", stderr: "execution error: boom (-1)\n" });
  assert.equal((await e.make().load({ on: null, path: LOCAL })).error, "Cannot load this PDF: execution error: boom (-1)");
});

test("no PDF header, a gone file and badSpelling: a hint, nothing rendered", async () => {
  const f = fake(() => ({ code: 0, stdout: probeOut(500, 7, PNG(1, 1)), stderr: "" }));
  assert.deepEqual(await f.make().load({ on: null, path: LOCAL }), { error: "File header is not PDF · no preview", final: true });
  assert.deepEqual(f.kinds(), ["probe"]);
  const big = fake(() => ({ code: 0, stdout: probeOut(MAX_PDF_LOCAL + 1, 7, PNG(1, 1)), stderr: "" }));
  assert.equal((await big.make().load({ on: null, path: LOCAL })).load, undefined, "a wrong header over the limit gets no Load");
  const gone = fake(() => ({ code: 0, stdout: "-1\n", stderr: "" }));
  assert.deepEqual(await gone.make().load({ on: null, path: LOCAL }), { error: "This file is no longer available", final: true });
  const bad = fake(() => { throw new Error("must not run"); });
  assert.deepEqual(await bad.make().load({ on: null, path: "/Users/m/../doc.pdf" }), { error: 'Path must not contain ".", ".." or "//"' });
  assert.deepEqual(bad.calls, []);
});

// The real thing, macOS only: osascript with RENDER_SCRIPT on a two-page PDF written under tmp/.
const realExec = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, (err, stdout, stderr) => { if (err && err.code === "ENOENT") reject(err); else resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }); });
});
test("osascript renders page 2 of a tiny PDF to a 600 x 300 PNG, turns a rotated page and reports broken files", { skip: process.platform !== "darwin" && "macOS only" }, async () => {
  const dir = await mkTmp("filer-pro-pdf-"), src = path.join(dir, "three.pdf"), out = path.join(dir, "p.png");
  try {
    await fs.writeFile(src, ["%PDF-1.4", "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj", "2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >> endobj", "4 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 150] >> endobj",
      "5 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Rotate 90 >> endobj", "trailer << /Root 1 0 R >>", ""].join("\n"));
    const render = async (file, page) => parseRender((await realExec("osascript", ["-l", "JavaScript", "-e", RENDER_SCRIPT, file, page, out])).stdout);
    assert.deepEqual(await render(src, "2"), { pages: 3, page: 2, width: 600, height: 300 });
    const png = await fs.readFile(out);
    assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [600, 300]);
    assert.deepEqual(await render(src, "3"), { pages: 3, page: 3, width: 200, height: 400 }, "a page with /Rotate 90 is portrait");
    assert.equal((await render(src, "9")).page, 3, "page 9 clamps to the last page");
    await fs.writeFile(path.join(dir, "no.pdf"), "not a pdf");
    assert.equal((await render(path.join(dir, "no.pdf"), "1")).error, "Cannot read this PDF · no preview");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("index.js: the PDF view, the page buttons and largeNote (source guard)", async () => {
  const index = await fs.readFile(new URL("../mods/filer-pro/preview/index.js", import.meta.url), "utf8");
  assert.match(index, /export \{ createImages \} from "\.\/images\.js";/, "the line test/images.test.js checks stays as it is");
  assert.match(index, /export \{ clearLoads, loadDir, previewJob, loadOutcome, resolveFile \} from "\.\/images\.js";/);
  assert.match(index, /export \{ createPdfs \} from "\.\/pdf\.js";/);
  assert.match(index, /if \(doc\.kind === "image" \|\| doc\.kind === "pdf"\) return picture\(doc, width, onWidth\);/);
  assert.match(index, /export function largeNote\(text, t, onLoad\)/);
  assert.ok(index.includes('button("files-load", "Load"'), "the Load button");
  for (const s of ['"Previous"', '"Next"', "files-page-prev", "files-page-next", "${page} / ${pages}"]) assert.ok(index.includes(s), s);
  assert.match(index, /if \(doc\.kind === "image"\) return \[\];/, "no buttons for an image");
  const harness = await fs.readFile(new URL("../test/check-preview/main.js", import.meta.url), "utf8");
  for (const s of ['kind: "pdf"', "largeNote(", "onPage"]) assert.ok(harness.includes(s), `check-preview draws ${s}`);
});

test("main.js: PDFs are decided before the text is read, Load starts a quiet job, pages and force reach the dialog (source guard)", async () => {
  const main = await fs.readFile(new URL("../mods/filer-pro/main.js", import.meta.url), "utf8");
  const show = main.indexOf("  show(path, cx, opts = {}) {"), view = main.indexOf("  viewer(t) {");
  assert.ok(show > 0 && view > show);
  const branch = main.indexOf('kind === "pdf"', show), text = main.indexOf("readTextFile(joinPath(root, path)", show);
  assert.ok(branch > 0 && branch < text, "the PDF branch comes before the text read");
  assert.ok(main.includes("previewer.createPdfs({") && main.includes("platform: window()?.platform"), "pdfs are created with the window's platform");
  assert.match(main, /loadLarge\(cx\) \{/, "the Load click has its own handler");
  const body = (name) => { const i = main.indexOf(`  ${name}(`); return main.slice(i, main.indexOf("\n  }\n", i)); };
  for (const m of ["show", "showHint", "turnPage"]) assert.ok(!body(m).includes("clearLoads(") && !body(m).includes("jobs.start("), `${m}() never clears loads and never starts a job (review B1)`);
  assert.ok(body("loadLarge").includes("clearLoads({") && body("loadLarge").includes("fetchLoad(") && body("loadLarge").includes("force: true"), "Load clears, then fetches (job) or shows with force (local PDF)");
  assert.ok(body("fetchLoad").includes("previewJob(") && body("fetchLoad").includes("fs.exists(dest)"), "a running job is joined, a present file is shown, else a job starts (review B2)");
  assert.match(main, /jobs\.start\(\{[^}]*direction: on \? "down" : "local"[^}]*choice: "new"[^}]*preview: true, as: name/, "the Load is a quiet down (remote) or local job under the fixed name");
  assert.ok(body("fetchLoad").includes("resolveFile(") && body("fetchLoad").includes("src = on ?"), "a local source is resolved before the job (cp -P would copy the link)");
  assert.ok(body("loadLarge").includes("viaJob(name)") && main.includes('extOf(name ?? "") !== "pdf"'), "local images go through the job, local PDFs stay with show(force)");
  assert.ok(body("showHint").includes("viaJob(doc.name)") && body("waitLoad").includes("viaJob(this.loadName)"), "the dialog points to the panel for a local image too, as for a machine");
  assert.ok(body("showHint").includes("previewJob(") && body("showHint").includes('" · Load it in the panel"'), "the dialog joins a running job or points to the panel");
  assert.ok(body("turnPage").includes("showHint("), "a hint while turning pages gets the same treatment");
  assert.ok(!body("fileOverlay").includes("jobs") && !body("overlayView").includes("jobs"), "the dialog never starts jobs");
  assert.ok(main.includes('while (j?.state === "running" && this.file === path && this.current(context))'), "the poll stops with the file");
  assert.ok(main.includes("loadOutcome(j)") && main.includes('"Loading… · progress in the transfers bar"'));
  assert.ok(main.includes('"PDFs have no source view"') && main.includes('"Images have no source view"'));
  assert.ok(main.includes('"Loading PDF…"') && main.includes('"Loading image…"'));
  assert.match(main, /openOverlay\(\{\s*mod: "filer-pro",\s*props: \{\s*view: "file",[^}]*page: this\.page, pages: this\.pages, force: this\.force[^}]*\}/, "the dialog gets page, pages and force");
  assert.match(main, /this\.show\(props\(\)\.path, cx, \{ mode: props\(\)\.mode, page: props\(\)\.page, pages: props\(\)\.pages, force: props\(\)\.force \}\)/);
  const loadText = main.indexOf("if (this.loader)", view), pic = main.indexOf('this.doc.kind === "pdf"', view), code = main.indexOf("if (!this.code)", view);
  assert.ok(loadText > 0 && loadText < pic && pic < code, "viewer: Load hint, then the page, then the loading text");
});

test("settings: maxLocal, maxRemote and cacheLimit per call", async () => {
  const MB = 1024 * 1024;
  const over = local(6 * MB);
  assert.equal((await over.make().load({ on: null, path: LOCAL, maxLocal: 5 * MB })).error, "File is larger than 5 MB");
  assert.equal((await local(6 * MB).make().load({ on: null, path: LOCAL, maxLocal: 7 * MB })).kind, "pdf");
  const size = 30 * MB;
  const r = fake((c) => c.args?.[1] === PROBE_SCRIPT ? { code: 0, stdout: probeOut(size, 7, PDF), stderr: "" } : ok);
  assert.equal((await r.make().load({ on: "box", path: REMOTE, maxRemote: 25 * MB })).error, "File is larger than 25 MB");
  const key = cacheKey({ on: null, path: LOCAL, size: 500, mtime: 7 });
  const c = fake((x) => x.args?.[1] === PROBE_SCRIPT ? { code: 0, stdout: probeOut(500, 7, PDF), stderr: "" }
    : x.cmd === "osascript" ? rendered(3, 1, 1224, 1584) : x.args?.[1] === LIST_SCRIPT ? { code: 0, stdout: row(10, pageName(key, 1)) + row(60e6, "old.png"), stderr: "" } : ok);
  await c.make().load({ on: null, path: LOCAL, cacheLimit: 100 * MB });
  assert.deepEqual(c.kinds(), ["probe", "render", "list"], "under a 100 MB cache the old file stays");
});
