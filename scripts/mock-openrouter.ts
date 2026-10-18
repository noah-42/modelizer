// Mock OpenRouter API for UI development and demos — no real keys needed.
// Usage: bun run scripts/mock-openrouter.ts   (serves http://127.0.0.1:9801)
// Then run modelizer with OPENROUTER_BASE_URL=http://127.0.0.1:9801 and any non-empty keys.
const KEY_BODY = {
  data: {
    label: "sk-or-v1-mock",
    usage: 4.28,
    usage_daily: 0.36,
    usage_weekly: 3.02,
    usage_monthly: 4.28,
    limit: 20,
    limit_remaining: 15.72,
    limit_reset: "2026-11-01T00:00:00.000Z",
    is_free_tier: false,
    is_management_key: false,
    free_model_daily_requests: { used: 37, limit: 1000, remaining: 963 },
  },
};
const CREDITS_BODY = { data: { total_credits: 30, total_usage: 11.42 } };

const ACTIVITY_BODY = {
  data: (() => {
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 1; i <= 5; i++) {
      const d = new Date(Date.now() - i * 86_400_000);
      const date = d.toISOString().slice(0, 10);
      rows.push({
        date,
        model: "anthropic/claude-sonnet-4.5",
        model_permaslug: "anthropic/claude-sonnet-4.5",
        endpoint_id: "mock-endpoint",
        provider_name: "Anthropic",
        requests: 12 + i,
        usage: 0.8 + i * 0.15,
        byok_usage_inference: 0,
        prompt_tokens: 40_000 + i * 1000,
        completion_tokens: 8_000 + i * 500,
        reasoning_tokens: 0,
        cached_tokens: 10_000,
      });
      rows.push({
        date,
        model: "openai/gpt-5-mini",
        model_permaslug: "openai/gpt-5-mini",
        endpoint_id: "mock-endpoint",
        provider_name: "OpenAI",
        requests: 4,
        usage: 0.05,
        byok_usage_inference: 0,
        prompt_tokens: 6_000,
        completion_tokens: 900,
        reasoning_tokens: 0,
        cached_tokens: 0,
      });
    }
    return rows;
  })(),
};

const server = Bun.serve({
  port: 9801,
  fetch(req) {
    if (req.url.endsWith("/api/v1/key")) return Response.json(KEY_BODY);
    if (req.url.endsWith("/api/v1/credits")) return Response.json(CREDITS_BODY);
    if (req.url.endsWith("/api/v1/activity")) return Response.json(ACTIVITY_BODY);
    return new Response("not found", { status: 404 });
  },
});
console.log(`mock openrouter on http://127.0.0.1:${server.port}`);
