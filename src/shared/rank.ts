// Fractional ranks: a card's position is a string that sorts between its
// neighbours, so a move only rewrites the moved card (no renumbering of the
// whole column, no write fan-out, and two people reordering different cards
// never touch the same row).
//
// Keys are base-62 digit strings with no trailing "0" (the smallest digit),
// which guarantees there is always room between any two distinct keys.

export const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Longest rank the server accepts. Appending to the end of one column grows a
 * key by one character about every 31 appends (see `step`), so this allows
 * roughly 4,000 consecutive appends before a column would need rebalancing. */
export const MAX_RANK_LENGTH = 128;

export function isValidRank(key: unknown): key is string {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_RANK_LENGTH) return false;
  if (key.endsWith("0")) return false;
  for (const ch of key) if (!DIGITS.includes(ch)) return false;
  return true;
}

function midpoint(a: string, b: string | null): string {
  // Invariant: a < b (b === null means "+infinity"), neither has a trailing "0".
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? DIGITS[0]) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0]!) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]!) : DIGITS.length;
  if (digitB - digitA > 1) {
    return DIGITS[Math.round((digitA + digitB) / 2)]!;
  }
  // Adjacent digits: keep a's first digit and recurse on the tail.
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA]! + midpoint(a.slice(1), null);
}

/**
 * A key strictly between `before` and `after`. Either side may be null
 * (start / end of the list). Throws if before >= after.
 */
export function rankBetween(before: string | null, after: string | null): string {
  if (before !== null && !isValidRank(before)) throw new Error(`invalid rank: ${before}`);
  if (after !== null && !isValidRank(after)) throw new Error(`invalid rank: ${after}`);
  if (before !== null && after !== null && before >= after) {
    throw new Error(`rankBetween: ${before} >= ${after}`);
  }
  if (before !== null && after === null) return stepUp(before);
  if (before === null && after !== null) return stepDown(after);
  return midpoint(before ?? "", after);
}

// Appending to the end (and prepending to the start) is by far the most common
// insert on a kanban board. Halving the gap each time would add a character
// every ~5 appends; stepping one digit at a time adds one every ~31.
function stepUp(key: string): string {
  const d = DIGITS.indexOf(key[0]!);
  if (d < DIGITS.length - 1) return DIGITS[d + 1]!;
  return key[0]! + (key.length > 1 ? stepUp(key.slice(1)) : midpoint("", null));
}

function stepDown(key: string): string {
  const d = DIGITS.indexOf(key[0]!);
  if (d >= 2) return DIGITS[d - 1]!;
  // "1…" → "0z"; "0…" → "0" + one step below the rest. A lone "0" is invalid.
  if (d === 1) return DIGITS[0]! + DIGITS[DIGITS.length - 1]!;
  return DIGITS[0]! + stepDown(key.slice(1));
}
