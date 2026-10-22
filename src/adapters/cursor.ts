import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SubscriptionFacts, SubscriptionState } from "../subscriptions";
import { fetchPoll } from "./types";
import type { Adapter, CollectContext, ProviderNote, RawPoll, UsagePoint } from "./types";

/**
 * Cursor — stability tier 2: undocumented endpoint, and the session token is read from Cursor's
 * own local storage (`state.vscdb`), the same source CodexBar and ccursor use.
 *
 * `GET https://api2.cursor.sh/auth/full_stripe_profile` (Bearer from `cursorAuth/accessToken`)
 * verified 2026-10-22 answers with plan and billing state only:
 *   { membershipType: "pro", subscriptionStatus: "active", isYearlyPlan: false,
 *     pendingCancellationDate: null, … }
 * `GET /auth/usage-summary` (same bearer) answers the included usage for the current billing
 * cycle and the cycle's end, which is the only usage Cursor exposes to this token; it reports no
 * five-hour window and no weekly figure. Price and charge date stay in subscriptions.toml.
 */

export const CURSOR_PROFILE_URL = "https://api2.cursor.sh/auth/full_stripe_profile";
export const CURSOR_PROFILE_ENDPOINT = "stripe-profile";
export const CURSOR_USAGE_URL = "https://api2.cursor.sh/auth/usage-summary";
export const CURSOR_USAGE_ENDPOINT = "usage-summary";
/** Cursor reports percentages, never a unit for its absolute included figure, so we show the share. */
const PERCENT_FULL = 100;
const ONE_DAY_MS = 86_400_000;
const CURSOR_TOKEN_KEY = "cursorAuth/accessToken";
const CURSOR_POLL_MS = 15 * 60_000;

const PLAN_NAMES: Readonly<Record<string, string>> = {
  pro: "Cursor Pro",
  pro_plus: "Cursor Pro+",
  ultra: "Cursor Ultra",
};

/** Plans that are not a paid subscription: nothing to show on the Subscriptions page. */
const FREE_MEMBERSHIPS = new Set(["free", "", "none"]);

const STATE_BY_CURSOR_STATUS: Readonly<Record<string, SubscriptionState>> = {
  active: "active",
  trialing: "trialing",
  trial: "trialing",
  canceled: "cancelled",
  cancelled: "cancelled",
  past_due: "past_due",
  unpaid: "past_due",
};

/** Cursor keeps its auth in the VS Code storage database; `CURSOR_STATE_DB` overrides the path. */
export function cursorStatePath(env: Record<string, string | undefined>): string {
  const override = env.CURSOR_STATE_DB?.trim();
  if (override !== undefined && override !== "") return override;
  return join(homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
}

/**
 * Read the Cursor access token from `state.vscdb`. Opened read-only and closed again; the token
 * is returned to the caller and never logged or archived.
 */
export function readCursorAccessToken(statePath: string): string | null {
  if (!existsSync(statePath)) return null;
  let db: Database | null = null;
  try {
    db = new Database(statePath, { readonly: true });
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(CURSOR_TOKEN_KEY) as
      | { value: string | null }
      | null;
    const token = row?.value?.trim() ?? "";
    return token === "" ? null : token;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** Plan facts from `full_stripe_profile`; null when Cursor reports no paid plan. */
export function cursorFactsFromProfile(json: unknown): SubscriptionFacts | null {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return null;
  const root = json as Record<string, unknown>;
  const membership = typeof root.membershipType === "string" ? root.membershipType.trim().toLowerCase() : "";
  const status = typeof root.subscriptionStatus === "string" ? root.subscriptionStatus.trim().toLowerCase() : null;
  const state = status === null ? "unknown" : (STATE_BY_CURSOR_STATUS[status] ?? "unknown");
  if (FREE_MEMBERSHIPS.has(membership) && state !== "active" && state !== "trialing") return null;
  return {
    provider: "cursor",
    planId: FREE_MEMBERSHIPS.has(membership) ? null : membership,
    planName: PLAN_NAMES[membership] ?? null,
    state,
    period: root.isYearlyPlan === true ? "annual" : root.isYearlyPlan === false ? "monthly" : null,
    renewsAt: null,
    seats: root.isTeamMember === true ? null : 1,
    source: "cursor-api",
  };
}

/**
 * The billing cycle Cursor meters on, as a quota point. `totalPercentUsed` is reported directly, so
 * the absolute `limit` (an undocumented unit) never has to be interpreted.
 */
export function cursorUsagePoint(json: unknown, capturedAt: string): UsagePoint | null {
  const plan = planOf(json);
  const root = asObject(json);
  const percent = numberOf(plan.totalPercentUsed);
  const windowStart = isoOf(root.billingCycleStart);
  const resetAt = isoOf(root.billingCycleEnd);
  if (percent === null && resetAt === null) return null;
  return {
    provider: "cursor",
    kind: "quota",
    label: "cursor-plan-usage",
    model: null,
    used: percent,
    limit: PERCENT_FULL,
    remaining: percent === null ? null : Math.max(PERCENT_FULL - percent, 0),
    unit: "percent",
    window_start: windowStart,
    window_end: resetAt,
    reset_at: resetAt,
    day: null,
    requests: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    captured_at: capturedAt,
    source: "cursor-api",
    quota_window: cadenceOf(windowStart, resetAt),
    stale: false,
  };
}

/** `individualUsage.plan`, where the included usage lives; an empty object when absent. */
function planOf(json: unknown): Record<string, unknown> {
  const individual = asObject(asObject(json).individualUsage);
  return asObject(individual.plan);
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isoOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** Name the cycle length when it is a calendar month or year, so the card says what it meters. */
function cadenceOf(start: string | null, end: string | null): string | null {
  if (start === null || end === null) return null;
  const days = (Date.parse(end) - Date.parse(start)) / ONE_DAY_MS;
  if (days >= 27 && days <= 33) return "monthly";
  if (days >= 360 && days <= 370) return "annual";
  return null;
}

async function pollWithToken(
  ctx: CollectContext,
  endpoint: string,
  url: string,
  token: string,
): Promise<RawPoll> {
  try {
    return await fetchPoll(ctx, {
      endpoint,
      url,
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      optional: true,
    });
  } catch (err) {
    const message = (err as Error).message;
    ctx.log(`cursor: ${endpoint} request failed (${message})`);
    return { endpoint, url, status: 0, body: message, json: null, headers: {}, optional: true };
  }
}

function tokenMissingPoll(statePath: string): RawPoll {
  return {
    endpoint: "access-token",
    url: `file://${statePath}`,
    status: 0,
    body: "no Cursor access token in state.vscdb (sign in to Cursor)",
    json: null,
    headers: {},
    optional: true,
  };
}

export const cursorAdapter: Adapter = {
  id: "cursor",
  stabilityTier: 2,
  pollEveryMs: CURSOR_POLL_MS,

  isConfigured(env) {
    return existsSync(cursorStatePath(env));
  },
  missingCredentials(env) {
    const path = cursorStatePath(env);
    return existsSync(path) ? [] : ["Cursor (sign in, then set CURSOR_STATE_DB if it is not in the default location)"];
  },

  notes: [
    {
      title: "Metered per billing cycle, not per five hours",
      text: "usage-summary reports the included usage for the current billing cycle and when that cycle ends, which is the reset shown above. Cursor states no five-hour window and no weekly figure to this token, so the card does not invent one. Price and renewal day come from subscriptions.toml.",
    },
    {
      title: "Where the token comes from",
      text: "The access token is read read-only from Cursor's own state database (state.vscdb, key cursorAuth/accessToken) — the same source CodexBar uses. It is sent only to api2.cursor.sh, never logged, and never written back; signing out of Cursor therefore stops the poll.",
    },
  ] satisfies ProviderNote[],

  async collect(ctx: CollectContext) {
    const statePath = cursorStatePath(ctx.env);
    const token = readCursorAccessToken(statePath);
    if (token === null) return [tokenMissingPoll(statePath)];
    return Promise.all([
      pollWithToken(ctx, CURSOR_PROFILE_ENDPOINT, CURSOR_PROFILE_URL, token),
      pollWithToken(ctx, CURSOR_USAGE_ENDPOINT, CURSOR_USAGE_URL, token),
    ]);
  },

  /** The included usage for the current billing cycle, when that poll succeeded. */
  normalize(polls, capturedAt) {
    const usage = polls.find((p) => p.endpoint === CURSOR_USAGE_ENDPOINT && p.status === 200);
    if (usage === undefined) return [];
    const point = cursorUsagePoint(usage.json, capturedAt);
    return point === null ? [] : [point];
  },

  subscriptionFacts(polls) {
    const poll = polls.find((p) => p.endpoint === CURSOR_PROFILE_ENDPOINT && p.status === 200);
    return poll === undefined ? null : cursorFactsFromProfile(poll.json);
  },
};
