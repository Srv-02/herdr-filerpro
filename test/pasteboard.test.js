import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { writeClipboard } from "../mods/filer-pro/lib/pasteboard.js";
import { platform } from "../mods/filer-pro/lib/platform.js";
import { mkTmp } from "./tmp-helper.js";

const TEXT = `-n "a" $(x) 'b' %s\nline2\n`;

function recording(code = 0) {
  const calls = [];
  const deps = { exec: async (cmd, args) => { calls.push([cmd, args]); return { code, stdout: "", stderr: "" }; }, notify: (n) => calls.push(["notify", n]), platform };
  return { calls, deps };
}

test("writeClipboard uses cx.write_to_clipboard synchronously and runs nothing", async () => {
  const { calls, deps } = recording();
  const written = [];
  const p = writeClipboard(TEXT, { ...deps, cx: { write_to_clipboard: (t) => written.push(t) } });
  assert.deepEqual(written, [TEXT]); // before any await
  assert.deepEqual(await p, { ok: true });
  assert.deepEqual(calls, []);
});

test("writeClipboard falls back to pbcopy without cx and when the cx method throws", async () => {
  for (const cx of [undefined, null, {}, { write_to_clipboard: () => { throw new Error("no clipboard"); } }]) {
    const { calls, deps } = recording();
    assert.deepEqual(await writeClipboard(TEXT, { ...deps, cx }), { ok: true });
    assert.deepEqual(calls, [platform.clipboardArgs(TEXT)]);
  }
});

test("writeClipboard: the fallback hands the text to pbcopy byte for byte (real sh, fake pbcopy in PATH)", async () => {
  const dir = await fs.realpath(await mkTmp("clip-"));
  const bin = `${dir}/bin`, out = `${dir}/clip.txt`;
  await fs.mkdir(bin);
  await fs.writeFile(`${bin}/pbcopy`, `#!/bin/sh\ncat > "${out}"\n`, { mode: 0o755 });
  // PATH only for the child process; the test process keeps its own
  const exec = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }, (err, stdout, stderr) => {
    if (err && err.code === "ENOENT") reject(err); else resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
  }));
  const toasts = [];
  assert.deepEqual(await writeClipboard(TEXT, { exec, notify: (n) => toasts.push(n), platform }), { ok: true });
  assert.equal(await fs.readFile(out, "utf8"), TEXT);
  assert.deepEqual(toasts, []);
  for (const t of ["-n", "", "café café", "a\\b"]) {
    await writeClipboard(t, { exec, notify: (n) => toasts.push(n), platform });
    assert.equal(await fs.readFile(out, "utf8"), t);
  }
});

test("writeClipboard reports Copy Path failed when both ways fail", async () => {
  const bad = { write_to_clipboard: () => { throw new Error("no"); } };
  for (const exec of [async () => { throw new Error("boom"); }, async () => ({ code: 1, stdout: "", stderr: "" })]) {
    const toasts = [];
    const r = await writeClipboard("/srv/a b", { cx: bad, exec, notify: (n) => toasts.push(n), platform });
    assert.deepEqual(r, { ok: false, error: "Could not copy to the clipboard: /srv/a b" });
    assert.deepEqual(toasts, [{ title: "Copy Path failed", body: "Could not copy to the clipboard: /srv/a b", level: "error" }]);
  }
});
