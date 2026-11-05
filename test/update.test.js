import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RELEASES_API, UPDATE_INTERVAL_MS, parseVersion, compareVersions, localVersion, releaseUrl, checkDue, fetchLatest, fetchRelease, updateCheck, updateHint, createUpdateGate, ATTEMPT_MS,
} from "../mods/filer-pro/lib/update.js";

const DAY = 24 * 60 * 60 * 1000;
const never = () => new Promise(() => {});

test("parseVersion strips one leading v and rejects what is not semver", () => {
  assert.deepEqual(parseVersion("v1.2.3"), { core: [1, 2, 3], pre: [] });
  assert.deepEqual(parseVersion("V1.2.3"), { core: [1, 2, 3], pre: [] });
  assert.deepEqual(parseVersion("1.0.0-rc.1+build.5"), { core: [1, 0, 0], pre: ["rc", 1] });
  for (const bad of ["", "1.2", "1.2.3.4", "vv1.2.3", "01.2.3", "1.2.3-", "1.2.3-01", "latest", null, undefined, 5, " 1.2.3"]) assert.equal(parseVersion(bad), null, String(bad));
});

test("compareVersions orders by semver precedence, with or without v", () => {
  assert.equal(compareVersions("v1.0.1", "1.0.0"), 1);
  assert.equal(compareVersions("1.0.0", "v1.0.0"), 0);
  assert.equal(compareVersions("1.9.0", "1.10.0"), -1);
  assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
  assert.equal(compareVersions("v1.0.0+abc", "1.0.0"), 0, "build metadata is ignored");
});

test("compareVersions: a pre-release is older than its release and ordered by its identifiers", () => {
  assert.equal(compareVersions("1.1.0-beta", "1.1.0"), -1);
  assert.equal(compareVersions("v1.1.0-rc.1", "1.0.0"), 1);
  const order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
  for (let i = 0; i + 1 < order.length; i++) {
    assert.equal(compareVersions(order[i], order[i + 1]), -1, `${order[i]} < ${order[i + 1]}`);
    assert.equal(compareVersions(order[i + 1], order[i]), 1, `${order[i + 1]} > ${order[i]}`);
  }
});

test("compareVersions gives null when one side is not a version", () => {
  assert.equal(compareVersions("latest", "1.0.0"), null);
  assert.equal(compareVersions("1.0.0", null), null);
});

test("localVersion reads the version from mod.json text", () => {
  assert.equal(localVersion('{ "place": "none", "version": "1.0.0" }'), "1.0.0");
  for (const bad of [null, "", "{nope", '{"place":"none"}', '{"version":"one"}', '{"version":1}']) assert.equal(localVersion(bad), null, String(bad));
});

test("releaseUrl builds the release page of the tag in this repo", () => {
  assert.equal(releaseUrl("v1.1.0"), "https://github.com/Srv-02/herdr-filerpro/releases/tag/v1.1.0");
  assert.equal(releaseUrl("v1.1.0/../x?y"), "https://github.com/Srv-02/herdr-filerpro/releases/tag/v1.1.0%2F..%2Fx%3Fy");
});

test("checkDue: once per 24 h, again at once after a mod update or a clock moved back", () => {
  const now = 10 * DAY;
  assert.equal(UPDATE_INTERVAL_MS, DAY);
  assert.equal(checkDue(null, "1.0.0", now), true);
  assert.equal(checkDue({ at: "x", local: "1.0.0" }, "1.0.0", now), true);
  assert.equal(checkDue({ at: now - DAY + 1, local: "1.0.0" }, "1.0.0", now), false);
  assert.equal(checkDue({ at: now - DAY, local: "1.0.0" }, "1.0.0", now), true);
  assert.equal(checkDue({ at: now - 1000, local: "0.9.0" }, "1.0.0", now), true, "the mod was updated");
  assert.equal(checkDue({ at: now + 60000, local: "1.0.0" }, "1.0.0", now), true, "the clock moved back");
});

// A fake fetch: records the calls and answers with `res` (or throws it when it is an Error).
function fakeFetch(res) {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, opts }); if (res instanceof Error) throw res; return res; };
  return { fn, calls };
}
const ok = (body) => ({ status: 200, ok: true, json: async () => body });

test("fetchLatest asks the GitHub API with Accept and User-Agent and returns the tag", async () => {
  const f = fakeFetch(ok({ tag_name: "v1.2.0", html_url: "https://evil.example.com" }));
  assert.equal(await fetchLatest(f.fn, never), "v1.2.0");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, RELEASES_API);
  assert.equal(RELEASES_API, "https://api.github.com/repos/Srv-02/herdr-filerpro/releases/latest");
  assert.equal(f.calls[0].opts.headers.Accept, "application/vnd.github+json");
  assert.ok(f.calls[0].opts.headers["User-Agent"]);
});

test("fetchLatest reads the body with text() when the response has it", async () => {
  assert.equal(await fetchLatest(fakeFetch({ status: 200, text: async () => '{"tag_name":"v1.0.1"}' }).fn, never), "v1.0.1");
  assert.equal(await fetchLatest(fakeFetch({ status: 200, text: async () => "<html>" }).fn, never), null);
});

test("fetchRelease tells no release (tag null) apart from a failed request (error)", async () => {
  assert.deepEqual(await fetchRelease(fakeFetch(ok({ tag_name: "v1.2.0" })).fn, never), { tag: "v1.2.0" });
  assert.deepEqual(await fetchRelease(fakeFetch({ status: 404, ok: false, json: async () => ({}) }).fn, never), { tag: null });
  const failed = {
    "403 (rate limit)": { status: 403, ok: false, json: async () => ({}) },
    "offline": new Error("network down"),
    "malformed JSON": { status: 200, ok: true, json: async () => { throw new SyntaxError("bad"); } },
    "tag not a version": ok({ tag_name: "nightly" }),
    "no response": undefined,
  };
  for (const [name, res] of Object.entries(failed)) assert.ok((await fetchRelease(fakeFetch(res).fn, never)).error, name);
  assert.ok((await fetchRelease(() => never(), async () => {})).error, "timeout");
  assert.ok((await fetchRelease(null, never)).error, "no fetch in this runtime");
});

test("fetchLatest is null for no release, rate limit, errors, malformed JSON, a bad tag and a hanging request", async () => {
  const cases = {
    "404 (no release yet)": { status: 404, ok: false, json: async () => ({ message: "Not Found" }) },
    "403 (rate limit)": { status: 403, ok: false, json: async () => ({}) },
    "500": { status: 500, ok: false, json: async () => ({ tag_name: "v9.0.0" }) },
    "offline": new Error("network down"),
    "malformed JSON": { status: 200, ok: true, json: async () => { throw new SyntaxError("bad"); } },
    "no tag": ok({}),
    "tag not a version": ok({ tag_name: "nightly" }),
    "null body": ok(null),
    "no response": undefined,
  };
  for (const [name, res] of Object.entries(cases)) assert.equal(await fetchLatest(fakeFetch(res).fn, never), null, name);
  assert.equal(await fetchLatest(() => never(), async () => {}), null, "timeout");
  assert.equal(await fetchLatest(null, never), null, "no fetch in this runtime");
});

test("updateCheck: off means no request, and an old result is cleared", async () => {
  const f = fakeFetch(ok({ tag_name: "v2.0.0" }));
  const run = (state) => updateCheck({ enabled: false, state, local: "1.0.0", now: DAY, fetch: () => fetchLatest(f.fn, never) });
  assert.deepEqual(await run(null), { request: false });
  assert.deepEqual(await run({ at: 0, local: "1.0.0", latest: "v2.0.0" }), { request: false, state: null });
  assert.equal(f.calls.length, 0);
});

test("updateCheck: no request when the local version is unknown or the last check is under 24 h old", async () => {
  const f = fakeFetch(ok({ tag_name: "v2.0.0" }));
  const fetch = () => fetchLatest(f.fn, never);
  assert.deepEqual(await updateCheck({ enabled: true, state: null, local: null, now: DAY, fetch }), { request: false });
  assert.deepEqual(await updateCheck({ enabled: true, state: { at: DAY - 1, local: "1.0.0", latest: null }, local: "1.0.0", now: DAY, fetch }), { request: false });
  assert.equal(f.calls.length, 0);
});

test("updateCheck: a due check asks once and stores the result", async () => {
  const f = fakeFetch(ok({ tag_name: "v1.1.0" }));
  const out = await updateCheck({ enabled: true, state: null, local: "1.0.0", now: 5 * DAY, fetch: () => fetchLatest(f.fn, never) });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(out, { request: true, state: { at: 5 * DAY, local: "1.0.0", latest: "v1.1.0" } });
});

test("updateCheck: a failed check is stored too, so there is no retry before the next day", async () => {
  const f = fakeFetch(new Error("offline"));
  const out = await updateCheck({ enabled: true, state: null, local: "1.0.0", now: 5 * DAY, fetch: () => fetchLatest(f.fn, never) });
  assert.deepEqual(out, { request: true, state: { at: 5 * DAY, local: "1.0.0", latest: null } });
  assert.equal(checkDue(out.state, "1.0.0", 5 * DAY + DAY - 1), false);
  const kept = await updateCheck({ enabled: true, state: { at: 3 * DAY, local: "1.0.0", latest: "v1.1.0" }, local: "1.0.0", now: 5 * DAY, fetch: () => fetchLatest(f.fn, never) });
  assert.deepEqual(kept.state, { at: 5 * DAY, local: "1.0.0", latest: "v1.1.0" }, "a failure keeps the last known release");
  const garbage = await updateCheck({ enabled: true, state: { at: "x", latest: 7 }, local: "1.0.0", now: 5 * DAY, fetch: async () => null });
  assert.deepEqual(garbage.state, { at: 5 * DAY, local: "1.0.0", latest: null });
});

test("updateHint shows only a release newer than the installed version, with a link built from the tag", () => {
  const url = "https://github.com/Srv-02/herdr-filerpro/releases/tag/v1.1.0";
  assert.deepEqual(updateHint({ at: 1, latest: "v1.1.0" }, "1.0.0"), { version: "1.1.0", url });
  assert.deepEqual(updateHint({ at: 1, latest: "v1.1.0", url: "javascript:alert(1)" }, "1.0.0"), { version: "1.1.0", url }, "a stored url is never used");
  assert.equal(updateHint({ at: 1, local: "1.0.0", latest: "v1.1.0" }, "1.1.0"), null, "the mod was updated since the check");
  assert.equal(updateHint({ at: 1, latest: "v1.1.0" }, "1.2.0"), null, "installed is newer");
  assert.equal(updateHint({ at: 1, latest: "v1.1.0-rc.1" }, "1.1.0"), null, "pre-release of the installed version");
  assert.equal(updateHint({ at: 1, latest: "1.1.0-rc.1" }, "1.0.0")?.version, "1.1.0-rc.1", "a newer pre-release counts");
  assert.equal(updateHint({ at: 1, latest: null }, "1.0.0"), null, "failed check");
  assert.equal(updateHint({ at: 1, latest: "v1.1.0" }, null), null, "installed version unknown");
  for (const bad of [null, undefined, 5, "x", {}, { latest: 7 }, { latest: ["v2.0.0"] }]) assert.equal(updateHint(bad, "1.0.0"), null, JSON.stringify(bad));
});

test("createUpdateGate: only the lease holder, one pass at a time, again after an hour or on becoming holder", () => {
  let now = 0;
  const gate = createUpdateGate(() => now);
  assert.equal(ATTEMPT_MS, 60 * 60 * 1000);
  assert.equal(gate.take(false), false, "not the holder");
  assert.equal(gate.take(true), true, "first beat as holder");
  assert.equal(gate.take(true), false, "a pass is running");
  gate.done();
  now = ATTEMPT_MS - 1;
  assert.equal(gate.take(true), false, "within the hour");
  now = ATTEMPT_MS;
  assert.equal(gate.take(true), true, "an hour later");
  gate.done();
  now += 1000;
  assert.equal(gate.take(false), false, "lease lost");
  assert.equal(gate.take(true), true, "lease taken again: at once");
});
