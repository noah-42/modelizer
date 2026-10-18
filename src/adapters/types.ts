export type PointKind = "quota" | "balance" | "usage";
export type Unit = "usd" | "cny" | "tokens" | "requests" | "credits" | "percent" | "unknown";

/** One normalized fact extracted from a poll: a quota window, a balance, or a day of usage. */
export interface UsagePoint {
  provider: string;
  kind: PointKind;
  label: string;
  model: string | null;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  unit: Unit;
  window_start: string | null;
  window_end: string | null;
  reset_at: string | null;
  day: string | null;
  requests: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  captured_at: string;
}

/** A single HTTP response archived verbatim so a broken adapter can be repaired from evidence. */
export interface RawPoll {
  endpoint: string;
  url: string;
  status: number;
  body: string;
  json: unknown;
  headers: Record<string, string>;
  /** Optional polls may fail without failing the adapter run (e.g. payg-only endpoints on a subscription key). */
  optional?: boolean;
}

export interface CollectContext {
  fetchFn: typeof fetch;
  env: Record<string, string | undefined>;
  now: Date;
  log: (msg: string) => void;
}

/** A clock-derived status row (no API call needed), e.g. a provider's peak/off-peak pricing window. */
export interface StatusNote {
  label: string;
  state: string;
  tone: "good" | "warn" | "muted";
  /** ISO instant when the state flips. */
  until?: string;
}

/** Static background shown in the card's "Pricing & notes" section. Verified facts only. */
export interface ProviderNote {
  title: string;
  text: string;
}

export interface Adapter {
  id: string;
  /** 1 = official documented API, 2 = undocumented/community, 3 = local files, 4 = no path. */
  stabilityTier: 1 | 2 | 3 | 4;
  pollEveryMs: number;
  isConfigured(env: Record<string, string | undefined>): boolean;
  missingCredentials(env: Record<string, string | undefined>): string[];
  collect(ctx: CollectContext): Promise<RawPoll[]>;
  /** Pure mapping from successful polls to points; throws on unexpected shapes so drift is loud. */
  normalize(polls: RawPoll[], capturedAt: string): UsagePoint[];
  /** Optional clock-derived status, evaluated fresh on every overview request. */
  liveStatus?(now: Date): StatusNote[];
  /** Optional env-derived hints (e.g. "add X key to unlock more data"), shown as muted status rows. */
  statusHints?(env: Record<string, string | undefined>): StatusNote[];
  /** Optional static pricing/token-value notes. */
  notes?: ProviderNote[];
}

export class NormalizeError extends Error {}

/** GET a JSON endpoint and archive status/headers/body verbatim. Never throws on HTTP status. */
export async function fetchPoll(
  ctx: CollectContext,
  opts: { endpoint: string; url: string; headers: Record<string, string>; optional?: boolean },
): Promise<RawPoll> {
  const res = await ctx.fetchFn(opts.url, { headers: opts.headers, signal: AbortSignal.timeout(15_000) });
  const body = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(body);
  } catch {
    // keep raw body only
  }
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return {
    endpoint: opts.endpoint,
    url: opts.url,
    status: res.status,
    body,
    json,
    headers,
    optional: opts.optional ?? false,
  };
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export { num };
