// Texts of a move job in the transfers bar (#100). Pure.
export const MOVE_MARK = "✂";

// job.move.srcOn names the source side (null = this computer). base: the detail line of a plain job.
export function moveDetail(job, base) {
  const on = job.move?.srcOn ?? null, trash = on === null;
  switch (job.state) {
    case "running": return trash ? `${base} · then moves the original to the Trash` : `${base} · then deletes the original on ${on}`;
    case "verifying": return "Checking the copy…";
    case "deleting": return trash ? "Moving the original to the Trash…" : `Deleting the original on ${on}…`;
    case "done":
      if (typeof job.kept === "string") return `${base} · Copied. The original is kept.`;
      if (job.moved) return trash ? `${base} · Moved. The original is in the Trash.` : `${base} · Moved. The original on ${on} is deleted.`;
      return base;
    default: return base;
  }
}
