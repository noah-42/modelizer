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
  priceUsd: number | null;
  period: BillingPeriod;
  monthlyUsd: number | null;
  renewsAt: string | null;
  state: SubscriptionState;
  seats: number | null;
  source: string;
  configured: boolean;
}

export interface SubscriptionsResponse {
  generatedAt: string;
  configPath: string;
  totalMonthlyUsd: number;
  subscriptions: Subscription[];
  /** Set when subscriptions.toml could not be parsed. */
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
export async function fetchSubscriptions(): Promise<SubscriptionsResponse> {
  const res = await fetch("/api/subscriptions");
  const body = (await res.json()) as SubscriptionsResponse;
  if (!res.ok && body.error === null) throw new Error(`HTTP ${res.status}`);
  return body;
}
