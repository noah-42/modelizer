import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import type { Adapter, ProviderNote, StatusNote, UsagePoint } from "./adapters/types";
import type { AuditEventRow, Db, SessionRow } from "./db";
import {
  DEFAULT_SUBSCRIPTIONS_PATH,
  loadSubscriptions,
  SubscriptionCatalog,
  SubscriptionConfigError,
  type Subscription,
} from "./subscriptions";
import { windowsFromPoints, type OverviewWindow } from "./windows";

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
  /** Authoritative quota windows (5h, weekly, …) for an outside assistant. */
  windows: OverviewWindow[];
  /** Plan/billing row from the Subscriptions page, when one exists for this provider. */
  subscription: Subscription | null;
}

/** One page of the Subscriptions view: merged config + provider facts. */
export interface SubscriptionsResponse {
  generatedAt: string;
  /** Which file the price/renewal half came from. */
  configPath: string;
  totalMonthlyUsd: number;
  subscriptions: Subscription[];
  /** Set when subscriptions.toml could not be parsed; the page shows it instead of rows. */
  error: string | null;
}

export interface DiaryEntry {
  kind: UsagePoint["kind"];
  label: string;
  model: string | null;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  unit: UsagePoint["unit"];
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

export interface Overview {
  generatedAt: string;
  providers: OverviewProvider[];
}

export function buildApi(deps: {
  db: Db;
  adapters: Adapter[];
  env: Record<string, string | undefined>;
  now?: () => Date;
  currentSessionId?: number;
}): Hono {
  const { db, adapters, env } = deps;
  const now = deps.now ?? (() => new Date());
  const app = new Hono();

  app.get("/api/overview", (c) => {
    const states = new Map(db.getAllAdapterStates().map((s) => [s.provider, s]));
    const latest = db.latestPoints();
    const planRows = new Map(readSubscriptions(db, env, now()).rows.map((r) => [r.provider, r]));
    const providers: OverviewProvider[] = adapters.map((a) => {
      const state = states.get(a.id);
      const pollEveryMs = a.pollEveryMs;
      const stale =
        state === undefined ||
        state.last_success === null ||
        now().getTime() - Date.parse(state.last_success) > 3 * pollEveryMs;
      // Which endpoints failed in the most recent poll batch (optional soft-fails included).
      const raws = db.lastRawPolls(a.id, 20);
      const latestBatch = raws[0]?.captured_at;
      const degradedEndpoints = raws
        .filter((r) => r.captured_at === latestBatch && (r.status < 200 || r.status >= 300))
        .map((r) => ({ endpoint: r.endpoint, status: r.status }));
      return {
        id: a.id,
        stabilityTier: a.stabilityTier,
        pollEverySeconds: Math.round(pollEveryMs / 1000),
        configured: a.isConfigured(env),
        lastSuccess: state?.last_success ?? null,
        lastError: state?.last_error ?? null,
        lastErrorAt: state?.last_error_at ?? null,
        consecutiveFailures: state?.consecutive_failures ?? 0,
        stale,
        status: [
          ...(a.liveStatus ? a.liveStatus(now()) : []),
          ...(a.statusHints?.(env) ?? []),
        ],
        notes: a.notes ?? [],
        degradedEndpoints,
        // Includes daily history rows (model-daily) — the UI renders those in a separate
        // per-model section rather than the main card rows.
        points: latest.filter((p) => p.provider === a.id),
        windows: windowsFromPoints(latest.filter((p) => p.provider === a.id)).map(
          ({ provider: _provider, ...window }) => window,
        ),
        subscription: planRows.get(a.id) ?? null,
      };
    });
    return c.json({ generatedAt: now().toISOString(), providers } satisfies Overview);
  });

  app.get("/api/providers/:id/raw", (c) => {
    const id = c.req.param("id");
    const limit = Math.min(Number(c.req.query("limit") ?? 10) || 10, 50);
    return c.json({ provider: id, polls: db.lastRawPolls(id, limit) });
  });

  app.get("/api/providers/:id/points", (c) => {
    const id = c.req.param("id");
    const days = Math.min(Number(c.req.query("days") ?? 30) || 30, 365);
    const since = new Date(now().getTime() - days * 86_400_000).toISOString();
    return c.json({ provider: id, points: db.pointsSince(id, since) });
  });

  app.get("/api/sessions", (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 30) || 30, 200);
    const sessions = db.listSessions(limit);
    return c.json({ currentSessionId: deps.currentSessionId ?? null, sessions });
  });

  app.get("/api/audit", (c) => {
    const sessionParam = c.req.query("session");
    const sessionId = sessionParam !== undefined && sessionParam !== "" ? Number(sessionParam) : undefined;
    const limit = Math.min(Number(c.req.query("limit") ?? 300) || 300, 2000);
    return c.json({
      events: db.auditEvents({ sessionId: Number.isFinite(sessionId) ? sessionId : undefined, limit }),
    });
  });

  app.get("/api/diary", (c) => {
    const days = Math.min(Number(c.req.query("days") ?? 14) || 14, 90);
    const since = new Date(now().getTime() - days * 86_400_000).toISOString();
    return c.json({ days: buildDiary(db, since) });
  });

  app.get("/api/subscriptions", (c) => {
    const view = readSubscriptions(db, env, now());
    const generatedAt = now().toISOString();
    if (view.error !== null) {
      const broken: SubscriptionsResponse = {
        generatedAt,
        configPath: view.configPath,
        totalMonthlyUsd: view.totalMonthlyUsd,
        subscriptions: [],
        error: view.error,
      };
      return c.json(broken, 422);
    }
    const body: SubscriptionsResponse = {
      generatedAt,
      configPath: view.configPath,
      totalMonthlyUsd: view.totalMonthlyUsd,
      subscriptions: view.rows,
      error: null,
    };
    return c.json(body);
  });

  app.use("*", serveStatic({ root: "./web/dist" }));
  app.get("*", serveStatic({ path: "./web/dist/index.html" }));

  return app;
}

interface SubscriptionView {
  rows: Subscription[];
  totalMonthlyUsd: number;
  configPath: string;
  error: string | null;
}

/**
 * Merge subscriptions.toml (price, renewal day) with the last plan facts each adapter stored
 * (plan, billing state). Never throws: a broken config becomes a message on the page.
 */
function readSubscriptions(db: Db, env: Record<string, string | undefined>, at: Date): SubscriptionView {
  const override = env.MODELIZER_SUBSCRIPTIONS?.trim();
  const configPath = override !== undefined && override !== "" ? override : DEFAULT_SUBSCRIPTIONS_PATH;
  try {
    const entries = loadSubscriptions(configPath);
    const facts = db.getSubscriptionFacts().map((row) => row.facts);
    const catalog = new SubscriptionCatalog(entries, facts, at);
    return { rows: catalog.list(), totalMonthlyUsd: catalog.totalMonthlyUsd(), configPath, error: null };
  } catch (err) {
    const message = err instanceof SubscriptionConfigError ? err.message : `subscriptions: ${(err as Error).message}`;
    return { rows: [], totalMonthlyUsd: 0, configPath, error: message };
  }
}

/**
 * Day-by-day usage journal. model-daily points are filed under their usage day (immutable
 * history); every other point under the local date it was captured, keeping the last
 * capture of the day per (provider, kind, label, model) — the day's closing value.
 */function buildDiary(db: Db, sinceIso: string): DiaryDay[] {
  const points = db.pointsAllSince(sinceIso);
  const events = db.auditEvents({ limit: 4000 });

  const dayOf = (p: UsagePoint): string =>
    p.day !== null ? p.day : new Date(p.captured_at).toISOString().slice(0, 10);

  const byDay = new Map<string, Map<string, DiaryEntry & { capturedAt: string }>>();
  for (const p of points) {
    const date = dayOf(p);
    const day = byDay.get(date) ?? new Map();
    const key = `${p.provider}|${p.kind}|${p.label}|${p.model ?? ""}`;
    const existing = day.get(key);
    if (existing === undefined || p.captured_at >= existing.capturedAt) {
      day.set(key, {
        kind: p.kind,
        label: p.label,
        model: p.model,
        used: p.used,
        limit: p.limit,
        remaining: p.remaining,
        unit: p.unit,
        capturedAt: p.captured_at,
      });
    }
    byDay.set(date, day);
  }

  const warnCounts = new Map<string, { warnings: number; errors: number }>();
  for (const e of events) {
    const date = e.at.slice(0, 10);
    const counts = warnCounts.get(date) ?? { warnings: 0, errors: 0 };
    if (e.level === "warn") counts.warnings += 1;
    if (e.level === "error") counts.errors += 1;
    warnCounts.set(date, counts);
  }

  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, entries]) => {
      const providersMap = new Map<string, DiaryEntry[]>();
      for (const [key, entry] of entries) {
        const provider = key.split("|")[0] ?? "?";
        const list = providersMap.get(provider) ?? [];
        list.push(entry);
        providersMap.set(provider, list);
      }
      const counts = warnCounts.get(date) ?? { warnings: 0, errors: 0 };
      return {
        date,
        providers: [...providersMap.entries()].map(([id, list]) => ({
          id,
          entries: list.sort((a, b) => (a.label < b.label ? -1 : 1)),
        })),
        warnings: counts.warnings,
        errors: counts.errors,
      };
    });
}
