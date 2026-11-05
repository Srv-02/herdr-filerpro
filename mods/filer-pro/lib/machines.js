const UNREADABLE = { error: "Cannot read the machine list" };

export function sshTarget(machineLsJson, machine) {
  let data;
  try {
    data = JSON.parse(machineLsJson);
  } catch {
    return { ...UNREADABLE };
  }
  const list = data && data.machines;
  if (!Array.isArray(list)) return { ...UNREADABLE };
  const entry = list.find((m) => m && m.name === machine);
  if (!entry) return { error: `Unknown machine: ${machine}` };
  if (entry.via === true || (typeof entry.via === "string" && entry.via !== "")) {
    return { error: `${machine} is connected via a command, not SSH; filer-pro needs SSH` };
  }
  for (const key of ["target", "ssh", "host"]) {
    if (typeof entry[key] === "string" && entry[key] !== "") return { target: entry[key] };
  }
  return { ...UNREADABLE };
}
