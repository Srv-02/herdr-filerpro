// PDFs in the file view: detection by header, one PNG per page rastered by macOS PDFKit in an osascript process
// (JXA), stored in the image cache of images.js. Pure: Herdr comes in as dependencies (see images.js).
// The PDF is parsed by the system's PDFKit inside osascript: path, page and target travel only as arguments.
import { extOf } from "../lib/langs.js";
import { badSpelling } from "../lib/fileops.js";
import { cacheKey, dimensions, createCache, timeoutHint, loadDir, DIR, PROBE_SCRIPT } from "./images.js";

export const MAX_PDF_LOCAL = 100 * 1024 * 1024, MAX_PDF_REMOTE = 20 * 1024 * 1024;

// The header may sit behind up to 1024 bytes of junk (PDF 1.7, Appendix H).
export const isPdf = (bytes) => String.fromCharCode(...bytes.subarray(0, 1029)).includes("%PDF-");
export const pageName = (key, n) => `${key}p${n}.png`;

// `osascript -l JavaScript -e RENDER_SCRIPT <pdf> <page> <png>`: one page as PNG, longest edge at most 2048 px,
// scale at most 2, drawn on white (transparent pages, dark theme). boundsForBox ignores /Rotate, so a page turned by
// 90 or 270 degrees swaps width and height. Prints one JSON line.
export const RENDER_SCRIPT = `ObjC.import("PDFKit"); ObjC.import("AppKit");
function run(argv) {
  const [src, pageArg, out] = argv;
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(src));
  if (doc.isNil()) return JSON.stringify({ error: "broken" });
  if (doc.isLocked) return JSON.stringify({ error: "locked" });
  const pages = Number(doc.pageCount);
  if (pages < 1) return JSON.stringify({ error: "empty" });
  const n = Math.min(Math.max(1, +pageArg || 1), pages), page = doc.pageAtIndex(n - 1);
  const box = page.boundsForBox($.kPDFDisplayBoxCropBox), turned = Number(page.rotation) % 180 !== 0;
  const w = turned ? box.size.height : box.size.width, h = turned ? box.size.width : box.size.height;
  const scale = Math.min(2, 2048 / Math.max(w, h)), pw = Math.max(1, Math.round(w * scale)), ph = Math.max(1, Math.round(h * scale));
  const img = page.thumbnailOfSizeForBox($.NSMakeSize(pw, ph), $.kPDFDisplayBoxCropBox);
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, pw, ph, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
  $.NSColor.whiteColor.setFill;
  $.NSRectFill($.NSMakeRect(0, 0, pw, ph));
  img.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, pw, ph), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1);
  $.NSGraphicsContext.restoreGraphicsState;
  const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
  if (png.isNil() || !png.writeToFileAtomically(out, true)) return JSON.stringify({ error: "write" });
  return JSON.stringify({ pages, page: n, width: pw, height: ph, scale });
}`;

const ERRORS = { locked: "PDF is password-protected", empty: "PDF has no pages", broken: "Cannot read this PDF", write: "Cannot write the page image" };
const oneLine = (text) => String(text ?? "").split("\n").map((l) => l.trim()).find(Boolean);

// { pages, page, width, height } or { error, final }: the first line that starts with "{" counts (CoreGraphics may log before it).
export function parseRender(stdout, stderr = "") {
  const line = String(stdout ?? "").split("\n").map((l) => l.trim()).find((l) => l.startsWith("{"));
  let r = null;
  try { r = line ? JSON.parse(line) : null; } catch { r = null; }
  if (r?.error && ERRORS[r.error]) return { error: `${ERRORS[r.error]} · no preview`, final: true };
  if (r && r.pages >= 1 && r.page >= 1 && r.width >= 1 && r.height >= 1) return { pages: r.pages, page: r.page, width: r.width, height: r.height };
  const detail = oneLine(stderr) ?? (r ? null : oneLine(stdout)) ?? "unknown error"; // a JSON line without a page is no detail worth showing
  return { error: `Cannot load this PDF: ${detail}`, final: true };
}

const timedOut = (e) => /time[d ]*-?\s*out/i.test(String(e?.message ?? e));

export function createPdfs({ exec, hc, exists, unlink, mkdir, readFile, appHome, platform, rand }) {
  const cache = createCache({ exec, hc, unlink, rand, what: "PDF" });
  // { kind: "pdf", path, page, pages, width, height } (path relative to appHome, width and height in points: PNG pixels / 2)
  // or { error, final, load?, key? }. `pages` from an earlier result lets a cached page skip osascript.
  async function load({ on, path, page = 1, pages = null, force = false }) {
    if (badSpelling(path)) return { error: 'Path must not contain ".", ".." or "//"' };
    if (platform !== "macos") return { error: "PDF preview needs macOS", final: true };
    const cannot = (e) => ({ error: `Cannot load this PDF: ${oneLine(e?.message ?? e) ?? "unknown error"}`, final: true });
    let probe;
    try { probe = await exec("sh", ["-c", PROBE_SCRIPT, "x", path], { on }); } catch (e) { return cannot(e); }
    if (probe.code !== 0) return cannot(probe.stderr || `exit code ${probe.code}`);
    const [first, ...rest] = probe.stdout.split("\n"), [size, mtime] = first.trim().split(" ").map(Number);
    if (!(size >= 0)) return { error: "This file is no longer available", final: true };
    const bytes = Uint8Array.from(rest.join(" ").match(/\b[0-9a-f]{2}\b/g) ?? [], (h) => parseInt(h, 16));
    if (!isPdf(bytes)) return { error: `File header is not ${extOf(path).toUpperCase()} · no preview`, final: true };
    const limit = on ? MAX_PDF_REMOTE : MAX_PDF_LOCAL, key = cacheKey({ on, path, size, mtime }), dir = `${appHome()}/${DIR}`;
    // The source to raster: the file itself, the fetched copy in the cache, or the transfer job's copy in loads/<key>/.
    let src = path, fetched = null;
    const loaded = `${appHome()}/${loadDir(key)}/${key}.pdf`; // the transfer job writes this name (jobs.start `as`)
    if (on && (await exists(loaded))) src = loaded; // at any size: e.g. after a timed-out download
    else if (size > limit) {
      if (on || !force) return { error: `File is larger than ${limit / 1024 / 1024} MB`, load: true, final: true, key, name: `${key}.pdf` };
    } else if (on) {
      src = `${dir}/${key}.pdf`;
      fetched = `${key}.pdf`; // always in the keep list while it is the source, not only when fetched now (review W2)
    }
    const name = pageName(key, page), png = `${dir}/${name}`, rel = `${DIR}/${name}`;
    if (pages && (await exists(png))) {
      let dims = null;
      try { dims = dimensions(await readFile(png)); } catch { dims = null; }
      if (dims) return { kind: "pdf", path: rel, page, pages, width: Math.round(dims.width / 2), height: Math.round(dims.height / 2) };
    }
    if (fetched && !(await exists(src))) {
      const r = await cache.fetch({ on, path, size, file: src });
      if (r) return { ...timeoutHint(r, on, key, `${key}.pdf`), final: true };
    }
    try { await mkdir(dir, { recursive: true }); } catch {}
    let r;
    try { r = await exec("osascript", ["-l", "JavaScript", "-e", RENDER_SCRIPT, src, String(page), png], { on: null }); }
    catch (e) { return timedOut(e) ? { error: "Rendering timed out (30 s limit) · no preview", final: true } : cannot(e); }
    const out = parseRender(r.stdout, r.code === 0 ? "" : r.stderr);
    if (out.error) return out;
    await cache.evict(dir, [name, ...(fetched ? [fetched] : [])]); // the PNG sits under the requested page's name, also when PDFKit clamped the page
    return { kind: "pdf", path: rel, page: out.page, pages: out.pages, width: Math.round(out.width / 2), height: Math.round(out.height / 2) };
  }
  return { load };
}
