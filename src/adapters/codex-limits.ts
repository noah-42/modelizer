import { windowFromMinutes } from "../windows";

export type CodexLimitSource = "app-server" | "session-log";

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowMinutes: number;
  /** ISO instant, or null when the log did not say when the window ends. */
  resetsAt: string | null;
  source: CodexLimitSource;
}

export interface CodexRateLimits {
  observedAt: string;
  planType: string | null;
  /** Raw slots, kept for the archived summary. Windows are classified in `byWindow`. */
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  byWindow: Partial<Record<"five_hour" | "weekly", CodexRateLimitWindow>>;
}

/**
 * Session-log `token_count` payload. `resets_at` is unix seconds.
 * Older builds omit it and send `resets_in_seconds` relative to the event timestamp.
 * A null `rate_limits` (codex exec sometimes writes that) is not a snapshot.
 */
export function parseSessionRateLimits(
  rl: Record<string, unknown>,
  observedTs: number,
): CodexRateLimits | null {
  const primary = readLogWindow(rl.primary, observedTs, "session-log");
  const secondary = readLogWindow(rl.secondary, observedTs, "session-log");
  if (primary === null && secondary === null) return null;
  return {
    observedAt: new Date(observedTs).toISOString(),
    planType: typeof rl.plan_type === "string" ? rl.plan_type : typeof rl.planType === "string" ? rl.planType : null,
    primary,
    secondary,
    byWindow: classify(primary, secondary),
  };
}

/** `account/rateLimits/read` result. CamelCase fields per the app-server docs; snake_case accepted too. */
export function parseAppServerRateLimits(result: unknown, observedAt: string): CodexRateLimits | null {
  const root = unwrapResult(result);
  if (root === null) return null;

  const ordered: Record<string, unknown>[] = [];
  const byId = root.rateLimitsByLimitId ?? root.rate_limits_by_limit_id;
  if (byId !== null && typeof byId === "object") {
    const map = byId as Record<string, unknown>;
    if (map.codex !== null && typeof map.codex === "object") ordered.push(map.codex as Record<string, unknown>);
  }
  const top = root.rateLimits ?? root.rate_limits;
  if (top !== null && typeof top === "object") ordered.push(top as Record<string, unknown>);
  if (byId !== null && typeof byId === "object") {
    for (const [key, value] of Object.entries(byId as Record<string, unknown>)) {
      if (key === "codex") continue;
      if (value !== null && typeof value === "object") ordered.push(value as Record<string, unknown>);
    }
  }

  let primary: CodexRateLimitWindow | null = null;
  let secondary: CodexRateLimitWindow | null = null;
  let planType: string | null = null;
  const byWindow: CodexRateLimits["byWindow"] = {};
  for (const bucket of ordered) {
    const p = readAppWindow(bucket.primary);
    const s = readAppWindow(bucket.secondary);
    if (primary === null && p) primary = p;
    if (secondary === null && s) secondary = s;
    if (planType === null) {
      if (typeof bucket.planType === "string") planType = bucket.planType;
      else if (typeof bucket.plan_type === "string") planType = bucket.plan_type;
    }
    for (const slot of [p, s]) {
      if (slot === null) continue;
      const kind = windowFromMinutes(slot.windowMinutes);
      if ((kind === "five_hour" || kind === "weekly") && byWindow[kind] === undefined) byWindow[kind] = slot;
    }
  }
  if (primary === null && secondary === null && byWindow.five_hour === undefined && byWindow.weekly === undefined) {
    return null;
  }
  return { observedAt, planType, primary, secondary, byWindow };
}

/** Live app-server windows win per kind; logs fill anything the RPC did not return. */
export function mergeRateLimits(log: CodexRateLimits | null, live: CodexRateLimits | null): CodexRateLimits | null {
  if (live === null || (live.byWindow.five_hour === undefined && live.byWindow.weekly === undefined)) return log;
  if (log === null) return live;
  const byWindow: CodexRateLimits["byWindow"] = { ...log.byWindow };
  if (live.byWindow.five_hour) byWindow.five_hour = live.byWindow.five_hour;
  if (live.byWindow.weekly) byWindow.weekly = live.byWindow.weekly;
  return {
    observedAt: live.observedAt,
    planType: live.planType ?? log.planType,
    primary: live.primary ?? log.primary,
    secondary: live.secondary ?? log.secondary,
    byWindow,
  };
}

function classify(
  primary: CodexRateLimitWindow | null,
  secondary: CodexRateLimitWindow | null,
): CodexRateLimits["byWindow"] {
  const byWindow: CodexRateLimits["byWindow"] = {};
  for (const slot of [primary, secondary]) {
    if (slot === null) continue;
    const kind = windowFromMinutes(slot.windowMinutes);
    if (kind === "five_hour" || kind === "weekly") byWindow[kind] = slot;
  }
  return byWindow;
}

function readLogWindow(v: unknown, observedTs: number, source: CodexLimitSource): CodexRateLimitWindow | null {
  if (v === null || typeof v !== "object") return null;
  const w = v as Record<string, unknown>;
  const used = num(w.used_percent ?? w.usedPercent);
  const minutes = num(w.window_minutes ?? w.windowMinutes ?? w.window_duration_mins ?? w.windowDurationMins);
  if (used === null || minutes === null) return null;
  return { usedPercent: used, windowMinutes: minutes, resetsAt: resetsFromLog(w, observedTs), source };
}

function readAppWindow(v: unknown): CodexRateLimitWindow | null {
  if (v === null || typeof v !== "object") return null;
  const w = v as Record<string, unknown>;
  const used = num(w.usedPercent ?? w.used_percent);
  const minutes = num(w.windowDurationMins ?? w.window_duration_mins ?? w.window_minutes ?? w.windowMinutes);
  if (used === null || minutes === null) return null;
  return { usedPercent: used, windowMinutes: minutes, resetsAt: resetsFromAbsolute(w.resetsAt ?? w.resets_at), source: "app-server" };
}

function resetsFromLog(w: Record<string, unknown>, observedTs: number): string | null {
  const absolute = resetsFromAbsolute(w.resets_at ?? w.resetsAt);
  if (absolute !== null) return absolute;
  const rel = num(w.resets_in_seconds ?? w.resetsInSeconds);
  if (rel === null) return null;
  return new Date(observedTs + rel * 1000).toISOString();
}

function resetsFromAbsolute(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v > 1e12 ? v : v * 1000).toISOString();
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Date.parse(v))) return new Date(Date.parse(v)).toISOString();
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function unwrapResult(result: unknown): Record<string, unknown> | null {
  if (result === null || typeof result !== "object") return null;
  const root = result as Record<string, unknown>;
  if (root.result !== null && typeof root.result === "object" && (root.rateLimits === undefined && root.rate_limits === undefined)) {
    return root.result as Record<string, unknown>;
  }
  return root;
}
