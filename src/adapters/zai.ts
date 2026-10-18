import { fetchPoll, NormalizeError, num } from "./types";
import type { Adapter, CollectContext, ProviderNote, RawPoll, StatusNote, UsagePoint } from "./types";

const DEFAULT_BASE = "https://api.z.ai";

/**
 * Peak pricing (official, docs.z.ai devpack overview, verified 2026-10-03):
 * Monday–Friday 14:00–18:00 Singapore time (UTC+8) = 06:00–10:00 UTC; off-peak bills at 50%
 * of the credit rate. Promo: Sept 25 – Oct 7, 2026 all-day off-peak. No endpoint exposes this —
 * computed from the clock.
 */
const PEAK_START_UTC_H = 6;
const PEAK_END_UTC_H = 10;
const PROMO_ALL_DAY_OFFPEAK_END = Date.parse("2026-10-08T00:00:00Z");

/**
 * All endpoints are UNDOCUMENTED (stability tier 2), reverse-engineered by the community and in
 * active use by CodexBar / TokenStep as of 2026-10-03. Shapes pinned from their sources:
 *
 * GET /api/monitor/usage/quota/limit            (required poll — richest source)
 *   { data: { level, limits: [ { type: TOKENS_LIMIT|TIME_LIMIT|CREDIT_LIMIT,
 *       unit, number, percentage, usage(TOTAL), currentValue?, remaining?,
 *       nextResetTime (EPOCH MS — observed as number in the wild), usageDetails: [...] } ] } }
 *   unit multipliers are minutes: 1→day, 3→hour, 5→minute, 6→week. Team scope adds ?type=2
 *   plus Bigmodel-Organization / Bigmodel-Project headers. Observed on a lite coding plan:
 *   the 5h window arrives percentage-only, and MCP (TIME_LIMIT) carries per-tool usageDetails.
 * GET /api/coding/usage                         (optional; coding-plan keys only)
 *   windows token_window / daily (5h) / monthly, each { used, remaining, total } (+aliases).
 *   Observed 2026-10-03: can return HTTP 200 with { code: 500, success: false } — treat as absent.
 * GET /api/monitor/usage/model-usage?startTime&endTime   (optional; per-model usage)
 *   { data: { x_time: ["YYYY-MM-DD HH:MM", ...] (HOURLY), modelDataList: [{ modelName,
 *     tokensUsage: [...] }] } } — aggregated to daily totals per model.
 * GET /api/paas/v4/balance                      (optional; 404s on coding-plan keys today)
 *   { data: { total_balance, available_balance, currency } }
 */

// CodexBar's window-length table: unit code → minutes.
const UNIT_MINUTES: Record<number, number> = { 1: 1440, 3: 60, 5: 1, 6: 10080 };

export const zaiAdapter: Adapter = {
  id: "zai",
  stabilityTier: 2,
  pollEveryMs: 15 * 60_000,

  isConfigured(env) {
    return Boolean(env.ZAI_API_KEY);
  },
  missingCredentials(env) {
    return env.ZAI_API_KEY ? [] : ["ZAI_API_KEY"];
  },

  liveStatus(now: Date): StatusNote[] {
    const t = now.getTime();
    if (t < PROMO_ALL_DAY_OFFPEAK_END) {
      return [
        {
          label: "pricing",
          state: "off-peak · all-day promo rate",
          tone: "good",
          until: new Date(PROMO_ALL_DAY_OFFPEAK_END).toISOString(),
        },
      ];
    }
    const weekday = now.getUTCDay() >= 1 && now.getUTCDay() <= 5;
    const hour = now.getUTCHours();
    if (weekday && hour >= PEAK_START_UTC_H && hour < PEAK_END_UTC_H) {
      const until = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), PEAK_END_UTC_H),
      );
      return [{ label: "pricing", state: "peak · 1× credits", tone: "warn", until: until.toISOString() }];
    }
    let next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), PEAK_START_UTC_H));
    if (t >= next.getTime()) next = new Date(next.getTime() + 86_400_000);
    while (next.getUTCDay() === 0 || next.getUTCDay() === 6) next = new Date(next.getTime() + 86_400_000);
    return [{ label: "pricing", state: "off-peak · 0.5× credits", tone: "good", until: next.toISOString() }];
  },

  notes: [
    {
      title: "GLM Coding Plan (subscription, not pay-as-you-go)",
      text: "Model tokens draw from a 5-hour rolling window plus a monthly pool. Z.AI reports the 5h window only as a percentage on this plan — the absolute token pool isn't exposed, so the card shows %. Cached input tokens are cheaper than fresh input/output (Z.AI discount schedule).",
    },
    {
      title: "Credits & peak pricing",
      text: "Usage is metered in credits: peak hours (weekdays 14:00–18:00 Singapore time = 06:00–10:00 UTC) cost 1×, off-peak 0.5×. Promotions can make all day off-peak (e.g. Sept 25 – Oct 7, 2026).",
    },
    {
      title: "MCP tools",
      text: "search-prime, web-reader, and zread share a monthly request quota (100 calls on lite), separate from the token windows.",
    },
  ] satisfies ProviderNote[],

  async collect(ctx: CollectContext): Promise<RawPoll[]> {
    const base = (ctx.env.ZAI_BASE_URL ?? DEFAULT_BASE).replace(/\/$/, "");
    const headers: Record<string, string> = {
      Authorization: `Bearer ${ctx.env.ZAI_API_KEY}`,
      Accept: "application/json",
    };
    const team = ctx.env.ZAI_ORGANIZATION !== undefined;
    if (team) {
      headers["Bigmodel-Organization"] = ctx.env.ZAI_ORGANIZATION ?? "";
      if (ctx.env.ZAI_PROJECT) headers["Bigmodel-Project"] = ctx.env.ZAI_PROJECT;
    }

    const polls: RawPoll[] = [];
    polls.push(
      // Optional: a 429 here degrades to the coding-usage fallback instead of failing the run.
      await tryPoll(
        fetchPoll(ctx, {
          endpoint: "quota-limit",
          url: `${base}/api/monitor/usage/quota/limit${team ? "?type=2" : ""}`,
          headers,
          optional: true,
        }),
        "quota-limit",
        `${base}/api/monitor/usage/quota/limit`,
      ),
    );
    polls.push(
      await tryPoll(
        fetchPoll(ctx, { endpoint: "coding-usage", url: `${base}/api/coding/usage`, headers, optional: true }),
        "coding-usage",
        `${base}/api/coding/usage`,
      ),
    );

    const end = ctx.now;
    const start = new Date(end.getTime() - 7 * 86_400_000);
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const modelParams = new URLSearchParams({
      startTime: fmt(start),
      endTime: fmt(end),
      ...(team ? { type: "3" } : {}),
    });
    polls.push(
      await tryPoll(
        fetchPoll(ctx, {
          endpoint: "model-usage",
          url: `${base}/api/monitor/usage/model-usage?${modelParams.toString()}`,
          headers,
          optional: true,
        }),
        "model-usage",
        `${base}/api/monitor/usage/model-usage`,
      ),
    );
    polls.push(
      await tryPoll(
        fetchPoll(ctx, { endpoint: "balance", url: `${base}/api/paas/v4/balance`, headers, optional: true }),
        "balance",
        `${base}/api/paas/v4/balance`,
      ),
    );
    return polls;
  },

  normalize(polls, capturedAt) {
    const quota = polls.find((p) => p.endpoint === "quota-limit" && p.status === 200);
    const codingBody = polls.find((p) => p.endpoint === "coding-usage" && p.status === 200);
    const codingUsable =
      codingBody !== undefined &&
      (codingBody.json as { success?: boolean; code?: number } | null)?.success !== false &&
      ((codingBody.json as { code?: number } | null)?.code ?? 200) < 400;

    const points: UsagePoint[] = [];
    const push = (fields: Partial<UsagePoint>, label: string, kind: UsagePoint["kind"], unit: UsagePoint["unit"]) =>
      points.push(blankPoint(capturedAt, label, kind, unit, fields));

    if (quota) {
      const data = dataOf(quota.json, "zai quota-limit");
      const limits = asRecordArray(data.limits);
      for (const l of limits) {
        const type = String(l.type ?? "");
        if (type !== "TOKENS_LIMIT" && type !== "CREDIT_LIMIT" && type !== "TIME_LIMIT") continue;

        const total = num(l.usage); // 'usage' is the window TOTAL (CodexBar semantics)
        const remaining = num(l.remaining);
        const current = num(l.currentValue);
        let used: number | null = null;
        if (total !== null && remaining !== null) {
          used = Math.max(total - remaining, current ?? total - remaining);
        } else if (current !== null) {
          used = current;
        }
        const percentage = num(l.percentage);
        if (used === null && remaining === null && total === null && percentage === null) continue;

        const unit = num(l.unit);
        const number = num(l.number);
        const perUnitMinutes = unit !== null ? (UNIT_MINUTES[unit] ?? null) : null;
        const totalMinutes = perUnitMinutes !== null && number !== null ? perUnitMinutes * number : null;
        const windowMs = totalMinutes !== null ? totalMinutes * 60_000 : null;

        let label: string;
        let pointUnit: UsagePoint["unit"];
        if (type === "TIME_LIMIT") {
          label = "mcp";
          pointUnit = "requests";
        } else if (totalMinutes === 300) {
          label = "coding-5h";
          pointUnit = "tokens";
        } else if (windowMs !== null && windowMs > 27 * 86_400_000 && windowMs < 33 * 86_400_000) {
          label = "monthly";
          pointUnit = type === "CREDIT_LIMIT" ? "credits" : "tokens";
        } else {
          label = `${type === "CREDIT_LIMIT" ? "credit" : "token"}-${totalMinutes ?? "?"}m`;
          pointUnit = type === "CREDIT_LIMIT" ? "credits" : "tokens";
        }

        let reset_at = toIsoReset(l.nextResetTime);
        let stale = false;
        if (reset_at !== null && totalMinutes === 300) {
          const delta = Date.parse(reset_at) - Date.parse(capturedAt);
          if (Number.isFinite(delta) && delta > 6 * 3600_000) {
            reset_at = null; // bogus reset for a 5h window
            stale = true;
          }
        }
        const quotaWindow = label === "coding-5h" ? "five_hour" : label === "monthly" ? "monthly" : label === "mcp" ? "mcp" : null;
        const usedPercent = percentage !== null
          ? percentage
          : used !== null && total !== null && total > 0
            ? (used / total) * 100
            : null;

        if (used !== null || remaining !== null || total !== null) {
          push({
            used,
            limit: total,
            remaining,
            reset_at,
            quota_window: quotaWindow,
            source: quotaWindow ? "zai-api" : null,
            stale,
            used_percent: usedPercent,
          }, label, "quota", pointUnit);
        } else if (percentage !== null) {
          // Percentage-only window (observed for the 5h token window on lite plans).
          push({
            used: percentage,
            limit: 100,
            reset_at,
            quota_window: quotaWindow,
            source: "zai-api",
            stale,
            used_percent: percentage,
          }, label, "quota", "percent");
        }

        for (const d of asRecordArray(l.usageDetails)) {
          const model = typeof d.modelCode === "string" ? d.modelCode : null;
          const usedTokens = num(d.usage);
          if (model && usedTokens !== null) push({ used: usedTokens, model }, "coding-window-by-model", "usage", "tokens");
        }
      }
    } else if (codingUsable) {
      // Fallback when quota-limit fails (or the key only works with /api/coding/usage).
      const windows: Array<[string[], string]> = [
        [["token_window", "tokenWindow"], "token-window"],
        [["daily", "day"], "coding-5h"],
        [["monthly", "month", "subscription"], "monthly"],
      ];
      const obj = dataOf(codingBody.json, "zai coding-usage");
      for (const [keys, label] of windows) {
        const w = keys.map((k) => obj[k]).find((v) => v !== undefined && v !== null) as
          | Record<string, unknown>
          | undefined;
        if (!w) continue;
        const used = num(w.used ?? w.used_percent ?? w.utilization);
        const remaining = num(w.remaining ?? w.remain ?? w.left);
        const total = num(w.total ?? w.limit ?? w.quota);
        if (used === null && remaining === null && total === null) continue;
        const quotaWindow = label === "coding-5h" ? "five_hour" : label === "monthly" ? "monthly" : label === "token-window" ? "token_window" : null;
        const usedPercent = used !== null && total !== null && total > 0 ? (used / total) * 100 : null;
        push({
          used,
          limit: total,
          remaining,
          quota_window: quotaWindow,
          source: quotaWindow ? "zai-api" : null,
          used_percent: usedPercent,
        }, label, "quota", "tokens");
      }
      if (points.length === 0) throw new NormalizeError("zai coding-usage: no recognizable windows");
    }

    const modelUsage = polls.find((p) => p.endpoint === "model-usage" && p.status === 200);
    if (modelUsage) {
      const data = dataOf(modelUsage.json, "zai model-usage");
      const xTime = Array.isArray(data.x_time) ? (data.x_time as unknown[]) : [];
      for (const m of asRecordArray(data.modelDataList)) {
        const modelName = typeof m.modelName === "string" ? m.modelName : null;
        const tokens = Array.isArray(m.tokensUsage) ? (m.tokensUsage as unknown[]) : [];
        if (!modelName) continue;
        // x_time is hourly in the wild — aggregate buckets into daily totals per model.
        const perDay = new Map<string, number>();
        for (let i = 0; i < Math.min(xTime.length, tokens.length); i++) {
          const used = num(tokens[i]);
          const day = parseDayLabel(String(xTime[i] ?? ""));
          if (used === null || day === null) continue;
          perDay.set(day, (perDay.get(day) ?? 0) + used);
        }
        for (const [day, used] of perDay) {
          push({ used, day, model: modelName }, "model-daily", "usage", "tokens");
        }
      }
    }

    const balance = polls.find((p) => p.endpoint === "balance" && p.status === 200);
    if (balance) {
      const data = dataOf(balance.json, "zai balance");
      const total = num(data.total_balance);
      const available = num(data.available_balance);
      const currency = typeof data.currency === "string" ? data.currency : "";
      const unit: UsagePoint["unit"] = currency.toUpperCase() === "CNY" ? "cny" : "usd";
      const used = total !== null && available !== null ? Math.max(0, total - available) : null;
      push({ used, limit: total, remaining: available }, "payg-balance", "balance", unit);
    }

    // Degrade gracefully: any single endpoint failing is fine, but an empty result is loud.
    if (points.length === 0) {
      throw new NormalizeError("zai: no usable data (quota-limit and coding-usage both unavailable)");
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
    provider: "zai",
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

function dataOf(json: unknown, what: string): Record<string, unknown> {
  const root = (json ?? {}) as Record<string, unknown>;
  const data = root.data;
  if (data !== undefined && data !== null && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  if (typeof root === "object" && Object.keys(root).length > 0) return root;
  throw new NormalizeError(`${what}: unexpected shape (no data object)`);
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((v) => v !== null && typeof v === "object") : [];
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function parseDayLabel(label: string): string | null {
  const full = /^(\d{4})-(\d{2})-(\d{2})/.exec(label);
  if (full) return `${full[1]}-${full[2]}-${full[3]}`;
  const short = /^(\d{2})-(\d{2})$/.exec(label.trim());
  if (short) return `${new Date().getFullYear()}-${short[1]}-${short[2]}`;
  const parsed = Date.parse(label);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return null;
}

// Observed as epoch-ms numbers in the wild; community tools saw ISO strings. Accept both.
function toIsoReset(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 1e12) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d{13,}$/.test(trimmed)) return new Date(Number(trimmed)).toISOString();
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

// Network errors on optional polls must not fail the run — synthesize a failed optional poll.
async function tryPoll(p: Promise<RawPoll>, endpoint: string, url: string): Promise<RawPoll> {
  try {
    return await p;
  } catch (err) {
    return {
      endpoint,
      url,
      status: 0,
      body: (err as Error).message,
      json: null,
      headers: {},
      optional: true,
    };
  }
}
