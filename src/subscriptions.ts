import { readFileSync } from "node:fs";
import { parse } from "smol-toml";

/**
 * Subscriptions = the things with a monthly bill: plan, price, renewal, state.
 *
 * Two inputs are merged:
 *   1. `subscriptions.toml` — the user's own facts (price paid, renewal day).
 *   2. provider facts — what an adapter can read from the provider (plan, status, seats).
 *
 * Facts win for plan/state because the provider knows; config wins for price and renewal
 * because no provider in this app exposes the charge date. Nothing here guesses a price it
 * cannot source: an unknown plan keeps `priceUsd: null` and the page says so.
 */

export type BillingPeriod = "monthly" | "annual";

export type SubscriptionState = "active" | "trialing" | "cancelled" | "past_due" | "unknown";

const PERIODS: readonly BillingPeriod[] = ["monthly", "annual"];
const STATES: readonly SubscriptionState[] = ["active", "trialing", "cancelled", "past_due", "unknown"];

/** What a provider reports about the plan behind a card. Pure output of an adapter. */
export interface SubscriptionFacts {
  provider: string;
  /** Provider-native plan id, e.g. `pro` for Claude or Cursor. */
  planId: string | null;
  /** Human label when the provider gives one. */
  planName: string | null;
  state: SubscriptionState;
  period: BillingPeriod | null;
  /** Only when the provider actually states it; never derived here. */
  renewsAt: string | null;
  seats: number | null;
  /** Which source produced this, e.g. `claude-oauth` or `cursor-api`. */
  source: string;
}

/** One `[[subscription]]` block from subscriptions.toml. */
export interface SubscriptionEntry {
  provider: string;
  plan?: string;
  priceUsd?: number;
  period?: BillingPeriod;
  /** Day of month the card is charged, 1-31. Clamped in short months. */
  renewsDay?: number;
  renewsAt?: string;
  state?: SubscriptionState;
  seats?: number;
}

/** A merged row for the Subscriptions page. */
export interface Subscription {
  provider: string;
  plan: string;
  /** Price per billing period, USD. Null when neither config nor the plan catalogue knows it. */
  priceUsd: number | null;
  period: BillingPeriod;
  /** priceUsd normalised to a month; the page's total uses this. */
  monthlyUsd: number | null;
  renewsAt: string | null;
  state: SubscriptionState;
  seats: number | null;
  /** `config`, the provider source, or `<source>+config`. */
  source: string;
  /** True when the provider appears in subscriptions.toml. */
  configured: boolean;
}

export interface KnownPlan {
  provider: string;
  id: string;
  name: string;
  monthlyUsd: number;
}

/**
 * List prices for plans this app can recognise, so a detected plan shows a cost without
 * asking the user. Override any row with `price_usd` in subscriptions.toml — annual pricing,
 * student discounts and grandfathered rates are not modelled here.
 */
export const KNOWN_PLANS: readonly KnownPlan[] = [
  { provider: "claude", id: "pro", name: "Claude Pro", monthlyUsd: 20 },
  { provider: "claude", id: "max_5x", name: "Claude Max 5×", monthlyUsd: 100 },
  { provider: "claude", id: "max_20x", name: "Claude Max 20×", monthlyUsd: 200 },
  { provider: "cursor", id: "pro", name: "Cursor Pro", monthlyUsd: 20 },
  { provider: "cursor", id: "pro_plus", name: "Cursor Pro+", monthlyUsd: 60 },
  { provider: "cursor", id: "ultra", name: "Cursor Ultra", monthlyUsd: 200 },
  { provider: "xai", id: "supergrok", name: "SuperGrok", monthlyUsd: 30 },
  { provider: "xai", id: "supergrok_heavy", name: "SuperGrok Heavy", monthlyUsd: 300 },
];

const MONTHS_PER_YEAR = 12;
/** Renewals are day-precision, so park the instant mid-day UTC to survive any local offset. */
const RENEWAL_HOUR_UTC = 9;

export class SubscriptionConfigError extends Error {}

export const DEFAULT_SUBSCRIPTIONS_PATH = "subscriptions.toml";

export function loadSubscriptions(path = DEFAULT_SUBSCRIPTIONS_PATH): SubscriptionEntry[] {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const raw = parse(text) as { subscription?: unknown };
  const blocks = raw.subscription;
  if (blocks === undefined) return [];
  if (!Array.isArray(blocks)) throw new SubscriptionConfigError(`${path}: [[subscription]] must be an array of tables`);
  return blocks.map((block, index) => parseEntry(block, index, path));
}

function parseEntry(block: unknown, index: number, path: string): SubscriptionEntry {
  const where = `${path}: subscription #${index + 1}`;
  if (block === null || typeof block !== "object" || Array.isArray(block)) {
    throw new SubscriptionConfigError(`${where}: expected a table`);
  }
  const b = block as Record<string, unknown>;
  const provider = typeof b.provider === "string" ? b.provider.trim() : "";
  if (provider === "") throw new SubscriptionConfigError(`${where}: provider is required`);

  const entry: SubscriptionEntry = { provider };
  const plan = optionalString(b.plan, `${where}: plan`);
  if (plan !== null) entry.plan = plan;
  const price = optionalNumber(b.price_usd, `${where}: price_usd`);
  if (price !== null) {
    if (price < 0) throw new SubscriptionConfigError(`${where}: price_usd must be >= 0`);
    entry.priceUsd = price;
  }
  const period = optionalString(b.period, `${where}: period`);
  if (period !== null) {
    if (!isPeriod(period)) throw new SubscriptionConfigError(`${where}: period must be monthly or annual`);
    entry.period = period;
  }
  const renewsDay = optionalNumber(b.renews_day, `${where}: renews_day`);
  if (renewsDay !== null) {
    if (!Number.isInteger(renewsDay) || renewsDay < 1 || renewsDay > 31) {
      throw new SubscriptionConfigError(`${where}: renews_day must be an integer 1-31`);
    }
    entry.renewsDay = renewsDay;
  }
  const renewsAt = optionalString(b.renews_at, `${where}: renews_at`);
  if (renewsAt !== null) {
    if (!Number.isFinite(Date.parse(renewsAt))) throw new SubscriptionConfigError(`${where}: renews_at must be an ISO date`);
    entry.renewsAt = renewsAt;
  }
  const state = optionalString(b.state, `${where}: state`);
  if (state !== null) {
    if (!isState(state)) throw new SubscriptionConfigError(`${where}: state must be one of ${STATES.join(", ")}`);
    entry.state = state;
  }
  const seats = optionalNumber(b.seats, `${where}: seats`);
  if (seats !== null) {
    if (!Number.isInteger(seats) || seats < 1) throw new SubscriptionConfigError(`${where}: seats must be an integer >= 1`);
    entry.seats = seats;
  }
  return entry;
}

function optionalString(value: unknown, where: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "") throw new SubscriptionConfigError(`${where} must be a non-empty string`);
  return value.trim();
}

function optionalNumber(value: unknown, where: string): number | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new SubscriptionConfigError(`${where} must be a number`);
  return value;
}

function isPeriod(value: string): value is BillingPeriod {
  return (PERIODS as readonly string[]).includes(value);
}

function isState(value: string): value is SubscriptionState {
  return (STATES as readonly string[]).includes(value);
}

export function knownPlan(provider: string, planId: string | null): KnownPlan | null {
  if (planId === null) return null;
  return KNOWN_PLANS.find((p) => p.provider === provider && p.id === planId) ?? null;
}

/** Normalise a per-period price to a monthly figure for the page total. */
export function monthlyPrice(priceUsd: number | null, period: BillingPeriod): number | null {
  if (priceUsd === null) return null;
  return period === "annual" ? priceUsd / MONTHS_PER_YEAR : priceUsd;
}

/**
 * Next charge date from a renewal day-of-month or an explicit past date.
 * Day-of-month means: same day next month (clamped for short months), at 09:00 UTC.
 * Returns null when nothing is known — the page then asks for `renews_day`.
 */
export function nextRenewal(
  opts: { renewsDay?: number | undefined; renewsAt?: string | undefined; period: BillingPeriod },
  now: Date,
): string | null {
  if (opts.renewsAt !== undefined) {
    const start = Date.parse(opts.renewsAt);
    if (!Number.isFinite(start)) return null;
    const step = opts.period === "annual" ? 12 : 1;
    let at = new Date(start);
    let guard = 0;
    while (at.getTime() <= now.getTime() && guard < 240) {
      at = addMonths(at, step, opts.renewsDay);
      guard += 1;
    }
    return at.toISOString();
  }
  if (opts.renewsDay === undefined) return null;
  const day = clampDay(now.getUTCFullYear(), now.getUTCMonth(), opts.renewsDay);
  let at = renewalInstant(now.getUTCFullYear(), now.getUTCMonth(), day);
  if (at.getTime() <= now.getTime()) {
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    at = renewalInstant(next.getUTCFullYear(), next.getUTCMonth(), clampDay(next.getUTCFullYear(), next.getUTCMonth(), opts.renewsDay));
  }
  return at.toISOString();
}

function renewalInstant(year: number, monthIndex: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex, day, RENEWAL_HOUR_UTC));
}

function addMonths(from: Date, months: number, day?: number): Date {
  const target = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months, 1));
  const wanted = day ?? from.getUTCDate();
  return renewalInstant(target.getUTCFullYear(), target.getUTCMonth(), clampDay(target.getUTCFullYear(), target.getUTCMonth(), wanted));
}

function clampDay(year: number, monthIndex: number, day: number): number {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return Math.min(day, lastDay);
}

/** Merge config entries with provider facts into page rows. */
export class SubscriptionCatalog {
  private readonly entries: SubscriptionEntry[];
  private readonly facts: Map<string, SubscriptionFacts>;
  private readonly now: Date;

  constructor(entries: SubscriptionEntry[], facts: SubscriptionFacts[], now: Date) {
    this.entries = entries;
    this.facts = new Map(facts.map((f) => [f.provider, f]));
    this.now = now;
  }

  /** One row per provider, most expensive first; unrriced rows last. */
  list(): Subscription[] {
    const providers = new Set<string>([...this.entries.map((e) => e.provider), ...this.facts.keys()]);
    return [...providers]
      .map((provider) => this.merge(provider))
      .sort((a, b) => (b.monthlyUsd ?? -1) - (a.monthlyUsd ?? -1) || (a.provider < b.provider ? -1 : 1));
  }

  /** Monthly spend across every row that has a price. */
  totalMonthlyUsd(): number {
    return Number(
      this.list()
        .reduce((sum, s) => sum + (s.monthlyUsd ?? 0), 0)
        .toFixed(2),
    );
  }

  private merge(provider: string): Subscription {
    const entry = this.entries.find((e) => e.provider === provider);
    const facts = this.facts.get(provider);
    const planId = entry?.plan ?? facts?.planId ?? null;
    const known = knownPlan(provider, planId);
    const period = entry?.period ?? facts?.period ?? "monthly";
    const priceUsd = entry?.priceUsd ?? known?.monthlyUsd ?? null;
    const state = facts !== undefined && facts.state !== "unknown" ? facts.state : (entry?.state ?? "unknown");
    const renewsAt = nextRenewal(
      { ...(entry?.renewsDay !== undefined ? { renewsDay: entry.renewsDay } : {}), ...(entry?.renewsAt !== undefined ? { renewsAt: entry.renewsAt } : {}), period },
      this.now,
    ) ?? facts?.renewsAt ?? null;

    return {
      provider,
      plan: facts?.planName ?? known?.name ?? planId ?? "unknown plan",
      priceUsd,
      period,
      monthlyUsd: monthlyPrice(priceUsd, period),
      renewsAt,
      state,
      seats: entry?.seats ?? facts?.seats ?? null,
      source: sourceLabel(entry !== undefined, facts?.source),
      configured: entry !== undefined,
    };
  }
}

function sourceLabel(configured: boolean, factSource: string | undefined): string {
  if (factSource === undefined) return "config";
  return configured ? `${factSource}+config` : factSource;
}
