// Mock Claude Code transcripts for UI development — no real sessions needed.
// Usage: bun run scripts/mock-claude.ts
// Writes fixture JSONL to data/mock-claude/projects with an active 5h block plus 7 days of history.
// Then: CLAUDE_PROJECTS_DIR=data/mock-claude/projects MODELIZER_DB=data/dev-mock.db bun run dev

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = "data/mock-claude/projects/-Users-x-demo";
mkdirSync(OUT, { recursive: true });

const now = Date.now();
const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();
let n = 0;

function turn(ts: string, model: string, input: number, cacheRead: number, output: number): string {
  n += 1;
  return JSON.stringify({
    isSidechain: false,
    message: {
      model,
      id: `msg_mock_${n}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "…" }],
      usage: { input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead, output_tokens: output },
    },
    requestId: `req_mock_${n}`,
    timestamp: ts,
    type: "assistant",
    uuid: `uuid_mock_${n}`,
  });
}

const lines: string[] = [
  // Active block: anchored 2h ago, still inside its 5h window.
  turn(hoursAgo(2), "claude-opus-5-5", 800, 40_000, 1_200),
  turn(hoursAgo(1.4), "claude-opus-5-5", 300, 52_000, 900),
  turn(hoursAgo(0.6), "claude-haiku-4-5", 150, 9_000, 400),
  // Previous block yesterday evening (the ≥5h gap opens a new block).
  turn(hoursAgo(20), "claude-opus-5-5", 500, 61_000, 2_100),
  turn(hoursAgo(19.2), "claude-opus-5-5", 250, 70_000, 1_500),
];
// A week of lighter history, one block per day.
for (let d = 3; d <= 7; d++) {
  lines.push(turn(hoursAgo(24 * d), "claude-opus-5-5", 200, 30_000 + d * 2_000, 800));
  lines.push(turn(hoursAgo(24 * d - 0.5), "claude-haiku-4-5", 100, 8_000, 300));
}

writeFileSync(join(OUT, "session-mock.jsonl"), lines.join("\n"));
const reset5h = new Date(now + 3 * 3_600_000).toISOString();
const resetWeek = new Date(now + 4 * 86_400_000).toISOString();
writeFileSync("data/mock-claude/usage.txt", [
  "Current session",
  "41% used",
  `Resets ${reset5h}`,
  "",
  "Current week (all models)",
  "9% used",
  `Resets ${resetWeek}`,
  "",
].join("\n"));
console.log(`mock claude transcripts: ${n} turns → ${OUT}`);
console.log("run with: CLAUDE_PROJECTS_DIR=data/mock-claude/projects CLAUDE_USAGE_FILE=data/mock-claude/usage.txt MODELIZER_DB=data/dev-mock.db bun run dev");
