// Update check: at most one request per day to the latest GitHub release, a hint in the panel when it is newer.
// Pure logic; the host's fetch and timer come in as functions. Every failure is silent and counts as a check.
const REPO = "Srv-02/herdr-filerpro";
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
export const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 30000;

// Semver 2.0 (MAJOR.MINOR.PATCH[-pre][+build]) with one optional leading v; null for anything else.
const SEMVER = /^[vV]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export function parseVersion(s) {
  const m = typeof s === "string" ? SEMVER.exec(s) : null;
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [] };
}

// -1, 0 or 1 by semver precedence (build metadata ignored); null when one side is not a version.
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  // A release ranks above its pre-releases.
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = typeof p === "number", qn = typeof q === "number";
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

// The installed version from the text of mod.json; null when it cannot be read.
export function localVersion(text) {
  try {
    const v = JSON.parse(text)?.version;
    return parseVersion(v) ? v : null;
  } catch { return null; }
}

// The release page is built from the tag, never taken from the response or shared state.
export const releaseUrl = (tag) => `https://github.com/${REPO}/releases/tag/${encodeURIComponent(tag)}`;

// state: shared("filer-pro.update") = { at, local, latest }: time of the last check, the version installed then,
// the last known release tag (null until one was seen). Due after 24 h, at once after a mod update
// (the stored local version differs) or when the clock moved back past the stored time.
export function checkDue(state, local, now) {
  if (!state || typeof state.at !== "number") return true;
  return state.local !== local || state.at > now || now - state.at >= UPDATE_INTERVAL_MS;
}

// One request; the tag_name of the latest release, or null (no release yet, rate limit, offline, bad JSON, timeout).
export async function fetchLatest(fetchFn, sleep) {
  if (typeof fetchFn !== "function") return null;
  const ask = (async () => {
    const res = await fetchFn(RELEASES_API, { headers: { Accept: "application/vnd.github+json", "User-Agent": "filer-pro-update-check" } });
    if (res?.status !== 200) return null;
    const body = typeof res.text === "function" ? JSON.parse(await res.text()) : await res.json();
    const tag = body?.tag_name;
    return parseVersion(tag) ? tag : null;
  })().catch(() => null);
  const timeout = Promise.resolve().then(() => sleep(FETCH_TIMEOUT_MS)).then(() => null, () => null);
  return Promise.race([ask, timeout]);
}

// The decision of one lease-holder pass. `request` says whether fetch ran; `state` is present when
// shared("filer-pro.update") must be written (null clears an old hint once the check is turned off).
// A failed request keeps the last known release, so being offline for a day does not hide a hint.
export async function updateCheck({ enabled, state, local, now, fetch }) {
  if (!enabled) return state != null ? { request: false, state: null } : { request: false };
  if (!local || !checkDue(state, local, now)) return { request: false };
  const latest = (await fetch()) ?? (parseVersion(state?.latest) ? state.latest : null);
  return { request: true, state: { at: now, local, latest } };
}

// { version, url } when the stored release is newer than the version this copy runs (`local`, from its own
// mod.json), else null. Compared here and not with state.local, so an update of the mod hides the hint at once.
export function updateHint(state, local) {
  if (!state || typeof state !== "object" || compareVersions(state.latest, local) !== 1) return null;
  return { version: state.latest.replace(/^[vV]/, ""), url: releaseUrl(state.latest) };
}

// When the lease holder runs a pass (reads the config and maybe asks GitHub): at once on becoming holder, then
// at most once per hour, never two at a time. The pass itself decides with checkDue whether a request is due.
export const ATTEMPT_MS = 60 * 60 * 1000;
export function createUpdateGate(now) {
  let next = 0, busy = false;
  return {
    take(holding) {
      if (!holding) { next = 0; return false; }
      if (busy || now() < next) return false;
      busy = true; next = now() + ATTEMPT_MS;
      return true;
    },
    done() { busy = false; },
  };
}
