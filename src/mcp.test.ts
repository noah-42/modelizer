import { afterAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.MODELIZER_URL = "http://127.0.0.1:4788";

const { createMcpServer } = await import("./mcp");

/** A stand-in for the modelizer API, shaped like the real endpoints. */
const app = new Hono()
  .get("/api/overview", (c) =>
    c.json({
      providers: [
        {
          id: "zai",
          configured: true,
          stale: false,
          lastError: null,
          lastSuccess: "2026-10-30T01:00:00Z",
          windows: [{ window: "monthly", usedPercent: 40, resetsAt: null, source: "zai-api", stale: false }],
          subscription: { plan: "coding", state: "active", price: 19, currency: "USD", renewsAt: "2026-11-05", endsAt: null, extra: "dropped" },
        },
        {
          id: "moonshot",
          configured: false,
          stale: false,
          lastError: "missing credentials: MOONSHOT_API_KEY",
          lastSuccess: null,
          windows: [],
          subscription: null,
        },
      ],
    }),
  )
  .get("/api/subscriptions", (c) => c.json({ rows: [], totals: [{ currency: "USD", recurring: 39 }] }))
  .get("/api/models", (c) =>
    c.json({
      models: [
        { id: "kimi-k2-thinking", name: "Kimi K2 Thinking", provider: "moonshot" },
        { id: "glm-5.3", name: "GLM-5.3", provider: "zai" },
      ],
      error: null,
    }),
  );

const server = Bun.serve({ port: 4788, fetch: app.fetch });
afterAll(() => server.stop(true));

/** Connect a client to a fresh server instance over in-memory transports and return it. */
async function connectedClient() {
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createMcpServer().connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function text(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0]?.text ?? "{}");
}

describe("modelizer MCP server", () => {
  test("exposes exactly the three read-only tools", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_models", "get_overview", "get_subscriptions"]);
    await client.close();
  });

  test("get_overview trims each provider to agent-relevant fields", async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: "get_overview", arguments: {} });
    const parsed = text(result as never) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(2);
    const zai = parsed[0] as Record<string, unknown>;
    expect(zai.id).toBe("zai");
    expect(Array.isArray(zai.windows)).toBe(true);
    // the subscription keeps the billing facts, drops the rest
    expect(zai.subscription).toEqual({
      plan: "coding",
      state: "active",
      price: 19,
      currency: "USD",
      renewsAt: "2026-11-05",
      endsAt: null,
    });
    await client.close();
  });

  test("get_models filters by provider", async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: "get_models", arguments: { provider: "zai" } });
    const parsed = text(result as never) as { models: Array<{ id: string }> };
    expect(parsed.models.map((m) => m.id)).toEqual(["glm-5.3"]);
    await client.close();
  });

  test("a failing API surfaces as a tool error, not a hang", async () => {
    process.env.MODELIZER_URL = "http://127.0.0.1:4999"; // nothing there
    const client = await connectedClient();
    const result = await client.callTool({ name: "get_subscriptions", arguments: {} });
    expect(result.isError).toBe(true);
    await client.close();
    process.env.MODELIZER_URL = "http://127.0.0.1:4788";
  });
});
