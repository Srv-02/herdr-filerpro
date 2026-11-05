// Adapted from herdr-files-plus by jjongkwann (https://github.com/jjongkwann/herdr-files-plus, MIT).
//
// The preview module: the views for a prepared document and the header buttons. main.js loads this
// folder only with import(), so deleting mods/filer-pro/preview/ leaves the mod working without a preview.
// Everything in here may import its own files statically; the folder is the unit of removal.
import { div, image } from "gpui-kit";
import { v_flex, TextView } from "gpui-base";
import { safeLink, noteText, PREVIEW_MAX_CHARS } from "./prepare.js";
import { fit } from "./images.js";

export { prepare, prepareAsync } from "./prepare.js";
export { createDiagrams } from "./diagrams.js";
export { createImages } from "./images.js";
export { clearLoads, loadDir, previewJob, loadOutcome, resolveFile } from "./images.js";
export { createPdfs } from "./pdf.js";
export { colorKey } from "./mermaid.js";

export const WIDTH_STEP = 32;

// Document links are untrusted: only web links open, and only on a click.
const onLink = (url, cx) => { const target = safeLink(url); if (target) cx.open_url(target); };

const text = (kind, id, body) => {
  const el = kind === "html" ? TextView.html(id, body) : TextView.markdown(id, body);
  return el.on_link_click(onLink).selectable(true);
};

function diagram(p, i, t, font, width) {
  const d = p.diagram ?? {};
  if (d.path && d.width && d.height) {
    const w = Math.min(d.width, Math.max(80, (width ?? d.width + 32) - 32));
    return div().id(`diagram-${i}`).flex_none().child(image(d.path).w(w).h(w * d.height / d.width));
  }
  return v_flex().id(`diagram-${i}`).flex_none().gap(4).p(10).rounded(6).border_1().border_color(t.border)
    .child(div().text_size(11).text_color(d.error ? t.ansi1 : t.dim).child(d.error ? `Mermaid: ${d.error}` : "Rendering diagram…"))
    .when(Boolean(d.error), (el) => el.child(div().text_size(12).font_family(font).text_color(t.muted).child(p.text)));
}

// One image from the cache (doc.path is relative to the app folder, as image() wants it): as wide as the view minus
// its padding, never wider than the image itself, and the width is reported in steps like the diagram view.
function picture(doc, width, onWidth) {
  const { w, h } = fit(doc.width, doc.height, width);
  return v_flex().id("files-preview").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(10)
    .on_size_change((size, cx) => onWidth(Math.floor(size.width / WIDTH_STEP) * WIDTH_STEP, cx))
    .child(div().id("files-image").flex_none().child(image(doc.path).w(w).h(h)));
}

const note = (t, doc) => div().flex_none().text_size(11).text_color(t.dim).child(noteText(doc.limit ?? PREVIEW_MAX_CHARS));

/**
 * The element for a prepared document. `width` is the last reported width (in 32 px steps); `onWidth(width, cx)`
 * is called only for documents with diagrams and images, and only when the step changes.
 */
export function view(doc, { t, font, file, width }, { onWidth }) {
  if (doc.kind === "image" || doc.kind === "pdf") return picture(doc, width, onWidth);
  if (!doc.diagrams) {
    const part = doc.parts[0] ?? { kind: doc.kind, text: "" };
    return v_flex().id("files-preview").flex_1().min_h(0).px(16).py(10).gap(6)
      .child(text(part.kind, `preview-${file}`, part.text).scrollable(true).flex_1().min_h(0))
      .when(doc.truncated, (el) => el.child(note(t, doc)));
  }
  return v_flex().id("files-preview").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(10).gap(10)
    .on_size_change((size, cx) => onWidth(Math.floor(size.width / WIDTH_STEP) * WIDTH_STEP, cx))
    .children(doc.parts.map((p, i) => (p.kind === "mermaid" ? diagram(p, i, t, font, width) : text("markdown", `preview-${file}-${i}`, p.text))))
    .when(doc.truncated, (el) => el.child(note(t, doc)));
}

/** The header buttons: Preview/Source (names the view you switch to) and Open in browser (local HTML only). */
const button = (id, label, t, onClick) => div().id(id).px(7).py(2).rounded(6).text_size(11).text_color(t.muted).cursor_pointer()
  .hover((s) => s.bg(t.hover)).on_click(onClick).child(label);

export function tools(doc, { mode, canOpen, page, pages }, t, { onToggle, onOpen, onPage }) {
  if (doc.kind === "image") return [];
  if (doc.kind === "pdf") {
    // Previous · "3 / 12" · Next; a button at its end is dimmed and has no click. main.js owns page and pages.
    const edge = (id, label, target) => target ? button(id, label, t, (_e, cx) => onPage(target, cx)) : div().id(id).px(7).py(2).text_size(11).text_color(t.dim).child(label);
    return [edge("files-page-prev", "Previous", page > 1 ? page - 1 : 0), div().text_size(11).text_color(t.muted).child(`${page} / ${pages}`), edge("files-page-next", "Next", page < pages ? page + 1 : 0)];
  }
  const out = [button("files-mode", mode === "preview" ? "Source" : "Preview", t, (_e, cx) => onToggle(cx))];
  if (doc.kind === "html" && canOpen) out.push(button("files-browser", "Open in browser", t, (_e, cx) => onOpen(cx)));
  return out;
}

/** The hint for a file over the size limit, with the Load button (main.js lifts the limit on a click). */
export function largeNote(text, t, onLoad) {
  return v_flex().id("files-preview").flex_1().min_h(0).p(12).gap(8).items_start()
    .child(div().text_color(t.dim).child(text))
    .child(button("files-load", "Load", t, (_e, cx) => onLoad(cx)).border_1().border_color(t.border));
}
