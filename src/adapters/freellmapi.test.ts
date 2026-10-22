import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { databasePath, freellmapiAdapter } from "./freellmapi";

const root = mkdtempSync(join(tmpdir(), "modelizer-freellmapi-"));
const dbPath = join(root, "freeapi.db");
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE models (
    platform TEXT, model_id TEXT, display_name TEXT, rpd_limit INTEGER,
    tpd_limit INTEGER, rpm_limit INTEGER, tpm_limit INTEGER, enabled INTEGER
  );
  CREATE TABLE requests (
    platform TEXT, model_id TEXT, status TEXT, input_tokens INTEGER,
    output_tokens INTEGER, created_at TEXT
  );
`);
db.query("INSERT INTO models VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("google", "gemini-2.5-flash", "Gemini Flash", 20, 1000000, null, null, 1);
db.query("INSERT INTO requests VALUES (?, ?, ?, ?, ?, ?)").run("google", "gemini-2.5-flash", "success", 1200, 800, "2026-10-22T12:00:00Z");
db.query("INSERT INTO requests VALUES (?, ?, ?, ?, ?, ?)").run("google", "gemini-2.5-flash", "failed", 9000, 9000, "2026-10-22T12:01:00Z");
db.close();
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("freellmapiAdapter", () => {
  test("uses the configured database path", () => {
    expect(databasePath({ FREELLMAPI_DB: dbPath })).toBe(dbPath);
  });

  test("imports successful per-model input and output tokens", async () => {
    const polls = await freellmapiAdapter.collect({
      fetchFn: fetch,
      env: { FREELLMAPI_DB: dbPath },
      now: new Date("2026-10-22T13:00:00Z"),
      log: () => undefined,
    });
    const points = freellmapiAdapter.normalize(polls, "2026-10-22T13:00:00Z");
    const usage = points.find((point) => point.kind === "usage");
    expect(usage).toMatchObject({
      provider: "freellmapi",
      label: "freellmapi-daily-usage",
      model: "google/gemini-2.5-flash",
      used: 2000,
      requests: 1,
      tokens_in: 1200,
      tokens_out: 800,
      day: "2026-10-22",
    });
  });

  test("imports a numeric daily token limit beside usage", async () => {
    const polls = await freellmapiAdapter.collect({
      fetchFn: fetch,
      env: { FREELLMAPI_DB: dbPath },
      now: new Date("2026-10-22T13:00:00Z"),
      log: () => undefined,
    });
    const points = freellmapiAdapter.normalize(polls, "2026-10-22T13:00:00Z");
    expect(points.find((point) => point.kind === "quota")).toMatchObject({
      label: "freellmapi-daily-token-limit",
      used: 2000,
      limit: 1_000_000,
      remaining: 998_000,
      quota_window: "daily",
    });
  });

  test("does not report a provider when the database is missing", () => {
    expect(freellmapiAdapter.isConfigured({ FREELLMAPI_DB: join(root, "missing.db"), FREELLMAPI_CONTAINER: "definitely-missing" })).toBe(false);
  });
});
