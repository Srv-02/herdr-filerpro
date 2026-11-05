import { test } from "node:test";
import assert from "node:assert/strict";
import { prepare, prepareSteps, prepareAsync, safeLink, noteText, PREVIEW_MAX_CHARS, MAX_DIAGRAMS } from "../mods/filer-pro/preview/prepare.js";

test("Markdown is truncated, stripped and split", () => {
  const md = "# T\n![a](https://example.com/p.gif)\n```mermaid\nflowchart LR\n A-->B\n```\n" + "x".repeat(300000);
  const doc = prepare(md, { kind: "markdown", mermaid: true });
  assert.equal(doc.kind, "markdown");
  assert.equal(doc.truncated, true);
  assert.equal(doc.diagrams, 1);
  assert.equal(doc.parts[0].kind, "markdown");
  assert.ok(doc.parts[0].text.includes("[image: a]"));
  assert.equal(doc.parts[1].kind, "mermaid");
  assert.ok(doc.parts.map((p) => p.text).join("").length <= PREVIEW_MAX_CHARS + 50);
});

test("a short file is not truncated", () => {
  assert.equal(prepare("# T", { kind: "markdown", mermaid: true }).truncated, false);
});

test("mermaid false: the fence stays text and no diagram is counted", () => {
  const d = prepare("```mermaid\nA\n```", { kind: "markdown", mermaid: false });
  assert.deepEqual(d.parts.map((p) => p.kind), ["markdown"]);
  assert.equal(d.diagrams, 0);
  assert.ok(d.parts[0].text.includes("```mermaid"));
});

test("from the 21st fence on, the rest stays Markdown", () => {
  const md = "```mermaid\nflowchart LR\n A-->B\n```\n".repeat(25);
  const d = prepare(md, { kind: "markdown", mermaid: true });
  assert.equal(d.diagrams, MAX_DIAGRAMS);
  assert.equal(d.parts.filter((p) => p.kind === "mermaid").length, 20);
  const last = d.parts.at(-1);
  assert.ok(last.kind === "markdown" && last.text.includes("```mermaid") && last.text.includes("A-->B"));
});

test("HTML is stripped and never split", () => {
  const d = prepare('<img src="x"><p>a</p>', { kind: "html", mermaid: true });
  assert.deepEqual(d.parts, [{ kind: "html", text: "[image]<p>a</p>" }]);
  assert.equal(d.diagrams, 0);
});

test("the cut never leaves half a surrogate pair", () => {
  const d = prepare("a".repeat(PREVIEW_MAX_CHARS - 1) + "\u{1F600}", { kind: "markdown", mermaid: false });
  assert.equal(d.truncated, true);
  assert.doesNotMatch(d.parts[0].text, /[\ud800-\udbff]$/);
});

test("200,000 characters with 20 fences prepare in well under a frame of slack (smoke, not a benchmark)", () => {
  const md = ("```mermaid\nflowchart LR\n A-->B\n```\n" + "text\n".repeat(2000)).repeat(20);
  const d = prepare(md, { kind: "markdown", mermaid: true });
  assert.equal(d.diagrams, 20);
});

test("links: only http and https reach the opener", () => {
  assert.equal(safeLink("https://example.com/a?b=c"), "https://example.com/a?b=c");
  assert.equal(safeLink("HTTP://example.com"), "HTTP://example.com");
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "./other.md", "../x.html", "/abs/path", "#anchor", "mailto:a@example.com",
    "myapp://open", "\\\\server\\share", "ftp://example.com", "", " https://example.com", "data:text/html,x"])
    assert.equal(safeLink(bad), null, bad);
  assert.equal(safeLink(undefined), null);
});

test("prepareSteps gives the same document as prepare and yields in pieces", () => {
  const md = "# T\n\ntext ![a](b)\n\n```mermaid\nflowchart LR\n A-->B\n```\n\n".repeat(400);
  const gen = prepareSteps(md, { kind: "markdown", mermaid: true });
  let n = 0, r;
  while (!(r = gen.next()).done) n++;
  assert.ok(n >= 5, `only ${n} steps`);
  assert.deepEqual(r.value, prepare(md, { kind: "markdown", mermaid: true }));
});

test("prepareAsync sleeps between the steps and returns the document", async () => {
  const md = "text ![a](b)\n\n".repeat(5000);
  let sleeps = 0;
  const doc = await prepareAsync(md, { kind: "markdown", mermaid: false }, { sleep: async () => { sleeps++; }, alive: () => true, now: Date.now });
  assert.ok(sleeps >= 5);
  assert.deepEqual(doc, prepare(md, { kind: "markdown", mermaid: false }));
});

test("prepareAsync stops at once when the file changed and returns null", async () => {
  const md = "text\n\n".repeat(20000);
  let sleeps = 0, alive = true;
  const doc = await prepareAsync(md, { kind: "markdown", mermaid: false }, { sleep: async () => { if (++sleeps === 2) alive = false; }, alive: () => alive, now: Date.now });
  assert.equal(doc, null);
  assert.equal(sleeps, 2);
});

test("prepareAsync reports the duration of every step", async () => {
  const steps = [];
  await prepareAsync("text\n\n".repeat(5000), { kind: "markdown", mermaid: false }, { sleep: async () => {}, alive: () => true, now: Date.now, onStep: (ms) => steps.push(ms) });
  assert.ok(steps.length >= 3 && steps.every((ms) => ms >= 0));
});

test("a cut long line marks the document as shortened", () => {
  assert.equal(prepare("a".repeat(50000), { kind: "markdown", mermaid: false }).truncated, true);
});

test("settings: maxChars and maxDiagrams per call; the document carries its limit for the note", () => {
  const long = "a".repeat(150);
  const doc = prepare(long, { kind: "markdown", mermaid: true, maxChars: 100 });
  assert.equal(doc.truncated, true);
  assert.equal(doc.limit, 100);
  assert.equal(prepare("x", { kind: "markdown", mermaid: true }).limit, PREVIEW_MAX_CHARS);
  const fences = "```mermaid\ngraph TD\nA-->B\n```\n\n```mermaid\ngraph TD\nC-->D\n```\n";
  assert.equal(prepare(fences, { kind: "markdown", mermaid: true, maxDiagrams: 1 }).diagrams, 1);
  assert.equal(prepare(fences, { kind: "markdown", mermaid: true }).diagrams, 2);
  assert.equal(noteText(200000), "Preview is shortened (first 200,000 characters, long lines cut) · open Source for the whole file");
  assert.equal(noteText(50000), "Preview is shortened (first 50,000 characters, long lines cut) · open Source for the whole file");
});
