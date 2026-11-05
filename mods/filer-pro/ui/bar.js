// The transfers bar: one row per job in shared("filer-pro.jobs"). Nothing to render without jobs. As high as its
// rows (barHeight in mods/filer-pro/lib/barsize.js), at most 220 px; from there it scrolls.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { barFill } from "../lib/progress.js";
import { formatBytes, formatRate } from "../lib/sizes.js";
import { barHeight, BAR_BORDER, ROW_PAD_Y, ROW_GAP, NAME_LINE_H, TRACK_LINE_H, SMALL_LINE_H } from "../lib/barsize.js";

function detail(job) {
  if (job.state === "running") {
    const done = job.total != null ? `${formatBytes(job.bytes)} / ${formatBytes(job.total)}` : formatBytes(job.bytes);
    return `${done} · ${formatRate(job.rate)}`;
  }
  if (job.state === "done") return job.total != null ? formatBytes(job.total) : "Done";
  if (job.state === "cancelled") return "Cancelled";
  return "";
}

function track(job, t) {
  const { width, tone, pulse } = barFill(job);
  const fill = div().h_full().rounded(3).bg(tone === "error" ? t.ansi1 : t.ansi4).w(width);
  if (pulse) fill.loop("opacity", { from: 0.25, to: 1, period: 1200 });
  return div().flex_1().min_w(0).h(6).rounded(3).overflow_hidden().bg(t.hover).child(fill);
}

function row(job, t, { onCancel, onDismiss }) {
  const running = job.state === "running";
  const percent = running ? (job.percent == null ? "" : `${job.percent}%`) : job.state === "done" ? "100%" : "";
  const small = `${SMALL_LINE_H}px`;
  return v_flex().id(`job-${job.id}`).flex_none().gap(ROW_GAP).px(10).py(ROW_PAD_Y)
    .child(h_flex().h(NAME_LINE_H).line_height(`${NAME_LINE_H}px`).flex_none().gap(6).items_center()
      .child(div().w(12).flex_none().text_color(t.muted).child({ down: "↓", up: "↑", local: "→", remote: "→" }[job.direction]))
      .child(div().flex_1().min_w(0).truncate().child(job.name))
      .child(div().id(`job-x-${job.id}`).w(20).flex_none().text_center().cursor_pointer().text_color(t.muted).hover(s => s.text_color(t.foreground))
        .on_click((_e, cx) => { running ? onCancel(job.id) : onDismiss(job.id); cx.notify(); }).child("✕")))
    .child(h_flex().h(TRACK_LINE_H).flex_none().gap(6).items_center()
      .child(track(job, t))
      .child(div().w(34).flex_none().text_right().text_size(11).line_height(small).text_color(t.dim).child(percent)))
    .child(div().h(SMALL_LINE_H).flex_none().text_size(11).line_height(small).text_color(t.dim).truncate().child(detail(job)))
    .when(job.state === "failed" && Boolean(job.error), el => el.child(div().flex_none().text_size(11).line_height(small).text_color(t.ansi1).child(job.error)));
}

export function transfersBar(jobs, t, handlers) {
  const list = Array.isArray(jobs) ? jobs : Object.values(jobs ?? {});
  if (list.length === 0) return null;
  list.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  return v_flex().id("transfers").flex_none().h(barHeight(list)).overflow_y_scrollbar().border_t(BAR_BORDER).border_color(t.border)
    .children(list.map(job => row(job, t, handlers)));
}
