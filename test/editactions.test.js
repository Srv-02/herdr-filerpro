import { test } from "node:test";
import assert from "node:assert/strict";
import { editInTerminal, openInEditor } from "../mods/filer-pro/lib/editors.js";

const cfg = (over = {}) => async () => ({ terminal_editor: "vi", terminal_editors: [], gui_editor: "VS Code", gui_editors: [], ...over });
const MACHINES = JSON.stringify({ machines: [{ name: "box", target: "me@box" }, { name: "jump", via: "kubectl exec" }] });

function deps(over = {}) {
  const log = { runs: [], execs: [], notes: [], hcs: [] };
  const d = {
    loadConfig: cfg(), home: () => "/Users/u",
    focused: () => ({ pane: "p1" }), spaces: () => [{ id: "s1", active: true, machine: null }, { id: "s2", active: false, machine: "box" }],
    run: async (cmd, args) => { log.runs.push([cmd, args]); },
    exec: async (cmd, args, opts) => { log.execs.push([cmd, args, opts]); return { code: 0, stdout: "", stderr: "" }; },
    hc: async (args) => { log.hcs.push(args); return { code: 0, stdout: MACHINES, stderr: "" }; },
    notify: (n) => log.notes.push(n),
    ...over,
  };
  return { d, log };
}

test("editInTerminal: local file splits right with the configured editor in the file's folder", async () => {
  const { d, log } = deps({ loadConfig: cfg({ terminal_editor: "nvim", terminal_editors: [{ name: "nvim", command: "nvim -u NONE" }] }) });
  await editInTerminal({ machine: null, path: "/srv/a $b.txt" }, d);
  assert.deepEqual(log.runs, [["terminal.open", { argv: ["nvim", "-u", "NONE", "/srv/a $b.txt"], folder: "/srv", place: "right" }]]);
  assert.deepEqual(log.notes, []);
});

test("editInTerminal: a failing split (throwing or rejecting) falls back to a new tab without an error toast", async () => {
  for (const fail of [() => { throw new Error("no pane"); }, async () => { throw new Error("no pane"); }]) {
    const { d, log } = deps();
    d.run = (cmd, args) => { log.runs.push(cmd); return cmd === "terminal.open" ? fail() : undefined; };
    await editInTerminal({ machine: null, path: "/srv/x" }, d);
    assert.deepEqual(log.runs, ["terminal.open", "tab.new"]);
    assert.deepEqual(log.notes, []);
  }
});

test("editInTerminal: when every host command fails, one error notice with the last error", async () => {
  const { d, log } = deps({ run: async (cmd) => { throw new Error(`${cmd} broke`); } });
  await editInTerminal({ machine: null, path: "/srv/x" }, d);
  assert.deepEqual(log.notes, [{ title: "Edit in Terminal failed", body: "tab.new broke", level: "error" }]);
});

test("editInTerminal: no safe place on the file's machine gives an info notice, nothing runs", async () => {
  const { d, log } = deps();
  await editInTerminal({ machine: "box", path: "/home/me/x" }, d);
  assert.deepEqual(log.runs, []);
  assert.deepEqual(log.notes, [{ title: "Edit in Terminal", body: "Switch to a space on box to edit this file there.", level: "info" }]);
  const local = deps({ spaces: () => [{ id: "s2", active: true, machine: "box" }] });
  await editInTerminal({ machine: null, path: "/x" }, local.d);
  assert.equal(local.log.notes[0].body, "Switch to a space on this computer to edit this file there.");
});

test("editInTerminal: no editor binary check (no exec, no hc)", async () => {
  const { d, log } = deps({ spaces: () => [{ id: "s2", active: true, machine: "box" }] });
  await editInTerminal({ machine: "box", path: "/home/me/x" }, d);
  assert.deepEqual([log.execs, log.hcs], [[], []]);
  assert.equal(log.runs[0][0], "terminal.open");
});

test("openInEditor: local file runs the local template on this computer, no machine lookup", async () => {
  const { d, log } = deps();
  await openInEditor({ machine: null, path: "/Users/u/a b.txt" }, d);
  assert.deepEqual(log.execs, [["code", ["/Users/u/a b.txt"], { on: null }]]);
  assert.deepEqual([log.hcs, log.notes], [[], []]);
});

test("openInEditor: remote file resolves the SSH target and runs the remote template locally", async () => {
  const { d, log } = deps({ loadConfig: cfg({ gui_editor: "Zed" }) });
  await openInEditor({ machine: "box", path: "/home/me/ä #1.md" }, d);
  assert.deepEqual(log.hcs, [["machine", "ls", "--json"]]);
  assert.deepEqual(log.execs, [["zed", ["ssh://me@box/home/me/%C3%A4%20%231.md"], { on: null }]]);
});

test("openInEditor: machine lookup problems become error notices and nothing runs", async () => {
  for (const [over, body] of [
    [{}, "jump is connected via a command, not SSH; filer-pro needs SSH"],
    [{ hc: async () => { throw new Error("hc gone"); } }, "hc gone"],
    [{ hc: async () => ({ code: 1, stdout: "", stderr: "nope" }) }, "Cannot read the machine list"],
  ]) {
    const { d, log } = deps(over);
    await openInEditor({ machine: "jump", path: "/x" }, d);
    assert.deepEqual(log.execs, []);
    assert.deepEqual(log.notes, [{ title: "Open in VS Code failed", body, level: "error" }]);
  }
  const { d, log } = deps({ loadConfig: cfg({ gui_editor: "Mine", gui_editors: [{ name: "Mine", local: "m {path}", remote: null }] }) });
  await openInEditor({ machine: "box", path: "/x" }, d);
  assert.match(log.notes[0].body, /Mine has no remote template/);
});

test("openInEditor: a spawn error retries the usual CLI folders, then shows the first error", async () => {
  const tried = [];
  const { d, log } = deps({ exec: async (cmd) => { tried.push(cmd); throw new Error(`spawn ${cmd} ENOENT`); } });
  await openInEditor({ machine: null, path: "/x" }, d);
  assert.deepEqual(tried, ["code", "/opt/homebrew/bin/code", "/usr/local/bin/code", "/Users/u/.local/bin/code"]);
  assert.deepEqual(log.notes, [{ title: "Open in VS Code failed", body: "spawn code ENOENT", level: "error" }]);
  const found = deps({ exec: async (cmd) => { tried.push(cmd); if (cmd !== "/usr/local/bin/code") throw new Error("ENOENT"); return { code: 0, stdout: "", stderr: "" }; } });
  tried.length = 0;
  await openInEditor({ machine: null, path: "/x" }, found.d);
  assert.deepEqual(tried, ["code", "/opt/homebrew/bin/code", "/usr/local/bin/code"]);
  assert.deepEqual(found.log.notes, []);
});

test("openInEditor: a path command and a timeout are not retried", async () => {
  const tried = [];
  const { d, log } = deps({
    loadConfig: cfg({ gui_editor: "Mine", gui_editors: [{ name: "Mine", local: "/opt/ed/bin/ed {path}" }] }),
    exec: async (cmd) => { tried.push(cmd); throw new Error("ENOENT"); },
  });
  await openInEditor({ machine: null, path: "/x" }, d);
  assert.deepEqual(tried, ["/opt/ed/bin/ed"]);
  assert.equal(log.notes.length, 1);
  tried.length = 0;
  const t = deps({ exec: async (cmd) => { tried.push(cmd); throw new Error("command timed out"); } });
  await openInEditor({ machine: null, path: "/x" }, t.d);
  assert.deepEqual(tried, ["code"]);
  assert.equal(t.log.notes[0].body, "command timed out");
});

test("openInEditor: a non-zero exit shows stderr, or the exit code when stderr is empty", async () => {
  const a = deps({ exec: async () => ({ code: 1, stdout: "", stderr: "Unable to connect to VS Code server.\n" }) });
  await openInEditor({ machine: null, path: "/x" }, a.d);
  assert.deepEqual(a.log.notes, [{ title: "Open in VS Code failed", body: "Unable to connect to VS Code server.", level: "error" }]);
  const b = deps({ exec: async () => ({ code: 3, stdout: "", stderr: "" }) });
  await openInEditor({ machine: null, path: "/x" }, b.d);
  assert.equal(b.log.notes[0].body, "code exited with 3");
});

test("openInEditor: a folder on a machine runs remote_folder, a local folder the local template", async () => {
  const a = deps();
  await openInEditor({ machine: "box", path: "/srv/app", folder: true }, a.d);
  assert.deepEqual(a.log.execs, [["code", ["--folder-uri", "vscode-remote://ssh-remote+me@box/srv/app"], { on: null }]]);
  const b = deps();
  await openInEditor({ machine: null, path: "/Users/u/app", folder: true }, b.d);
  assert.deepEqual(b.log.execs, [["code", ["/Users/u/app"], { on: null }]]);
  assert.deepEqual(b.log.hcs, []);
});

test("openInEditor: the error title names the configured editor", async () => {
  const z = deps({ loadConfig: cfg({ gui_editor: "Zed" }), exec: async () => { throw new Error("spawn zed ENOENT"); } });
  await openInEditor({ machine: null, path: "/x" }, z.d);
  assert.equal(z.log.notes[0].title, "Open in Zed failed");
  const m = deps({ loadConfig: cfg({ gui_editor: "Mine", gui_editors: [{ name: "Mine", local: "m {path}", remote: "m --ssh {target} {path}", remote_folder: null }] }) });
  await openInEditor({ machine: "box", path: "/srv/app", folder: true }, m.d);
  assert.equal(m.log.notes[0].title, "Open in Mine failed");
  assert.match(m.log.notes[0].body, /remote_folder/);
  assert.deepEqual(m.log.execs, []);
});
