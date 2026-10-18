#!/usr/bin/env bun
/**
 * Optional Claude Code StopFailure hook.
 * Install (user settings, ~/.claude/settings.json) — matcher is the error type:
 *
 *   "hooks": {
 *     "StopFailure": [
 *       {
 *         "matcher": "rate_limit",
 *         "hooks": [{ "type": "command", "command": "bun /absolute/path/scripts/claude-rate-limit-hook.ts" }]
 *       }
 *     ]
 *   }
 *
 * On error=rate_limit, writes { recordedAt, error, message, resetsAt, window } to
 * MODELIZER_CLAUDE_HOOK_FILE or ~/.modelizer/claude-rate-limit.json.
 * Other errors exit 0 without writing. Claude Code ignores this hook's stdout.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { recordFromHookPayload } from "../src/usage-text";

let raw = "";
try {
  raw = readFileSync(0, "utf8");
} catch {
  process.exit(0);
}

let payload: unknown = null;
try {
  payload = JSON.parse(raw);
} catch {
  process.exit(0);
}

const record = recordFromHookPayload(payload, new Date());
if (record === null) process.exit(0);

const path = process.env.MODELIZER_CLAUDE_HOOK_FILE?.trim()
  || join(homedir(), ".modelizer", "claude-rate-limit.json");
mkdirSync(dirname(path), { recursive: true });
const tmp = `${path}.${process.pid}.tmp`;
writeFileSync(tmp, `${JSON.stringify(record)}\n`);
renameSync(tmp, path);
