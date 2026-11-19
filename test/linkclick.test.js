import { test } from "node:test";
import assert from "node:assert/strict";
import { linkTarget, wantsHome } from "../mods/filer-pro/lib/linkclick.js";

const local = { machine: null, cwd: "/Users/u/app" };
const studio = { machine: "studio", cwd: "/Users/u/app" };
const file = (raw, path = null) => ({ kind: "file", raw, path });

test("a local link uses the file Herdr found", () => {
  assert.deepEqual(linkTarget(file("./shot.png:3", "/Users/u/app/shot.png"), local), { machine: null, path: "/Users/u/app/shot.png" });
  assert.equal(linkTarget(file("./gone.png"), local), null, "a missing local file passes");
  assert.equal(linkTarget({ kind: "url", raw: "https://x/y.png", url: "https://x/y.png" }, local), null);
});

test("a remote link resolves against the terminal's folder and the home folder", () => {
  const t = (raw, home = null) => linkTarget(file(raw), studio, home)?.path ?? null;
  assert.equal(t("/tmp/a.png"), "/tmp/a.png");
  assert.equal(t("shots/a.png"), "/Users/u/app/shots/a.png");
  assert.equal(t("./a.png:12:5"), "/Users/u/app/a.png");
  assert.equal(t("docs/README.md."), "/Users/u/app/docs/README.md");
  assert.equal(t("../x/./b.pdf"), "/Users/u/x/b.pdf");
  assert.equal(t("$PWD/a.png"), "/Users/u/app/a.png");
  assert.equal(t("~/Desktop/a.png", "/Users/u"), "/Users/u/Desktop/a.png");
  assert.equal(t("$HOME/a.png", "/Users/u"), "/Users/u/a.png");
  assert.equal(t("~/a.png"), null, "no home folder known");
  assert.equal(t("file://studio/tmp/a%20b.png"), "/tmp/a b.png");
  assert.equal(t("file:C:/x.png"), null);
  assert.equal(t("file:///%E0.png"), null, "a bad escape");
  assert.equal(linkTarget(file("a.png"), { machine: "studio", cwd: null }), null, "a relative path needs the folder");
  assert.equal(t("/.."), null, "never / itself");
  assert.equal(linkTarget(file("/tmp/a.png"), studio).machine, "studio");
});

test("wantsHome only for remote links that start at the home folder", () => {
  assert.equal(wantsHome(file("~/a.png")), true);
  assert.equal(wantsHome(file("$HOME/a.png")), true);
  assert.equal(wantsHome(file("~/a.png", "/Users/u/a.png")), false);
  assert.equal(wantsHome(file("a/~/b.png")), false);
});
