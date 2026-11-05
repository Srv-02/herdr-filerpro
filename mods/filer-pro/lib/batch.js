// Decisions for one batch of transfer items. Pure. An item is { key, name, isDir, destIsDir?, exists, linkWarning?, mergeError? }.
// Questions come in two stages: first every link warning (Transfer anyway / Cancel; a folder with a
// symlink loop is blocked and only gets OK, which cancels it), then every conflict with an existing
// target. "Apply to all" covers items of the same kind (file or folder) and, for link warnings,
// the same blocked state: blocked and other folders are never answered together.
const LINK_CHOICES = ["transfer_anyway", "cancel"];
const BLOCKED_CHOICES = ["ok"];
const FILE_CHOICES = ["replace", "keep_both", "cancel"];
const DIR_CHOICES = ["merge", "replace", "keep_both", "cancel"];

export function createBatch(items) {
  const state = new Map(items.map((i) => [i.key, { link: undefined, choice: undefined }]));
  const needsLink = (i) => Boolean(i.linkWarning);
  const blocked = (i) => Boolean(i.linkBlocked);
  // Merge needs a folder on both sides (#54); otherwise it is stored as replace.
  const canMerge = (item) => Boolean(item.isDir) && item.destIsDir !== false;
  const normalize = (item, choice) => (choice === "merge" && !canMerge(item) ? "replace" : choice);
  // Same question: same kind of source and of target (a file over a folder is not answered with a file over a file).
  const sameKind = (a, b) => a.isDir === b.isDir && a.destIsDir === b.destIsDir;

  const linkOpen = (i) => needsLink(i) && state.get(i.key).link === undefined;
  const conflictOpen = (i) => {
    const s = state.get(i.key);
    return i.exists && s.choice === undefined && s.link !== "cancel" && !linkOpen(i);
  };

  function next() {
    return items.find(linkOpen) ?? items.find(conflictOpen) ?? null;
  }

  function choices(item) {
    if (linkOpen(item)) return [...(blocked(item) ? BLOCKED_CHOICES : LINK_CHOICES)];
    // A folder that cannot be merged (a linked source, #46) is asked like a file; Apply to all can still bring it
    // a Merge, which requests.js runTransfers refuses after the answer.
    return [...(canMerge(item) && !item.mergeError ? DIR_CHOICES : FILE_CHOICES)];
  }

  function setLink(item, choice) {
    // A blocked folder is never transferred, whatever the answer is.
    state.get(item.key).link = choice === "transfer_anyway" && !blocked(item) ? "transfer_anyway" : "cancel";
  }
  function setChoice(item, choice) {
    state.get(item.key).choice = normalize(item, choice);
  }

  function answer(choice, applyToAll) {
    const item = next();
    if (!item) return;
    if (linkOpen(item)) {
      setLink(item, choice);
      if (applyToAll) for (const i of items) if (i !== item && linkOpen(i) && i.isDir === item.isDir && blocked(i) === blocked(item)) setLink(i, choice);
    } else {
      setChoice(item, choice);
      if (applyToAll) for (const i of items) if (i !== item && conflictOpen(i) && sameKind(i, item)) setChoice(i, choice);
    }
  }

  // Answers from a request (links / conflict fields) before any question is asked.
  function preset({ links, conflict } = {}) {
    for (const i of items) {
      if (links && linkOpen(i)) setLink(i, links);
      if (conflict && i.exists && state.get(i.key).choice === undefined) setChoice(i, conflict);
    }
  }

  function decision(key) {
    const item = items.find((i) => i.key === key);
    const s = state.get(key);
    if (!item) return undefined;
    if (s.link === "cancel") return "cancel";
    if (linkOpen(item)) return undefined;
    if (s.choice !== undefined) return s.choice;
    return item.exists ? undefined : "new";
  }

  // How many items of the same kind are still waiting for the same question.
  function remaining(item) {
    const isLink = linkOpen(item);
    const open = isLink ? linkOpen : conflictOpen;
    return items.filter((i) => open(i) && (isLink ? i.isDir === item.isDir && blocked(i) === blocked(item) : sameKind(i, item))).length;
  }

  return { next, choices, answer, preset, decision, remaining };
}
