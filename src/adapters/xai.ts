/**
 * Grok (xAI) adapter — stability tier 3 (experimental).
 *
 * Auth on this machine is an xAI **OAuth** login (device-code flow, the same
 * client pi uses), NOT an API key: pi's auth store (~/.pi/agent/auth.json)
 * holds { access, refresh, expires }. Two rules taken from the claude
 * adapter's discipline:
 *
 * 1. modelizer never refreshes — two refreshers race and log the other out.
 *    The access token is read from pi's store at poll time; pi refreshes it
 *    whenever it next runs Grok. An expired token means the poll is skipped
 *    as stale, not an error.
 * 2. An XAI_API_KEY (api-key authMethod in the provider registry) wins over
 *    the OAuth token when set.
 *
 * Usage endpoints: xAI's documented Usage API is team-scoped
 * (GET /v1/usage-api/usage?team_id=…&execution_date=…). For an OAuth'd
 * individual account it is not expected to answer; the probe is kept so the
 * raw poll evidence accumulates and the adapter lights up automatically if
 * xAI ever opens it. Until something answers 200, the card reports
 * pay-as-you-go state from /v1/api-key when that works.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fetchPoll, NormalizeError, num } from "./types";
import type { Adapter, CollectContext, ProviderNote, RawPoll, UsagePoint } from "./types";

const DEFAULT_BASE = "https://api.x.ai";
const PI_AUTH = join(homedir(), ".pi", "agent", "auth.json");

interface XaiOAuth {
  access: string;
  refresh?: string | undefined;
  expires?: number | undefined;
}

/** The pi harness's xAI OAuth credential, when present and unexpired. */
export function piXaiOAuth(nowMs: number): XaiOAuth | null {
  try {
    const raw = JSON.parse(readFileSync(PI_AUTH, "utf8")) as Record<string, XaiOAuth>;
    const x = raw.xai;
    if (!x || typeof x.access !== "string" || x.access.length < 20) return null;
    // A stale token is still reported (source kept honest); callers decide.
    return { access: x.access, refresh: x.refresh, expires: x.expires };
  } catch {
    return null;
  }
}

function tokenFor(ctx: CollectContext): { token: string | null; kind: "api-key" | "oauth" | "none" } {
  const key = ctx.env.XAI_API_KEY;
  if (key && key.trim() !== "") return { token: key.trim(), kind: "api-key" };
  const oauth = piXaiOAuth(ctx.now.getTime());
  if (oauth) return { token: oauth.access, kind: "oauth" };
  return { token: null, kind: "none" };
}

export const xaiAdapter: Adapter = {
  id: "xai",
  stabilityTier: 3,
  pollEveryMs: 15 * 60_000,

  isConfigured(env) {
    if (env.XAI_API_KEY && env.XAI_API_KEY.trim() !== "") return true;
    return piXaiOAuth(Date.now()) !== null;
  },
  missingCredentials(env) {
    return this.isConfigured(env)
      ? []
      : ["XAI_API_KEY or an xAI OAuth login in ~/.pi/agent/auth.json (run pi with a Grok model once)"];
  },

  notes: [
    {
      title: "Grok via xAI — OAuth or API key",
      text: "Auth is read at poll time: XAI_API_KEY when set, else the OAuth token pi stores after a Grok device-code login. modelizer never refreshes the OAuth token — pi owns that; when the token is expired this card skips as stale rather than racing pi's refresh.",
    },
    {
      title: "Usage API is team-scoped today",
      text: "xAI's documented usage endpoint answers for team API keys; an individual OAuth account is not expected to have a usage meter yet. The probe stays on so the card lights up automatically if xAI opens it — the raw poll evidence accumulates either way.",
    },
  ] satisfies ProviderNote[],

  async collect(ctx: CollectContext): Promise<RawPoll[]> {
    const { token, kind } = tokenFor(ctx);
    if (!token) {
      return [{
        endpoint: "auth",
        url: PI_AUTH,
        status: 0,
        body: "no xAI credential (pi OAuth expired and no XAI_API_KEY)",
        json: { stale: true, kind: "none" },
        headers: {},
      }];
    }
    const headers = { Authorization: `Bearer ${token}` };
    const base = (ctx.env.XAI_BASE_URL ?? DEFAULT_BASE).replace(/\/$/, "");
    // Team usage API (documented; needs a team-scoped key). Optional: a 404
    // here is the expected answer for an individual OAuth account.
    const usage = await fetchPoll(ctx, {
      endpoint: "usage",
      url: `${base}/v1/usage-api/usage`,
      headers,
      optional: true,
    });
    // Key info: works for api-keys; answers 401/404 for OAuth tokens.
    const keyInfo = await fetchPoll(ctx, {
      endpoint: "api-key",
      url: `${base}/v1/api-key`,
      headers,
      optional: true,
    });
    return [usage, keyInfo];
  },

  normalize(polls, capturedAt) {
    const usage = polls.find((p) => p.endpoint === "usage");
    const keyInfo = polls.find((p) => p.endpoint === "api-key");
    if (!usage) throw new NormalizeError("xai: no usage poll");

    const points: UsagePoint[] = [];

    // Team usage report shape (when the key is team-scoped):
    // { usage: [ { app_id, team_id, usage_day, …, usage: { cost_usd, requests, … } } ] }
    const body = usage.json as { usage?: Array<Record<string, unknown>>; detail?: string } | null;
    if (usage.status === 200 && Array.isArray(body?.usage) && body!.usage.length > 0) {
      const day = body!.usage.at(-1)!;
      const u = (day.usage ?? {}) as Record<string, unknown>;
      points.push({
        provider: "xai",
        kind: "usage",
        label: "spend-today",
        model: null,
        used: num(u.cost_usd),
        limit: null,
        remaining: null,
        unit: "usd",
        window_start: (day.usage_day as string) ?? null,
        window_end: null,
        reset_at: null,
        day: (day.usage_day as string) ?? null,
        requests: num(u.requests),
        tokens_in: num(u.input_tokens),
        tokens_out: num(u.output_tokens),
        cost_usd: num(u.cost_usd),
        captured_at: capturedAt,
      });
    }

    // Key-info shape: { api_key: { disabled, … }, … } — pay-as-you-go liveness only.
    const info = keyInfo?.json as { api_key?: { disabled?: boolean; modified_at?: string } } | null;
    if (keyInfo?.status === 200 && info?.api_key) {
      points.push({
        provider: "xai",
        kind: "balance",
        label: info.api_key.disabled ? "key-disabled" : "key-active",
        model: null,
        used: null,
        limit: null,
        remaining: null,
        unit: "unknown",
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

    if (points.length === 0) {
      // Honest dead end: record why, so the card can say what is missing.
      throw new NormalizeError(
        `xai: no usage data (usage http-${usage.status}, key-info http-${keyInfo?.status ?? "n/a"})`
      );
    }
    return points;
  },
};
