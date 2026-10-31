import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { expect as pwExpect } from "playwright/test";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Playwright (todo 4 of MOD004): the built UI, pointed at a mocked API, shows the
// `auth failed` badge and the reason line when lastError carries the `auth:` prefix,
// and the generic failing badge when it does not.

const WEB_DIST = join(import.meta.dir, "..", "web", "dist");

function providerFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "zai",
    stabilityTier: 2,
    pollEverySeconds: 900,
    configured: true,
    lastSuccess: "2026-10-31T00:22:18.726Z",
    lastError: "auth: ZAI_API_KEY rejected by api.z.ai (code 1000 Authentication Failed) — generate a new key and update it (keychain: modelizer / ZAI_API_KEY)",
    lastErrorAt: "2026-10-31T15:01:37.870Z",
    consecutiveFailures: 98,
    stale: true,
    status: [],
    notes: [],
    degradedEndpoints: [],
    points: [],
    windows: [],
    subscription: null,
    planOnly: false,
    ...overrides,
  };
}

function overviewFixture(providers: unknown[]) {
  return JSON.stringify({ generatedAt: "2026-10-31T15:11:03.510Z", providers });
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

function serveDist(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/api/")) {
        const body =
          url.pathname === "/api/version"
            ? JSON.stringify({ build: "test" })
            : url.pathname === "/api/overview"
              ? overviewFixture(
                  (req.headers.get("referer") ?? "").includes("generic")
                    ? [providerFixture({ id: "zai", lastError: "zai: no usable data", consecutiveFailures: 3 })]
                    : [providerFixture()],
                )
              : url.pathname === "/api/changes"
                ? JSON.stringify({ generatedAt: "t", changes: [], error: null })
                : url.pathname === "/api/subscriptions"
                  ? JSON.stringify({ generatedAt: "t", configPath: "t", totals: [], subscriptions: [], error: null })
                  : url.pathname === "/api/models"
                    ? JSON.stringify({ generatedAt: "t", path: "t", models: [], error: null })
                    : JSON.stringify({});
        return new Response(body, { headers: { "content-type": "application/json" } });
      }
      const rel = url.pathname === "/" ? "/index.html" : url.pathname;
      try {
        const file = join(WEB_DIST, rel);
        statSync(file);
        const ext = rel.slice(rel.lastIndexOf("."));
        return new Response(readFileSync(file), {
          headers: { "content-type": MIME[ext] ?? "application/octet-stream" },
        });
      } catch {
        return new Response("not found", { status: 404 });
      }
    },
  });
}

describe("auth failure UI", () => {
  let server: ReturnType<typeof Bun.serve>;
  let browser: Browser;

  beforeAll(async () => {
    readdirSync(WEB_DIST); // throws (and fails the suite) when the web bundle has not been built
    server = serveDist();
    browser = await chromium.launch();
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  test("auth:-prefixed error renders the `auth failed` badge and the reason", async () => {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/`);
    const badge = page.locator(".badge.bad", { hasText: "auth failed" });
    await pwExpect(badge).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: /ZAI/ }).click(); // expand the collapsed card
    const card = page.locator(".card-error", { hasText: "ZAI_API_KEY rejected" });
    await pwExpect(card).toBeVisible();
    await pwExpect(card).not.toContainText("auth:");
    await page.close();
  });

  test("a generic error keeps the failing badge and no auth: styling", async () => {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/?generic`);
    await pwExpect(page.locator(".badge.bad", { hasText: "failing ×3" })).toBeVisible({ timeout: 10_000 });
    await pwExpect(page.locator(".badge.bad", { hasText: "auth failed" })).toHaveCount(0);
    await page.getByRole("button", { name: /ZAI/ }).click();
    await pwExpect(page.locator(".card-error", { hasText: "no usable data" })).toBeVisible();
    await page.close();
  });
});
