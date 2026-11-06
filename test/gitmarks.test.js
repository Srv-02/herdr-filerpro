// The git dir watch for a root inside a repository above it: the place parsed from one rev-parse, the folders to
// watch and which batches can change a mark.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { mkTmpSync } from "./tmp-helper.js";
import { GIT_PLACE_ARGS, gitPlace, gitWatchDirs, gitWatchHit } from "../mods/filer-pro/lib/gitmarks.js";

const git = (cwd, ...args) => { const r = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout; };

test("gitPlace: a subfolder of a main worktree resolves the relative common dir against the physical folder", () => {
  assert.deepEqual(gitPlace("sub/x/\n/r/.git\n../../.git\n/r\n"), { prefix: "sub/x/", gitDir: "/r/.git", commonDir: "/r/.git" });
  assert.deepEqual(gitPlace("\n/r/.git\n.git\n/r\n"), { prefix: "", gitDir: "/r/.git", commonDir: "/r/.git" });
  assert.deepEqual(gitPlace("s/\n/r/.git/worktrees/w\n/r/.git\n/w\n"), { prefix: "s/", gitDir: "/r/.git/worktrees/w", commonDir: "/r/.git" });
  assert.deepEqual(gitPlace("s/\nC:/r/.git\n../.git\nC:/r\n"), { prefix: "s/", gitDir: "C:/r/.git", commonDir: "C:/r/.git" });
});

test("gitPlace: output without the four lines is no place", () => {
  for (const out of ["", "sub/\n", "sub/\n--absolute-git-dir\n--git-common-dir\n--show-toplevel\n", "s/\n/r/.git\n\n/r\n"]) assert.equal(gitPlace(out), null, JSON.stringify(out));
});

test("gitPlace: matches the real git in a subfolder, a linked worktree and a separate git dir", () => {
  const base = fs.realpathSync(mkTmpSync("gitplace-"));
  const top = path.join(base, "top");
  fs.mkdirSync(path.join(top, "sub", "deep"), { recursive: true });
  git(top, "init", "-q");
  fs.writeFileSync(path.join(top, "sub", "a.txt"), "a\n");
  git(top, "add", "."); git(top, "commit", "-qm", "i");
  const sub = gitPlace(git(path.join(top, "sub", "deep"), ...GIT_PLACE_ARGS.slice(0)));
  assert.deepEqual(sub, { prefix: "sub/deep/", gitDir: path.join(top, ".git"), commonDir: path.join(top, ".git") });
  assert.deepEqual(gitWatchDirs(sub), [path.join(top, ".git")]);
  assert.equal(gitPlace(git(top, ...GIT_PLACE_ARGS)).prefix, "");
  assert.deepEqual(gitWatchDirs(gitPlace(git(top, ...GIT_PLACE_ARGS))), [], "the repository top: the root watch sees .git");

  git(top, "worktree", "add", "-q", path.join(base, "wt"), "-b", "w");
  const wt = gitPlace(git(path.join(base, "wt", "sub"), ...GIT_PLACE_ARGS));
  assert.deepEqual(wt, { prefix: "sub/", gitDir: path.join(top, ".git", "worktrees", "wt"), commonDir: path.join(top, ".git") });
  assert.deepEqual(gitWatchDirs(wt), [path.join(top, ".git")], "the common dir holds the worktree's git dir: one watch");

  const sep = path.join(base, "sep");
  fs.mkdirSync(path.join(sep, "sub"), { recursive: true });
  git(sep, "init", "-q", "--separate-git-dir", path.join(base, "sep.git"));
  const s = gitPlace(git(path.join(sep, "sub"), ...GIT_PLACE_ARGS));
  assert.deepEqual(gitWatchDirs(s), [path.join(base, "sep.git")], "a separate git dir is watched where it is");
});

test("gitWatchDirs: a git dir outside the common dir is watched as well", () => {
  assert.deepEqual(gitWatchDirs({ prefix: "s/", gitDir: "/g", commonDir: "/c" }), ["/g", "/c"]);
  assert.deepEqual(gitWatchDirs(null), []);
});

test("gitWatchHit: index, HEAD, refs and packed-refs count; objects, logs, locks and another worktree's index do not", () => {
  const main = { gitDir: "/r/.git", commonDir: "/r/.git" };
  for (const p of ["/r/.git/index", "/r/.git/HEAD", "/r/.git/refs/heads/main", "/r/.git/packed-refs", "/r/.git", "/elsewhere/x"]) assert.equal(gitWatchHit([p], main), true, p);
  for (const p of ["/r/.git/objects/ab/cdef", "/r/.git/logs/HEAD", "/r/.git/logs/refs/heads/main", "/r/.git/index.lock", "/r/.git/ORIG_HEAD", "/r/.git/COMMIT_EDITMSG", "/r/.git/worktrees/w/index"]) assert.equal(gitWatchHit([p], main), false, p);
  const wt = { gitDir: "/r/.git/worktrees/w", commonDir: "/r/.git" };
  for (const p of ["/r/.git/worktrees/w/index", "/r/.git/worktrees/w/HEAD", "/r/.git/refs/heads/w"]) assert.equal(gitWatchHit([p], wt), true, p);
  for (const p of ["/r/.git/index", "/r/.git/HEAD", "/r/.git/worktrees/w/logs/HEAD", "/r/.git/worktrees/other/index"]) assert.equal(gitWatchHit([p], wt), false, p);
  assert.equal(gitWatchHit(["C:\\r\\.git\\index"], { gitDir: "C:/r/.git", commonDir: "C:/r/.git" }), true, "Windows separators");
  assert.equal(gitWatchHit([], main), true, "a batch without paths falls back to a refresh");
});
