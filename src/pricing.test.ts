import { describe, expect, test } from "bun:test";
import { bundledPricing, estimateCost, resolvePrice } from "./pricing";

// Trimmed copy of the checked-in table with two ids that share a prefix on purpose.
const table = {
  "claude-opus-5": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  "claude-opus-5-5": { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
};

const ONE_MILLION = 1_000_000;

describe("resolvePrice", () => {
  test("returns the row for an exact model id", () => {
    expect(resolvePrice(table, "claude-opus-5-5")).toEqual(table["claude-opus-5-5"]);
  });

  test("ignores the release-date suffix that models.dev keeps and transcripts drop", () => {
    const dated = { "claude-sonnet-4-5": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } };
    expect(resolvePrice(dated, "claude-sonnet-4-5-20250929")).toEqual(dated["claude-sonnet-4-5"]);
  });

  test("prefers the longest matching prefix instead of a shorter family id", () => {
    expect(resolvePrice(table, "claude-opus-5-5-20260101")).toEqual(table["claude-opus-5-5"]);
    expect(resolvePrice(table, "claude-opus-5-20260101")).toEqual(table["claude-opus-5"]);
  });

  test("returns null for a model with no price row", () => {
    expect(resolvePrice(table, "<synthetic>")).toBeNull();
    expect(resolvePrice(table, "")).toBeNull();
  });
});

describe("estimateCost", () => {
  test("prices input, output, cache reads and cache writes at list rates", () => {
    const cost = estimateCost(table, "claude-opus-5-5", {
      input: ONE_MILLION,
      output: ONE_MILLION,
      cacheRead: ONE_MILLION,
      cacheWrite: ONE_MILLION,
    });
    // 4 + 20 + 0.2 + 5
    expect(cost).toBe(29.2);
  });

  test("returns null instead of zero for an unpriced model", () => {
    expect(estimateCost(table, "<synthetic>", { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 })).toBeNull();
  });

  test("scales with cached tokens, which dominate long sessions", () => {
    const cost = estimateCost(table, "claude-opus-5-5", {
      input: 0,
      output: 0,
      cacheRead: 10 * ONE_MILLION,
      cacheWrite: 0,
    });
    expect(cost).toBe(2);
  });
});

describe("bundledPricing", () => {
  test("prices every model Claude Code currently writes", () => {
    const pricing = bundledPricing();
    for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]) {
      expect(resolvePrice(pricing, model)).not.toBeNull();
    }
  });
});
