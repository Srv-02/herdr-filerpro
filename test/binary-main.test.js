// Issues #32 and #33: what the viewer says for a file that is not shown as text, and what a click on a binary file
// does. main.js is loaded with stubbed host modules (as in test/bundles-main.test.js); the host is test/fake/herdr.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { LIST_SCRIPT } from "../mods/filer-pro/lib/tree.js";
import { numbers } from "../mods/filer-pro/lib/settings.js";
import { OPEN_CHECK_SCRIPT } from "../mods/filer-pro/lib/open.js";
import { PROBE_SCRIPT, READ_SCRIPT } from "../mods/filer-pro/lib/textedit.js";
import { SIZE_SCRIPT } from "../mods/filer-pro/lib/sizes.js";
import { isBinaryName, looksUtf16Text, BINARY_MESSAGE } from "../mods/filer-pro/lib/binary.js";
import { createFake } from "./fake/herdr.js";

globalThis.__make = (kind) => {
  const node = { kind, calls: [], kids: [] };
  const el = new Proxy(node, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop !== "string" || prop === "then") return undefined;
      return (...args) => {
        if (prop === "when") return args[0] ? args[1](el) : el;
        if (prop === "child") { if (args[0] != null) target.kids.push(args[0]); }
        else if (prop === "children") target.kids.push(...args[0].filter((x) => x != null));
        target.calls.push([prop, ...args]);
        return el;
      };
    },
  });
  return el;
};
const stub = (names) => names.map((n) => `export const ${n} = (...a) => globalThis.__impl.${n}(...a);`).join("\n");
const make = (names) => names.map((n) => `export const ${n} = (...a) => { const e = globalThis.__make("${n}"); e.args = a; return e; };`).join("\n");
const STUBS = {
  herdr: stub(["spaces", "panes", "focused", "exec", "hc", "readTextFile", "writeTextFile", "watchFolder", "theme", "settings", "window", "shared", "setShared", "notify", "props", "appHome", "home", "nextCommand", "openOverlay", "closeOverlay", "pickFolder", "run", "layout"]),
  "gpui-kit": `export class View {}; ${make(["div", "svg", "image"])}`,
  "gpui-base": `${make(["v_flex", "h_flex", "TextView"])} export const Input = { new: () => globalThis.__make("input") }, Scrollbar = { vertical: () => globalThis.__make("scrollbar") };
export class Editor { static new() { return globalThis.__make("editor"); } } export class EditorState { static new(o) { return { release() {}, opts: o, on() { return true; } }; } } export class InputState {}`,
  "fs/promises": `${stub(["exists"])} export const readFile = async () => "", writeFile = async () => {}, mkdir = readFile, unlink = readFile, stat = readFile;`,
};
const hooks = `export async function resolve(s, c, next) { return s in ${JSON.stringify(STUBS)} ? { url: "stub:" + s, shortCircuit: true } : next(s, c); }
export async function load(u, c, next) { return u.startsWith("stub:") ? { format: "module", shortCircuit: true, source: ${JSON.stringify(STUBS)}[u.slice(5)] } : next(u, c); }`;
register("data:text/javascript," + encodeURIComponent(hooks));
const FilerPro = (await import("../mods/filer-pro/main.js")).default;

const never = () => new Promise(() => {});
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
const DEFAULTS = { ...numbers(null), node_path: "", svg_check: true, double_click_files: false, double_click_apps: true };
const ROOT = "/Users/example/Downloads";
const NAMES = ["a.zip", "report.docx", "setup.pkg", "big.log", "latin.txt", "wide.txt", "blob.dat", "ok.txt", "gone.txt"];
const LISTING = NAMES.flatMap((n) => ["f", n]).join("\0") + "\0";
const MiB = 1048576;

// One fake host: a local space at ROOT, or the machine "box". Everything the panel runs is recorded in the fake.
function host({ machine = null } = {}) {
  const f = createFake({ files: {}, store: {} });
  globalThis.__impl = {
    props: () => ({}), appHome: () => "/app", home: () => "/Users/example", window: () => ({ platform: "macos" }),
    theme: () => new Proxy({}, { get: (_t, k) => String(k) }), settings: () => ({ dark: true, font_family: "mono" }),
    spaces: () => [{ active: true, id: "s1", folder: ROOT, machine }], panes: () => [], focused: () => ({}),
    shared: f.getShared, setShared: f.setShared, readTextFile: f.readTextFile, writeTextFile: async () => {},
    exec: async (cmd, args, opts) => {
      if (cmd === "sh" && args[1] === LIST_SCRIPT) { f.execCalls.push({ cmd, args, on: opts?.on ?? null }); return { code: 0, stdout: args[3] === ROOT ? LISTING : "", stderr: "" }; }
      return f.exec(cmd, args, opts);
    },
    hc: f.hc, openOverlay: () => "ov1", closeOverlay: () => {}, notify: f.notify,
    watchFolder: never, nextCommand: never, layout: () => ({}), pickFolder: async () => null, run: () => {}, exists: async () => false,
  };
  return f;
}
function fakeCx() {
  const cx = { notify() {}, sleep: never, stop_propagation() { cx.stopped = (cx.stopped ?? 0) + 1; }, spawn: (fn) => { const p = Promise.resolve().then(() => fn(cx)); p.catch(() => {}); return p; }, timer: { after: (ms, fn) => { if (ms === 0) setImmediate(() => fn(cx)); }, every() {} } };
  return cx;
}
async function loaded(cx, cfg = {}) {
  const self = Object.assign(Object.create(FilerPro.prototype), { cfg: { ...DEFAULTS, ...cfg }, saved: new Map(), reload: { signal: () => false, take: () => false }, jobs: {}, perf: null });
  self.refresh(cx);
  await settle();
  return self;
}
function* walk(e) {
  if (!e || typeof e !== "object") return;
  yield e;
  for (const k of e.kids ?? []) yield* walk(k);
}
const idOf = (el) => el.calls?.find((c) => c[0] === "id")?.[1];
const byId = (root, id) => [...walk(root)].find((e) => idOf(e) === id);
const handler = (el, name) => el.calls.find(([k]) => k === name).at(-1);
const texts = (root) => [...walk(root)].flatMap((e) => (e.kids ?? []).filter((k) => typeof k === "string"));
const scriptRuns = (f, script) => f.execCalls.filter((c) => c.cmd === "sh" && c.args[1] === script);
const fileReads = (f) => f.reads.filter((p) => p !== "/app/filer-pro.json");
const readOut = (bytes, link = "n") => `file y 644 ${bytes.length} n ${link}\n${Buffer.from(bytes).toString("base64")}\n`;
const click = (self, cx, name, n) => handler(byId(self.render(cx), `file-${name}`), "on_click")({ modifiers: {}, click_count: n }, cx);
const shownMessage = (self, cx) => texts(self.render(cx));

// ---- #32: the reason instead of the catch-all

test("#32: a text file over 1 MiB names the limit and its size, locally, with one bounded read after the failed read", async () => {
  const f = host(); const cx = fakeCx(); const self = await loaded(cx);
  const p = `${ROOT}/big.log`;
  f.readErrors[p] = new Error("Text file exceeds 1 MiB");
  f.readOuts[p] = `file y 644 3400000 n n\n`;
  self.show("big.log", cx);
  await settle();
  assert.equal(self.fileError, "File larger than 1 MiB (3.4 MB)");
  assert.notEqual(self.fileError, "Cannot preview this file (binary, too large, or unreadable)");
  assert.equal(scriptRuns(f, READ_SCRIPT).length, 1, "one bounded read, after the failure");
  assert.equal(scriptRuns(f, READ_SCRIPT)[0].on, null, "locally, no SSH");
  assert.equal(scriptRuns(f, PROBE_SCRIPT).length, 0);
  assert.deepEqual(f.reads.filter((r) => r === p), [p], "the file is read once");
  assert.equal(self.openable, false, "no Open button for a large text file");
});

test("#39: on a machine a file over 1 MiB costs one bounded exec there, no readTextFile and no content", async () => {
  const f = host({ machine: "box" }); const cx = fakeCx(); const self = await loaded(cx);
  const p = `${ROOT}/big.log`;
  f.readOuts[p] = `file y 644 ${5 * MiB} n n\n`;
  const before = f.execCalls.length;
  self.show("big.log", cx);
  await settle();
  assert.equal(self.fileError, "File larger than 1 MiB (5.2 MB)");
  assert.deepEqual(f.execCalls.slice(before).map((c) => [c.args[1] === READ_SCRIPT, c.on]), [[true, "box"]], "exactly one exec");
  assert.deepEqual(fileReads(f), [], "herdr's readTextFile (a full cat) never runs on a machine");
});

test("#32: a normal preview adds no lookup of its own (only the edit check's probe from #22 runs; the size script never)", async () => {
  const f = host(); const cx = fakeCx(); const self = await loaded(cx);
  f.files[`${ROOT}/ok.txt`] = "hello\n";
  self.show("ok.txt", cx);
  await settle();
  assert.equal(self.fileError, null);
  assert.equal(scriptRuns(f, PROBE_SCRIPT).length, 1, "the edit check, as before");
  assert.equal(scriptRuns(f, SIZE_SCRIPT).length, 0);
});

test("#32: a link to a large file is sized through the link (READ_SCRIPT follows it)", async () => {
  const f = host(); const cx = fakeCx(); const self = await loaded(cx);
  const p = `${ROOT}/big.log`;
  f.readErrors[p] = new Error("Text file exceeds 1 MiB");
  f.readOuts[p] = `file y 644 ${2 * MiB} n y\n`;
  self.show("big.log", cx);
  await settle();
  assert.equal(self.fileError, "File larger than 1 MiB (2.1 MB)");
  assert.equal(scriptRuns(f, SIZE_SCRIPT).length, 0, "no second exec for the size");
});

test("#39: a local Latin-1 file is shown with U+FFFD, Edit refused with the reason, one local exec", async () => {
  const f = host(); const cx = fakeCx(); const self = await loaded(cx);
  const p = `${ROOT}/latin.txt`;
  f.readErrors[p] = new Error("stream did not contain valid UTF-8");
  f.readOuts[p] = readOut([0x63, 0x61, 0x66, 0xe9, 0x0a]);
  const before = f.execCalls.length;
  self.show("latin.txt", cx);
  await settle();
  assert.equal(self.fileError, null);
  assert.equal(self.shownText, "caf\ufffd\n");
  assert.equal(self.code.opts.value, "caf\ufffd\n");
  assert.deepEqual(self.editCheck, { state: "refused", reason: "Not UTF-8 (Latin-1 or other), use Edit in Terminal" });
  assert.deepEqual(f.execCalls.slice(before).map((c) => [c.args[1] === READ_SCRIPT, c.on]), [[true, null]], "one local exec, no probe");
});

test("#39: a Latin-1 file on a machine is shown with U+FFFD in one exec, Edit refused", async () => {
  const f = host({ machine: "box" }); const cx = fakeCx(); const self = await loaded(cx);
  f.readOuts[`${ROOT}/latin.txt`] = readOut(Buffer.from("Gr\xfc\xdfe\n", "latin1"));
  const before = f.execCalls.length;
  self.show("latin.txt", cx);
  await settle();
  assert.equal(self.shownText, "Gr\ufffd\ufffde\n");
  assert.equal(self.editCheck.reason, "Not UTF-8 (Latin-1 or other), use Edit in Terminal");
  assert.equal(f.execCalls.length - before, 1);
  assert.deepEqual(fileReads(f), []);
});

test("#32: a UTF-16 file (BOM, rejected by the read) says UTF-16", async () => {
  const f = host(); const cx = fakeCx(); const self = await loaded(cx);
  const p = `${ROOT}/wide.txt`;
  f.readErrors[p] = new Error("stream did not contain valid UTF-8");
  f.readOuts[p] = readOut([0xff, 0xfe, 0x68, 0, 0x69, 0, 0x0a, 0]);
  self.show("wide.txt", cx);
  await settle();
  assert.equal(self.fileError, "UTF-16 file · use Open or Edit in Terminal");
});

test("#32: UTF-16 without a BOM is valid UTF-8 for the read (NULs): it says UTF-16 without any extra exec", async () => {
  const f = host(); const cx = fakeCx(); const self = await loaded(cx);
  f.files[`${ROOT}/wide.txt`] = "h\0i\0 \0t\0e\0x\0t\0";
  const before = f.execCalls.length;
  self.show("wide.txt", cx);
  await settle();
  assert.equal(self.fileError, "UTF-16 file · use Open or Edit in Terminal");
  assert.equal(f.execCalls.length, before, "no exec");
  assert.equal(looksUtf16Text("��h\0i\0"), true, "a machine returns the BOM as replacement characters");
  assert.equal(looksUtf16Text("PK\u0003\u0004\0\0\0\0abc"), false);
});

test("#32: a failed read of a file that is gone, a folder or an unprobeable file gets its own reason, not the old catch-all", async () => {
  for (const [out, want] of [["missing\n", "This file is no longer available"], ["dir\n", "Not a regular file"], ["", "Cannot read this file"]]) {
    const f = host(); const cx = fakeCx(); const self = await loaded(cx);
    const p = `${ROOT}/gone.txt`;
    f.readErrors[p] = new Error("os error");
    f.readOuts[p] = out;
    self.show("gone.txt", cx);
    await settle();
    assert.equal(self.fileError, want);
  }
});

test("#39: on a machine an unreadable file names the reason, a missing one is no longer available (one exec each)", async () => {
  for (const [out, want] of [["unreadable n 200 5 n n\n", "No read permission · cannot show this file"], ["missing\n", "This file is no longer available"],
    [{ code: 1, stderr: "sh: /x: Input/output error\n" }, "Cannot read this file: sh: /x: Input/output error"]]) {
    const f = host({ machine: "box" }); const cx = fakeCx(); const self = await loaded(cx);
    f.readOuts[`${ROOT}/gone.txt`] = out;
    const before = f.execCalls.length;
    self.show("gone.txt", cx);
    await settle();
    assert.equal(self.fileError, want);
    assert.equal(f.execCalls.length - before, 1);
  }
});

test("#39: on a machine a small text file costs one exec: shown and edit-checked from the same bytes", async () => {
  const f = host({ machine: "box" }); const cx = fakeCx(); const self = await loaded(cx);
  f.readOuts[`${ROOT}/ok.txt`] = readOut(Buffer.from("hello\r\n"));
  const before = f.execCalls.length;
  self.show("ok.txt", cx);
  await settle();
  assert.equal(self.fileError, null);
  assert.equal(self.shownText, "hello\r\n");
  assert.equal(self.editCheck.state, "ok");
  assert.equal(self.editCheck.info.eol, "CRLF");
  assert.deepEqual(f.execCalls.slice(before).map((c) => [c.args[1] === READ_SCRIPT, c.on]), [[true, "box"]]);
  assert.deepEqual(fileReads(f), []);
});

test("#39: on a machine a symbolic link to a text file is shown through the link, Edit refused", async () => {
  const f = host({ machine: "box" }); const cx = fakeCx(); const self = await loaded(cx);
  f.readOuts[`${ROOT}/ok.txt`] = readOut(Buffer.from("via link\n"), "y");
  self.show("ok.txt", cx);
  await settle();
  assert.equal(self.shownText, "via link\n");
  assert.deepEqual(self.editCheck, { state: "refused", reason: "Symbolic link" });
});

test("#39: a read the runtime interrupts never leaves Loading file…", async () => {
  const f = host({ machine: "box" }); const cx = fakeCx(); const self = await loaded(cx);
  f.readOuts[`${ROOT}/ok.txt`] = readOut(Buffer.from("x\n"));
  self.readGuarded = (full, on, cfg, cx) => new Promise((done) => {
    // what readFileGuarded's guard delivers when the job that parses is interrupted
    cx.timer.after(0, () => done({ ok: false, message: "Could not check this file", binary: false }));
  });
  let state = null;
  self.show("ok.txt", cx, { onDone: (s) => { state = s; } });
  await settle();
  assert.equal(self.fileError, "Could not check this file");
  assert.equal(state.error, "Could not check this file");
  assert.ok(!shownMessage(self, cx).includes("Loading file…"));
});

test("#32: an error that is not the read (here the editor) is not blamed on the file's type", async () => {
  const f = host(); const cx = fakeCx(); const self = await loaded(cx);
  f.files[`${ROOT}/ok.txt`] = "hello\n";
  self.editorOptions = () => { throw new Error("editor broke"); };
  self.show("ok.txt", cx);
  await settle();
  assert.equal(self.fileError, "Cannot show this file: editor broke");
});

// ---- #33: binary files

test("#33: known binary extensions are archives and Office/ODF documents, not installers or programs", () => {
  for (const n of ["a.zip", "a.TAR.GZ", "x.tgz", "x.7z", "x.rar", "x.bz2", "x.xz", "r.docx", "r.xlsx", "r.pptx", "r.odt", "r.ods", "r.odp", "old.doc"]) assert.equal(isBinaryName(n), true, n);
  for (const n of ["a.pkg", "a.dmg", "a.exe", "a.txt", "zip", "a.png", "a.pdf", "Makefile"]) assert.equal(isBinaryName(n), false, n);
});

test("#33: a local ZIP click shows the message with an Open button and never reads the file", async () => {
  const f = host(); const cx = fakeCx(); const self = await loaded(cx);
  click(self, cx, "a.zip", 1);
  await settle();
  assert.deepEqual(fileReads(f), [], "no readTextFile of the file");
  assert.equal(self.fileError, BINARY_MESSAGE);
  const tree = self.render(cx);
  assert.ok(texts(tree).includes(BINARY_MESSAGE));
  assert.ok(byId(tree, "files-open-binary"), "Open button");
  assert.equal(scriptRuns(f, OPEN_CHECK_SCRIPT).length, 0, "a single click starts nothing");
  handler(byId(tree, "files-open-binary"), "on_click")({ modifiers: {} }, cx);
  await settle();
  const runs = scriptRuns(f, OPEN_CHECK_SCRIPT);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].args[3], `${ROOT}/a.zip`);
  assert.equal(runs[0].on, null);
});

test("#33: double_click_apps on: a single click shows, a double click starts the default app once (via the viewer or the row)", async () => {
  const f = host(); const cx = fakeCx(); const self = await loaded(cx);
  click(self, cx, "report.docx", 1);
  await settle();
  assert.equal(self.file, "report.docx");
  // the first click replaced the tree by the viewer: the second click lands there
  handler(byId(self.render(cx), "files-binary"), "on_click")({ modifiers: {}, click_count: 2 }, cx);
  await settle();
  assert.equal(scriptRuns(f, OPEN_CHECK_SCRIPT).length, 1);
  handler(byId(self.render(cx), "files-binary"), "on_click")({ modifiers: {}, click_count: 3 }, cx);
  await settle();
  assert.equal(scriptRuns(f, OPEN_CHECK_SCRIPT).length, 1, "a third press does nothing");
  // the second click reaching the row (the tree was still drawn)
  self.show(null);
  click(self, cx, "report.docx", 2);
  await settle();
  assert.equal(scriptRuns(f, OPEN_CHECK_SCRIPT).length, 2);
  assert.equal(self.file, null, "the row's double click opens the app, no viewer");
  assert.deepEqual(fileReads(f), []);
});

test("#33: double_click_apps off: a single click starts the default app at once", async () => {
  const f = host(); const cx = fakeCx(); const self = await loaded(cx, { double_click_apps: false });
  click(self, cx, "a.zip", 1);
  await settle();
  assert.equal(scriptRuns(f, OPEN_CHECK_SCRIPT).length, 1);
  assert.equal(self.file, null);
  assert.equal(self.lastOpened, "a.zip");
  assert.deepEqual(fileReads(f), []);
  // and a double click opens once, not twice
  click(self, cx, "a.zip", 2);
  await settle();
  assert.equal(scriptRuns(f, OPEN_CHECK_SCRIPT).length, 1);
});

test("#33: the double_click_files setting does not decide for binary files, double_click_apps does", async () => {
  for (const files of [false, true]) {
    const f = host(); const cx = fakeCx(); const self = await loaded(cx, { double_click_files: files, double_click_apps: false });
    click(self, cx, "a.zip", 1);
    await settle();
    assert.equal(scriptRuns(f, OPEN_CHECK_SCRIPT).length, 1, `files ${files}`);
  }
});

test("#33: a file that turns out binary after the read shows the message with Open (local) and an installer is not in the list", async () => {
  const f = host(); const cx = fakeCx(); const self = await loaded(cx);
  f.files[`${ROOT}/blob.dat`] = "ELF\0\u0001\u0002";
  f.files[`${ROOT}/setup.pkg`] = "xar!\0\0";
  self.show("blob.dat", cx);
  await settle();
  assert.equal(self.fileError, BINARY_MESSAGE);
  assert.equal(self.openable, true);
  assert.ok(byId(self.render(cx), "files-open-binary"));
  self.show("setup.pkg", cx);
  await settle();
  assert.ok(fileReads(f).includes(`${ROOT}/setup.pkg`), "a .pkg is read first, then reported binary");
  assert.equal(self.fileError, BINARY_MESSAGE);
  assert.equal(scriptRuns(f, OPEN_CHECK_SCRIPT).length, 0);
});

test("#33 remote: a click on a ZIP never reads, downloads or opens anything, for every click setting", async () => {
  for (const files of [false, true]) for (const apps of [false, true]) for (const n of [1, 2]) {
    const f = host({ machine: "box" }); const cx = fakeCx(); const self = await loaded(cx, { double_click_files: files, double_click_apps: apps });
    const execsBefore = f.execCalls.length;
    click(self, cx, "a.zip", n);
    await settle();
    const tag = `files ${files} apps ${apps} click ${n}`;
    assert.deepEqual(fileReads(f), [], tag);
    assert.equal(f.execCalls.length, execsBefore, `${tag}: no exec at all`);
    assert.deepEqual(f.hcCalls.filter((a) => a[0] === "run"), [], `${tag}: no transfer`);
    assert.deepEqual(f.jobs(), {}, `${tag}: no job`);
    assert.equal(f.store["filer-pro.request"] ?? null, null, `${tag}: no request`);
    assert.equal(scriptRuns(f, OPEN_CHECK_SCRIPT).length, 0, tag);
    if (self.file) {
      assert.equal(self.fileError, BINARY_MESSAGE, tag);
      assert.equal(byId(self.render(cx), "files-open-binary"), undefined, `${tag}: no Open button`);
      assert.equal(byId(self.render(cx), "files-binary"), undefined, `${tag}: no launching view`);
    }
  }
});

test("#33 remote: a double click on the shown message (or its first press) cannot open anything, and openBinary refuses", async () => {
  const f = host({ machine: "box" }); const cx = fakeCx(); const self = await loaded(cx, { double_click_files: true });
  click(self, cx, "a.zip", 1);
  click(self, cx, "a.zip", 2);
  await settle();
  assert.equal(self.file, "a.zip");
  self.openBinary("a.zip");
  self.openable = true; // even a wrongly set flag opens nothing on a machine
  self.openBinary("a.zip");
  await settle();
  assert.equal(scriptRuns(f, OPEN_CHECK_SCRIPT).length, 0);
  assert.deepEqual(f.hcCalls.filter((a) => a[0] === "run"), []);
});

test("#33 remote: a file that turns out binary after the read shows the message without an Open button", async () => {
  const f = host({ machine: "box" }); const cx = fakeCx(); const self = await loaded(cx);
  f.readOuts[`${ROOT}/blob.dat`] = readOut(Buffer.from("ELF\0\u0001"));
  self.show("blob.dat", cx);
  await settle();
  assert.equal(self.fileError, BINARY_MESSAGE);
  assert.equal(self.openable, false);
  assert.equal(byId(self.render(cx), "files-open-binary"), undefined);
});

test("#33: an agent request open on a binary file answers with the message and starts no app, locally and on a machine", async () => {
  for (const machine of [null, "box"]) {
    const f = host({ machine }); const cx = fakeCx(); const self = await loaded(cx);
    f.store["filer-pro.show"] = { id: "r1", action: "open", path: `${ROOT}/a.zip`, on: machine };
    self.checkShow(cx);
    await settle();
    const ans = f.store["filer-pro.shown"];
    assert.equal(ans.hit, true);
    assert.equal(ans.result.ok, false);
    assert.equal(ans.result.error, BINARY_MESSAGE);
    assert.equal(scriptRuns(f, OPEN_CHECK_SCRIPT).length, 0, `machine ${machine}`);
    assert.deepEqual(fileReads(f), []);
  }
});

test("#33: restoring the last file of a context (show without a click) on a ZIP starts nothing", async () => {
  const f = host(); const cx = fakeCx(); const self = await loaded(cx);
  self.show("a.zip", cx);
  await settle();
  assert.equal(self.fileError, BINARY_MESSAGE);
  assert.equal(scriptRuns(f, OPEN_CHECK_SCRIPT).length, 0);
});

test("#33 remote: Cmd+click downloads a normal file for the Finder, but never a known binary file (the only click path that transferred)", async () => {
  const f = host({ machine: "box" }); const cx = fakeCx(); const self = await loaded(cx, { double_click_files: true });
  const requests = []; self.request = async (r) => { requests.push(r); };
  const cmd = (name) => handler(byId(self.render(cx), `file-${name}`), "on_click")({ modifiers: { platform: true }, click_count: 1 }, cx);
  cmd("a.zip");
  cmd("report.docx");
  await settle();
  assert.deepEqual(requests, [], "no download request for a binary extension");
  assert.deepEqual(f.hcCalls.filter((a) => a[0] === "run"), []);
  assert.equal(scriptRuns(f, OPEN_CHECK_SCRIPT).length, 0);
  cmd("ok.txt");
  assert.equal(requests[0]?.reveal, true, "the Finder reveal of other files is unchanged");
});

// ---- #49: a folder or file the user may not reach is not "empty" or "gone"

test("#49: a folder that cannot be listed shows a note row, not nothing; the root shows the message", async () => {
  host(); const cx = fakeCx();
  const inner = globalThis.__impl.exec;
  globalThis.__impl.exec = async (cmd, args, opts) => (cmd === "sh" && args[1] === LIST_SCRIPT && args[3] === `${ROOT}/locked` ? { code: 3, stdout: "", stderr: "" } : inner(cmd, args, opts));
  const self = await loaded(cx);
  self.entries.set("", [{ name: "locked", dir: true }]);
  self.toggle("locked", cx);
  await settle();
  assert.equal(self.error, null, "not an error toast");
  assert.ok(self.folders.has("locked"), "the folder stays open");
  assert.deepEqual(self.visible().map((r) => r.entry.name), ["locked", "No permission to list this folder"]);
  assert.ok(texts(self.render(cx)).includes("No permission to list this folder"));
  // The root itself.
  globalThis.__impl.exec = async (cmd, args, opts) => (cmd === "sh" && args[1] === LIST_SCRIPT ? { code: 3, stdout: "", stderr: "" } : inner(cmd, args, opts));
  const root = await loaded(cx);
  assert.ok(texts(root.render(cx)).includes("No permission to list this folder"));
});

test("#49: a file below an unsearchable folder says so (local: readTextFile gave null), a deleted one stays 'no longer available'", async () => {
  const f = host(); const cx = fakeCx(); const self = await loaded(cx);
  f.readOuts[`${ROOT}/gone.txt`] = "noaccess\n";
  self.show("gone.txt", cx);
  await settle();
  assert.equal(self.fileError, "No search permission on its folder · cannot show this file");
  self.show("ok.txt", cx);
  await settle();
  self.show("blob.dat", cx);
  await settle();
  assert.equal(self.fileError, "This file is no longer available", "readOuts defaults to missing");
});
