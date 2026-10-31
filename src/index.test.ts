import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startModelizer } from "./index";
import { resolveEnv } from "./secrets";

async function providerIds(response: Response): Promise<string[]> {
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("providers" in body) || !Array.isArray(body.providers)) {
    throw new TypeError("Expected an overview provider list");
  }
  return body.providers.map((provider: unknown) => {
    if (typeof provider !== "object" || provider === null || !("id" in provider) || typeof provider.id !== "string") {
      throw new TypeError("Expected an overview provider id");
    }
    return provider.id;
  });
}

test("the server starts empty and applies provider enablement and saved order without restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "modelizer-runtime-"));
  const configPath = join(directory, "modelizer.toml");
  writeFileSync(configPath, '[server]\nport = 0\nbind = "127.0.0.1"\n');
  const env = resolveEnv({
    MODELIZER_CONFIG: configPath,
    MODELIZER_DB: join(directory, "test.db"),
    MODELIZER_SUBSCRIPTIONS: join(directory, "subscriptions.toml"),
    MODELIZER_MODELS: join(directory, "models.toml"),
  }, { platform: "linux" });
  const runtime = startModelizer(env);
  const base = `http://127.0.0.1:${runtime.server.port}`;
  const overviewIds = async () => providerIds(await fetch(`${base}/api/overview`));
  const put = async (path: string, body: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
  };
  try {
    expect(await overviewIds()).toEqual([]);
    for (const id of ["openrouter", "moonshot", "zai"]) {
      await put(`/api/providers/${id}/enabled`, { enabled: true });
      expect(runtime.scheduler.adapter(id)?.id).toBe(id);
    }
    await put("/api/providers/order", { ids: ["moonshot"] });
    expect(await overviewIds()).toEqual(["moonshot", "zai", "openrouter"]);
    await put("/api/providers/zai/enabled", { enabled: false });
    expect(runtime.scheduler.adapter("zai")).toBeUndefined();
    expect(await overviewIds()).toEqual(["moonshot", "openrouter"]);
    for (const id of ["moonshot", "openrouter"]) await put(`/api/providers/${id}/enabled`, { enabled: false });
    expect(await overviewIds()).toEqual([]);
    expect(await runtime.scheduler.tick()).toEqual([]);
    for (const id of ["openrouter", "moonshot", "zai"]) await put(`/api/providers/${id}/enabled`, { enabled: true });
  } finally {
    runtime.shutdown();
  }
  const restarted = startModelizer(env);
  try {
    const response = await fetch(`http://127.0.0.1:${restarted.server.port}/api/overview`);
    expect(await providerIds(response)).toEqual(["moonshot", "zai", "openrouter"]);
  } finally {
    restarted.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});
