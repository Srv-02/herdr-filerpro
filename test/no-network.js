// Loaded before every test file (package.json: node --import ./test/no-network.js --test). No test may reach the
// network: the real fetch is replaced by one that rejects, and a test during which it was called fails afterwards,
// also when the code under test swallowed the rejection (main.js runs its update pass in a try/catch). A test that
// needs an answer from GitHub passes its own fake fetch or sets globalThis.fetch for its duration.
import { afterEach } from "node:test";

const calls = [];
export function networkFetch(input) {
  const url = String(input?.url ?? input);
  calls.push(url);
  return Promise.reject(new Error(`a test reached the network: fetch(${url})`));
}
globalThis.fetch = networkFetch;

afterEach(() => {
  if (!calls.length) return;
  const urls = calls.splice(0);
  throw new Error(`the test called the real fetch (${urls.join(", ")}); give it a fake fetch`);
});
