import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../mods/filer-pro/lib/config.js";

const home = () => "/home/u";
const appHome = () => "/home/u/.config/herdr-app";
const reader = (text) => async (p) => (p === "/home/u/.config/herdr-app/filer-pro.json" ? text : null);

test("tilde expands to home", async () => {
  assert.equal((await loadConfig(reader('{"download_folder":"~/x"}'), appHome, home)).download_folder, "/home/u/x");
});
test("absolute path stays", async () => {
  assert.equal((await loadConfig(reader('{"download_folder":"/data/in"}'), appHome, home)).download_folder, "/data/in");
});
test("missing file and broken JSON give the default", async () => {
  assert.equal((await loadConfig(reader(null), appHome, home)).download_folder, "/home/u/Downloads");
  assert.equal((await loadConfig(reader("{nope"), appHome, home)).download_folder, "/home/u/Downloads");
  assert.equal((await loadConfig(reader('{"download_folder":5}'), appHome, home)).download_folder, "/home/u/Downloads");
});
test("reader that rejects gives the default", async () => {
  assert.equal((await loadConfig(async () => { throw new Error("x"); }, appHome, home)).download_folder, "/home/u/Downloads");
});
test("preview, mermaid, perf with defaults and type checks", async () => {
  assert.deepEqual(await loadConfig(reader(null), appHome, home), { download_folder: "/home/u/Downloads", preview: true, mermaid: true, perf: false });
  const c = await loadConfig(reader('{"preview":false,"mermaid":"no","perf":true}'), appHome, home);
  assert.deepEqual([c.preview, c.mermaid, c.perf], [false, true, true]);
});
test("a broken file leaves the switches at the default", async () => {
  const c = await loadConfig(reader("{nope"), appHome, home);
  assert.deepEqual([c.preview, c.mermaid, c.perf], [true, true, false]);
});
