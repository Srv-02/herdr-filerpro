// Adapted from herdr-files-plus by jjongkwann (https://github.com/jjongkwann/herdr-files-plus, MIT).
//
// Renders one Mermaid diagram outside the mod runtime (the mod would block on the 1.5 MB bundle and elkjs).
//   node render-mermaid.mjs <in.mmd> <outBase> <colorsJson>
// Writes <outBase>.svg, then <outBase>.json ({ width, height, key }) last, each through a .tmp file (named with the process id) and a rename,
// so a reader that finds the .json always finds a complete .svg. Deletes <in.mmd>. Prints nothing on success.
// Failure: one line on stderr, exit code 1, no output files.
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { flattenSvg, FONT, RENDER_VERSION } from "../preview/mermaid.js";

// A diagram never needs an image or a reference outside itself: discard such an SVG.
export function unsafeSvg(svg) {
  if (/<image\b/i.test(svg)) return true;
  for (const m of svg.matchAll(/\b(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) if (!(m[1] ?? m[2]).trim().startsWith("#")) return true;
  for (const m of svg.matchAll(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi)) if (!m[2].trim().startsWith("#")) return true;
  return false;
}

const oneLine = (e) => String(e?.message ?? e).split("\n").map((l) => l.trim()).find(Boolean) ?? "render failed";

async function main([input, outBase, colorsJson]) {
  if (!input || !outBase || colorsJson === undefined) throw new Error("usage: render-mermaid.mjs <in.mmd> <outBase> <colorsJson>");
  let source;
  try { source = await fs.readFile(input, "utf8"); } catch { throw new Error("cannot read the diagram source"); }
  try {
    let colors;
    try { colors = JSON.parse(colorsJson); } catch { throw new Error("colors are not valid JSON"); }
    let renderMermaidSVG;
    try { ({ renderMermaidSVG } = await import("../preview/mermaid.bundle.js")); }
    catch (e) { throw new Error(e?.code === "ERR_MODULE_NOT_FOUND" ? "mermaid.bundle.js missing" : `mermaid.bundle.js failed to load: ${oneLine(e)}`); }
    const svg = flattenSvg(renderMermaidSVG(source, { ...colors, font: FONT, transparent: true }), FONT);
    if (unsafeSvg(svg)) throw new Error("diagram contains an image or an external reference");
    const size = (name) => +(new RegExp(`<svg[^>]*\\s${name}="([\\d.]+)"`).exec(svg)?.[1] ?? 0);
    // The full cache key: the mod compares it to its own, so a short-hash collision never shows a foreign diagram.
    const meta = { width: size("width"), height: size("height"), key: JSON.stringify([RENDER_VERSION, source, colors, FONT]) };
    if (!(meta.width > 0 && meta.height > 0)) throw new Error("diagram has no size");
    // The temp names carry the process id: two renders of the same diagram must not share a temp file.
    const tmp = (ext) => `${outBase}.${process.pid}.${ext}.tmp`;
    await fs.writeFile(tmp("svg"), svg);
    await fs.rename(tmp("svg"), `${outBase}.svg`);
    await fs.writeFile(tmp("json"), JSON.stringify(meta));
    await fs.rename(tmp("json"), `${outBase}.json`);
  } finally {
    await fs.rm(input, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`${oneLine(e)}\n`);
    process.exitCode = 1;
  });
}
