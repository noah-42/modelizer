import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

describe("claude rate-limit hook script", () => {
  test("records a rate_limit reset and ignores other errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "modelizer-hook-"));
    const file = join(dir, "claude-rate-limit.json");

    const limited = Bun.spawn(["bun", "scripts/claude-rate-limit-hook.ts"], {
      cwd: repoRoot,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MODELIZER_CLAUDE_HOOK_FILE: file },
    });
    limited.stdin.write(JSON.stringify({
      hook_event_name: "StopFailure",
      error: "rate_limit",
      last_assistant_message: "API Error: Rate limit reached. Resets 2026-10-18T18:30:00Z",
    }));
    await limited.stdin.end();
    expect(await limited.exited).toBe(0);
    const saved = JSON.parse(readFileSync(file, "utf8")) as { error: string; resetsAt: string; window: string | null };
    expect(saved.error).toBe("rate_limit");
    expect(saved.resetsAt).toBe("2026-10-18T18:30:00.000Z");

    const other = Bun.spawn(["bun", "scripts/claude-rate-limit-hook.ts"], {
      cwd: repoRoot,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MODELIZER_CLAUDE_HOOK_FILE: file },
    });
    other.stdin.write(JSON.stringify({ error: "overloaded", message: "busy" }));
    await other.stdin.end();
    expect(await other.exited).toBe(0);
    const still = JSON.parse(readFileSync(file, "utf8")) as { resetsAt: string };
    expect(still.resetsAt).toBe("2026-10-18T18:30:00.000Z");
  });
});