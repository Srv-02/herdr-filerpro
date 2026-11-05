import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { openRegularFile, openChecked, afterDownload, OPEN_CHECK_SCRIPT } from "../mods/filer-pro/lib/open.js";
import { platform } from "../mods/filer-pro/lib/platform.js";
import { mkTmp } from "./tmp-helper.js";

const REPO = path.resolve(import.meta.dirname, "..");
const realExec = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, (err, stdout, stderr) => {
  if (err && err.code === "ENOENT") reject(err); else resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
}));

// The opener is a recorder script that writes its arguments (one per line) to a file; everything else runs for real.
async function setup() {
  const dir = await fs.realpath(await mkTmp("open-"));
  const recorder = `${dir}/record.sh`, log = `${dir}/opened.log`;
  await fs.writeFile(recorder, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${log}"; done\n`, { mode: 0o755 });
  const toasts = [];
  const deps = { exec: realExec, notify: (n) => toasts.push(n), platform: { openArgs: (p) => [recorder, [p]] } };
  const opened = async () => (await fs.readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
  return { dir, toasts, deps, opened };
}

test("a regular .html file is opened with its resolved path", async () => {
  const { dir, toasts, deps, opened } = await setup();
  await fs.writeFile(`${dir}/a.html`, "<p>x</p>");
  await fs.writeFile(`${dir}/B.HTM`, "<p>x</p>");
  await openRegularFile(`${dir}/a.html`, deps);
  await openRegularFile(`${dir}/B.HTM`, deps);
  assert.deepEqual(await opened(), [`${dir}/a.html`, `${dir}/B.HTM`]);
  assert.deepEqual(toasts, []);
});

test("a symlink to a .html is opened by its resolved target", async () => {
  const { dir, deps, opened } = await setup();
  await fs.writeFile(`${dir}/real.html`, "x");
  await fs.symlink(`${dir}/real.html`, `${dir}/link.html`);
  await openRegularFile(`${dir}/link.html`, deps);
  assert.deepEqual(await opened(), [`${dir}/real.html`]);
});

test("a file symlink to a .command or any other program is refused", async () => {
  const { dir, toasts, deps, opened } = await setup();
  await fs.writeFile(`${dir}/run.command`, "#!/bin/sh\n");
  await fs.symlink(`${dir}/run.command`, `${dir}/innocent.html`);
  await openRegularFile(`${dir}/innocent.html`, deps);
  assert.deepEqual(await opened(), []);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].title, "Open in browser");
  assert.equal(toasts[0].level, "warning");
});

test("a symlinked parent folder cannot smuggle in a .command, a .app or a .sh", async () => {
  const { dir, toasts, deps, opened } = await setup();
  await fs.mkdir(`${dir}/real`);
  for (const name of ["x.command", "y.sh", "z.app"]) await fs.writeFile(`${dir}/real/${name}`, "x");
  await fs.symlink(`${dir}/real`, `${dir}/folder`);
  for (const name of ["x.command", "y.sh", "z.app"]) await openRegularFile(`${dir}/folder/${name}`, deps);
  assert.deepEqual(await opened(), []);
  assert.equal(toasts.length, 3);
});

test("a .html inside a symlinked parent is opened as the resolved path", async () => {
  const { dir, deps, opened } = await setup();
  await fs.mkdir(`${dir}/real`);
  await fs.writeFile(`${dir}/real/p.html`, "x");
  await fs.symlink(`${dir}/real`, `${dir}/folder`);
  await openRegularFile(`${dir}/folder/p.html`, deps);
  assert.deepEqual(await opened(), [`${dir}/real/p.html`]);
});

test("a folder named .html, a missing file and a non-html extension are refused", async () => {
  const { dir, toasts, deps, opened } = await setup();
  await fs.mkdir(`${dir}/folder.html`);
  await fs.writeFile(`${dir}/notes.txt`, "x");
  for (const p of [`${dir}/folder.html`, `${dir}/missing.html`, `${dir}/notes.txt`]) await openRegularFile(p, deps);
  assert.deepEqual(await opened(), []);
  assert.equal(toasts.length, 3);
});

test("spaces, quotes and a leading dash are plain data", async () => {
  const { dir, deps, opened } = await setup();
  const weird = `${dir}/it's $(x) "a" b.html`, dash = `${dir}/-rf.html`;
  await fs.writeFile(weird, "x");
  await fs.writeFile(dash, "x");
  await openRegularFile(weird, deps);
  await openRegularFile(dash, deps);
  const here = process.cwd();
  process.chdir(dir);
  try { await openRegularFile("-rf.html", deps); } finally { process.chdir(here); }
  assert.deepEqual(await opened(), [weird, dash, dash]);
});

// Like setup(), with previewArgs and an opener that always fails.
async function setup2() {
  const s = await setup();
  const recorder = `${s.dir}/record.sh`, failing = `${s.dir}/fail.sh`;
  await fs.writeFile(failing, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  s.deps.platform = { openArgs: (p) => [recorder, [p]], previewArgs: (p) => [recorder, ["-a", "Preview", p]] };
  s.failDeps = { ...s.deps, platform: { openArgs: (p) => [failing, [p]], previewArgs: (p) => [failing, ["-a", "Preview", p]] } };
  return s;
}
const DEFAULT = { app: "default" }, PREVIEW = { app: "preview" };

test("openChecked: a regular .txt is opened with its resolved path and returns ok", async () => {
  const { dir, toasts, deps, opened } = await setup2();
  const a = `${dir}/a.txt`, b = `${dir}/B.TXT`;
  await fs.writeFile(a, "x");
  await fs.writeFile(b, "x");
  assert.deepEqual(await openChecked(a, DEFAULT, deps), { ok: true });
  assert.deepEqual(await openChecked(b, DEFAULT, deps), { ok: true });
  assert.deepEqual(await opened(), [a, b]);
  assert.deepEqual(toasts, []);
});

test("openChecked: preview hands -a Preview to the opener before the resolved path", async () => {
  const { dir, toasts, deps, opened } = await setup2();
  await fs.writeFile(`${dir}/p.pdf`, "x");
  await fs.symlink(`${dir}/p.pdf`, `${dir}/l.pdf`);
  assert.deepEqual(await openChecked(`${dir}/p.pdf`, PREVIEW, deps), { ok: true });
  assert.deepEqual(await opened(), ["-a", "Preview", `${dir}/p.pdf`]);
  assert.deepEqual(await openChecked(`${dir}/l.pdf`, PREVIEW, deps), { ok: true });
  assert.deepEqual((await opened()).slice(3), ["-a", "Preview", `${dir}/p.pdf`]);
  assert.deepEqual(toasts, []);
});

// Decision 2026-11-05: Open behaves like a double click in the Finder. No rule on extension or execute permission.
test("openChecked: any regular file opens like a double click, whatever its extension or execute permission", async () => {
  const { dir, toasts, deps, opened } = await setup2();
  const files = [];
  for (const [name, mode] of [["run.command", 0o644], ["S.SH", 0o755], ["tool", 0o755], ["x.xyz", 0o700], ["report.pdf", 0o700], ["go.webloc", 0o644]]) {
    const f = `${dir}/${name}`;
    await fs.writeFile(f, "x");
    await fs.chmod(f, mode);
    files.push(f);
    assert.deepEqual(await openChecked(f, DEFAULT, deps), { ok: true }, name);
  }
  assert.deepEqual(await openChecked(files[0], PREVIEW, deps), { ok: true });
  assert.deepEqual(await opened(), [...files, "-a", "Preview", files[0]]);
  assert.deepEqual(toasts, []);
});

test("openChecked: a link and a symlinked parent open the resolved path", async () => {
  const { dir, deps, opened } = await setup2();
  await fs.writeFile(`${dir}/b.command`, "x");
  await fs.symlink(`${dir}/b.command`, `${dir}/a.txt`);
  assert.deepEqual(await openChecked(`${dir}/a.txt`, DEFAULT, deps), { ok: true });
  await fs.mkdir(`${dir}/real`);
  await fs.writeFile(`${dir}/real/ok.txt`, "x");
  await fs.symlink(`${dir}/real`, `${dir}/folder`);
  assert.deepEqual(await openChecked(`${dir}/folder/ok.txt`, DEFAULT, deps), { ok: true });
  assert.deepEqual(await opened(), [`${dir}/b.command`, `${dir}/real/ok.txt`]);
});

test("afterDownload opens any downloaded regular file after the quarantine flag", async () => {
  const { dir, toasts, deps, opened } = await setup2();
  const d = { ...deps, platform: { ...deps.platform, quarantineArgs: () => ["true", []] } };
  const bin = `${dir}/dl`;
  await fs.writeFile(bin, "x");
  await fs.chmod(bin, 0o700);
  await afterDownload({ dest: bin, reveal: "open", direction: "down" }, d);
  await afterDownload({ dest: bin, reveal: "preview", direction: "down" }, d);
  assert.deepEqual(await opened(), [bin, "-a", "Preview", bin]);
  assert.deepEqual(toasts, []);
});

test("openChecked: a folder, an x.app folder, a missing file and a dangling link are refused with their own messages", async () => {
  const { dir, toasts, deps, opened } = await setup2();
  await fs.mkdir(`${dir}/d`);
  await fs.mkdir(`${dir}/x.app`);
  await fs.symlink(`${dir}/nothing`, `${dir}/gone`);
  for (const p of [`${dir}/d`, `${dir}/x.app`]) {
    assert.deepEqual(await openChecked(p, DEFAULT, deps), { ok: false, error: `Only files can be opened, not folders or app bundles: ${p}` });
  }
  for (const p of [`${dir}/missing.txt`, `${dir}/gone`]) {
    assert.deepEqual(await openChecked(p, DEFAULT, deps), { ok: false, error: `Cannot open: ${p} (not found)` });
  }
  assert.deepEqual(await opened(), []);
  assert.equal(toasts.length, 4);
});

test("openChecked: spaces, quotes, $(x), Unicode NFC and NFD and a leading dash are plain data", async () => {
  const { dir, toasts, deps, opened } = await setup2();
  const weird = `${dir}/it's $(x) "a" b.txt`, dash = `${dir}/-rf.txt`;
  await fs.writeFile(weird, "x");
  await fs.writeFile(dash, "x");
  await openChecked(weird, DEFAULT, deps);
  await openChecked(dash, DEFAULT, deps);
  const here = process.cwd();
  process.chdir(dir);
  try { await openChecked("-rf.txt", DEFAULT, deps); } finally { process.chdir(here); }
  assert.deepEqual(await opened(), [weird, dash, dash]);
  const nfc = `${dir}/caf\u00e9.txt`, nfd = `${dir}/cafe\u0301.txt`;
  await fs.writeFile(nfc, "x");
  await fs.writeFile(nfd, "x");
  await openChecked(nfc, DEFAULT, deps);
  await openChecked(nfd, DEFAULT, deps);
  const got = (await opened()).slice(3);
  assert.equal(got.length, 2);
  for (const e of got) assert.equal(e.normalize("NFC"), nfc);
  assert.deepEqual(toasts, []);
});

test("openChecked: a failing opener gives Could not open", async () => {
  const s = await setup2();
  const f = `${s.dir}/ok.txt`;
  await fs.writeFile(f, "x");
  const error = `Could not open: ${f}`;
  assert.deepEqual(await openChecked(f, DEFAULT, s.failDeps), { ok: false, error });
  assert.deepEqual(s.toasts, [{ title: "Open", body: error, level: "warning" }]);
  const throwing = { ...s.deps, exec: async () => { throw new Error("boom"); } };
  assert.deepEqual(await openChecked(f, DEFAULT, throwing), { ok: false, error });
});

test("OPEN_CHECK_SCRIPT only resolves the path and requires an existing regular file", () => {
  for (const part of ["realpath --", '[ -e "$real" ]', '[ -f "$real" ]', 'exec "$@" "$real"']) assert.ok(OPEN_CHECK_SCRIPT.includes(part), part);
  for (const part of ["[ -x", "exit 5", "exit 6", "case"]) assert.equal(OPEN_CHECK_SCRIPT.includes(part), false, part);
});

test("Preview.app exists where open -a Preview finds it (macOS)", async (t) => {
  if (process.platform !== "darwin") return t.skip("macOS only");
  await fs.access("/System/Applications/Preview.app"); // no app is started
});

const QDEST = "/Users/me/Downloads/a.pdf";
const NOW = 0x69c0f0a0 * 1000 + 999;
const XATTR = ["xattr", ["-w", "com.apple.quarantine", "0081;69c0f0a0;Filer Pro;", QDEST]];
const okExec = (calls) => async (cmd, args) => { calls.push([cmd, args]); return { code: 0, stdout: "", stderr: "" }; };

test("afterDownload: reveal true reveals, open and preview run the check script with the right opener, nothing else runs", async () => {
  const calls = [];
  const deps = { exec: okExec(calls), notify: () => {}, platform, now: () => NOW };
  const job = (reveal) => ({ dest: QDEST, reveal, direction: "down" });
  await afterDownload(job(true), deps);
  await afterDownload(job("open"), deps);
  await afterDownload(job("preview"), deps);
  assert.deepEqual(calls, [
    ["open", ["-R", QDEST]],
    XATTR,
    ["sh", ["-c", OPEN_CHECK_SCRIPT, "sh", QDEST, "open"]],
    XATTR,
    ["sh", ["-c", OPEN_CHECK_SCRIPT, "sh", QDEST, "open", "-a", "Preview"]],
  ]);
  // a rejecting exec never rejects afterDownload
  await afterDownload(job(true), { ...deps, exec: async () => { throw new Error("boom"); } });
  await afterDownload(job("open"), { ...deps, exec: async () => { throw new Error("boom"); } });
});

test("afterDownload marks the download as quarantined before it opens it", async () => {
  const calls = [];
  await afterDownload({ dest: QDEST, reveal: "open", direction: "down" }, { exec: okExec(calls), notify: () => {}, platform, now: () => NOW });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], XATTR);
  assert.deepEqual(calls[1], ["sh", ["-c", OPEN_CHECK_SCRIPT, "sh", QDEST, "open"]]);
});

test("afterDownload does not open when the quarantine flag cannot be set", async () => {
  for (const reveal of ["open", "preview"]) {
    for (const failing of [async () => ({ code: 1, stdout: "", stderr: "x" }), async () => { throw new Error("boom"); }]) {
      const calls = [], toasts = [];
      const exec = async (cmd, args) => { calls.push([cmd, args]); return failing(); };
      await afterDownload({ dest: QDEST, reveal, direction: "down" }, { exec, notify: (n) => toasts.push(n), platform, now: () => NOW });
      assert.deepEqual(calls, [XATTR]);
      assert.deepEqual(toasts, [{
        title: reveal === "preview" ? "Open in Preview" : "Open",
        body: `Not opened, the download could not be marked as downloaded (quarantine): ${QDEST}`,
        level: "warning",
      }]);
    }
  }
});

test("afterDownload reveal true runs no xattr", async () => {
  const calls = [];
  await afterDownload({ dest: QDEST, reveal: true, direction: "down" }, { exec: okExec(calls), notify: () => {}, platform, now: () => NOW });
  assert.deepEqual(calls, [["open", ["-R", QDEST]]]);
});

test("afterDownload sets no quarantine flag on a local copy (cp -P keeps links, xattr would mark the original)", async () => {
  for (const reveal of ["open", "preview"]) {
    const calls = [];
    await afterDownload({ dest: QDEST, reveal, direction: "local" }, { exec: okExec(calls), notify: () => {}, platform, now: () => NOW });
    assert.deepEqual(calls, [["sh", ["-c", OPEN_CHECK_SCRIPT, "sh", QDEST, "open", ...(reveal === "preview" ? ["-a", "Preview"] : [])]]]);
  }
});
