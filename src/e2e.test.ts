import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildApi } from "./api";
import { openRouterAdapter } from "./adapters/openrouter";
import { zaiAdapter } from "./adapters/zai";
import { openDb } from "./db";
import { Scheduler } from "./scheduler";
import type { UsagePoint } from "./adapters/types";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// End-to-end: mock OpenRouter API → adapter → scheduler → SQLite → HTTP overview.
// Proves the skeleton without real credentials; also pins the *_BASE_URL override
// that every future adapter should offer for the same purpose.
const KEY_BODY = {
  data: {
    label: "sk-or-v1-test",
    usage: 0.04,
    usage_daily: 0.01,
    usage_weekly: 0.04,
    usage_monthly: 0.04,
    limit: 10,
    limit_remaining: 9.96,
    limit_reset: "2026-11-01T00:00:00.000Z",
    free_model_daily_requests: { used: 2, limit: 50, remaining: 48 },
  },
};
const CREDITS_BODY = { data: { total_credits: 20, total_usage: 4.5 } };
const ACTIVITY_BODY = {
  data: [
    {
      date: "2026-10-02",
      model: "openai/gpt-5-mini",
      requests: 3,
      usage: 0.12,
      prompt_tokens: 5_000,
      completion_tokens: 800,
    },
  ],
};

let mock: ReturnType<typeof Bun.serve>;
let zaiMock: ReturnType<typeof Bun.serve>;
let dbPath: string;

// Shape captured from the real API on 2026-10-03 (lite coding plan).
const ZAI_QUOTA = {
  success: true,
  code: 200,
  data: {
    level: "lite",
    limits: [
      {
        type: "TIME_LIMIT",
        unit: 5,
        number: 1,
        usage: 100,
        currentValue: 100,
        remaining: 0,
        percentage: 100,
        nextResetTime: 1793542651984,
        usageDetails: [
          { modelCode: "search-prime", usage: 25 },
          { modelCode: "web-reader", usage: 75 },
        ],
      },
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 5, nextResetTime: 1791047424085 },
    ],
  },
};

beforeAll(() => {
  mock = Bun.serve({
    port: 0,
    fetch(req) {
      const auth = req.headers.get("authorization") ?? "";
      if (req.url.endsWith("/api/v1/key")) {
        return auth === "Bearer test-key"
          ? Response.json(KEY_BODY)
          : new Response("unauthorized", { status: 401 });
      }
      if (req.url.endsWith("/api/v1/credits")) {
        return auth === "Bearer test-mgmt"
          ? Response.json(CREDITS_BODY)
          : new Response("unauthorized", { status: 401 });
      }
      if (req.url.endsWith("/api/v1/activity")) {
        return auth === "Bearer test-mgmt"
          ? Response.json(ACTIVITY_BODY)
          : new Response("unauthorized", { status: 403 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  zaiMock = Bun.serve({
    port: 0,
    fetch(req) {
      const auth = req.headers.get("authorization") ?? "";
      if (auth !== "Bearer zai-key") return new Response("unauthorized", { status: 401 });
      if (req.url.includes("/api/monitor/usage/quota/limit")) return Response.json(ZAI_QUOTA);
      if (req.url.includes("/api/coding/usage")) return Response.json({ data: { daily: { used: 1, total: 2 } } });
      if (req.url.includes("/api/monitor/usage/model-usage"))
        return Response.json({ data: { x_time: ["2026-10-02"], modelDataList: [{ modelName: "glm-4.7", tokensUsage: [900] }] } });
      // balance intentionally 404s: optional poll must not fail the run
      return new Response("not found", { status: 404 });
    },
  });
  dbPath = join(mkdtempSync(join(tmpdir(), "modelizer-e2e-")), "e2e.db");
});

afterAll(() => {
  mock.stop(true);
  zaiMock.stop(true);
});

function mkUsage(overrides: Partial<UsagePoint> = {}): UsagePoint {
  return {
    provider: "zai",
    kind: "quota",
    label: "test",
    model: null,
    used: 1,
    limit: 2,
    remaining: 1,
    unit: "tokens",
    window_start: null,
    window_end: null,
    reset_at: null,
    day: null,
    requests: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    captured_at: "2026-10-02T12:00:00Z",
    ...overrides,
  };
}

describe("end to end", () => {
  test("poll → db → overview", async () => {
    const db = openDb(dbPath);
    const env = {
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_MANAGEMENT_KEY: "test-mgmt",
      OPENROUTER_BASE_URL: `http://127.0.0.1:${mock.port}`,
    };
    const scheduler = new Scheduler({ adapters: [openRouterAdapter], db, env });
    const outcome = await scheduler.runProvider("openrouter");
    expect(outcome.ok).toBe(true);
    expect(outcome.points.length).toBeGreaterThanOrEqual(5);

    const app = buildApi({ db, adapters: [openRouterAdapter], env, now: () => new Date("2026-10-03T00:01:00Z") });

    const overviewRes = await app.request("/api/overview");
    expect(overviewRes.status).toBe(200);
    const overview = (await overviewRes.json()) as {
      providers: Array<{ id: string; stale: boolean; configured: boolean; points: UsagePoint[] }>;
    };
    const provider = overview.providers.find((p) => p.id === "openrouter");
    expect(provider?.configured).toBe(true);
    expect(provider?.stale).toBe(false);
    expect(provider?.points.length).toBeGreaterThanOrEqual(5);

    const raw = db.lastRawPolls("openrouter", 10);
    const latestBatch = raw[0]?.captured_at;
    expect([...new Set(raw.filter((p) => p.captured_at === latestBatch).map((p) => p.endpoint))].sort()).toEqual([
      "activity",
      "credits",
      "key",
    ]);
    expect(outcome.points.some((p) => p.label === "model-spend" && p.model === "openai/gpt-5-mini")).toBe(true);

    const historyRes = await app.request("/api/providers/openrouter/points?days=7");
    const history = (await historyRes.json()) as { points: UsagePoint[] };
    expect(history.points.length).toBe(outcome.points.length);
    db.close();
  });

  test("degradedEndpoints flags a failed model-usage check in the latest batch only", async () => {
    const db = openDb(dbPath);
    // earlier batch: everything fine
    db.insertRawPolls(
      "zai",
      [
        { endpoint: "quota-limit", url: "u", status: 200, body: "{}", json: {}, headers: {} },
        { endpoint: "model-usage", url: "u", status: 200, body: "{}", json: {}, headers: {} },
      ],
      "2026-10-03T10:00:00Z",
    );
    // latest batch: token usage check 404s
    db.insertRawPolls(
      "zai",
      [
        { endpoint: "quota-limit", url: "u", status: 200, body: "{}", json: {}, headers: {} },
        { endpoint: "model-usage", url: "u", status: 404, body: "gone", json: null, headers: {} },
      ],
      "2026-10-03T10:15:00Z",
    );
    const app = buildApi({ db, adapters: [zaiAdapter], env: {}, now: () => new Date("2026-10-03T10:16:00Z") });
    const ov = (await (await app.request("/api/overview")).json()) as {
      providers: Array<{ id: string; degradedEndpoints: Array<{ endpoint: string; status: number }> }>;
    };
    expect(ov.providers.find((p) => p.id === "zai")?.degradedEndpoints).toEqual([
      { endpoint: "model-usage", status: 404 },
    ]);
    db.close();
  });

  test("bad key → loud failure, state records error", async () => {
    const db = openDb(dbPath);
    const env = {
      OPENROUTER_API_KEY: "wrong",
      OPENROUTER_BASE_URL: `http://127.0.0.1:${mock.port}`,
    };
    const scheduler = new Scheduler({ adapters: [openRouterAdapter], db, env });
    const outcome = await scheduler.runProvider("openrouter");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("401");
    const state = db.getAdapterState("openrouter");
    expect(state?.last_error).toContain("401");
    db.close();
  });

  test("overview: adapter order = display order (zai first), notes included", async () => {
    const db = openDb(dbPath);
    const app = buildApi({
      db,
      adapters: [zaiAdapter, openRouterAdapter],
      env: {},
      now: () => new Date("2026-10-03T00:01:00Z"),
    });
    const res = await app.request("/api/overview");
    const overview = (await res.json()) as {
      providers: Array<{ id: string; planOnly: boolean; notes: unknown[]; points: unknown[] }>;
    };
    // Adapters keep their order; plan-only rows (a subscription with no API to poll) follow them.
    expect(overview.providers.slice(0, 2).map((p) => p.id)).toEqual(["zai", "openrouter"]);
    for (const planOnly of overview.providers.slice(2)) {
      expect(planOnly.planOnly).toBe(true);
      expect(planOnly.points).toHaveLength(0);
    }
    expect(overview.providers[0]!.notes.length).toBeGreaterThan(0);
    db.close();
  });

  test("sessions, audit, and diary endpoints", async () => {
    const db = openDb(dbPath);
    const now = () => new Date("2026-10-03T12:00:00Z");
    const sessionId = db.startSession("2026-10-03T11:00:00Z", 42);
    db.addAudit(sessionId, "2026-10-03T11:01:00Z", "zai", "info", "poll ok — 21 points");
    db.addAudit(sessionId, "2026-10-03T11:05:00Z", "zai", "error", "poll failed", "HTTP 429");
    db.insertPoints([
      mkUsage({ provider: "zai", kind: "usage", label: "model-daily", model: "glm-4.7", day: "2026-10-02", used: 100, captured_at: "2026-10-02T12:00:00Z" }),
      mkUsage({ provider: "zai", kind: "usage", label: "model-daily", model: "glm-4.7", day: "2026-10-02", used: 150, captured_at: "2026-10-02T18:00:00Z" }),
      mkUsage({ provider: "zai", kind: "quota", label: "coding-5h", used: 40, limit: 100, unit: "percent", captured_at: "2026-10-02T18:00:00Z" }),
    ]);

    const app = buildApi({ db, adapters: [zaiAdapter], env: {}, now, currentSessionId: sessionId });

    const sessionsRes = await app.request("/api/sessions");
    const sessions = (await sessionsRes.json()) as {
      currentSessionId: number | null;
      sessions: Array<{ id: number; stopped_at: string | null }>;
    };
    expect(sessions.currentSessionId).toBe(sessionId);
    expect(sessions.sessions[0]?.id).toBe(sessionId);

    const auditRes = await app.request(`/api/audit?session=${sessionId}`);
    const audit = (await auditRes.json()) as { events: Array<{ event: string; level: string }> };
    expect(audit.events.length).toBe(2);
    expect(audit.events[0]?.level).toBe("error");

    const diaryRes = await app.request("/api/diary?days=7");
    const diary = (await diaryRes.json()) as {
      days: Array<{ date: string; providers: Array<{ id: string; entries: Array<{ label: string; model: string | null; used: number | null }> }>; errors: number }>;
    };
    expect(diary.days.length).toBeGreaterThanOrEqual(1);
    const oct2 = diary.days.find((d) => d.date === "2026-10-02");
    expect(oct2).toBeDefined();
    expect(oct2?.errors).toBe(0); // the 429 landed on 10-03, not 10-02
    const model = oct2?.providers[0]?.entries.find((e) => e.label === "model-daily");
    expect(model?.used).toBe(150); // later capture of the day wins
    expect(model?.model).toBe("glm-4.7");
    const window = oct2?.providers[0]?.entries.find((e) => e.label === "coding-5h");
    expect(window?.used).toBe(40);
    db.close();
  });

  test("zai: required poll ok, optional balance 404 tolerated", async () => {
    const db = openDb(dbPath);
    const env = {
      ZAI_API_KEY: "zai-key",
      ZAI_BASE_URL: `http://127.0.0.1:${zaiMock.port}`,
    };
    const scheduler = new Scheduler({ adapters: [zaiAdapter], db, env });
    const outcome = await scheduler.runProvider("zai");
    expect(outcome.ok).toBe(true);
    const labels = outcome.points.map((p) => p.label);
    expect(labels).toContain("mcp");
    expect(labels).toContain("coding-5h");
    expect(labels).toContain("coding-window-by-model");
    expect(labels).toContain("model-daily");
    expect(labels).not.toContain("payg-balance");
    const five = outcome.points.find((p) => p.label === "coding-5h");
    expect(five?.unit).toBe("percent");
    expect(five?.used).toBe(5);

    const raw = db.lastRawPolls("zai", 10);
    // batch-scoped: other tests add zai raw polls to this shared db
    const latestBatch = raw[0]?.captured_at;
    const latestEndpoints = [...new Set(raw.filter((r) => r.captured_at === latestBatch).map((p) => p.endpoint))].sort();
    expect(latestEndpoints).toEqual(["balance", "coding-usage", "model-usage", "quota-limit"]);

    // degradedEndpoints surfaces the latest batch's soft-fails (balance 404) for the UI
    const app2 = buildApi({ db, adapters: [zaiAdapter], env, now: () => new Date("2026-10-03T00:02:00Z") });
    const ov = (await (await app2.request("/api/overview")).json()) as {
      providers: Array<{
        id: string;
        degradedEndpoints: Array<{ endpoint: string; status: number }>;
        windows: Array<{ window: string; usedPercent: number | null; resetsAt: string | null; source: string; stale: boolean }>;
      }>;
    };
    const zaiOv = ov.providers.find((pr) => pr.id === "zai");
    expect(zaiOv?.degradedEndpoints).toEqual([{ endpoint: "balance", status: 404 }]);
    expect(zaiOv?.windows.find((w) => w.window === "five_hour")).toMatchObject({
      usedPercent: 5,
      source: "zai-api",
      stale: false,
      resetsAt: new Date(1791047424085).toISOString(),
    });
    db.close();
  });
});
