// Number formatting for UI text. Pure, and free of Intl: herdr runs the mod on QuickJS-ng, which has no Intl, so
// the locale formatting of Number gives plain digits there (scripts/lint.mjs rejects it in the mod).

// 10000 -> "10,000".
export const group = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
