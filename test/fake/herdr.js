// Recording fakes for the herdr APIs the job manager gets by injection (not a test itself).
import { SIZE_SCRIPT } from "../../mods/filer-pro/lib/sizes.js";
import { LINKS_SCRIPT } from "../../mods/filer-pro/lib/links.js";
import { PROBE_SCRIPT, READ_SCRIPT } from "../../mods/filer-pro/lib/textedit.js";
import { ARCHIVE_PROBE_SCRIPT, ARCHIVE_SIZE_SCRIPT, EXTRACT_STOP_SCRIPT } from "../../mods/filer-pro/lib/archives.js";
import { EXISTS_SCRIPT, LIST_SCRIPT, RESOLVE_SCRIPT, REPLACE_CHECK_SCRIPT } from "../../mods/filer-pro/lib/jobs.js";

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });

export function createFake(over = {}) {
  const f = {
    execCalls: [],
    hcCalls: [],
    notifications: [],
    store: {},
    files: {}, // path -> text, for readTextFile
    readErrors: {}, // path -> Error that readTextFile rejects with (over 1 MiB, invalid UTF-8)
    reads: [], // every path readTextFile was asked for
    probes: {}, // path -> stdout of PROBE_SCRIPT (absent: empty stdout)
    readOuts: {}, // path -> stdout of READ_SCRIPT, or { code, stdout, stderr } (absent: "missing")
    sizes: {}, // path -> bytes; absent means -1 (missing)
    sizeError: null, // Error to throw from the size probe
    sizeFlags: {}, // path -> "partial" | "timeout": the size probe appends it to the number, like SIZE_SCRIPT does
    sizeDelay: 0, // ms the clock jumps during a size probe
    existing: new Set(), // paths that exist (EXISTS_SCRIPT)
    dirs: new Set(), // paths that are directories
    symlinks: new Set(), // paths that are symlinks (EXISTS_SCRIPT prints l)
    listings: {}, // dir -> names (LIST_SCRIPT)
    resolved: {}, // dir -> physical path (RESOLVE_SCRIPT); absent means the path itself
    mounted: {}, // path -> message of REPLACE_CHECK_SCRIPT (a file system is mounted in the old target)
    resolveFail: false, // RESOLVE_SCRIPT prints nothing and exits 1
    archives: {}, // archive path -> { code, stdout, stderr } of ARCHIVE_PROBE_SCRIPT (absent: code 4)
    archiveSizes: {}, // archive path -> stdout of ARCHIVE_SIZE_SCRIPT, or { code, stdout, stderr } (absent: empty stdout)
    links: "total=0 outside=0 loop=0\n", // stdout of LINKS_SCRIPT
    linksCode: 0,
    linksReject: false,
    machineReject: null, // Error thrown by `hc machine ls`
    execCode: null, // {code, stderr} returned by the exists probe instead of its normal answer
    execReject: null, // Error thrown by every other exec
    machines: { machines: [{ name: "box", target: "user@box", via: false }] },
    runError: null, // stderr to fail `hc run` with
    getFail: false, // `hc get` fails (terminal unknown)
    terminals: {}, // address -> {state, reason?}
    t: 1_000_000,
    seq: 0,
    ...over,
  };
  f.now = () => f.t;
  f.newId = () => `id${++f.seq}`;
  f.appHome = () => "/Users/m/.config/herdr-app";
  f.home = () => "/Users/m";
  f.getShared = (k) => f.store[k];
  f.setShared = (k, v) => {
    f.store[k] = JSON.parse(JSON.stringify(v)); // like the persisted store: no shared references
    return null;
  };
  f.notify = (n) => {
    f.notifications.push(n);
    return "n1";
  };
  f.readTextFile = async (p) => {
    f.reads.push(p);
    if (f.readErrors[p]) throw f.readErrors[p];
    return f.files[p] ?? null;
  };
  f.jobs = () => f.store["filer-pro.jobs"] ?? {};
  f.hcRuns = () => f.hcCalls.filter((a) => a[0] === "run");
  f.execsOf = (cmd) => f.execCalls.filter((c) => c.cmd === cmd);

  f.exec = async (cmd, args = [], opts = {}) => {
    f.execCalls.push({ cmd, args, on: opts.on ?? null, ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}) });
    if (cmd === "sh" && args[0] === "-c") {
      const script = args[1];
      const path = args[3];
      if (script === SIZE_SCRIPT) {
        if (f.sizeError) throw f.sizeError;
        f.t += f.sizeDelay;
        f.onSize?.();
        return ok(`${f.sizes[path] ?? -1}${f.sizes[path] !== undefined && f.sizeFlags[path] ? ` ${f.sizeFlags[path]}` : ""}\n`);
      }
      if (script === ARCHIVE_PROBE_SCRIPT) return { stdout: "", stderr: "", ...(f.archives[args[5]] ?? { code: 4, stderr: "not an archive" }) };
      if (script === ARCHIVE_SIZE_SCRIPT) { const r = f.archiveSizes[args[4]] ?? ""; return typeof r === "string" ? ok(r) : { stdout: "", stderr: "", ...r }; }
      if (script === EXTRACT_STOP_SCRIPT) return ok();
      if (script === PROBE_SCRIPT) return ok(f.probes[path] ?? "");
      if (script === READ_SCRIPT) { const r = f.readOuts[path] ?? "missing\n"; return typeof r === "string" ? ok(r) : { stdout: "", stderr: "", ...r }; }
      if (script === EXISTS_SCRIPT && f.execCode?.(path)) return { stdout: "", ...f.execCode(path) };
      if (script === EXISTS_SCRIPT) return ok((f.existing.has(path) ? "y\n" : "") + (f.dirs.has(path) ? "d\n" : "") + (f.symlinks.has(path) ? "l\n" : ""));
      if (script === RESOLVE_SCRIPT) return f.resolveFail ? { code: 1, stdout: "", stderr: "" } : ok(`${f.resolved[path] ?? path}\n`);
      if (script === REPLACE_CHECK_SCRIPT) return ok(f.mounted[path] ? `${f.mounted[path]}\n` : "");
      if (script === LIST_SCRIPT) return ok((f.listings[path] ?? []).map((n) => `./${n}\0`).join(""));
      if (script === LINKS_SCRIPT) {
        if (f.linksReject) throw new Error("boom");
        return { code: f.linksCode, stdout: f.links, stderr: "" };
      }
    }
    if (f.execReject) throw f.execReject;
    return ok();
  };

  f.hc = async (args) => {
    f.hcCalls.push(args);
    const [verb] = args;
    if (verb === "machine") {
      if (f.machineReject) throw f.machineReject;
      return ok(JSON.stringify(f.machines));
    }
    if (verb === "run") {
      f.onRun?.();
      if (f.runError) return { code: 1, stdout: "", stderr: f.runError };
      const name = args[args.indexOf("--name") + 1];
      const address = `term-${name}`;
      f.terminals[address] = { state: "live" };
      return ok(JSON.stringify({ address, name, state: "live" }));
    }
    if (verb === "get") {
      const t = f.terminals[args[1]];
      if (f.getFail || !t) return { code: 1, stdout: "", stderr: "no such terminal" };
      return ok(JSON.stringify({ exit_code: null, ...t }));
    }
    if (verb === "kill") {
      f.terminals[args[1]] = { state: "finished", reason: "killed", signal: 1 };
      return ok();
    }
    return ok(); // rm
  };

  f.deps = () => ({
    exec: f.exec,
    hc: f.hc,
    readTextFile: f.readTextFile,
    getShared: f.getShared,
    setShared: f.setShared,
    notify: f.notify,
    now: f.now,
    newId: f.newId,
    appHome: f.appHome,
    home: f.home,
  });
  return f;
}
