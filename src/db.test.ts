import { describe, expect, test } from "bun:test";
import { openDb } from "./db";
import type { UsagePoint } from "./adapters/types";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function mkPoint(overrides: Partial<UsagePoint> = {}): UsagePoint {
  return {
    provider: "openrouter",
    kind: "balance",
    label: "credits",
    model: null,
    used: 5,
    limit: 20,
    remaining: 15,
    unit: "usd",
    window_start: null,
    window_end: null,
    reset_at: null,
    day: null,
    requests: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    captured_at: "2026-10-03T00:00:00Z",
    ...overrides,
  };
}

function testDb() {
  return openDb(join(mkdtempSync(join(tmpdir(), "modelizer-db-")), "test.db"));
}

describe("db", () => {
  test("latestPoints keeps only the newest capture per group", () => {
    const db = testDb();
    db.insertPoints([mkPoint({ captured_at: "2026-10-03T00:00:00Z", used: 5 })]);
    db.insertPoints([mkPoint({ captured_at: "2026-10-03T00:15:00Z", used: 7 })]);
    db.insertPoints([mkPoint({ provider: "openrouter", kind: "quota", label: "other", captured_at: "2026-10-03T00:15:00Z" })]);

    const latest = db.latestPoints();
    expect(latest.length).toBe(2);
    const credits = latest.find((p) => p.label === "credits");
    expect(credits?.used).toBe(7);
    expect(credits?.captured_at).toBe("2026-10-03T00:15:00Z");
    db.close();
  });

  test("quota window fields round-trip", () => {
    const db = testDb();
    db.insertPoints([
      mkPoint({
        kind: "quota",
        label: "codex-5h-percent",
        unit: "percent",
        used: 12,
        limit: 100,
        quota_window: "five_hour",
        source: "app-server",
        stale: true,
        used_percent: 12,
        reset_at: "2026-10-03T05:00:00.000Z",
      }),
    ]);
    const row = db.latestPoints()[0];
    expect(row?.quota_window).toBe("five_hour");
    expect(row?.source).toBe("app-server");
    expect(row?.stale).toBe(true);
    expect(row?.used_percent).toBe(12);
    expect(row?.reset_at).toBe("2026-10-03T05:00:00.000Z");
    db.close();
  });

  test("same label different model/day are separate groups", () => {
    const db = testDb();
    db.insertPoints([
      mkPoint({ kind: "usage", label: "spend", model: "gpt-x", day: "2026-10-02" }),
      mkPoint({ kind: "usage", label: "spend", model: "claude-y", day: "2026-10-02" }),
    ]);
    expect(db.latestPoints().length).toBe(2);
    db.close();
  });

  test("adapter state: failures accumulate, success resets", () => {
    const db = testDb();
    db.updateAdapterState("openrouter", { ok: false, error: "HTTP 500", at: "2026-10-03T00:00:00Z" });
    db.updateAdapterState("openrouter", { ok: false, error: "HTTP 500", at: "2026-10-03T00:15:00Z" });
    let state = db.getAdapterState("openrouter");
    expect(state?.consecutive_failures).toBe(2);
    expect(state?.last_error).toBe("HTTP 500");

    db.updateAdapterState("openrouter", { ok: true, at: "2026-10-03T00:30:00Z" });
    state = db.getAdapterState("openrouter");
    expect(state?.consecutive_failures).toBe(0);
    expect(state?.last_success).toBe("2026-10-03T00:30:00Z");
    expect(state?.last_error).toBeNull();
    expect(state?.last_error_at).toBeNull();
    db.close();
  });

  test("raw polls archived newest-first", () => {
    const db = testDb();
    db.insertRawPolls("openrouter", [{ endpoint: "key", url: "u", status: 200, body: "{}", json: {}, headers: {} }], "t1");
    db.insertRawPolls("openrouter", [{ endpoint: "credits", url: "u2", status: 200, body: "{}", json: {}, headers: {} }], "t2");
    const polls = db.lastRawPolls("openrouter", 10);
    expect(polls.length).toBe(2);
    expect(polls[0]?.endpoint).toBe("credits");
    db.close();
  });

  test("sessions: start, end, list", () => {
    const db = testDb();
    const id1 = db.startSession("2026-10-03T10:00:00Z", 111);
    const id2 = db.startSession("2026-10-03T11:00:00Z", 222);
    db.endSession(id1, "2026-10-03T10:30:00Z");
    const sessions = db.listSessions(10);
    expect(sessions.length).toBe(2);
    expect(sessions[0]?.id).toBe(id2); // newest first
    expect(sessions[0]?.stopped_at).toBeNull(); // still running
    expect(sessions[1]?.id).toBe(id1);
    expect(sessions[1]?.stopped_at).toBe("2026-10-03T10:30:00Z");
    db.close();
  });

  test("audit events: written per session, filterable, newest-first", () => {
    const db = testDb();
    const s1 = db.startSession("2026-10-03T10:00:00Z", 1);
    const s2 = db.startSession("2026-10-03T11:00:00Z", 2);
    db.addAudit(s1, "2026-10-03T10:01:00Z", "zai", "info", "poll ok — 21 points");
    db.addAudit(s2, "2026-10-03T11:01:00Z", "zai", "error", "poll failed", "HTTP 429; backing off 60s");
    db.addAudit(s2, "2026-10-03T11:02:00Z", null, "warn", "missing credentials", "OPENROUTER_API_KEY");

    const forS2 = db.auditEvents({ sessionId: s2, limit: 10 });
    expect(forS2.length).toBe(2);
    expect(forS2[0]?.event).toBe("missing credentials"); // newest first
    expect(forS2[1]?.provider).toBe("zai");
    const all = db.auditEvents({ limit: 10 });
    expect(all.length).toBe(3);
    db.close();
  });
});
