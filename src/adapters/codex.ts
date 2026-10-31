import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnAppServer } from "./codex-app-server";
import { mergeRateLimits, parseAppServerRateLimits, parseSessionRateLimits } from "./codex-limits";
import type { CodexRateLimitWindow, CodexRateLimits } from "./codex-limits";
import { NormalizeError } from "./types";
import type { Adapter, CollectContext, ProviderNote, RawPoll, UsagePoint } from "./types";
import type { SubscriptionFacts } from "../subscriptions";

export type { CodexRateLimitWindow, CodexRateLimits };

/**
 * OpenAI via Codex (ChatGPT subscription) — stability tier 3: local files, no API.
 * ChatGPT-plan usage has no API surface (the documented Admin API only covers platform-org
 * billing), but Codex writes per-turn usage into its session logs. Shape verified on
 * 2026-10-12 against live ~/.codex/sessions files:
 *
 * ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl — one JSON object per line with
 * top-level { timestamp: ISO, ordinal, type, payload }. Relevant entries:
 *   turn_context  payload.model ("gpt-6.1-sol"), payload.model_reasoning_effort ("low")
 *   token_usage_record
 *     payload: { session_id, turn_id, response_id,
 *       turn_token_usage: { input_tokens (INCLUDES cached), cached_input_tokens,
 *         cache_write_input_tokens, output_tokens (includes reasoning), total_tokens
 *         = input + output } }
 * Exactly one record per turn (verified: zero duplicates across all files); deduped anyway.
 *
 * Real quota telemetry, preferred source first:
 *   1. `codex app-server` JSON-RPC `account/rateLimits/read` (documented; no model turn).
 *   2. Session logs. `token_count` events (often wrapped in event_msg) carry
 *      payload.rate_limits: { primary, secondary } each with used_percent, window_minutes
 *      (300 = 5h, 10080 = weekly — classified by duration, not by slot), resets_at (unix
 *      seconds). Older builds send resets_in_seconds relative to the event timestamp.
 *      `codex exec` may write rate_limits: null; those lines are not snapshots.
 * The latest log snapshot wins. 5-hour window: same rolling block as
 * Claude — anchored at the first turn record after a ≥5h gap; the next turn at/after anchor+5h
 * opens a new block. Model attribution follows turn_context entries in file order (model can
 * change mid-thread via settings). Aggregate-only: no prompts, paths, or session ids leave
 * collect().
 */

const BLOCK_MS = 5 * 3_600_000;
/** Scan window: the 5h block plus daily history for the UI's 7-day per-model section. */
const SCAN_MS = 8 * 86_400_000;

export interface CodexBlockSummary {
  start: string;
  end: string;
  used: number;
  requests: number;
}

export interface CodexDailySummary {
  day: string;
  model: string;
  used: number;
  inTokens: number;
  outTokens: number;
  requests: number;
}

export interface CodexSummary {
  files: number;
  turns: number;
  duplicates: number;
  unparsableLines: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  /** Last few blocks, oldest first; the final one is the active block. */
  blocks: CodexBlockSummary[];
  daily: CodexDailySummary[];
  /** OpenAI's own rate-limit telemetry from the newest event_msg that carried it. */
  rateLimits: CodexRateLimits | null;
  /** Personal token budget for the 5h block (CODEX_SESSION_TOKENS), when configured. */
  sessionTokenLimit: number | null;
  /** Personal turn budget for the 5h block (CODEX_SESSION_TURNS), when configured. */
  sessionTurnLimit: number | null;
}

interface TurnRow {
  ts: number;
  model: string;
  used: number;
  inTokens: number;
  outTokens: number;
}export function sessionsDir(env: Record<string, string | undefined>): string {
  const custom = env.CODEX_SESSIONS_DIR;
  const dir = custom && custom.trim() !== "" ? custom : join(homedir(), ".codex", "sessions");
  return dir.replace(/^~/, homedir());
}

/**
 * Codex's account file, next to the sessions directory (`~/.codex/auth.json`). Deriving it from
 * `CODEX_SESSIONS_DIR` keeps tests and mock fixtures hermetic: point the fixtures at a temp dir
 * and no real account file is ever read.
 */
export function authJsonPath(env: Record<string, string | undefined>): string {
  const custom = env.CODEX_SESSIONS_DIR;
  const home =
    custom !== undefined && custom.trim() !== ""
      ? dirname(custom.trim().replace(/^~/, homedir()))
      : join(homedir(), ".codex");
  return join(home, "auth.json");
}

/** JWTs are base64url; a malformed token is not an error, just no claims. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (part === undefined) return null;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The plan lives in the id_token, under this namespaced claim. */
const CHATGPT_AUTH_CLAIM = "https://api.openai.com/auth";

/** What Codex's own login knows about the plan. Deliberately excludes the token and the email. */
export interface CodexAccountClaims {
  planType: string | null;
  /** Populated only when OpenAI states it; null in practice (verified 2026-10-22). */
  activeUntil: string | null;
}

/**
 * Read the plan type out of `auth.json` (`tokens.id_token`). The token is decoded here and
 * never leaves this function: only the two claim values are returned and archived.
 */
export function readCodexClaims(path: string): CodexAccountClaims | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { tokens?: { id_token?: unknown } };
    const idToken = raw.tokens?.id_token;
    if (typeof idToken !== "string" || idToken === "") return null;
    const payload = decodeJwtPayload(idToken);
    const claim = payload?.[CHATGPT_AUTH_CLAIM];
    if (claim === null || typeof claim !== "object" || Array.isArray(claim)) return null;
    const c = claim as Record<string, unknown>;
    const planType = typeof c.chatgpt_plan_type === "string" ? c.chatgpt_plan_type : null;
    const activeUntil = typeof c.chatgpt_subscription_active_until === "string" ? c.chatgpt_subscription_active_until : null;
    if (planType === null && activeUntil === null) return null;
    return { planType, activeUntil };
  } catch {
    return null;
  }
}

const CHATGPT_PLAN_LABELS: Readonly<Record<string, string>> = {
  plus: "ChatGPT Plus",
  pro: "ChatGPT Pro",
  team: "ChatGPT Team",
  business: "ChatGPT Business",
  enterprise: "ChatGPT Enterprise",
};

/**
 * Plan facts from Codex's own login claims. A ChatGPT account names its plan in the id token;
 * an API-key login carries no plan, which yields null rather than a guess.
 */
export function codexFactsFromClaims(json: unknown): SubscriptionFacts | null {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return null;
  const c = json as Record<string, unknown>;
  const planType = typeof c.planType === "string" ? c.planType.trim().toLowerCase() : null;
  if (planType === null || planType === "" || planType === "free") return null;
  return {
    provider: "codex",
    planId: planType,
    planName: CHATGPT_PLAN_LABELS[planType] ?? null,
    state: "active",
    period: null,
    renewsAt: null,
    seats: null,
    source: "codex-auth",
  };
}

function listSessionFiles(dir: string, now: number): string[] {
  const all = readdirSync(dir, { recursive: true })
    .filter((f): f is string => typeof f === "string" && f.endsWith(".jsonl"))
    .map((f) => join(dir, f));
  const cutoff = now - SCAN_MS;
  return all.filter((f) => {
    try {
      return statSync(f).mtimeMs >= cutoff;
    } catch {
      return false;
    }
  });
}

interface TurnRow {
  ts: number;
  model: string;
  used: number;
  inTokens: number;
  outTokens: number;
}

function collectTurns(
  files: string[],
  sinceMs: number,
): { turns: TurnRow[]; duplicates: number; unparsable: number; rateLimits: CodexRateLimits | null } {
  // Per file: walk entries in ordinal order; turn_context entries update the current model,
  // token_usage_record entries consume it, event_msg rate_limits snapshots update the quota.
  const turns: TurnRow[] = [];
  let duplicates = 0;
  let unparsable = 0;
  let rateLimits: CodexRateLimits | null = null;
  for (const file of files) {
    let currentModel = "unknown";
    const seen = new Set<string>();
    const parsed: Array<{ ts: number; ordinal: number; entry: Record<string, unknown> }> = [];
    for (const line of readFileSync(file, "utf-8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const ts = Date.parse(String(entry.timestamp ?? ""));
        const ordinal = Number(entry.ordinal ?? 0);
        if (Number.isFinite(ts) && ts >= sinceMs) parsed.push({ ts, ordinal, entry });
      } catch {
        unparsable += 1;
      }
    }
    parsed.sort((a, b) => a.ordinal - b.ordinal);
    for (const { ts, entry } of parsed) {
      const type = entry.type;
      const payload = entry.payload;
      if ((type === "event_msg" || type === "token_count") && payload !== null && typeof payload === "object") {
        const body = payload as Record<string, unknown>;
        // event_msg wraps a token_count; a bare token_count carries rate_limits on the payload.
        if (type === "event_msg" && body.type !== undefined && body.type !== "token_count" && body.rate_limits === undefined) {
          continue;
        }
        const rl = body.rate_limits;
        // codex exec writes rate_limits: null. That is not a snapshot.
        if (rl !== null && typeof rl === "object") {
          const parsedRl = parseSessionRateLimits(rl as Record<string, unknown>, ts);
          if (parsedRl !== null && (rateLimits === null || ts > Date.parse(rateLimits.observedAt))) {
            rateLimits = parsedRl;
          }
        }
        continue;
      }
      if (type === "turn_context" && payload !== null && typeof payload === "object") {
        const p = payload as Record<string, unknown>;
        if (typeof p.model === "string" && p.model !== "") currentModel = p.model;
        continue;
      }
      if (type !== "token_usage_record" || payload === null || typeof payload !== "object") continue;
      const p = payload as Record<string, unknown>;
      const usage = p.turn_token_usage;
      if (usage === null || typeof usage !== "object") continue;
      const u = usage as Record<string, unknown>;

      const sessionId = typeof p.session_id === "string" ? p.session_id : "";
      const turnId = typeof p.turn_id === "string" ? p.turn_id : "";
      const responseId = typeof p.response_id === "string" ? p.response_id : "";
      const key = `${sessionId}/${turnId}/${responseId}`;
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      seen.add(key);

      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      const input = n(u.input_tokens);
      const output = n(u.output_tokens);
      // total_tokens is Codex's own sum (input incl. cached + output); fall back if absent.
      const total = n(u.total_tokens) || input + output;
      turns.push({ ts, model: currentModel, used: total, inTokens: input, outTokens: output });
    }
  }
  turns.sort((a, b) => a.ts - b.ts);
  return { turns, duplicates, unparsable, rateLimits };
}

/** 5h block semantics: a turn at/after the anchor+5h opens a new block anchored there. */
function foldBlocks(turns: TurnRow[]): CodexBlockSummary[] {
  const blocks: CodexBlockSummary[] = [];
  for (const t of turns) {
    const current = blocks.at(-1);
    if (current === undefined || t.ts >= Date.parse(current.start) + BLOCK_MS) {
      blocks.push({
        start: new Date(t.ts).toISOString(),
        end: new Date(t.ts + BLOCK_MS).toISOString(),
        used: t.used,
        requests: 1,
      });
    } else {
      current.used += t.used;
      current.requests += 1;
    }
  }
  return blocks;
}

function summarize(
  files: string[],
  turns: TurnRow[],
  duplicates: number,
  unparsable: number,
  sessionTokenLimit: number | null,
  sessionTurnLimit: number | null,
  rateLimits: CodexRateLimits | null,
): CodexSummary {
  const daily = new Map<string, CodexDailySummary>();
  for (const t of turns) {
    const day = new Date(t.ts).toISOString().slice(0, 10);
    const key = `${day}|${t.model}`;
    const row = daily.get(key) ?? { day, model: t.model, used: 0, inTokens: 0, outTokens: 0, requests: 0 };
    row.used += t.used;
    row.inTokens += t.inTokens;
    row.outTokens += t.outTokens;
    row.requests += 1;
    daily.set(key, row);
  }
  const first = turns[0];
  const last = turns.at(-1);
  return {
    files: files.length,
    turns: turns.length,
    duplicates,
    unparsableLines: unparsable,
    firstTimestamp: first ? new Date(first.ts).toISOString() : null,
    lastTimestamp: last ? new Date(last.ts).toISOString() : null,
    blocks: foldBlocks(turns).slice(-3),
    daily: [...daily.values()].sort((a, b) => (a.day === b.day ? (a.model < b.model ? -1 : 1) : a.day < b.day ? 1 : -1)),
    rateLimits,
    sessionTokenLimit,
    sessionTurnLimit,
  };
}

export const codexAdapter: Adapter = {
  id: "codex",
  stabilityTier: 3,
  isolate: true,
  pollEveryMs: 5 * 60_000,

  isConfigured(env) {
    try {
      return existsSync(sessionsDir(env));
    } catch {
      return false;
    }
  },
  missingCredentials(env) {
    return this.isConfigured(env) ? [] : ["~/.codex/sessions (run Codex once, or set CODEX_SESSIONS_DIR)"];
  },

  notes: [
    {
      title: "OpenAI via Codex — local transcripts, no API",
      text: "ChatGPT-plan usage has no API (the Admin API only covers platform-org billing). This card parses the per-turn usage records Codex writes under ~/.codex/sessions, so nothing is sent anywhere and no key is needed.",
    },
    {
      title: "5-hour and weekly windows",
      text: "Live percentages and reset times come from `codex app-server` (account/rateLimits/read — no model turn). If that command is unavailable, the card falls back to rate_limits snapshots Codex writes into session logs. Windows are identified by length (300 minutes = 5h, 10080 = weekly), not by primary/secondary slot. Set CODEX_APP_SERVER=0 to skip the live read.",
    },
    {
      title: "Scope & counting",
      text: "Only sessions run on this machine are visible. Totals use Codex's own per-turn total (input including cached + output; reasoning tokens are part of output). Model attribution follows the session's turn_context entries; effort level lives in your Codex config, not the records.",
    },
    {
      title: "Which plan — for the Subscriptions page",
      text: "Codex's login file (~/.codex/auth.json) names the ChatGPT plan in its id token (chatgpt_plan_type), so the Subscriptions page reports Plus or Pro from the provider instead of guessing. The price and the charge date are still yours to enter: OpenAI states no billing date locally. Only the plan value is read — the token never leaves the adapter.",
    },
    {
      title: "How much is left? Calibrate the budgets",
      text: "OpenAI doesn't publish ChatGPT-plan limits, so 'left' is a personal calibration: run /status inside Codex (the authoritative view), note its % against the tokens/turns here, and set CODEX_SESSION_TOKENS / CODEX_SESSION_TURNS in .env to your effective full-window budgets. Budgets are per model + effort — recalibrate when either changes.",
    },
  ] satisfies ProviderNote[],

  async collect(ctx: CollectContext): Promise<RawPoll[]> {
    const dir = sessionsDir(ctx.env);
    const now = ctx.now.getTime();
    const since = now - SCAN_MS;

    let files: string[] = [];
    if (existsSync(dir)) files = listSessionFiles(dir, now);
    const { turns, duplicates, unparsable, rateLimits: logLimits } = collectTurns(files, since);
    const app = await readAppServer(ctx);
    const rateLimits = mergeRateLimits(logLimits, app.limits);
    const tokens = Number(ctx.env.CODEX_SESSION_TOKENS ?? "");
    const tLimit = Number.isFinite(tokens) && tokens > 0 ? tokens : null;
    const turnsEnv = Number(ctx.env.CODEX_SESSION_TURNS ?? "");
    const turnLimit = Number.isFinite(turnsEnv) && turnsEnv > 0 ? turnsEnv : null;
    const summary = summarize(files, turns, duplicates, unparsable, tLimit, turnLimit, rateLimits);
    const body = JSON.stringify(summary);
    const polls: RawPoll[] = [
      {
        endpoint: "sessions-jsonl",
        url: `file://${dir}`,
        status: 200,
        body,
        json: summary,
        headers: {},
      },
    ];
    if (app.poll) polls.push(app.poll);
    const claimsPath = authJsonPath(ctx.env);
    const claims = readCodexClaims(claimsPath);
    if (claims !== null) {
      polls.push({
        endpoint: "auth-claims",
        url: `file://${claimsPath}`,
        status: 200,
        body: JSON.stringify(claims),
        json: claims,
        headers: {},
      });
    }
    return polls;
  },

  normalize(polls, capturedAt) {
    const poll = polls.find((p) => p.endpoint === "sessions-jsonl" && p.status === 200);
    if (poll === undefined) throw new NormalizeError("codex: no sessions-jsonl poll");
    const s = poll.json as CodexSummary | null;
    if (s === null || !Array.isArray(s.daily) || !Array.isArray(s.blocks)) {
      throw new NormalizeError("codex: unexpected summary shape");
    }

    const points: UsagePoint[] = [];
    // OpenAI's own rate-limit telemetry is authoritative when present: real percent-used,
    // real reset times (these also feed the dashboard's next-reset banner).
    // Roll-forward: telemetry only arrives with requests, so a resets_at in the past means
    // the window rolled with no usage recorded in it — the new window is 0% used, and its
    // next reset isn't knowable until the next request.
    const rl = s.rateLimits;
    const windowPoint = (label: string, kind: "five_hour" | "weekly", w: CodexRateLimitWindow) => {
      const rolled = w.resetsAt !== null && Date.parse(w.resetsAt) <= Date.parse(capturedAt);
      const used = rolled ? 0 : w.usedPercent;
      points.push(blankPoint(capturedAt, label, "quota", "percent", {
        used,
        limit: 100,
        remaining: rolled ? 100 : Math.max(0, 100 - w.usedPercent),
        reset_at: rolled ? null : w.resetsAt,
        window_end: rolled ? null : w.resetsAt,
        quota_window: kind,
        source: w.source,
        stale: rolled,
        used_percent: used,
      }));
    };
    if (rl?.byWindow.five_hour) windowPoint("codex-5h-percent", "five_hour", rl.byWindow.five_hour);
    if (rl?.byWindow.weekly) windowPoint("codex-weekly-percent", "weekly", rl.byWindow.weekly);
    const active = s.blocks.at(-1);
    if (active !== undefined) {
      points.push(blankPoint(capturedAt, "codex-5h", "usage", "tokens", {
        used: active.used,
        limit: s.sessionTokenLimit,
        remaining: s.sessionTokenLimit !== null ? Math.max(0, s.sessionTokenLimit - active.used) : null,
        window_start: active.start,
        window_end: active.end,
        reset_at: active.end,
        requests: active.requests,
      }));
      if (s.sessionTurnLimit !== null && s.sessionTurnLimit > 0) {
        points.push(blankPoint(capturedAt, "codex-5h-turns", "quota", "requests", {
          used: active.requests,
          limit: s.sessionTurnLimit,
          remaining: Math.max(0, s.sessionTurnLimit - active.requests),
          window_start: active.start,
          window_end: active.end,
          reset_at: active.end,
        }));
      }
    }
    for (const d of s.daily) {
      points.push(blankPoint(capturedAt, "model-daily", "usage", "tokens", {
        model: d.model,
        day: d.day,
        used: d.used,
        tokens_in: d.inTokens,
        tokens_out: d.outTokens,
        requests: d.requests,
      }));
    }
    if (points.length === 0) {
      throw new NormalizeError("codex: no turn usage found in ~/.codex/sessions (last 8 days)");
    }
    return points;
  },

  subscriptionFacts(polls) {
    const poll = polls.find((p) => p.endpoint === "auth-claims" && p.status === 200);
    return poll === undefined ? null : codexFactsFromClaims(poll.json);
  },
};

/**
 * Live read via `codex app-server`. A missing binary is a quiet fallback to session logs.
 * Protocol and shape failures are archived (optional) so a drift is visible without
 * failing the transcript poll.
 */
async function readAppServer(ctx: CollectContext): Promise<{ poll: RawPoll | null; limits: CodexRateLimits | null }> {
  if (ctx.env.CODEX_APP_SERVER === "0") return { poll: null, limits: null };
  const fixture = ctx.env.CODEX_APP_SERVER_FIXTURE?.trim();
  if (fixture) {
    try {
      const body = readFileSync(fixture, "utf8");
      const json = JSON.parse(body) as unknown;
      const limits = parseAppServerRateLimits(json, ctx.now.toISOString());
      return {
        poll: {
          endpoint: "app-server",
          url: `file://${fixture}`,
          status: limits ? 200 : 422,
          body,
          json,
          headers: {},
          optional: true,
        },
        limits,
      };
    } catch (err) {
      const message = (err as Error).message;
      return {
        poll: {
          endpoint: "app-server",
          url: `file://${fixture}`,
          status: 0,
          body: message,
          json: { error: message },
          headers: {},
          optional: true,
        },
        limits: null,
      };
    }
  }

  const bin = ctx.env.CODEX_BIN?.trim() || "codex";
  const result = await spawnAppServer(bin, ["app-server"], 12_000);
  if (!result.ok) {
    if (result.missing) {
      ctx.log("codex: app-server binary unavailable; using session logs");
      return { poll: null, limits: null };
    }
    ctx.log(`codex: app-server failed (${result.error}); using session logs`);
    return {
      poll: {
        endpoint: "app-server",
        url: "codex app-server",
        status: 0,
        body: result.raw || result.error,
        json: { error: result.error },
        headers: {},
        optional: true,
      },
      limits: null,
    };
  }
  const limits = parseAppServerRateLimits(result.result, ctx.now.toISOString());
  return {
    poll: {
      endpoint: "app-server",
      url: "codex app-server",
      status: limits ? 200 : 422,
      body: result.raw || JSON.stringify(result.result),
      json: result.result,
      headers: {},
      optional: true,
    },
    limits,
  };
}

function blankPoint(
  capturedAt: string,
  label: string,
  kind: UsagePoint["kind"],
  unit: UsagePoint["unit"],
  fields: Partial<UsagePoint>,
): UsagePoint {
  return {
    provider: "codex",
    kind,
    label,
    model: null,
    used: null,
    limit: null,
    remaining: null,
    unit,
    window_start: null,
    window_end: null,
    reset_at: null,
    day: null,
    requests: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    captured_at: capturedAt,
    ...fields,
  };
}
