import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DIGITS, isValidRank, rankBetween } from "../src/shared/rank.ts";

const validRank = fc
  .array(fc.constantFrom(...DIGITS), { minLength: 1, maxLength: 12 })
  .map((d) => d.join(""))
  .filter(isValidRank);

describe("rankBetween", () => {
  it("handles the open ends", () => {
    const first = rankBetween(null, null);
    expect(isValidRank(first)).toBe(true);
    expect(rankBetween(null, first) < first).toBe(true);
    expect(rankBetween(first, null) > first).toBe(true);
  });

  it("finds room between adjacent digits by going one level deeper", () => {
    const k = rankBetween("a", "b");
    expect(k > "a" && k < "b").toBe(true);
    expect(k.startsWith("a")).toBe(true);
  });

  it("property: result is strictly between and valid", () => {
    fc.assert(
      fc.property(validRank, validRank, (x, y) => {
        fc.pre(x !== y);
        const [lo, hi] = x < y ? [x, y] : [y, x];
        const k = rankBetween(lo, hi);
        return lo < k && k < hi && isValidRank(k);
      }),
      { numRuns: 2000 },
    );
  });

  it("property: open-ended inserts stay ordered", () => {
    fc.assert(
      fc.property(validRank, (x) => {
        const after = rankBetween(x, null);
        const before = rankBetween(null, x);
        return before < x && x < after && isValidRank(before) && isValidRank(after);
      }),
    );
  });

  it("property: any sequence of inserts keeps a strictly sorted list", () => {
    fc.assert(
      fc.property(fc.array(fc.nat(), { minLength: 1, maxLength: 200 }), (positions) => {
        const list: string[] = [];
        for (const p of positions) {
          const i = p % (list.length + 1);
          list.splice(i, 0, rankBetween(list[i - 1] ?? null, list[i] ?? null));
        }
        return list.every((k, i) => i === 0 || list[i - 1]! < k) && list.every(isValidRank);
      }),
    );
  });

  it("3,000 appends to the end (or prepends to the start) stay under the length cap", () => {
    let end = rankBetween(null, null);
    let start = end;
    for (let i = 0; i < 3000; i++) {
      const nextEnd = rankBetween(end, null);
      const nextStart = rankBetween(null, start);
      expect(nextEnd > end && nextStart < start).toBe(true);
      end = nextEnd;
      start = nextStart;
    }
    expect(end.length).toBeLessThan(110);
    expect(start.length).toBeLessThan(110);
  });

  it("rejects bad input instead of producing a wrong order", () => {
    expect(() => rankBetween("b", "a")).toThrow();
    expect(() => rankBetween("a", "a")).toThrow();
    expect(() => rankBetween("a0", null)).toThrow();
    expect(() => rankBetween("a!", null)).toThrow();
    expect(isValidRank("")).toBe(false);
    expect(isValidRank("x".repeat(129))).toBe(false);
  });
});
