import { describe, expect, test } from "bun:test";
import { Scheduler } from "./scheduler";
import type { Adapter, RawPoll, UsagePoint } from "./adapters/types";
import { openDb } from "./db";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const POLL_EVERY = 15 * 60_000;

function fakeAdapter(overrides: Partial<Adapter> = {}): Adapter {
  return {
    id: "fake",
    stabilityTier: 1,
    pollEveryMs: POLL_EVERY,
    isConfigured: () => true,
    missingCredentials: () => [],
    collect: async () => [{ endpoint: "e", url: "u", status: 200, body: "{}", json: {}, headers: {} }],
    normalize: (_polls, capturedAt) => [
      {
        provider: "fake",
        kind: "balance",
        label: "credits",
        model: null,
        used: 1,
        limit: 10,
        remaining: 9,
        unit: "usd",
        window_start: null,
        window_end: null,
        reset_at: null,
        day: null,
        requests: null,
        tokens_in: null,
        tokens_out: null,
        cost_usd: null,
        captured_at: capturedAt,
      },
    ],
    ...overrides,
  };
}

function harness(adapters: Adapter[], env: Record<string, string> = {}) {
  let nowMs = Date.parse("2026-10-03T00:00:00Z");
  const db = openDb(join(mkdtempSync(join(tmpdir(), "modelizer-sched-")), "s.db"));
  const scheduler = new Scheduler({
    adapters,
    db,
    env,
    clock: () => new Date(nowMs),
    maxBackoffMs: 3600_000,
    random: () => 0.5, // deterministic jitter: 0.9 + 0.2×0.5 = exactly 1.0× interval
  });
  return {
    db,
    scheduler,
    advance: (ms: number) => {
      nowMs += ms;
    },
    now: () => nowMs,
  };
}

describe("scheduler", () => {
  test("success persists points, raw polls, and state; reschedules one interval out", async () => {
    const h = harness([fakeAdapter()]);
    const outcome = await h.scheduler.runProvider("fake");
    expect(outcome.ok).toBe(true);
    expect(outcome.points.length).toBe(1);
    expect(outcome.nextDueInMs).toBe(POLL_EVERY);

    const state = h.db.getAdapterState("fake");
    expect(state?.consecutive_failures).toBe(0);
    expect(state?.last_success).toBe("2026-10-03T00:00:00.000Z");
    expect(h.db.latestPoints().length).toBe(1);
    expect(h.db.lastRawPolls("fake", 5).length).toBe(1);
    expect(h.scheduler.isDue("fake")).toBe(false);
    h.advance(POLL_EVERY + 1);
    expect(h.scheduler.isDue("fake")).toBe(true);
    h.db.close();
  });

  test("collect failure: exponential backoff grows with consecutive failures", async () => {
    let calls = 0;
    const adapter = fakeAdapter({
      collect: async () => {
        calls += 1;
        throw new Error("network down");
      },
    });
    const h = harness([adapter]);
    const first = await h.scheduler.runProvider("fake");
    expect(first.ok).toBe(false);
    expect(first.error).toContain("network down");
    expect(first.nextDueInMs).toBe(POLL_EVERY * 2);

    h.advance(first.nextDueInMs);
    const second = await h.scheduler.runProvider("fake");
    expect(second.nextDueInMs).toBe(POLL_EVERY * 4);
    expect(h.db.getAdapterState("fake")?.consecutive_failures).toBe(2);
    expect(calls).toBe(2);
    h.db.close();
  });

  test("HTTP 429 with retry-after overrides backoff when larger", async () => {
    const adapter = fakeAdapter({
      collect: async () =>
        [
          {
            endpoint: "e",
            url: "u",
            status: 429,
            body: "slow down",
            json: null,
            headers: { "retry-after": "1800" },
          },
        ] satisfies RawPoll[],
    });
    const h = harness([adapter]);
    const outcome = await h.scheduler.runProvider("fake");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("429");
    expect(outcome.nextDueInMs).toBe(1_800_000);
    h.db.close();
  });

  test("missing credentials: soft failure at normal cadence", async () => {
    const adapter = fakeAdapter({
      isConfigured: () => false,
      missingCredentials: () => ["FAKE_KEY"],
    });
    const h = harness([adapter]);
    const outcome = await h.scheduler.runProvider("fake");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("missing credentials: FAKE_KEY");
    expect(outcome.nextDueInMs).toBe(POLL_EVERY);
    expect(h.db.getAdapterState("fake")?.last_error).toContain("FAKE_KEY");
    h.db.close();
  });

  test("optional poll failures don't fail the run", async () => {
    const adapter = fakeAdapter({
      id: "opt",
      collect: async () =>
        [
          { endpoint: "primary", url: "u", status: 200, body: "{}", json: {}, headers: {} },
          { endpoint: "secondary", url: "u2", status: 404, body: "nope", json: null, headers: {}, optional: true },
        ] satisfies RawPoll[],
      normalize: (polls, capturedAt) =>
        polls
          .filter((p) => p.status === 200)
          .map(() => ({
            provider: "opt",
            kind: "quota" as const,
            label: "only",
            model: null,
            used: 1,
            limit: 2,
            remaining: 1,
            unit: "tokens" as const,
            window_start: null,
            window_end: null,
            reset_at: null,
            day: null,
            requests: null,
            tokens_in: null,
            tokens_out: null,
            cost_usd: null,
            captured_at: capturedAt,
          })),
    });
    const h = harness([adapter]);
    const outcome = await h.scheduler.runProvider("opt");
    expect(outcome.ok).toBe(true);
    expect(outcome.points.length).toBe(1);
    h.db.close();
  });

  test("successful run with optional 429 + retry-after extends the next poll", async () => {
    const adapter = fakeAdapter({
      id: "degraded",
      collect: async () =>
        [
          { endpoint: "primary", url: "u", status: 200, body: "{}", json: {}, headers: {} },
          {
            endpoint: "flaky",
            url: "u2",
            status: 429,
            body: "slow down",
            json: null,
            headers: { "retry-after": "1800" },
            optional: true,
          },
        ] satisfies RawPoll[],
    });
    const h = harness([adapter]);
    const outcome = await h.scheduler.runProvider("degraded");
    expect(outcome.ok).toBe(true);
    expect(outcome.nextDueInMs).toBeGreaterThanOrEqual(1_800_000);
    h.db.close();
  });

  test("jitter stays within ±10% of the poll interval", async () => {
    for (const r of [0, 0.5, 1]) {
      const db = openDb(join(mkdtempSync(join(tmpdir(), "modelizer-sched-")), "s.db"));
      const scheduler = new Scheduler({
        adapters: [fakeAdapter({ id: "jit" })],
        db,
        env: {},
        clock: () => new Date(0),
        random: () => r,
      });
      const outcome = await scheduler.runProvider("jit");
      const expected = POLL_EVERY * (0.9 + 0.2 * r);
      expect(Math.abs(outcome.nextDueInMs - expected)).toBeLessThan(2);
      db.close();
    }
  });

  test("audit sink records ok / failure / missing-credentials outcomes", async () => {
    const events: Array<{ provider: string | null; level: string; event: string }> = [];
    const audit = (e: { provider: string | null; level: string; event: string }) => events.push(e);

    const failing = fakeAdapter({
      id: "fail-audit",
      collect: async () => {
        throw new Error("network down");
      },
    });
    const missing = fakeAdapter({
      id: "missing-audit",
      isConfigured: () => false,
      missingCredentials: () => ["X_KEY"],
    });

    let nowMs = 0;
    const db = openDb(join(mkdtempSync(join(tmpdir(), "modelizer-audit-")), "a.db"));
    const scheduler = new Scheduler({
      adapters: [fakeAdapter({ id: "ok-audit" }), failing, missing],
      db,
      env: {},
      clock: () => new Date(nowMs),
      random: () => 0.5,
      audit,
    });
    await scheduler.runProvider("ok-audit");
    await scheduler.runProvider("fail-audit");
    await scheduler.runProvider("missing-audit");
    nowMs += 1;

    expect(events.find((e) => e.provider === "ok-audit")?.event).toContain("poll ok — 1 points");
    const fail = events.find((e) => e.provider === "fail-audit");
    expect(fail?.level).toBe("error");
    expect(fail?.event).toBe("poll failed");
    const creds = events.find((e) => e.provider === "missing-audit");
    expect(creds?.level).toBe("warn");
    expect(creds?.event).toBe("missing credentials");
    db.close();
  });

  test("tick only runs adapters that are due", async () => {
    let calls = 0;
    const adapter = fakeAdapter({
      id: "counter",
      collect: async () => {
        calls += 1;
        return [{ endpoint: "e", url: "u", status: 200, body: "{}", json: {}, headers: {} }];
      },
    });
    const h = harness([adapter]);
    await h.scheduler.tick();
    expect(calls).toBe(1);
    await h.scheduler.tick();
    expect(calls).toBe(1);
    h.advance(POLL_EVERY + 1);
    await h.scheduler.tick();
    expect(calls).toBe(2);
    h.db.close();
  });
});
