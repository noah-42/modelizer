import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fetchPoll, NormalizeError } from "./types";
import type { Adapter, CollectContext, ProviderNote, RawPoll, StatusNote, UsagePoint } from "./types";

/**
 * Claude Pro/Max subscription (Claude Code) — stability tier 3: local files, no API.
 * Anthropic exposes no usage API for personal plans; the only machine-readable record is the
 * JSONL transcript Claude Code writes per session. Verified shape on 2026-10-06
 * (see plans/2026-10-oct-03_MOD001 provider matrix, T3 row — the ccusage data source):
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
 * Weekly limits exist too but are not derivable from transcripts; only the block is reported.
 * Everything is aggregate-only: no message text, session ids, or project paths leave collect().
 */

const BLOCK_MS = 5 * 3_600_000;
/** Scan window: the 5h block plus daily history for the UI's 7-day per-model section. */
const SCAN_MS = 8 * 86_400_000;

/**
 * Real quota telemetry (stability tier 2, verified schema from ccstatusline's usage-fetch,
 * 2026-10-13): Claude Code stores an OAuth token (macOS keychain service
 * "Claude Code-credentials", JSON blob { claudeAiOauth: { accessToken, expiresAt, ... } }),
 * which reads live windows from GET api.anthropic.com/api/oauth/usage
 * (header anthropic-beta: oauth-2025-04-20). Response — flat buckets win, limits[] fallback:
 *   { five_hour: { utilization, resets_at } | null, seven_day: { ... } | null,
 *     limits: [ { kind: "session"|"weekly_all"|"weekly_scoped", percent, resets_at } ] }
 * A limits entry with percent 0 and no resets_at is a placeholder, not data.
 * The token travels only in the Authorization header and is never logged or stored.
 */

const OAUTH_USAGE_PATH = "/api/oauth/usage";

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

export function parseOAuthUsage(
  json: unknown,
): { fiveHour: { percent: number; resetsAt: string | null } | null; weekly: { percent: number; resetsAt: string | null } | null } | null {
  if (json === null || typeof json !== "object") return null;
  const root = json as Record<string, unknown>;
  const bucket = (v: unknown): { percent: number; resetsAt: string | null } | null => {
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
  inTokens: number;
  outTokens: number;
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
        inTokens: input + cacheWrite + cacheRead,
        outTokens: output,
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

function summarize(
  dir: string,
  files: string[],
  events: UsageEvent[],
  promptTs: number[],
  duplicates: number,
  unparsable: number,
  sessionTokenLimit: number | null,
  sessionTurnLimit: number | null,
): ClaudeSummary {
  const daily = new Map<string, ClaudeDailySummary>();
  for (const e of events) {
    const day = new Date(e.ts).toISOString().slice(0, 10);
    const key = `${day}|${e.model}`;
    const row = daily.get(key) ?? { day, model: e.model, used: 0, inTokens: 0, outTokens: 0, requests: 0 };
    row.used += e.used;
    row.inTokens += e.inTokens;
    row.outTokens += e.outTokens;
    row.requests += 1;
    daily.set(key, row);
  }
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
    daily: [...daily.values()].sort((a, b) => (a.day === b.day ? (a.model < b.model ? -1 : 1) : a.day < b.day ? 1 : -1)),
    sessionTokenLimit,
    sessionTurnLimit,
  };
}

export const claudeAdapter: Adapter = {
  id: "claude",
  stabilityTier: 3,
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

  statusHints(env): StatusNote[] {
    try {
      return oauthStatusHint(readOAuthCredentials(env), Date.now());
    } catch {
      return [];
    }
  },

  notes: [
    {
      title: "Claude Pro/Max — local transcripts, no API",
      text: "Anthropic has no usage API for personal subscriptions. This card parses the session logs Claude Code writes under ~/.claude/projects — the same source ccusage reads — so nothing is sent anywhere and no key is needed.",
    },
    {
      title: "5-hour session blocks",
      text: "Usage metering runs in 5-hour blocks anchored at your first prompt after a break; a turn five hours after the block started opens a new one. Plan limits are unpublished, so the card shows absolute tokens instead of a percentage. Weekly limits aren't derivable from transcripts.",
    },
    {
      title: "Scope & counting",
      text: "Only sessions run on this machine are visible. Totals count input, output, and cached tokens (cache reads dominate long sessions); sub-agent turns are included. Claude Code prunes old transcripts, but modelizer keeps the daily history it has already recorded.",
    },
    {
      title: "How much is left? Calibrate the budgets",
      text: "Anthropic doesn't publish plan limits, so 'left' is a personal calibration: run /usage inside Claude Code (the authoritative view), note its % against the tokens/requests here, and set CLAUDE_SESSION_TOKENS / CLAUDE_SESSION_TURNS in .env to your effective full-window budgets. Calibrated for Opus 5.5 on medium: ~47M tokens ≈ 210 requests per 5h window (2026-10-06). Requests count API turns including tool loops; different models or effort levels drain budgets at different rates.",
    },
  ] satisfies ProviderNote[],

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
      dir,
      files,
      events,
      promptTs,
      duplicates,
      unparsable,
      Number.isFinite(tokens) && tokens > 0 ? tokens : null,
      Number.isFinite(turns) && turns > 0 ? turns : null,
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

    // Opportunistic live-quota poll: only when a plausibly-fresh OAuth token exists.
    const creds = readOAuthCredentials(ctx.env, { nowMs: now });
    const expired = creds.expiresAt !== null && creds.expiresAt <= now;
    if (creds.token !== null && !expired) {
      const base = (ctx.env.ANTHROPIC_OAUTH_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, "");
      polls.push(
        await fetchPoll(ctx, {
          endpoint: "oauth-usage",
          url: `${base}${OAUTH_USAGE_PATH}`,
          headers: {
            Authorization: `Bearer ${creds.token}`,
            "anthropic-beta": "oauth-2025-04-20",
            Accept: "application/json",
          },
          optional: true,
        }),
      );
    }
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

    // Live quota from Anthropic's OAuth usage endpoint when the poll succeeded.
    const usage = polls.find((p) => p.endpoint === "oauth-usage" && p.status === 200);
    const oauth = usage !== undefined ? parseOAuthUsage(usage.json) : null;
    if (oauth?.fiveHour !== null && oauth?.fiveHour !== undefined) {
      points.push(blankPoint(capturedAt, "claude-5h-percent", "quota", "percent", {
        used: oauth.fiveHour.percent,
        limit: 100,
        remaining: Math.max(0, 100 - oauth.fiveHour.percent),
        reset_at: oauth.fiveHour.resetsAt,
        window_end: oauth.fiveHour.resetsAt,
      }));
    }
    if (oauth?.weekly !== null && oauth?.weekly !== undefined) {
      points.push(blankPoint(capturedAt, "claude-weekly-percent", "quota", "percent", {
        used: oauth.weekly.percent,
        limit: 100,
        remaining: Math.max(0, 100 - oauth.weekly.percent),
        reset_at: oauth.weekly.resetsAt,
        window_end: oauth.weekly.resetsAt,
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
    }
    if (points.length === 0) {
      throw new NormalizeError("claude: no assistant usage found in ~/.claude/projects (last 8 days)");
    }
    return points;
  },
};

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
