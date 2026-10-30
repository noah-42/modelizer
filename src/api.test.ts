import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { buildApi } from "./api";
import { openDb } from "./db";
import { loadSubscriptions, type SubscriptionEntry, type SubscriptionFacts } from "./subscriptions";

const root = mkdtempSync(join(tmpdir(), "modelizer-api-"));
const db = openDb(join(root, "api.db"));
const subscriptionsFile = join(root, "subscriptions.toml");
afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** An app pointed at a fresh temp subscriptions.toml via MODELIZER_SUBSCRIPTIONS (the api-auth harness pattern). */
function appWith(config = ""): Hono {
  writeFileSync(subscriptionsFile, config);
  return buildApi({ db, adapters: [], env: { MODELIZER_SUBSCRIPTIONS: subscriptionsFile } });
}

/** One API call; a body travels as JSON. No token is configured, so every caller is trusted. */
async function call(app: Hono, method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit =
    body === undefined
      ? { method }
      : { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } };
  return app.request(path, init, undefined, undefined as never);
}

/** Provider-stated facts, as a poll would have stored them. */
function cursorFacts(): SubscriptionFacts {
  return {
    provider: "cursor",
    planId: "pro",
    planName: "Cursor Pro",
    state: "active",
    period: null,
    renewsAt: null,
    seats: null,
    source: "cursor-api",
  };
}

describe("subscription routes", () => {
  test("creates a block and reads it back as the saved entry and a page row", async () => {
    const app = appWith("");
    const res = await call(app, "POST", "/api/subscriptions", {
      provider: "claude",
      label: "Pro",
      price: 20,
      currency: "usd",
      period: "monthly",
      renewsDay: 13,
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { entry: SubscriptionEntry; path: string };
    expect(created.entry).toEqual({
      provider: "claude",
      label: "Pro",
      price: 20,
      currency: "USD",
      period: "monthly",
      renewsDay: 13,
    });
    expect(created.path).toBe(subscriptionsFile);
    expect(loadSubscriptions(subscriptionsFile)).toEqual([created.entry]);

    const view = (await (await call(app, "GET", "/api/subscriptions")).json()) as {
      configPath: string;
      subscriptions: Array<{ provider: string; source: string; configured: boolean; price: number | null }>;
    };
    expect(view.configPath).toBe(subscriptionsFile);
    expect(view.subscriptions.find((row) => row.provider === "claude")).toMatchObject({
      source: "config",
      configured: true,
      price: 20,
    });
  });

  test("updates single fields, keeps absent ones, and returns the saved entry", async () => {
    const config = [
      "[[subscription]]",
      'provider = "claude"',
      'label = "Pro"',
      "price = 20",
      "renews_day = 13",
      "",
      "[[subscription]]",
      'provider = "cursor"',
      "price = 60",
      "",
    ].join("\n");
    const app = appWith(config);
    const res = await call(app, "PUT", "/api/subscriptions/claude", { price: 25, note: "intro rate" });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as { entry: unknown; path: string };
    expect(updated.entry).toEqual({
      provider: "claude",
      label: "Pro",
      price: 25,
      renewsDay: 13,
      note: "intro rate",
    });
    expect(updated.path).toBe(subscriptionsFile);
    expect(loadSubscriptions(subscriptionsFile).find((entry) => entry.provider === "cursor")).toEqual({
      provider: "cursor",
      price: 60,
    });
  });

  test("clears fields on explicit null or empty string without writing empties", async () => {
    const config = [
      "[[subscription]]",
      'provider = "claude"',
      'label = "Pro"',
      'note = "old"',
      'period = "annual"',
      "price = 20",
      "renews_day = 13",
      "",
    ].join("\n");
    const app = appWith(config);
    const res = await call(app, "PUT", "/api/subscriptions/claude", { label: null, note: "", period: null });
    expect(res.status).toBe(200);
    expect(loadSubscriptions(subscriptionsFile)).toEqual([{ provider: "claude", price: 20, renewsDay: 13 }]);
    expect(readFileSync(subscriptionsFile, "utf8")).not.toContain('label = ""');
  });

  test("delete removes only the saved block and leaves a fact-backed row listed", async () => {
    db.upsertSubscriptionFacts("cursor", cursorFacts(), "2026-10-30T00:00:00.000Z");
    const app = appWith('[[subscription]]\nprovider = "cursor"\nprice = 60\n');
    const removed = await call(app, "DELETE", "/api/subscriptions/cursor");
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: "cursor", path: subscriptionsFile });
    expect(loadSubscriptions(subscriptionsFile)).toEqual([]);
    const view = (await (await call(app, "GET", "/api/subscriptions")).json()) as {
      subscriptions: Array<{ provider: string; source: string; configured: boolean }>;
    };
    const row = view.subscriptions.find((entry) => entry.provider === "cursor");
    expect(row).toMatchObject({ source: "cursor-api", configured: false });
    expect(row?.source).not.toBe("config");
  });

  test("reorders saved entries and leaves unlisted ones to the price sort", async () => {
    const config = [
      "[[subscription]]",
      'provider = "claude"',
      "price = 20",
      "",
      "[[subscription]]",
      'provider = "cursor"',
      "price = 60",
      "",
      "[[subscription]]",
      'provider = "codex"',
      "price = 200",
      "",
    ].join("\n");
    const app = appWith(config);
    const res = await call(app, "PUT", "/api/subscriptions/order", { providers: ["cursor", "claude"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ordered: 2, path: subscriptionsFile });
    expect(loadSubscriptions(subscriptionsFile)).toEqual([
      { provider: "claude", price: 20, order: 2 },
      { provider: "cursor", price: 60, order: 1 },
      { provider: "codex", price: 200 },
    ]);
    const view = (await (await call(app, "GET", "/api/subscriptions")).json()) as {
      subscriptions: Array<{ provider: string }>;
    };
    expect(view.subscriptions.map((row) => row.provider)).toEqual(["cursor", "claude", "codex"]);
  });
});

describe("subscription route errors", () => {
  test("refuses bodies that are not JSON objects, miss a provider, or mistype a field", async () => {
    const app = appWith("");
    const malformed = await app.request("/api/subscriptions", { method: "POST", body: "not json" });
    expect(malformed.status).toBe(400);
    expect((await call(app, "POST", "/api/subscriptions", { price: 20 })).status).toBe(400);
    expect((await call(app, "POST", "/api/subscriptions", { provider: "claude", price: "20" })).status).toBe(400);
    expect((await call(app, "PUT", "/api/subscriptions/order", { providers: "claude" })).status).toBe(400);
    expect((await call(app, "PUT", "/api/subscriptions/order", { providers: ["claude", 7] })).status).toBe(400);
  });

  test("answers 404 when the provider is not saved", async () => {
    const app = appWith("");
    expect((await call(app, "PUT", "/api/subscriptions/ghost", { price: 20 })).status).toBe(404);
    expect((await call(app, "DELETE", "/api/subscriptions/ghost")).status).toBe(404);
    expect((await call(app, "PUT", "/api/subscriptions/order", { providers: ["ghost"] })).status).toBe(404);
  });

  test("answers 409 on a duplicate add or a duplicate order, leaving the file untouched", async () => {
    const config = '[[subscription]]\nprovider = "claude"\nprice = 20\n';
    const app = appWith(config);
    const duplicate = await call(app, "POST", "/api/subscriptions", { provider: "claude", price: 25 });
    expect(duplicate.status).toBe(409);
    expect((await call(app, "PUT", "/api/subscriptions/order", { providers: ["claude", "claude"] })).status).toBe(409);
    expect(readFileSync(subscriptionsFile, "utf8")).toBe(config);
  });

  test("answers 422 when values fail the TOML parse rules or the file is broken", async () => {
    const app = appWith("");
    const priced = await call(app, "POST", "/api/subscriptions", { provider: "claude", price: -1 });
    expect(priced.status).toBe(422);
    expect(((await priced.json()) as { error: string }).error).toContain("price must be >= 0");
    expect((await call(app, "POST", "/api/subscriptions", { provider: "claude", period: "weekly" })).status).toBe(422);
    expect((await call(app, "POST", "/api/subscriptions", { provider: "claude", currency: "US" })).status).toBe(422);
    expect((await call(app, "POST", "/api/subscriptions", { provider: "claude", renewsDay: 32 })).status).toBe(422);

    const broken = "not = [valid toml";
    const brokenApp = appWith(broken);
    expect((await call(brokenApp, "POST", "/api/subscriptions", { provider: "claude" })).status).toBe(422);
    expect(readFileSync(subscriptionsFile, "utf8")).toBe(broken);
  });

  test("lists the saved overrides only via /api/subscriptions/config", async () => {
    const app = appWith('[[subscription]]\nprovider = "cursor"\nprice = 60\n');
    const res = await call(app, "GET", "/api/subscriptions/config");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; entries: SubscriptionEntry[] };
    expect(body.entries).toEqual([{ provider: "cursor", price: 60 }]);
    expect(body.path).toBe(subscriptionsFile);
  });

  test("surfaces a broken file from /api/subscriptions/config with the parse error", async () => {
    const app = appWith("[[subscription]]\nnope\n");
    const res = await call(app, "GET", "/api/subscriptions/config");
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/subscriptions/);
  });
});
