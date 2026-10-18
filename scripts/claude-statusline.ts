#!/usr/bin/env bun
/**
 * Optional Claude Code statusLine command.
 * Claude Code sends one JSON object on stdin (https://code.claude.com/docs/en/statusline).
 * `rate_limits.five_hour` / `seven_day` (`used_percentage`, `resets_at`) arrived in v2.1.80.
 * Older builds omit them; this script still exits 0.
 *
 * Install in ~/.claude/settings.json. To keep an existing status line, put its
 * command after `--` — it receives the same JSON on stdin:
 *
 *   "statusLine": {
 *     "type": "command",
 *     "command": "bun /absolute/path/to/modelizer/scripts/claude-statusline.ts -- ~/.claude/statusline.sh",
 *     "refreshInterval": 60
 *   }
 *
 * Without `--`, stdout is a short line such as "5h 23% · 7d 41%".
 * Writes ~/.modelizer/claude-statusline.json (or MODELIZER_CLAUDE_STATUSLINE_FILE)
 * only when at least one window field is present.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { statuslineText, windowsFromRateLimits, type ParsedUsageWindow } from "../src/usage-text";

let raw = "";
try {
  raw = readFileSync(0, "utf8");
} catch {
  raw = "";
}

// Bun removes a leading `--` before the script runs. Whatever remains is the
// existing statusLine command, which we feed the same JSON on stdin.
const cmd = process.argv.slice(2);
while (cmd[0] === "--") cmd.shift();

let payload: unknown = null;
if (raw.trim() !== "") {
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = null;
  }
}

const rateLimits = payload !== null && typeof payload === "object"
  ? (payload as Record<string, unknown>).rate_limits
  : undefined;
const windows = windowsFromRateLimits(rateLimits);
writeSnapshot(windows);

const chained = cmd[0];
if (chained !== undefined) {
  const child = spawnSync(chained, cmd.slice(1), { input: raw, encoding: "utf8" });
  if (typeof child.stdout === "string" && child.stdout !== "") {
    process.stdout.write(child.stdout);
    process.exit(0);
  }
}

const line = statuslineText(windows);
if (line !== "") {
  process.stdout.write(`${line}\n`);
  process.exit(0);
}

const model = payload !== null && typeof payload === "object"
  ? (payload as { model?: { display_name?: unknown } }).model?.display_name
  : undefined;
if (typeof model === "string" && model.trim() !== "") process.stdout.write(`${model.trim()}\n`);
process.exit(0);

function writeSnapshot(windows: ParsedUsageWindow[]): void {
  if (windows.length === 0) return;
  const rateLimits: Record<string, { used_percentage?: number; resets_at?: string }> = {};
  for (const w of windows) {
    const key = w.window === "five_hour" ? "five_hour" : "seven_day";
    const bucket: { used_percentage?: number; resets_at?: string } = {};
    if (w.usedPercent !== null) bucket.used_percentage = w.usedPercent;
    if (w.resetsAt !== null) bucket.resets_at = w.resetsAt;
    rateLimits[key] = bucket;
  }
  const path = process.env.MODELIZER_CLAUDE_STATUSLINE_FILE?.trim()
    || join(homedir(), ".modelizer", "claude-statusline.json");
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ recordedAt: new Date().toISOString(), rate_limits: rateLimits })}\n`);
    renameSync(tmp, path);
  } catch {
    // A status line must not break the prompt.
  }
}
