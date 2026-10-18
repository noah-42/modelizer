// Mock Z.AI API for UI development and demos — no real keys needed.
// Usage: bun run scripts/mock-zai.ts   (serves http://127.0.0.1:9802)
// DEGRADED=1 bun run scripts/mock-zai.ts → model-usage 404s, to test degraded-endpoint UI.
// Then run modelizer with ZAI_BASE_URL=http://127.0.0.1:9802 and any non-empty ZAI_API_KEY.

const QUOTA = {
  // Shape captured from the real API on 2026-10-03 (lite coding plan):
  // TIME_LIMIT is MCP tools; the 5h token window is percentage-only; resets are epoch ms.
  success: true,
  code: 200,
  data: {
    level: "lite",
    limits: [
      {
        type: "TIME_LIMIT",
        unit: 5,
        number: 1,
        usage: 100,
        currentValue: 72,
        remaining: 28,
        percentage: 72,
        nextResetTime: Date.now() + 8 * 86_400_000,
        usageDetails: [
          { modelCode: "search-prime", usage: 18 },
          { modelCode: "web-reader", usage: 54 },
        ],
      },
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 35, nextResetTime: Date.now() + 71 * 60_000 },
    ],
  },
};

const CODING = {
  data: {
    token_window: { used: 42000, remaining: 58000, total: 100000 },
    daily: { used: 42000, remaining: 78000, total: 120000 },
    monthly: { used: 2200000, remaining: 2600000, total: 4800000 },
  },
};

const MODEL_USAGE = {
  data: {
    x_time: (() => {
      const out: string[] = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86_400_000);
        out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
      }
      return out;
    })(),
    modelDataList: [
      { modelName: "glm-4.7", tokensUsage: [120000, 98000, 143000, 87000, 156000, 101000, 132000] },
      { modelName: "glm-4.6-flash", tokensUsage: [30000, 22000, 35000, 18000, 41000, 26000, 33000] },
    ],
  },
};

const server = Bun.serve({
  port: 9802,
  fetch(req) {
    const url = req.url;
    if (url.includes("/api/monitor/usage/quota/limit")) return Response.json(QUOTA);
    if (url.includes("/api/coding/usage")) return Response.json(CODING);
    if (url.includes("/api/monitor/usage/model-usage")) {
      if (process.env.DEGRADED) return new Response("not found", { status: 404 });
      return Response.json(MODEL_USAGE);
    }
    if (url.includes("/api/paas/v4/balance"))
      return Response.json({ data: { total_balance: 10, available_balance: 6.4, currency: "USD" } });
    return new Response("not found", { status: 404 });
  },
});
console.log(`mock z.ai on http://127.0.0.1:${server.port}`);
