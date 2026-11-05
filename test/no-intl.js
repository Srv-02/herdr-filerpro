// Runs fn as on herdr's QuickJS-ng engine, which has no Intl: Intl is gone and toLocaleString returns plain digits.
// Tests of UI text wrap their asserts in it, so they cannot pass by leaning on Node's Intl.
export async function withoutIntl(fn) {
  const intl = Object.getOwnPropertyDescriptor(globalThis, "Intl");
  const toLocale = Number.prototype.toLocaleString;
  delete globalThis.Intl;
  Number.prototype.toLocaleString = function () { return String(this); };
  try {
    return await fn();
  } finally {
    Number.prototype.toLocaleString = toLocale;
    Object.defineProperty(globalThis, "Intl", intl);
  }
}
