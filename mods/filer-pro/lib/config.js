// Config: appHome()/filer-pro.json. Keys: download_folder, preview, mermaid, perf.
// A missing or broken file, or a value of the wrong type, means the default.
export async function loadConfig(readTextFile, appHome, home) {
  const fallback = `${home()}/Downloads`;
  let folder = null, cfg = null;
  try {
    const text = await readTextFile(`${appHome()}/filer-pro.json`);
    cfg = text == null ? null : JSON.parse(text);
    if (cfg && typeof cfg.download_folder === "string" && cfg.download_folder.trim() !== "") folder = cfg.download_folder.trim();
  } catch {
    folder = null; cfg = null;
  }
  const flag = (key, fallbackValue) => (cfg && typeof cfg[key] === "boolean" ? cfg[key] : fallbackValue);
  const flags = { preview: flag("preview", true), mermaid: flag("mermaid", true), perf: flag("perf", false) };
  if (folder == null) return { download_folder: fallback, ...flags };
  if (folder === "~" || folder.startsWith("~/")) folder = home() + folder.slice(1);
  return { download_folder: folder, ...flags };
}
