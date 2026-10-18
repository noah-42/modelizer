// Mock Codex session transcripts for UI development — no real sessions needed.
// Usage: bun run scripts/mock-codex.ts
// Writes fixture JSONL to data/mock-codex/sessions with an active 5h block plus 7 days of history.
// Then: CODEX_SESSIONS_DIR=data/mock-codex/sessions MODELIZER_DB=data/dev-mock.db bun run dev

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const now = Date.now();
const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();
let n = 0;

function turn(base: number, ts: string, model: string, input: number, cached: number, output: number): string[] {
  n += 1;
  return [
    JSON.stringify({ timestamp: ts, ordinal: base, type: "turn_context", payload: { turn_id: `ctx_${n}`, model, model_reasoning_effort: "low" } }),
    JSON.stringify({
      timestamp: ts, ordinal: base + 0.5, type: "token_usage_record",
      payload: {
        session_id: "sess_mock", turn_id: `turn_${n}`, response_id: `resp_${n}`,
        turn_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output },
      },
    }),
  ];
}

const dir = "data/mock-codex/sessions/2026/10/12";
mkdirSync(dir, { recursive: true });
const lines: string[] = [
  // Active block: anchored 2h ago, still inside its 5h window.
  ...turn(1, hoursAgo(2), "gpt-6.1-sol", 4_000, 61_000, 1_400),
  ...turn(3, hoursAgo(1.5), "gpt-6.1-sol", 2_500, 70_000, 900),
  ...turn(5, hoursAgo(0.7), "gpt-5.5", 1_200, 9_000, 300),
  // Previous block yesterday evening (the ≥5h gap opens a new block).
  ...turn(7, hoursAgo(21), "gpt-6.1-sol", 3_000, 55_000, 2_000),
];
// A week of lighter history, one block per day, in per-day files like the real layout.
for (let d = 3; d <= 7; d++) {
  lines.push(...turn(10 + d, hoursAgo(24 * d), "gpt-6.1-sol", 800, 20_000 + d * 2_000, 500));
  lines.push(...turn(20 + d, hoursAgo(24 * d - 0.5), "gpt-5.5", 400, 6_000, 200));
}

writeFileSync(join(dir, "rollout-mock.jsonl"), lines.join("\n"));
console.log(`mock codex sessions: ${n} turns → ${dir}`);
console.log("run with: CODEX_SESSIONS_DIR=data/mock-codex/sessions MODELIZER_DB=data/dev-mock.db bun run dev");
