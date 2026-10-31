import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { serveStatic } from "hono/bun";
import type { Adapter, ProviderNote, StatusNote, UsagePoint } from "./adapters/types";
import type { AuditEventRow, Db, SessionRow } from "./db";
import {
  appendSubscription,
  type BillingPeriod,
  DEFAULT_SUBSCRIPTIONS_PATH,
  loadSubscriptions,
  removeSubscription,
  setSubscriptionOrder,
  SubscriptionCatalog,
  SubscriptionConfigError,
  type CurrencyTotal,
  type Subscription,
  type SubscriptionEntry,
  type SubscriptionState,
  type SubscriptionUpdate,
  updateSubscription,
} from "./subscriptions";
import {
  appendModel,
  DEFAULT_MODELS_PATH,
  loadModels,
  ModelCatalog,
  ModelConfigError,
  ModelExistsError,
  ModelNotFoundError,
  removeModel,
  setModelOrder,
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
import { registerProviderRoutes, type ProviderRouteDeps } from "./api-providers";

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

export function buildApi(deps: ProviderRouteDeps & {
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
  const subscriptionsPath = () => env.MODELIZER_SUBSCRIPTIONS?.trim() || DEFAULT_SUBSCRIPTIONS_PATH;
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
    const planRows = new Map(readSubscriptions(db, subscriptionsPath(), now()).rows.map((r) => [r.provider, r]));
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

  registerProviderRoutes(app, { ...deps, now });

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

  /**
   * Remove a model from the catalogue by id (URL-encoded in the path). Removal is textual, so it
   * works even when the rest of the file is currently unparsable; only a missing entry fails.
   */
  app.delete("/api/models/:id", (c) => {
    const path = modelsPath();
    let id: string;
    try {
      id = decodeURIComponent(c.req.param("id"));
    } catch {
      return c.json({ error: "the model id must be URL-encoded" }, 400);
    }
    try {
      removeModel(id, path);
      return c.json({ removed: id, path });
    } catch (err) {
      if (err instanceof ModelNotFoundError) return c.json({ error: (err as Error).message }, 404);
      const message = (err as Error).message;
      return c.json({ error: `could not remove the model: ${message}` }, 422);
    }
  });

  /**
   * Reorder the catalogue: the ids come in display sequence, the first getting `order = 1`.
   * Ids not listed keep their current order and sort after the ranked ones, by name.
   */
  app.put("/api/models/order", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { ids?: unknown } | null;
    const ids = Array.isArray(body?.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
    const path = modelsPath();
    try {
      setModelOrder(ids, path);
      return c.json({ ordered: ids.length, path });
    } catch (err) {
      if (err instanceof ModelNotFoundError) return c.json({ error: (err as Error).message }, 404);
      return c.json({ error: `could not reorder: ${(err as Error).message}` }, 422);
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

  /** The saved overrides only — what the manage tab edits, without merged provider facts. */
  app.get("/api/subscriptions/config", (c) => {
    const path = subscriptionsPath();
    try {
      const entries = loadSubscriptions(path);
      // The saved order is the display order: ranked blocks first, unranked after in file order
      // (stable sort), matching how SubscriptionCatalog.list() sequences the merged page.
      const ordered = entries
        .map((entry, index) => ({ entry, index }))
        .sort((a, b) => (a.entry.order ?? Number.MAX_SAFE_INTEGER) - (b.entry.order ?? Number.MAX_SAFE_INTEGER) || a.index - b.index)
        .map(({ entry }) => entry);
      return c.json({ path, entries: ordered });
    } catch (err) {
      const message = err instanceof SubscriptionConfigError ? err.message : `subscriptions: ${(err as Error).message}`;
      return c.json({ error: message }, 422);
    }
  });

  app.get("/api/subscriptions", (c) => {
    const view = readSubscriptions(db, subscriptionsPath(), now());
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

  /**
   * Reorder the saved entries: providers arrive in display sequence, the first getting
   * `order = 1`. Entries not listed keep the price sort after the ranked ones.
   */
  app.put("/api/subscriptions/order", async (c) => {
    const path = subscriptionsPath();
    try {
      const providers = readProviderList(await c.req.json().catch(() => null));
      if (new Set(providers).size !== providers.length) {
        return c.json({ error: "provider order contains duplicates" }, 409);
      }
      const entries = loadSubscriptions(path);
      const unknown = providers.filter((provider) => !entries.some((entry) => entry.provider === provider));
      if (unknown.length > 0) {
        return c.json({ error: `provider "${unknown[0] ?? ""}" is not configured` }, 404);
      }
      setSubscriptionOrder(providers, path);
      return c.json({ ordered: providers.length, path });
    } catch (err) {
      return subscriptionWriteError(c, err);
    }
  });

  /**
   * Add a `[[subscription]]` block. The response carries the saved entry itself, never a
   * merged page row — the caller already knows what the provider reported.
   */
  app.post("/api/subscriptions", async (c) => {
    const path = subscriptionsPath();
    try {
      const entry = readNewSubscription(await c.req.json().catch(() => null));
      if (loadSubscriptions(path).some((saved) => saved.provider === entry.provider)) {
        return c.json({ error: `provider "${entry.provider}" is already configured` }, 409);
      }
      appendSubscription(entry, path);
      const saved = loadSubscriptions(path).find((item) => item.provider === entry.provider);
      if (saved === undefined) return c.json({ error: "the saved entry did not appear in the file" }, 502);
      return c.json({ entry: saved, path }, 201);
    } catch (err) {
      return subscriptionWriteError(c, err);
    }
  });

  /**
   * Edit one saved block: a field absent from the body keeps its saved value; `null` — or
   * `""` for a text field — clears it. The response is the saved entry, not a merged row.
   */
  app.put("/api/subscriptions/:provider", async (c) => {
    const path = subscriptionsPath();
    try {
      const provider = decodeProvider(c.req.param("provider"));
      const changes = readSubscriptionChanges(await c.req.json().catch(() => null));
      if (!loadSubscriptions(path).some((entry) => entry.provider === provider)) {
        return c.json({ error: `provider "${provider}" is not configured` }, 404);
      }
      updateSubscription(provider, changes, path);
      const saved = loadSubscriptions(path).find((entry) => entry.provider === provider);
      if (saved === undefined) return c.json({ error: "the saved entry did not appear in the file" }, 502);
      return c.json({ entry: saved, path });
    } catch (err) {
      return subscriptionWriteError(c, err);
    }
  });

  /**
   * Remove the saved override only. A provider-detected plan lives in the DB facts and stays:
   * deleting an override cancels nothing, so the page still lists the row with its fact source.
   */
  app.delete("/api/subscriptions/:provider", (c) => {
    const path = subscriptionsPath();
    try {
      const provider = decodeProvider(c.req.param("provider"));
      if (!loadSubscriptions(path).some((entry) => entry.provider === provider)) {
        return c.json({ error: `provider "${provider}" is not configured` }, 404);
      }
      removeSubscription(provider, path);
      return c.json({ removed: provider, path });
    } catch (err) {
      return subscriptionWriteError(c, err);
    }
  });

  /** The UI compares this against its own build to warn about a server older than the page. */
  app.get("/api/version", (c) =>
    c.json({
      server: "modelizer",
      startedAt: now().toISOString(),
      routes: ["overview", "subscriptions-config", "changes", "providers-manage", "version"],
    }),
  );

  /**
   * Unknown API paths answer JSON, never the SPA fallback: a server older than the page
   * must produce a readable "restart" error in the UI, not an HTML blob the fetch helper
   * chokes on.
   */
  app.all("/api/*", (c) => c.json({ error: "no such API route" }, 404));

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
function readSubscriptions(db: Db, configPath: string, at: Date): SubscriptionView {
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

/** A subscription route failure that already knows its HTTP status. */
class SubscriptionRouteError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 422) {
    super(message);
  }
}

/**
 * Map a failed subscription write the way the models routes map theirs: request-shape errors
 * keep their status (400/404/409), write-layer rejections — bad values, an unparsable file —
 * are 422. One request, one answer: nothing here retries or cascades.
 */
function subscriptionWriteError(c: Context, err: unknown): Response {
  if (err instanceof SubscriptionRouteError) return c.json({ error: err.message }, err.status);
  if (err instanceof SubscriptionConfigError) return c.json({ error: err.message }, 422);
  return c.json({ error: `could not save the subscription: ${(err as Error).message}` }, 422);
}

/** Entry fields the routes copy as plain strings; the enum pair gets its own checks below. */
const SUBSCRIPTION_TEXT_FIELDS = ["plan", "label", "note", "currency", "renewsAt", "endsAt"] as const;
/** Entry fields the routes copy as numbers. */
const SUBSCRIPTION_NUMBER_FIELDS = ["order", "price", "priceNext", "renewsDay", "seats"] as const;
const PERIOD_VALUES = "monthly or annual";
const STATE_VALUES = "one of active, trialing, cancelled, past_due, unknown";

/** The period and state sets the TOML layer accepts, mirrored so subscriptions.ts stays untouched. */
const BILLING_PERIODS = ["monthly", "annual"] as const;
const SUBSCRIPTION_STATES = ["active", "trialing", "cancelled", "past_due", "unknown"] as const;

function isBillingPeriod(value: string): value is BillingPeriod {
  return (BILLING_PERIODS as readonly string[]).includes(value);
}

function isSubscriptionState(value: string): value is SubscriptionState {
  return (SUBSCRIPTION_STATES as readonly string[]).includes(value);
}

/** The request body as a field bag; a body that is not a JSON object is refused outright. */
function subscriptionBody(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new SubscriptionRouteError("the request body must be a JSON object", 400);
  }
  return body as Record<string, unknown>;
}

/**
 * One text field as tri-state: undefined = absent from the body, null = clear (explicit null
 * or an empty string), otherwise the value. A wrong JSON type is a 400.
 */
function optionalTextField(fields: Record<string, unknown>, field: string): string | null | undefined {
  const value = fields[field];
  if (value === undefined || value === null || value === "") return value === "" ? null : value;
  if (typeof value !== "string") throw new SubscriptionRouteError(`${field} must be a string`, 400);
  return value;
}

/** One number field, same tri-state convention; an empty string is not a number, so 400. */
function optionalNumberField(fields: Record<string, unknown>, field: string): number | null | undefined {
  const value = fields[field];
  if (value === undefined || value === null) return value;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SubscriptionRouteError(`${field} must be a number`, 400);
  }
  return value;
}

/** One enum-restricted field, same tri-state convention; a value outside the set is a 422. */
function optionalEnumField<T extends string>(
  fields: Record<string, unknown>,
  field: string,
  guard: (value: string) => value is T,
  expected: string,
): T | null | undefined {
  const value = fields[field];
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") throw new SubscriptionRouteError(`${field} must be a string`, 400);
  if (value === "") return null;
  if (!guard(value)) throw new SubscriptionRouteError(`${field} must be ${expected}`, 422);
  return value;
}

/** The entry a POST appends: `provider` plus every field worth saving (clears mean "leave unset"). */
function readNewSubscription(body: unknown): SubscriptionEntry {
  const fields = subscriptionBody(body);
  const provider = typeof fields.provider === "string" ? fields.provider.trim() : "";
  if (provider === "") {
    throw new SubscriptionRouteError("provider is required and must be a non-empty string", 400);
  }
  const entry: SubscriptionEntry = { provider };
  for (const field of SUBSCRIPTION_TEXT_FIELDS) {
    const value = optionalTextField(fields, field);
    if (value !== null && value !== undefined) entry[field] = value;
  }
  for (const field of SUBSCRIPTION_NUMBER_FIELDS) {
    const value = optionalNumberField(fields, field);
    if (value !== null && value !== undefined) entry[field] = value;
  }
  const period = optionalEnumField(fields, "period", isBillingPeriod, PERIOD_VALUES);
  if (period !== null && period !== undefined) entry.period = period;
  const state = optionalEnumField(fields, "state", isSubscriptionState, STATE_VALUES);
  if (state !== null && state !== undefined) entry.state = state;
  return entry;
}

/** The field changes a PUT applies: absent = keep the saved value, null or "" = clear it. */
function readSubscriptionChanges(body: unknown): SubscriptionUpdate {
  const fields = subscriptionBody(body);
  const changes: SubscriptionUpdate = {};
  for (const field of SUBSCRIPTION_TEXT_FIELDS) {
    const value = optionalTextField(fields, field);
    if (value !== undefined) changes[field] = value;
  }
  for (const field of SUBSCRIPTION_NUMBER_FIELDS) {
    const value = optionalNumberField(fields, field);
    if (value !== undefined) changes[field] = value;
  }
  const period = optionalEnumField(fields, "period", isBillingPeriod, PERIOD_VALUES);
  if (period !== undefined) changes.period = period;
  const state = optionalEnumField(fields, "state", isSubscriptionState, STATE_VALUES);
  if (state !== undefined) changes.state = state;
  return changes;
}

/** The `providers` array of an order request, in the wanted display sequence. */
function readProviderList(body: unknown): string[] {
  const list = subscriptionBody(body).providers;
  if (!Array.isArray(list)) throw new SubscriptionRouteError("providers must be an array of provider ids", 400);
  const providers = list.filter((id): id is string => typeof id === "string" && id.trim() !== "");
  if (providers.length !== list.length) {
    throw new SubscriptionRouteError("providers must be an array of provider ids", 400);
  }
  return providers.map((id) => id.trim());
}

/** The :provider path parameter, decoded like the model ids; bad percent-encoding is a 400. */
function decodeProvider(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new SubscriptionRouteError("the provider id must be URL-encoded", 400);
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
