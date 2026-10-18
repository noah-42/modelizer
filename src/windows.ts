import type { UsagePoint } from "./adapters/types";

/** Quota window names exposed on `/api/overview` and in reset notices. */
export type KnownWindow = "five_hour" | "weekly" | "monthly" | "mcp" | "token_window";

export interface OverviewWindow {
  window: string;
  usedPercent: number | null;
  resetsAt: string | null;
  source: string;
  stale: boolean;
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
    const next: OverviewWindow & { provider: string } = {
      provider: p.provider,
      window,
      usedPercent,
      resetsAt: p.reset_at,
      source: p.source ?? "unknown",
      stale: p.stale === true,
    };
    const key = `${p.provider}|${window}`;
    const prev = best.get(key);
    if (prev === undefined || preferWindow(next, prev)) best.set(key, next);
  }
  return [...best.values()];
}

function preferWindow(next: OverviewWindow, prev: OverviewWindow): boolean {
  if (next.stale !== prev.stale) return !next.stale;
  if ((next.resetsAt !== null) !== (prev.resetsAt !== null)) return next.resetsAt !== null;
  if ((next.usedPercent !== null) !== (prev.usedPercent !== null)) return next.usedPercent !== null;
  return false;
}
