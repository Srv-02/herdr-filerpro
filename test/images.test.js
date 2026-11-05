import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkTmp } from "./tmp-helper.js";
import path from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createImages, sniff, dimensions, cacheKey, evictPlan, fit, MAX_IMAGE, CACHE_LIMIT, DIR, PROBE_SCRIPT, FETCH_LOCAL, FETCH_SSH, LIST_SCRIPT, LOADS, loadDir, stalePlan, clearLoads, resolveFile, previewJob, loadOutcome, LOADS_LIST_SCRIPT } from "../mods/filer-pro/preview/images.js";

const APP = "/Users/m/.config/herdr-app";
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const be32 = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const PNG = (w, h) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, ...be32(w), ...be32(h), 8, 6, 0, 0, 0]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0, 0, 0, 0]); // SOF0: 640 × 480
const GIF = Uint8Array.from([...ascii("GIF89a"), 16, 0, 8, 0]);
const WEBP = Uint8Array.from([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBPVP8X"), 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0x03, 0x00, 0xff, 0x02, 0x00]); // 1024 × 768
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" ");
const probeOut = (size, mtime, bytes) => `${size} ${mtime}\n   ${hex(bytes)}\n`;

// A fake of exec, hc, exists and unlink in the style of test/diagrams.test.js. `behave(call)` returns { code, stdout, stderr } or throws.
function fake(behave) {
  const f = { calls: [], unlinks: [], present: new Set() };
  f.exec = async (cmd, args, options) => { f.calls.push({ cmd, args, options }); return behave(f.calls.at(-1)); };
  f.hc = async (args) => { f.calls.push({ cmd: "hc", args }); return { code: 0, stdout: JSON.stringify({ machines: [{ name: "box", target: "u@box" }] }), stderr: "" }; };
  f.exists = async (p) => f.present.has(p);
  f.unlink = async (p) => { f.unlinks.push(p); };
  f.make = () => createImages({ exec: f.exec, hc: f.hc, exists: f.exists, unlink: f.unlink, appHome: () => APP, rand: () => "r1" });
  f.kinds = () => f.calls.map((c) => c.cmd === "hc" ? "hc" : c.cmd === "rm" && c.args[0] === "-rf" ? "rmrf" : c.cmd === "rm" ? "rm" : c.args[1] === PROBE_SCRIPT ? "probe" : c.args[1] === FETCH_SSH ? "scp" : c.args[1] === FETCH_LOCAL ? "cp" : c.args[1] === LOADS_LIST_SCRIPT ? "loads" : c.args[1] === LIST_SCRIPT ? "list" : c.cmd);
  return f;
}
const realExec = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, (err, stdout, stderr) => { if (err && err.code === "ENOENT") reject(err); else resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }); });
});

test("sniff: the header must match the extension", () => {
  assert.equal(sniff(PNG(1, 1), "png"), "png");
  assert.equal(sniff(PNG(1, 1), "jpg"), null);
  assert.equal(sniff(PNG(1, 1), "svg"), null);
  assert.equal(sniff(JPEG, "jpg"), "jpeg");
  assert.equal(sniff(JPEG, "jpeg"), "jpeg");
  assert.equal(sniff(GIF, "gif"), "gif");
  assert.equal(sniff(WEBP, "webp"), "webp");
  assert.equal(sniff(ascii('<?xml version="1.0"?>\n<!-- a -->\n<svg xmlns="http://www.w3.org/2000/svg">'), "svg"), "svg");
  assert.equal(sniff(ascii("<svg>"), "svg"), "svg");
  assert.equal(sniff(ascii("hello <svg"), "svg"), null, "text before the root element is no SVG");
  assert.equal(sniff(ascii("MZ\x90\x00"), "png"), null, "a renamed executable");
  assert.equal(sniff(new Uint8Array(0), "png"), null, "an empty file");
});

test("dimensions reads PNG, GIF, JPEG, WebP and SVG headers", () => {
  assert.deepEqual(dimensions(PNG(300, 200)), { width: 300, height: 200 });
  assert.deepEqual(dimensions(GIF), { width: 16, height: 8 });
  assert.deepEqual(dimensions(JPEG), { width: 640, height: 480 });
  assert.deepEqual(dimensions(WEBP), { width: 1024, height: 768 });
  assert.deepEqual(dimensions(ascii('<svg width="10" height="5">')), { width: 10, height: 5 });
  assert.deepEqual(dimensions(ascii('<svg width="10px" height="5px">')), { width: 10, height: 5 });
  assert.deepEqual(dimensions(ascii('<svg viewBox="0 0 640 480">')), { width: 640, height: 480 });
  assert.equal(dimensions(ascii("<svg>")), null);
  assert.equal(dimensions(ascii("hello")), null);
});

// The renderer uses the real width and height, so a size we cannot read must not fall back to a small viewBox.
test("dimensions: an SVG width or height that is not a plain number is no size", () => {
  const box = ' viewBox="0 0 10 10"';
  for (const attrs of ['width="100000mm" height="100000mm"', 'width="1e5" height="1e5"', 'width="100em" height="10em"',
    "width='100000mm' height='100000mm'", 'width = "100000mm" height = "100000mm"', 'width="10" height="100000mm"', 'width="100000mm"',
    'width=100000mm height=100000mm', 'width="" height=""']) {
    assert.equal(dimensions(ascii(`<svg ${attrs}${box}>`)), null, attrs);
  }
  assert.deepEqual(dimensions(ascii("<svg width='10' height='5'>")), { width: 10, height: 5 });
  assert.deepEqual(dimensions(ascii('<svg width = "10px" height = "5">')), { width: 10, height: 5 });
  // only the root's own, first-class attributes count
  assert.deepEqual(dimensions(ascii('<svg data-width="1" data-height="1" width="10" height="5">')), { width: 10, height: 5 });
  assert.equal(dimensions(ascii('<svg data-width="1" data-height="1" viewBox="0 0 10 10">')).width, 10);
  assert.equal(dimensions(ascii('<svg foo=" width=5 height=5" width="100000mm" height="100000mm" viewBox="0 0 10 10">')), null, "a value that contains width= is no attribute");
  assert.equal(dimensions(ascii("<svg foo=' width=\"5\" height=\"5\"' width='9mm' height='9mm' viewBox='0 0 10 10'>")), null);
  assert.equal(dimensions(ascii('<svg width="5" width="100000mm" height="5" viewBox="0 0 10 10">')), null, "duplicate attributes fail closed");
  assert.equal(dimensions(ascii('<svg width="5" height="5" "junk" viewBox="0 0 10 10">')), null, "malformed list fails closed");
  assert.equal(dimensions(ascii('<!-- <svg width="1" height="1"> --><svg width="100000mm" height="100000mm" viewBox="0 0 10 10">')), null, "the root is the one isSvg finds, not a commented one");
  assert.equal(dimensions(ascii('<svg data-x=">" width="100000mm" height="100000mm" viewBox="0 0 10 10">')), null, "a > inside a value does not end the tag");
});

// Percentages and missing sizes (common in icons) take the viewBox; other units stay fail closed.
test("dimensions: a percentage or missing SVG size falls back to the viewBox", () => {
  const d = (a) => dimensions(ascii(`<svg ${a}>`));
  assert.deepEqual(d('width="100%" height="100%" viewBox="0 0 24 24"'), { width: 24, height: 24 });
  assert.deepEqual(d('width="100%" viewBox="0 0 24 12"'), { width: 24, height: 12 });
  assert.deepEqual(d('height="50%" viewBox="0,0,24,12"'), { width: 24, height: 12 });
  // one plain size scales the other by the aspect ratio, as the renderer draws it
  assert.deepEqual(d('width="32" viewBox="0 0 24 12"'), { width: 32, height: 16 });
  assert.deepEqual(d('height="32" viewBox="0 0 24 12"'), { width: 64, height: 32 });
  assert.deepEqual(d('width="32" height="100%" viewBox="0 0 24 24"'), { width: 32, height: 32 });
  assert.equal(d('width="100%"'), null, "no viewBox, no size");
  assert.equal(d('width="100%" height="100%" viewBox="0 0 0 24"'), null);
  assert.equal(d('width="100%" height="100%" viewBox="0 0 24"'), null);
  assert.equal(d('width="100%" height="100%" viewBox="0 0 24 x"'), null);
  assert.equal(d('width="100000mm" viewBox="0 0 24 24"'), null);
  assert.equal(d('width="100%" height="100000mm" viewBox="0 0 24 24"'), null);
  assert.equal(d('width="100%" height="5em" viewBox="0 0 24 24"'), null);
});

test("dimensions: the 100 megapixel limit holds for every SVG that gets a size", () => {
  for (const a of ['width="100000" viewBox="0 0 1 1"', 'height="100000" viewBox="0 0 1 1"', 'width="100000" height="100000"', 'width="100%" viewBox="0 0 100000 100000"', 'width="20000" viewBox="0 0 1 1"']) {
    const r = dimensions(ascii(`<svg ${a}>`));
    assert.ok(r && r.width * r.height > 100e6, a);
  }
  for (const a of ['width="1e5" viewBox="0 0 1 1"', 'width="100000in" viewBox="0 0 1 1"']) assert.equal(dimensions(ascii(`<svg ${a}>`)), null, a);
});

test("dimensions: an SVG with a size-free <style> or style attribute is an image, one that sets a size or loads more is not", () => {
  const d = (a) => dimensions(ascii(`<svg ${a}>`)), doc = (inner, attrs = 'viewBox="0 0 24 24"') => dimensions(ascii(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>`));
  const ok = { width: 24, height: 24 };
  // Illustrator/Figma export
  assert.deepEqual(doc("<defs><style>.cls-1 { fill: #007994; stroke-width: 0px; } @media (prefers-color-scheme: dark) { .cls-1 { fill: #ffffff; } }</style></defs>"), ok);
  assert.deepEqual(doc("<style>.a{stroke-width:2;line-height:1;fill:red}</style>"), ok, "stroke-width and line-height are no size");
  assert.deepEqual(doc("<style><![CDATA[ .a{fill:red} ]]></style>"), ok, "CDATA around harmless css");
  assert.deepEqual(doc("<STYLE>.a{fill:red}</STYLE>"), ok);
  assert.deepEqual(doc("<style/>"), ok);
  assert.deepEqual(d(`style="fill:red" viewBox="0 0 24 24"`), ok, "style attribute without a size");
  assert.deepEqual(d(`style='' width="10" height="5"`), { width: 10, height: 5 }, "an empty style attribute");
  assert.equal(d(`style="width:9e9px" viewBox="0 0 24 24"`), null);
  for (const st of ["width:100000px", "min-width:100000px", "inline-size:1e5px", "zoom:1000", "max-block-size:1e9px", "WIDTH : 9", "fill:red;&#119;idth:9", "fill:red;wid\\74 h:9", "background:url(a.png)"])
    assert.equal(d(`style="${st}" viewBox="0 0 24 24"`), null, st);
  for (const css of ["svg{width:1e5px}", "svg{ width : 1e5px }", ".a{min-height:9e9px}", "svg{max-width:1e9px}", "svg{min-inline-size:1e9px}", "svg{block-size:1e9px}", "svg{zoom:1000}", "a{width/**/:1e9px}",
    "@import 'a.css';", "@import url(a.css);", ".a{fill:url(#g)}", ".a{content:'\\77 idth'}", ".a{fill:red}svg{&#119;idth:9e9px}"])
    assert.equal(doc(`<style>${css}</style>`), null, css);
  assert.equal(doc("<style><![CDATA[ svg{width:1e5px} ]]></style>"), null, "CDATA does not hide a size");
  assert.equal(doc("<svg:style>svg{width:1e5px}</svg:style>"), null, "a namespace prefix does not hide the element");
  assert.equal(doc("<x:STYLE>svg{width:1e5px}</x:STYLE>"), null);
  assert.deepEqual(doc("<svg:style>.a{fill:red}</svg:style>"), ok);
  assert.equal(doc("<style>.a{fill:red}</style><style>svg{width:1e5px}</style>"), null, "the second block counts too");
  assert.equal(doc("<style>svg{width:1e5px}"), null, "an unclosed block counts");
  assert.deepEqual(doc("<styles>width:9</styles>"), ok, "styles is no style element");
  for (const bad of ["<?xml-stylesheet href=\"a.css\"?><svg viewBox=\"0 0 24 24\"></svg>", "<?XML-Stylesheet href=\"a.css\"?><svg viewBox=\"0 0 24 24\"></svg>",
    "<!DOCTYPE svg [<!ENTITY a \"b\">]><svg viewBox=\"0 0 24 24\"></svg>", "<!DOCTYPE svg [ ]><svg viewBox=\"0 0 24 24\"></svg>",
    "<svg viewBox=\"0 0 24 24\"><!ENTITY a \"b\"></svg>"])
    assert.equal(dimensions(ascii(bad)), null, bad);
  assert.deepEqual(dimensions(ascii('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg viewBox="0 0 24 24"></svg>')), ok, "a DOCTYPE without internal subset");
  assert.equal(doc("<foreignObject><div/></foreignObject>"), null);
  assert.equal(doc("<svg:foreignObject/>"), null);
  assert.equal(doc("<g xmlns:h=\"http://www.w3.org/1999/xhtml\"/>"), null, "the XHTML namespace");
  const late = "<svg viewBox=\"0 0 24 24\">" + "<!-- -->".repeat(2000) + "<style>svg{width:1e5px}</style></svg>";
  assert.equal(dimensions(ascii(late)), null, "a <style> behind the first 4 KiB is still found");
  assert.deepEqual(dimensions(ascii('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>')), ok, "a plain icon stays an image");
  assert.deepEqual(d('data-style="x" stroke-width="2" viewBox="0 0 24 24"'), ok, "only an attribute named style counts");
  const t0 = Date.now();
  dimensions(ascii('<svg viewBox="0 0 24 24">' + "<style>".repeat(9000) + "</svg>"));
  dimensions(ascii('<svg viewBox="0 0 24 24"><style>' + "/*".repeat(30000) + "</svg>"));
  assert.ok(Date.now() - t0 < 1500, "hostile repeated <style stays fast");
});

const le32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24];
// BMP payload: a BITMAPINFOHEADER (size 40, biWidth, biHeight, planes 1, 32 bpp); the height includes the AND mask.
const BMP = (w, h) => Uint8Array.from([...le32(40), ...le32(w), ...le32(h), 1, 0, 32, 0, ...new Array(20).fill(0)]);
// Entries are [w, h] with a BMP payload matching the directory, or [w, h, ihdrW, ihdrH] with an embedded PNG; the payloads follow the directory.
const icoOf = (...es) => {
  const dir = 6 + 16 * es.length, payloads = es.map(([w, h, pw, ph]) => pw ? PNG(pw, ph) : BMP(w || 256, (h || 256) * 2));
  let off = dir;
  const head = [0, 0, 1, 0, es.length, 0, ...es.flatMap(([w, h], i) => {
    const e = [w, h, 0, 0, 1, 0, 32, 0, ...le32(payloads[i].length), ...le32(off)];
    off += payloads[i].length;
    return e;
  })];
  return Uint8Array.from([...head, ...payloads.flatMap((p) => [...p])]);
};

test("ICO: detected by header, dimensions from the largest directory entry", () => {
  const ico = icoOf;
  assert.equal(sniff(ico([16, 16]), "ico"), "ico");
  assert.equal(sniff(ico([16, 16]), "png"), null);
  assert.deepEqual(dimensions(ico([16, 16])), { width: 16, height: 16 });
  assert.deepEqual(dimensions(ico([16, 16], [48, 32], [32, 32])), { width: 48, height: 32 }, "the largest entry wins");
  assert.deepEqual(dimensions(ico([0, 0], [32, 32])), { width: 256, height: 256 }, "0 means 256");
  assert.equal(sniff(ico(), "ico"), null, "count 0 is no ICO");
  assert.equal(dimensions(ico()), null);
  assert.equal(sniff(Uint8Array.from([0, 0, 2, 0, 1, 0]), "ico"), null, "a cursor (type 2) is no ICO");
  const whole = ico([16, 16], [32, 32]);
  for (let n = 6; n < 6 + 16 * 2; n++) assert.equal(dimensions(whole.subarray(0, n)), null, `directory cut at ${n}`);
  assert.deepEqual(dimensions(whole), { width: 32, height: 32 });
});

test("ICO: an embedded PNG counts with its IHDR size, not the directory size", () => {
  const ico = icoOf;
  assert.deepEqual(dimensions(ico([16, 16, 20000, 20000])), { width: 20000, height: 20000 }, "directory says 16x16, IHDR says 20000x20000");
  assert.deepEqual(dimensions(ico([32, 32], [16, 16, 300, 200])), { width: 300, height: 200 });
  assert.deepEqual(dimensions(ico([0, 0, 256, 256])), { width: 256, height: 256 }, "a normal PNG icon stays an image");
  const far = ico([16, 16, 16, 16]);
  assert.equal(dimensions(far.subarray(0, 22 + 23)), null, "IHDR not fully inside the probe: unknown");
  const out = far.slice();
  out.set([0, 0, 1, 0], 6 + 12); // data offset 65536, behind the probe
  assert.equal(dimensions(out), null, "payload offset outside the probe: unknown");
});

test("ICO: a BMP header larger than the directory counts, a PNG needs signature and IHDR", () => {
  const ico = icoOf;
  const withBmp = (w, h) => { const b = ico([16, 16]); b.set(BMP(w, h), 22); return b; };
  assert.deepEqual(dimensions(withBmp(30000, 60000)), { width: 30000, height: 30000 }, "directory 16x16, header 30000x60000 (30000 high)");
  assert.deepEqual(dimensions(withBmp(32, -64)), { width: 32, height: 32 }, "a negative height is its absolute value");
  assert.equal(dimensions(withBmp(0, 64)), null, "biWidth 0: unknown");
  assert.equal(dimensions(withBmp(-5, 64)), null, "negative biWidth: unknown");
  assert.deepEqual(dimensions(ico([32, 32])), { width: 32, height: 32 }, "a normal BMP icon stays an image");
  assert.equal(dimensions(ico([32, 32]).subarray(0, 22 + 15)), null, "header not inside the probe: unknown");
  const badType = ico([16, 16, 16, 16]);
  badType.set([0x58], 22 + 12); // IHDR becomes XHDR
  assert.equal(dimensions(badType), null, "PNG signature with a wrong chunk type: unknown");
  const badSig = ico([16, 16, 16, 16]);
  badSig.set([0x00], 22 + 7); // the last signature byte is wrong: no PNG, so the bytes are read as a BMP header and are huge
  const d = dimensions(badSig);
  assert.ok(d && d.width * d.height > 100e6, "an incomplete signature is no PNG: the IHDR size does not count");
});

test("load: an SVG larger than the 64 KiB probe is no image", async () => {
  const svg = ascii('<svg viewBox="0 0 24 24"></svg>');
  const f = fake((c) => ({ code: 0, stdout: probeOut(70000, 1, svg), stderr: "" }));
  const r = await f.make().load({ on: null, path: "/Users/m/big.svg" });
  assert.ok(r.error && !r.final, "an error that falls through to the text view");
});

test("cacheKey changes with machine, path, size and mtime", () => {
  const base = { on: "box", path: "/home/u/a.png", size: 10, mtime: 100 };
  const keys = [base, { ...base, on: null }, { ...base, path: "/home/u/b.png" }, { ...base, size: 11 }, { ...base, mtime: 101 }].map(cacheKey);
  assert.equal(new Set(keys).size, 5);
  assert.equal(cacheKey(base), cacheKey({ ...base }));
  assert.match(keys[0], /^[a-z0-9]+$/);
});

test("cacheKey is a SHA-256 of machine, path, size and mtime", () => {
  assert.equal(cacheKey({ on: "box", path: "/home/u/a.png", size: 10, mtime: 100 }), createHash("sha256").update(JSON.stringify(["box", "/home/u/a.png", 10, 100])).digest("hex"));
});

// Runs in a child with a timeout, so a regression fails the test instead of hanging it.
test("svg detection stays linear on hostile headers", async () => {
  const script = `import(process.argv[1]).then(({ sniff, dimensions }) => {
    const heads = [("<!---->" + " ").repeat(500) + "x", "<!--".repeat(1024), "<?xml ".repeat(680), "<!DOCTYPE ".repeat(400), " ".repeat(4000) + "x", "\\n\\t ".repeat(1300) + "x",
      "<svg " + ' width="1'.repeat(400), "<svg " + " ".repeat(4000), '<svg viewBox="0' + ", ".repeat(1500) + "x", '<svg viewBox="0 0' + " ".repeat(3000) + "x", "<svg" + ' width = "'.repeat(400)];
    const warm = Uint8Array.from('<svg width="1"/>', (c) => c.charCodeAt(0)); sniff(warm, "svg"); dimensions(warm); // JIT warm-up, so a loaded machine does not time the cold start
    const times = heads.map((h) => { const b = Uint8Array.from(h.slice(0, 4096), (c) => c.charCodeAt(0)), t = Date.now(); sniff(b, "svg"); dimensions(b); return Date.now() - t; });
    console.log(JSON.stringify(times));
  });`;
  const out = await new Promise((resolve) => execFile(process.execPath, ["--input-type=module", "-e", script, new URL("../mods/filer-pro/preview/images.js", import.meta.url).href], { timeout: 20000 }, (err, stdout) => resolve(err ? String(err.killed ? "timeout" : err) : stdout)));
  const times = out.startsWith("[") ? JSON.parse(out) : [out];
  // A regression is quadratic or worse (seconds, or the 20 s timeout); the limit leaves room for a loaded machine.
  assert.ok(times.every((t) => t < 250), `a header took 250 ms or more: ${times}`);
});

test("evictPlan removes the oldest beyond 50 MB, counts the new file, never names it or a .part", () => {
  const row = (size, name) => `-rw-r--r--  1 501  20  ${size} Nov  4 15:00 ${name}\n`;
  const list = "total 8\n" + row(10, "new.png") + row(30, "b.png") + row(20, "c.jpeg") + row(5, "d.webp") + row(0, "e.png.r1.part") + row(7, "../x") + "drwxr-xr-x  2 501  20  64 Nov  4 15:00 sub\n";
  assert.deepEqual(evictPlan(list, 45, ["new.png"]), ["c.jpeg", "d.webp"]);
  assert.deepEqual(evictPlan(list, 100, ["new.png"]), []);
  assert.deepEqual(evictPlan("", 1, ["new.png"]), []);
  assert.deepEqual(evictPlan(row(60, "new.png") + row(1, "old.png"), 50, ["new.png"]), ["old.png"], "the new file is counted but never named");
  assert.deepEqual(evictPlan(row(60, "b.pdf") + row(1, "c.png"), 50, ["b.pdf", "c.png"]), [], "every name of the keep list stays");
  assert.deepEqual(evictPlan(row(60, "a.png") + row(1, "b.pdf"), 50, ["a.png"]), ["b.pdf"]);
});

test("fit follows the width and never exceeds the original", () => {
  assert.deepEqual(fit(300, 200, 0), { w: 300, h: 200 }, "width unknown: original size");
  assert.deepEqual(fit(300, 200, 200), { w: 168, h: 112 });
  assert.deepEqual(fit(100, 50, 1000), { w: 100, h: 50 });
  assert.deepEqual(fit(300, 200, 40), { w: 80, h: 53 });
});

test('a PNG opens as an image, not as "Binary file · no text preview"', async () => {
  const dir = await mkTmp("filer-pro-images-"), app = path.join(dir, "app"), pic = path.join(dir, "pic one.png");
  try {
    await fs.writeFile(pic, PNG(300, 200));
    await fs.symlink(pic, path.join(dir, "link.png"));
    await fs.symlink(path.join(dir, "gone.png"), path.join(dir, "dangling.png"));
    await fs.writeFile(path.join(dir, "fake.png"), "MZ not a png");
    const calls = [];
    const exec = (cmd, args, options) => { calls.push({ cmd, args, options }); return realExec(cmd, args); };
    const images = createImages({ exec, hc: async () => { throw new Error("not remote"); }, exists: (p) => fs.access(p).then(() => true, () => false), unlink: fs.unlink, appHome: () => app });
    const doc = await images.load({ on: null, path: pic });
    assert.equal(doc.error, undefined, JSON.stringify(doc));
    assert.equal(doc.kind, "image");
    assert.deepEqual([doc.width, doc.height], [300, 200]);
    assert.doesNotMatch(JSON.stringify(doc), /Binary/);
    assert.match(doc.path, new RegExp(`^${DIR}/[a-z0-9]+\\.png$`));
    assert.deepEqual(await fs.readFile(path.join(app, doc.path)), Buffer.from(PNG(300, 200)));
    assert.deepEqual(calls.map((c) => c.cmd), ["sh", "sh", "sh"], "probe, copy, list");
    assert.ok(calls.every((c) => c.options.on === null));
    calls.length = 0;
    assert.deepEqual(await images.load({ on: null, path: pic }), doc);
    assert.deepEqual(calls.map((c) => c.cmd), ["sh"], "a hit is only the probe");
    const viaLink = await images.load({ on: null, path: path.join(dir, "link.png") });
    assert.deepEqual([viaLink.error, viaLink.width, viaLink.height], [undefined, 300, 200], "a link opens like its target");
    assert.deepEqual(await images.load({ on: null, path: path.join(dir, "dangling.png") }), { error: "This file is no longer available", final: true });
    assert.deepEqual(await images.load({ on: null, path: path.join(dir, "fake.png") }), { error: "File header is not PNG · no preview" });
    assert.deepEqual((await fs.readdir(path.join(app, DIR))).filter((n) => n.includes(".part")), []);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("a file that changes between probe and copy never enters the cache", async () => {
  const dir = await mkTmp("filer-pro-images-"), app = path.join(dir, "app"), pic = path.join(dir, "grow.png");
  try {
    await fs.writeFile(pic, PNG(300, 200));
    const calls = [];
    const exec = async (cmd, args, options) => {
      calls.push({ cmd, args });
      const r = await realExec(cmd, args);
      if (args[1] === PROBE_SCRIPT) await fs.appendFile(pic, Buffer.alloc(1000, 1));
      return r;
    };
    const images = createImages({ exec, hc: async () => { throw new Error("not remote"); }, exists: (p) => fs.access(p).then(() => true, () => false), unlink: fs.unlink, appHome: () => app });
    const doc = await images.load({ on: null, path: pic });
    assert.match(doc.error ?? "", /changed/, JSON.stringify(doc));
    assert.deepEqual(await fs.readdir(path.join(app, DIR)).catch(() => []), [], "no file, no .part");
    assert.deepEqual(calls.map((c) => c.args[1] === LIST_SCRIPT || c.cmd === "rm"), [false, false], "no list, no rm");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("over 20 MB: a hint with Load, nothing is copied; exactly 20 MB opens", async () => {
  const key = cacheKey({ on: null, path: "/Users/m/big.png", size: MAX_IMAGE + 1, mtime: 1 });
  const f = fake(() => ({ code: 0, stdout: probeOut(MAX_IMAGE + 1, 1, PNG(300, 200)), stderr: "" }));
  assert.deepEqual(await f.make().load({ on: null, path: "/Users/m/big.png" }), { error: "File is larger than 20 MB", load: true, final: true, key, name: `${key}.png` });
  assert.deepEqual(f.kinds(), ["probe"]);
  const g = fake(() => ({ code: 0, stdout: probeOut(MAX_IMAGE, 1, PNG(300, 200)), stderr: "" }));
  assert.equal((await g.make().load({ on: null, path: "/Users/m/big.png" })).kind, "image", "exactly at the limit: no button");
});

test("local over 20 MB: no copy through exec even with force (the Load job does it); a copy in loads/<key>/ is shown without force", async () => {
  const key = cacheKey({ on: null, path: "/Users/m/pics/big one.jpg", size: MAX_IMAGE + 1, mtime: 1 }), loaded = `${APP}/${loadDir(key)}/${key}.jpeg`;
  const f = fake((c) => c.args[1] === PROBE_SCRIPT ? { code: 0, stdout: probeOut(MAX_IMAGE + 1, 1, JPEG), stderr: "" } : { code: 0, stdout: "", stderr: "" });
  const hint = await f.make().load({ on: null, path: "/Users/m/pics/big one.jpg", force: true });
  assert.deepEqual(hint, { error: "File is larger than 20 MB", load: true, final: true, key, name: `${key}.jpeg` });
  assert.deepEqual(f.kinds(), ["probe"], "no cp: the transfer job copies");
  f.present.add(loaded); f.calls.length = 0;
  assert.deepEqual(await f.make().load({ on: null, path: "/Users/m/pics/big one.jpg" }), { kind: "image", path: `${loadDir(key)}/${key}.jpeg`, width: 640, height: 480 }, "present: shown without force");
  assert.deepEqual(f.kinds(), ["probe"]);
});

test("remote over 20 MB: Load never fetches through ssh (the job does), 100 megapixels have no Load even with force", async () => {
  const f = fake(() => ({ code: 0, stdout: probeOut(MAX_IMAGE + 1, 1, PNG(300, 200)), stderr: "" }));
  const r = await f.make().load({ on: "box", path: "/home/u/big.png", force: true });
  assert.deepEqual([r.load, r.final, r.error, r.name], [true, true, "File is larger than 20 MB", `${r.key}.png`]);
  assert.deepEqual(f.kinds(), ["probe"], "no hc, no ssh");
  const g = fake(() => ({ code: 0, stdout: probeOut(1000, 1, PNG(20000, 10000)), stderr: "" }));
  assert.deepEqual(await g.make().load({ on: null, path: "/Users/m/huge.png", force: true }), { error: "Image has more than 100 megapixels · no preview", final: true });
  const h = fake(() => ({ code: 0, stdout: probeOut(MAX_IMAGE + 1, 1, PNG(20000, 10000)), stderr: "" }));
  assert.equal((await h.make().load({ on: null, path: "/Users/m/huge.png" })).load, undefined, "megapixels are checked before the size hint");
});

test("an SVG over 20 MB is a final hint without Load", async () => {
  const f = fake(() => ({ code: 0, stdout: probeOut(MAX_IMAGE + 1, 1, ascii('<svg viewBox="0 0 1 1">')), stderr: "" }));
  assert.deepEqual(await f.make().load({ on: null, path: "/Users/m/big.svg", force: true }), { error: "File is larger than 20 MB · no preview", final: true });
  assert.deepEqual(f.kinds(), ["probe"]);
});

test("stalePlan names other 64-hex folders only, keeps the given keys; clearLoads keeps only running preview jobs", async () => {
  const a = "a".repeat(64), b = "b".repeat(64), c = "c".repeat(64);
  assert.deepEqual(stalePlan(`${a}\n${b}\n${c}\nnotes.txt\n${"d".repeat(63)}\n..\n`, [a]), [b, c]);
  assert.deepEqual(stalePlan("", [a]), []);
  const jobs = { j1: { preview: true, state: "running", destDir: `${APP}/${LOADS}/${b}` }, j2: { preview: true, state: "done", destDir: `${APP}/${LOADS}/${c}` }, j3: { state: "running", destDir: "/Users/m/Downloads" } };
  const f = fake((call) => call.args?.[1] === LOADS_LIST_SCRIPT ? { code: 0, stdout: `${a}\n${b}\n${c}\n`, stderr: "" } : { code: 0, stdout: "", stderr: "" });
  await clearLoads({ exec: f.exec, appHome: () => APP, jobs });
  assert.deepEqual(f.kinds(), ["loads", "rmrf"]);
  assert.deepEqual(f.calls[1].args, ["-rf", "--", `${APP}/${LOADS}/${a}`, `${APP}/${LOADS}/${c}`], "b has a running preview job; a and c go (the next load starts clean)");
  const g = fake(() => ({ code: 0, stdout: "", stderr: "" }));
  await clearLoads({ exec: g.exec, appHome: () => APP, jobs: null });
  assert.deepEqual(g.kinds(), ["loads"], "nothing stale: no rm");
});

test("previewJob joins the running preview job of a loads folder; loadOutcome maps the end state", () => {
  const dir = `${APP}/${LOADS}/${"a".repeat(64)}`;
  const jobs = { j1: { id: "j1", preview: true, state: "done", destDir: dir }, j2: { id: "j2", preview: true, state: "running", destDir: dir }, j3: { id: "j3", state: "running", destDir: dir }, j4: { id: "j4", preview: true, state: "running", destDir: `${dir}x` } };
  assert.equal(previewJob(jobs, dir)?.id, "j2", "running, preview, same folder");
  assert.equal(previewJob({ j1: jobs.j1, j3: jobs.j3 }, dir), null, "done or not a preview job: no join");
  assert.equal(previewJob(null, dir), null);
  assert.deepEqual(loadOutcome({ state: "done" }), { show: true });
  assert.deepEqual(loadOutcome(undefined), { show: true }, "cleared by clearFinished: load() decides");
  assert.deepEqual(loadOutcome({ state: "cancelled" }), { error: "Load cancelled" });
  assert.deepEqual(loadOutcome({ state: "failed", error: "boom" }), { error: "boom" });
  assert.deepEqual(loadOutcome({ state: "failed", error: null }), { error: "Load failed" });
});

test("remote: a cache hit downloads nothing, a miss runs ssh once and evicts the oldest", async () => {
  const name = `${cacheKey({ on: "box", path: "/home/u/pic.png", size: 29, mtime: 1700000000 })}.png`, file = `${APP}/${DIR}/${name}`;
  const f = fake((c) => {
    if (c.args[1] === PROBE_SCRIPT) return { code: 0, stdout: probeOut(29, 1700000000, PNG(300, 200)), stderr: "" };
    if (c.args[1] === LIST_SCRIPT) return { code: 0, stdout: `total 8\n-rw-r--r--  1 501  20  29 Nov  4 15:00 ${name}\n-rw-r--r--  1 501  20  52000000 Nov  4 14:00 aaaa.png\n-rw-r--r--  1 501  20  2000000 Nov  4 13:00 bbbb.jpeg\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const doc = await f.make().load({ on: "box", path: "/home/u/pic.png" });
  assert.deepEqual(doc, { kind: "image", path: `${DIR}/${name}`, width: 300, height: 200 });
  assert.deepEqual(f.kinds(), ["probe", "hc", "scp", "list", "rm"]);
  assert.equal(f.calls[0].options.on, "box", "the probe runs on the machine");
  assert.deepEqual(f.calls[2].args.slice(2), ["x", "/home/u/pic.png", `${file}.r1.part`, file, "29", "u@box"]);
  assert.equal(f.calls[2].options.on, null, "ssh runs on this computer");
  assert.deepEqual(f.calls[4].args, ["-f", "--", `${APP}/${DIR}/bbbb.jpeg`]);
  assert.ok(CACHE_LIMIT > 29 + 52000000 && CACHE_LIMIT < 29 + 52000000 + 2000000, "the listing straddles the limit");
  f.present.add(file); f.calls.length = 0;
  assert.deepEqual(await f.make().load({ on: "box", path: "/home/u/pic.png" }), doc);
  assert.deepEqual(f.kinds(), ["probe"], "a hit: no hc, no ssh, no list");
});

test("a timed-out ssh from a machine becomes a Load hint and its part file is removed", async () => {
  const key = cacheKey({ on: "box", path: "/home/u/pic.png", size: 29, mtime: 1 }), file = `${APP}/${DIR}/${key}.png`;
  const f = fake((c) => {
    if (c.args[1] === PROBE_SCRIPT) return { code: 0, stdout: probeOut(29, 1, PNG(300, 200)), stderr: "" };
    throw new Error("command timed out after 30s");
  });
  const doc = await f.make().load({ on: "box", path: "/home/u/pic.png" });
  assert.deepEqual(doc, { error: "Download timed out (30 s limit)", load: true, final: true, key, name: `${key}.png` });
  assert.deepEqual(f.unlinks, [`${file}.r1.part`]);
  assert.deepEqual(f.kinds(), ["probe", "hc", "scp"]);
});

test("a timed-out local cp becomes a Load hint that says Copy, not Download", async () => {
  const key = cacheKey({ on: null, path: "/Users/m/pic.png", size: 29, mtime: 1 });
  const f = fake((c) => {
    if (c.args[1] === PROBE_SCRIPT) return { code: 0, stdout: probeOut(29, 1, PNG(300, 200)), stderr: "" };
    throw new Error("command timed out after 30s");
  });
  const doc = await f.make().load({ on: null, path: "/Users/m/pic.png" });
  assert.deepEqual(doc, { error: "Copy timed out (30 s limit)", load: true, final: true, key, name: `${key}.png` });
  assert.deepEqual(f.unlinks, [`${APP}/${DIR}/${key}.png.r1.part`]);
});

test("resolveFile: a relative link, a chain and a link in the directory path resolve to the real file; a plain path stays; a loop and a failing exec fall back to the path", async () => {
  const dir = await mkTmp("images-link-");
  try {
    await fs.mkdir(path.join(dir, "real dir"));
    await fs.mkdir(path.join(dir, "sub"));
    await fs.writeFile(path.join(dir, "real dir", "pic.png"), "x");
    await fs.symlink("../real dir/pic.png", path.join(dir, "sub", "rel.png"));
    await fs.symlink("sub/rel.png", path.join(dir, "chain.png"));
    await fs.symlink("sub", path.join(dir, "subln"));
    const real = await fs.realpath(path.join(dir, "real dir", "pic.png"));
    assert.equal(await resolveFile({ exec: realExec, path: path.join(dir, "sub", "rel.png") }), real);
    assert.equal(await resolveFile({ exec: realExec, path: path.join(dir, "chain.png") }), real);
    assert.equal(await resolveFile({ exec: realExec, path: path.join(dir, "subln", "rel.png") }), real);
    assert.equal(await resolveFile({ exec: realExec, path: path.join(dir, "real dir", "pic.png") }), real);
    await fs.symlink("loop2", path.join(dir, "loop1")); await fs.symlink("loop1", path.join(dir, "loop2"));
    assert.equal(await resolveFile({ exec: realExec, path: path.join(dir, "loop1") }), path.join(dir, "loop1"), "a loop falls back to the path");
    assert.equal(await resolveFile({ exec: async () => { throw new Error("x"); }, path: "/a/b.png" }), "/a/b.png");
    // A broken link is not an error: the script resolves to the missing target (the probe reports "no longer available" before, or cp fails cleanly).
    await fs.symlink("../real dir/nowhere.png", path.join(dir, "sub", "broken.png"));
    assert.equal(await resolveFile({ exec: realExec, path: path.join(dir, "sub", "broken.png") }), path.join(await fs.realpath(path.join(dir, "real dir")), "nowhere.png"), "a broken link resolves to its missing target");
    await fs.symlink("../gone dir/x.png", path.join(dir, "sub", "nodir.png"));
    assert.equal(await resolveFile({ exec: realExec, path: path.join(dir, "sub", "nodir.png") }), path.join(dir, "sub", "nodir.png"), "a link into a missing directory falls back to the path");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("a copy in loads/<key>/ under the limit is used without hc or ssh", async () => {
  const key = cacheKey({ on: "box", path: "/home/u/pic.png", size: 29, mtime: 1 }), rel = `${loadDir(key)}/${key}.png`;
  const f = fake((c) => ({ code: 0, stdout: probeOut(29, 1, PNG(300, 200)), stderr: "" }));
  f.present.add(`${APP}/${rel}`);
  assert.deepEqual(await f.make().load({ on: "box", path: "/home/u/pic.png" }), { kind: "image", path: rel, width: 300, height: 200 });
  assert.deepEqual(f.kinds(), ["probe"]);
});

test("badSpelling paths are refused before any exec", async () => {
  const f = fake(() => { throw new Error("must not run"); });
  for (const p of ["/home/u/../x.png", "/home/u//x.png", "/home/u/./x.png"])
    assert.deepEqual(await f.make().load({ on: "box", path: p }), { error: 'Path must not contain ".", ".." or "//"' }, p);
  assert.deepEqual(f.calls, []);
});

test("dimensions finds the JPEG SOF behind a large EXIF block", () => {
  const exif = new Uint8Array(5000), sof = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0, 0, 0, 0];
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, ...[(5002 >> 8) & 255, 5002 & 255], ...exif.slice(0, 5000), ...sof]);
  assert.ok(bytes.length > 4096);
  assert.equal(sniff(bytes, "jpg"), "jpeg");
  assert.deepEqual(dimensions(bytes), { width: 640, height: 480 });
});

test("more than 100 megapixels: a hint, nothing is copied", async () => {
  const f = fake(() => ({ code: 0, stdout: probeOut(1000, 1, PNG(20000, 10000)), stderr: "" }));
  assert.deepEqual(await f.make().load({ on: null, path: "/Users/m/huge.png" }), { error: "Image has more than 100 megapixels · no preview", final: true });
  assert.deepEqual(f.kinds(), ["probe"]);
});

// A fake ssh on PATH: ignores its options and the host, runs the script from stdin locally (like "sh -s" remotely)
// and copies what the script prints to $SEEN, so the test sees every byte that crossed the "wire".
async function withFakeSsh(fn) {
  const dir = await mkTmp("filer-pro-ssh-"), oldPath = process.env.PATH;
  try {
    await fs.writeFile(path.join(dir, "ssh"), '#!/bin/sh\nshift $(( $# - 1 ))\ncase "$1" in "sh -s") ;; *) exit 9 ;; esac\nsh -s | tee "$SEEN"\n', { mode: 0o755 });
    process.env.PATH = `${dir}:${oldPath}`; process.env.SEEN = path.join(dir, "seen");
    return await fn(dir);
  } finally { process.env.PATH = oldPath; delete process.env.SEEN; await fs.rm(dir, { recursive: true, force: true }); }
}
test("remote fetch: a file that grows is cut at size + 1 bytes on the wire, binary-safe, odd names", async () => {
  await withFakeSsh(async (dir) => {
    const odd = path.join(dir, "it's [1] $x `y`\n.png"), data = Buffer.from(Array.from({ length: 300 }, (_, i) => i % 256));
    await fs.writeFile(odd, data);
    const out = path.join(dir, "out.part"), file = path.join(dir, "cache", "out.png");
    // the probe saw 100 bytes, the file now has 300
    const grown = await realExec("sh", ["-c", FETCH_SSH, "x", odd, out, file, "100", "u@box"]);
    assert.equal(grown.code, 1, grown.stderr); assert.match(grown.stderr, /file changed/);
    assert.equal((await fs.readFile(path.join(dir, "seen"))).length, 101, "never more than size + 1 bytes were sent");
    assert.equal((await fs.stat(out)).size, 101, "the part file holds size + 1 bytes at most");
    // unchanged: exact bytes, moved into place
    const ok = await realExec("sh", ["-c", FETCH_SSH, "x", odd, out, file, "300", "u@box"]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual(await fs.readFile(file), data);
    await assert.rejects(fs.access(out), "the part file is gone after the move");
  });
});
test("remote fetch failure: load removes the part file", async () => {
  await withFakeSsh(async (dir) => {
    const app = path.join(dir, "app"), unlinked = [];
    const exec = (cmd, args, options) => options.on === "box" ? realExec(cmd, args) : realExec(cmd, args);
    const hc = async () => ({ code: 0, stdout: JSON.stringify({ machines: [{ name: "box", target: "u@box" }] }), stderr: "" });
    const pic = path.join(dir, "pic.png");
    await fs.writeFile(pic, PNG(300, 200));
    const images = createImages({ exec, hc, exists: () => Promise.resolve(false), unlink: async (p) => { unlinked.push(p); await fs.rm(p, { force: true }); }, appHome: () => app });
    const doc = await images.load({ on: "box", path: pic });
    assert.equal(doc.error, undefined, JSON.stringify(doc));
    assert.deepEqual((await fs.readdir(path.join(app, DIR))).filter((n) => n.includes(".part")), []);
  });
});

test("all four scripts parse under sh -n", async () => {
  for (const [name, script] of Object.entries({ PROBE_SCRIPT, FETCH_LOCAL, FETCH_SSH, LIST_SCRIPT })) {
    const r = await realExec("sh", ["-n", "-c", script]);
    assert.equal(r.code, 0, `${name}: ${r.stderr}`);
  }
});

test("main.js: images are decided before the text is read (source guard)", async () => {
  const main = await fs.readFile(new URL("../mods/filer-pro/main.js", import.meta.url), "utf8");
  const show = main.indexOf("  show(path, cx, opts = {}) {"), view = main.indexOf("  viewer(t) {");
  assert.ok(show > 0 && view > show, "show() and viewer() found");
  const branch = main.indexOf('kind === "image"', show), text = main.indexOf("readTextFile(joinPath(root, path)", show);
  assert.ok(branch > 0 && branch < text, "the image branch comes before the text read");
  const gate = main.indexOf('extOf(path) !== "svg"', show);
  assert.ok(gate > branch && gate < text, "an SVG error without final falls through to the text read");
  assert.match(main.slice(show, text), /doc\.final/, "final errors are shown even for SVG");
  const pic = main.indexOf('this.doc.kind === "image"', view), code = main.indexOf("if (!this.code)", view);
  assert.ok(pic > 0 && pic < code, "the image view comes before the editor's loading text");
  assert.ok(main.includes('"Loading image…"'), "the loading text for images");
  const check = main.indexOf("  checkShow(cx) {"), mode = main.indexOf("modeResult(", check);
  const guard = main.indexOf("Images have no source view", check);
  assert.ok(guard > check && guard < mode, "a mode request on an image is answered before modeResult");
  const index = await fs.readFile(new URL("../mods/filer-pro/preview/index.js", import.meta.url), "utf8");
  assert.match(index, /export \{ createImages \} from "\.\/images\.js"/);
  assert.match(index, /if \(doc\.kind === "image"\) return \[\];/, "no Source button for an image");
});

test("sniff and dimensions need no TextDecoder", () => {
  const saved = globalThis.TextDecoder;
  globalThis.TextDecoder = undefined;
  try {
    const svg = Uint8Array.from([0xef, 0xbb, 0xbf, ...ascii('<svg width="10" height="20"></svg>')]);
    assert.equal(sniff(svg, "svg"), "svg");
    assert.deepEqual(dimensions(svg), { width: 10, height: 20 });
  } finally { globalThis.TextDecoder = saved; }
});
