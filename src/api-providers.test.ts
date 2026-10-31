import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApi } from "./api";
import { zaiAdapter } from "./adapters/zai";
import { claudeAdapter } from "./adapters/claude";
import { authJsonPath } from "./adapters/codex";
import type { ProviderAuth } from "./provider-auth";
import { loadConfig } from "./config";
import { openDb } from "./db";
import { Scheduler } from "./scheduler";
import { credentialStatus, refreshCredentials, resolveEnv, type SecurityRunner, type TokenStatus } from "./secrets";

const AT = "2026-10-30T12:00:00.000Z";
const SUBMITTED = "test-only-submitted-credential";
const REPLACEMENT = "test-only-replacement-credential";
const ENV_TOKEN = "test-only-environment-credential";
const TOKEN_PATH = "/api/providers/zai/tokens/ZAI_API_KEY";
const OAUTH_PATH = "/api/providers/claude/oauth-usage";
const APP_TOKEN = "test-only-app-owned-credential";
const cleanups: Array<() => void> = [];
const noProviderFetch: typeof fetch = Object.assign(
  async (): Promise<Response> => { throw new TypeError("Provider calls are forbidden in management tests"); },
  { preconnect: () => { throw new TypeError("Provider connections are forbidden in management tests"); } },
);

interface ManagedProvider extends ProviderAuth {
  id: string;
  displayName: string;
  enabled: boolean;
  order: number;
  missingCredentials: string[];
  tokens: Record<string, TokenStatus>;
  authHealth: string;
}
interface ManageResponse {
  providers: ManagedProvider[];
  tokens: Record<string, TokenStatus>;
}

function fakeSecurity() {
  const store = new Map<string, string>();
  const commands: string[] = [];
  const run: SecurityRunner = (args) => {
    const name = args[args.indexOf("-a") + 1] ?? "";
    const command = args[0] ?? "";
    commands.push(command);
    if (command === "add-generic-password") {
      store.set(name, args[args.indexOf("-w") + 1] ?? "");
      return { status: 0, stdout: "" };
    }
    if (command === "delete-generic-password") return { status: store.delete(name) ? 0 : 44, stdout: "" };
    return { status: store.has(name) ? 0 : 44, stdout: store.get(name) ?? "" };
  };
  return { store, commands, run };
}

function appWith(base: Record<string, string | undefined> = {}) {
  const root = mkdtempSync(join(tmpdir(), "modelizer-providers-"));
  const path = join(root, "modelizer.toml");
  writeFileSync(path, '# preserved comment\norder = ["zai", "openrouter"]\n[server]\nport = 7788\n[providers.zai]\nenabled = true\n');
  const db = openDb(join(root, "test.db"));
  cleanups.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const security = fakeSecurity();
  const secretOptions = { platform: "darwin", run: security.run } as const;
  const env = resolveEnv({
    CLAUDE_PROJECTS_DIR: join(root, "claude", "projects"),
    CODEX_SESSIONS_DIR: join(root, "codex", "sessions"),
    CURSOR_STATE_DB: join(root, "state.vscdb"),
    FREELLMAPI_DB: join(root, "freeapi.db"),
    ...base,
  }, secretOptions);
  writeFileSync(join(root, "freeapi.db"), "");
  let changes = 0;
  const app = buildApi({
    db, adapters: [], env: {}, envRef: env, configPath: path, secretOptions,
    now: () => new Date(AT), onProvidersChanged: () => { changes += 1; },
    fetchFn: noProviderFetch,
  });
  return { app, db, env, path, root, security, secretOptions, changes: () => changes };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function writeRequest(method: string, body?: unknown): RequestInit {
  return { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) };
}

async function listing(h: ReturnType<typeof appWith>): Promise<ManageResponse> {
  const response = await h.app.request("/api/providers/manage");
  expect(response.status).toBe(200);
  return JSON.parse(await response.text());
}

function row(data: ManageResponse, id = "zai"): ManagedProvider {
  const provider = data.providers.find((p) => p.id === id);
  if (!provider) throw new TypeError(`Missing fixture provider ${id}`);
  return provider;
}

async function safeBody(response: Response, status = 200): Promise<string> {
  const text = await response.text();
  expect(response.status).toBe(status);
  for (const token of [SUBMITTED, REPLACEMENT, ENV_TOKEN, APP_TOKEN]) expect(text).not.toContain(token);
  expect(text).not.toMatch(/"value"\s*:/);
  return text;
}

describe("provider management", () => {
  test("the listing describes every adapter using its actual authentication source", async () => {
    const h = appWith();
    const data = await listing(h);
    expect(Object.fromEntries(data.providers.map((provider) => [provider.id, provider.authMethod]))).toEqual({
      zai: "api-key", openrouter: "api-key", moonshot: "api-key",
      claude: "app: Claude Code login", codex: "app: ChatGPT login", cursor: "app: Cursor login",
      freellmapi: "app: FreeLLMAPI local ledger",
    });
    for (const id of ["zai", "openrouter", "moonshot"]) {
      expect(row(data, id).appAuthPresent).toBeUndefined();
      expect(row(data, id).oauthUsageEnabled).toBeUndefined();
    }
    expect(row(data, "claude").oauthUsageEnabled).toBe(false);
  });

  test("absent app sources report no token even when historical polls succeeded", async () => {
    const h = appWith();
    mkdirSync(join(h.root, "codex", "sessions"), { recursive: true });
    for (const id of ["claude", "codex", "cursor"]) h.db.updateAdapterState(id, { ok: true, at: AT });
    const data = await listing(h);
    for (const id of ["claude", "codex", "cursor"]) {
      expect(row(data, id).appAuthPresent).toBe(false);
      expect(row(data, id).authHealth).toBe("no-token");
    }
  });

  test("app presence checks expose only booleans and preserve app owned credential files", async () => {
    const h = appWith();
    mkdirSync(join(h.root, "claude", "projects"), { recursive: true });
    mkdirSync(join(h.root, "codex", "sessions"), { recursive: true });
    const authPath = authJsonPath(h.env);
    const statePath = join(h.root, "state.vscdb");
    // Opaque contents prove listing needs existence, not parsing or opening app credentials.
    for (const path of [authPath, statePath]) writeFileSync(path, APP_TOKEN);
    h.security.store.set("ANTHROPIC_ADMIN_API_KEY", APP_TOKEN);
    refreshCredentials(h.env, h.secretOptions);
    for (const id of ["claude", "codex", "cursor"]) h.db.updateAdapterState(id, { ok: true, at: AT });
    const data: ManageResponse = JSON.parse(await safeBody(await h.app.request("/api/providers/manage")));
    for (const id of ["claude", "codex", "cursor", "freellmapi"]) expect(row(data, id).appAuthPresent).toBe(true);
    for (const id of ["claude", "codex", "cursor"]) expect(row(data, id).authHealth).toBe("ok");
    for (const path of [authPath, statePath]) expect(readFileSync(path, "utf8")).toBe(APP_TOKEN);
    expect(h.security.commands.every((command) => command === "find-generic-password")).toBe(true);
  });

  test.each([true, false])("setting Claude OAuth usage to %s changes only the shared process flag", async (enabled) => {
    const h = appWith({ CLAUDE_OAUTH_USAGE: enabled ? "0" : "1", CLAUDE_OAUTH_TOKEN: APP_TOKEN });
    mkdirSync(join(h.root, "claude", "projects"), { recursive: true });
    const originalEnv = { ...h.env };
    const originalConfig = readFileSync(h.path, "utf8");
    const originalDb = h.db.raw.serialize();
    const commands = [...h.security.commands];
    const seen: Array<string | undefined> = [];
    const adapter = { ...claudeAdapter, collect: async (ctx: Parameters<typeof claudeAdapter.collect>[0]) => {
      seen.push(ctx.env.CLAUDE_OAUTH_USAGE);
      return [];
    }, normalize: () => [] };
    const scheduler = new Scheduler({ db: h.db, adapters: [adapter], env: h.env, clock: () => new Date(AT) });

    const response = await safeBody(await h.app.request(OAUTH_PATH, writeRequest("PUT", { enabled })));

    expect(JSON.parse(response)).toEqual({ id: "claude", oauthUsageEnabled: enabled });
    expect(h.env).toEqual({ ...originalEnv, CLAUDE_OAUTH_USAGE: enabled ? "1" : "0" });
    expect(readFileSync(h.path, "utf8")).toBe(originalConfig);
    expect(h.db.raw.serialize()).toEqual(originalDb);
    expect(h.security.commands).toEqual(commands);
    expect(h.security.store.size).toBe(0);
    expect(h.changes()).toBe(0);
    await scheduler.runProvider("claude");
    expect(seen).toEqual([enabled ? "1" : "0"]);
    expect(row(await listing(h), "claude").oauthUsageEnabled).toBe(enabled);
    refreshCredentials(h.env, h.secretOptions);
    expect(h.env.CLAUDE_OAUTH_USAGE).toBe(enabled ? "1" : "0");
  });

  test("invalid Claude OAuth usage input leaves the process flag untouched", async () => {
    const h = appWith({ CLAUDE_OAUTH_USAGE: "1" });
    const commands = [...h.security.commands];
    for (const body of [{ enabled: "yes" }, {}, null]) {
      await safeBody(await h.app.request(OAUTH_PATH, writeRequest("PUT", body)), 400);
    }
    await safeBody(await h.app.request(OAUTH_PATH, { method: "PUT", body: "{" }), 400);
    expect(h.env.CLAUDE_OAUTH_USAGE).toBe("1");
    expect(h.security.commands).toEqual(commands);
  });

  test("the listing exposes only credential status for every managed secret", async () => {
    const h = appWith({ ZAI_API_KEY: ENV_TOKEN });
    const text = await safeBody(await h.app.request("/api/providers/manage"));
    const data: ManageResponse = JSON.parse(text);
    expect(row(data).tokens.ZAI_API_KEY).toEqual({ set: true, source: "env", shadowed: false });
    expect(data.tokens.MODELIZER_WEBHOOK_SECRET).toEqual({ set: false, source: "absent", shadowed: false });
    expect(row(data, "openrouter").missingCredentials).toEqual(["OPENROUTER_API_KEY"]);
    expect(h.security.commands.every((command) => command === "find-generic-password")).toBe(true);
  });

  test.each([
    ["HTTP 401: quota endpoint unauthorized", "rejected"],
    ["HTTP 403 forbidden", "rejected"],
    ["HTTP 429: quota exhausted", "quota"],
    ["quota exhausted", "quota"],
    ["network unavailable", "unknown"],
  ])("stored error %s is classified as %s without collection", async (error, expected) => {
    const h = appWith({ ZAI_API_KEY: ENV_TOKEN });
    h.db.updateAdapterState("zai", { ok: false, error, at: AT });
    expect(row(await listing(h)).authHealth).toBe(expected);
  });

  test("fresh success is healthy while never polled and stale success stay unknown", async () => {
    const h = appWith({ ZAI_API_KEY: ENV_TOKEN });
    expect(row(await listing(h)).authHealth).toBe("unknown");
    h.db.updateAdapterState("zai", { ok: true, at: AT });
    expect(row(await listing(h)).authHealth).toBe("ok");
    h.db.updateAdapterState("zai", { ok: true, at: "2020-01-01T00:00:00Z" });
    expect(row(await listing(h)).authHealth).toBe("unknown");
  });

  test("absent credentials take precedence over historical success", async () => {
    const h = appWith();
    h.db.updateAdapterState("zai", { ok: true, at: AT });
    expect(row(await listing(h)).authHealth).toBe("no-token");
  });

  test("enablement and order round trip through the configured TOML path", async () => {
    const h = appWith();
    await safeBody(await h.app.request("/api/providers/zai/enabled", writeRequest("PUT", { enabled: false })));
    await safeBody(await h.app.request("/api/providers/order", writeRequest("PUT", { ids: ["moonshot", "zai"] })));
    const config = loadConfig(h.path);
    expect(config.providers.zai?.enabled).toBe(false);
    expect(config.order).toEqual(["moonshot", "zai"]);
    const data = await listing(h);
    expect(data.providers.slice(0, 2).map((p) => p.id)).toEqual(["moonshot", "zai"]);
    expect(row(data).enabled).toBe(false);
    expect(h.changes()).toBe(2);
    expect(readFileSync(h.path, "utf8")).toContain("# preserved comment");
  });

  test("removing an integration preserves tokens and all observation tables", async () => {
    const h = appWith({ ZAI_API_KEY: ENV_TOKEN });
    h.security.store.set("ZAI_API_KEY", SUBMITTED);
    const subscriptionsPath = join(h.root, "subscriptions.toml");
    const modelsPath = join(h.root, "models.toml");
    const subscriptions = '[[subscription]]\nprovider = "zai"\nprice = 10\n';
    const models = '[[model]]\nid = "fixture"\nprovider = "zai"\n';
    writeFileSync(subscriptionsPath, subscriptions);
    writeFileSync(modelsPath, models);
    h.db.updateAdapterState("zai", { ok: false, error: "HTTP 429", at: AT });
    const state = h.db.getAdapterState("zai");
    const before = h.db.raw.serialize();
    await safeBody(await h.app.request("/api/providers/zai", writeRequest("DELETE")));
    expect(loadConfig(h.path).providers.zai?.enabled).toBe(false);
    expect(loadConfig(h.path).order).not.toContain("zai");
    expect(h.db.getAdapterState("zai")).toEqual(state);
    expect(h.db.raw.serialize()).toEqual(before);
    expect(h.env.ZAI_API_KEY).toBe(ENV_TOKEN);
    expect(h.security.store.get("ZAI_API_KEY")).toBe(SUBMITTED);
    expect(readFileSync(subscriptionsPath, "utf8")).toBe(subscriptions);
    expect(readFileSync(modelsPath, "utf8")).toBe(models);
    expect(h.security.commands).not.toContain("delete-generic-password");
    expect(h.changes()).toBe(1);
  });

  test("adding replacing and removing a token changes the next poll in the same process", async () => {
    const h = appWith();
    const seen: Array<string | undefined> = [];
    const adapter = { ...zaiAdapter, collect: async (ctx: Parameters<typeof zaiAdapter.collect>[0]) => {
      seen.push(ctx.env.ZAI_API_KEY);
      return [];
    }, normalize: () => [] };
    const scheduler = new Scheduler({ db: h.db, adapters: [adapter], env: h.env, clock: () => new Date(AT) });
    const added = await safeBody(await h.app.request(TOKEN_PATH, writeRequest("POST", { value: SUBMITTED })));
    expect(JSON.parse(added)).toEqual({ set: true, source: "keychain", shadowed: false });
    expect(resolveEnv({}, h.secretOptions).ZAI_API_KEY).toBe(SUBMITTED);
    await scheduler.runProvider("zai");
    await safeBody(await h.app.request(TOKEN_PATH, writeRequest("PUT", { value: REPLACEMENT })));
    await scheduler.runProvider("zai");
    expect(seen).toEqual([SUBMITTED, REPLACEMENT]);
    await safeBody(await h.app.request(TOKEN_PATH, writeRequest("DELETE")));
    const outcome = await scheduler.runProvider("zai");
    expect(outcome.ok).toBe(false);
    expect(seen).toHaveLength(2);
    expect(h.env.ZAI_API_KEY).toBeUndefined();
    await safeBody(await h.app.request("/api/providers/manage"));
    expect(credentialStatus(h.env, "ZAI_API_KEY").source).toBe("absent");
  });

  test("adding a shadowed entry updates Keychain without replacing the environment value", async () => {
    const h = appWith({ ZAI_API_KEY: ENV_TOKEN });
    const response = await safeBody(await h.app.request(TOKEN_PATH, writeRequest("POST", { value: SUBMITTED })));
    expect(JSON.parse(response)).toMatchObject({ set: true, source: "env", shadowed: true });
    expect(h.env.ZAI_API_KEY).toBe(ENV_TOKEN);
    expect(h.security.store.get("ZAI_API_KEY")).toBe(SUBMITTED);
    expect(row(await listing(h)).tokens.ZAI_API_KEY?.shadowed).toBe(true);
    refreshCredentials(h.env);
    expect(h.env.ZAI_API_KEY).toBe(ENV_TOKEN);
  });

  test("environment supplied credentials cannot be removed or replaced", async () => {
    const h = appWith({ ZAI_API_KEY: ENV_TOKEN });
    await safeBody(await h.app.request(TOKEN_PATH, writeRequest("DELETE")), 409);
    await safeBody(await h.app.request(TOKEN_PATH, writeRequest("PUT", { value: SUBMITTED })), 409);
    expect(h.security.store.size).toBe(0);
    expect(h.env.ZAI_API_KEY).toBe(ENV_TOKEN);
  });

  test("invalid input is rejected without modifying provider configuration", async () => {
    const h = appWith();
    const original = readFileSync(h.path, "utf8");
    await safeBody(await h.app.request("/api/providers/zai/enabled", writeRequest("PUT", { enabled: "yes" })), 400);
    await safeBody(await h.app.request("/api/providers/order", writeRequest("PUT", { ids: ["zai", 3] })), 400);
    await safeBody(await h.app.request("/api/providers/order", writeRequest("PUT", { ids: ["zai", "zai"] })), 409);
    await safeBody(await h.app.request("/api/providers/unknown/enabled", writeRequest("PUT", { enabled: true })), 404);
    await safeBody(await h.app.request("/api/providers/order", writeRequest("PUT", { ids: ["unknown"] })), 404);
    await safeBody(await h.app.request(TOKEN_PATH, writeRequest("POST", { value: "" })), 400);
    await safeBody(await h.app.request("/api/providers/zai/tokens/CLAUDE_OAUTH_TOKEN", writeRequest("DELETE")), 404);
    expect(readFileSync(h.path, "utf8")).toBe(original);
    expect(h.changes()).toBe(0);
  });
});
