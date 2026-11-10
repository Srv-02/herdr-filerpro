// Folder navigation (issue #59): the per-terminal override of the shown root and the state it carries along.
import { test } from "node:test";
import assert from "node:assert/strict";
import { paneId, shownRoot, setRoot, upOf, topOf, carry, headerPath, frontTruncate, watchable } from "../mods/filer-pro/lib/navigate.js";

const at = (cwd, on = null, space = "s1") => ({ cwd, on, space });

test("paneId names the focused pane, a layout terminal block, or nothing", () => {
  assert.equal(paneId({ pane: "p1", terminal: "t1" }), "p1");
  assert.equal(paneId({ pane: null, terminal: "host/t2" }), "terminal:host/t2");
  assert.equal(paneId({ pane: null, terminal: null }), null);
  assert.equal(paneId(null), null);
});

test("without an override the tree shows the terminal's folder", () => {
  assert.equal(shownRoot(new Map(), "p1", at("/r/a")), "/r/a");
  assert.equal(shownRoot(new Map(), null, at("/r/a")), "/r/a");
  assert.equal(shownRoot(new Map(), "p1", at(undefined)), undefined);
});

test("Up sets the override, the terminal's own folder ends it", () => {
  const nav = new Map();
  assert.equal(setRoot(nav, "p1", at("/r/a"), "/r"), true); // Up
  assert.equal(shownRoot(nav, "p1", at("/r/a")), "/r");
  assert.equal(setRoot(nav, "p1", at("/r/a"), "/r/b"), true); // another folder
  assert.equal(shownRoot(nav, "p1", at("/r/a")), "/r/b");
  assert.equal(setRoot(nav, "p1", at("/r/a"), "/r/a"), true); // Back to the terminal's folder
  assert.equal(nav.size, 0);
  assert.equal(shownRoot(nav, "p1", at("/r/a")), "/r/a");
});

test("the override is per terminal: another pane shows its own folder, switching back shows the navigated one", () => {
  const nav = new Map();
  setRoot(nav, "p1", at("/r/a"), "/r");
  assert.equal(shownRoot(nav, "p2", at("/r/a")), "/r/a"); // same folder, other terminal: no override
  assert.equal(shownRoot(nav, "p2", at("/x")), "/x");
  assert.equal(shownRoot(nav, "p1", at("/r/a")), "/r");
});

test("a cd in the terminal keeps its override: the tree stays where the user navigated", () => {
  const nav = new Map();
  setRoot(nav, "p1", at("/r/a"), "/");
  assert.equal(shownRoot(nav, "p1", at("/tmp")), "/");
  assert.equal(shownRoot(nav, "p1", at("/r/a")), "/");
  setRoot(nav, "p1", at("/tmp"), "/tmp"); // back to the terminal's folder, wherever it is now
  assert.equal(nav.size, 0);
  assert.equal(shownRoot(nav, "p1", at("/tmp")), "/tmp");
});

test("the override belongs to the machine it was set on", () => {
  const nav = new Map();
  setRoot(nav, "p1", at("/r/a", "host"), "/r");
  assert.equal(shownRoot(nav, "p1", at("/r/a", "host")), "/r");
  assert.equal(shownRoot(nav, "p1", at("/r/a", null)), "/r/a");
  assert.equal(nav.size, 0);
});

test("setRoot refuses without a pane, a terminal folder or a root", () => {
  const nav = new Map();
  assert.equal(setRoot(nav, null, at("/r/a"), "/r"), false);
  assert.equal(setRoot(nav, "p1", at(undefined), "/r"), false);
  assert.equal(setRoot(nav, "p1", at("/r/a"), null), false);
  assert.equal(nav.size, 0);
});

test("upOf gives the parent, null at / and at a drive root", () => {
  assert.equal(upOf("/r/a"), "/r");
  assert.equal(upOf("/r/a/"), "/r");
  assert.equal(upOf("/r"), "/");
  assert.equal(upOf("/"), null);
  assert.equal(upOf("//"), null);
  assert.equal(upOf(""), null);
  assert.equal(upOf(undefined), null);
  assert.equal(upOf("C:\\Users\\me"), "C:\\Users");
  assert.equal(upOf("C:\\Users"), "C:\\");
  assert.equal(upOf("C:\\"), null);
});

const state = (folders, file = null, packages = [], lastOpened = file) => ({ folders: new Set(folders), packages: new Set(packages), file, lastOpened });
const plain = (s) => ({ folders: [...s.folders].sort(), packages: [...s.packages].sort(), file: s.file, lastOpened: s.lastOpened });

test("carry up keeps expanded folders and the open file, and opens the old root", () => {
  assert.deepEqual(plain(carry(state(["src", "src/lib"], "src/lib/a.js", ["X.app"]), "/r/a", "/r")), {
    folders: ["a", "a/src", "a/src/lib"], packages: ["a/X.app"], file: "a/src/lib/a.js", lastOpened: "a/src/lib/a.js",
  });
  assert.deepEqual(plain(carry(state([]), "/r/a/b", "/r")), { folders: ["a", "a/b"], packages: [], file: null, lastOpened: null });
  assert.deepEqual(plain(carry(state(["x"]), "/r", "/")), { folders: ["r", "r/x"], packages: [], file: null, lastOpened: null });
});

test("carry down keeps what lies inside the new root and drops the rest", () => {
  assert.deepEqual(plain(carry(state(["b", "b/c", "d"], "b/c/f.txt", ["b/Y.app"], "d/g"), "/r", "/r/b")), {
    folders: ["c"], packages: ["Y.app"], file: "c/f.txt", lastOpened: null,
  });
  assert.deepEqual(plain(carry(state(["d"], "d/g"), "/r", "/r/b")), { folders: [], packages: [], file: null, lastOpened: null });
  assert.deepEqual(plain(carry(state(["b"], "b"), "/r", "/r/b")), { folders: [], packages: [], file: null, lastOpened: null });
});

test("carry to an unrelated folder keeps nothing; to the same folder everything", () => {
  assert.deepEqual(plain(carry(state(["b"], "b/x"), "/r/a", "/q")), { folders: [], packages: [], file: null, lastOpened: null });
  assert.deepEqual(plain(carry(state(["b"], "b/x"), "/r/a", "/r/ab")), { folders: [], packages: [], file: null, lastOpened: null });
  assert.deepEqual(plain(carry(state(["b"], "b/x"), "/r/a", "/r/a")), { folders: ["b"], packages: [], file: "b/x", lastOpened: "b/x" });
});

test("headerPath shows the home folder as ~", () => {
  assert.equal(headerPath("/home/u/git/p", "/home/u"), "~/git/p");
  assert.equal(headerPath("/home/u", "/home/u"), "~");
  assert.equal(headerPath("/home/user2", "/home/u"), "/home/user2");
  assert.equal(headerPath("/srv", null), "/srv");
  assert.equal(headerPath("/", "/home/u"), "/");
});

test("frontTruncate cuts at the front, at a folder boundary when it can", () => {
  assert.equal(frontTruncate("~/git/project", 20), "~/git/project");
  assert.equal(frontTruncate("~/git/projects/herdr/filer", 16), "…/herdr/filer");
  assert.equal(frontTruncate("~/averyveryverylongname", 8), "…ongname");
  assert.equal(frontTruncate("~/abc", 1), "…");
  assert.equal(frontTruncate("", 5), "");
});

test("topOf: / or the drive root", () => {
  assert.equal(topOf("/r/a"), "/");
  assert.equal(topOf("/"), "/");
  assert.equal(topOf("C:\\Users\\me"), "C:\\");
  assert.equal(topOf("C:"), "C:\\");
  assert.equal(topOf(""), null);
  assert.equal(topOf(undefined), null);
});

test("carry up lists the old root and its parents before the folders below it", () => {
  assert.deepEqual([...carry(state(["x/y"]), "/r/a/b", "/r").folders], ["a", "a/b", "a/b/x/y"]);
});

test("watchable: not / and not a folder above home", () => {
  assert.equal(watchable("/", "/Users/u"), false);
  assert.equal(watchable("/Users", "/Users/u"), false);
  assert.equal(watchable("/Users/", "/Users/u"), false);
  assert.equal(watchable("C:\\", null), false);
  assert.equal(watchable("/Users/u", "/Users/u"), true);
  assert.equal(watchable("/Users/u/git", "/Users/u"), true);
  assert.equal(watchable("/srv", "/Users/u"), true);
  assert.equal(watchable("/Users/u2", "/Users/u"), true);
  assert.equal(watchable("/srv", null), true);
});

test("Windows paths: carry to a drive root, watchable and ~ with backslashes", () => {
  assert.deepEqual(plain(carry(state(["x"], "x\\y.txt"), "C:\\a", "C:\\")), { folders: ["a", "a/x"], packages: [], file: "a/x\\y.txt", lastOpened: "a/x\\y.txt" });
  assert.deepEqual(plain(carry(state(["x"]), "C:\\a", "C:\\ab")), { folders: [], packages: [], file: null, lastOpened: null });
  assert.equal(watchable("C:\\Users", "C:\\Users\\me"), false);
  assert.equal(watchable("C:\\Users\\me\\git", "C:\\Users\\me"), true);
  assert.equal(headerPath("C:\\Users\\me\\git", "C:\\Users\\me"), "~\\git");
});
