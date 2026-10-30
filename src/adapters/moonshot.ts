import { fetchPoll, NormalizeError, num } from "./types";
import type { Adapter, CollectContext, ProviderNote, RawPoll, UsagePoint } from "./types";

const DEFAULT_BASE = "https://api.moonshot.ai";

/**
 * Shapes verified against api.moonshot.ai / api.moonshot.cn on 2026-10-30: both hosts authenticate
 * `/v1/users/me/balance` (401 for a bad key, not 404), the account-balance endpoint documented at
 * platform.moonshot.ai/docs. The documented success body is
 * `{ code: 0, data: { available_balance, voucher_balance, total_granted, total_used, … } }` with
 * the amounts as strings. The .cn platform bills in CNY; the .ai one in USD.
 */
export const moonshotAdapter: Adapter = {
  id: "moonshot",
  stabilityTier: 1,
  pollEveryMs: 15 * 60_000,

  isConfigured(env) {
    return Boolean(env.MOONSHOT_API_KEY);
  },
  missingCredentials(env) {
    return env.MOONSHOT_API_KEY ? [] : ["MOONSHOT_API_KEY"];
  },

  notes: [
    {
      title: "Pay-as-you-go, per-token",
      text: "Moonshot bills per token at the rate listed per model (platform.moonshot.ai/docs/pricing). No subscription quota: spend is capped only by the account balance (plus any voucher credit).",
    },
    {
      title: "Kimi models, Moonshot account",
      text: "Kimi is Moonshot's model family; usage and balance here are account-wide for your API key, not per model. Model → provider mapping lives in models.toml.",
    },
    {
      title: "Currency follows the host",
      text: "api.moonshot.cn is billed in CNY, api.moonshot.ai in USD — set MOONSHOT_BASE_URL to the platform you hold the key on and this card tracks that currency.",
    },
  ] satisfies ProviderNote[],

  async collect(ctx: CollectContext): Promise<RawPoll[]> {
    const base = (ctx.env.MOONSHOT_BASE_URL ?? DEFAULT_BASE).replace(/\/$/, "");
    return [
      await fetchPoll(ctx, {
        endpoint: "balance",
        url: `${base}/v1/users/me/balance`,
        headers: { Authorization: `Bearer ${ctx.env.MOONSHOT_API_KEY}` },
      }),
    ];
  },

  normalize(polls, capturedAt) {
    const poll = polls.find((p) => p.endpoint === "balance");
    if (!poll) throw new NormalizeError("moonshot: no balance poll");
    const data = (poll.json as { data?: Record<string, unknown>; code?: unknown } | null)?.data;
    if (!data) throw new NormalizeError("moonshot /v1/users/me/balance: unexpected shape (no .data)");
    const code = num(poll.json && (poll.json as { code?: unknown }).code);
    if (code !== null && code !== 0) {
      throw new NormalizeError(`moonshot /v1/users/me/balance: error code ${code}`);
    }

    // The .cn platform bills in CNY, the global .ai one in USD.
    const currency: UsagePoint["unit"] = /moonshot\.cn/.test(poll.url) ? "cny" : "usd";
    const granted = num(data.total_granted);
    const used = num(data.total_used);

    return [
      {
        provider: "moonshot",
        kind: "balance",
        label: "balance",
        model: null,
        used,
        limit: granted,
        remaining: num(data.available_balance),
        unit: currency,
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
      {
        provider: "moonshot",
        kind: "balance",
        label: "voucher-credit",
        model: null,
        used: null,
        limit: null,
        remaining: num(data.voucher_balance),
        unit: currency,
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
    ];
  },
};
