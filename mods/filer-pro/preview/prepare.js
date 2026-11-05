// Adapted from herdr-files-plus by jjongkwann (https://github.com/jjongkwann/herdr-files-plus, MIT).
//
// Everything a preview needs before it is drawn: truncate, strip loading content, split out diagrams.
// Pure. The work is a generator of small steps (prepareSteps): the Herdr runtime is about six times slower than V8
// and runs on the thread that draws and handles input, so the mod sleeps between steps (prepareAsync) and shows the
// source meanwhile. prepare() runs all steps at once (tests, tools).
import { markdownSteps, htmlSteps } from "./strip.js";
import { splitMermaidSteps, MAX_DIAGRAMS, MAX_DIAGRAM_CHARS } from "./mermaid.js";

export const PREVIEW_MAX_CHARS = 200000;
export { MAX_DIAGRAMS, MAX_DIAGRAM_CHARS };

// Links in a document are written by whoever wrote the document: only web links go to the system opener.
// A local path, file:, javascript: or a custom scheme could start a program.
export function safeLink(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
}

const fence = (text) => "```mermaid\n" + text + "\n```";

/**
 * The steps of prepare: yields between pieces of work, returns
 * { kind, parts: [{ kind: "markdown" | "html" | "mermaid", text, diagram? }], truncated, diagrams }.
 * Mermaid parts beyond MAX_DIAGRAMS fold back into Markdown, so they show as code.
 */
export function* prepareSteps(text, { kind, mermaid }) {
  let source = text, truncated = false;
  if (source.length > PREVIEW_MAX_CHARS) {
    let cut = PREVIEW_MAX_CHARS;
    const last = source.charCodeAt(cut - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut--;
    source = source.slice(0, cut);
    truncated = true;
  }
  if (kind === "html") return { kind, parts: [{ kind: "html", text: yield* htmlSteps(source) }], truncated, diagrams: 0 };
  const stripped = yield* markdownSteps(source);
  yield;
  const split = mermaid ? yield* splitMermaidSteps(stripped.text) : [{ kind: "markdown", text: stripped.text }];
  const parts = [];
  let diagrams = 0;
  for (const p of split) {
    const keep = p.kind === "mermaid" && diagrams < MAX_DIAGRAMS;
    if (keep) diagrams++;
    const next = p.kind === "mermaid" && !keep ? { kind: "markdown", text: fence(p.text) } : { ...p };
    const prev = parts.at(-1);
    if (next.kind === "markdown" && prev?.kind === "markdown") prev.text += "\n\n" + next.text;
    else parts.push(next);
  }
  return { kind, parts, truncated: truncated || stripped.cut, diagrams };
}

export function prepare(text, options) {
  const gen = prepareSteps(text, options);
  let r;
  while (!(r = gen.next()).done);
  return r.value;
}

/**
 * prepare in steps with `await sleep()` between them, so input and drawing keep running. `alive()` is asked before
 * every step: false (another file was opened) stops at once and returns null. `onStep(ms)` gets each step's duration.
 */
export async function prepareAsync(text, options, { sleep, alive, now = Date.now, onStep }) {
  const gen = prepareSteps(text, options);
  for (;;) {
    if (!alive()) return null;
    const t0 = now(), r = gen.next();
    onStep?.(now() - t0);
    if (r.done) return r.value;
    await sleep();
  }
}
