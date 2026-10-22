import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SubscriptionFacts, SubscriptionState } from "../subscriptions";
import { fetchPoll } from "./types";
import type { Adapter, CollectContext, ProviderNote, RawPoll } from "./types";

/**
 * Cursor — stability tier 2: undocumented endpoint, and the session token is read from Cursor's
 * own local storage (`state.vscdb`), the same source CodexBar and ccursor use.
 *
 * `GET https://api2.cursor.sh/auth/full_stripe_profile` (Bearer from `cursorAuth/accessToken`)
 * verified 2026-10-22 answers with plan and billing state only:
 *   { membershipType: "pro", subscriptionStatus: "active", isYearlyPlan: false,
 *     pendingCancellationDate: null, … }
 * No usage, no price, no charge date: `/api/usage-summary` wants a web cookie session (401 with
 * this token), and `/auth/stripe_profile` answers a bare `false`. So this adapter contributes
 * subscription facts and no usage points — the dashboard card points at the Subscriptions page.
 */

export const CURSOR_PROFILE_URL = "https://api2.cursor.sh/auth/full_stripe_profile";
export const CURSOR_PROFILE_ENDPOINT = "stripe-profile";
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
      title: "Plan only — usage needs a browser session",
      text: "Cursor's API states the plan and billing status for the signed-in user, which is what the Subscriptions page shows. Request counts, token spend and the charge date are not in that response: /api/usage-summary only answers a cursor.com cookie session, so nothing here scrapes the dashboard. Price and renewal day come from subscriptions.toml.",
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
    try {
      const poll = await fetchPoll(ctx, {
        endpoint: CURSOR_PROFILE_ENDPOINT,
        url: CURSOR_PROFILE_URL,
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        optional: true,
      });
      return [poll];
    } catch (err) {
      const message = (err as Error).message;
      ctx.log(`cursor: stripe profile request failed (${message})`);
      return [
        {
          endpoint: CURSOR_PROFILE_ENDPOINT,
          url: CURSOR_PROFILE_URL,
          status: 0,
          body: message,
          json: null,
          headers: {},
          optional: true,
        },
      ];
    }
  },

  /** No usage numbers are available, so the plan facts are the whole contribution. */
  normalize() {
    return [];
  },

  subscriptionFacts(polls) {
    const poll = polls.find((p) => p.endpoint === CURSOR_PROFILE_ENDPOINT && p.status === 200);
    return poll === undefined ? null : cursorFactsFromProfile(poll.json);
  },
};
