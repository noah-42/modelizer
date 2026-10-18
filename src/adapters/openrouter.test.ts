import { describe, expect, test } from "bun:test";
import { openRouterAdapter } from "./openrouter";
import type { RawPoll } from "./types";

// Shapes from openrouter.ai/docs/api-reference, verified 2026-10-03.
const KEY_WITH_LIMIT = {
  data: {
    label: "sk-or-v1-abc",
    usage: 0.0502,
    usage_daily: 0.0102,
    usage_weekly: 0.0502,
    usage_monthly: 0.0502,
    limit: 10,
    limit_remaining: 9.9498,
    limit_reset: "2026-11-01T00:00:00.000Z",
    is_free_tier: false,
    is_management_key: false,
    free_model_daily_requests: { used: 3, limit: 50, remaining: 47 },
  },
};

const KEY_NO_LIMIT = {
  data: {
    label: "sk-or-v1-abc",
    usage: "12.5",
    usage_daily: null,
    usage_weekly: null,
    usage_monthly: null,
    limit: null,
    limit_remaining: null,
    limit_reset: null,
  },
};

const CREDITS_OK = { data: { total_credits: 20, total_usage: 5.25 } };

const ACTIVITY_OK = {
  data: [
    {
      date: "2026-10-02",
      model: "anthropic/claude-sonnet-4.5",
      requests: 12,
      usage: 0.85,
      byok_usage_inference: 0,
      prompt_tokens: 40_000,
      completion_tokens: 8_000,
      reasoning_tokens: 0,
      cached_tokens: 10_000,
    },
    {
      date: "2026-10-01",
      model: "anthropic/claude-sonnet-4.5",
      requests: 9,
      usage: 0.4,
      prompt_tokens: 30_000,
      completion_tokens: 6_000,
    },
  ],
};

function poll(endpoint: string, json: unknown, status = 200): RawPoll {
  return { endpoint, url: `https://x/${endpoint}`, status, body: JSON.stringify(json), json, headers: {} };
}

const AT = "2026-10-03T01:00:00Z";

describe("openrouter normalize", () => {
  test("key with spend limit → quota + rolling windows + free requests", () => {
    const points = openRouterAdapter.normalize([poll("key", KEY_WITH_LIMIT)], AT);
    const limit = points.find((p) => p.label === "key-spend-limit");
    expect(limit?.kind).toBe("quota");
    expect(limit?.used).toBe(0.0502);
    expect(limit?.limit).toBe(10);
    expect(limit?.remaining).toBe(9.9498);
    expect(limit?.reset_at).toBe("2026-11-01T00:00:00.000Z");

    expect(points.find((p) => p.label === "spend-daily")?.used).toBe(0.0102);
    expect(points.find((p) => p.label === "spend-monthly")?.used).toBe(0.0502);

    const free = points.find((p) => p.label === "free-model-requests-daily");
    expect(free?.unit).toBe("requests");
    expect(free?.remaining).toBe(47);
  });

  test("key without limit → lifetime usage point, numeric strings coerced, nulls skipped", () => {
    const points = openRouterAdapter.normalize([poll("key", KEY_NO_LIMIT)], AT);
    expect(points.find((p) => p.label === "key-spend-limit")).toBeUndefined();
    expect(points.find((p) => p.label === "spend-daily")).toBeUndefined();
    const lifetime = points.find((p) => p.label === "key-lifetime-spend");
    expect(lifetime?.kind).toBe("usage");
    expect(lifetime?.used).toBe(12.5);
  });

  test("credits → balance with remaining computed", () => {
    const points = openRouterAdapter.normalize([poll("key", KEY_WITH_LIMIT), poll("credits", CREDITS_OK)], AT);
    const credits = points.find((p) => p.label === "credits");
    expect(credits?.kind).toBe("balance");
    expect(credits?.limit).toBe(20);
    expect(credits?.used).toBe(5.25);
    expect(credits?.remaining).toBeCloseTo(14.75, 6);
  });

  test("unexpected shape is loud", () => {
    expect(() => openRouterAdapter.normalize([poll("key", { nope: true })], AT)).toThrow(/no \.data/);
    expect(() => openRouterAdapter.normalize([poll("credits", { data: null })], AT)).toThrow(/no \.data/);
  });

  test("activity rows → per-model spend points with day, requests, tokens", () => {
    const points = openRouterAdapter.normalize([poll("key", KEY_WITH_LIMIT), poll("activity", ACTIVITY_OK)], AT);
    const spend = points.filter((p) => p.label === "model-spend");
    expect(spend.length).toBe(2);
    const latest = spend.find((p) => p.day === "2026-10-02");
    expect(latest?.model).toBe("anthropic/claude-sonnet-4.5");
    expect(latest?.used).toBe(0.85);
    expect(latest?.cost_usd).toBe(0.85);
    expect(latest?.unit).toBe("usd");
    expect(latest?.requests).toBe(12);
    expect(latest?.tokens_in).toBe(40_000);
    expect(latest?.tokens_out).toBe(8_000);
  });

  test("activity with bad shape is loud; failed activity poll is tolerated", () => {
    expect(() => openRouterAdapter.normalize([poll("key", KEY_WITH_LIMIT), poll("activity", { nope: 1 })], AT)).toThrow(
      /no data array/,
    );
    // 403/404 activity (non-200) is skipped by normalize — scheduler filters it earlier
    const points = openRouterAdapter.normalize([poll("key", KEY_WITH_LIMIT), poll("activity", {}, 403)], AT);
    expect(points.find((p) => p.label === "model-spend")).toBeUndefined();
  });

  test("statusHints: muted hint without management key, none with it", () => {
    expect(openRouterAdapter.statusHints?.({})).toHaveLength(1);
    expect(openRouterAdapter.statusHints?.({ OPENROUTER_MANAGEMENT_KEY: "k" })).toEqual([]);
  });
});

describe("openrouter config", () => {
  test("credentials", () => {
    expect(openRouterAdapter.isConfigured({})).toBe(false);
    expect(openRouterAdapter.missingCredentials({})).toEqual(["OPENROUTER_API_KEY"]);
    expect(openRouterAdapter.isConfigured({ OPENROUTER_API_KEY: "k" })).toBe(true);
    expect(openRouterAdapter.missingCredentials({ OPENROUTER_API_KEY: "k" })).toEqual([]);
  });
});
