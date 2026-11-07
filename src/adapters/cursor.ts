import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import type { SecurityRunner } from "../secrets";
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
 * `POST /aiserver.v1.DashboardService/GetCurrentPeriodUsage` (same bearer, Connect JSON) is what
 * the Cursor app itself reads: the included usage for the current period, that period's start and
 * reset, and the percentage Cursor shows you ("You've used 90% of your included usage"). The
 * period is weekly on this plan, so the card's front line is the weekly budget.
 *
 * `/auth/usage-summary` also answers, but it reports a different, empty bucket (the calendar-month
 * API allowance, 0 of 4,615), so it is not what gates the week. Price and charge date stay in
 * subscriptions.toml.
 */

export const CURSOR_PROFILE_URL = "https://api2.cursor.sh/auth/full_stripe_profile";

/** Production origins — provenance mode `real` is proven only against these. */
export const CURSOR_ORIGINS = ["https://api2.cursor.sh"] as const;
export const CURSOR_PROFILE_ENDPOINT = "stripe-profile";
export const CURSOR_PERIOD_URL =
  "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
export const CURSOR_PERIOD_ENDPOINT = "period-usage";
/** A Connect call needs a body even when the request has no fields. */
const CONNECT_EMPTY_BODY = "{}";
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

/** Cursor's at-rest encryption envelope (observed 2026-10-31): token is ciphertext, not a bearer. */
export const CURSOR_ENCRYPTED_TOKEN_PREFIX = "cursor-safe-storage:";

/**
 * Cursor wraps the Chromium os_crypt envelope: `cursor-safe-storage:v1:` plus base64 of the
 * macOS blob (`v10`/`v11` header, AES-128-CBC, PKCS7). The wrapping key is PBKDF2-SHA1 of the
 * `Cursor Safe Storage` keychain password over Chromium's fixed salt — the same derivation the
 * app itself performs, so no Cursor state is written and the keychain read is read-only.
 * Verified live 2026-11-02: the decrypted token answers both api2.cursor.sh poll endpoints.
 */
export const CURSOR_SAFE_STORAGE_SERVICE = "Cursor Safe Storage";
export const CURSOR_SAFE_STORAGE_ACCOUNT = "Cursor Key";
const CHROMIUM_SALT = "saltysalt";
const CHROMIUM_ITERATIONS = 1003;
const CHROMIUM_KEY_BYTES = 16;
const CHROMIUM_IV = Buffer.alloc(16, 0x20);

/** Decrypt a `cursor-safe-storage:v1:` envelope; null when the shape, password or padding is wrong. */
export function decryptCursorToken(envelope: string, safeStoragePassword: string): string | null {
  const match = /^cursor-safe-storage:v1:([A-Za-z0-9+/=]+)$/.exec(envelope.trim());
  if (match === null) return null;
  let blob: Buffer;
  try {
    blob = Buffer.from(match[1] ?? "", "base64");
  } catch {
    return null;
  }
  // The inner blob begins with a version tag ("v10" today); a wrong password usually fails the
  // PKCS7 final() step, and a lucky decrypt still cannot look like a token.
  if (blob.length < 19 || !/^v1[0-9]/.test(blob.toString("latin1"))) return null;
  const key = crypto.pbkdf2Sync(safeStoragePassword, CHROMIUM_SALT, CHROMIUM_ITERATIONS, CHROMIUM_KEY_BYTES, "sha1");
  try {
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, CHROMIUM_IV);
    const plain = Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]);
    const token = plain.toString("utf8");
    // A bearer token is printable ASCII and long; anything else is a failed decrypt.
    return token.length >= 20 && /^[\x21-\x7e]+$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** The Cursor Safe Storage keychain password, or null when the item is absent. Value never logged. */
export function readCursorSafeStoragePassword(run: SecurityRunner = defaultSecurityRun): string | null {
  const res = run(["find-generic-password", "-s", CURSOR_SAFE_STORAGE_SERVICE, "-a", CURSOR_SAFE_STORAGE_ACCOUNT, "-w"]);
  const value = res.status === 0 ? res.stdout.replace(/\n$/, "") : "";
  return value === "" ? null : value;
}

function defaultSecurityRun(args: string[]): { status: number | null; stdout: string } {
  const res = spawnSync("security", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return { status: res.status, stdout: res.stdout ?? "" };
}

/** Raw stored value, whatever its envelope; null when the key is absent or blank. */
function readCursorStoredToken(statePath: string): string | null {
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

/**
 * Read the Cursor access token from `state.vscdb`. Opened read-only and closed again; the token
 * is returned to the caller and never logged or archived. Null when the stored value is the
 * encrypted envelope — it is not a bearer, and sending it only earns a 401.
 */
export function readCursorAccessToken(statePath: string): string | null {
  const raw = readCursorStoredToken(statePath);
  if (raw === null) return null;
  return raw.startsWith(CURSOR_ENCRYPTED_TOKEN_PREFIX) ? null : raw;
}

/** True when Cursor holds the token only in its proprietary encrypted envelope. */
export function cursorTokenIsEncrypted(statePath: string): boolean {
  const raw = readCursorStoredToken(statePath);
  return raw !== null && raw.startsWith(CURSOR_ENCRYPTED_TOKEN_PREFIX);
}

/**
 * The usable bearer: the raw token when Cursor stored plaintext, otherwise the decrypted
 * envelope (the app's own key derivation, read-only keychain). Null when nothing works —
 * the caller decides between "not signed in" and "encrypted but undecryptable".
 */
export function usableCursorToken(statePath: string): string | null {
  const raw = readCursorStoredToken(statePath);
  if (raw === null) return null;
  if (!raw.startsWith(CURSOR_ENCRYPTED_TOKEN_PREFIX)) return raw;
  const password = readCursorSafeStoragePassword();
  return password === null ? null : decryptCursorToken(raw, password);
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
 * The included usage for the current period, as a quota point. Cursor reports the share directly
 * ("You've used 90% of your included usage"), so the point carries the percentage, the period it
 * belongs to and when that period resets — the three things that decide whether you can keep going.
 */
export function cursorPeriodPoint(json: unknown, capturedAt: string): UsagePoint | null {
  const root = asObject(json);
  const plan = asObject(root.planUsage);
  const percent = numberOf(plan.totalPercentUsed);
  const windowStart = isoOfEpoch(root.billingCycleStart);
  const resetAt = isoOfEpoch(root.billingCycleEnd);
  if (percent === null || resetAt === null) return null;
  return {
    provider: "cursor",
    kind: "quota",
    label: "cursor-included-usage",
    model: null,
    used: percent,
    limit: PERCENT_FULL,
    remaining: Math.max(PERCENT_FULL - percent, 0),
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

/** This service sends instants as epoch milliseconds in a string, not as ISO dates. */
function isoOfEpoch(value: unknown): string | null {
  const ms = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

/** Name the period the plan meters on, so a weekly budget is not mistaken for a monthly one. */
function cadenceOf(start: string | null, end: string | null): string | null {
  if (start === null || end === null) return null;
  const days = (Date.parse(end) - Date.parse(start)) / ONE_DAY_MS;
  if (days >= 6 && days <= 8) return "weekly";
  if (days >= 27 && days <= 33) return "monthly";
  if (days >= 360 && days <= 370) return "annual";
  return null;
}

async function pollWithToken(
  ctx: CollectContext,
  endpoint: string,
  url: string,
  token: string,
  request: { method: "GET" | "POST"; body?: string | undefined },
): Promise<RawPoll> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/json",
  };
  // A Connect call without a JSON content type is refused with 415 before it is routed.
  if (request.body !== undefined) headers["content-type"] = "application/json";
  try {
    return await fetchPoll(ctx, {
      endpoint,
      url,
      method: request.method,
      body: request.body,
      headers,
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
  upstreamOrigins: CURSOR_ORIGINS,
  pollEveryMs: CURSOR_POLL_MS,

  isConfigured(env) {
    return Boolean(env.CURSOR_API_KEY?.trim()) || existsSync(cursorStatePath(env));
  },
  missingCredentials(env) {
    if (env.CURSOR_API_KEY?.trim()) return [];
    const path = cursorStatePath(env);
    return existsSync(path) ? [] : ["Cursor (sign in, then set CURSOR_STATE_DB if it is not in the default location)"];
  },

  notes: [
    {
      title: "Weekly included usage",
      text: "GetCurrentPeriodUsage is the call the Cursor app makes: it states the included usage for the current period, when that period started and when it resets. This plan meters weekly, so the front of the card is the weekly budget; Cursor has no five-hour window. Price and renewal day still come from subscriptions.toml.",
    },
    {
      title: "Where the token comes from",
      text: "The access token is read read-only from Cursor's own state database (state.vscdb, key cursorAuth/accessToken) — the same source CodexBar uses. Since Cursor encrypts it at rest, modelizer unwraps the envelope with the Cursor Safe Storage keychain item (the app's own derivation; nothing is written back). The token is sent only to api2.cursor.sh, never logged; signing out of Cursor therefore stops the poll.",
    },
  ] satisfies ProviderNote[],

  async collect(ctx: CollectContext) {
    const statePath = cursorStatePath(ctx.env);
    const envKey = ctx.env.CURSOR_API_KEY?.trim() ?? "";
    if (envKey === "" && cursorTokenIsEncrypted(statePath) && usableCursorToken(statePath) === null) {
      // Sending the envelope earns a bare 401 and makes the card look broken; name the real
      // state instead. Decryption normally works (Cursor Safe Storage keychain item); failing
      // that, Cursor's public API keys do not expose the personal usage meter either.
      throw new Error(
        "Cursor stores its access token encrypted at rest (cursor-safe-storage envelope) and it could not be decrypted — the Cursor Safe Storage keychain item is missing or does not match, so usage polling is paused. Sign out and back in to Cursor, or set CURSOR_API_KEY; plan and billing still come from subscriptions.toml.",
      );
    }
    const token = envKey !== "" ? envKey : usableCursorToken(statePath);
    if (token === null) return [tokenMissingPoll(statePath)];
    return Promise.all([
      pollWithToken(ctx, CURSOR_PROFILE_ENDPOINT, CURSOR_PROFILE_URL, token, { method: "GET" }),
      pollWithToken(ctx, CURSOR_PERIOD_ENDPOINT, CURSOR_PERIOD_URL, token, {
        method: "POST",
        body: CONNECT_EMPTY_BODY,
      }),
    ]);
  },

  authFailure(polls) {
    // Both endpoints share one bearer from state.vscdb; 401/403 on either means Cursor rejected
    // the stored token (sign-out or rotation). Named like the other adapters so the card says
    // "auth failed" instead of keeping the last captured window visible as if it were current.
    for (const p of polls) {
      if (p.endpoint !== CURSOR_PROFILE_ENDPOINT && p.endpoint !== CURSOR_PERIOD_ENDPOINT) continue;
      if (p.status === 401 || p.status === 403) {
        return "Cursor rejected the stored access token (HTTP " +
          p.status +
          ") — the app keeps its session in memory but stopped rewriting the token in state.vscdb. Sign out and back in to refresh the local token; Cursor's public API keys cannot poll the personal usage meter";
      }
    }
    return null;
  },

  /** The included usage for the current period, when that poll succeeded. */
  normalize(polls, capturedAt) {
    const period = polls.find((p) => p.endpoint === CURSOR_PERIOD_ENDPOINT && p.status === 200);
    if (period === undefined) return [];
    const point = cursorPeriodPoint(period.json, capturedAt);
    return point === null ? [] : [point];
  },

  subscriptionFacts(polls) {
    const poll = polls.find((p) => p.endpoint === CURSOR_PROFILE_ENDPOINT && p.status === 200);
    return poll === undefined ? null : cursorFactsFromProfile(poll.json);
  },
};
