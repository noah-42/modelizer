export type PointKind = "quota" | "balance" | "usage";
export type Unit = "usd" | "cny" | "tokens" | "requests" | "credits" | "percent" | "unknown";

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
  /** `pricing` marks a cost derived from list prices rather than reported by the provider. */
  source: string | null;
  quota_window?: string | null;
  stale?: boolean;
}

export interface StatusNote {
  label: string;
  state: string;
  tone: "good" | "warn" | "muted";
  until?: string;
}

export interface ProviderNote {
  title: string;
  text: string;
}

export interface DegradedEndpoint {
  endpoint: string;
  status: number;
}

export interface OverviewProvider {
  id: string;
  stabilityTier: number;
  pollEverySeconds: number;
  configured: boolean;
  lastSuccess: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  consecutiveFailures: number;
  stale: boolean;
  status: StatusNote[];
  notes: ProviderNote[];
  degradedEndpoints: DegradedEndpoint[];
  points: UsagePoint[];
  windows: Array<{
    window: string;
    usedPercent: number | null;
    resetsAt: string | null;
    source: string;
    stale: boolean;
  }>;
  /** Plan/billing row for this provider, when subscriptions.toml or the adapter has one. */
  subscription: Subscription | null;
  /** A plan with no API behind it: shown for completeness, with nothing to poll or meter. */
  planOnly: boolean;
}

export interface Overview {
  generatedAt: string;
  providers: OverviewProvider[];
}

export interface SessionInfo {
  id: number;
  started_at: string;
  stopped_at: string | null;
  pid: number | null;
}

export interface SessionsResponse {
  currentSessionId: number | null;
  sessions: SessionInfo[];
}

export interface AuditEventRow {
  id: number;
  session_id: number;
  at: string;
  provider: string | null;
  level: "info" | "warn" | "error";
  event: string;
  detail: string | null;
}

export interface DiaryEntry {
  kind: PointKind;
  label: string;
  model: string | null;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  unit: Unit;
}

export interface DiaryProvider {
  id: string;
  entries: DiaryEntry[];
}

export interface DiaryDay {
  date: string;
  providers: DiaryProvider[];
  warnings: number;
  errors: number;
}

export type BillingPeriod = "monthly" | "annual";
export type SubscriptionState = "active" | "trialing" | "cancelled" | "past_due" | "unknown";

export interface Subscription {
  provider: string;
  plan: string;
  /** Amount per billing period in `currency`, as billed now. */
  price: number | null;
  /** Amount from the next renewal on, when it differs (intro rate). */
  priceNext: number | null;
  currency: string;
  period: BillingPeriod;
  /** Monthly cost in force now, in `currency` (price, annualised). Drives the header total. */
  current: number | null;
  /** Monthly cost from the next charge on (priceNext ?? price, annualised). */
  monthly: number | null;
  renewsAt: string | null;
  /** Paid-through date of a prepaid term; null when it renews instead. */
  endsAt: string | null;
  /** True when the plan charges again after this period. */
  recurring: boolean;
  /** True when the whole term was paid up front, so the money has already left. */
  prepaid: boolean;
  /** True when the plan is live and costing money now, so it is in the header total. */
  counts: boolean;
  state: SubscriptionState;
  seats: number | null;
  source: string;
  configured: boolean;
  /** A recorded fact from subscriptions.toml, shown on the card. */
  note: string | null;
}

export interface CurrencyTotal {
  currency: string;
  monthly: number;
}

export interface SubscriptionsResponse {
  generatedAt: string;
  configPath: string;
  /** Monthly spend per currency for plans that keep charging. */
  totals: CurrencyTotal[];
  subscriptions: Subscription[];
  /** Set when subscriptions.toml could not be parsed. */
  error: string | null;
}

/** A model this machine uses and the provider that serves it. */
export interface LlmModel {
  id: string;
  name: string;
  provider: string;
  /** Where an added entry came from, e.g. its OpenRouter page. */
  sourceUrl?: string;
  contextLength?: number;
  /** USD per million tokens, as the provider quotes them. */
  promptUsdPerMTok?: number;
  completionUsdPerMTok?: number;
}

export interface ModelsResponse {
  generatedAt: string;
  path: string;
  models: LlmModel[];
  /** Set when models.toml could not be parsed. */
  error: string | null;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function fetchOverview(): Promise<Overview> {
  return getJson<Overview>("/api/overview");
}
export function fetchSessions(): Promise<SessionsResponse> {
  return getJson<SessionsResponse>("/api/sessions");
}
export function fetchAudit(session?: number): Promise<{ events: AuditEventRow[] }> {
  const q = session !== undefined ? `?session=${session}` : "";
  return getJson<{ events: AuditEventRow[] }>(`/api/audit${q}`);
}
export function fetchDiary(days = 14): Promise<{ days: DiaryDay[] }> {
  return getJson<{ days: DiaryDay[] }>(`/api/diary?days=${days}`);
}

/** A broken subscriptions.toml comes back as 422 *with* a readable error, so keep the body. */
export async function fetchModels(): Promise<ModelsResponse> {
  const res = await fetch("/api/models");
  const body = (await res.json()) as ModelsResponse;
  if (!res.ok && body.error === null) throw new Error(`HTTP ${res.status}`);
  return body;
}

/** Add a model to the catalogue from its OpenRouter link; the server fills in the details. */
export async function addModel(url: string, provider?: string): Promise<LlmModel> {
  const res = await fetch("/api/models", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const body = (await res.json()) as { model?: LlmModel; error?: string };
  if (!res.ok || body.model === undefined) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body.model;
}

/** Remove a model from the catalogue by id; the file keeps everything else untouched. */
export async function removeModel(id: string): Promise<void> {
  const res = await fetch(`/api/models/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
}

/** Persist a display order: the ids come in the wanted sequence, first gets `order = 1`. */
export async function reorderModels(ids: string[]): Promise<void> {
  const res = await fetch("/api/models/order", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
}

export async function fetchSubscriptions(): Promise<SubscriptionsResponse> {
  const res = await fetch("/api/subscriptions");
  const body = (await res.json()) as SubscriptionsResponse;
  if (!res.ok && body.error === null) throw new Error(`HTTP ${res.status}`);
  return body;
}
