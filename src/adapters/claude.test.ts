import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeAdapter, oauthStatusHint, parseOAuthUsage, readOAuthCredentials, type ClaudeSummary } from "./claude";
import type { CollectContext, RawPoll } from "./types";

// Timestamps are pinned around a fixed "now" so the 8-day scan window is deterministic.
const NOW = new Date("2026-10-06T20:00:00.000Z");

const root = mkdtempSync(join(tmpdir(), "modelizer-claude-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function fixtureDir(name: string): string {
  const dir = join(root, name, "-Users-x-demo");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// CLAUDE_OAUTH_TOKEN:"" disables keychain reads → tests stay hermetic.
function ctx(dir: string): CollectContext {
  return {
    fetchFn: fetch,
    env: { CLAUDE_PROJECTS_DIR: dir, CLAUDE_OAUTH_TOKEN: "" },
    now: NOW,
    log: () => {},
  };
}

interface Turn {
  ts: string;
  model?: string;
  input?: number;
  cacheWrite?: number;
  cacheRead?: number;
  output?: number;
  msgId: string;
  requestId?: string;
  sidechain?: boolean;
}

// Shape verified against a real ~/.claude/projects session file (2026-10-06).
function turn(t: Turn): string {
  return JSON.stringify({
    parentUuid: "p",
    isSidechain: t.sidechain ?? false,
    message: {
      model: t.model ?? "claude-opus-5-5",
      id: t.msgId,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "…" }],
      usage: {
        input_tokens: t.input ?? 0,
        cache_creation_input_tokens: t.cacheWrite ?? 0,
        cache_read_input_tokens: t.cacheRead ?? 0,
        output_tokens: t.output ?? 0,
      },
    },
    requestId: t.requestId ?? `req-${t.msgId}`,
    timestamp: t.ts,
    type: "assistant",
    uuid: `uuid-${t.msgId}`,
  });
}

function writeSession(dir: string, file: string, lines: string[]): string {
  const path = join(dir, file);
  // Interleave non-assistant and junk lines like real transcripts contain.
  writeFileSync(path, [`{"type":"user","message":{"content":"…"}}`, "not json", ...lines].join("\n"));
  return path;
}

function userPrompt(ts: string): string {
  return JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content: "…" } });
}

describe("claude adapter (T3 local transcripts)", () => {
  test("collect+normalize: blocks, daily split, sidechain counted, junk skipped", async () => {
    const dir = fixtureDir("main");
    writeSession(dir, "s1.jsonl", [
      // Block 1: anchored 10:00, two turns (11:00 is within 5h of 10:00).
      turn({ ts: "2026-10-06T10:00:00.000Z", msgId: "a", input: 100, output: 50 }),
      turn({ ts: "2026-10-06T11:00:00.000Z", msgId: "b", cacheRead: 1000, output: 200 }),
      // 16:00 is ≥5h after 10:00 → new block, which becomes the active one.
      turn({ ts: "2026-10-06T16:00:00.000Z", msgId: "c", input: 30, output: 70 }),
      // Sub-agent turn in the active block still burns tokens.
      turn({ ts: "2026-10-06T17:00:00.000Z", msgId: "d", input: 10, output: 20, sidechain: true }),
      // A second model, straddling the UTC day boundary.
      turn({ ts: "2026-10-05T23:30:00.000Z", msgId: "e", model: "claude-haiku-4-5", input: 1, output: 2 }),
      turn({ ts: "2026-10-06T00:30:00.000Z", msgId: "f", model: "claude-haiku-4-5", input: 3, output: 4 }),
    ]);

    const polls = await claudeAdapter.collect(ctx(join(root, "main")));
    expect(polls).toHaveLength(1);
    const poll = polls.at(0);
    if (poll === undefined) throw new Error("no poll returned");
    expect(poll.endpoint).toBe("projects-jsonl");
    expect(poll.status).toBe(200);

    const s = poll.json as ClaudeSummary;
    expect(s.files).toBe(1);
    expect(s.entries).toBe(6);
    // Sorted by time, the day-boundary turns anchor their own block:
    // 10-05T23:30–10-06T04:30 (haiku), 10:00–15:00, and the active 16:00–21:00.
    expect(s.blocks).toHaveLength(3);
    expect(s.blocks.at(0)).toEqual({ start: "2026-10-05T23:30:00.000Z", end: "2026-10-06T04:30:00.000Z", used: 10, requests: 2 });
    expect(s.blocks.at(1)).toEqual({ start: "2026-10-06T10:00:00.000Z", end: "2026-10-06T15:00:00.000Z", used: 1350, requests: 2 });

    const points = claudeAdapter.normalize(polls, "2026-10-06T20:00:01.000Z");
    const five = points.find((p) => p.label === "claude-5h");
    expect(five).toMatchObject({
      kind: "usage",
      unit: "tokens",
      used: 130, // 100 + 30 from the active block
      window_start: "2026-10-06T16:00:00.000Z",
      window_end: "2026-10-06T21:00:00.000Z",
      reset_at: "2026-10-06T21:00:00.000Z",
      requests: 2,
    });

    const daily = points.filter((p) => p.label === "model-daily");
    expect(daily).toHaveLength(3);
    const opus = daily.find((p) => p.model === "claude-opus-5-5");
    expect(opus).toMatchObject({ day: "2026-10-06", used: 1480, tokens_in: 1140, tokens_out: 340, requests: 4 });
    const haiku5 = daily.find((p) => p.day === "2026-10-05");
    expect(haiku5).toMatchObject({ model: "claude-haiku-4-5", used: 3, requests: 1 });
    const haiku6 = daily.find((p) => p.day === "2026-10-06");
    expect(haiku6).toMatchObject({ model: "claude-haiku-4-5", used: 7, requests: 1 });
    // No turns budget configured → no estimate point.
    expect(points.find((p) => p.label === "claude-5h-turns")).toBeUndefined();
  });

  test("CLAUDE_SESSION_TURNS adds a used-vs-budget point with remaining", async () => {
    const dir = fixtureDir("turns");
    writeSession(dir, "s.jsonl", [
      turn({ ts: "2026-10-06T18:00:00.000Z", msgId: "t1", input: 5, output: 5 }),
      turn({ ts: "2026-10-06T19:00:00.000Z", msgId: "t2", input: 5, output: 5 }),
    ]);
    const polls = await claudeAdapter.collect({
      fetchFn: fetch,
      env: { CLAUDE_PROJECTS_DIR: dir, CLAUDE_SESSION_TURNS: "10", CLAUDE_OAUTH_TOKEN: "" },
      now: NOW,
      log: () => {},
    });
    const points = claudeAdapter.normalize(polls, "2026-10-06T20:00:01.000Z");
    expect(points.find((p) => p.label === "claude-5h-turns")).toMatchObject({
      kind: "quota",
      unit: "requests",
      used: 2,
      limit: 10,
      remaining: 8,
      reset_at: "2026-10-06T23:00:00.000Z",
    });
  });

  test("blocks anchor at the opening prompt, not the first response", async () => {
    const dir = fixtureDir("anchor");
    writeSession(dir, "s.jsonl", [
      userPrompt("2026-10-06T09:55:00.000Z"),
      turn({ ts: "2026-10-06T10:00:00.000Z", msgId: "p1", input: 1, output: 1 }),
      // 6h later: a new block, again opened by a prompt 2 minutes before the response.
      userPrompt("2026-10-06T15:58:00.000Z"),
      turn({ ts: "2026-10-06T16:00:00.000Z", msgId: "p2", input: 1, output: 1 }),
    ]);
    const polls = await claudeAdapter.collect(ctx(join(root, "anchor")));
    const s = polls.at(0)?.json as ClaudeSummary | undefined;
    expect(s?.blocks).toHaveLength(2);
    expect(s?.blocks.at(0)).toMatchObject({ start: "2026-10-06T09:55:00.000Z", end: "2026-10-06T14:55:00.000Z" });
    // The second prompt (15:58) sits ≥5h after the first anchor (09:55) → it anchors block 2.
    expect(s?.blocks.at(1)).toMatchObject({ start: "2026-10-06T15:58:00.000Z", end: "2026-10-06T20:58:00.000Z" });
  });

  test("CLAUDE_SESSION_TOKENS fills limit/remaining on the token point", async () => {
    const dir = fixtureDir("toklimit");
    writeSession(dir, "s.jsonl", [
      turn({ ts: "2026-10-06T18:00:00.000Z", msgId: "k1", input: 300, output: 200 }),
    ]);
    const polls = await claudeAdapter.collect({
      fetchFn: fetch,
      env: { CLAUDE_PROJECTS_DIR: dir, CLAUDE_SESSION_TOKENS: "10000", CLAUDE_OAUTH_TOKEN: "" },
      now: NOW,
      log: () => {},
    });
    const points = claudeAdapter.normalize(polls, "2026-10-06T20:00:01.000Z");
    expect(points.find((p) => p.label === "claude-5h")).toMatchObject({
      used: 500,
      limit: 10000,
      remaining: 9500,
    });
  });

  test("duplicate turns (resumed sessions) are counted once", async () => {
    const dir = fixtureDir("dup");
    writeSession(dir, "s1.jsonl", [
      turn({ ts: "2026-10-06T12:00:00.000Z", msgId: "x", input: 10, output: 5, requestId: "req-1" }),
      turn({ ts: "2026-10-06T12:00:05.000Z", msgId: "x", input: 10, output: 5, requestId: "req-1" }),
      turn({ ts: "2026-10-06T12:30:00.000Z", msgId: "y", input: 1, output: 1, requestId: "req-1" }),
    ]);
    const polls = await claudeAdapter.collect(ctx(join(root, "dup")));
    const s = polls.at(0)?.json as ClaudeSummary | undefined;
    expect(s?.duplicates).toBe(1);
    expect(s?.entries).toBe(2);
    expect(s?.blocks.at(0)?.used).toBe(17);
  });

  test("files untouched for 8+ days are skipped entirely", async () => {
    const dir = fixtureDir("stale");
    const f = writeSession(dir, "old.jsonl", [turn({ ts: "2026-09-01T10:00:00.000Z", msgId: "old", input: 5 })]);
    utimesSync(f, new Date("2026-09-01"), new Date("2026-09-01"));
    const polls = await claudeAdapter.collect(ctx(join(root, "stale")));
    const s = polls.at(0)?.json as ClaudeSummary | undefined;
    expect(s?.files).toBe(0);
    expect(s?.entries).toBe(0);
    expect(() => claudeAdapter.normalize(polls, "2026-10-06T20:00:01.000Z")).toThrow(/no assistant usage/);
  });

  test("isConfigured / missingCredentials follow the directory", () => {
    expect(claudeAdapter.isConfigured({ CLAUDE_PROJECTS_DIR: join(root, "main") })).toBe(true);
    expect(claudeAdapter.missingCredentials({ CLAUDE_PROJECTS_DIR: join(root, "main") })).toEqual([]);
    const missing = { CLAUDE_PROJECTS_DIR: join(root, "nope") };
    expect(claudeAdapter.isConfigured(missing)).toBe(false);
    expect(claudeAdapter.missingCredentials(missing)[0]).toContain("~/.claude/projects");
  });

  test("normalize: missing or malformed poll is loud", () => {
    expect(() => claudeAdapter.normalize([], "at")).toThrow(/no projects-jsonl poll/);
    const broken: RawPoll = { endpoint: "projects-jsonl", url: "file://x", status: 200, body: "{}", json: null, headers: {} };
    expect(() => claudeAdapter.normalize([broken], "at")).toThrow(/unexpected summary shape/);
  });
});

describe("claude OAuth usage (live quota, tier 2)", () => {
  const USAGE_BODY = {
    five_hour: { utilization: 62.5, resets_at: "2026-10-06T23:00:00.000Z" },
    seven_day: null,
    limits: [
      { kind: "session", percent: 10, resets_at: "bogus" }, // flat bucket wins
      { kind: "weekly_all", percent: 31, resets_at: "2026-10-12T00:00:00.000Z" },
      { kind: "weekly_scoped", percent: 0, resets_at: null, scope: { model: { display_name: "Opus" } } },
      { kind: "session", percent: 0, resets_at: null }, // placeholder — skipped
    ],
  };

  function ctxWithFetch(dir: string, stub: (url: string, init?: RequestInit) => Promise<Response>): CollectContext {
    return {
      fetchFn: ((url: string | URL | Request, init?: RequestInit) =>
        stub(String(url), init)) as unknown as typeof fetch,
      env: { CLAUDE_PROJECTS_DIR: dir, CLAUDE_OAUTH_TOKEN: "test-token" },
      now: NOW,
      log: () => {},
    };
  }

  test("fresh token → usage poll merged as real percent points", async () => {
    const dir = fixtureDir("oauth");
    writeSession(dir, "s.jsonl", [turn({ ts: "2026-10-06T18:00:00.000Z", msgId: "o1", input: 10, output: 5 })]);
    let sawHeaders: Headers | undefined;
    const polls = await claudeAdapter.collect(
      ctxWithFetch(dir, async (_url: string, init?: RequestInit) => {
        sawHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify(USAGE_BODY), { status: 200 });
      }),
    );
    expect(polls.map((p) => p.endpoint).sort()).toEqual(["oauth-usage", "projects-jsonl"]);
    expect(sawHeaders?.get("anthropic-beta")).toBe("oauth-2025-04-20");
    expect(sawHeaders?.get("authorization")).toBe("Bearer test-token");

    const points = claudeAdapter.normalize(polls, "2026-10-06T20:00:01.000Z");
    expect(points.find((p) => p.label === "claude-5h-percent")).toMatchObject({
      kind: "quota",
      unit: "percent",
      used: 62.5,
      limit: 100,
      remaining: 37.5,
      reset_at: "2026-10-06T23:00:00.000Z",
    });
    expect(points.find((p) => p.label === "claude-weekly-percent")).toMatchObject({
      used: 31,
      remaining: 69,
      reset_at: "2026-10-12T00:00:00.000Z",
    });
    // transcript estimate still present alongside the real numbers
    expect(points.find((p) => p.label === "claude-5h")).toBeDefined();
  });

  test("401 → optional failure, estimates remain, no crash", async () => {
    const dir = fixtureDir("oauth401");
    writeSession(dir, "s.jsonl", [turn({ ts: "2026-10-06T18:00:00.000Z", msgId: "z1", input: 10, output: 5 })]);
    const polls = await claudeAdapter.collect(
      ctxWithFetch(dir, async () => new Response('{"error":{"type":"authentication_error"}}', { status: 401 })),
    );
    expect(polls.some((p) => p.endpoint === "oauth-usage" && p.status === 401)).toBe(true);
    const points = claudeAdapter.normalize(polls, "2026-10-06T20:00:01.000Z");
    expect(points.find((p) => p.label === "claude-5h-percent")).toBeUndefined();
    expect(points.find((p) => p.label === "claude-5h")).toBeDefined();
  });

  test("no token (empty env override) → no usage poll attempted", async () => {
    const dir = fixtureDir("oauthexp");
    writeSession(dir, "s.jsonl", [turn({ ts: "2026-10-06T18:00:00.000Z", msgId: "e1", input: 1, output: 1 })]);
    const polls = await claudeAdapter.collect({
      fetchFn: fetch,
      env: { CLAUDE_PROJECTS_DIR: dir, CLAUDE_OAUTH_TOKEN: "" },
      now: NOW,
      log: () => {},
    });
    expect(polls.map((p) => p.endpoint)).toEqual(["projects-jsonl"]);
  });

  test("elapsed transcript window rolls forward to a fresh 0", async () => {
    const dir = fixtureDir("rolled");
    // Block anchored 10:00 → ends 15:00Z, capture is 20:00Z → window elapsed (e.g. user reset).
    writeSession(dir, "s.jsonl", [turn({ ts: "2026-10-06T10:00:00.000Z", msgId: "r1", input: 500, output: 100 })]);
    const polls = await claudeAdapter.collect(ctx(join(root, "rolled")));
    const points = claudeAdapter.normalize(polls, "2026-10-06T20:00:01.000Z");
    const five = points.find((p) => p.label === "claude-5h");
    expect(five).toMatchObject({ used: 0, requests: 0, window_start: null, window_end: null, reset_at: null });
  });
});

describe("claude oauth helpers", () => {
  test("readOAuthCredentials: env token, keychain blob, expiry", () => {
    expect(readOAuthCredentials({ CLAUDE_OAUTH_TOKEN: " t " })).toEqual({
      token: "t",
      expiresAt: null,
      source: "env",
    });
    expect(readOAuthCredentials({ CLAUDE_OAUTH_TOKEN: "" })).toEqual({
      token: null,
      expiresAt: null,
      source: "none",
    });
    const run = () => ({
      status: 0,
      stdout: JSON.stringify({ claudeAiOauth: { accessToken: "abc", expiresAt: 123 } }),
    });
    expect(readOAuthCredentials({}, { platform: "darwin", run })).toEqual({
      token: "abc",
      expiresAt: 123,
      source: "keychain",
    });
    const fail = () => ({ status: 44, stdout: "" });
    expect(readOAuthCredentials({}, { platform: "darwin", run: fail })).toEqual({
      token: null,
      expiresAt: null,
      source: "none",
    });
    expect(readOAuthCredentials({}, { platform: "linux", run })).toEqual({
      token: null,
      expiresAt: null,
      source: "none",
    });
  });

  test("oauthStatusHint: missing → muted, expired → warn+action, fresh → none", () => {
    expect(oauthStatusHint({ token: null, expiresAt: null, source: "none" }, 1000)).toHaveLength(1);
    const expired = oauthStatusHint({ token: "t", expiresAt: 500, source: "keychain" }, 1000);
    expect(expired[0]?.tone).toBe("warn");
    expect(expired[0]?.state).toContain("claude /login");
    expect(oauthStatusHint({ token: "t", expiresAt: 5000, source: "keychain" }, 1000)).toEqual([]);
    expect(oauthStatusHint({ token: "t", expiresAt: null, source: "env" }, 1000)).toEqual([]);
  });

  test("parseOAuthUsage: flat buckets win, limits fill gaps, placeholders skipped", () => {
    const parsed = parseOAuthUsage({
      five_hour: { utilization: 40, resets_at: "r5" },
      limits: [
        { kind: "session", percent: 99, resets_at: "nope" },
        { kind: "weekly_all", percent: 12, resets_at: "rw" },
      ],
    });
    expect(parsed?.fiveHour).toEqual({ percent: 40, resetsAt: "r5" });
    expect(parsed?.weekly).toEqual({ percent: 12, resetsAt: "rw" });

    const limitsOnly = parseOAuthUsage({
      five_hour: null,
      limits: [{ kind: "session", percent: 22, resets_at: "rs" }],
    });
    expect(limitsOnly?.fiveHour).toEqual({ percent: 22, resetsAt: "rs" });

    expect(parseOAuthUsage({ limits: [{ kind: "session", percent: 0, resets_at: null }] })).toBeNull();
    expect(parseOAuthUsage(null)).toBeNull();
    expect(parseOAuthUsage({})).toBeNull();
  });
});
