import { test } from "node:test";
import assert from "node:assert/strict";
import { createReloadGate, fileHit, watchRel, watchPlan, permsCover } from "../mods/filer-pro/lib/reload.js";

const clock = () => { let t = 0; return { now: () => t, tick: (ms) => { t += ms; } }; };

test("reload gate: the value at start is no change, a new signal reloads at once", () => {
  const c = clock(), g = createReloadGate({ now: c.now, at: 5 });
  assert.equal(g.signal(5), false);
  assert.equal(g.take(false), false);
  assert.equal(g.signal(6), true);
  assert.equal(g.take(false), true);
  assert.equal(g.take(false), false); // done once
});

test("reload gate: 100 finished jobs in a burst give one reload now and one after the gap", () => {
  const c = clock(), g = createReloadGate({ now: c.now, at: null });
  let reloads = 0;
  for (let i = 1; i <= 100; i++) {
    g.signal(i);
    if (g.take(false)) reloads++;
    c.tick(5); // 100 signals within 500 ms
  }
  assert.equal(reloads, 1);
  c.tick(400); // still inside the gap of 1 s
  assert.equal(g.take(false), false);
  c.tick(100);
  assert.equal(g.take(false), true);
  assert.equal(g.take(false), false);
});

test("reload gate: a signal during a running load is kept and done after it", () => {
  const c = clock(), g = createReloadGate({ now: c.now, at: null });
  g.signal(1);
  assert.equal(g.take(false), true);
  c.tick(2000);
  g.signal(2); // arrives while the load runs
  assert.equal(g.take(true), false);
  c.tick(3000);
  assert.equal(g.take(true), false);
  assert.equal(g.take(false), true); // the load is over: caught up
  assert.equal(g.take(false), false);
});

test("fileHit: the file itself or a folder above it, never a sibling or a longer name", () => {
  const f = "/w/src/a.txt";
  assert.equal(fileHit(["/w/src/a.txt"], f), true);
  assert.equal(fileHit(["/w/src"], f), true, "the folder of the file");
  assert.equal(fileHit(["/w/"], f), true, "the watched root: refresh everything");
  assert.equal(fileHit(["/w/src/b.txt", "/w/other"], f), false);
  assert.equal(fileHit(["/w/src/a.txt.swp", "/w/sr"], f), false);
  assert.equal(fileHit(["C:\\w\\src"], "C:\\w\\src\\a.txt"), true);
  assert.equal(fileHit([], f), false);
  assert.equal(fileHit(null, f), false);
  assert.equal(fileHit(["/w"], null), false);
});

// ---- issue #42: which watch batches refresh

test("reload gate: mark() is a local trigger, gated and caught up like a signal", () => {
  const c = clock(), g = createReloadGate({ now: c.now, at: null });
  g.mark();
  assert.equal(g.take(false), true, "the first change after quiet: at once");
  g.mark();
  assert.equal(g.take(false), false, "inside the gap of 1 s");
  g.mark(); // coalesced
  c.tick(1000);
  assert.equal(g.take(false), true, "the trailing refresh after the gap");
  assert.equal(g.take(false), false);
});

test("watchRel: relative to the root as given or as resolved, null outside both", () => {
  const roots = ["/tmp/w", "/private/tmp/w"];
  assert.equal(watchRel("/tmp/w/a.txt", roots), "a.txt");
  assert.equal(watchRel("/private/tmp/w/sub/b", roots), "sub/b");
  assert.equal(watchRel("/private/tmp/w", roots), "");
  assert.equal(watchRel("/private/tmp/w/", roots), "");
  assert.equal(watchRel("/private/tmp/wx/a", roots), null, "a longer name is not below the root");
  assert.equal(watchRel("/elsewhere/a", roots), null);
  assert.equal(watchRel("/a/b", ["/"]), "a/b", "the root folder /");
  assert.equal(watchRel("/w/a", ["/w", null]), "a", "no resolved root");
  assert.equal(watchRel("C:\\w\\sub\\a.txt", ["C:\\w"]), "sub/a.txt", "Windows separators");
});

const plan = (paths, o = {}) => watchPlan(paths, { roots: ["/w"], folders: ["src"], file: null, hide: { hide_system_files: true, hide_dotfiles: false }, ...o });
const NOTHING = { refresh: false, file: null };

test("watch filter: a write in a collapsed subtree is ignored", () => {
  assert.deepEqual(plan(["/w/Library/Caches/x.db", "/w/node_modules/a/b.js", "/w/src/deep/c.txt"]), NOTHING);
});

test("watch filter: a child of the root or of an expanded folder refreshes, without reading the open file", () => {
  assert.deepEqual(plan(["/w/new.txt"]), { refresh: true, file: null });
  assert.deepEqual(plan(["/w/src/a.js"], { file: "README.md" }), { refresh: true, file: null });
});

test("watch filter: a shown folder or a folder above one, reported itself, refreshes", () => {
  assert.equal(plan(["/w/src"]).refresh, true);
  assert.equal(plan(["/w/a"], { folders: ["a/b/c", "a/b"] }).refresh, true);
  assert.equal(plan(["/w/a/b/c"], { folders: ["a/b/c", "a/b", "a"] }).refresh, true);
});

test("watch filter: the root in a batch (overflow) refreshes everything and names the open file", () => {
  assert.deepEqual(plan(["/w/Library/x", "/w"], { file: "deep/a.txt" }), { refresh: true, file: "named" });
});

test("watch filter: the open file or a folder above it is named, also in a collapsed folder", () => {
  assert.deepEqual(plan(["/w/deep/sub/a.txt"], { file: "deep/sub/a.txt" }), { refresh: true, file: "named" });
  assert.deepEqual(plan(["/w/deep"], { file: "deep/sub/a.txt" }), { refresh: true, file: "named" });
  assert.deepEqual(plan(["/w/deep/sub/a.txt.swp"], { file: "deep/sub/a.txt" }), NOTHING);
});

test("watch filter: .git index, HEAD and refs refresh the marks; objects and logs are ignored", () => {
  for (const p of [".git/index", ".git/HEAD", ".git/refs/heads/main", ".git"]) assert.equal(plan([`/w/${p}`]).refresh, true, p);
  for (const p of [".git/objects/ab/cdef", ".git/logs/HEAD", ".git/index.lock", ".git/FETCH_HEAD"]) assert.deepEqual(plan([`/w/${p}`]), NOTHING, p);
  assert.equal(plan(["/w/.git/index"], { hide: { hide_dotfiles: true } }).refresh, true, "also while dot files are hidden");
  assert.deepEqual(plan(["/w/sub/.git/index"]), NOTHING, "a nested repository in a collapsed folder");
});

test("watch filter: hidden entries are ignored while they are hidden, shown ones refresh", () => {
  const dots = { hide_system_files: false, hide_dotfiles: true };
  assert.deepEqual(plan(["/w/.zsh_history", "/w/src/.eslintcache"], { hide: dots }), NOTHING);
  assert.equal(plan(["/w/.zsh_history"], { hide: { hide_dotfiles: false } }).refresh, true, "dot files shown");
  assert.deepEqual(plan(["/w/.DS_Store"]), NOTHING, "a system file while hide_system_files is on");
  assert.deepEqual(plan(["/w/.zsh_history"], { hide: dots, file: ".zsh_history" }), { refresh: true, file: "named" }, "the open file wins");
});

test("watch filter: paths under the resolved root are compared too", () => {
  assert.deepEqual(plan(["/private/tmp/w/x/y"], { roots: ["/tmp/w", "/private/tmp/w"] }), NOTHING);
  assert.equal(plan(["/private/tmp/w/new"], { roots: ["/tmp/w", "/private/tmp/w"] }).refresh, true);
});

test("watch filter: a path under no known root falls back to refresh everything and compare the text", () => {
  assert.deepEqual(plan(["/elsewhere/a"], { file: "a.txt" }), { refresh: true, file: "text" });
  assert.deepEqual(plan(["/elsewhere/a"]), { refresh: true, file: null });
  assert.deepEqual(plan([], { file: "a.txt" }), { refresh: true, file: "text" }, "an empty batch carries no paths: refresh");
  assert.deepEqual(plan(null), { refresh: true, file: null });
});

// ---- issue #41: which chmod re-probes the open file

const on = (o = {}) => ({ on: null, root: "/w", file: "src/a.txt", ...o });
test("permsCover: a chmod of the open file itself", () => {
  assert.equal(permsCover({ machine: null, path: "/w/src/a.txt", recursive: false }, on()), true);
  assert.equal(permsCover({ machine: "box", path: "/w/src/a.txt" }, on({ on: "box" })), true);
});
test("permsCover: an unrelated chmod does not cover the open file", () => {
  assert.equal(permsCover({ machine: null, path: "/w/src/b.txt", recursive: false }, on()), false);
  assert.equal(permsCover({ machine: null, path: "/w/src/a.txt.bak", recursive: false }, on()), false);
  assert.equal(permsCover({ machine: null, path: "/w/sr", recursive: true }, on()), false);
  assert.equal(permsCover(undefined, on()), false);
  assert.equal(permsCover({ machine: null, path: "/w/src/a.txt" }, on({ file: null })), false, "no open file");
});
test("permsCover: a recursive chmod of a folder above the open file", () => {
  assert.equal(permsCover({ machine: null, path: "/w", recursive: true }, on()), true);
  assert.equal(permsCover({ machine: null, path: "/w/src/", recursive: true }, on()), true);
});
test("permsCover: a non-recursive chmod covers only the direct parent folder (its write and sticky bits decide editing)", () => {
  assert.equal(permsCover({ machine: null, path: "/w/src", recursive: false }, on()), true);
  assert.equal(permsCover({ machine: null, path: "/w", recursive: false }, on()), false);
});
test("permsCover: another machine with the same path does not cover the open file", () => {
  assert.equal(permsCover({ machine: "box", path: "/w/src/a.txt", recursive: false }, on()), false);
  assert.equal(permsCover({ machine: null, path: "/w/src/a.txt", recursive: false }, on({ on: "box" })), false);
  assert.equal(permsCover({ machine: "other", path: "/w", recursive: true }, on({ on: "box" })), false);
});

test("watch filter: .gitignore in a shown folder refreshes the marks even while dot files are hidden", () => {
  const dots = { hide_dotfiles: true };
  assert.equal(plan(["/w/.gitignore"], { hide: dots }).refresh, true);
  assert.equal(plan(["/w/src/.gitignore"], { hide: dots }).refresh, true);
  assert.deepEqual(plan(["/w/closed/.gitignore"], { hide: dots }), NOTHING, "a collapsed folder: no shown row changes");
});

test("watch filter: while the open file's real folder is unknown, a path with its name elsewhere compares the text", () => {
  assert.deepEqual(plan(["/w/real/a.txt"], { file: "link/a.txt" }), { refresh: true, file: "text" });
  assert.deepEqual(plan(["/w/real/b.txt"], { file: "link/a.txt" }), NOTHING);
});

test("watch filter: once the open file's real folder is known, only its real path names it (no name guess)", () => {
  const known = { file: "link/a.txt", fileKnown: true, links: [["link", "/w/real"]] };
  assert.deepEqual(plan(["/w/real/a.txt"], known), { refresh: true, file: "named" });
  assert.deepEqual(plan(["/w/node_modules/x/a.txt"], known), NOTHING, "same name elsewhere: nothing");
  assert.deepEqual(plan(["/w/deep/a.txt"], { file: "a.txt" }), NOTHING, "a file in the root itself is always matched exactly");
});

test("watch filter: an expanded symlinked folder (l -> a, a collapsed) refreshes on a change under its real path", () => {
  const o = { folders: ["l"], links: [["l", "/w/a"]] };
  assert.deepEqual(plan(["/w/a/x"], o), { refresh: true, file: null });
  assert.deepEqual(plan(["/w/a/x"], { folders: ["l"] }), NOTHING, "without the link: a collapsed folder");
  assert.deepEqual(plan(["/w/a/deep/y"], o), NOTHING, "below a collapsed folder inside the link: nothing");
  assert.equal(plan(["/w/a"], o).refresh, true, "the target folder itself");
  assert.deepEqual(plan(["/w/a/x.txt"], { ...o, file: "l/x.txt", fileKnown: true }), { refresh: true, file: "named" });
});

test("watch filter: a link target outside the root is compared too, and a path under no root nor link falls back", () => {
  const o = { folders: ["l"], links: [["l", "/elsewhere/t"]] };
  assert.deepEqual(plan(["/elsewhere/t/x"], o), { refresh: true, file: null });
  assert.deepEqual(plan(["/elsewhere/u/x"], o), { refresh: true, file: null }, "fallback: refresh everything");
});

test("watchRel: a Windows extended-length prefix is ignored", () => {
  assert.equal(watchRel("\\\\?\\C:\\w\\a.txt", ["C:\\w"]), "a.txt");
});
