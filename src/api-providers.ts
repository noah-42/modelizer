import type { Hono } from "hono";
import { ADAPTERS, ADAPTERS_BY_ID } from "./adapters";
import type { Adapter } from "./adapters/types";
import { loadConfig, setProviderEnabled, setProviderOrder } from "./config";
import type { AdapterStateRow, Db } from "./db";
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
  configPath?: string;
  now?: () => Date;
}

const DISPLAY_NAMES: Record<string, string> = {
  zai: "Z.AI", claude: "Claude", cursor: "Cursor", codex: "Codex",
  openrouter: "OpenRouter", freellmapi: "FreeLLMAPI", moonshot: "Moonshot",
};
const PROVIDER_SECRETS: Record<string, readonly SecretName[]> = {
  zai: ["ZAI_API_KEY"], openrouter: ["OPENROUTER_API_KEY", "OPENROUTER_MANAGEMENT_KEY"],
  moonshot: ["MOONSHOT_API_KEY"], claude: ["ANTHROPIC_ADMIN_API_KEY"], codex: ["OPENAI_ADMIN_API_KEY"],
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
  app.get("/api/providers/manage", (c) => {
    try {
      const config = loadConfig(configPath());
      const ids = [...new Set([...(config.order ?? []), ...ADAPTERS.map((a) => a.id)])];
      const tokens = Object.fromEntries(SECRET_NAMES.map((name) => [name, credentialStatus(env, name)]));
      const providers = ids.flatMap((id, index) => {
        const adapter = ADAPTERS_BY_ID.get(id);
        if (!adapter) return [];
        return [{
          id, displayName: DISPLAY_NAMES[id] ?? id, enabled: config.providers[id]?.enabled === true,
          order: index + 1, missingCredentials: adapter.missingCredentials(env),
          tokens: Object.fromEntries((PROVIDER_SECRETS[id] ?? []).map((name) => [name, credentialStatus(env, name)])),
          authHealth: authHealth(adapter, env, deps.db.getAdapterState(id), now()),
        }];
      });
      return c.json({ providers, tokens });
    } catch {
      return c.json({ error: "Could not read provider configuration" }, 422);
    }
  });

  app.put("/api/providers/order", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (!isObject(body) || !Array.isArray(body.ids) || !body.ids.every((id): id is string => typeof id === "string"))
      return c.json({ error: "ids must be an array of provider ids" }, 400);
    if (body.ids.some((id) => !ADAPTERS_BY_ID.has(id))) return c.json({ error: "Unknown provider" }, 404);
    if (new Set(body.ids).size !== body.ids.length) return c.json({ error: "Duplicate provider ids" }, 409);
    try {
      loadConfig(configPath());
      setProviderOrder(body.ids, configPath());
      await deps.onProvidersChanged?.();
      return c.json({ ids: body.ids });
    } catch {
      return c.json({ error: "Could not reorder providers" }, 422);
    }
  });

  app.put("/api/providers/:id/enabled", async (c) => {
    const id = c.req.param("id");
    if (!ADAPTERS_BY_ID.has(id)) return c.json({ error: "Unknown provider" }, 404);
    const body: unknown = await c.req.json().catch(() => null);
    if (!isObject(body) || typeof body.enabled !== "boolean") return c.json({ error: "enabled must be a boolean" }, 400);
    try {
      loadConfig(configPath());
      setProviderEnabled(id, body.enabled, configPath());
      await deps.onProvidersChanged?.();
      return c.json({ id, enabled: body.enabled });
    } catch {
      return c.json({ error: "Could not update provider" }, 422);
    }
  });

  app.delete("/api/providers/:id", async (c) => {
    const id = c.req.param("id");
    if (!ADAPTERS_BY_ID.has(id)) return c.json({ error: "Unknown provider" }, 404);
    try {
      const config = loadConfig(configPath());
      setProviderEnabled(id, false, configPath());
      setProviderOrder((config.order ?? []).filter((saved) => saved !== id), configPath());
      await deps.onProvidersChanged?.();
      return c.json({ id, enabled: false });
    } catch {
      return c.json({ error: "Could not remove provider" }, 422);
    }
  });

  app.on(["POST", "PUT", "DELETE"], "/api/providers/:id/tokens/:name", async (c) => {
    const id = c.req.param("id");
    const name = secretName(c.req.param("name"));
    if (!ADAPTERS_BY_ID.has(id) || !name || !(PROVIDER_SECRETS[id] ?? []).includes(name))
      return c.json({ error: "Unknown provider credential" }, 404);
    const status = credentialStatus(env, name);
    const method = c.req.method;
    // POST stores a shadowed Keychain entry; PUT replaces the effective credential.
    if (status.source === "env" && method !== "POST")
      return c.json({ error: "Credential is read-only while supplied by the environment" }, 409);
    const body: unknown = method === "DELETE" ? null : await c.req.json().catch(() => null);
    if (method !== "DELETE" && (!isObject(body) || typeof body.value !== "string" || body.value.trim() === ""))
      return c.json({ error: "A nonempty credential value is required" }, 400);
    try {
      if (method === "DELETE") removeSecret(name, options);
      else if (isObject(body) && typeof body.value === "string") writeSecret(name, body.value, options);
      refreshCredentials(env, options);
      const updated = credentialStatus(env, name);
      return c.json({
        ...updated,
        ...(updated.shadowed ? { message: "shadowed by environment" } : {}),
      });
    } catch (error) {
      if (error instanceof KeychainError) return c.json({ error: error.message }, 422);
      return c.json({ error: "Could not refresh credentials" }, 422);
    }
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
