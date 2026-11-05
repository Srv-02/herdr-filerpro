import { test } from "node:test";
import assert from "node:assert/strict";
import { platform } from "../mods/filer-pro/lib/platform.js";

test("revealArgs", () => {
  assert.deepEqual(platform.revealArgs("/a/b"), ["open", ["-R", "/a/b"]]);
});
test("trashDir", () => {
  assert.equal(platform.trashDir("/Users/me"), "/Users/me/.Trash");
});
test("pathKey ignores letter case", () => {
  assert.equal(platform.pathKey("/Users/Me/Proj"), "/users/me/proj");
});
test("openArgs", () => {
  assert.deepEqual(platform.openArgs("/a/b.html"), ["open", ["/a/b.html"]]);
});

test("pathKey ignores Unicode normalization (APFS): NFD and NFC give the same key", () => {
  assert.equal(platform.pathKey("/x/Ünter"), platform.pathKey("/x/Ünter"));
  assert.equal(platform.pathKey("/x/ÜNTER"), "/x/ünter");
});

test("previewArgs opens the file with Preview.app", () => {
  assert.deepEqual(platform.previewArgs("/a/b.pdf"), ["open", ["-a", "Preview", "/a/b.pdf"]]);
});
test("clipboardArgs pipes the text into pbcopy as an argument, never inside the script", () => {
  const text = `-n "a" $(x) 'b'\nline2 %s`;
  const [cmd, args] = platform.clipboardArgs(text);
  assert.equal(cmd, "sh");
  assert.deepEqual(args, ["-c", 'printf %s "$1" | LC_ALL=en_US.UTF-8 pbcopy', "sh", text]);
  assert.equal(args[1].includes("line2"), false);
});

test("quarantineArgs sets the quarantine flag with the time in hex seconds, the path only as an argument", () => {
  assert.deepEqual(platform.quarantineArgs("/a/b c.pdf", 0x69c0f0a0 * 1000 + 999), ["xattr", ["-w", "com.apple.quarantine", "0081;69c0f0a0;Filer Pro;", "/a/b c.pdf"]]);
  assert.equal(platform.quarantineArgs("/x", 1500)[1][2], "0081;1;Filer Pro;");
});
