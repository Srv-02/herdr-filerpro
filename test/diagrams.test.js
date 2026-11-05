import { test } from "node:test";
import assert from "node:assert/strict";
import { createDiagrams, NODE_CANDIDATES, NO_NODE } from "../mods/filer-pro/preview/diagrams.js";
import { hash, colorsFor, FONT, RENDER_VERSION, MAX_DIAGRAM_CHARS } from "../mods/filer-pro/preview/mermaid.js";
import { withoutIntl } from "./no-intl.js";

const APP = "/Users/m/.config/herdr-app";
const theme = { background: "#000000", foreground: "#ffffff", dim: "#888888", ansi4: "#0000ff", muted: "#999999", border: "#333333" };
const fullKey = (source) => JSON.stringify([RENDER_VERSION, source, colorsFor(theme), FONT]);
const keyOf = (source) => hash(fullKey(source));
const part = (text) => ({ kind: "mermaid", text });

// A fake of exec, the file functions and the Node script. `behave(call)` returns { code, stdout, stderr } or throws.
function fake(behave = () => ({ code: 0, stdout: "", stderr: "" })) {
  const f = { files: {}, execCalls: [], writes: [], mkdirs: [], samples: [] };
  f.exec = async (cmd, args, options) => {
    f.execCalls.push({ cmd, args, options });
    const r = await behave(f.execCalls.at(-1), f);
    if (r.code === 0 && args[0]?.endsWith("render-mermaid.mjs"))
      f.files[`${args[2]}.json`] = JSON.stringify({ width: 300, height: 100, key: JSON.stringify([RENDER_VERSION, f.files[args[1]], JSON.parse(args[3]), FONT]) });
    return r;
  };
  f.readTextFile = async (p) => f.files[p] ?? null;
  f.writeFile = async (p, text) => { f.writes.push(p); f.files[p] = text; };
  f.mkdir = async (p, o) => { f.mkdirs.push([p, o]); };
  f.unlink = async (p) => { if (!(p in f.files)) throw new Error("ENOENT"); delete f.files[p]; };
  f.perf = { sample: (phase, ms) => f.samples.push([phase, ms]) };
  f.make = (extra) => createDiagrams({ ...extra, exec: f.exec, readTextFile: f.readTextFile, writeFile: f.writeFile, mkdir: f.mkdir, unlink: f.unlink, appHome: () => APP, now: () => 0, perf: f.perf, rand: () => "r1" });
  return f;
}

test("cache hit starts no exec", async () => {
  const f = fake(), source = "flowchart LR\n A-->B", key = keyOf(source);
  f.files[`${APP}/data/filer-pro/diagrams/${key}.json`] = JSON.stringify({ width: 10, height: 5, key: fullKey(source) });
  const parts = [{ kind: "markdown", text: "x" }, part(source)];
  await f.make().renderAll(parts, theme, () => true, () => {});
  assert.equal(f.execCalls.length, 0);
  assert.deepEqual(parts[1].diagram, { path: `data/filer-pro/diagrams/${key}.svg`, width: 10, height: 5 });
});

test("cache miss writes the source and runs node with the script, the temp file and the colors", async () => {
  const f = fake(), source = "flowchart LR\n A-->B", key = keyOf(source), parts = [part(source)];
  await f.make().renderAll(parts, theme, () => true, () => {});
  assert.deepEqual(f.mkdirs, [[`${APP}/data/filer-pro/diagrams`, { recursive: true }]]);
  assert.deepEqual(f.writes, [`${APP}/data/filer-pro/diagrams/${key}.r1.mmd`]);
  assert.equal(f.files[`${APP}/data/filer-pro/diagrams/${key}.r1.mmd`], source);
  const call = f.execCalls[0];
  assert.equal(call.cmd, "node");
  assert.deepEqual(call.args, [`${APP}/mods/filer-pro/bin/render-mermaid.mjs`, `${APP}/data/filer-pro/diagrams/${key}.r1.mmd`, `${APP}/data/filer-pro/diagrams/${key}`, JSON.stringify(colorsFor(theme))]);
  assert.equal(call.options.on, null);
  assert.deepEqual(parts[0].diagram, { path: `data/filer-pro/diagrams/${key}.svg`, width: 300, height: 100 });
  assert.equal(f.samples[0][0], "mermaid.exec");
});

test("the diagram shows as loading until its turn", async () => {
  let seen;
  const parts = [part("flowchart LR\n A-->B"), part("flowchart LR\n C-->D")];
  const f = fake((call) => { seen ??= parts.map((p) => p.diagram?.loading === true); return { code: 0, stdout: "", stderr: "" }; });
  await f.make().renderAll(parts, theme, () => true, () => {});
  assert.deepEqual(seen, [true, true], "both were marked loading when the first render started");
  assert.ok(parts.every((p) => p.diagram.path));
});

test("failure: first stderr line", async () => {
  const f = fake(() => ({ code: 1, stdout: "", stderr: "Parse error on line 2\nmore" })), parts = [part("x")];
  await f.make().renderAll(parts, theme, () => true, () => {});
  assert.deepEqual(parts[0].diagram, { error: "Parse error on line 2" });
});

test("exit 0 without a json counts as a failure", async () => {
  const f = fake(), parts = [part("x")];
  f.exec = async (cmd, args, o) => { f.execCalls.push({ cmd, args, o }); return { code: 0, stdout: "", stderr: "" }; };
  await f.make().renderAll(parts, theme, () => true, () => {});
  assert.deepEqual(parts[0].diagram, { error: "render produced no output" });
});

test("node candidates: the first that exec does not reject is remembered per instance", async () => {
  const f = fake((call) => { if (call.cmd !== "/opt/homebrew/bin/node") throw new Error("not found"); return { code: 0, stdout: "", stderr: "" }; });
  const parts = [part("a"), part("b")], d = f.make();
  await d.renderAll(parts, theme, () => true, () => {});
  assert.deepEqual(f.execCalls.map((c) => c.cmd), ["node", "/opt/homebrew/bin/node", "/opt/homebrew/bin/node"]);
  assert.ok(parts.every((p) => p.diagram.path));
  assert.deepEqual(NODE_CANDIDATES, ["node", "/opt/homebrew/bin/node", "/usr/local/bin/node"]);
});

test("every candidate is rejected: a clear message, no crash", async () => {
  const f = fake(() => { throw new Error("spawn failed"); }), parts = [part("a"), part("b")];
  await f.make().renderAll(parts, theme, () => true, () => {});
  assert.deepEqual(f.execCalls.map((c) => c.cmd), NODE_CANDIDATES, "the candidates are tried once per run, not once per diagram");
  assert.deepEqual(parts.map((p) => p.diagram), [{ error: NO_NODE }, { error: NO_NODE }]);
  assert.equal(NO_NODE, 'node not found (install Node.js or set "mermaid": false)');
});

test("a timeout is reported as such", async () => {
  const f = fake(() => { throw new Error("command timed out after 30s"); }), parts = [part("a")];
  await f.make().renderAll(parts, theme, () => true, () => {});
  assert.deepEqual(parts[0].diagram, { error: "render timed out" });
  assert.equal(f.execCalls.length, 1);
});

test("document change stops after the running diagram and drops its result", async () => {
  let alive = true;
  const f = fake((call, state) => { if (state.execCalls.length === 2) alive = false; return { code: 0, stdout: "", stderr: "" }; });
  const parts = [part("a"), part("b"), part("c")];
  let changes = 0;
  await f.make().renderAll(parts, theme, () => alive, () => changes++);
  assert.equal(f.execCalls.length, 2);
  assert.equal(changes, 1);
  assert.ok(parts[0].diagram.path);
  assert.equal(parts[2].diagram.loading, true);
});

test("a theme change (the color key no longer matches) stops the run the same way", async () => {
  let key = "k1";
  const f = fake((call, state) => { if (state.execCalls.length === 1) key = "k2"; return { code: 0, stdout: "", stderr: "" }; });
  await f.make().renderAll([part("a"), part("b")], theme, () => key === "k1", () => {});
  assert.equal(f.execCalls.length, 1);
});

test("a fence over the limit does not render; the limit is grouped without Intl (herdr's engine)", async () => {
  const f = fake(), parts = [part("x".repeat(MAX_DIAGRAM_CHARS + 1)), part("y")];
  await withoutIntl(() => f.make().renderAll(parts, theme, () => true, () => {}));
  assert.deepEqual(parts[0].diagram, { error: "Diagram too large (limit 20,000 characters)" });
  assert.equal(f.execCalls.length, 1);
});

test("beyond the 20th diagram nothing starts", async () => {
  const f = fake(), parts = Array.from({ length: 22 }, (_, i) => part(`flowchart LR\n A${i}-->B`));
  await f.make().renderAll(parts, theme, () => true, () => {});
  assert.equal(f.execCalls.length, 20);
  assert.deepEqual(parts[20].diagram, { error: "Too many diagrams (limit 20)" });
});

test("the same source twice renders once", async () => {
  const f = fake(), parts = [part("same"), part("same")];
  await f.make().renderAll(parts, theme, () => true, () => {});
  assert.equal(f.execCalls.length, 1);
  assert.deepEqual(parts[0].diagram, parts[1].diagram);
});

test("a short-hash collision is no cache hit: the json must confirm the full key", async () => {
  const f = fake(), a = "flowchart LR\n A-->B", b = "flowchart LR\n X-->Y", sameHash = () => "collide";
  f.files[`${APP}/data/filer-pro/diagrams/collide.json`] = JSON.stringify({ width: 10, height: 5, key: fullKey(a) });
  const partsA = [part(a)], partsB = [part(b)], d = f.make({ hash: sameHash });
  await d.renderAll(partsA, theme, () => true, () => {});
  assert.equal(f.execCalls.length, 0, "the entry confirms its own source");
  assert.deepEqual(partsA[0].diagram, { path: "data/filer-pro/diagrams/collide.svg", width: 10, height: 5 });
  await d.renderAll(partsB, theme, () => true, () => {});
  assert.equal(f.execCalls.length, 1, "another source with the same short hash is rendered again");
});

test("a json without a key, or with another key, is no cache hit", async () => {
  for (const meta of [{ width: 10, height: 5 }, { width: 10, height: 5, key: "other" }]) {
    const f = fake(), source = "flowchart LR\n A-->B";
    f.files[`${APP}/data/filer-pro/diagrams/${keyOf(source)}.json`] = JSON.stringify(meta);
    await f.make().renderAll([part(source)], theme, () => true, () => {});
    assert.equal(f.execCalls.length, 1);
  }
});

test("after a re-render over a colliding entry the freshly written json is accepted", async () => {
  const f = fake(), a = "flowchart LR\n A-->B", parts = [part(a)];
  f.files[`${APP}/data/filer-pro/diagrams/${keyOf(a)}.json`] = JSON.stringify({ width: 1, height: 1, key: "stale" });
  await f.make().renderAll(parts, theme, () => true, () => {});
  assert.deepEqual(parts[0].diagram, { path: `data/filer-pro/diagrams/${keyOf(a)}.svg`, width: 300, height: 100 });
});

test("a new run probes for node again (it may have been installed meanwhile)", async () => {
  const f = fake(() => { throw new Error("spawn failed"); }), d = f.make();
  await d.renderAll([part("a")], theme, () => true, () => {});
  await d.renderAll([part("b")], theme, () => true, () => {});
  assert.equal(f.execCalls.length, NODE_CANDIDATES.length * 2);
});

test("the source file does not stay behind after a failed run", async () => {
  for (const behave of [() => { throw new Error("spawn failed"); }, () => { throw new Error("command timed out"); }, () => ({ code: 1, stdout: "", stderr: "boom" })]) {
    const f = fake(behave);
    await f.make().renderAll([part("a")], theme, () => true, () => {});
    assert.deepEqual(Object.keys(f.files).filter((n) => n.endsWith(".mmd")), []);
  }
});

test("exit code 1 with a finished json is a success (another run was faster)", async () => {
  const f = fake((call, state) => {
    state.files[`${call.args[2]}.json`] = JSON.stringify({ width: 7, height: 3, key: fullKey("a") });
    return { code: 1, stdout: "", stderr: "ENOENT: rename" };
  }), parts = [part("a")];
  await f.make().renderAll(parts, theme, () => true, () => {});
  assert.deepEqual(parts[0].diagram, { path: `data/filer-pro/diagrams/${keyOf("a")}.svg`, width: 7, height: 3 });
});

test("settings: maxDiagrams and maxChars per run", async () => {
  const f = fake(), parts = [part("x".repeat(600)), part("a"), part("b"), part("c")];
  await f.make().renderAll(parts, theme, () => true, () => {}, { maxDiagrams: 2, maxChars: 500 });
  assert.deepEqual(parts[0].diagram, { error: "Diagram too large (limit 500 characters)" });
  assert.deepEqual(parts[3].diagram, { error: "Too many diagrams (limit 2)" });
  assert.equal(f.execCalls.length, 2);
});

test("settings: a configured node path is the only one tried, also after another path worked", async () => {
  const f = fake((call) => { if (call.cmd !== "/opt/n/node") throw new Error("not found"); return { code: 0, stdout: "", stderr: "" }; });
  const d = f.make(), parts = [part("a")];
  await d.renderAll(parts, theme, () => true, () => {}, { node: "/opt/n/node" });
  assert.deepEqual(f.execCalls.map((c) => c.cmd), ["/opt/n/node"]);
  assert.ok(parts[0].diagram.path);
  const g = fake(() => { throw new Error("spawn failed"); }), more = [part("b"), part("c")];
  await g.make().renderAll(more, theme, () => true, () => {}, { node: "/missing/node" });
  assert.deepEqual(g.execCalls.map((c) => c.cmd), ["/missing/node"], "not once per diagram");
  assert.deepEqual(more.map((p) => p.diagram), [{ error: "node not found at /missing/node" }, { error: "node not found at /missing/node" }]);
});
