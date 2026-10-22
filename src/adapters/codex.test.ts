import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authJsonPath, codexAdapter, codexFactsFromClaims, readCodexClaims, type CodexSummary } from "./codex";
import type { CollectContext, RawPoll } from "./types";

// Timestamps are pinned around a fixed "now" so the 8-day scan window is deterministic.
const NOW = new Date("2026-10-12T16:00:00.000Z");

const root = mkdtempSync(join(tmpdir(), "modelizer-codex-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Codex layout: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
function fixtureDir(name: string): string {
  const dir = join(root, name, "2026", "10", "12");
  mkdirSync(dir, { recursive: true });
  return join(root, name);
}

function ctx(dir: string): CollectContext {
  return { fetchFn: fetch, env: { CODEX_SESSIONS_DIR: dir, CODEX_APP_SERVER: "0" }, now: NOW, log: () => {} };
}

interface Turn {
  ordinal: number;
  ts: string;
  model?: string; // emits a turn_context when set
  input?: number;
  cached?: number;
  output?: number;
  total?: number;
  turnId: string;
}

// Shape verified against real ~/.codex/sessions rollout files (2026-10-12).
function turn(t: Turn): string[] {
  const lines: string[] = [];
  if (t.model !== undefined) {
    lines.push(JSON.stringify({
      timestamp: t.ts,
      ordinal: t.ordinal,
      type: "turn_context",
      payload: { turn_id: `ctx-${t.turnId}`, model: t.model, model_reasoning_effort: "low" },
    }));
  }
  const input = t.input ?? 0;
  const cached = t.cached ?? 0;
  const output = t.output ?? 0;
  lines.push(JSON.stringify({
    timestamp: t.ts,
    ordinal: t.ordinal + 0.5,
    type: "token_usage_record",
    payload: {
      session_id: "sess-1",
      turn_id: t.turnId,
      response_id: `resp-${t.turnId}`,
      turn_token_usage: {
        input_tokens: input, // includes cached in the wild
        cached_input_tokens: cached,
        cache_write_input_tokens: 0,
        output_tokens: output,
        reasoning_output_tokens: 0,
        total_tokens: t.total ?? input + output,
      },
    },
  }));
  return lines;
}

function writeSession(dir: string, file: string, lines: string[]): string {
  const path = join(dir, file);
  // Interleave non-usage entries like real rollouts contain.
  writeFileSync(path, [
    JSON.stringify({ timestamp: "2026-10-12T00:00:00.000Z", ordinal: -10, type: "session_meta", payload: {} }),
    "not json",
    ...lines,
  ].join("\n"));
  return path;
}

describe("codex adapter (T3 local transcripts)", () => {
  test("collect+normalize: blocks, daily per-model split, junk skipped", async () => {
    const dir = fixtureDir("main");
    writeSession(dir, "rollout-a.jsonl", [
      ...turn({ ordinal: 1, ts: "2026-10-12T09:00:00.000Z", model: "gpt-5.5", input: 1000, cached: 400, output: 200, turnId: "t1" }),
      ...turn({ ordinal: 2, ts: "2026-10-12T10:30:00.000Z", input: 500, output: 100, turnId: "t2" }),
      // ≥5h after the 09:00 anchor → new block.
      ...turn({ ordinal: 3, ts: "2026-10-12T15:00:00.000Z", model: "gpt-6.1-sol", input: 300, cached: 100, output: 60, turnId: "t3" }),
      // A second model in a *separate* session file, same day, within the active block window.
    ]);
    writeSession(dir, "rollout-b.jsonl", [
      ...turn({ ordinal: 1, ts: "2026-10-12T15:30:00.000Z", model: "gpt-5.6-terra", input: 50, output: 25, turnId: "u1" }),
      // Previous UTC day (different file per day in the wild).
    ]);
    const dirB = join(root, "main", "2026", "10", "11");
    mkdirSync(dirB, { recursive: true });
    writeFileSync(join(dirB, "rollout-c.jsonl"), [
      JSON.stringify({ timestamp: "2026-10-11T18:00:00.000Z", ordinal: 1, type: "token_usage_record", payload: { session_id: "s2", turn_id: "v1", response_id: "r-v1", turn_token_usage: { input_tokens: 40, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 50 } } }),
    ].join("\n"));

    const polls = await codexAdapter.collect(ctx(join(root, "main")));
    expect(polls).toHaveLength(1);
    const poll = polls.at(0);
    if (poll === undefined) throw new Error("no poll returned");
    expect(poll.endpoint).toBe("sessions-jsonl");
    expect(poll.status).toBe(200);

    const s = poll.json as CodexSummary;
    expect(s.files).toBe(3);
    expect(s.turns).toBe(5);
    // v1 (Oct 11 18:00) sorts first and anchors its own block; then 09:00 and 15:00 on Oct 12.
    expect(s.blocks).toHaveLength(3);
    expect(s.blocks.at(0)).toEqual({ start: "2026-10-11T18:00:00.000Z", end: "2026-10-11T23:00:00.000Z", used: 50, requests: 1 });
    expect(s.blocks.at(1)).toEqual({ start: "2026-10-12T09:00:00.000Z", end: "2026-10-12T14:00:00.000Z", used: 1800, requests: 2 });

    const points = codexAdapter.normalize(polls, "2026-10-12T16:00:01.000Z");
    const five = points.find((p) => p.label === "codex-5h");
    // Active block: t3 (300+60) + u1 (50+25) — no budget configured → limit/remaining null.
    expect(five).toMatchObject({
      kind: "usage",
      unit: "tokens",
      used: 435,
      window_start: "2026-10-12T15:00:00.000Z",
      window_end: "2026-10-12T20:00:00.000Z",
      reset_at: "2026-10-12T20:00:00.000Z",
      requests: 2,
    });
    expect(five?.limit).toBeNull();

    const daily = points.filter((p) => p.label === "model-daily");
    expect(daily).toHaveLength(4);
    const sol = daily.find((p) => p.model === "gpt-6.1-sol");
    expect(sol).toMatchObject({ day: "2026-10-12", used: 360, tokens_in: 300, tokens_out: 60, requests: 1 });
    const terra = daily.find((p) => p.model === "gpt-5.6-terra");
    expect(terra).toMatchObject({ day: "2026-10-12", used: 75, requests: 1 });
    const gpt55 = daily.find((p) => p.model === "gpt-5.5");
    expect(gpt55).toMatchObject({ day: "2026-10-12", used: 1800, requests: 2 }); // model sticks after turn_context
    const v1 = daily.find((p) => p.day === "2026-10-11");
    expect(v1).toMatchObject({ used: 50, requests: 1, model: "unknown" }); // no turn_context in that file
  });

  test("duplicate turn records (same session/turn/response) count once", async () => {
    const dir = fixtureDir("dup");
    const lines = turn({ ordinal: 1, ts: "2026-10-12T12:00:00.000Z", input: 10, output: 5, turnId: "x" });
    writeSession(dir, "rollout-dup.jsonl", [...lines, ...lines]); // exact duplicate entry
    const polls = await codexAdapter.collect(ctx(join(root, "dup")));
    const s = polls.at(0)?.json as CodexSummary | undefined;
    expect(s?.duplicates).toBe(1);
    expect(s?.turns).toBe(1);
    expect(s?.blocks.at(0)?.used).toBe(15);
  });

  test("files untouched for 8+ days are skipped entirely", async () => {
    const dir = fixtureDir("stale");
    const f = writeSession(dir, "rollout-old.jsonl", [
      ...turn({ ordinal: 1, ts: "2026-09-01T10:00:00.000Z", input: 5, output: 5, turnId: "old" }),
    ]);
    utimesSync(f, new Date("2026-09-01"), new Date("2026-09-01"));
    const polls = await codexAdapter.collect(ctx(join(root, "stale")));
    const s = polls.at(0)?.json as CodexSummary | undefined;
    expect(s?.files).toBe(0);
    expect(s?.turns).toBe(0);
    expect(() => codexAdapter.normalize(polls, "2026-10-12T16:00:01.000Z")).toThrow(/no turn usage/);
  });

  test("CODEX_SESSION_TOKENS/TURNS add budget points with remaining", async () => {
    const dir = fixtureDir("budget");
    writeSession(dir, "rollout-b.jsonl", [
      ...turn({ ordinal: 1, ts: "2026-10-12T14:00:00.000Z", input: 300, output: 200, turnId: "b1" }),
      ...turn({ ordinal: 2, ts: "2026-10-12T15:00:00.000Z", input: 100, output: 50, turnId: "b2" }),
    ]);
    const polls = await codexAdapter.collect({
      fetchFn: fetch,
      env: { CODEX_SESSIONS_DIR: dir, CODEX_SESSION_TOKENS: "10000", CODEX_SESSION_TURNS: "3", CODEX_APP_SERVER: "0" },
      now: NOW,
      log: () => {},
    });
    const points = codexAdapter.normalize(polls, "2026-10-12T16:00:01.000Z");
    expect(points.find((p) => p.label === "codex-5h")).toMatchObject({ used: 650, limit: 10000, remaining: 9350 });
    expect(points.find((p) => p.label === "codex-5h-turns")).toMatchObject({
      kind: "quota", unit: "requests", used: 2, limit: 3, remaining: 1, reset_at: "2026-10-12T19:00:00.000Z",
    });
  });

  test("rate_limits telemetry → real quota percent points (latest snapshot wins)", async () => {
    const dir = fixtureDir("rl");
    const rlEvent = (
      ordinal: number,
      ts: string,
      primaryUsed: number,
      secondaryUsed: number,
      primaryResetSec: number,
    ) =>
      JSON.stringify({
        timestamp: ts,
        ordinal,
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            limit_id: "codex",
            primary: { used_percent: primaryUsed, window_minutes: 300, resets_at: primaryResetSec },
            secondary: { used_percent: secondaryUsed, window_minutes: 10080, resets_at: primaryResetSec + 600_000 },
            credits: { has_credits: false, unlimited: false, balance: "0" },
            plan_type: "plus",
          },
        },
      });
    // older snapshot (90% used) must lose to the newer one (43%)
    writeSession(dir, "rollout-rl.jsonl", [
      ...turn({ ordinal: 1, ts: "2026-10-12T15:00:00.000Z", model: "gpt-6.1-sol", input: 100, output: 10, turnId: "r1" }),
      rlEvent(2, "2026-10-12T15:30:00.000Z", 90, 20, 1791910105),
      rlEvent(3, "2026-10-12T15:45:00.000Z", 43, 7, 1791910105),
    ]);

    const polls = await codexAdapter.collect(ctx(dir));
    const s = polls.at(0)?.json as CodexSummary | undefined;
    expect(s?.rateLimits?.planType).toBe("plus");
    expect(s?.rateLimits?.primary?.usedPercent).toBe(43);

    const points = codexAdapter.normalize(polls, "2026-10-12T16:00:01.000Z");
    const five = points.find((p) => p.label === "codex-5h-percent");
    expect(five).toMatchObject({
      kind: "quota",
      unit: "percent",
      used: 43,
      limit: 100,
      remaining: 57,
      reset_at: new Date(1791910105 * 1000).toISOString(),
    });
    const weekly = points.find((p) => p.label === "codex-weekly-percent");
    expect(weekly).toMatchObject({ used: 7, limit: 100, remaining: 93, unit: "percent" });
  });

  test("a rate-limit window whose reset has passed rolls forward to 0% used", async () => {
    const dir = fixtureDir("rl-rolled");
    const rlEvent = (ordinal: number, ts: string, primaryUsed: number, secondaryUsed: number, primaryResetSec: number) =>
      JSON.stringify({
        timestamp: ts,
        ordinal,
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            primary: { used_percent: primaryUsed, window_minutes: 300, resets_at: primaryResetSec },
            secondary: { used_percent: secondaryUsed, window_minutes: 10080, resets_at: primaryResetSec + 600_000 },
          },
        },
      });
    // primary reset at 12:00Z; capture happens at 16:00Z → the 5h window rolled meanwhile
    writeSession(dir, "rollout-rolled.jsonl", [
      ...turn({ ordinal: 1, ts: "2026-10-12T11:00:00.000Z", input: 100, output: 10, turnId: "rr1" }),
      rlEvent(2, "2026-10-12T11:30:00.000Z", 80, 5, Date.parse("2026-10-12T12:00:00.000Z") / 1000),
    ]);
    const polls = await codexAdapter.collect(ctx(dir));
    const points = codexAdapter.normalize(polls, "2026-10-12T16:00:01.000Z");
    const five = points.find((p) => p.label === "codex-5h-percent");
    expect(five).toMatchObject({ used: 0, remaining: 100, reset_at: null });
    // weekly reset still in the future → real numbers kept
    const weekly = points.find((p) => p.label === "codex-weekly-percent");
    expect(weekly).toMatchObject({ used: 5, remaining: 95 });
  });

  test("windows follow window_minutes, not the primary/secondary slot", async () => {
    const dir = fixtureDir("swap");
    writeSession(dir, "rollout-swap.jsonl", [
      ...turn({ ordinal: 1, ts: "2026-10-12T15:00:00.000Z", input: 10, output: 1, turnId: "s1" }),
      JSON.stringify({
        timestamp: "2026-10-12T15:10:00.000Z",
        ordinal: 2,
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            // swapped on purpose: primary is the week, secondary is the 5h window
            primary: { used_percent: 9, window_minutes: 10080, resets_at: 1792000000 },
            secondary: { used_percent: 44, window_minutes: 300, resets_at: 1791910105 },
          },
        },
      }),
    ]);
    const polls = await codexAdapter.collect(ctx(dir));
    const points = codexAdapter.normalize(polls, "2026-10-12T16:00:01.000Z");
    expect(points.find((p) => p.label === "codex-5h-percent")).toMatchObject({
      used: 44,
      quota_window: "five_hour",
      source: "session-log",
      reset_at: new Date(1791910105 * 1000).toISOString(),
    });
    expect(points.find((p) => p.label === "codex-weekly-percent")).toMatchObject({
      used: 9,
      quota_window: "weekly",
      reset_at: new Date(1792000000 * 1000).toISOString(),
    });
  });

  test("older logs: resets_in_seconds is relative to the event timestamp; null rate_limits are skipped", async () => {
    const dir = fixtureDir("rel");
    const eventTs = "2026-10-12T15:00:00.000Z";
    writeSession(dir, "rollout-rel.jsonl", [
      ...turn({ ordinal: 1, ts: eventTs, input: 10, output: 1, turnId: "rel1" }),
      JSON.stringify({
        timestamp: eventTs,
        ordinal: 2,
        type: "token_count",
        payload: { rate_limits: null },
      }),
      JSON.stringify({
        timestamp: eventTs,
        ordinal: 3,
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            primary: { used_percent: 15, window_minutes: 300, resets_in_seconds: 7200 },
            secondary: { used_percent: 2, window_minutes: 10080, resets_in_seconds: 86_400 },
          },
        },
      }),
    ]);
    const polls = await codexAdapter.collect(ctx(dir));
    const points = codexAdapter.normalize(polls, "2026-10-12T16:00:01.000Z");
    const anchor = Date.parse(eventTs);
    expect(points.find((p) => p.label === "codex-5h-percent")).toMatchObject({
      used: 15,
      reset_at: new Date(anchor + 7_200_000).toISOString(),
    });
    expect(points.find((p) => p.label === "codex-weekly-percent")?.reset_at).toBe(new Date(anchor + 86_400_000).toISOString());
  });

  test("app-server fixture wins over session logs; logs fill a missing window", async () => {
    const dir = fixtureDir("app");
    writeSession(dir, "rollout-app.jsonl", [
      ...turn({ ordinal: 1, ts: "2026-10-12T15:00:00.000Z", input: 10, output: 1, turnId: "a1" }),
      JSON.stringify({
        timestamp: "2026-10-12T15:05:00.000Z",
        ordinal: 2,
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            primary: { used_percent: 90, window_minutes: 300, resets_at: 1791910105 },
            secondary: { used_percent: 8, window_minutes: 10080, resets_at: 1792000000 },
          },
        },
      }),
    ]);
    const fixture = join(root, "app-server.json");
    writeFileSync(fixture, JSON.stringify({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1791911111 },
        secondary: null,
      },
      rateLimitResetCredits: { availableCount: 1, credits: [] },
    }));
    const polls = await codexAdapter.collect({
      fetchFn: fetch,
      env: { CODEX_SESSIONS_DIR: dir, CODEX_APP_SERVER_FIXTURE: fixture },
      now: NOW,
      log: () => {},
    });
    expect(polls.map((p) => p.endpoint).sort()).toEqual(["app-server", "sessions-jsonl"]);
    expect(polls.find((p) => p.endpoint === "app-server")?.body).toContain("rateLimitResetCredits");
    const points = codexAdapter.normalize(polls, "2026-10-12T16:00:01.000Z");
    expect(points.find((p) => p.label === "codex-5h-percent")).toMatchObject({
      used: 12,
      source: "app-server",
      reset_at: new Date(1791911111 * 1000).toISOString(),
    });
    // weekly was not in the RPC result — the log snapshot fills it
    expect(points.find((p) => p.label === "codex-weekly-percent")).toMatchObject({ used: 8, source: "session-log" });
  });

  test("missing app-server binary falls back to logs without an extra poll", async () => {
    const dir = fixtureDir("nobin");
    writeSession(dir, "rollout-nobin.jsonl", [
      ...turn({ ordinal: 1, ts: "2026-10-12T15:00:00.000Z", input: 10, output: 1, turnId: "n1" }),
      JSON.stringify({
        timestamp: "2026-10-12T15:05:00.000Z",
        ordinal: 2,
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            primary: { used_percent: 21, window_minutes: 300, resets_at: 1791910105 },
          },
        },
      }),
    ]);
    const polls = await codexAdapter.collect({
      fetchFn: fetch,
      env: { CODEX_SESSIONS_DIR: dir, CODEX_BIN: "modelizer-codex-missing" },
      now: NOW,
      log: () => {},
    });
    expect(polls.map((p) => p.endpoint)).toEqual(["sessions-jsonl"]);
    const points = codexAdapter.normalize(polls, "2026-10-12T16:00:01.000Z");
    expect(points.find((p) => p.label === "codex-5h-percent")).toMatchObject({ used: 21, source: "session-log" });
  });

  test("isConfigured / missingCredentials follow the directory", () => {
    expect(codexAdapter.isConfigured({ CODEX_SESSIONS_DIR: join(root, "main") })).toBe(true);
    expect(codexAdapter.missingCredentials({ CODEX_SESSIONS_DIR: join(root, "main") })).toEqual([]);
    const missing = { CODEX_SESSIONS_DIR: join(root, "nope") };
    expect(codexAdapter.isConfigured(missing)).toBe(false);
    expect(codexAdapter.missingCredentials(missing)[0]).toContain("~/.codex/sessions");
  });

  test("normalize: missing or malformed poll is loud", () => {
    expect(() => codexAdapter.normalize([], "at")).toThrow(/no sessions-jsonl poll/);
    const broken: RawPoll = { endpoint: "sessions-jsonl", url: "file://x", status: 200, body: "{}", json: null, headers: {} };
    expect(() => codexAdapter.normalize([broken], "at")).toThrow(/unexpected summary shape/);
  });
});

describe("codex plan claims", () => {
  /** Build a JWT with only the payload we care about; the signature is never checked here. */
  function fakeIdToken(claim: Record<string, unknown>): string {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return `${enc({ alg: "RS256" })}.${enc({ "https://api.openai.com/auth": claim })}.signature`;
  }

  function authFile(name: string, body: unknown): string {
    const home = join(root, name);
    mkdirSync(join(home, "sessions"), { recursive: true });
    writeFileSync(join(home, "auth.json"), JSON.stringify(body));
    return join(home, "sessions");
  }

  test("reads the plan from the id token and nothing else", () => {
    const sessions = authFile("plan-plus", {
      auth_mode: "chatgpt",
      tokens: { id_token: fakeIdToken({ chatgpt_plan_type: "plus", email: "someone@example.com" }) },
    });
    const path = authJsonPath({ CODEX_SESSIONS_DIR: sessions });
    expect(readCodexClaims(path)).toEqual({ planType: "plus", activeUntil: null });
  });

  test("returns null for an API-key login with no id token", () => {
    const sessions = authFile("plan-apikey", { auth_mode: "apikey", OPENAI_API_KEY: "sk-test" });
    expect(readCodexClaims(authJsonPath({ CODEX_SESSIONS_DIR: sessions }))).toBeNull();
  });

  test("returns null when auth.json is absent or malformed", () => {
    mkdirSync(join(root, "no-auth", "sessions"), { recursive: true });
    expect(readCodexClaims(join(root, "no-auth", "auth.json"))).toBeNull();
    const bad = join(root, "bad-auth.json");
    writeFileSync(bad, "{not json");
    expect(readCodexClaims(bad)).toBeNull();
  });

  test("maps plan types to the labels the page shows", () => {
    expect(codexFactsFromClaims({ planType: "plus" })).toEqual({
      provider: "codex",
      planId: "plus",
      planName: "ChatGPT Plus",
      state: "active",
      period: null,
      renewsAt: null,
      seats: null,
      source: "codex-auth",
    });
    expect(codexFactsFromClaims({ planType: "pro" })).toMatchObject({ planName: "ChatGPT Pro" });
    expect(codexFactsFromClaims({ planType: "free" })).toBeNull();
    expect(codexFactsFromClaims({ planType: "mystery" })).toMatchObject({ planId: "mystery", planName: null });
  });

  test("collect archives the plan claims without the token", async () => {
    const sessions = authFile("plan-telemetry", {
      tokens: { id_token: fakeIdToken({ chatgpt_plan_type: "plus" }), access_token: "secret-access" },
    });
    const polls = await codexAdapter.collect({
      fetchFn: fetch,
      env: { CODEX_SESSIONS_DIR: sessions, CODEX_APP_SERVER: "0" },
      now: NOW,
      log: () => {},
    });
    const claims = polls.find((p) => p.endpoint === "auth-claims");
    expect(claims?.json).toEqual({ planType: "plus", activeUntil: null });
    expect(claims?.body).not.toContain("secret-access");
    expect(codexAdapter.subscriptionFacts?.(polls, NOW)).toMatchObject({ planId: "plus" });
  });
});
