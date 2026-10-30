#!/usr/bin/env bun
/**
 * MCP server for modelizer — read-only tools over stdio.
 *
 * Wraps the local HTTP API (the same three GET endpoints the dashboard reads) so coding agents —
 * Claude Code, Cursor, Codex — can check quota windows, subscriptions and the model catalogue
 * before picking a model. Nothing here writes: the catalogue mutations stay dashboard-only, and
 * the provider keys never leave the modelizer process.
 *
 * Run with `bun run mcp`. The agent connects over stdio; modelizer itself must be running — the
 * default is http://127.0.0.1:7788, override with MODELIZER_URL, and set MODELIZER_TOKEN when the
 * server is bound beyond loopback with a token configured.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

function baseUrl(): string {
  return (process.env.MODELIZER_URL ?? "http://127.0.0.1:7788").replace(/\/$/, "");
}

function token(): string {
  return process.env.MODELIZER_TOKEN ?? "";
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    headers: token() === "" ? {} : { Authorization: `Bearer ${token()}` },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const error = (body as { error?: string } | null)?.error;
    throw new Error(error ?? `HTTP ${res.status} from ${path}`);
  }
  return body as T;
}

/** Trim an overview to what an agent needs: windows, health, and the provider's own rows. */
function slimOverview(providers: Array<Record<string, unknown>>): unknown[] {
  return providers.map((p) => ({
    id: p.id,
    configured: p.configured,
    stale: p.stale,
    lastError: p.lastError,
    lastSuccess: p.lastSuccess,
    windows: p.windows,
    subscription:
      p.subscription === null
        ? null
        : (({ plan, state, price, currency, renewsAt, endsAt }) => ({ plan, state, price, currency, renewsAt, endsAt }))(
            p.subscription as Record<string, unknown>,
          ),
  }));
}

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "modelizer", version: "0.1.0" },
    {
      instructions:
        "Read-only view of the local LLM subscription and quota dashboard. Use get_overview before long tasks to check remaining quota windows; use get_models to see which provider serves which model.",
    },
  );

  server.tool(
    "get_overview",
    "Per-provider quota state: remaining %, reset times for each window (five_hour, weekly, monthly), health, and the plan each provider is on. Call this before heavy work to pick a provider with headroom.",
    {},
    async () => {
      try {
        const body = await getJson<{ providers: Array<Record<string, unknown>> }>("/api/overview");
        return { content: [{ type: "text", text: JSON.stringify(slimOverview(body.providers), null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `modelizer unreachable: ${(err as Error).message}` }] };
      }
    },
  );

  server.tool(
    "get_subscriptions",
    "What the household pays for: plan, billing state, monthly price, next renewal per provider, plus per-currency totals.",
    {},
    async () => {
      try {
        const body = await getJson<unknown>("/api/subscriptions");
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `modelizer unreachable: ${(err as Error).message}` }] };
      }
    },
  );

  server.tool(
    "get_models",
    "The model catalogue: which provider serves which model, with context length and per-million pricing where known. Pass a provider id to narrow the list.",
    { provider: z.string().optional().describe("Optional provider id (claude, codex, zai, moonshot, …) to filter by") },
    async ({ provider }) => {
      try {
        const body = await getJson<{ models: Array<Record<string, unknown>>; error: string | null }>("/api/models");
        const models =
          provider === undefined ? body.models : body.models.filter((m) => m.provider === provider);
        return {
          content: [{ type: "text", text: JSON.stringify({ models, error: body.error }, null, 2) }],
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `modelizer unreachable: ${(err as Error).message}` }] };
      }
    },
  );

  return server;
}

if (import.meta.main) {
  const transport = new StdioServerTransport();
  await createMcpServer().connect(transport);
}
