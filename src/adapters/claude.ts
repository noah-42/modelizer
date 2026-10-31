import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { bundledPricing, estimateCost, type PricingTable } from "../pricing";
import { runCommand } from "../proc";
import { parseUsageText, usageUnsupportedReason, windowsFromRateLimits, type HookRecord, type ParsedUsageWindow } from "../usage-text";
import { fetchPoll, NormalizeError } from "./types";
import type { Adapter, CollectContext, ProviderNote, RawPoll, StatusNote, UsagePoint } from "./types";
import type { SubscriptionFacts, SubscriptionState } from "../subscriptions";

/**
 * Claude Pro/Max subscription (Claude Code) — stability tier 3: local files, no API.
 * Anthropic exposes no usage API for personal plans; the only machine-readable record is the
 * JSONL transcript Claude Code writes per session. Verified shape on 2026-10-06 (ccusage's
 * data source; the original verification matrix lived in the private planning notes):
 *
 * ~/.claude/projects/<project>/<session>.jsonl — one JSON object per line. Assistant turns:
 *   { type: "assistant", timestamp: ISO, requestId, uuid, isSidechain,
 *     message: { id: "msg_…", model: "claude-opus-5-5",
 *       usage: { input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
 *                output_tokens } } }
 *
 * Semantics (mirroring ccusage): a token total counts input + output + cache reads + cache
 * writes, sub-agent turns (isSidechain) included; the 5-hour session window is a *block*
 * anchored at the first PROMPT after a ≥5h gap — usage at or after anchor+5h opens a new
 * block. Verified 2026-10-06 against Claude Code's /usage: the block anchored at 21:52 (first
 * response) while Anthropic's window reset matched 21:40 (the prompt) — so blocks snap to the
 * latest user-entry timestamp preceding their first assistant turn.
 * Weekly limits and real reset times are not in the transcripts. Preferred source is the
 * account-wide OAuth usage endpoint (`CLAUDE_OAUTH_USAGE=1`, read-only — see below), then the
 * optional statusLine script (scripts/claude-statusline.ts), which records `rate_limits` when
 * Claude Code sends them (v2.1.80+). `claude -p /usage` is tried after those with stdin closed
 * and a short timeout; it is a dead end on Claude Code 2.1.307+, which answers with a
 * `local_command` result ("Usage: 0 input, 0 output") instead of window percentages, so the
 * failure is cached and not retried for several hours. A StopFailure hook can still override
 * the reset time of one window.
 *
 * OAuth usage (opt-in, `CLAUDE_OAUTH_USAGE=1`): GET https://api.anthropic.com/api/oauth/usage
 * with the Claude Code login token from the macOS keychain. Read-only: the token is never
 * refreshed or written back, because two refreshers (modelizer and CodexBar, or Claude Code
 * itself) would race and log the CLI out. 401/403/429 and unexpected shapes back off for an
 * hour instead of hammering the endpoint. Without the flag, nothing leaves the machine.
 *
 * Cost is API-equivalent: local tokens priced at list rates from src/pricing/anthropic.json,
 * emitted as `model-spend` points. A subscription has no per-token bill, so this is a burn
 * metric, not an invoice.
 * Everything is aggregate-only: no message text, session ids, or project paths leave collect().
 */

const BLOCK_MS = 5 * 3_600_000;
/** Scan window: the 5h block plus daily history for the UI's 7-day per-model section. */
const SCAN_MS = 8 * 86_400_000;

/**
 * OAuth usage is opt-in (`CLAUDE_OAUTH_USAGE=1`): it needs the Claude Code login token and
 * talks to Anthropic's undocumented usage endpoint. Read-only by design — refreshing here
 * would race Claude Code and CodexBar and log one of them out.
 */
export const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const OAUTH_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
export const OAUTH_USAGE_ENDPOINT = "oauth-usage";
export const OAUTH_PROFILE_ENDPOINT = "oauth-profile";
/** 401/403/429 or an unparsable body: stop calling for an hour instead of every tick. */
export const OAUTH_BACKOFF_MS = 3_600_000;
const OAUTH_HEADERS = { "anthropic-version": "2023-06-01", accept: "application/json" } as const;

export interface OAuthCredentials {
  token: string | null;
  expiresAt: number | null;
  source: "env" | "keychain" | "file" | "none";
}

type SecurityRunner = (args: string[]) => { status: number | null; stdout: string };

export function readOAuthCredentials(
  env: Record<string, string | undefined>,
  opts: { platform?: NodeJS.Platform; run?: SecurityRunner; nowMs?: number } = {},
): OAuthCredentials {
  // Explicit env token wins; CLAUDE_OAUTH_TOKEN="" disables keychain/file reads entirely
  // (used by tests to stay hermetic).
  const envToken = env.CLAUDE_OAUTH_TOKEN;
  if (envToken !== undefined) {
    const trimmed = envToken.trim();
    return trimmed !== "" ? { token: trimmed, expiresAt: null, source: "env" } : { token: null, expiresAt: null, source: "none" };
  }
  const platform = opts.platform ?? process.platform;
  const nowMs = opts.nowMs ?? Date.now();

  let raw: string | null = null;
  let source: OAuthCredentials["source"] = "none";
  if (platform === "darwin") {
    const run = opts.run ?? ((args) => {
      const res = spawnSync("security", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      return { status: res.status, stdout: res.stdout ?? "" };
    });
    const res = run(["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
    if (res.status === 0 && res.stdout.trim() !== "") {
      raw = res.stdout;
      source = "keychain";
    }
  }
  if (raw === null) {
    const file = join(homedir(), ".claude", ".credentials.json");
    if (existsSync(file)) {
      try {
        raw = readFileSync(file, "utf8");
        source = "file";
      } catch {
        raw = null;
      }
    }
  }
  if (raw === null) return { token: null, expiresAt: null, source: "none" };
  try {
    const parsed = JSON.parse(raw) as { claudeAiOauth?: Record<string, unknown> };
    const oauth = parsed.claudeAiOauth ?? (parsed as Record<string, unknown>);
    const token = typeof oauth.accessToken === "string" ? oauth.accessToken : null;
    const expiresAt = typeof oauth.expiresAt === "number" ? oauth.expiresAt : null;
    if (token === null) return { token: null, expiresAt: null, source: "none" };
    return { token, expiresAt, source };
  } catch {
    return { token: null, expiresAt: null, source: "none" };
  }
}

export function oauthStatusHint(creds: OAuthCredentials, nowMs: number): StatusNote[] {
  if (creds.token === null) {
    return [
      {
        label: "hint",
        state: "no Claude Code OAuth token — showing transcript estimates only",
        tone: "muted",
      },
    ];
  }
  if (creds.expiresAt !== null && creds.expiresAt <= nowMs) {
    return [
      {
        label: "hint",
        state: "OAuth token expired — run `claude /login` once to restore real usage %",
        tone: "warn",
      },
    ];
  }
  return [];
}

export interface OAuthWindow {
  percent: number;
  resetsAt: string | null;
}

export interface OAuthUsage {
  fiveHour: OAuthWindow | null;
  weekly: OAuthWindow | null;
}

export function parseOAuthUsage(json: unknown): OAuthUsage | null {
  if (json === null || typeof json !== "object") return null;
  const root = json as Record<string, unknown>;
  const bucket = (v: unknown): OAuthWindow | null => {
    if (v === null || typeof v !== "object") return null;
    const b = v as Record<string, unknown>;
    if (typeof b.utilization !== "number") return null;
    return { percent: b.utilization, resetsAt: typeof b.resets_at === "string" ? b.resets_at : null };
  };
  let fiveHour = bucket(root.five_hour);
  let weekly = bucket(root.seven_day);

  const limits = Array.isArray(root.limits) ? (root.limits as Record<string, unknown>[]) : [];
  for (const l of limits) {
    const kind = typeof l.kind === "string" ? l.kind : "";
    const percent = typeof l.percent === "number" ? l.percent : null;
    const resetsAt = typeof l.resets_at === "string" ? l.resets_at : null;
    // percent 0 with no reset time is a placeholder entry, not real data
    if (percent === null || (percent === 0 && resetsAt === null)) continue;
    if (kind === "session" && fiveHour === null) fiveHour = { percent, resetsAt };
    if (kind === "weekly_all" && weekly === null) weekly = { percent, resetsAt };
  }
  if (fiveHour === null && weekly === null) return null;
  return { fiveHour, weekly };
}

/** Billing states Anthropic uses on the organization; anything else stays unknown. */
const STATE_BY_SUBSCRIPTION_STATUS: Readonly<Record<string, SubscriptionState>> = {
  active: "active",
  trialing: "trialing",
  trial: "trialing",
  canceled: "cancelled",
  cancelled: "cancelled",
  past_due: "past_due",
};

/**
 * Plan facts from `/api/oauth/profile`. Anthropic states the plan and billing status but not
 * the price or the charge date, so those come from subscriptions.toml.
 */
export function claudeFactsFromProfile(json: unknown): SubscriptionFacts | null {
  const root = asRecord(json);
  if (root === null) return null;
  const account = asRecord(root.account);
  const organization = asRecord(root.organization);
  const hasMax = account?.has_claude_max === true;
  const hasPro = account?.has_claude_pro === true;
  const status = typeof organization?.subscription_status === "string" ? organization.subscription_status : null;
  if (!hasMax && !hasPro && status === null) return null;
  return {
    provider: "claude",
    planId: hasMax ? "max" : hasPro ? "pro" : null,
    planName: hasMax ? "Claude Max" : hasPro ? "Claude Pro" : null,
    state: status === null ? "unknown" : (STATE_BY_SUBSCRIPTION_STATUS[status] ?? "unknown"),
    period: null,
    renewsAt: null,
    seats: null,
    source: "claude-oauth",
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export interface ClaudeBlockSummary {
  start: string;
  end: string;
  used: number;
  requests: number;
}

export interface ClaudeDailySummary {
  day: string;
  model: string;
  used: number;
  inTokens: number;
  outTokens: number;
  requests: number;
  /** API-equivalent USD for the day at list prices; null when the model has no price row. */
  costUsd: number | null;
}

export interface ClaudeSummary {
  files: number;
  entries: number;
  duplicates: number;
  unparsableLines: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  /** Last few blocks, oldest first; the final one is the active block. */
  blocks: ClaudeBlockSummary[];
  daily: ClaudeDailySummary[];
  /** Personal token budget for the 5h block (CLAUDE_SESSION_TOKENS), when configured. */
  sessionTokenLimit: number | null;
  /** Personal turn budget for the 5h block (CLAUDE_SESSION_TURNS), when configured. */
  sessionTurnLimit: number | null;
}

interface UsageEvent {
  ts: number;
  model: string;
  used: number;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export function projectsDir(env: Record<string, string | undefined>): string {
  const custom = env.CLAUDE_PROJECTS_DIR;
  const dir = custom && custom.trim() !== "" ? custom : join(homedir(), ".claude", "projects");
  return dir.replace(/^~/, homedir());
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

function collectEvents(
  files: string[],
  sinceMs: number,
): { events: UsageEvent[]; promptTs: number[]; duplicates: number; unparsable: number } {
  const events: UsageEvent[] = [];
  const promptTs: number[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let unparsable = 0;
  for (const file of files) {
    const lines = readFileSync(file, "utf-8").split("\n");
    for (const line of lines) {
      if (line.trim() === "") continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        unparsable += 1;
        continue;
      }
      const ts = Date.parse(String(entry.timestamp ?? ""));
      if (!Number.isFinite(ts) || ts < sinceMs) continue;
      if (entry.type === "user") {
        // Prompts (not their tokens — their TIME) anchor the 5h window.
        if (entry.message !== null && typeof entry.message === "object") promptTs.push(ts);
        continue;
      }
      if (entry.type !== "assistant") continue;
      const message = entry.message;
      if (message === null || typeof message !== "object") continue;
      const msg = message as Record<string, unknown>;
      const usage = msg.usage;
      if (usage === null || typeof usage !== "object") continue;

      const u = usage as Record<string, unknown>;
      const input = Number(u.input_tokens ?? 0) || 0;
      const cacheWrite = Number(u.cache_creation_input_tokens ?? 0) || 0;
      const cacheRead = Number(u.cache_read_input_tokens ?? 0) || 0;
      const output = Number(u.output_tokens ?? 0) || 0;

      // Same turn can be re-logged when a session is resumed; ccusage dedupes on ids too.
      const requestId = typeof entry.requestId === "string" ? entry.requestId : "";
      const msgId = typeof msg.id === "string" ? msg.id : "";
      if (requestId !== "" && msgId !== "") {
        const key = `${requestId}/${msgId}`;
        if (seen.has(key)) {
          duplicates += 1;
          continue;
        }
        seen.add(key);
      }

      events.push({
        ts,
        model: typeof msg.model === "string" && msg.model !== "" ? msg.model : "unknown",
        used: input + cacheWrite + cacheRead + output,
        input,
        cacheWrite,
        cacheRead,
        output,
      });
    }
  }
  events.sort((a, b) => a.ts - b.ts);
  promptTs.sort((a, b) => a - b);
  return { events, promptTs, duplicates, unparsable };
}

/** ccusage block semantics: a turn ≥5h after the block's anchor opens a new block. The anchor
 *  snaps to the prompt that opened the block (verified: /usage reset matched the first prompt,
 *  not the first logged response). */
function foldBlocks(events: UsageEvent[], promptTs: number[]): ClaudeBlockSummary[] {
  const blocks: Array<ClaudeBlockSummary & { anchorMs: number }> = [];
  let lastTs = Number.NEGATIVE_INFINITY;
  for (const e of events) {
    const current = blocks.at(-1);
    if (current === undefined || e.ts >= current.anchorMs + BLOCK_MS) {
      let anchor = e.ts;
      for (const p of promptTs) {
        if (p > lastTs && p <= e.ts && p < anchor) anchor = p;
      }
      blocks.push({
        anchorMs: anchor,
        start: new Date(anchor).toISOString(),
        end: new Date(anchor + BLOCK_MS).toISOString(),
        used: e.used,
        requests: 1,
      });
    } else {
      current.used += e.used;
      current.requests += 1;
    }
    lastTs = e.ts;
  }
  return blocks.map(({ anchorMs, ...b }) => b);
}

interface DailyTotals {
  day: string;
  model: string;
  used: number;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  requests: number;
}

/** One row per (UTC day, model). Raw token kinds are kept apart so pricing stays exact. */
function accumulateDaily(events: UsageEvent[]): Map<string, DailyTotals> {
  const daily = new Map<string, DailyTotals>();
  for (const e of events) {
    const day = new Date(e.ts).toISOString().slice(0, 10);
    const key = `${day}|${e.model}`;
    const row = daily.get(key) ?? { day, model: e.model, used: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, requests: 0 };
    row.used += e.used;
    row.input += e.input;
    row.cacheWrite += e.cacheWrite;
    row.cacheRead += e.cacheRead;
    row.output += e.output;
    row.requests += 1;
    daily.set(key, row);
  }
  return daily;
}

function priceDaily(totals: Map<string, DailyTotals>, pricing: PricingTable): ClaudeDailySummary[] {
  return [...totals.values()].map((t) => ({
    day: t.day,
    model: t.model,
    used: t.used,
    inTokens: t.input + t.cacheWrite + t.cacheRead,
    outTokens: t.output,
    requests: t.requests,
    costUsd: estimateCost(pricing, t.model, {
      input: t.input,
      cacheWrite: t.cacheWrite,
      cacheRead: t.cacheRead,
      output: t.output,
    }),
  }));
}

function summarize(
  files: string[],
  events: UsageEvent[],
  promptTs: number[],
  duplicates: number,
  unparsable: number,
  sessionTokenLimit: number | null,
  sessionTurnLimit: number | null,
  pricing: PricingTable,
): ClaudeSummary {
  const daily = priceDaily(accumulateDaily(events), pricing);
  const first = events[0];
  const last = events.at(-1);
  return {
    files: files.length,
    entries: events.length,
    duplicates,
    unparsableLines: unparsable,
    firstTimestamp: first ? new Date(first.ts).toISOString() : null,
    lastTimestamp: last ? new Date(last.ts).toISOString() : null,
    blocks: foldBlocks(events, promptTs).slice(-3),
    daily: daily.sort((a, b) => (a.day === b.day ? (a.model < b.model ? -1 : 1) : a.day < b.day ? 1 : -1)),
    sessionTokenLimit,
    sessionTurnLimit,
  };
}

export const claudeAdapter: Adapter = {
  id: "claude",
  stabilityTier: 3,
  isolate: true,
  pollEveryMs: 5 * 60_000,

  isConfigured(env) {
    try {
      return existsSync(projectsDir(env));
    } catch {
      return false;
    }
  },
  missingCredentials(env) {
    return this.isConfigured(env) ? [] : ["~/.claude/projects (run Claude Code once, or set CLAUDE_PROJECTS_DIR)"];
  },

  notes: [
    {
      title: "Claude Pro/Max — transcripts plus an opt-in account-wide check",
      text: "Anthropic has no public usage API for personal subscriptions. Token totals come from the session logs Claude Code writes under ~/.claude/projects — the same source ccusage reads — so they only cover this machine. With CLAUDE_OAUTH_USAGE=1 the card also asks Anthropic's own usage endpoint for the account-wide 5h/weekly percentages, which is the only view that includes claude.ai and other devices. Otherwise nothing leaves the machine.",
    },
    {
      title: "5-hour and weekly windows",
      text: "Percentages come from the account-wide usage endpoint when CLAUDE_OAUTH_USAGE=1, else from the optional statusLine script (scripts/claude-statusline.ts; rate_limits on Claude Code 2.1.80+), else from `claude -p /usage --output-format json` with stdin closed and a short timeout. That command is a dead end on Claude Code 2.1.307+, where it answers with a local_command result and no window data, so its failure is cached for 6 hours. A StopFailure hook can still record an exact reset. Set CLAUDE_USAGE=0 to skip the command entirely.",
    },
    {
      title: "Cost is API-equivalent, not a bill",
      text: "A subscription is not billed per token, so per-model spend is what these tokens would cost at list prices (input, output, cache read, cache write) from the checked-in table in src/pricing/anthropic.json — the same number CodexBar shows. Treat it as a burn metric for comparing days and models. Refresh prices with `bun run scripts/refresh-pricing.ts` when a new model lands.",
    },
    {
      title: "Scope & counting",
      text: "Only sessions run on this machine land in the token totals. Totals count input, output, and cached tokens (cache reads dominate long sessions); sub-agent turns are included. Claude Code prunes old transcripts, but modelizer keeps the daily history it has already recorded.",
    },
    {
      title: "How much is left? Calibrate the budgets",
      text: "Anthropic doesn't publish plan limits, so 'left' is a personal calibration: run /usage inside Claude Code (the authoritative view), note its % against the tokens/requests here, and set CLAUDE_SESSION_TOKENS / CLAUDE_SESSION_TURNS in .env to your effective full-window budgets. Calibrated for Opus 5.5 on medium: ~47M tokens ≈ 210 requests per 5h window (2026-10-06). Requests count API turns including tool loops; different models or effort levels drain budgets at different rates.",
    },
  ] satisfies ProviderNote[],

  statusHints(env) {
    if (env.CLAUDE_OAUTH_USAGE !== "1") {
      return [
        {
          label: "hint",
          state: "account-wide usage is off — set CLAUDE_OAUTH_USAGE=1 for Anthropic's own 5h/weekly %",
          tone: "muted",
        },
      ];
    }
    const nowMs = Date.now();
    return oauthStatusHint(readOAuthCredentials(env, { nowMs }), nowMs);
  },

  async collect(ctx: CollectContext): Promise<RawPoll[]> {
    const dir = projectsDir(ctx.env);
    const now = ctx.now.getTime();
    const since = now - SCAN_MS;

    let files: string[] = [];
    if (existsSync(dir)) files = listSessionFiles(dir, now);
    const { events, promptTs, duplicates, unparsable } = collectEvents(files, since);
    const tokens = Number(ctx.env.CLAUDE_SESSION_TOKENS ?? "");
    const turns = Number(ctx.env.CLAUDE_SESSION_TURNS ?? "");
    const summary = summarize(
      files,
      events,
      promptTs,
      duplicates,
      unparsable,
      Number.isFinite(tokens) && tokens > 0 ? tokens : null,
      Number.isFinite(turns) && turns > 0 ? turns : null,
      bundledPricing(),
    );
    const body = JSON.stringify(summary);
    const polls: RawPoll[] = [
      {
        endpoint: "projects-jsonl",
        url: `file://${dir}`,
        status: 200,
        body,
        json: summary,
        headers: {},
      },
    ];

    const oauth = await readOAuthUsagePoll(ctx);
    if (oauth) polls.push(oauth);
    const profile = await readOAuthProfilePoll(ctx);
    if (profile) polls.push(profile);
    const statusline = readStatuslinePoll(ctx);
    if (statusline) polls.push(statusline);
    const usage = await readUsageCommand(ctx);
    if (usage) polls.push(usage);
    const hook = readHookPoll(ctx);
    if (hook) polls.push(hook);
    return polls;
  },

  normalize(polls, capturedAt) {
    const poll = polls.find((p) => p.endpoint === "projects-jsonl" && p.status === 200);
    if (poll === undefined) throw new NormalizeError("claude: no projects-jsonl poll");
    const s = poll.json as ClaudeSummary | null;
    if (s === null || !Array.isArray(s.daily) || !Array.isArray(s.blocks)) {
      throw new NormalizeError("claude: unexpected summary shape");
    }

    const points: UsagePoint[] = [];

    for (const w of mergeClaudeWindows(polls, capturedAt)) {
      const label = w.window === "five_hour" ? "claude-5h-percent" : "claude-weekly-percent";
      points.push(blankPoint(capturedAt, label, "quota", "percent", {
        used: w.usedPercent,
        limit: w.usedPercent === null ? null : 100,
        remaining: w.usedPercent === null ? null : Math.max(0, 100 - w.usedPercent),
        reset_at: w.resetsAt,
        window_end: w.resetsAt,
        quota_window: w.window,
        source: w.source,
        stale: w.stale,
        used_percent: w.usedPercent,
      }));
    }

    const active = s.blocks.at(-1);
    if (active !== undefined) {
      // Roll-forward: if the transcript block's window already elapsed (e.g. the user reset
      // or simply waited), show a fresh window instead of stale numbers.
      const elapsed = Date.parse(active.end) <= Date.parse(capturedAt);
      points.push(blankPoint(capturedAt, "claude-5h", "usage", "tokens", {
        used: elapsed ? 0 : active.used,
        limit: s.sessionTokenLimit,
        remaining:
          s.sessionTokenLimit !== null
            ? Math.max(0, s.sessionTokenLimit - (elapsed ? 0 : active.used))
            : null,
        window_start: elapsed ? null : active.start,
        window_end: elapsed ? null : active.end,
        reset_at: elapsed ? null : active.end,
        requests: elapsed ? 0 : active.requests,
      }));
      if (s.sessionTurnLimit !== null && s.sessionTurnLimit > 0) {
        points.push(blankPoint(capturedAt, "claude-5h-turns", "quota", "requests", {
          used: elapsed ? 0 : active.requests,
          limit: s.sessionTurnLimit,
          remaining: elapsed ? s.sessionTurnLimit : Math.max(0, s.sessionTurnLimit - active.requests),
          window_start: elapsed ? null : active.start,
          window_end: elapsed ? null : active.end,
          reset_at: elapsed ? null : active.end,
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
      // API-equivalent list-price cost for the same day; unknown models stay unpriced.
      if (typeof d.costUsd === "number" && Number.isFinite(d.costUsd)) {
        points.push(blankPoint(capturedAt, "model-spend", "usage", "usd", {
          model: d.model,
          day: d.day,
          cost_usd: d.costUsd,
          source: "pricing",
        }));
      }
    }
    if (points.length === 0) {
      throw new NormalizeError("claude: no assistant usage found in ~/.claude/projects (last 8 days)");
    }
    return points;
  },

  subscriptionFacts(polls) {
    const poll = polls.find((p) => p.endpoint === OAUTH_PROFILE_ENDPOINT && p.status === 200);
    return poll === undefined ? null : claudeFactsFromProfile(poll.json);
  },
};

const HOOK_MAX_AGE_MS = 14 * 86_400_000;
/** Status-line snapshots older than this are ignored; the file only updates while Claude Code is open. */
export const STATUSLINE_MAX_AGE_MS = 6 * 3_600_000;
/** "Unknown skill" / empty / hung `/usage` is not retried on every poll. */
export const USAGE_UNSUPPORTED_BACKOFF_MS = 6 * 3_600_000;
/** Stdin is closed by runCommand (`stdio: "ignore"`). JSON mode returns in well under this on 2.1.7. */
export const USAGE_COMMAND_TIMEOUT_MS = 5_000;
export const CLAUDE_USAGE_ARGS = ["-p", "/usage", "--output-format", "json"] as const;

export function hookFilePath(env: Record<string, string | undefined>): string {
  return envPath(env.MODELIZER_CLAUDE_HOOK_FILE, join(homedir(), ".modelizer", "claude-rate-limit.json"));
}

function statuslineFilePath(env: Record<string, string | undefined>): string {
  return envPath(env.MODELIZER_CLAUDE_STATUSLINE_FILE, join(homedir(), ".modelizer", "claude-statusline.json"));
}

function usageStatePath(env: Record<string, string | undefined>): string {
  return envPath(env.MODELIZER_CLAUDE_USAGE_STATE, join(homedir(), ".modelizer", "claude-usage-command.json"));
}

function envPath(custom: string | undefined, fallback: string): string {
  const trimmed = custom?.trim();
  if (trimmed) return trimmed.replace(/^~/, homedir());
  return fallback;
}

async function readUsageCommand(ctx: CollectContext): Promise<RawPoll | null> {
  if (ctx.env.CLAUDE_USAGE === "0") return null;
  if (backoffActive(usageStatePath(ctx.env), ctx.now)) return null;
  const file = ctx.env.CLAUDE_USAGE_FILE?.trim();
  if (file) {
    try {
      return finishUsage(ctx, `file://${file}`, readFileSync(file, "utf8"), null);
    } catch (err) {
      const message = (err as Error).message;
      return {
        endpoint: "usage-command",
        url: `file://${file}`,
        status: 0,
        body: message,
        json: { stale: true, windows: [], error: message },
        headers: {},
        optional: true,
      };
    }
  }
  const bin = ctx.env.CLAUDE_BIN?.trim() || "claude";
  const result = await runCommand(bin, [...CLAUDE_USAGE_ARGS], USAGE_COMMAND_TIMEOUT_MS);
  if (result.missing) {
    ctx.log("claude: `claude` binary unavailable; transcripts only");
    return null;
  }
  const hung = result.error === "timeout" ? "timeout" as const : null;
  return finishUsage(ctx, "claude -p /usage --output-format json", result.stdout, hung);
}

function finishUsage(
  ctx: CollectContext,
  url: string,
  text: string,
  hung: "timeout" | null,
): RawPoll {
  const reason = hung ?? usageUnsupportedReason(text);
  if (reason !== null) {
    rememberUsageUnsupported(ctx, reason);
    ctx.log(`claude: /usage unsupported (${reason}); not retrying for ${USAGE_UNSUPPORTED_BACKOFF_MS / 3_600_000}h`);
    return {
      endpoint: "usage-command",
      url,
      status: 200,
      body: text === "" ? reason : text,
      json: { stale: true, unsupported: true, reason, windows: [] },
      headers: {},
      optional: true,
    };
  }
  return usagePoll(url, text, ctx.now);
}

function backoffActive(path: string, now: Date): boolean {
  if (!existsSync(path)) return false;
  try {
    const json = JSON.parse(readFileSync(path, "utf8")) as { until?: unknown };
    const until = typeof json.until === "string" ? Date.parse(json.until) : NaN;
    return Number.isFinite(until) && until > now.getTime();
  } catch {
    return false;
  }
}

/** Record "do not ask again until X" next to the adapter so a restart does not reset it. */
function rememberBackoff(ctx: CollectContext, path: string, reason: string, untilMs: number): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const body = JSON.stringify({
      until: new Date(untilMs).toISOString(),
      reason,
      detectedAt: ctx.now.toISOString(),
    });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${body}\n`);
    renameSync(tmp, path);
  } catch (err) {
    ctx.log(`claude: could not record backoff for ${path} (${(err as Error).message})`);
  }
}

function rememberUsageUnsupported(ctx: CollectContext, reason: string): void {
  rememberBackoff(ctx, usageStatePath(ctx.env), reason, ctx.now.getTime() + USAGE_UNSUPPORTED_BACKOFF_MS);
}

export function oauthStatePath(env: Record<string, string | undefined>): string {
  return envPath(env.MODELIZER_CLAUDE_OAUTH_STATE, join(homedir(), ".modelizer", "claude-oauth-state.json"));
}

function oauthWindows(usage: OAuthUsage): ParsedUsageWindow[] {
  const out: ParsedUsageWindow[] = [];
  for (const [window, bucket] of [["five_hour", usage.fiveHour], ["weekly", usage.weekly]] as const) {
    if (bucket === null) continue;
    out.push({ window, usedPercent: bucket.percent, resetsAt: isoOrNull(bucket.resetsAt) });
  }
  return out;
}

/** The endpoint sends `+00:00` with microseconds; store one canonical ISO form. */
function isoOrNull(value: string | null): string | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

async function requestOAuth(ctx: CollectContext, url: string, endpoint: string, token: string): Promise<RawPoll> {
  try {
    return await fetchPoll(ctx, {
      endpoint,
      url,
      headers: { ...OAUTH_HEADERS, authorization: `Bearer ${token}` },
      optional: true,
    });
  } catch (err) {
    const message = (err as Error).message;
    ctx.log(`claude: ${endpoint} request failed (${message})`);
    return {
      endpoint,
      url,
      status: 0,
      body: message,
      json: { stale: true, windows: [], error: message },
      headers: {},
      optional: true,
    };
  }
}

/** Shared guard: opt-in flag, backoff marker, and a live Claude Code token. */
function oauthRequestToken(ctx: CollectContext): string | null {
  if (ctx.env.CLAUDE_OAUTH_USAGE !== "1") return null;
  if (backoffActive(oauthStatePath(ctx.env), ctx.now)) return null;
  const creds = readOAuthCredentials(ctx.env, { nowMs: ctx.now.getTime() });
  if (creds.token === null) {
    ctx.log("claude: CLAUDE_OAUTH_USAGE=1 but no Claude Code token; skipping account-wide usage");
    return null;
  }
  if (creds.expiresAt !== null && creds.expiresAt <= ctx.now.getTime()) {
    ctx.log("claude: Claude Code token expired; skipping account-wide usage");
    return null;
  }
  return creds.token;
}

function noteOAuthFailure(ctx: CollectContext, status: number): string {
  const reason = status === 200 ? "unexpected-shape" : `http-${status}`;
  rememberBackoff(ctx, oauthStatePath(ctx.env), reason, ctx.now.getTime() + OAUTH_BACKOFF_MS);
  ctx.log(`claude: oauth ${reason}; not retrying for ${OAUTH_BACKOFF_MS / 60_000}m`);
  return reason;
}

/**
 * Account-wide 5h/weekly percentages from Anthropic's usage endpoint. Off unless
 * `CLAUDE_OAUTH_USAGE=1`. Never refreshes the token; failures back off for an hour.
 */
async function readOAuthUsagePoll(ctx: CollectContext): Promise<RawPoll | null> {
  const token = oauthRequestToken(ctx);
  if (token === null) return null;
  const poll = await requestOAuth(ctx, OAUTH_USAGE_URL, OAUTH_USAGE_ENDPOINT, token);
  const parsed = poll.status === 200 ? parseOAuthUsage(poll.json) : null;
  if (parsed === null) return { ...poll, json: { stale: true, windows: [], reason: noteOAuthFailure(ctx, poll.status) } };
  return { ...poll, json: { stale: false, windows: oauthWindows(parsed) } };
}

/** Plan and billing state, so the Subscriptions page can report the real plan. */
async function readOAuthProfilePoll(ctx: CollectContext): Promise<RawPoll | null> {
  const token = oauthRequestToken(ctx);
  if (token === null) return null;
  const poll = await requestOAuth(ctx, OAUTH_PROFILE_URL, OAUTH_PROFILE_ENDPOINT, token);
  if (poll.status !== 200) noteOAuthFailure(ctx, poll.status);
  return poll;
}

function readStatuslinePoll(ctx: CollectContext): RawPoll | null {
  const path = statuslineFilePath(ctx.env);
  if (!existsSync(path)) return null;
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return {
      endpoint: "usage-statusline",
      url: `file://${path}`,
      status: 0,
      body: (err as Error).message,
      json: { fresh: false, windows: [] },
      headers: {},
      optional: true,
    };
  }
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  const record = json !== null && typeof json === "object" ? json as Record<string, unknown> : null;
  const recordedAt = typeof record?.recordedAt === "string" ? Date.parse(record.recordedAt) : NaN;
  const age = ctx.now.getTime() - recordedAt;
  const freshClock = Number.isFinite(recordedAt) && age >= -60_000 && age <= STATUSLINE_MAX_AGE_MS;
  const windows = freshClock && record
    ? windowsFromRateLimits(record.rate_limits).filter((w) => w.resetsAt === null || Date.parse(w.resetsAt) > ctx.now.getTime())
    : [];
  return {
    endpoint: "usage-statusline",
    url: `file://${path}`,
    status: record ? 200 : 422,
    body: text,
    json: { fresh: freshClock && windows.length > 0, windows },
    headers: {},
    optional: true,
  };
}

function usagePoll(url: string, text: string, now: Date): RawPoll {
  const parsed = parseUsageText(text, now);
  const stale = parsed.windows.length === 0;
  return {
    endpoint: "usage-command",
    url,
    status: 200,
    body: text,
    json: { stale, windows: parsed.windows },
    headers: {},
    optional: true,
  };
}

function readHookPoll(ctx: CollectContext): RawPoll | null {
  const path = hookFilePath(ctx.env);
  if (!existsSync(path)) return null;
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return {
      endpoint: "usage-hook",
      url: `file://${path}`,
      status: 0,
      body: (err as Error).message,
      json: null,
      headers: {},
      optional: true,
    };
  }
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return {
    endpoint: "usage-hook",
    url: `file://${path}`,
    status: json ? 200 : 422,
    body: text,
    json,
    headers: {},
    optional: true,
  };
}

interface ClaudeWindow {
  window: "five_hour" | "weekly";
  usedPercent: number | null;
  resetsAt: string | null;
  source: string;
  stale: boolean;
}

function mergeClaudeWindows(polls: RawPoll[], capturedAt: string): ClaudeWindow[] {
  const map = new Map<string, ClaudeWindow>();

  // Account-wide first: this is the only source that also sees claude.ai and other machines.
  const oauth = polls.find((p) => p.endpoint === OAUTH_USAGE_ENDPOINT && p.status === 200);
  const oauthBody = oauth?.json as { stale?: boolean; windows?: ParsedUsageWindow[] } | null;
  if (oauthBody?.stale !== true && Array.isArray(oauthBody?.windows)) {
    for (const w of oauthBody.windows) {
      map.set(w.window, { window: w.window, usedPercent: w.usedPercent, resetsAt: w.resetsAt, source: "oauth", stale: false });
    }
  }

  const status = polls.find((p) => p.endpoint === "usage-statusline" && p.status === 200);
  const statusBody = status?.json as { fresh?: boolean; windows?: ParsedUsageWindow[] } | null;
  if (statusBody?.fresh === true && Array.isArray(statusBody.windows)) {
    for (const w of statusBody.windows) {
      if (map.has(w.window)) continue;
      map.set(w.window, {
        window: w.window,
        usedPercent: w.usedPercent,
        resetsAt: w.resetsAt,
        source: "statusline",
        stale: false,
      });
    }
  }

  const usage = polls.find((p) => p.endpoint === "usage-command");
  if (usage) {
    const body = usage.json as { stale?: boolean; windows?: ParsedUsageWindow[] } | null;
    const windows = body?.windows ?? [];
    const bad = usage.status !== 200 || body?.stale === true || windows.length === 0;
    if (!bad) {
      for (const w of windows) {
        if (!map.has(w.window)) {
          map.set(w.window, {
            window: w.window,
            usedPercent: w.usedPercent,
            resetsAt: w.resetsAt,
            source: "usage-command",
            stale: false,
          });
        }
      }
    } else {
      for (const window of ["five_hour", "weekly"] as const) {
        if (!map.has(window)) {
          map.set(window, { window, usedPercent: null, resetsAt: null, source: "usage-command", stale: true });
        }
      }
    }
  }

  const hookPoll = polls.find((p) => p.endpoint === "usage-hook" && p.status === 200);
  const hook = hookPoll?.json as HookRecord | null;
  if (hook && hook.error === "rate_limit" && typeof hook.resetsAt === "string") {
    const recorded = Date.parse(hook.recordedAt);
    const resets = Date.parse(hook.resetsAt);
    const fresh = Number.isFinite(recorded) && Date.parse(capturedAt) - recorded < HOOK_MAX_AGE_MS && resets > Date.parse(capturedAt);
    if (fresh) {
      const key = hook.window ?? "five_hour";
      const existing = map.get(key);
      map.set(key, {
        window: key,
        usedPercent: existing?.usedPercent ?? 100,
        resetsAt: new Date(resets).toISOString(),
        source: "hook",
        stale: false,
      });
    }
  }

  // A failed OAuth call still says "we don't know" — only for windows nothing else filled.
  const oauthPoll = polls.find((p) => p.endpoint === OAUTH_USAGE_ENDPOINT);
  const oauthFailed = oauthPoll !== undefined && (oauthPoll.status !== 200 || (oauthPoll.json as { stale?: boolean } | null)?.stale === true);
  if (oauthFailed) {
    for (const window of ["five_hour", "weekly"] as const) {
      if (!map.has(window)) map.set(window, { window, usedPercent: null, resetsAt: null, source: "oauth", stale: true });
    }
  }
  return [...map.values()];
}

function blankPoint(
  capturedAt: string,
  label: string,
  kind: UsagePoint["kind"],
  unit: UsagePoint["unit"],
  fields: Partial<UsagePoint>,
): UsagePoint {
  return {
    provider: "claude",
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
