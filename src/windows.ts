import type { UsagePoint, Unit } from "./adapters/types";

/** Quota window names exposed on `/api/overview` and in reset notices. */
export type KnownWindow = "five_hour" | "weekly" | "monthly" | "mcp" | "token_window";

/** How a reset time is known — or honestly, why there is none. */
export interface WindowReset {
  /** ISO with offset when the provider reported one; null is preserved, never rolled forward. */
  resetsAt: string | null;
  /** provider-reported = straight from the payload; estimated = clearly flagged inference; else unavailable. */
  basis: "provider-reported" | "local-observed" | "estimated" | "unavailable";
  /** Why there is no time (idle/no active window, not exposed, auth failure, stale data, …). */
  reason: string | null;
  /** rolling = a sliding usage window; fixed = resets on the provider's clock; null = unknown. */
  windowKind: "rolling" | "fixed" | null;
}

export interface OverviewWindow {
  /** Stable identity for watchers: `<provider>|<window>`. */
  id: string;
  window: string;
  /** What the value meters (point label), e.g. "included-usage" or "mcp" — not just a bare %. */
  scope: string;
  model: string | null;
  unit: Unit;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  usedPercent: number | null;
  /** When this exact reading was captured — not the overview's generatedAt. */
  capturedAt: string;
  source: string;
  stale: boolean;
  /** Kept flat for existing clients; identical to `reset.resetsAt`. */
  resetsAt: string | null;
  reset: WindowReset;
}

/** 300 minutes is the 5-hour session window; 10080 is the weekly window. Slots are not authoritative. */
export function windowFromMinutes(minutes: number): "five_hour" | "weekly" | null {
  if (minutes === 300) return "five_hour";
  if (minutes === 10080) return "weekly";
  return null;
}

export const WINDOW_PHRASE: Record<string, string> = {
  five_hour: "5-hour",
  weekly: "weekly",
  monthly: "monthly",
  mcp: "MCP",
  token_window: "token",
};

export const PROVIDER_NAME: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  zai: "Z.AI",
  openrouter: "OpenRouter",
};

export function providerDisplayName(id: string): string {
  return PROVIDER_NAME[id] ?? id;
}

export function windowPhrase(window: string): string {
  return WINDOW_PHRASE[window] ?? window.replaceAll("_", " ");
}

/**
 * Authoritative quota windows carried on usage points (`quota_window` set by an adapter).
 * Transcript estimates are omitted — they do not know the provider's reset clock.
 */
/** Rolling vs fixed is a property of the window type, known from the provider's mechanics. */
const WINDOW_KIND: Record<string, "rolling" | "fixed" | null> = {
  five_hour: "rolling",
  weekly: "fixed",
  monthly: "fixed",
  mcp: "fixed",
  token_window: null,
};

/**
 * A window with no reset time is a gap, not a zero: the reason says why the clock is missing.
 * An expired provider timestamp is passed through as-is — it is never rolled forward and
 * presented as confirmed; a passed stamp is not evidence the allowance recovered.
 */
function resetOf(p: UsagePoint): WindowReset {
  const resetsAt = p.reset_at;
  if (resetsAt !== null) {
    return { resetsAt, basis: "provider-reported", reason: null, windowKind: WINDOW_KIND[p.quota_window ?? ""] ?? null };
  }
  const windowKind = WINDOW_KIND[p.quota_window ?? ""] ?? null;
  if (p.stale === true) {
    return { resetsAt: null, basis: "unavailable", reason: "stale-data", windowKind };
  }
  // Percentage-only windows (e.g. Z.AI's 5h coding window) simply do not expose a clock.
  if (p.used_percent !== undefined && p.used_percent !== null && p.limit === null) {
    return { resetsAt: null, basis: "unavailable", reason: "provider-does-not-expose", windowKind };
  }
  return { resetsAt: null, basis: "unavailable", reason: "unknown", windowKind };
}

export function windowsFromPoints(points: UsagePoint[]): Array<OverviewWindow & { provider: string }> {
  const best = new Map<string, OverviewWindow & { provider: string }>();
  for (const p of points) {
    const window = p.quota_window;
    if (window === undefined || window === null || window === "") continue;
    const usedPercent = p.used_percent !== undefined && p.used_percent !== null
      ? p.used_percent
      : p.unit === "percent"
        ? p.used
        : null;
    const reset = resetOf(p);
    const next: OverviewWindow & { provider: string } = {
      id: `${p.provider}|${window}`,
      provider: p.provider,
      window,
      scope: p.label,
      model: p.model,
      unit: p.unit,
      used: p.used,
      limit: p.limit,
      remaining: p.remaining,
      usedPercent,
      capturedAt: p.captured_at,
      source: p.source ?? "unknown",
      stale: p.stale === true,
      resetsAt: reset.resetsAt,
      reset,
    };
    const key = `${p.provider}|${window}`;
    const prev = best.get(key);
    if (prev === undefined || preferWindow(next, prev)) best.set(key, next);
  }
  return [...best.values()];
}

function preferWindow(next: OverviewWindow, prev: OverviewWindow): boolean {
  if (next.stale !== prev.stale) return !next.stale;
  if ((next.reset.resetsAt !== null) !== (prev.reset.resetsAt !== null)) return next.reset.resetsAt !== null;
  if ((next.usedPercent !== null) !== (prev.usedPercent !== null)) return next.usedPercent !== null;
  return false;
}
