// Adapted from herdr-files-plus by jjongkwann (https://github.com/jjongkwann/herdr-files-plus, MIT).
//
// Takes everything out of Markdown and HTML that would load a resource or run code, so a preview
// never makes a network request (tracking pixels). The preview views draw no images at all; this
// is the second line of defense, in case a view ever does. Pure, no Herdr imports.
//
// The work comes in small steps (generators): the Herdr mod runtime is about six times slower than V8 and runs
// on the thread that draws and handles input, so a caller yields between steps (see prepare.js).
// The plain functions run all steps at once.

// Characters of work between two yields: about 0.75 ms per 1,000 characters in the Herdr runtime, so a step stays
// well under one 16 ms frame. A single line over MAX_LINE_CHARS is cut in the preview, because a line is one unit.
export const STEP_CHARS = 4000;
export const MAX_LINE_CHARS = 8000;

const run = (gen) => { let r; while (!(r = gen.next()).done); return r.value; };

// Elements removed together with their content (up to the closing tag, else to the end of the text).
const RAW = new Set(["script", "style", "svg", "picture", "video", "audio", "iframe", "object", "noscript", "frameset"]);
// Elements without content that are removed. img and image become a placeholder.
const VOID = new Set(["source", "embed", "link", "meta", "base", "track", "frame", "param"]);
const IMAGE = new Set(["img", "image"]);
// Attributes that load something or run code, on any element.
const DROP = /^(?:background|poster|style|src|srcset|data|ping|formaction|on.*)$/i;

const AUTOLINK = /<(?:[a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>]*|[^\s<>@]+@[^\s<>@]+)>/y;
const NAME = /<(\/?)([a-zA-Z][\w:-]*)(?=[\s/>])/y;
const ATTR = /(?:\s|\/(?!>))*([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>=`]+)))?/y;
const END = /\s*\/?>/y;

const escapeText = (s) => s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
const placeholder = (alt) => {
  const text = escapeText((alt ?? "").replace(/\s+/g, " ").trim().slice(0, 200));
  return text ? `[image: ${text}]` : "[image]";
};

function closeOf(html, name, from) {
  const re = new RegExp(`</${name}\\s*>`, "ig");
  re.lastIndex = from;
  const m = re.exec(html);
  return m ? m.index + m[0].length : html.length;
}

// Reads the tag at `at`: { end, closing, name, attrs: [[name, value]] }, or null when it is malformed.
function readTag(html, at) {
  NAME.lastIndex = at;
  const head = NAME.exec(html);
  if (!head) return null;
  const attrs = [];
  let i = NAME.lastIndex;
  for (;;) {
    END.lastIndex = i;
    if (END.test(html)) return { end: END.lastIndex, closing: head[1] === "/", name: head[2].toLowerCase(), attrs };
    ATTR.lastIndex = i;
    const m = ATTR.exec(html);
    if (!m || ATTR.lastIndex === i) return null;
    attrs.push([m[1], m[2] ?? m[3] ?? m[4] ?? ""]);
    i = ATTR.lastIndex;
  }
}

const attr = (tag, name) => tag.attrs.find(([n]) => n.toLowerCase() === name)?.[1];

/** The steps of stripHtmlResources: yields every STEP_CHARS characters, returns the text. */
export function* htmlSteps(html) {
  const out = [];
  let i = 0, mark = 0;
  while (i < html.length) {
    if (i - mark >= STEP_CHARS) { mark = i; yield; }
    const lt = html.indexOf("<", i);
    if (lt < 0) { out.push(html.slice(i)); break; }
    out.push(html.slice(i, lt));
    AUTOLINK.lastIndex = lt;
    if (AUTOLINK.test(html)) { out.push(html.slice(lt, AUTOLINK.lastIndex)); i = AUTOLINK.lastIndex; continue; }
    if (!/[a-zA-Z/]/.test(html[lt + 1] ?? "")) {
      // Comments, doctype and plain "<" stay as they are.
      out.push("<"); i = lt + 1; continue;
    }
    const tag = readTag(html, lt);
    if (!tag) { out.push("&lt;"); i = lt + 1; continue; }
    i = tag.end;
    if (tag.closing) { if (!RAW.has(tag.name) && !VOID.has(tag.name) && !IMAGE.has(tag.name)) out.push(html.slice(lt, i)); continue; }
    if (RAW.has(tag.name)) {
      const stop = closeOf(html, tag.name, i);
      if (tag.name === "picture") {
        const inner = html.slice(i, stop), img = /<img\b[^>]*>/i.exec(inner), t = img && readTag(inner, img.index);
        out.push(t ? placeholder(attr(t, "alt")) : "[image]");
      }
      i = stop; continue;
    }
    if (VOID.has(tag.name)) continue;
    if (IMAGE.has(tag.name)) { out.push(placeholder(attr(tag, "alt"))); continue; }
    if (tag.name === "input" && attr(tag, "type")?.trim().toLowerCase() === "image") { out.push("[image]"); continue; }
    const kept = tag.attrs.filter(([n]) => !DROP.test(n)).map(([n, v]) => ` ${n}="${v.replace(/"/g, "&quot;")}"`);
    out.push(`<${tag.name}${kept.join("")}>`);
  }
  return out.join("");
}

/** HTML without images, media, frames, scripts, styles, links to resources and loading attributes. */
export const stripHtmlResources = (html) => run(htmlSteps(html));

// ---- Markdown
//
// What the renderer treats as an image can differ from what a simple scan sees (escapes, code spans, HTML blocks,
// fences in containers). So nothing is trusted unless it is certain: only a fence that starts in column 0 outside an
// HTML block and has no backtick in its info string, and a code span that opens and closes on one line, count as code.
// Everywhere else every image marker "![" is neutralized, whatever the renderer would make of it.

const OPEN_FENCE = /^(?:(`{3,})[^`]*|(~{3,}).*)$/;
const CLOSE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const HTML_START = /^ {0,3}<[A-Za-z/!?]/;
const HTML_ENDS = [
  [/^ {0,3}<(?:script|pre|style|textarea)(?:\s|>|$)/i, /<\/(?:script|pre|style|textarea)>/i],
  [/^ {0,3}<!--/, /-->/], [/^ {0,3}<\?/, /\?>/], [/^ {0,3}<!\[CDATA\[/, /\]\]>/], [/^ {0,3}<![A-Za-z]/, />/],
];
const MD_IMAGE = /!\[([^\]\n]*)\](?:\([^)\n]*\)|\s?\[[^\]\n]*\])?/g;

const backslashesBefore = (text, at) => { let n = 0; while (at - n > 0 && text[at - n - 1] === "\\") n++; return n; };

// Splits prose into code spans and the rest. A span counts as code only when it is certain. CommonMark pairs backticks
// across the lines of a paragraph and lets a raw HTML tag swallow backticks, so after a backtick run without a partner
// on its own line, or after any "<" outside a span, nothing is trusted until the next blank line. `risky` says the
// paragraph already started that way (a chunk that ended inside a paragraph).
function* spans(text, risky) {
  let i = 0, last = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === "\n") { if (/^[ \t]*(?:\n|$)/.test(text.slice(i + 1, i + 200))) risky = false; i++; continue; }
    if (ch === "<") { risky = true; i++; continue; }
    if (ch !== "`") { i++; continue; }
    let n = 1;
    while (text[i + n] === "`") n++;
    const nl = text.indexOf("\n", i), lineEnd = nl < 0 ? text.length : nl;
    let close = -1;
    for (let at = text.indexOf("`", i + n); at >= 0 && at < lineEnd;) {
      let m = 1;
      while (text[at + m] === "`") m++;
      if (m === n) { close = at; break; }
      at = text.indexOf("`", at + m);
    }
    if (close < 0) { risky = true; i += n; continue; }
    if (risky) { i = close + n; continue; }
    if (i > last) yield [false, text.slice(last, i)];
    yield [true, text.slice(i, close + n)];
    i = last = close + n;
  }
  if (last < text.length) yield [false, text.slice(last)];
}

function neutralize(text) {
  const named = text.replace(MD_IMAGE, (m, alt, at, whole) => (backslashesBefore(whole, at) % 2 ? m : placeholder(alt.replace(/[\][\\]/g, ""))));
  return stripHtmlResources(named).replace(/(\\*)!\[/g, (m, bs) => (bs.length % 2 ? m : `${bs}\\![`));
}

// Between a piece and the next, backticks must stay separate: removing raw HTML can leave a literal run of backticks
// next to the run that opens a code span, and the two would merge into one longer run and change what is code.
const prose = (text, risky = false) => {
  let out = "";
  for (const [code, part] of spans(text, risky)) {
    const piece = code ? part : neutralize(part);
    out += (out.endsWith("`") && piece.startsWith("`") ? " " : "") + piece;
  }
  return out;
};

// Which HTML block, if any, a line opens: null, or the regex that ends it ("blank" ends at a blank line).
function htmlBlock(line) {
  if (!HTML_START.test(line)) return null;
  for (const [start, end] of HTML_ENDS) if (start.test(line)) return end.test(line) ? null : end;
  return "blank";
}

function* markdownPass(md) {
  const lines = md.split("\n"), out = [];
  let buf = [], bufHtml = false, size = 0, work = 0, fence = null, html = null, cut = false, carry = false;
  // Lines of an HTML block are raw HTML to the renderer: no backtick there starts a code span.
  const flush = () => {
    if (!buf.length) return;
    out.push(bufHtml ? neutralize(buf.join("\n")) : prose(buf.join("\n"), carry));
    carry = buf[buf.length - 1].trim() !== ""; // the paragraph goes on in the next piece
    buf = []; size = 0;
  };
  for (let line of lines) {
    if (line.length > MAX_LINE_CHARS) { line = `${line.slice(0, MAX_LINE_CHARS)} …`; cut = true; }
    work += line.length + 1;
    if (fence) {
      out.push(line);
      const close = CLOSE_FENCE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
    } else {
      let isHtml = html !== null;
      if (html === "blank" && line.trim() === "") { html = null; isHtml = false; }
      else if (html && html !== "blank" && html.test(line)) html = null;
      else if (html === null) {
        const open = OPEN_FENCE.exec(line);
        if (open) { flush(); fence = open[1] ?? open[2]; out.push(line); if (work >= STEP_CHARS) { work = 0; yield; } continue; }
        html = htmlBlock(line);
        isHtml = HTML_START.test(line);
      }
      if (isHtml !== bufHtml) flush();
      bufHtml = isHtml;
      buf.push(line);
      size += line.length + 1;
      // Cut between paragraphs when there is enough; a tag or an image never spans a blank line.
      if ((size >= STEP_CHARS && line.trim() === "") || size >= 2 * STEP_CHARS) flush();
    }
    if (work >= STEP_CHARS) { work = 0; yield; }
  }
  flush();
  return { text: out.join("\n"), cut };
}

/**
 * The steps of stripMarkdownImages: yields between pieces of work, returns { text, cut }.
 * Removing a tag or an image can change the block structure (a line that started with a tag now starts with "<!--" or
 * "~~~"), so the pass runs again on its own output until nothing changes (at most three times; the usual document
 * changes nothing in the second pass).
 */
export function* markdownSteps(md) {
  let text = md, cut = false;
  for (let pass = 0; pass < 3; pass++) {
    const r = yield* markdownPass(text);
    cut = cut || r.cut;
    if (r.text === text) break;
    text = r.text;
    yield;
  }
  return { text, cut };
}

/** Markdown without images (inline, reference, HTML) and without loading raw HTML; real code stays code. */
export const stripMarkdownImages = (md) => run(markdownSteps(md)).text;
