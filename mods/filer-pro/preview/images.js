// Images in the file view: detection by extension and header, the dimensions from the header, the cache under
// data/filer-pro/images/ with its size limit (image_cache_mb, default 50 MB), and the copy into it (cp, or ssh from a machine), all through exec.
// Pure: Herdr comes in as dependencies, so it runs under Node tests (see diagrams.js). dimensions() follows the
// Issues mod's pictures.js, which ships with herdr-app.
import { createHash } from "crypto";
import { extOf } from "../lib/langs.js";
import { badSpelling } from "../lib/fileops.js";
import { sshTarget } from "../lib/machines.js";
import { baseName } from "../lib/names.js";

export const MAX_IMAGE = 20 * 1024 * 1024, CACHE_LIMIT = 50 * 1024 * 1024, DIR = "data/filer-pro/images";
// Files over a size limit that the user lifted with Load: one folder per cache key, outside the image cache.
export const LOADS = "data/filer-pro/loads";
// A byte limit in MB for texts: "20", or "0.5" for a limit that is no whole number of MB.
export const mb = (bytes) => String(Math.round((bytes / 1024 / 1024) * 10) / 10);
export const loadDir = (key) => `${LOADS}/${key}`;

// `x <path>`: -1 when the path does not exist (a dangling link too), else "<size> <mtime>" of the file behind a
// link (stat -L, GNU or BSD as in sizes.js) and the first 64 KiB as hex (a JPEG's SOF can sit behind a big EXIF
// block). head -c is GNU, BSD and busybox.
export const PROBE_SCRIPT = [
  'p=$1',
  'if [ ! -e "$p" ]; then echo -1; exit 0; fi',
  'if stat -c%s / >/dev/null 2>&1; then stat -L -c "%s %Y" "$p"; else stat -L -f "%z %m" "$p"; fi',
  'head -c 65536 "$p" | od -An -v -tx1',
].join("\n");
// `x <src> <part> <file> <size> [<target>]`: copies into the part file, then moves it into place (one atomic
// rename, so two mod copies fetching the same image never leave half a file) only if it has the size the probe
// saw; a file that changed in between never enters the cache. head -c stops one byte past that size, locally and
// on the machine, so a file that grows during the transfer never puts more than size + 1 bytes into the part
// file (and a part file is never counted by the cache listing). Remote: one ssh call with the script on stdin
// (as transfer.sh does: only the constant "sh -s" meets the login shell, the path is quoted into the script)
// and the bytes on stdout, redirected into the part file by this local shell: binary-safe, no 8 MiB text limit
// of exec, and exec's 30 s limit applies. The cache's mtime order is "last written".
const CHECKED = '{ [ "$(wc -c < "$2")" -eq "$4" ] && mv -f -- "$2" "$3" || { echo "file changed while loading" >&2; exit 1; }; }';
export const FETCH_LOCAL = `mkdir -p "\${3%/*}" && head -c $(( $4 + 1 )) < "$1" > "$2" && ${CHECKED}`;
const QUOTE = String.raw`sed "s/'/'\\\\''/g"`; // ' becomes '\'' (the trailing "." keeps a final newline through $(...))
export const FETCH_SSH = `mkdir -p "\${3%/*}" && q=$(printf '%s.' "$1" | ${QUOTE}) && ` +
  `printf "set -- '%s'\\n{ head -c %s -- \\"\\$1\\"\\n} </dev/null\\n" "\${q%.}" "$(( $4 + 1 ))" | ` +
  `ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -- "$5" "sh -s" > "$2" && ${CHECKED}`;
// `x <dir>`: one `ls -l` line per entry, last written first. A single process, so thousands of files stay fast.
export const LIST_SCRIPT = 'cd -- "$1" 2>/dev/null && ls -lnt';
// `x <dir>`: the names in the loads folder, one per line.
export const LOADS_LIST_SCRIPT = 'cd -- "$1" 2>/dev/null && ls -1';

const oneLine = (text) => String(text ?? "").split("\n").map((l) => l.trim()).find(Boolean);
const timedOut = (e) => /time[d ]*-?\s*out/i.test(String(e?.message ?? e));
const MAGIC = { png: [0x89, 0x50, 0x4e, 0x47], jpeg: [0xff, 0xd8, 0xff], gif: [0x47, 0x49, 0x46, 0x38] };
const at = (b, i, s) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
const u16 = (b, i) => b[i] | (b[i + 1] << 8), u24 = (b, i) => u16(b, i) | (b[i + 2] << 16);
const b16 = (b, i) => (b[i] << 8) | b[i + 1], b32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const i32 = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
const format = (b) => Object.keys(MAGIC).find((k) => MAGIC[k].every((v, i) => b[i] === v)) ?? (at(b, 0, "RIFF") && at(b, 8, "WEBP") ? "webp" : b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && u16(b, 4) > 0 ? "ico" : null);

// The first 4 KiB as text, one char per byte (the runtime documents no TextDecoder), without a UTF-8 BOM.
const head = (b) => String.fromCharCode(...b.subarray(0, 4096)).replace(/^\xef\xbb\xbf/, "");

// All given bytes as lower-case text, one char per byte, in chunks (a spread of 64 K arguments is no sure thing).
function lower(b) {
  let s = "";
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s.toLowerCase();
}

// Where the attributes of the root element start (just behind "<svg") when the text is, after whitespace, XML
// prolog, comments and DOCTYPE, an <svg> element; else -1. One pass, no regex backtracking: a hostile header must
// not freeze the UI.
function svgStart(s) {
  for (let i = 0; ;) {
    while (/\s/.test(s[i] ?? "")) i++;
    const low = s.slice(i, i + 9).toLowerCase(), end = low.startsWith("<?") ? "?>" : low.startsWith("<!--") ? "-->" : low === "<!doctype" ? ">" : null;
    if (!end) return low.startsWith("<svg") && !/\w/.test(low[4] ?? "") ? i + 4 : -1;
    const j = s.indexOf(end, i + 2);
    if (j < 0) return -1;
    i = j + end.length;
  }
}

// The format when the header matches the extension (jpg counts as jpeg), else null.
const isSvg = (s) => svgStart(s) >= 0;

// The attributes of the root <svg> as a Map name -> value, read in one anchored, quote-aware pass from `i`.
// null (fail closed) for a duplicate name or anything that is not a well-formed attribute list.
function svgAttrs(s, i) {
  const re = /\s*(?:([^\s=>/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?|(\/?>))/y, map = new Map();
  for (re.lastIndex = i; ;) {
    const m = re.exec(s);
    if (!m || m[0] === "") return null;
    if (m[5]) return map;
    if (map.has(m[1])) return null;
    map.set(m[1], m[2] ?? m[3] ?? m[4] ?? "");
  }
}

// CSS text (a <style> body or a style attribute) that sets no size and pulls in nothing. Comments are dropped first
// (`width/**/:` is still width), CDATA markers too. Any `&` (a character reference could spell `width`), `@import`,
// `url(` or backslash (CSS escape) fails; so does a size property name (not `stroke-width`, `line-height`: no
// letter, digit, `_` or `-` before the name) followed by `:`.
const SIZE_PROP = /(?:^|[^\w-])(?:(?:min-|max-)?(?:width|height|inline-size|block-size)|zoom)\s*:/;
function cssOk(css) {
  css = css.toLowerCase();
  let t = "";
  for (let i = 0; ;) {
    const j = css.indexOf("/*", i);
    if (j < 0) { t += css.slice(i); break; }
    t += css.slice(i, j);
    const k = css.indexOf("*/", j + 2);
    if (k < 0) break;
    i = k + 2;
  }
  t = t.replace(/<!\[cdata\[|\]\]>/g, "");
  return !/[&\\]|@import|url\(/.test(t) && !SIZE_PROP.test(t);
}

// Whether the (lower-cased) SVG text is safe to draw as an image: see dimensions().
function svgSafe(low, attrs) {
  if (low.includes("<?xml-stylesheet") || low.includes("<!entity") || low.includes("<foreignobject") || low.includes(":foreignobject")
    || low.includes("http://www.w3.org/1999/xhtml")) return false;
  for (let i = low.indexOf("<!doctype"); i >= 0; i = low.indexOf("<!doctype", i + 9)) {
    const m = /[>[]/.exec(low.slice(i + 9));
    if (m && m[0] === "[") return false;
  }
  if (attrs.has("style") && !cssOk(attrs.get("style"))) return false;
  const open = /<(?:[a-z_][\w.-]*:)?style(?![\w.:-])/g, close = /<\/(?:[a-z_][\w.-]*:)?style\s*>/g;
  for (let m; (m = open.exec(low));) {
    const gt = low.indexOf(">", m.index);
    if (gt < 0) return false;
    if (low[gt - 1] === "/") { open.lastIndex = gt; continue; }
    close.lastIndex = gt;
    const c = close.exec(low), end = c ? c.index : low.length;
    if (!cssOk(low.slice(gt + 1, end))) return false;
    open.lastIndex = c ? c.index + c[0].length : low.length;
  }
  return true;
}

export function sniff(bytes, ext) {
  const f = format(bytes) ?? (isSvg(head(bytes)) ? "svg" : null);
  return f && f === (ext === "jpg" ? "jpeg" : ext) ? f : null;
}

// { width, height } from the header, null when unknown. svgCheck false (setting svg_check) skips svgSafe: an SVG then
// opens even when it could set its own size through CSS or load more than itself; its size still comes from the root.
export function dimensions(bytes, { svgCheck = true } = {}) {
  const f = format(bytes);
  let w = 0, h = 0;
  if (f === "ico") {
    // The directory: 16 bytes per entry from offset 6, byte 0 the width and byte 1 the height (0 means 256), the data
    // offset (u32 LE) at +12. An entry may hold a PNG or a BMP whose header says more than the directory, so that size counts
    // too; the largest entry wins. A payload we cannot see (behind the probe) could be such a PNG: unknown.
    const n = u16(bytes, 4);
    if (6 + 16 * n > bytes.length) return null;
    for (let i = 0; i < n; i++) {
      const e = 6 + 16 * i, off = bytes[e + 12] + bytes[e + 13] * 256 + bytes[e + 14] * 65536 + bytes[e + 15] * 16777216;
      let [ew, eh] = [bytes[e] || 256, bytes[e + 1] || 256];
      if (off + 16 > bytes.length) return null;
      if (MAGIC.png.every((v, k) => bytes[off + k] === v) && at(bytes, off + 4, "\x0d\x0a\x1a\x0a")) {
        // A PNG payload: the IHDR size counts, but only behind a real IHDR chunk type; else the size is unknown.
        if (off + 24 > bytes.length || !at(bytes, off + 12, "IHDR")) return null;
        [ew, eh] = [b32(bytes, off + 16), b32(bytes, off + 20)];
      } else {
        // A BMP payload: the BITMAPINFOHEADER holds biWidth and biHeight (twice the image height: XOR and AND mask)
        // and the decoder may use them instead of the directory, so the larger value counts.
        const bw = i32(bytes, off + 4), bh = Math.abs(i32(bytes, off + 8)) / 2;
        if (bw <= 0) return null;
        [ew, eh] = [Math.max(ew, bw), Math.max(eh, bh)];
      }
      if (ew * eh > w * h) [w, h] = [ew, eh];
    }
  } else if (f === "png") [w, h] = [b32(bytes, 16), b32(bytes, 20)];
  else if (f === "gif") [w, h] = [u16(bytes, 6), u16(bytes, 8)];
  else if (f === "webp") {
    if (at(bytes, 12, "VP8X")) [w, h] = [u24(bytes, 24) + 1, u24(bytes, 27) + 1];
    else if (at(bytes, 12, "VP8L")) { const v = b32(bytes.slice(21, 25).reverse(), 0); [w, h] = [(v & 0x3fff) + 1, ((v >>> 14) & 0x3fff) + 1]; }
    else if (at(bytes, 12, "VP8 ")) [w, h] = [u16(bytes, 26) & 0x3fff, u16(bytes, 28) & 0x3fff];
  } else if (f === "jpeg") {
    for (let i = 2; i + 8 < bytes.length;) {
      const m = bytes[i + 1];
      if (bytes[i] !== 0xff || m === 0xff) i++;
      else if (m === 0x01 || (m >= 0xd0 && m <= 0xd9)) i += 2;
      else if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { [h, w] = [b16(bytes, i + 5), b16(bytes, i + 7)]; break; }
      else i += 2 + b16(bytes, i + 2);
    }
  } else {
    // An SVG opens as an image unless it could set its own size through CSS or load more than itself. The renderer
    // draws the real width and height, and any CSS size property (width, min-width, inline-size, zoom, ...) on the
    // root would win over the attributes, so a <style> element or a style attribute on the root is fine only if its
    // text sets no such property (svgStyleOk). Fail closed on everything else: xml-stylesheet, a DOCTYPE with an
    // internal subset or any entity, foreignObject, the XHTML namespace. The scan covers every byte we have (the
    // 64 KiB of the probe); load() sends an SVG larger than that to the text view, since a <style> could sit behind it.
    // A plain number (or px) is a size; a percentage or a missing value takes its size from the viewBox; any other
    // unit (mm, em, 1e5, ...) is no size, never a fall back to a small viewBox. Only the root's own attributes count.
    const text = head(bytes), at0 = svgStart(text), attrs = at0 >= 0 ? svgAttrs(text, at0) : null;
    if (!attrs || (svgCheck && !svgSafe(lower(bytes), attrs))) return null;
    const plain = /^\s*(\d+\.?\d*|\.\d+)(?:px)?\s*$/, percent = /^\s*(\d+\.?\d*|\.\d+)%\s*$/, num = "[+-]?(?:\\d+\\.?\\d*|\\.\\d+)";
    const kind = (v) => v === undefined || percent.test(v) ? "box" : plain.test(v) ? "num" : "bad";
    const [aw, ah] = [attrs.get("width"), attrs.get("height")], [kw, kh] = [kind(aw), kind(ah)];
    if (kw === "bad" || kh === "bad") return null;
    if (kw === "num" && kh === "num") [w, h] = [parseFloat(aw), parseFloat(ah)];
    else {
      const m = (attrs.get("viewBox") ?? "").match(new RegExp(`^\\s*${num}[\\s,]+${num}[\\s,]+(${num})[\\s,]+(${num})\\s*$`)), [bw, bh] = m ? [+m[1], +m[2]] : [0, 0];
      if (!(bw > 0 && bh > 0)) return null;
      // One plain size scales the other by the viewBox aspect ratio, as the renderer does.
      if (kw === "num") [w, h] = [parseFloat(aw), parseFloat(aw) * bh / bw];
      else if (kh === "num") [w, h] = [parseFloat(ah) * bw / bh, parseFloat(ah)];
      else [w, h] = [bw, bh];
    }
  }
  return +w > 0 && +h > 0 ? { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) } : null;
}

export function cacheKey({ on, path, size, mtime }) {
  const s = JSON.stringify([on ?? "", path, size, mtime]);
  return createHash("sha256").update(s).digest("hex");
}

// Names to remove: walks `ls -lnt` (newest first), sums the sizes, names every file once the sum passes `limit`.
// Only plain names we wrote qualify (so `rm` never sees anything else); `keep` (a list of names) is counted but never named.
export function evictPlan(stdout, limit, keep) {
  const kept = new Set(keep);
  let sum = 0;
  const out = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^-\S*\s+\d+\s+\d+\s+\d+\s+(\d+)\s.*\s(\S+)$/);
    if (!m || !/^[a-z0-9]+\.[a-z]+$/.test(m[2])) continue;
    sum += +m[1];
    if (sum > limit && !kept.has(m[2])) out.push(m[2]);
  }
  return out;
}

// Load folders to remove: the entries of loads/ that are exactly 64 hex characters (a cache key) and not in `keep`.
export function stalePlan(stdout, keep) {
  const kept = new Set(keep);
  return stdout.split("\n").map((l) => l.trim()).filter((n) => /^[0-9a-f]{64}$/.test(n) && !kept.has(n));
}

// The view after a preview job (main.js): the running preview job that loads into `destDir`, or null.
export const previewJob = (jobs, destDir) => Object.values(jobs ?? {}).find((j) => j.preview && j.state === "running" && j.destDir === destDir) ?? null;
// What the view does once that job is gone: show the file (done, or cleared by clearFinished: load() decides) or the error.
export const loadOutcome = (job) => !job || job.state === "done" ? { show: true } : { error: job.state === "cancelled" ? "Load cancelled" : job.error || "Load failed" };

// Clears loads/ before a new Load, except the folders of running preview jobs. Errors are swallowed: the load goes on.
export async function clearLoads({ exec, appHome, jobs }) {
  const dir = `${appHome()}/${LOADS}`, keep = Object.values(jobs ?? {}).filter((j) => j.preview && j.state === "running").map((j) => baseName(j.destDir));
  try {
    const old = stalePlan((await exec("sh", ["-c", LOADS_LIST_SCRIPT, "x", dir], { on: null })).stdout, keep);
    if (old.length) await exec("rm", ["-rf", "--", ...old.map((n) => `${dir}/${n}`)], { on: null });
  } catch {}
}

// Drawn size: follows the room (minus padding), never above the original, at least 80 wide.
export function fit(width, height, room) {
  const w = Math.min(width, Math.max(80, (room || width + 32) - 32));
  return { w, h: Math.round(w * height / width) };
}

// A timed-out copy (download from a machine, or cp of a slow local source) becomes a Load hint: the transfer job has no 30 s limit.
export function timeoutHint(r, on, key, name) {
  return r.timeout ? { error: r.error, load: true, final: true, key, name } : r;
}

// `x <path>`: the file behind a symbolic link (relative links and chains followed, at most 40 hops), physical directory;
// fails (prints nothing) for a loop, more than 40 hops or a missing target directory; a broken link whose directory exists is not an error and resolves to its missing target. The transfer job copies with cp -P and would put the link itself into loads/.
export const RESOLVE_FILE = 'p=$1; n=0; while [ -L "$p" ]; do [ $n -lt 40 ] || exit 1; t=$(readlink -- "$p") || exit 1; case $t in /*) p=$t;; *) p=${p%/*}/$t;; esac; n=$((n+1)); done; d=${p%/*}; cd -P -- "${d:-/}" || exit 1; printf \'%s/%s\' "${PWD%/}" "${p##*/}"';
// The path a local Load copies from: the real file behind a link; the path itself when it cannot be resolved.
export async function resolveFile({ exec, path }) {
  try {
    const r = await exec("sh", ["-c", RESOLVE_FILE, "x", path], { on: null });
    return r.code === 0 && r.stdout ? r.stdout : path;
  } catch { return path; }
}

// The copy into a file (cp, or ssh from a machine) and the eviction of the image cache; images.js and pdf.js share it.
// `what` names the thing in error texts. fetch() returns null or { error } (`timeout: true` after the 30 s limit; see timeoutHint).
export function createCache({ exec, hc, unlink, rand = () => Math.random().toString(36).slice(2, 8), what = "image" }) {
  const cannot = (e) => ({ error: `Cannot load this ${what}: ${oneLine(e?.message ?? e) ?? "unknown error"}` });
  async function fetch({ on, path, size, file }) {
    const part = `${file}.${rand()}.part`;
    let target = null, script = FETCH_LOCAL;
    if (on) {
      let t;
      try { t = sshTarget((await hc(["machine", "ls", "--json"])).stdout, on); } catch (e) { return cannot(e); }
      if (t.error) return { error: t.error };
      target = t.target; script = FETCH_SSH;
    }
    let r;
    try { r = await exec("sh", ["-c", script, "x", path, part, file, String(size), ...(target ? [target] : [])], { on: null }); }
    catch (e) { await unlink(part).catch(() => {}); return timedOut(e) ? { error: `${on ? "Download" : "Copy"} timed out (30 s limit)`, timeout: true } : cannot(e); }
    if (r.code !== 0) { await unlink(part).catch(() => {}); return cannot(r.stderr || `exit code ${r.code}`); }
    return null;
  }
  async function evict(dir, keep, limit = CACHE_LIMIT) {
    try {
      const old = evictPlan((await exec("sh", ["-c", LIST_SCRIPT, "x", dir], { on: null })).stdout, limit, keep);
      if (old.length) await exec("rm", ["-f", "--", ...old.map((n) => `${dir}/${n}`)], { on: null });
    } catch {}
  }
  return { fetch, evict };
}

export function createImages({ exec, hc, exists, unlink, appHome, rand = () => Math.random().toString(36).slice(2, 8) }) {
  const cache = createCache({ exec, hc, unlink, rand });
  // { kind: "image", path, width, height } (path relative to appHome) or { error }; `final` means: no text fallback.
  // A hint with `load` carries `key` and `name`; Load itself is a transfer job (main.js), then load() finds its copy.
  // maxImage, cacheLimit: bytes from the settings (image_max_mb, image_cache_mb), svgCheck: svg_check; per call, so a
  // changed setting applies to the next file.
  async function load({ on, path, maxImage = MAX_IMAGE, cacheLimit = CACHE_LIMIT, svgCheck = true }) {
    if (badSpelling(path)) return { error: 'Path must not contain ".", ".." or "//"' };
    const ext = extOf(path), cannot = (e) => ({ error: `Cannot load this image: ${oneLine(e?.message ?? e) ?? "unknown error"}` });
    let probe;
    try { probe = await exec("sh", ["-c", PROBE_SCRIPT, "x", path], { on }); } catch (e) { return cannot(e); }
    if (probe.code !== 0) return cannot(probe.stderr || `exit code ${probe.code}`);
    const [first, ...rest] = probe.stdout.split("\n"), [size, mtime] = first.trim().split(" ").map(Number);
    if (!(size >= 0)) return { error: "This file is no longer available", final: true };
    if (ext === "svg" && size > maxImage) return { error: `File is larger than ${mb(maxImage)} MB · no preview`, final: true }; // never drawn, never read as text
    const bytes = Uint8Array.from(rest.join(" ").match(/\b[0-9a-f]{2}\b/g) ?? [], (h) => parseInt(h, 16));
    const kind = sniff(bytes, ext);
    if (!kind) return { error: `File header is not ${ext.toUpperCase()} · no preview` };
    if (kind === "svg" && svgCheck && size > bytes.length) return { error: "SVG is larger than the 64 KiB checked · no preview" };
    const dims = dimensions(bytes, { svgCheck });
    if (!dims) return { error: "Image size unknown · no preview" };
    if (dims.width * dims.height > 100e6) return { error: "Image has more than 100 megapixels · no preview", final: true };
    const key = cacheKey({ on, path, size, mtime });
    const name = `${key}.${kind}`, rel = `${loadDir(key)}/${name}`, loaded = `${appHome()}/${rel}`;
    // A copy in loads/<key>/ wins at any size: the Load click (or the transfer job) put it there, e.g. after a timed-out download.
    if (await exists(loaded)) return { kind: "image", path: rel, ...dims };
    // Over the limit the transfer job (main.js, jobs.start `as`) puts the file under that name, locally and from a machine; load() only reports.
    if (size > maxImage) return { error: `File is larger than ${mb(maxImage)} MB`, load: true, final: true, key, name };
    const dir = `${appHome()}/${DIR}`, file = `${dir}/${name}`;
    if (!(await exists(file))) {
      const r = await cache.fetch({ on, path, size, file });
      if (r) return timeoutHint(r, on, key, name);
      await cache.evict(dir, [name], cacheLimit);
    }
    return { kind: "image", path: `${DIR}/${name}`, ...dims };
  }
  return { load };
}
