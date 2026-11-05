// Throwaway folders below the gitignored tmp/ of the repo, removed again when the importing test file is done.
// Every test that needs a scratch folder takes it from here: never os.tmpdir(), $TMPDIR or a path outside the repo
// (checked by test/tmp-helper.test.js).
import { after } from "node:test";
import fs from "node:fs";
import path from "node:path";

export const TMP = path.resolve(import.meta.dirname, "..", "tmp");
const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

export function mkTmpSync(prefix) {
  fs.mkdirSync(TMP, { recursive: true });
  const d = fs.mkdtempSync(path.join(TMP, prefix));
  made.push(d);
  return d;
}

export async function mkTmp(prefix) {
  await fs.promises.mkdir(TMP, { recursive: true });
  const d = await fs.promises.mkdtemp(path.join(TMP, prefix));
  made.push(d);
  return d;
}
