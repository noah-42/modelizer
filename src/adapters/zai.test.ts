import { describe, expect, test } from "bun:test";
import { zaiAdapter } from "./zai";
import type { RawPoll } from "./types";

// Shapes pinned from CodexBar zai.js and TokenStep GLMQuotaService.swift (2026-10-03).
const QUOTA_OK = {
  success: true,
  code: 200,
  data: {
    planName: "GLM Coding Plan",
    limits: [
      {
        type: "TOKENS_LIMIT",
        unit: 5,
        number: 300, // 1-minute × 300 = 5h window
        usage: 120000, // 'usage' is the TOTAL
        remaining: 90000,
        percentage: 25,
        nextResetTime: "2026-10-03T06:00:00Z",
        usageDetails: [
          { modelCode: "glm-4.7", usage: 90000 },
          { modelCode: "glm-4.6-flash", usage: 30000 },
        ],
      },
      {
        type: "TOKENS_LIMIT",
        unit: 1,
        number: 30, // 30 days
        usage: 4800000,
        remaining: 1200000,
        percentage: 75,
        nextResetTime: 1793542651984, // epoch ms — observed in the wild
      },
      { type: "TIME_LIMIT", unit: 5, number: 1, usage: 40, remaining: 20 },
      { type: "SOMETHING_ELSE", unit: 1, number: 1, usage: 5 },
    ],
  },
};

// Observed on a lite coding plan: the 5h window carries only a percentage (unit=3 hours × 5).
const QUOTA_PERCENTAGE_ONLY = {
  success: true,
  code: 200,
  data: {
    level: "lite",
    limits: [
      { type: "TIME_LIMIT", unit: 5, number: 1, usage: 100, currentValue: 100, remaining: 0, percentage: 100, nextResetTime: 1793542651984, usageDetails: [{ modelCode: "search-prime", usage: 25 }, { modelCode: "web-reader", usage: 75 }] },
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 5, nextResetTime: 1791047424085 },
    ],
  },
};

const CODING_OK = {
  data: {
    token_window: { used: 1000, remaining: 9000, total: 10000 },
    daily: { used: 200, remaining: 800, total: 1000 },
    monthly: { used: 5000, remain: 95000, limit: 100000 }, // alias keys on purpose
  },
};

const MODEL_OK = {
  data: {
    x_time: ["2026-10-01 10:00", "2026-10-01 11:00", "2026-10-02 09:00"], // hourly in the wild
    modelDataList: [{ modelName: "glm-4.7", tokensUsage: [100, 150, 250] }],
  },
};

const BALANCE_OK = { data: { total_balance: 10, available_balance: 7.5, currency: "USD" } };
const BALANCE_CNY = { data: { total_balance: 100, available_balance: 80, currency: "CNY" } };

function poll(endpoint: string, json: unknown, status = 200): RawPoll {
  return { endpoint, url: `https://x/${endpoint}`, status, body: JSON.stringify(json), json, headers: {} };
}

const AT = "2026-10-03T01:00:00Z";

describe("zai normalize", () => {
  test("quota/limit: 5h + monthly + mcp + per-model usageDetails", () => {
    const points = zaiAdapter.normalize([poll("quota-limit", QUOTA_OK)], AT);
    const five = points.find((p) => p.label === "coding-5h");
    expect(five?.used).toBe(30000); // total 120000 - remaining 90000
    expect(five?.limit).toBe(120000);
    expect(five?.remaining).toBe(90000);
    expect(five?.unit).toBe("tokens");
    expect(five?.reset_at).toBe("2026-10-03T06:00:00.000Z"); // ISO inputs get canonicalized

    const monthly = points.find((p) => p.label === "monthly");
    expect(monthly?.used).toBe(3600000);
    expect(monthly?.limit).toBe(4800000);
    expect(monthly?.reset_at).toBe(new Date(1793542651984).toISOString());

    const mcp = points.find((p) => p.label === "mcp");
    expect(mcp?.unit).toBe("requests");
    expect(mcp?.remaining).toBe(20);

    const byModel = points.filter((p) => p.label === "coding-window-by-model");
    expect(byModel.length).toBe(2);
    expect(byModel[0]?.model).toBe("glm-4.7");

    expect(points.find((p) => p.label.includes("SOMETHING"))).toBeUndefined();
  });

  test("percentage-only windows (lite plan shape): 5h as percent + MCP usageDetails", () => {
    const points = zaiAdapter.normalize([poll("quota-limit", QUOTA_PERCENTAGE_ONLY)], AT);
    const five = points.find((p) => p.label === "coding-5h");
    expect(five?.used).toBe(5);
    expect(five?.limit).toBe(100);
    expect(five?.unit).toBe("percent");

    const mcp = points.find((p) => p.label === "mcp");
    expect(mcp?.used).toBe(100);
    expect(mcp?.limit).toBe(100);
    expect(mcp?.remaining).toBe(0);

    const tools = points.filter((p) => p.label === "coding-window-by-model");
    expect(tools.map((t) => `${t.model}:${t.used}`).sort()).toEqual(["search-prime:25", "web-reader:75"]);
  });

  test("coding/usage returns HTTP 200 with an error body → treated as absent", () => {
    const errBody = { code: 500, msg: "404 NOT_FOUND", success: false };
    // quota-limit failed AND coding-usage is a 200-with-error → must throw, not parse garbage
    expect(() => zaiAdapter.normalize([poll("quota-limit", {}, 500), poll("coding-usage", errBody)], AT)).toThrow(
      /no usable data/,
    );
  });

  test("bogus 5h reset (10h away) is dropped", () => {
    const bogus = structuredClone(QUOTA_OK);
    (bogus.data.limits[0] as { nextResetTime?: string }).nextResetTime = "2026-10-03T11:00:00Z";
    const points = zaiAdapter.normalize([poll("quota-limit", bogus)], AT);
    expect(points.find((p) => p.label === "coding-5h")?.reset_at).toBeNull();
  });

  test("coding/usage fallback when quota/limit fails; alias keys honored", () => {
    const points = zaiAdapter.normalize([poll("quota-limit", {}, 500), poll("coding-usage", CODING_OK)], AT);
    expect(points.find((p) => p.label === "coding-5h")?.used).toBe(200);
    const monthly = points.find((p) => p.label === "monthly");
    expect(monthly?.remaining).toBe(95000);
    expect(monthly?.limit).toBe(100000);
    expect(points.find((p) => p.label === "token-window")?.used).toBe(1000);
  });

  test("both quota sources failed → loud", () => {
    expect(() => zaiAdapter.normalize([poll("quota-limit", {}, 502), poll("coding-usage", {}, 403)], AT)).toThrow(
      /no usable data/,
    );
  });

  test("degraded run: quota 429 + coding 404, but model-usage alive → still produces points", () => {
    const points = zaiAdapter.normalize(
      [poll("quota-limit", {}, 429), poll("coding-usage", {}, 404), poll("model-usage", MODEL_OK)],
      AT,
    );
    expect(points.length).toBe(2);
    expect(points.every((p) => p.label === "model-daily")).toBe(true);
  });

  test("model-usage hourly buckets are summed into daily totals", () => {
    const points = zaiAdapter.normalize([poll("quota-limit", QUOTA_OK), poll("model-usage", MODEL_OK)], AT);
    const rows = points.filter((p) => p.label === "model-daily");
    expect(rows.length).toBe(2); // two distinct days
    const day1 = rows.find((r) => r.day === "2026-10-01");
    expect(day1?.used).toBe(250); // 100 + 150
    expect(rows.find((r) => r.day === "2026-10-02")?.used).toBe(250);
  });

  test("balance in USD and CNY", () => {
    const usd = zaiAdapter.normalize([poll("quota-limit", QUOTA_OK), poll("balance", BALANCE_OK)], AT);
    const b = usd.find((p) => p.label === "payg-balance");
    expect(b?.unit).toBe("usd");
    expect(b?.remaining).toBe(7.5);
    expect(b?.used).toBe(2.5);

    const cny = zaiAdapter.normalize([poll("quota-limit", QUOTA_OK), poll("balance", BALANCE_CNY)], AT);
    expect(cny.find((p) => p.label === "payg-balance")?.unit).toBe("cny");
  });

  test("credentials", () => {
    expect(zaiAdapter.isConfigured({})).toBe(false);
    expect(zaiAdapter.missingCredentials({})).toEqual(["ZAI_API_KEY"]);
    expect(zaiAdapter.isConfigured({ ZAI_API_KEY: "k" })).toBe(true);
  });
});

describe("zai liveStatus (peak = weekdays 06:00–10:00 UTC)", () => {
  const s = (now: string) => zaiAdapter.liveStatus!(new Date(now))[0]!;

  test("promo window overrides everything", () => {
    // Mon Oct 5 2026, 07:00 UTC would be peak, but the Sept 25 – Oct 7 promo makes all day off-peak
    const note = s("2026-10-05T07:00:00Z");
    expect(note.state).toContain("promo");
    expect(note.tone).toBe("good");
    expect(note.until).toBe("2026-10-08T00:00:00.000Z");
  });

  test("weekday inside peak", () => {
    const note = s("2026-10-12T07:30:00Z"); // Monday
    expect(note.state).toBe("peak · 1× credits");
    expect(note.tone).toBe("warn");
    expect(note.until).toBe("2026-10-12T10:00:00.000Z");
  });

  test("weekday before peak", () => {
    const note = s("2026-10-12T04:00:00Z"); // Monday early
    expect(note.state).toContain("off-peak");
    expect(note.until).toBe("2026-10-12T06:00:00.000Z");
  });

  test("weekday after peak rolls to next weekday", () => {
    const note = s("2026-10-09T12:00:00Z"); // Friday afternoon
    expect(note.state).toContain("off-peak");
    expect(note.until).toBe("2026-10-12T06:00:00.000Z"); // Monday
  });

  test("weekend is off-peak until Monday", () => {
    const note = s("2026-10-10T09:00:00Z"); // Saturday, inside peak hours but weekend
    expect(note.state).toContain("off-peak");
    expect(note.until).toBe("2026-10-12T06:00:00.000Z");
  });

  test("peak boundary: exactly 10:00 is off-peak", () => {
    expect(s("2026-10-12T09:59:59Z").state).toContain("peak");
    expect(s("2026-10-12T10:00:00Z").state).toContain("off-peak");
  });
});
