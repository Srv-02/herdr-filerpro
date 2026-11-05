// Lease: exactly one mod copy drives the jobs. The holder rewrites the shared key every 5 s (each write
// re-renders every mod); others take over when the lease is older than 15 s (or missing).
export const LEASE_TTL_MS = 15000;
export const LEASE_RENEW_MS = 5000;

// `write` says whether the lease must be stored now; `at` stays the stored value while the holder is not renewing.
export function leaseNext(current, me, now) {
  const fresh = current && typeof current.at === "number";
  if (fresh && current.owner === me) return now - current.at >= LEASE_RENEW_MS ? { owner: me, at: now, mine: true, write: true } : { owner: me, at: current.at, mine: true, write: false };
  if (!fresh || now - current.at > LEASE_TTL_MS) return { owner: me, at: now, mine: true, write: true };
  return { owner: current.owner, at: current.at, mine: false, write: false };
}

// Keys of the pre-rename mods (fileshare, file-pro) that still hold a value in shared.json; setShared cannot delete, null is the cleared state.
const KEY_NAMES = ["answer", "changed", "clipboard", "jobs", "last_download", "lease", "pending", "show", "shown"];
const LEGACY_KEYS = ["fileshare", "file-pro"].flatMap((prefix) => KEY_NAMES.map((k) => prefix + "." + k));
export const staleLegacyKeys = (get) => LEGACY_KEYS.filter((k) => get(k) != null);
