import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

function spawnStatusline(args: string[], input: string, file: string) {
  return Bun.spawn(["bun", "scripts/claude-statusline.ts", ...args], {
    cwd: repoRoot,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, MODELIZER_CLAUDE_STATUSLINE_FILE: file },
  });
}

describe("claude status line script", () => {
  test("writes rate_limits and prints a short line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "modelizer-statusline-"));
    const file = join(dir, "claude-statusline.json");
    const input = JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: 1760834838 },
        seven_day: { used_percentage: 61, resets_at: "2026-10-24T20:44:22Z" },
      },
    });
    const proc = spawnStatusline([], input, file);
    proc.stdin.write(input);
    await proc.stdin.end();
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe("5h 24% · 7d 61%\n");
    const saved = JSON.parse(readFileSync(file, "utf8")) as {
      recordedAt: string;
      rate_limits: { five_hour: { used_percentage: number; resets_at: string }; seven_day: { used_percentage: number } };
    };
    expect(saved.rate_limits.five_hour.used_percentage).toBe(23.5);
    expect(saved.rate_limits.five_hour.resets_at).toBe(new Date(1760834838 * 1000).toISOString());
    expect(saved.rate_limits.seven_day.used_percentage).toBe(61);
    expect(Number.isFinite(Date.parse(saved.recordedAt))).toBe(true);
  });

  test("older builds without rate_limits write no file and still print a line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "modelizer-statusline-old-"));
    const file = join(dir, "claude-statusline.json");
    const input = JSON.stringify({ model: { display_name: "Opus" }, version: "2.1.7" });
    const proc = spawnStatusline([], input, file);
    proc.stdin.write(input);
    await proc.stdin.end();
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe("Opus\n");
    expect(existsSync(file)).toBe(false);
  });

  test("chains an existing statusLine command instead of replacing its output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "modelizer-statusline-chain-"));
    const file = join(dir, "claude-statusline.json");
    const input = JSON.stringify({
      rate_limits: { five_hour: { used_percentage: 3 } },
    });
    const proc = spawnStatusline(["--", "bun", "-e", "process.stdout.write('kept')"], input, file);
    proc.stdin.write(input);
    await proc.stdin.end();
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe("kept");
    const saved = JSON.parse(readFileSync(file, "utf8")) as { rate_limits: { five_hour: { used_percentage: number } } };
    expect(saved.rate_limits.five_hour.used_percentage).toBe(3);
    expect(saved.rate_limits.five_hour).not.toHaveProperty("resets_at");
  });
});
