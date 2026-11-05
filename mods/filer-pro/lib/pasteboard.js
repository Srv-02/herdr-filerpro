// The system clipboard for Copy Path. cx.write_to_clipboard (gpui-kit Context) is called synchronously, before
// any await: the context is only valid until the handler's first await. Without it, or when it throws, the text
// goes through pbcopy as an argument (platform.clipboardArgs). No success toast; a failure is one.
export async function writeClipboard(text, { cx, exec, notify, platform }) {
  if (typeof cx?.write_to_clipboard === "function") {
    try {
      cx.write_to_clipboard(text);
      return { ok: true };
    } catch {
      // fall through to pbcopy
    }
  }
  let r = null;
  try {
    const [cmd, args] = platform.clipboardArgs(text);
    r = await exec(cmd, args);
  } catch {
    r = null;
  }
  if (r?.code === 0) return { ok: true };
  const error = `Could not copy to the clipboard: ${text}`;
  notify({ title: "Copy Path failed", body: error, level: "error" });
  return { ok: false, error };
}
