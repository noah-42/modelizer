import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { parse } from "smol-toml";

/**
 * Subscriptions = the things with a recurring bill: plan, price, renewal, state.
 *
 * Two inputs are merged:
 *   1. `subscriptions.toml` — the user's own facts (price paid, renewal day, paid-through date).
 *   2. provider facts — what an adapter can read from the provider (plan, status, seats).
 *
 * Facts win for plan/state because the provider knows; config wins for price and renewal because
 * no provider here exposes the charge date. Money is kept in the currency it is billed in — this
 * app does not invent an exchange rate — so totals are reported per currency.
 */

export type BillingPeriod = "monthly" | "annual";

export type SubscriptionState = "active" | "trialing" | "cancelled" | "past_due" | "unknown";

const PERIODS: readonly BillingPeriod[] = ["monthly", "annual"];
const STATES: readonly SubscriptionState[] = ["active", "trialing", "cancelled", "past_due", "unknown"];
const MONTHS_PER_YEAR = 12;
const DEFAULT_CURRENCY = "USD";
/** Renewals are day-precision, so park the instant mid-day UTC to survive any local offset. */
const RENEWAL_HOUR_UTC = 9;

/** What a provider reports about the plan behind a card. Pure output of an adapter. */
export interface SubscriptionFacts {
  provider: string;
  /** Provider-native plan id, e.g. `pro` for Claude or Cursor, `plus` for ChatGPT. */
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
  order?: number;
  plan?: string;
  /** Display name when the plan has no catalogue entry (config is the user's own wording). */
  label?: string;
  /** A fact worth carrying on the card, e.g. "free daily messages, reset 2:00 AM". */
  note?: string;
  /** Amount per billing period, in `currency`. */
  price?: number;
  /** Amount charged from the next renewal on (intro offers); monthly cost uses this. */
  priceNext?: number;
  /** ISO 4217 code; defaults to USD. */
  currency?: string;
  period?: BillingPeriod;
  /** Day of month the card is charged, 1-31. Clamped in short months. */
  renewsDay?: number;
  renewsAt?: string;
  /** Paid-through date of a prepaid term that does not auto-renew (e.g. an annual plan). */
  endsAt?: string;
  state?: SubscriptionState;
  seats?: number;
}

/** A merged row for the Subscriptions page. */
export interface Subscription {
  provider: string;
  plan: string;
  /** Amount per billing period in `currency`, as billed now. Null when unknown. */
  price: number | null;
  /** Amount from the next renewal on, when it differs from `price`. */
  priceNext: number | null;
  currency: string;
  period: BillingPeriod;
  /** Monthly cost in force now, in `currency` (price, annualised). Drives the total. */
  current: number | null;
  /** Monthly cost from the next charge on (priceNext ?? price, annualised). */ 
  monthly: number | null;
  /** Next automatic charge, when the plan renews. */
  renewsAt: string | null;
  /** Paid-through date for a prepaid term; null when it renews instead. */
  endsAt: string | null;
  /** True when the plan charges again after this period. */
  recurring: boolean;
  /** True when the whole term was paid up front: the money has already left. */
  prepaid: boolean;
  /** True when the plan is live and costing money now, so it belongs in the monthly total. */
  counts: boolean;
  state: SubscriptionState;
  seats: number | null;
  /** `config`, the provider source, or `<source>+config`. */
  source: string;
  /** True when the provider appears in subscriptions.toml. */
  configured: boolean;
  /** A recorded fact from subscriptions.toml, shown on the card and the row. */
  note: string | null;
}

export interface KnownPlan {
  provider: string;
  id: string;
  name: string;
  monthlyUsd: number;
}

/** Monthly spend in one currency; several currencies are never added together. */
export interface CurrencyTotal {
  currency: string;
  monthly: number;
}

/**
 * List prices for plans this app can recognise, so a detected plan shows a cost without
 * asking the user. Override any row with `price` in subscriptions.toml — annual pricing,
 * student discounts, regional VAT and grandfathered rates are not modelled here.
 */
export const KNOWN_PLANS: readonly KnownPlan[] = [
  { provider: "claude", id: "pro", name: "Claude Pro", monthlyUsd: 20 },
  { provider: "claude", id: "max_5x", name: "Claude Max 5×", monthlyUsd: 100 },
  { provider: "claude", id: "max_20x", name: "Claude Max 20×", monthlyUsd: 200 },
  { provider: "cursor", id: "pro", name: "Cursor Pro", monthlyUsd: 20 },
  { provider: "cursor", id: "pro_plus", name: "Cursor Pro+", monthlyUsd: 60 },
  { provider: "cursor", id: "ultra", name: "Cursor Ultra", monthlyUsd: 200 },
  { provider: "codex", id: "plus", name: "ChatGPT Plus", monthlyUsd: 20 },
  { provider: "codex", id: "pro", name: "ChatGPT Pro", monthlyUsd: 200 },
  { provider: "xai", id: "supergrok", name: "SuperGrok", monthlyUsd: 30 },
  { provider: "xai", id: "supergrok_heavy", name: "SuperGrok Heavy", monthlyUsd: 300 },
];

export class SubscriptionConfigError extends Error {}

export const DEFAULT_SUBSCRIPTIONS_PATH = "subscriptions.toml";

export interface SubscriptionUpdate {
  plan?: string | null;
  label?: string | null;
  note?: string | null;
  price?: number | null;
  priceNext?: number | null;
  currency?: string | null;
  period?: BillingPeriod | null;
  renewsDay?: number | null;
  renewsAt?: string | null;
  endsAt?: string | null;
  state?: SubscriptionState | null;
  seats?: number | null;
  order?: number | null;
}

const SUBSCRIPTION_FIELDS = [
  ["plan", "plan"],
  ["label", "label"],
  ["note", "note"],
  ["price", "price"],
  ["priceNext", "price_next"],
  ["currency", "currency"],
  ["period", "period"],
  ["renewsDay", "renews_day"],
  ["renewsAt", "renews_at"],
  ["endsAt", "ends_at"],
  ["state", "state"],
  ["seats", "seats"],
  ["order", "order"],
] as const;

export function appendSubscription(entry: SubscriptionEntry, path = DEFAULT_SUBSCRIPTIONS_PATH): void {
  const existing = loadSubscriptions(path);
  const validated = parseEntry(toTomlEntry(entry), existing.length, path);
  if (existing.some(({ provider }) => provider === validated.provider)) {
    throw new SubscriptionConfigError(`${path}: provider "${validated.provider}" already exists`);
  }
  const current = readSubscriptionText(path);
  const separator = current.trim() === "" ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  writeSubscriptions(path, `${current}${separator}${serializeSubscription(validated)}\n`);
}

export function updateSubscription(
  provider: string,
  changes: SubscriptionUpdate,
  path = DEFAULT_SUBSCRIPTIONS_PATH,
): void {
  const current = readSubscriptionText(path);
  const entries = loadSubscriptions(path);
  if (!entries.some((entry) => entry.provider === provider)) throw missingSubscription(provider, path);
  const blocks = splitSubscriptionBlocks(current);
  const targetIndex = entries.findIndex((entry) => entry.provider === provider);
  const targetBlock = blocks.find((block) => block.some((line) => readTomlString(line) === provider));
  if (targetBlock === undefined) throw missingSubscription(provider, path);
  const values: Record<string, unknown> = { ...toTomlEntry(entries[targetIndex] as SubscriptionEntry) };
  for (const [field] of SUBSCRIPTION_FIELDS) {
    const value = changes[field];
    if (value === undefined) continue;
    if (value === null || value === "") delete values[field];
    else values[field] = value;
  }
  const validated = parseEntry(values, targetIndex, path);
  blocks[blocks.indexOf(targetBlock)] = replaceSubscriptionFields(targetBlock, validated);
  writeSubscriptions(path, blocks.flat().join("\n"));
}

export function removeSubscription(provider: string, path = DEFAULT_SUBSCRIPTIONS_PATH): void {
  const current = readSubscriptionText(path);
  const entries = loadSubscriptions(path);
  const index = entries.findIndex((entry) => entry.provider === provider);
  if (index < 0) throw missingSubscription(provider, path);
  const blocks = splitSubscriptionBlocks(current);
  const blockIndex = blocks.findIndex((block) => block.some((line) => readTomlString(line) === provider));
  const target = blocks[blockIndex];
  if (target === undefined) throw missingSubscription(provider, path);
  blocks.splice(blockIndex, 1);
  writeSubscriptions(path, blocks.flat().join("\n"));
}

export function setSubscriptionOrder(providers: string[], path = DEFAULT_SUBSCRIPTIONS_PATH): void {
  const entries = loadSubscriptions(path);
  const unique = new Set(providers);
  if (unique.size !== providers.length) throw new SubscriptionConfigError(`${path}: provider order contains duplicates`);
  const unknown = providers.filter((provider) => !entries.some((entry) => entry.provider === provider));
  if (unknown.length > 0) throw missingSubscription(unknown[0] ?? "", path);
  const current = readSubscriptionText(path);
  const lines = current.split("\n");
  const blocks = splitSubscriptionBlocks(current);
  const reordered = blocks.map((block, index) => {
    const entry = entries[index];
    if (entry === undefined) return block;
    const rank = providers.indexOf(entry.provider);
    return rank < 0 ? block : replaceSubscriptionOrder(block, rank + 1);
  });
  writeSubscriptions(path, reordered.flat().join("\n"));
}

function splitSubscriptionBlocks(text: string): string[][] {
  const lines = text.split("\n");
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === "[[subscription]]" && current.length > 0) {
      blocks.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

function replaceSubscriptionFields(block: string[], entry: SubscriptionEntry): string[] {
  const fields = new Map<string, string>();
  for (const [field, key] of SUBSCRIPTION_FIELDS) {
    const value = entry[field];
    if (value !== undefined) fields.set(key, `${key} = ${typeof value === "string" ? JSON.stringify(value) : value}`);
  }
  const firstHeader = block.findIndex((line) => line.trim() === "[[subscription]]");
  const header = firstHeader < 0 ? [] : block.slice(0, firstHeader + 1);
  const body = firstHeader < 0 ? block : block.slice(firstHeader + 1);
  const providerLine = body.findIndex((line) => /^\s*provider\s*=/.test(line));
  const retained = body.filter((line) => !SUBSCRIPTION_FIELDS.some(([, key]) => new RegExp(`^\\s*${key}\\s*=`).test(line)));
  const insertion = providerLine < 0 ? 0 : Math.min(providerLine, retained.length);
  retained.splice(insertion, 0, ...fields.values());
  return [...header, ...retained];
}

function replaceSubscriptionOrder(block: string[], order: number): string[] {
  const line = `order = ${order}`;
  const existing = block.findIndex((item) => /^\s*order\s*=/.test(item));
  if (existing >= 0) {
    block[existing] = line;
    return block;
  }
  const providerLine = block.findIndex((item) => /^\s*provider\s*=/.test(item));
  block.splice(providerLine < 0 ? 0 : providerLine + 1, 0, line);
  return block;
}

function readSubscriptionText(path: string): string {
  try {
    const text = readFileSync(path, "utf8");
    parse(text);
    loadSubscriptions(path);
    return text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function writeSubscriptions(path: string, contents: string): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, contents, { mode: 0o600 });
  renameSync(temporary, path);
}

function missingSubscription(provider: string, path: string): SubscriptionConfigError {
  return new SubscriptionConfigError(`${path}: provider "${provider}" is not configured`);
}

function serializeSubscription(entry: SubscriptionEntry): string {
  return ["[[subscription]]", ...serializeSubscriptionFields(entry)].join("\n");
}

function serializeSubscriptionFields(entry: SubscriptionEntry): string[] {
  const lines = [`provider = ${JSON.stringify(entry.provider)}`];
  for (const [field, key] of SUBSCRIPTION_FIELDS) {
    const value = entry[field];
    if (value !== undefined) lines.push(`${key} = ${typeof value === "string" ? JSON.stringify(value) : value}`);
  }
  return lines;
}

function toTomlEntry(entry: SubscriptionEntry): Record<string, unknown> {
  const result: Record<string, unknown> = { provider: entry.provider };
  for (const [field, key] of SUBSCRIPTION_FIELDS) {
    const value = entry[field];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function readTomlString(line: string): string | null {
  const match = /^\s*provider\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/.exec(line);
  if (match === null) return null;
  try {
    return String(parse(`value = ${match[1]}`).value);
  } catch {
    return null;
  }
}

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
  const entries = blocks.map((block, index) => parseEntry(block, index, path));
  // One row per provider: a second block would silently lose to the first, so say so instead.
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.provider)) {
      throw new SubscriptionConfigError(`${path}: provider "${entry.provider}" appears more than once — one block per provider`);
    }
    seen.add(entry.provider);
  }
  return entries;
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
  const order = optionalNumber(b.order, `${where}: order`);
  if (order !== null) {
    if (!Number.isInteger(order) || order < 1) throw new SubscriptionConfigError(`${where}: order must be an integer >= 1`);
    entry.order = order;
  }
  const plan = optionalString(b.plan, `${where}: plan`);
  if (plan !== null) entry.plan = plan;
  const label = optionalString(b.label, `${where}: label`);
  if (label !== null) entry.label = label;
  const note = optionalString(b.note, `${where}: note`);
  if (note !== null) entry.note = note;
  const price = optionalAmount(b.price, `${where}: price`);
  if (price !== null) entry.price = price;
  const priceNext = optionalAmount(b.price_next, `${where}: price_next`);
  if (priceNext !== null) entry.priceNext = priceNext;
  const currency = optionalString(b.currency, `${where}: currency`);
  if (currency !== null) entry.currency = parseCurrency(currency, `${where}: currency`);
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
  if (renewsAt !== null) entry.renewsAt = parseInstant(renewsAt, `${where}: renews_at`);
  const endsAt = optionalString(b.ends_at, `${where}: ends_at`);
  if (endsAt !== null) entry.endsAt = parseInstant(endsAt, `${where}: ends_at`);
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

function parseCurrency(value: string, where: string): string {
  const code = value.toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new SubscriptionConfigError(`${where} must be a 3-letter ISO 4217 code (USD, EUR, …)`);
  return code;
}

function parseInstant(value: string, where: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new SubscriptionConfigError(`${where} must be an ISO date`);
  return value;
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

function optionalAmount(value: unknown, where: string): number | null {
  const amount = optionalNumber(value, where);
  if (amount !== null && amount < 0) throw new SubscriptionConfigError(`${where} must be >= 0`);
  return amount;
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
export function monthlyPrice(price: number | null, period: BillingPeriod): number | null {
  if (price === null) return null;
  return period === "annual" ? price / MONTHS_PER_YEAR : price;
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

  /** One row per provider, priciest first at the rate in force — the same number the total uses. */
  list(): Subscription[] {
    const providers = new Set<string>([...this.entries.map((e) => e.provider), ...this.facts.keys()]);
    const ranked = new Map(
      this.entries
        .filter((entry) => entry.order !== undefined)
        .map((entry) => [entry.provider, entry.order as number]),
    );
    return [...providers]
      .map((provider) => this.merge(provider))
      .sort((a, b) => {
        const aOrder = ranked.get(a.provider);
        const bOrder = ranked.get(b.provider);
        if (aOrder !== undefined || bOrder !== undefined) {
          if (aOrder === undefined) return 1;
          if (bOrder === undefined) return -1;
          if (aOrder !== bOrder) return aOrder - bOrder;
        }
        return (b.current ?? -1) - (a.current ?? -1) || (a.provider < b.provider ? -1 : 1);
      });
  }

  /**
   * Value of the plans that are active right now, per currency, at the price in force this
   * period. A plan paid up front is out (that money is spent, not monthly), as are cancelled and
   * past-due plans; a plan that is still running counts even if it will not renew.
   */
  totals(): CurrencyTotal[] {
    return sumByCurrency(this.list().filter((s) => s.counts), (s) => s.current);
  }

  private merge(provider: string): Subscription {
    const entry = this.entries.find((e) => e.provider === provider);
    const facts = this.facts.get(provider);
    const planId = entry?.plan ?? facts?.planId ?? null;
    const known = knownPlan(provider, planId);
    const period = entry?.period ?? facts?.period ?? "monthly";
    const currency = entry?.currency ?? DEFAULT_CURRENCY;
    const price = entry?.price ?? known?.monthlyUsd ?? null;
    const priceNext = entry?.priceNext ?? null;
    const state = facts !== undefined && facts.state !== "unknown" ? facts.state : (entry?.state ?? "unknown");
    const renewsAt =
      nextRenewal(
        {
          ...(entry?.renewsDay !== undefined ? { renewsDay: entry.renewsDay } : {}),
          ...(entry?.renewsAt !== undefined ? { renewsAt: entry.renewsAt } : {}),
          period,
        },
        this.now,
      ) ?? facts?.renewsAt ?? null;
    // A plan set not to renew ends, it does not charge: show its last day instead of a renewal.
    const endsAt = entry?.endsAt === undefined ? null : entry.endsAt;
    // A year paid in one go is a spent cost, not a monthly one; a cancelled plan costs nothing.
    const prepaid = endsAt !== null && period === "annual";
    const live = state !== "cancelled" && state !== "past_due";

    return {
      provider,
      plan: entry?.label ?? facts?.planName ?? known?.name ?? planId ?? "unknown plan",
      price,
      priceNext,
      currency,
      period,
      current: monthlyPrice(price, period),
      monthly: monthlyPrice(priceNext ?? price, period),
      renewsAt: endsAt === null ? renewsAt : null,
      endsAt,
      recurring: endsAt === null,
      prepaid,
      counts: live && !prepaid,
      state,
      seats: entry?.seats ?? facts?.seats ?? null,
      source: sourceLabel(entry !== undefined, facts?.source),
      configured: entry !== undefined,
      note: entry?.note ?? null,
    };
  }
}

function sourceLabel(configured: boolean, factSource: string | undefined): string {
  if (factSource === undefined) return "config";
  return configured ? `${factSource}+config` : factSource;
}

/** Currencies are never added together: one figure per currency, unpriced rows skipped. */
function sumByCurrency(
  rows: readonly Subscription[],
  amount: (row: Subscription) => number | null,
): CurrencyTotal[] {
  const byCurrency = new Map<string, number>();
  for (const row of rows) {
    const value = amount(row);
    if (value === null) continue;
    byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? 0) + value);
  }
  return [...byCurrency.entries()]
    .map(([currency, monthly]) => ({ currency, monthly: Number(monthly.toFixed(2)) }))
    .sort((a, b) => b.monthly - a.monthly);
}
