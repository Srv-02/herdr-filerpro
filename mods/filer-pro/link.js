// Herdr's terminal link handler (link_handlers in mod.json): a Ctrl/Cmd-click on an image, PDF, Markdown or HTML file
// shows it in the Filer Pro panel instead of the system app, also from a terminal on another machine. The panel copy
// that shows the clicked terminal's machine picks the click up (pollLink in main.js).
import { exec, layout, run, setShared } from "herdr";
import { linkTarget, wantsHome } from "./lib/linkclick.js";
import { revealCommands } from "./lib/panels.js";

export async function handleLink({ link, source }) {
  const reveal = revealCommands(layout(), "filer-pro");
  if (!reveal) return "pass"; // no Filer Pro panel in this layout: the usual opener
  const home = wantsHome(link)
    ? await exec("sh", ["-c", 'printf %s "$HOME"'], { on: source?.machine ?? null }).then((r) => (r.code === 0 ? r.stdout : null), () => null)
    : null;
  const target = linkTarget(link, source, home);
  if (!target) return "pass";
  setShared("filer-pro.link", { id: (Math.random().toString(36).slice(2) + "00000000").slice(0, 8), at: Date.now(), ...target });
  for (const [command, args] of reveal) run(command, args);
  return "handled";
}
