// Harness for `npm run check:preview` (copies mods/filer-pro/preview into this folder, then `herdr-app check test/check-preview`): the check does not load mods/filer-pro/preview/index.js on its own
// (main.js imports it only dynamically), and a mod may not import outside its folder. This mod imports the copy statically and draws every view once.
import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme } from "herdr";
import { view, tools, largeNote, prepare } from "./preview/index.js";

const SAMPLE = [
  "# Title", "", "A [link](https://example.com), a ![pic](https://example.com/p.gif) and `code`.", "",
  "```mermaid", "flowchart LR", "  A --> B", "```", "", "| a | b |", "|---|---|", "| 1 | 2 |",
].join("\n");
const HTML = '<h1>Title</h1><p>Text <a href="https://example.com">link</a></p><img src="https://example.com/p.gif" alt="pic">';

export default class CheckPreview extends View {
  render() {
    const t = theme(), noop = () => {}, handlers = { onWidth: noop };
    const pdfHandlers = { onToggle: noop, onOpen: noop, onPage: noop, onZoom: noop, onSpread: noop };
    const withDiagrams = prepare(SAMPLE, { kind: "markdown", mermaid: true });
    withDiagrams.parts.filter((p) => p.kind === "mermaid").forEach((p) => { p.diagram = { error: "demo" }; });
    withDiagrams.truncated = true;
    const plain = prepare(SAMPLE, { kind: "markdown", mermaid: false });
    const html = prepare(HTML, { kind: "html", mermaid: false });
    const frame = (el) => div().h(160).flex_none().child(el);
    return v_flex().size_full().gap(6).bg(t.background)
      .child(frame(view(withDiagrams, { t, font: "monospace", file: "a.md", width: 320 }, handlers)))
      .child(frame(view(plain, { t, font: "monospace", file: "b.md", width: 320 }, handlers)))
      .child(frame(view(html, { t, font: "monospace", file: "c.html", width: 320 }, handlers)))
      .child(frame(view({ kind: "pdf", path: "data/filer-pro/images/none.png", width: 300, height: 150, page: 2, pages: 5 }, { t, font: "monospace", file: "d.pdf", width: 320 }, handlers)))
      .children(tools({ kind: "pdf" }, { mode: "preview", canOpen: false, page: 2, pages: 5 }, t, pdfHandlers))
      .children(tools({ kind: "pdf" }, { mode: "preview", canOpen: false, page: 3, pages: 12, full: true, spread: true, percent: 100, fit: true }, t, pdfHandlers))
      .child(frame(view({ kind: "pdf", path: "data/filer-pro/images/none.png", width: 300, height: 150, page: 2, pages: 5 }, { t, font: "monospace", file: "e.pdf", width: 320, pdf: { items: [{ path: "data/filer-pro/images/none.png", w: 150, h: 100 }, { path: "data/filer-pro/images/none2.png", w: 150, h: 100 }] } }, { onWidth: noop, onZoom: noop, onWheel: noop })))
      .child(frame(largeNote("File is larger than 20 MB", t, noop)))
      .children(tools(html, { mode: "preview", canOpen: true }, t, { onToggle: noop, onOpen: noop }));
  }
}
