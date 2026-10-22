import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSubscriptions,
  monthlyPrice,
  nextRenewal,
  SubscriptionCatalog,
  SubscriptionConfigError,
  type SubscriptionFacts,
} from "./subscriptions";

const root = mkdtempSync(join(tmpdir(), "modelizer-subs-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function configFile(name: string, body: string): string {
  const path = join(root, name);
  writeFileSync(path, body);
  return path;
}

const NOW = new Date("2026-10-22T00:00:00.000Z");

function facts(partial: Partial<SubscriptionFacts> & { provider: string }): SubscriptionFacts {
  return {
    planId: null,
    planName: null,
    state: "unknown",
    period: null,
    renewsAt: null,
    seats: null,
    source: "test",
    ...partial,
  };
}

describe("loadSubscriptions", () => {
  test("returns an empty list when the file does not exist", () => {
    expect(loadSubscriptions(join(root, "absent.toml"))).toEqual([]);
  });

  test("parses each [[subscription]] block", () => {
    const path = configFile("ok.toml", [
      "[[subscription]]",
      'provider = "claude"',
      'plan = "pro"',
      "price_usd = 20",
      "renews_day = 13",
      "",
      "[[subscription]]",
      'provider = "cursor"',
      "price_usd = 240",
      'period = "annual"',
      'state = "active"',
      "seats = 2",
      "",
    ].join("\n"));
    expect(loadSubscriptions(path)).toEqual([
      { provider: "claude", plan: "pro", priceUsd: 20, renewsDay: 13 },
      { provider: "cursor", priceUsd: 240, period: "annual", state: "active", seats: 2 },
    ]);
  });

  test("rejects a block without a provider", () => {
    const path = configFile("no-provider.toml", "[[subscription]]\nprice_usd = 20\n");
    expect(() => loadSubscriptions(path)).toThrow(SubscriptionConfigError);
  });

  test("rejects a renewal day outside 1-31", () => {
    const path = configFile("bad-day.toml", '[[subscription]]\nprovider = "claude"\nrenews_day = 32\n');
    expect(() => loadSubscriptions(path)).toThrow(/renews_day must be an integer 1-31/);
  });

  test("rejects an unknown period or state", () => {
    const period = configFile("bad-period.toml", '[[subscription]]\nprovider = "claude"\nperiod = "weekly"\n');
    expect(() => loadSubscriptions(period)).toThrow(/period must be monthly or annual/);
    const state = configFile("bad-state.toml", '[[subscription]]\nprovider = "claude"\nstate = "paused"\n');
    expect(() => loadSubscriptions(state)).toThrow(/state must be one of/);
  });
});

describe("nextRenewal", () => {
  test("uses this month when the renewal day is still ahead", () => {
    expect(nextRenewal({ renewsDay: 25, period: "monthly" }, NOW)).toBe("2026-10-25T09:00:00.000Z");
  });

  test("rolls to next month once the day has passed", () => {
    expect(nextRenewal({ renewsDay: 13, period: "monthly" }, NOW)).toBe("2026-11-13T09:00:00.000Z");
  });

  test("clamps day 31 to the last day of a short month", () => {
    const february = new Date("2026-02-01T00:00:00.000Z");
    expect(nextRenewal({ renewsDay: 31, period: "monthly" }, february)).toBe("2026-02-28T09:00:00.000Z");
  });

  test("rolls an explicit past charge date forward by whole months", () => {
    expect(nextRenewal({ renewsAt: "2026-01-13", period: "monthly" }, NOW)).toBe("2026-11-13T09:00:00.000Z");
  });

  test("rolls an annual charge forward by whole years", () => {
    expect(nextRenewal({ renewsAt: "2026-03-01", period: "annual" }, NOW)).toBe("2027-03-01T09:00:00.000Z");
  });

  test("returns null when nothing is known", () => {
    expect(nextRenewal({ period: "monthly" }, NOW)).toBeNull();
  });
});

describe("monthlyPrice", () => {
  test("splits an annual price across twelve months", () => {
    expect(monthlyPrice(240, "annual")).toBe(20);
    expect(monthlyPrice(20, "monthly")).toBe(20);
    expect(monthlyPrice(null, "monthly")).toBeNull();
  });
});

describe("SubscriptionCatalog", () => {
  const claudeFacts = facts({
    provider: "claude",
    planId: "pro",
    planName: "Claude Pro",
    state: "active",
    period: "monthly",
    source: "claude-oauth",
  });

  test("merges provider facts with the configured price and renewal day", () => {
    const catalog = new SubscriptionCatalog(
      [{ provider: "claude", plan: "pro", priceUsd: 20, renewsDay: 13 }],
      [claudeFacts],
      NOW,
    );
    expect(catalog.list()[0]).toEqual({
      provider: "claude",
      plan: "Claude Pro",
      priceUsd: 20,
      period: "monthly",
      monthlyUsd: 20,
      renewsAt: "2026-11-13T09:00:00.000Z",
      state: "active",
      seats: null,
      source: "claude-oauth+config",
      configured: true,
    });
  });

  test("prices a known plan from the catalogue when config omits the price", () => {
    const catalog = new SubscriptionCatalog(
      [{ provider: "xai", plan: "supergrok", renewsDay: 21 }],
      [],
      NOW,
    );
    expect(catalog.list()[0]).toMatchObject({ plan: "SuperGrok", priceUsd: 30, monthlyUsd: 30, state: "unknown" });
  });

  test("includes a provider that only reports facts, unpriced if the plan is unknown", () => {
    const catalog = new SubscriptionCatalog(
      [],
      [facts({ provider: "cursor", planId: "pro", planName: "Cursor Pro", state: "active", source: "cursor-api" }),
       facts({ provider: "xai", planId: "mystery", planName: "Mystery Plan", source: "manual" })],
      NOW,
    );
    const rows = catalog.list();
    expect(rows.find((r) => r.provider === "cursor")).toMatchObject({
      plan: "Cursor Pro",
      priceUsd: 20,
      configured: false,
      source: "cursor-api",
    });
    expect(rows.find((r) => r.provider === "xai")).toMatchObject({ plan: "Mystery Plan", priceUsd: null, monthlyUsd: null });
  });

  test("totals only the rows that have a monthly price, most expensive first", () => {
    const catalog = new SubscriptionCatalog(
      [
        { provider: "claude", priceUsd: 20, renewsDay: 13 },
        { provider: "cursor", priceUsd: 720, period: "annual", renewsDay: 4 },
        { provider: "xai", plan: "unknown-plan" },
      ],
      [claudeFacts],
      NOW,
    );
    expect(catalog.list().map((s) => s.provider)).toEqual(["cursor", "claude", "xai"]);
    expect(catalog.totalMonthlyUsd()).toBe(80);
  });
});
