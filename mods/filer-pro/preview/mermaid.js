// Adapted from herdr-files-plus by jjongkwann (https://github.com/jjongkwann/herdr-files-plus, MIT).
// Pure Mermaid helpers: fence splitting, SVG flattening, theme colors, cache key. Rendering happens in
// bin/render-mermaid.mjs (a Node child process), never in the mod runtime.
//
// Limits that keep a hostile or huge document from starting hundreds of renders.
export const MAX_DIAGRAMS = 20;
export const MAX_DIAGRAM_CHARS = 20000;

// Characters of lines between two yields (see strip.js: the Herdr runtime is slow, a step must stay short).
const STEP_CHARS = 4000;

/** The steps of splitMermaid: yields every STEP_CHARS characters, returns the parts. */
export function* splitMermaidSteps(markdown) {
  const lines = markdown.split("\n"), parts = [];
  // A search that found no closing fence of a character and length rules out every later
  // fence at least that long, so each line is scanned once.
  let text = [], i = 0, work = 0;
  const unclosed = {};
  const flush = () => { const joined = text.join("\n"); if (joined.trim()) parts.push({ kind: "markdown", text: joined }); text = []; };
  while (i < lines.length) {
    if (work >= STEP_CHARS) { work = 0; yield; }
    const open = /^(`{3,}|~{3,})[ \t]*mermaid[ \t]*\r?$/.exec(lines[i]);
    let close = -1;
    if (open && open[1].length < (unclosed[open[1][0]] ?? Infinity)) {
      const fence = new RegExp(`^${open[1][0]}{${open[1].length},}[ \\t]*\\r?$`);
      for (let j = i + 1; j < lines.length; j++) if (fence.test(lines[j])) { close = j; break; }
      if (close < 0) unclosed[open[1][0]] = open[1].length;
    }
    if (close < 0) { work += lines[i].length + 1; text.push(lines[i++]); continue; }
    flush();
    const body = lines.slice(i + 1, close);
    for (const l of body) work += l.length + 1;
    parts.push({ kind: "mermaid", text: body.join("\n").replace(/\r$/gm, "") });
    i = close + 1;
  }
  flush();
  return parts;
}

/** Splits Markdown into [{ kind: "markdown" | "mermaid", text }], in order. One pass over the lines. */
export function splitMermaid(markdown) {
  const gen = splitMermaidSteps(markdown);
  let r;
  while (!(r = gen.next()).done);
  return r.value;
}

// ---- CSS variables and color-mix() → concrete colors (the SVG loader understands neither).

function hex(c) {
  const m = /^#([0-9a-f]{3,8})$/i.exec(c.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3 || h.length === 4) h = [...h].map(x => x + x).join("");
  if (h.length !== 6 && h.length !== 8) return null;
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}
const toHex = rgb => "#" + rgb.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");

function args(s) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (s[i] === "," && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out.map(a => a.trim());
}

function closing(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

function evaluate(expr, vars, depth = 0) {
  expr = expr.trim();
  const fn = /^(var|color-mix)\(/.exec(expr);
  if (!fn || depth > 16) return expr;
  const end = closing(expr, fn[0].length - 1);
  const [first, ...rest] = args(expr.slice(fn[0].length, end));
  if (fn[1] === "var") {
    if (vars.has(first)) return vars.get(first);
    return rest.length ? evaluate(rest.join(","), vars, depth + 1) : "currentColor";
  }
  // color-mix(in srgb, A p%, B [q%])
  const stop = s => { const m = /^(.*?)(?:\s+([\d.]+)%)?$/.exec(s); return [evaluate(m[1], vars, depth + 1), m[2] === undefined ? null : +m[2]]; };
  const [[a, pa], [b, pb]] = rest.map(stop);
  const ca = hex(a ?? ""), cb = hex(b ?? "");
  if (!ca || !cb) return ca ? a : b;
  const p = pa ?? (pb === null ? 50 : 100 - pb);
  return toHex(ca.map((v, i) => (v * p + cb[i] * (100 - p)) / 100));
}

// Replaces every var()/color-mix() in a piece of CSS.
function resolve(css, vars) {
  let out = "", i = 0;
  for (;;) {
    const at = css.slice(i).search(/(var|color-mix)\(/);
    if (at < 0) return out + css.slice(i);
    const start = i + at, end = closing(css, css.indexOf("(", start));
    if (end < 0) return out + css.slice(i);
    out += css.slice(i, start) + evaluate(css.slice(start, end + 1), vars);
    i = end + 1;
  }
}

const STYLE = /<style>([\s\S]*?)<\/style>/g, ROOT = /^<svg\b[^>]*>/, ATTR = /(\s[\w:-]+=")([^"]*)(")/g;

/**
 * Rewrites the renderer's SVG so every color is literal and no remote font is fetched.
 * Only its <style> block and attribute values are touched; diagram text is left alone.
 */
export function flattenSvg(svg, font) {
  font = font.split(",").map(f => f.trim()).map(f => /^[\w-]+$/.test(f) ? f : `'${f.replace(/['"]/g, "")}'`).join(", ");
  // Variables come only from the root element's style and the <style> block, resolved once each, in order.
  const vars = new Map();
  const declarations = [ROOT.exec(svg)?.[0] ?? "", ...[...svg.matchAll(STYLE)].map(m => m[1])].join("\n");
  for (const m of declarations.matchAll(/(--[\w-]+)\s*:\s*([^;}"]+)/g))
    if (!vars.has(m[1])) vars.set(m[1], evaluate(resolve(m[2].trim(), vars), vars));
  const css = text => resolve(text, vars)
    .replace(/@import\s+url\([^)]*\)[^;]*;/g, "")
    .replace(/\s*--[\w-]+\s*:\s*[^;}"]+;?/g, "")
    .replace(/font-family\s*:\s*[^;}"]+/g, `font-family: ${font}`);
  return svg
    .replace(STYLE, (_, body) => `<style>${css(body)}</style>`)
    .replace(/<[a-zA-Z][^>]*>/g, tag => tag.replace(ATTR, (_, pre, value, post) =>
      pre.trim().startsWith("font-family=") ? `${pre}${font.replaceAll('"', "'")}${post}` : pre + css(value) + post));
}

// Bump when the SVG output changes: the image loader caches by path, so a new look needs a new name.
export const RENDER_VERSION = 1;

/** FNV-1a, base36. */
export function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/** Herdr theme → diagram colors. */
export function colorsFor(t) {
  return { bg: t.background, fg: t.foreground, line: t.dim, accent: t.ansi4, muted: t.muted, border: t.border };
}

/** The six theme colors a diagram uses, joined: a cheap key to tell whether a theme change matters. */
export function colorKey(t) {
  return [t.background, t.foreground, t.dim, t.ansi4, t.muted, t.border].join("|");
}

/** The SVG loader resolves real family names and generic sans-serif, but not system-ui. */
export const FONT = "'Helvetica Neue', 'Segoe UI', Arial, 'Noto Sans', sans-serif";
