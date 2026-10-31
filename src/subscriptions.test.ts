import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSubscriptions,
  monthlyPrice,
  nextRenewal,
  SubscriptionCatalog,
  SubscriptionConfigError,
  appendSubscription,
  removeSubscription,
  setSubscriptionOrder,
  updateSubscription,
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
      "price = 20",
      "renews_day = 13",
      "",
      "[[subscription]]",
      'provider = "cursor"',
      "price = 240",
      'period = "annual"',
      'state = "active"',
      "seats = 2",
      "",
    ].join("\n"));
    expect(loadSubscriptions(path)).toEqual([
      { provider: "claude", plan: "pro", price: 20, renewsDay: 13 },
      { provider: "cursor", price: 240, period: "annual", state: "active", seats: 2 },
    ]);
  });

  test("parses a euro price with an intro rate and a paid-through date", () => {
    const path = configFile("eur.toml", [
      "[[subscription]]",
      'provider = "xai"',
      'plan = "supergrok"',
      'currency = "eur"',
      "price = 15",
      "price_next = 30",
      "",
      "[[subscription]]",
      'provider = "zai"',
      'currency = "EUR"',
      "price = 36",
      'period = "annual"',
      'ends_at = "2027-02-28"',
      "",
    ].join("\n"));
    expect(loadSubscriptions(path)).toEqual([
      { provider: "xai", plan: "supergrok", currency: "EUR", price: 15, priceNext: 30 },
      { provider: "zai", currency: "EUR", price: 36, period: "annual", endsAt: "2027-02-28" },
    ]);
  });

  test("lets the config name a plan the catalogue does not know", () => {
    const path = configFile("label.toml", [
      "[[subscription]]",
      'provider = "zai"',
      'label = "GLM Coding (annual)"',
      "price = 36",
      'currency = "EUR"',
      'period = "annual"',
      "",
    ].join("\n"));
    const catalog = new SubscriptionCatalog(loadSubscriptions(path), [], NOW);
    expect(catalog.list()[0]).toMatchObject({ plan: "GLM Coding (annual)", monthly: 3, currency: "EUR" });
  });

  test("rejects a block without a provider", () => {
    const path = configFile("no-provider.toml", "[[subscription]]\nprice = 20\n");
    expect(() => loadSubscriptions(path)).toThrow(SubscriptionConfigError);
  });

  test("rejects a renewal day outside 1-31", () => {
    const path = configFile("bad-day.toml", '[[subscription]]\nprovider = "claude"\nrenews_day = 32\n');
    expect(() => loadSubscriptions(path)).toThrow(/renews_day must be an integer 1-31/);
  });

  test("rejects an unknown period, state or currency", () => {
    const period = configFile("bad-period.toml", '[[subscription]]\nprovider = "claude"\nperiod = "weekly"\n');
    expect(() => loadSubscriptions(period)).toThrow(/period must be monthly or annual/);
    const state = configFile("bad-state.toml", '[[subscription]]\nprovider = "claude"\nstate = "paused"\n');
    expect(() => loadSubscriptions(state)).toThrow(/state must be one of/);
    const currency = configFile("bad-currency.toml", '[[subscription]]\nprovider = "claude"\ncurrency = "euro"\n');
    expect(() => loadSubscriptions(currency)).toThrow(/3-letter ISO 4217/);
  });

  test("rejects two blocks for the same provider", () => {
    const path = configFile("dupes.toml", [
      "[[subscription]]",
      'provider = "cursor"',
      "price = 20",
      "",
      "[[subscription]]",
      'provider = "cursor"',
      "price = 15",
      "",
    ].join("\n"));
    expect(() => loadSubscriptions(path)).toThrow(/provider "cursor" appears more than once/);
  });

  test("rejects a negative price", () => {
    const path = configFile("neg.toml", '[[subscription]]\nprovider = "claude"\nprice = -1\n');
    expect(() => loadSubscriptions(path)).toThrow(/price must be >= 0/);
  });
});

describe("subscription writers", () => {
  test("appends and reloads a subscription block, including a zero price", () => {
    const path = configFile("writer-add.toml", "# keep this comment\n");
    appendSubscription({ provider: "claude", label: "Pro", price: 0 }, path);
    expect(loadSubscriptions(path)).toEqual([{ provider: "claude", label: "Pro", price: 0 }]);
  });

  test("sets and clears fields without writing empty values", () => {
    const path = configFile("writer-update.toml", '[[subscription]]\nprovider = "claude"\nlabel = "old"\nprice = 20\n');
    updateSubscription("claude", { label: "new", price: null }, path);
    expect(loadSubscriptions(path)).toEqual([{ provider: "claude", label: "new" }]);
    expect(readFileSync(path, "utf8")).not.toContain('label = ""');
  });

  test("removes only the selected block and preserves remaining bytes", () => {
    const remaining = '[[subscription]]\nprovider = "cursor"\nprice = 5\n';
    const path = configFile("writer-remove.toml", `[[subscription]]\nprovider = "claude"\nprice = 20\n\n${remaining}`);
    removeSubscription("claude", path);
    expect(readFileSync(path, "utf8")).toBe(remaining);
  });

  test("writes order values from one through the provider count", () => {
    const path = configFile("writer-order.toml", '[[subscription]]\nprovider = "claude"\n\n[[subscription]]\nprovider = "cursor"\n');
    setSubscriptionOrder(["cursor", "claude"], path);
    expect(loadSubscriptions(path)).toEqual([{ provider: "claude", order: 2 }, { provider: "cursor", order: 1 }]);
  });

  test("lists reloaded subscriptions in saved order before unranked price-sorted rows", () => {
    const path = configFile("writer-catalog-order.toml", [
      '[[subscription]]', 'provider = "claude"', "price = 20", "",
      '[[subscription]]', 'provider = "cursor"', "price = 60", "",
      '[[subscription]]', 'provider = "codex"', "price = 200", "",
    ].join("\n"));
    setSubscriptionOrder(["claude", "cursor"], path);
    const catalog = new SubscriptionCatalog(loadSubscriptions(path), [], NOW);
    expect(catalog.list().map((subscription) => subscription.provider)).toEqual(["claude", "cursor", "codex"]);
  });

  test("rejects duplicate adds and unknown remove or order without changing bytes", () => {
    const path = configFile("writer-errors.toml", '[[subscription]]\nprovider = "claude"\n');
    const before = readFileSync(path, "utf8");
    expect(() => appendSubscription({ provider: "claude" }, path)).toThrow(SubscriptionConfigError);
    expect(() => removeSubscription("missing", path)).toThrow(SubscriptionConfigError);
    expect(() => setSubscriptionOrder(["missing"], path)).toThrow(SubscriptionConfigError);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("rejects malformed files without overwriting them", () => {
    const malformed = '[[subscription]\nprovider = "claude"\n';
    const path = configFile("writer-malformed.toml", malformed);
    expect(() => appendSubscription({ provider: "cursor" }, path)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(malformed);
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
      [{ provider: "claude", plan: "pro", price: 20, renewsDay: 13 }],
      [claudeFacts],
      NOW,
    );
    expect(catalog.list()[0]).toEqual({
      provider: "claude",
      plan: "Claude Pro",
      price: 20,
      priceNext: null,
      currency: "USD",
      period: "monthly",
      current: 20,
      monthly: 20,
      renewsAt: "2026-11-13T09:00:00.000Z",
      endsAt: null,
      recurring: true,
      prepaid: false,
      counts: true,
      state: "active",
      seats: null,
      source: "claude-oauth+config",
      configured: true,
      note: null,
    });
  });

  test("prices a known plan from the catalogue when config omits the price", () => {
    const catalog = new SubscriptionCatalog([{ provider: "xai", plan: "supergrok", renewsDay: 21 }], [], NOW);
    expect(catalog.list()[0]).toMatchObject({ plan: "SuperGrok", price: 30, monthly: 30, state: "unknown" });
  });

  test("uses the post-intro price for the monthly figure but still reports what is charged now", () => {
    const catalog = new SubscriptionCatalog(
      [{ provider: "xai", plan: "supergrok", price: 15, priceNext: 30, currency: "EUR" }],
      [],
      NOW,
    );
    expect(catalog.list()[0]).toMatchObject({
      price: 15,
      priceNext: 30,
      current: 15,
      monthly: 30,
      currency: "EUR",
    });
  });

  test("annualises a term paid up front and reports when it ends instead of a renewal", () => {
    const catalog = new SubscriptionCatalog(
      [{ provider: "zai", price: 36, currency: "EUR", period: "annual", endsAt: "2027-02-28" }],
      [],
      NOW,
    );
    expect(catalog.list()[0]).toMatchObject({
      current: 3,
      monthly: 3,
      currency: "EUR",
      renewsAt: null,
      endsAt: "2027-02-28",
      recurring: false,
      prepaid: true,
      counts: false,
    });
  });

  test("counts an annual plan that renews, since it charges again", () => {
    const catalog = new SubscriptionCatalog(
      [
        { provider: "claude", price: 20, renewsDay: 13 },
        { provider: "cursor", price: 60 },
        { provider: "xai", price: 15, priceNext: 30, currency: "EUR" },
        { provider: "zai", price: 36, currency: "EUR", period: "annual" },
      ],
      [claudeFacts],
      NOW,
    );
    // Priced at what is charged now: 15 EUR for the intro rate, 3 for the annual term.
    expect(catalog.totals()).toEqual([
      { currency: "USD", monthly: 80 },
      { currency: "EUR", monthly: 18 },
    ]);
  });

  test("leaves a plan paid up front out of the monthly total", () => {
    const catalog = new SubscriptionCatalog(
      [
        { provider: "cursor", label: "Premium", currency: "EUR", price: 15.5, priceNext: 31, renewsDay: 17 },
        { provider: "claude", currency: "EUR", price: 21.42, renewsDay: 6 },
        { provider: "zai", currency: "EUR", price: 36, period: "annual", endsAt: "2027-02-28" },
      ],
      [],
      NOW,
    );
    // 15.50 + 21.42: what is charged now, without the prepaid 3 or the 31 that starts later.
    expect(catalog.totals()).toEqual([{ currency: "EUR", monthly: 36.92 }]);
    expect(catalog.list().find((s) => s.provider === "zai")).toMatchObject({ recurring: false, monthly: 3 });
    expect(catalog.list().find((s) => s.provider === "claude")).toMatchObject({ recurring: true });
  });

  test("counts a plan that is still running even though it will not renew", () => {
    const catalog = new SubscriptionCatalog(
      [
        { provider: "claude", currency: "EUR", price: 21.42, renewsDay: 6 },
        { provider: "codex", currency: "EUR", price: 23, endsAt: "2026-11-12", state: "active" },
      ],
      [],
      NOW,
    );
    expect(catalog.totals()).toEqual([{ currency: "EUR", monthly: 44.42 }]);
    expect(catalog.list().find((s) => s.provider === "codex")).toMatchObject({
      current: 23,
      recurring: false,
      prepaid: false,
      counts: true,
      renewsAt: null,
      endsAt: "2026-11-12",
    });
  });

  test("leaves a cancelled plan out of the total", () => {
    const catalog = new SubscriptionCatalog(
      [
        { provider: "claude", currency: "EUR", price: 21.42, renewsDay: 6 },
        { provider: "codex", currency: "EUR", price: 23, state: "cancelled" },
      ],
      [],
      NOW,
    );
    expect(catalog.totals()).toEqual([{ currency: "EUR", monthly: 21.42 }]);
    expect(catalog.list().find((s) => s.provider === "codex")).toMatchObject({ counts: false });
  });

  test("totals the price in force now, not the rate that starts at the next charge", () => {
    const catalog = new SubscriptionCatalog(
      [
        { provider: "cursor", currency: "EUR", price: 15.5, priceNext: 31, renewsDay: 17 },
        { provider: "claude", currency: "EUR", price: 21.42, renewsDay: 6 },
      ],
      [],
      NOW,
    );
    expect(catalog.totals()).toEqual([{ currency: "EUR", monthly: 36.92 }]);
    const claude = catalog.list().find((s) => s.provider === "claude");
    const cursor = catalog.list().find((s) => s.provider === "cursor");
    expect(claude).toMatchObject({ current: 21.42, monthly: 21.42 });
    expect(cursor).toMatchObject({ current: 15.5, monthly: 31 });
  });

  test("counts a free plan at zero rather than asking for a price", () => {
    const catalog = new SubscriptionCatalog(
      [{ provider: "opencode", label: "OpenCode", price: 0, currency: "EUR", state: "active" }],
      [],
      NOW,
    );
    expect(catalog.list()[0]).toMatchObject({ plan: "OpenCode", current: 0, counts: true });
    expect(catalog.totals()).toEqual([{ currency: "EUR", monthly: 0 }]);
  });

  test("includes a provider that only reports facts, unpriced if the plan is unknown", () => {
    const catalog = new SubscriptionCatalog(
      [],
      [
        facts({ provider: "cursor", planId: "pro", planName: "Cursor Pro", state: "active", source: "cursor-api" }),
        facts({ provider: "xai", planId: "mystery", planName: "Mystery Plan", source: "manual" }),
      ],
      NOW,
    );
    const rows = catalog.list();
    expect(rows.find((r) => r.provider === "cursor")).toMatchObject({
      plan: "Cursor Pro",
      price: 20,
      configured: false,
      source: "cursor-api",
    });
    expect(rows.find((r) => r.provider === "xai")).toMatchObject({ plan: "Mystery Plan", price: null, monthly: null });
  });

  test("sorts by the price in force and leaves unpriced rows last", () => {
    const catalog = new SubscriptionCatalog(
      [
        { provider: "claude", price: 20, renewsDay: 13 },
        { provider: "cursor", price: 720, period: "annual", renewsDay: 4 },
        { provider: "xai", plan: "unknown-plan" },
      ],
      [claudeFacts],
      NOW,
    );
    expect(catalog.list().map((s) => s.provider)).toEqual(["cursor", "claude", "xai"]);
    expect(catalog.totals()).toEqual([{ currency: "USD", monthly: 80 }]);
  });
});
