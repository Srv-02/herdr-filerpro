// Adapted from herdr-files-plus by jjongkwann (https://github.com/jjongkwann/herdr-files-plus, MIT); the idea of renderToFile.
//
// Steers the diagrams of one preview: cache lookup, limits, order, and the Node child process that
// draws them. Pure: the Herdr functions come in as dependencies, so it runs under Node tests.
import { BASE } from "../lib/icons.js";
import { hash, colorsFor, FONT, RENDER_VERSION, MAX_DIAGRAMS, MAX_DIAGRAM_CHARS } from "./mermaid.js";

const DATA = "data/filer-pro";
export const NODE_CANDIDATES = ["node", "/opt/homebrew/bin/node", "/usr/local/bin/node"];
export const NO_NODE = 'node not found (install Node.js or set "mermaid": false)';

const oneLine = (text) => String(text ?? "").split("\n").map((l) => l.trim()).find(Boolean);
const timedOut = (e) => /time[d ]*-?\s*out/i.test(String(e?.message ?? e));

export function createDiagrams({ exec, readTextFile, writeFile, mkdir, unlink, appHome, now, perf, hash: shortHash = hash, rand = () => Math.random().toString(36).slice(2, 8) }) {
  let node = null, folder = null, noNode = false;

  const ensureFolder = () => (folder ??= mkdir(`${appHome()}/${DATA}/diagrams`, { recursive: true }));

  // Runs the first Node that exec accepts; the working one is remembered for this instance. A configured path
  // (setting node_path) is the only one tried; it is not remembered, so a changed setting applies to the next run.
  async function runNode(args, configured) {
    if (configured) {
      if (noNode) throw new Error(`node not found at ${configured}`);
      try { return await exec(configured, args, { on: null }); }
      catch (e) {
        if (timedOut(e)) throw new Error("render timed out");
        noNode = true;
        throw new Error(`node not found at ${configured}`);
      }
    }
    if (noNode) throw new Error(NO_NODE);
    const order = node ? [node] : NODE_CANDIDATES;
    for (const cmd of order) {
      try {
        const r = await exec(cmd, args, { on: null });
        node = cmd;
        return r;
      } catch (e) {
        if (timedOut(e)) throw new Error("render timed out");
      }
    }
    if (node) { node = null; return runNode(args); }
    noNode = true; // not again for the other diagrams of this run; the next run probes anew
    throw new Error(NO_NODE);
  }

  async function renderOne(source, theme, configured) {
    // The file name is a short, non-cryptographic hash. The .json carries the full key, so a collision
    // (another source with the same name) is never shown as a cache hit.
    const full = JSON.stringify([RENDER_VERSION, source, colorsFor(theme), FONT]), key = shortHash(full);
    const dir = `${DATA}/diagrams`, base = `${appHome()}/${dir}/${key}`;
    const known = async () => {
      try {
        const meta = JSON.parse(await readTextFile(`${base}.json`));
        return meta && meta.key === full && meta.width > 0 && meta.height > 0 ? { path: `${dir}/${key}.svg`, width: meta.width, height: meta.height } : null;
      } catch { return null; }
    };
    const hit = await known();
    if (hit) return hit;
    await ensureFolder();
    const input = `${base}.${rand()}.mmd`;
    await writeFile(input, source);
    const t0 = now();
    let r, failure = null;
    try { r = await runNode([`${appHome()}/${BASE}/bin/render-mermaid.mjs`, input, base, JSON.stringify(colorsFor(theme))], configured); }
    catch (e) { failure = e; }
    finally { perf?.sample("mermaid.exec", now() - t0); }
    if (failure || r.code !== 0) {
      // The script removes its own source; after a failure to start, a timeout or an error exit it may still be there.
      await unlink?.(input).catch(() => {});
      // Another run of the same diagram may have been faster: its result is as good as ours.
      const done = await known();
      if (done) return done;
      throw failure ?? new Error(oneLine(r.stderr) ?? "render failed");
    }
    const made = await known();
    if (!made) throw new Error("render produced no output");
    return made;
  }

  /**
   * Draws every mermaid part in order, one at a time. Sets `part.diagram` to { loading: true }, then to
   * { path, width, height } or { error }. `current()` is asked before each diagram and after its result:
   * false stops the run and drops the result. `onChange()` follows each finished diagram. `limits` from the settings:
   * { maxDiagrams, maxChars, node } (max_diagrams, max_diagram_chars, node_path; "" or missing node: the candidates).
   */
  async function renderAll(parts, theme, current, onChange, { maxDiagrams = MAX_DIAGRAMS, maxChars = MAX_DIAGRAM_CHARS, node: configured = "" } = {}) {
    let started = 0;
    noNode = false;
    const todo = [];
    for (const p of parts) {
      if (p.kind !== "mermaid") continue;
      if (p.text.length > maxChars) p.diagram = { error: `Diagram too large (limit ${maxChars.toLocaleString("en-US")} characters)` };
      else if (++started > maxDiagrams) p.diagram = { error: `Too many diagrams (limit ${maxDiagrams})` };
      else { p.diagram = { loading: true }; todo.push(p); }
    }
    for (const p of todo) {
      if (!current()) return;
      let result;
      try { result = await renderOne(p.text, theme, configured); }
      catch (e) { result = { error: oneLine(e?.message ?? e) ?? "render failed" }; }
      if (!current()) return;
      p.diagram = result;
      onChange();
    }
  }

  return { renderAll };
}
