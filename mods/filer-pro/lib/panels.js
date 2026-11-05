// The tab bar shows a panel button only for ids in shared "workspace.panels".
const DEFAULT_PANELS = ["files", "changes"];

// Returns the list with id included (pure, idempotent). Null or invalid input starts from the defaults.
export function withPanel(panels, id) {
  const list = Array.isArray(panels) ? panels : DEFAULT_PANELS;
  return list.includes(id) ? list : [...list, id];
}

// Removes the ids of the renamed predecessor mods from the list, each unless its layout block is still present
// (then the old mod may still be in use). `legacy` is one id or a list. Pure; returns the same reference when nothing changes.
// This is one of the two places under mods/filer-pro/ that name the old ids (allowed in test/clone.test.js).
export function withoutLegacy(panels, root, legacy = ["fileshare", "file-pro"]) {
  if (!Array.isArray(panels)) return panels;
  const stale = [].concat(legacy).filter((id) => panels.includes(id) && !find(root, id));
  return stale.length ? panels.filter((id) => !stale.includes(id)) : panels;
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Is the panel block `id` on screen? panel-body is a stack (one panel at a time) or a column (each panel toggled).
export function panelShown(root, id) {
  const panel = find(root, "panel"), body = find(root, "panel-body");
  if (!panel || !body || panel.hidden) return false;
  if (body.type === "stack") return body.active === id && find(body, id) !== null;
  return (body.children ?? []).some((c) => c.id === id && !c.hidden);
}
