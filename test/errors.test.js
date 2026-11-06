import { test } from "node:test";
import assert from "node:assert/strict";
import { explainError } from "../mods/filer-pro/lib/errors.js";

test("known patterns", () => {
  assert.equal(explainError("Host key verification failed."), "Unknown host key. Connect once in a terminal: ssh <host>");
  assert.equal(explainError("Host key verification failed.", "box"), "Unknown host key. Connect once in a terminal: ssh box");
  assert.equal(explainError("x\nPermission denied (publickey)\n"), "SSH login failed (key not loaded?)");
  assert.equal(explainError("No space left on device"), "Disk full");
  assert.equal(explainError("scp: Operation not permitted"), "Not permitted: macOS privacy settings, owner, or a locked item."); // no machine: this computer
  assert.equal(explainError("Connection timed out"), "Machine not reachable");
  assert.equal(explainError("ssh: Could not resolve hostname box"), "Machine not reachable");
});

test("priority follows list order", () => {
  assert.equal(explainError("Permission denied (publickey)\nNo space left on device"), "SSH login failed (key not loaded?)");
});

test("fallback", () => {
  assert.equal(explainError("a\n  boom  \n\n \n"), "boom");
  assert.equal(explainError(""), "Transfer failed");
  assert.equal(explainError("  \n "), "Transfer failed");
  assert.equal(explainError(undefined), "Transfer failed");
});

test("unknown machine", () => {
  assert.equal(explainError('`herdr.exec`: unknown machine "no-such-machine-stand-1"'), "Unknown machine: no-such-machine-stand-1");
});

test("target folder problems from scp and cp", () => {
  assert.equal(explainError('scp: open local "/x/.a.txt.fs-k3.part": No such file or directory'), "Target folder does not exist");
  assert.equal(explainError('scp: dest open "/srv/in/.a.txt.fs-k3.part": No such file or directory'), "Target folder does not exist");
  assert.equal(explainError('scp: open local "/.a.txt.fs-k3.part": Read-only file system'), "Cannot write to the target folder: Read-only file system");
  assert.equal(explainError('scp: open local "/x": Permission denied'), "Cannot write to the target folder: Permission denied");
  assert.equal(explainError("cp: /x/.a.part: Read-only file system"), "Cannot write to the target folder: Read-only file system");
  assert.equal(explainError("cp: /x/.a.part: Permission denied"), "Cannot write to the target folder: Permission denied");
});

test("old table wins over the target folder rules", () => {
  assert.equal(explainError('scp: open local "/x": Operation not permitted', "u@box"), "Not permitted: macOS privacy settings, owner, or a locked item.");
  assert.equal(explainError('scp: open local "/x": No space left on device'), "Disk full");
});

test("no shown text ends in a carriage return or whitespace", () => {
  assert.equal(explainError('scp: open local "/.a.txt.fs-k3.part": Read-only file system\r\n'), "Cannot write to the target folder: Read-only file system");
  assert.equal(explainError('x\r\nscp: open local "/.a.txt.fs-k3.part": Read-only file system\r'), "Cannot write to the target folder: Read-only file system");
  assert.equal(explainError("a\r\nboom\r\n"), "boom");
  assert.equal(explainError("boom \r"), "boom");
  assert.equal(explainError("x\r\nNo space left on device\r\n"), "Disk full");
  assert.equal(explainError('x\r\nunknown machine "m1"\r\n'), "Unknown machine: m1");
});

test("long messages are never shortened, the place of the old entry stays (#34)", () => {
  const msg = `Could not move: /Users/m/${"x".repeat(120)}/a.txt. The old entry is now in: /Users/m/${"y".repeat(120)}/.a.txt.fs-move.1`;
  assert.equal(explainError(msg), msg);
  assert.equal(explainError("x".repeat(300)), "x".repeat(300));
});

test("empty stderr gives the fallback of the caller, never an empty message (#34)", () => {
  assert.equal(explainError("", null, "Could not delete"), "Could not delete");
  assert.equal(explainError(" \r\n ", "box", "Could not rename"), "Could not rename");
  assert.equal(explainError(undefined, null, "Could not move"), "Could not move");
  assert.equal(explainError("", null, ""), "Transfer failed");
  assert.equal(explainError("", null, "  "), "Transfer failed");
  assert.equal(explainError("boom", null, "Could not delete"), "boom"); // a real message wins
});

test("EPERM on a remote machine never shows the macOS hint (#30)", () => {
  assert.equal(explainError("chmod: changing permissions of 'x': Operation not permitted", "box"), "Not permitted (owner, sticky folder or locked item)");
  assert.equal(explainError("scp: dest open \"/srv/x\": Operation not permitted", "u@box"), "Not permitted (owner, sticky folder or locked item)");
  assert.equal(explainError("rm: cannot remove 'x': Operation not permitted", "box", "Could not delete"), "Not permitted (owner, sticky folder or locked item)");
});

test("EPERM on the local write of a download on macOS keeps the macOS text (#30)", () => {
  assert.equal(explainError('scp: open local "/Users/m/Documents/.a.part": Operation not permitted', "u@box"), "Not permitted: macOS privacy settings, owner, or a locked item.");
  assert.equal(explainError('scp: open local "/Users/m/Documents/.a.part": Operation not permitted', "u@box", undefined, { localPlatform: "macos" }), "Not permitted: macOS privacy settings, owner, or a locked item.");
});

test("EPERM on this computer other than macOS gets the neutral text (#30)", () => {
  assert.equal(explainError("Error: Operation not permitted", null, undefined, { localPlatform: "windows" }), "Not permitted (owner, sticky folder or locked item)");
  assert.equal(explainError('scp: open local "/x": Operation not permitted', "u@box", undefined, { localPlatform: "windows" }), "Not permitted (owner, sticky folder or locked item)");
});
