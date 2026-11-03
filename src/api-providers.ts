import type { Hono } from "hono";
import { ADAPTERS, ADAPTERS_BY_ID } from "./adapters";
import type { Adapter } from "./adapters/types";
import { loadConfig, setProviderEnabled, setProviderMeta, setProviderOrder, type ProviderMeta } from "./config";
import type { AdapterStateRow, Db } from "./db";
import { providerAuth, type AuthMethod } from "./provider-auth";
import {
  allManageProviderIds,
  COLLECTOR_NO_SUBSCRIPTION_MESSAGE,
  COLLECTOR_PENDING_MESSAGE,
  isKnownProviderId,
  manageDisplayName,
  PENDING_BY_ID,
} from "./provider-registry";
import { DEFAULT_SUBSCRIPTIONS_PATH, loadSubscriptions } from "./subscriptions";
import {
  credentialStatus, KeychainError, refreshCredentials, removeSecret, SECRET_NAMES, writeSecret,
  type SecretName, type SecretOptions,
} from "./secrets";

export interface ProviderRouteDeps {
  db: Db;
  env: Record<string, string | undefined>;
  adapters: Adapter[];
  envRef?: Record<string, string | undefined>;
  onProvidersChanged?: () => void | Promise<void>;
  secretOptions?: SecretOptions;
  /** Injectable fetch for write-time credential validation; tests stub this to stay hermetic. */
  fetchFn?: typeof fetch;
  configPath?: string;
  now?: () => Date;
  /** Same path the subscriptions API uses — manage rows stay aligned with dashboard cards. */
  subscriptionsPath?: () => string;
}

const PROVIDER_SECRETS: Record<string, readonly SecretName[]> = {
  zai: ["ZAI_API_KEY"], openrouter: ["OPENROUTER_API_KEY", "OPENROUTER_MANAGEMENT_KEY"],
  moonshot: ["MOONSHOT_API_KEY"], claude: ["ANTHROPIC_ADMIN_API_KEY"], codex: ["OPENAI_ADMIN_API_KEY"],
  // Cursor locked its local state.vscdb token behind cursor-safe-storage encryption; a
  // user-supplied dashboard API key is the supported credential path now.
  cursor: ["CURSOR_API_KEY"],
  xai: ["XAI_API_KEY"],
};
const STALE_POLL_MULTIPLIER = 3;

function authHealth(adapter: Adapter, env: Record<string, string | undefined>, state: AdapterStateRow | undefined, at: Date) {
  if (!adapter.isConfigured(env)) return "no-token";
  const error = state?.last_error ?? "";
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden/i.test(error)) return "rejected";
  if (/\b429\b|quota|rate.?limit|too many requests/i.test(error)) return "quota";
  if (error === "" && state?.last_success &&
    at.getTime() - Date.parse(state.last_success) <= STALE_POLL_MULTIPLIER * adapter.pollEveryMs) return "ok";
  return "unknown";
}

function secretName(input: string): SecretName | undefined {
  return SECRET_NAMES.find((name) => name === input);
}

/** Register local management routes; reads never collect usage or validate tokens remotely. */
export function registerProviderRoutes(app: Hono, deps: ProviderRouteDeps): void {
  const env = deps.envRef ?? deps.env;
  const configPath = () => deps.configPath ?? (env.MODELIZER_CONFIG?.trim() || "modelizer.toml");
  const options = deps.secretOptions ?? {};
  const now = deps.now ?? (() => new Date());
  /** One user-made change for the changelog; token rows carry status, never values. */
  const record = (kind: "provider" | "token", target: string, action: string, detail?: Record<string, unknown>) =>
    deps.db.addChange(now().toISOString(), kind, target, action, detail === undefined ? undefined : JSON.stringify(detail));
  app.get("/api/providers/manage", (c) => {
    try {
      const config = loadConfig(configPath());
      const subsPath = deps.subscriptionsPath?.() ?? (env.MODELIZER_SUBSCRIPTIONS?.trim() || DEFAULT_SUBSCRIPTIONS_PATH);
      const savedSubs = loadSubscriptions(subsPath);
      const subsById = new Map(savedSubs.map((s) => [s.provider, s]));
      const enabledPollIds = new Set(
        ADAPTERS.filter((a) => config.providers[a.id]?.enabled === true).map((a) => a.id),
      );
      const ids = allManageProviderIds(config.order, savedSubs.map((s) => s.provider));
      const tokens = Object.fromEntries(SECRET_NAMES.map((name) => [name, credentialStatus(env, name)]));
      const providers = ids.flatMap((id, index) => {
        const adapter = ADAPTERS_BY_ID.get(id);
        const pending = PENDING_BY_ID.get(id);
        const savedSub = subsById.get(id);
        if (!adapter && !pending && savedSub === undefined) return [];
        const enabled = config.providers[id]?.enabled === true;
        const onDashboard = enabledPollIds.has(id) || (savedSub !== undefined && !enabledPollIds.has(id));
        const statusNotes: string[] = [];
        if (pending) {
          statusNotes.push(COLLECTOR_PENDING_MESSAGE);
          if (savedSub === undefined) statusNotes.push(COLLECTOR_NO_SUBSCRIPTION_MESSAGE);
        } else if (adapter === undefined && savedSub !== undefined) {
          statusNotes.push(COLLECTOR_PENDING_MESSAGE);
        }
        if (adapter && enabled) {
          const state = deps.db.getAdapterState(id);
          if (state?.last_error) statusNotes.push(state.last_error);
        }
        const auth = adapter
          ? providerAuth(adapter, env)
          : pending
            ? { authMethod: pending.authMethod }
            : { authMethod: "app: subscriptions.toml" as AuthMethod, appAuthPresent: true };
        const missing = adapter ? adapter.missingCredentials(env) : [];
        const meta = config.providers[id] ?? {};
        return [{
          id,
          displayName: meta.displayName ?? manageDisplayName(id),
          companyName: meta.companyName ?? null,
          companyLinkedIn: meta.companyLinkedIn ?? null,
          companyWebsite: meta.companyWebsite ?? null,
          companyX: meta.companyX ?? null,
          enabled,
          onDashboard,
          canEnable: isKnownProviderId(id),
          statusNotes,
          order: index + 1,
          missingCredentials: missing,
          tokens: Object.fromEntries((PROVIDER_SECRETS[id] ?? []).map((name) => [name, credentialStatus(env, name)])),
          ...auth,
          authHealth: adapter
            ? (auth.appAuthPresent === false ? "no-token" : authHealth(adapter, env, deps.db.getAdapterState(id), now()))
            : "unknown",
        }];
      });
      return c.json({ providers, tokens });
    } catch {
      return c.json({ error: "Could not read provider configuration" }, 422);
    }
  });

  app.put("/api/providers/claude/oauth-usage", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (!isObject(body) || typeof body.enabled !== "boolean")
      return c.json({ error: "enabled must be a boolean" }, 400);
    // The scheduler shares this process-local snapshot; no credential refresh or config write is needed.
    env.CLAUDE_OAUTH_USAGE = body.enabled ? "1" : "0";
    record("provider", "claude", "oauth", { enabled: body.enabled });
    return c.json({ id: "claude", oauthUsageEnabled: body.enabled });
  });

  app.put("/api/providers/order", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (!isObject(body) || !Array.isArray(body.ids) || !body.ids.every((id): id is string => typeof id === "string"))
      return c.json({ error: "ids must be an array of provider ids" }, 400);
    if (body.ids.some((id) => !isKnownProviderId(id))) return c.json({ error: "Unknown provider" }, 404);
    if (new Set(body.ids).size !== body.ids.length) return c.json({ error: "Duplicate provider ids" }, 409);
    try {
      loadConfig(configPath());
      setProviderOrder(body.ids, configPath());
      record("provider", body.ids.join(", "), "reorder", { order: body.ids });
      await deps.onProvidersChanged?.();
      return c.json({ ids: body.ids });
    } catch {
      return c.json({ error: "Could not reorder providers" }, 422);
    }
  });

  app.put("/api/providers/:id/enabled", async (c) => {
    const id = c.req.param("id");
    if (!isKnownProviderId(id)) return c.json({ error: "Unknown provider" }, 404);
    const body: unknown = await c.req.json().catch(() => null);
    if (!isObject(body) || typeof body.enabled !== "boolean") return c.json({ error: "enabled must be a boolean" }, 400);
    try {
      loadConfig(configPath());
      setProviderEnabled(id, body.enabled, configPath());
      record("provider", id, body.enabled ? "enable" : "disable", { enabled: body.enabled });
      await deps.onProvidersChanged?.();
      return c.json({ id, enabled: body.enabled });
    } catch {
      return c.json({ error: "Could not update provider" }, 422);
    }
  });

  app.put("/api/providers/:id/meta", async (c) => {
    const id = c.req.param("id");
    if (!isKnownProviderId(id)) return c.json({ error: `unknown provider ${id}` }, 404);
    const body = await c.req.json().catch(() => null);
    if (body === null || typeof body !== "object") return c.json({ error: "expected a JSON body" }, 400);
    const raw = body as Record<string, unknown>;
    const meta: ProviderMeta = {};
    for (const key of ["displayName", "companyName", "companyLinkedIn", "companyWebsite", "companyX"] as const) {
      const v = raw[key];
      if (v === undefined || v === null) continue;
      if (typeof v !== "string") return c.json({ error: `${key} must be a string` }, 400);
      meta[key] = v;
    }
    try {
      setProviderMeta(id, meta, configPath());
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "could not write provider metadata" }, 422);
    }
  });

  app.delete("/api/providers/:id", async (c) => {
    const id = c.req.param("id");
    if (!isKnownProviderId(id)) return c.json({ error: "Unknown provider" }, 404);
    try {
      const config = loadConfig(configPath());
      setProviderEnabled(id, false, configPath());
      setProviderOrder((config.order ?? []).filter((saved) => saved !== id), configPath());
      record("provider", id, "remove", { enabled: false });
      await deps.onProvidersChanged?.();
      return c.json({ id, enabled: false });
    } catch {
      return c.json({ error: "Could not remove provider" }, 422);
    }
  });

  app.on(["POST", "PUT", "DELETE"], "/api/providers/:id/tokens/:name", async (c) => {
    const id = c.req.param("id");
    const name = secretName(c.req.param("name"));
    // Registry-backed integrations (e.g. Grok/xAI, no collector yet) hold keys too — the check
    // is "known provider", not "has an adapter".
    if (!isKnownProviderId(id) || !name || !(PROVIDER_SECRETS[id] ?? []).includes(name))
      return c.json({ error: "Unknown provider credential" }, 404);
    const status = credentialStatus(env, name);
    const method = c.req.method;
    // POST stores a shadowed Keychain entry; PUT replaces the effective credential.
    if (status.source === "env" && method !== "POST")
      return c.json({ error: "Credential is read-only while supplied by the environment" }, 409);
    const body: unknown = method === "DELETE" ? null : await c.req.json().catch(() => null);
    if (method !== "DELETE" && (!isObject(body) || typeof body.value !== "string" || body.value.trim() === ""))
      return c.json({ error: "A nonempty credential value is required" }, 400);
    // Owner directive (2026-10-31): store the value verbatim — no provider round-trip,
    // no format gate. The value is still never echoed or logged.
    try {
      if (method === "DELETE") removeSecret(name, options);
      else if (isObject(body) && typeof body.value === "string") writeSecret(name, body.value, options);
      refreshCredentials(env, options);
      const updated = credentialStatus(env, name);
      // Status only — the submitted value never enters the change log.
      record("token", `${id}/${name}`, method === "DELETE" ? "remove" : "set", { source: updated.source });
      return c.json({
        ...updated,
        ...(updated.shadowed ? { message: "shadowed by environment" } : {}),
      });
    } catch (error) {
      if (error instanceof KeychainError) return c.json({ error: error.message }, 422);
      return c.json({ error: "Could not refresh credentials" }, 422);
    }
  });

  // Agent-blind verification: the process checks the stored credential against its provider
  // and reports only status — the value never appears in a request the caller can read.
  const VERIFY_TARGETS: Record<string, Array<{ url: string; auth: "bearer" | "basic"; label: string }>> = {
    XAI_API_KEY: [
      { url: "https://api.x.ai/v1/api-key", auth: "bearer", label: "x.ai" },
      { url: "https://api.x.ai/v1/models", auth: "bearer", label: "x.ai models" },
      { url: "https://grok.com/rest/rate-limits", auth: "bearer", label: "grok rate-limits" },
      { url: "https://grok.com/rest/subscription", auth: "bearer", label: "grok subscription" },
      { url: "https://grok.com/rest/workspace", auth: "bearer", label: "grok workspace" },
      { url: "https://grok.com/rest/api-keys/current", auth: "bearer", label: "grok api-keys" },
      { url: "https://api.cursor.com/v1/me", auth: "basic", label: "cursor api (basic)" },
      { url: "https://api.cursor.com/v1/me", auth: "bearer", label: "cursor api (bearer)" },
      { url: "https://api.cursor.com/v1/models", auth: "bearer", label: "cursor models" },
    ],
    CURSOR_API_KEY: [
      { url: "https://api2.cursor.sh/auth/full_stripe_profile", auth: "bearer", label: "cursor" },
      { url: "https://api.cursor.com/v1/me", auth: "basic", label: "cursor (agent api)" },
    ],
  };
  app.post("/api/providers/:id/tokens/:name/verify", async (c) => {
    const id = c.req.param("id");
    const name = secretName(c.req.param("name"));
    if (!isKnownProviderId(id) || !name || !(PROVIDER_SECRETS[id] ?? []).includes(name))
      return c.json({ error: "Unknown provider credential" }, 404);
    const targets = VERIFY_TARGETS[name];
    if (!targets) return c.json({ error: "No verification target for this credential" }, 422);
    const value = env[name]?.trim() ?? "";
    if (value === "") return c.json({ id, name, valid: false, status: 0, reason: "not set" });
    const results: Array<{ label: string; url: string; status: number; valid: boolean }> = [];
    for (const target of targets) {
      const headers: Record<string, string> = { Accept: "application/json" };
      headers.Authorization =
        target.auth === "basic" ? `Basic ${Buffer.from(`${value}:`).toString("base64")}` : `Bearer ${value}`;
      try {
        const res = await (deps.fetchFn ?? fetch)(target.url, { headers, signal: AbortSignal.timeout(15_000) });
        results.push({ label: target.label, url: target.url, status: res.status, valid: res.status === 200 });
        if (res.status === 200) break;
      } catch {
        results.push({ label: target.label, url: target.url, status: 0, valid: false });
      }
    }
    const accepted = results.find((r) => r.valid);
    let meKeys: string[] | undefined;
    if (accepted?.url.endsWith("/v1/me")) {
      try {
        const headers: Record<string, string> = { Accept: "application/json" };
        headers.Authorization =
          value.startsWith("grok_") && accepted.url.includes("api.cursor.com")
            ? `Basic ${Buffer.from(`${value}:`).toString("base64")}`
            : `Bearer ${value}`;
        const res = await (deps.fetchFn ?? fetch)(accepted.url, { headers, signal: AbortSignal.timeout(15_000) });
        const json: unknown = await res.json();
        if (typeof json === "object" && json !== null) meKeys = Object.keys(json as object);
      } catch { /* discovery is best-effort */ }
    }
    return c.json({ id, name, valid: Boolean(accepted), accepted: accepted ?? null, probed: results, meKeys });
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
