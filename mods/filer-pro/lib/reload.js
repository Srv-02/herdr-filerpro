// Tree reloads after filer-pro.changed (New Folder, Rename, Delete, every finished job): a batch of 100 jobs
// must not reload every open folder 100 times. At most one reload per gapMs and never while a load runs; a
// signal that arrives meanwhile is kept and caught up afterwards, so none is lost.
// signal(at): the current filer-pro.changed.at; true when it is new. take(loading): true when a reload starts now.
export function createReloadGate({ now, gapMs = 1000, at = null }) {
  let seen = at, dirty = false, last = -Infinity;
  return {
    signal(next) {
      if (next === seen) return false;
      seen = next;
      dirty = true;
      return true;
    },
    take(loading) {
      if (!dirty || loading || now() - last < gapMs) return false;
      dirty = false;
      last = now();
      return true;
    },
  };
}
