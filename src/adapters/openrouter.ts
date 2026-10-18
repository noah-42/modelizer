import { fetchPoll, NormalizeError, num } from "./types";
import type { Adapter, CollectContext, ProviderNote, RawPoll, UsagePoint } from "./types";

const DEFAULT_BASE = "https://openrouter.ai";

/**
 * Shapes verified against openrouter.ai/docs/api-reference on 2026-10-03.
 * /api/v1/key        → { data: { usage, usage_daily, usage_weekly, usage_monthly, limit, limit_remaining, limit_reset, free_model_daily_requests: { used, limit, remaining } } }
 * /api/v1/credits    → { data: { total_credits, total_usage } }   (management key)
 * /api/v1/activity   → { data: [ { date, model, usage (USD credits), requests, prompt_tokens,
 *                          completion_tokens, reasoning_tokens, cached_tokens, ... } ] }
 *                      last 30 completed UTC days, daily per-model aggregates (management key)
 */
export const openRouterAdapter: Adapter = {
  id: "openrouter",
  stabilityTier: 1,
  pollEveryMs: 15 * 60_000,

  isConfigured(env) {
    return Boolean(env.OPENROUTER_API_KEY);
  },
  missingCredentials(env) {
    return env.OPENROUTER_API_KEY ? [] : ["OPENROUTER_API_KEY"];
  },

  statusHints(env) {
    if (env.OPENROUTER_MANAGEMENT_KEY) return [];
    return [
      {
        label: "hint",
        state: "add OPENROUTER_MANAGEMENT_KEY to unlock account credits + per-model spend",
        tone: "muted",
      },
    ];
  },

  notes: [
    {
      title: "Pay-as-you-go, per-token USD",
      text: "Every model bills per token at its listed rate (openrouter.ai/models — prices are quoted per 1M tokens, so 1 token = rate ÷ 1,000,000). No subscription quota: spend is capped only by credits and any per-key limit you set.",
    },
    {
      title: "This card tracks this key only",
      text: "The spend rows come from the key endpoint, so a fresh key reads $0 even if you spend via other keys. Add a management key (OPENROUTER_MANAGEMENT_KEY) to see account-wide credits and per-model activity.",
    },
  ] satisfies ProviderNote[],

  async collect(ctx: CollectContext): Promise<RawPoll[]> {
    const base = (ctx.env.OPENROUTER_BASE_URL ?? DEFAULT_BASE).replace(/\/$/, "");
    const polls = [
      await fetchPoll(ctx, {
        endpoint: "key",
        url: `${base}/api/v1/key`,
        headers: { Authorization: `Bearer ${ctx.env.OPENROUTER_API_KEY}` },
      }),
    ];
    if (ctx.env.OPENROUTER_MANAGEMENT_KEY) {
      const mgmtHeaders = { Authorization: `Bearer ${ctx.env.OPENROUTER_MANAGEMENT_KEY}` };
      polls.push(
        await fetchPoll(ctx, {
          endpoint: "credits",
          url: `${base}/api/v1/credits`,
          headers: mgmtHeaders,
          optional: true,
        }),
      );
      polls.push(
        await fetchPoll(ctx, {
          endpoint: "activity",
          url: `${base}/api/v1/activity`,
          headers: mgmtHeaders,
          optional: true,
        }),
      );
    }
    return polls;
  },

  normalize(polls, capturedAt) {
    const points: UsagePoint[] = [];
    const keyPoll = polls.find((p) => p.endpoint === "key");
    if (keyPoll) {
      const data = (keyPoll.json as { data?: Record<string, unknown> } | null)?.data;
      if (!data) throw new NormalizeError("openrouter /api/v1/key: unexpected shape (no .data)");
      const p = (fields: Partial<UsagePoint>, label: string, kind: UsagePoint["kind"], unit: UsagePoint["unit"]) =>
        points.push({
          provider: "openrouter",
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
        });

      const limit = num(data.limit);
      if (limit !== null) {
        p(
          {
            used: num(data.usage),
            limit,
            remaining: num(data.limit_remaining),
            reset_at: typeof data.limit_reset === "string" ? data.limit_reset : null,
          },
          "key-spend-limit",
          "quota",
          "usd",
        );
      } else {
        p({ used: num(data.usage) }, "key-lifetime-spend", "usage", "usd");
      }

      const windows: Array<[string, string]> = [
        ["usage_daily", "spend-daily"],
        ["usage_weekly", "spend-weekly"],
        ["usage_monthly", "spend-monthly"],
      ];
      for (const [field, label] of windows) {
        const used = num(data[field]);
        if (used !== null) p({ used }, label, "quota", "usd");
      }

      const free = data.free_model_daily_requests as Record<string, unknown> | undefined;
      if (free && num(free.limit) !== null) {
        p(
          { used: num(free.used), limit: num(free.limit), remaining: num(free.remaining) },
          "free-model-requests-daily",
          "quota",
          "requests",
        );
      }
    }

    const creditsPoll = polls.find((p) => p.endpoint === "credits" && p.status === 200);
    if (creditsPoll) {
      const data = (creditsPoll.json as { data?: Record<string, unknown> } | null)?.data;
      if (!data) throw new NormalizeError("openrouter /api/v1/credits: unexpected shape (no .data)");
      const total = num(data.total_credits);
      const used = num(data.total_usage);
      const remaining = total !== null && used !== null ? total - used : null;
      points.push({
        provider: "openrouter",
        kind: "balance",
        label: "credits",
        model: null,
        used,
        limit: total,
        remaining,
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
      });
    }

    const activityPoll = polls.find((p) => p.endpoint === "activity" && p.status === 200);
    if (activityPoll) {
      const rows = (activityPoll.json as { data?: unknown } | null)?.data;
      if (!Array.isArray(rows)) {
        throw new NormalizeError("openrouter /api/v1/activity: unexpected shape (no data array)");
      }
      for (const row of rows) {
        const r = row as Record<string, unknown>;
        const model = typeof r.model === "string" ? r.model : null;
        const day = typeof r.date === "string" ? r.date : null;
        const usage = num(r.usage);
        if (model === null || day === null || usage === null) continue;
        points.push({
          provider: "openrouter",
          kind: "usage",
          label: "model-spend",
          model,
          used: usage,
          limit: null,
          remaining: null,
          unit: "usd",
          window_start: null,
          window_end: null,
          reset_at: null,
          day,
          requests: num(r.requests),
          tokens_in: num(r.prompt_tokens),
          tokens_out: num(r.completion_tokens),
          cost_usd: usage,
          captured_at: capturedAt,
        });
      }
    }

    return points;
  },
};
