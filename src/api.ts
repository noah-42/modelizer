import { createHash } from "node:crypto";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import type { Adapter, ProviderNote, StatusNote, UsagePoint } from "./adapters/types";
import type { AuditEventRow, Db, SessionRow } from "./db";
import {
  DEFAULT_SUBSCRIPTIONS_PATH,
  loadSubscriptions,
  SubscriptionCatalog,
  SubscriptionConfigError,
  type CurrencyTotal,
  type Subscription,
} from "./subscriptions";
import {
  appendModel,
  DEFAULT_MODELS_PATH,
  loadModels,
  ModelCatalog,
  ModelConfigError,
  ModelExistsError,
  type LlmModel,
} from "./models";
import {
  fetchOpenRouterModel,
  normalizeProviderId,
  OpenRouterUnknownModelError,
  OpenRouterUrlError,
  parseModelRef,
} from "./openrouter";
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
  /**
   * True for a plan that is written down in subscriptions.toml but has no API to poll — a free
   * plan with nothing to meter. The card shows the plan and skips the polling chrome.
   */
  planOnly: boolean;
}

/** Model → provider associations from models.toml. */
export interface ModelsResponse {
  generatedAt: string;
  /** Which file the associations came from. */
  path: string;
  models: LlmModel[];
  /** Set when models.toml could not be parsed; the page shows it instead of the list. */
  error: string | null;
}

/** One page of the Subscriptions view: merged config + provider facts. */
export interface SubscriptionsResponse {
  generatedAt: string;
  /** Which file the price/renewal half came from. */
  configPath: string;
  /**
   * Monthly spend per currency for plans that keep charging. A plan that will not renew is out
   * of this figure — its row says so with `recurring: false`.
   */
  totals: CurrencyTotal[];
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

/** Compare in constant time, via a hash so differing lengths cannot leak timing. */
function hashesEqual(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return a.equals(b);
}

export function buildApi(deps: {
  db: Db;
  adapters: Adapter[];
  env: Record<string, string | undefined>;
  now?: () => Date;
  currentSessionId?: number;
  /** Injected so tests can answer the OpenRouter catalogue without leaving the process. */
  fetchFn?: typeof fetch;
  /** Shared secret for requests that do not come from this machine; absent means the API is open. */
  token?: string | undefined;
}): Hono {
  const { db, adapters, env } = deps;
  const now = deps.now ?? (() => new Date());
  const fetchFn = deps.fetchFn ?? fetch;
  const app = new Hono();
  const modelsPath = () => env.MODELIZER_MODELS?.trim() || DEFAULT_MODELS_PATH;
  const expectedToken = deps.token ?? env.MODELIZER_TOKEN?.trim() ?? "";

  /**
   * Local callers — the dashboard in a browser, scripts on this machine — are trusted. Everything
   * from further away must present the token, as `Authorization: Bearer …` or `?token=…`.
   */
  app.use("/api/*", async (c, next) => {
    if (expectedToken === "") return next();
    const address = (c.env as { ip?: { address?: string } | null } | undefined)?.ip?.address ?? "";
    if (address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1") return next();
    const header = c.req.header("authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : c.req.query("token") ?? "";
    if (given !== "" && hashesEqual(given, expectedToken)) return next();
    return c.json({ error: "unauthorized — pass the token as `Authorization: Bearer …` or `?token=…`" }, 401);
  });

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
        planOnly: false,
      };
    });
    // A plan with no adapter still belongs on the dashboard: it is something you are signed up to.
    const polled = new Set(adapters.map((a) => a.id));
    for (const row of planRows.values()) {
      if (!polled.has(row.provider)) providers.push(planOnlyProvider(row));
    }
    return c.json({ generatedAt: now().toISOString(), providers } satisfies Overview);
  });

  /** A card for a plan that has no endpoint behind it: the row and nothing pretending to poll. */
  function planOnlyProvider(subscription: Subscription): OverviewProvider {
    return {
      id: subscription.provider,
      stabilityTier: 0,
      pollEverySeconds: 0,
      configured: true,
      lastSuccess: null,
      lastError: null,
      lastErrorAt: null,
      consecutiveFailures: 0,
      stale: false,
      status: [],
      notes: [],
      degradedEndpoints: [],
      points: [],
      windows: [],
      subscription,
      planOnly: true,
    };
  }

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

  /**
   * Add a model to the catalogue from its OpenRouter link. The link supplies only the id; every
   * field written to models.toml comes from OpenRouter's catalogue endpoint.
   */
  app.post("/api/models", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { url?: unknown; provider?: unknown } | null;
    const input = typeof body?.url === "string" ? body.url : "";
    const provider = typeof body?.provider === "string" ? body.provider : undefined;
    const path = modelsPath();
    try {
      const model = await fetchOpenRouterModel(parseModelRef(input), fetchFn);
      model.provider = normalizeProviderId(provider);
      appendModel(model, path);
      return c.json({ model, path }, 201);
    } catch (err) {
      const message = (err as Error).message;
      if (err instanceof OpenRouterUrlError) return c.json({ error: message }, 400);
      if (err instanceof OpenRouterUnknownModelError) return c.json({ error: message }, 404);
      if (err instanceof ModelExistsError) return c.json({ error: message }, 409);
      if (err instanceof ModelConfigError) return c.json({ error: message }, 422);
      return c.json({ error: `could not add the model: ${message}` }, 502);
    }
  });

  app.get("/api/models", (c) => {
    const path = modelsPath();
    try {
      const models = new ModelCatalog(loadModels(path)).list();
      const body: ModelsResponse = { generatedAt: now().toISOString(), path, models, error: null };
      return c.json(body);
    } catch (err) {
      const message = err instanceof ModelConfigError ? err.message : `models: ${(err as Error).message}`;
      const broken: ModelsResponse = { generatedAt: now().toISOString(), path, models: [], error: message };
      return c.json(broken, 422);
    }
  });

  app.get("/api/subscriptions", (c) => {
    const view = readSubscriptions(db, env, now());
    const generatedAt = now().toISOString();
    if (view.error !== null) {
      const broken: SubscriptionsResponse = {
        generatedAt,
        configPath: view.configPath,
        totals: [],
        subscriptions: [],
        error: view.error,
      };
      return c.json(broken, 422);
    }
    const body: SubscriptionsResponse = {
      generatedAt,
      configPath: view.configPath,
      totals: view.totals,
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
  totals: CurrencyTotal[];
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
    return { rows: catalog.list(), totals: catalog.totals(), configPath, error: null };
  } catch (err) {
    const message = err instanceof SubscriptionConfigError ? err.message : `subscriptions: ${(err as Error).message}`;
    return { rows: [], totals: [], configPath, error: message };
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
