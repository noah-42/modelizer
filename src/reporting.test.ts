import { describe, expect, test } from "bun:test";
import { ADAPTERS_BY_ID } from "./adapters";
import { buildApi } from "./api";
import { openDb } from "./db";
import { capabilitiesOf, provenanceOf, snapshotVersionOf } from "./reporting";
import { windowsFromPoints } from "./windows";
import type { UsagePoint } from "./adapters/types";

function point(fields: Partial<UsagePoint>): UsagePoint {
  return {
    provider: "zai",
    kind: "quota",
    label: "coding-5h",
    model: null,
    used: null,
    limit: null,
    remaining: null,
    unit: "percent",
    window_start: null,
    window_end: null,
    reset_at: null,
    day: null,
    requests: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    captured_at: "2026-11-07T00:00:00.000Z",
    ...fields,
  };
}

describe("provenance", () => {
  const zai = ADAPTERS_BY_ID.get("zai");
  test("a poll against the production origin proves the real account, with a non-secret ref", () => {
    const raws = [
      {
        endpoint: "quota-limit",
        url: "https://api.z.ai/api/monitor/usage/quota/limit",
        status: 200,
        body: JSON.stringify({ code: 200, data: { level: "lite", limits: [] }, success: true }),
      },
    ];
    const p = provenanceOf(zai!, "0.1.0", { last_success: "2026-11-07T00:00:45.231Z" } as never, raws, {});
    expect(p.mode).toBe("real");
    expect(p.upstreamOrigin).toBe("https://api.z.ai");
    expect(p.accountRef).toBe("zai-coding-level:lite");
    expect(p.accountLabel).toBe("GLM Coding Plan (level: lite)");
    expect(p.lastRealCheck).toBe("2026-11-07T00:00:45.231Z");
    // No secret material anywhere in the provenance block.
    expect(JSON.stringify(p)).not.toContain("Bearer");
  });

  test("a mock origin reads as demo; no polls read as unknown", () => {
    const raws = [{ endpoint: "quota-limit", url: "http://127.0.0.1:9801/quota", status: 200, body: "{}" }];
    expect(provenanceOf(zai!, "0.1.0", undefined, raws, { ZAI_BASE_URL: "http://127.0.0.1:9801" }).mode).toBe("demo");
    expect(provenanceOf(zai!, "0.1.0", undefined, [], {}).mode).toBe("unknown");
  });

  test("a provider without declared origins stays honest: unknown", () => {
    const claude = ADAPTERS_BY_ID.get("claude")!;
    const raws = [{ endpoint: "statusline", url: "statusline://snapshot", status: 200, body: "{}" }];
    expect(provenanceOf(claude, "0.1.0", { last_success: "2026-11-07T00:00:00Z" } as never, raws, {}).mode).toBe("unknown");
  });
});

describe("self-contained windows", () => {
  test("a window carries identity, unit, values, capture time and a qualified reset", () => {
    const points = [
      point({
        quota_window: "five_hour",
        used_percent: 0,
        used: 0,
        source: "zai-api",
      }),
      point({
        provider: "codex",
        label: "rate_limit",
        quota_window: "weekly",
        unit: "percent",
        used_percent: 6,
        used: 6,
        reset_at: "2026-11-13T22:28:37.000Z",
        source: "app-server",
      }),
    ];
    const windows = windowsFromPoints(points);
    const fiveHour = windows.find((w) => w.window === "five_hour")!;
    expect(fiveHour.id).toBe("zai|five_hour");
    expect(fiveHour.scope).toBe("coding-5h");
    expect(fiveHour.unit).toBe("percent");
    expect(fiveHour.capturedAt).toBe("2026-11-07T00:00:00.000Z");
    // Percentage-only: no reset is manufactured.
    expect(fiveHour.reset).toEqual({
      resetsAt: null,
      basis: "unavailable",
      reason: "provider-does-not-expose",
      windowKind: "rolling",
    });
    const weekly = windows.find((w) => w.window === "weekly")!;
    expect(weekly.reset).toEqual({
      resetsAt: "2026-11-13T22:28:37.000Z",
      basis: "provider-reported",
      reason: null,
      windowKind: "fixed",
    });
    expect(weekly.resetsAt).toBe(weekly.reset.resetsAt);
  });

  test("stale windows report their missing reset as stale-data, never a synthesized clock", () => {
    const windows = windowsFromPoints([point({ quota_window: "five_hour", used_percent: null, stale: true })]);
    expect(windows[0]?.reset).toEqual({
      resetsAt: null,
      basis: "unavailable",
      reason: "stale-data",
      windowKind: "rolling",
    });
  });
});

describe("capability matrix", () => {
  const zai = ADAPTERS_BY_ID.get("zai")!;
  test("Z.AI weekly/monthly coding windows are unsupported, not inferred", () => {
    const caps = capabilitiesOf({
      adapter: zai,
      state: { last_error: null } as never,
      hasSuccessfulPoints: true,
      windows: [{ id: "zai|five_hour", window: "five_hour", stale: false, reset: { resetsAt: null, basis: "unavailable", reason: "provider-does-not-expose", windowKind: "rolling" } } as never],
      planOnly: false,
      subscription: null,
    });
    expect(caps.usage).toBe("supported");
    expect(caps.shortWindow).toBe("supported");
    expect(caps.weeklyWindow).toBe("unsupported");
    expect(caps.monthlyWindow).toBe("unsupported");
    expect(caps.resetTimestamps).toBe("unknown");
  });

  test("an auth failure marks usage auth-required, and a plan-only card is unsupported", () => {
    const authed = capabilitiesOf({
      adapter: zai,
      state: { last_error: "auth: ZAI_API_KEY rejected" } as never,
      hasSuccessfulPoints: false,
      windows: [],
      planOnly: false,
      subscription: null,
    });
    expect(authed.usage).toBe("auth-required");
    const planOnly = capabilitiesOf({
      adapter: zai,
      state: undefined,
      hasSuccessfulPoints: false,
      windows: [],
      planOnly: true,
      subscription: { renewsAt: null, endsAt: "2027-02-28" } as never,
    });
    expect(planOnly.usage).toBe("unsupported");
    expect(planOnly.expiry).toBe("supported");
  });
});

describe("snapshot version", () => {
  test("changes only when a watched value changes", () => {
    const a = [{ id: "zai|five_hour", usedPercent: 0, resetsAt: null, stale: false }];
    const same = [{ id: "zai|five_hour", usedPercent: 0, resetsAt: null, stale: false }];
    const changed = [{ id: "zai|five_hour", usedPercent: 40, resetsAt: null, stale: false }];
    expect(snapshotVersionOf(a)).toBe(snapshotVersionOf(same));
    expect(snapshotVersionOf(a)).not.toBe(snapshotVersionOf(changed));
  });
});

describe("change events feed", () => {
  test("/api/events classifies recovery and errors, never plain polls", async () => {
    const root = `/tmp/modelizer-events-${Date.now()}`;
    const db = openDb(`${root}.db`);
    const app = buildApi({ db, adapters: [], env: {} });
    // Seed the audit trail through the same prepared statement the scheduler's sink uses.
    const insert = db.raw.prepare(
      "INSERT INTO audit_events (session_id, at, provider, level, event, detail) VALUES (1, $at, $provider, $level, $event, $detail)",
    );
    insert.run({ $at: "2026-11-07T00:00:00Z", $provider: "zai", $level: "error", $event: "quota-limit → HTTP 500", $detail: null });
    insert.run({ $at: "2026-11-07T00:15:00Z", $provider: "zai", $level: "error", $event: "auth: ZAI_API_KEY rejected", $detail: null });
    insert.run({ $at: "2026-11-07T00:30:00Z", $provider: "zai", $level: "info", $event: "poll ok — 2 points", $detail: null });
    insert.run({ $at: "2026-11-07T00:45:00Z", $provider: "zai", $level: "info", $event: "poll ok — 2 points", $detail: null });
    const r = await app.request("/api/events");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { events: Array<{ type: string; at: string; detail: string | null }> };
    const types = body.events.map((e) => e.type);
    // Two failures, then one access-recovered event for the first success; the second plain poll is not an event.
    expect(types).toEqual(["access-recovered", "auth-failure", "poll-error"]);
    expect(body.events[0]?.detail).toContain("access recovery, not quota recovery");
  });
});
