import { test } from "node:test";
import assert from "node:assert/strict";
import { sshTarget } from "../mods/filer-pro/lib/machines.js";

const j = (m) => JSON.stringify({ machines: m });

test("plain ssh machine", () => {
  assert.deepEqual(sshTarget(j([{ name: "box", target: "box", via: false }]), "box"), { target: "box" });
  assert.deepEqual(sshTarget(j([{ name: "box", target: "box" }]), "box"), { target: "box" });
  assert.deepEqual(sshTarget(j([{ name: "box", target: "box", via: null }]), "box"), { target: "box" });
});

test("via command", () => {
  const err = { error: "box is connected via a command, not SSH; filer-pro needs SSH" };
  assert.deepEqual(sshTarget(j([{ name: "box", target: "box", via: true }]), "box"), err);
  assert.deepEqual(sshTarget(j([{ name: "box", target: "box", via: "cmd" }]), "box"), err);
});

test("unknown machine", () => {
  assert.deepEqual(sshTarget(j([{ name: "other", target: "o" }]), "box"), { error: "Unknown machine: box" });
});

test("unreadable list", () => {
  const err = { error: "Cannot read the machine list" };
  assert.deepEqual(sshTarget("{not json", "box"), err);
  assert.deepEqual(sshTarget("{}", "box"), err);
  assert.deepEqual(sshTarget('{"machines":"x"}', "box"), err);
  assert.deepEqual(sshTarget(j([{ name: "box" }]), "box"), err);
});

test("fallback fields", () => {
  assert.deepEqual(sshTarget(j([{ name: "box", ssh: "u@box" }]), "box"), { target: "u@box" });
  assert.deepEqual(sshTarget(j([{ name: "box", host: "example.com" }]), "box"), { target: "example.com" });
  assert.deepEqual(sshTarget(j([{ name: "box", ssh: "a", host: "b" }]), "box"), { target: "a" });
});
