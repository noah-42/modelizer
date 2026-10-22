import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * API-equivalent pricing for local Claude usage.
 *
 * A subscription has no per-token bill, so "cost" here means what the same tokens would
 * have cost at list prices — the same number CodexBar shows. It is a burn metric for
 * comparing models and days, not an invoice.
 *
 * Prices are list prices in USD per million tokens, checked into `pricing/anthropic.json`
 * so a poll never depends on a third-party host staying up. `bun run scripts/refresh-pricing.ts`
 * regenerates the file from models.dev (the source CodexBar uses).
 */

export interface ModelPrice {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export type PricingTable = Readonly<Record<string, ModelPrice>>;

/** Per-turn token counts as the Claude Code transcript reports them. */
export interface TokenCounts {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export const PRICING_SOURCE_URL = "https://models.dev/api.json";
export const PRICING_PROVIDER = "anthropic";
/** Day the checked-in table was captured; refresh when a new model shows up unpriced. */
export const PRICING_CAPTURED_AT = "2026-10-22";

const TOKENS_PER_MILLION = 1_000_000;
/** models.dev ids sometimes carry a release date (`-20250929`) that transcripts omit. */
const RELEASE_DATE_SUFFIX = /-\d{8}$/;
const COST_DECIMALS = 6;

let cached: PricingTable | null = null;

/** The checked-in table. Read once; the file is immutable at runtime. */
export function bundledPricing(): PricingTable {
  if (cached !== null) return cached;
  const path = join(import.meta.dir, "pricing", "anthropic.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as PricingTable;
  cached = parsed;
  return parsed;
}

/**
 * Longest matching price row for a transcript model id.
 * Exact id first, then the id without a release-date suffix, then the longest table key
 * that prefixes it — never a shorter family key, so `claude-opus-5-5` cannot resolve to
 * `claude-opus-5` if both exist. Unknown models (e.g. `<synthetic>`) return null.
 */
export function resolvePrice(table: PricingTable, modelId: string): ModelPrice | null {
  if (modelId === "") return null;
  const exact = table[modelId];
  if (exact !== undefined) return exact;
  const undated = modelId.replace(RELEASE_DATE_SUFFIX, "");
  const undatedPrice = undated === modelId ? undefined : table[undated];
  if (undatedPrice !== undefined) return undatedPrice;
  let best = "";
  for (const key of Object.keys(table)) {
    if (modelId.startsWith(key) && key.length > best.length) best = key;
  }
  return best === "" ? null : (table[best] ?? null);
}

/** USD for one day of tokens. Null when the model has no price row. */
export function estimateCost(table: PricingTable, modelId: string, tokens: TokenCounts): number | null {
  const price = resolvePrice(table, modelId);
  if (price === null) return null;
  const usd =
    (tokens.input * price.input +
      tokens.output * price.output +
      tokens.cacheRead * price.cache_read +
      tokens.cacheWrite * price.cache_write) /
    TOKENS_PER_MILLION;
  return Number(usd.toFixed(COST_DECIMALS));
}
