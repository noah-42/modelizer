import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Adapter, CollectContext, ProviderNote, RawPoll, UsagePoint } from "./types";

/** Default data file created by the official Docker install when its volume is mounted locally. */
export const DEFAULT_FREELLMAPI_DB = join(homedir(), "freellmapi", "server", "data", "freeapi.db");
export const DEFAULT_FREELLMAPI_CONTAINER = "freellmapi-freellmapi-1";
export const FREELLMAPI_POLL_MS = 5 * 60_000;
const PROVIDER_ID = "freellmapi";
const DAILY_LABEL = "freellmapi-daily-usage";
const MAX_MODEL_ROWS = 500;

interface ModelRow {
  platform: string;
  model_id: string;
  display_name: string;
  rpd_limit: number | null;
  tpd_limit: number | null;
  rpm_limit: number | null;
  tpm_limit: number | null;
  monthly_token_budget: string;
}

interface UsageRow {
  platform: string;
  model_id: string;
  day: string;
  requests: number;
  tokens_in: number;
  tokens_out: number;
}

interface FreeLlmApiSnapshot {
  captured_at: string;
  models: ModelRow[];
  usage: UsageRow[];
}

/** FreeLLMAPI's local request ledger, read-only; no API key or dashboard cookie is needed. */
export const freellmapiAdapter: Adapter = {
  id: PROVIDER_ID,
  stabilityTier: 3,
  pollEveryMs: FREELLMAPI_POLL_MS,

  isConfigured(env) {
    return existsSync(databasePath(env)) || dockerContainerExists(env);
  },

  missingCredentials(env) {
    return existsSync(databasePath(env)) || dockerContainerExists(env)
      ? []
      : [`FreeLLMAPI database/container not found: ${databasePath(env)}`];
  },

  notes: [
    {
      title: "Read from FreeLLMAPI's local ledger",
      text: "Modelizer reads server/data/freeapi.db read-only. It imports successful request counts and input/output tokens per model; provider keys remain inside FreeLLMAPI and are never opened here.",
    },
    {
      title: "Limits come from the local model catalogue",
      text: "Numeric daily request/token limits are reported when FreeLLMAPI has them. A free-tier description such as '~3M/month' is not converted into a fabricated exact limit.",
    },
    {
      title: "Prompt estimate",
      text: "The estimated monthly capacity combines the model catalogue's approximate monthly budgets, then subtracts this month's imported usage. The prompt estimate divides remaining tokens by this month's observed average tokens per successful request. That total includes context and model output, so short prompts may allow many more requests while long coding/tool contexts allow fewer. It is an estimate, not a credit balance or provider guarantee.",
    },
  ] satisfies ProviderNote[],

  async collect(ctx: CollectContext) {
    const path = databasePath(ctx.env);
    try {
      if (existsSync(path)) return [readSnapshot(path, ctx.now)];
      return [await readContainerSnapshot(ctx.env, ctx.now)];
    } catch (error) {
      const message = (error as Error).message;
      ctx.log(`freellmapi: database read failed (${message})`);
      return [{ endpoint: "local-db", url: sourceUrl(ctx.env), status: 0, body: message, json: null, headers: {}, optional: true }];
    }
  },

  normalize(polls, capturedAt) {
    const poll = polls.find((candidate) => (candidate.endpoint === "local-db" || candidate.endpoint === "container-db") && candidate.status === 200);
    if (poll === undefined || poll.json === null) return [];
    return normalizeSnapshot(poll.json as FreeLlmApiSnapshot, capturedAt);
  },
};

/** Resolve the configurable SQLite path without making a user copy the database. */
export function databasePath(env: Record<string, string | undefined>): string {
  return env.FREELLMAPI_DB?.trim() || DEFAULT_FREELLMAPI_DB;
}

function sourceUrl(env: Record<string, string | undefined>): string {
  return existsSync(databasePath(env)) ? `file://${databasePath(env)}` : `docker://${dockerContainerName(env)}/app/server/data/freeapi.db`;
}

function dockerContainerName(env: Record<string, string | undefined>): string {
  return env.FREELLMAPI_CONTAINER?.trim() || DEFAULT_FREELLMAPI_CONTAINER;
}

function dockerContainerExists(env: Record<string, string | undefined>): boolean {
  const result = Bun.spawnSync(["docker", "inspect", dockerContainerName(env)], { stdout: "ignore", stderr: "ignore" });
  return result.exitCode === 0;
}

async function readContainerSnapshot(env: Record<string, string | undefined>, capturedAt: Date): Promise<RawPoll> {
  const query = `const Database=require('better-sqlite3');const d=new Database('/app/server/data/freeapi.db',{readonly:true});const models=d.prepare("SELECT platform,model_id,display_name,rpd_limit,tpd_limit,rpm_limit,tpm_limit,monthly_token_budget FROM models WHERE enabled=1 ORDER BY platform,model_id LIMIT ${MAX_MODEL_ROWS}").all();const usage=d.prepare("SELECT platform,model_id,substr(created_at,1,10) AS day,count(*) AS requests,coalesce(sum(max(input_tokens,0)),0) AS tokens_in,coalesce(sum(max(output_tokens,0)),0) AS tokens_out FROM requests WHERE status='success' GROUP BY platform,model_id,substr(created_at,1,10) ORDER BY day DESC,requests DESC LIMIT ${MAX_MODEL_ROWS}").all();console.log(JSON.stringify({captured_at:new Date().toISOString(),models,usage}));`;
  const process = Bun.spawn(["docker", "exec", dockerContainerName(env), "node", "-e", query], { stdout: "pipe", stderr: "pipe" });
  const [body, error] = await Promise.all([process.stdout.text(), process.stderr.text()]);
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(error.trim() || `docker exec exited ${exitCode}`);
  const snapshot = JSON.parse(body.trim()) as FreeLlmApiSnapshot;
  return { endpoint: "container-db", url: sourceUrl(env), status: 200, body: JSON.stringify(snapshot), json: snapshot, headers: {} };
}

function missingDatabasePoll(path: string): RawPoll {
  return { endpoint: "local-db", url: `file://${path}`, status: 0, body: "database not found", json: null, headers: {}, optional: true };
}

function readSnapshot(path: string, capturedAt: Date): RawPoll {
  const db = new Database(path, { readonly: true });
  try {
    const models = db.query(`
      SELECT platform, model_id, display_name, rpd_limit, tpd_limit, rpm_limit, tpm_limit, monthly_token_budget
      FROM models WHERE enabled = 1 ORDER BY platform, model_id LIMIT ${MAX_MODEL_ROWS}
    `).all() as ModelRow[];
    const usage = db.query(`
      SELECT platform, model_id, substr(created_at, 1, 10) AS day,
             count(*) AS requests,
             coalesce(sum(max(input_tokens, 0)), 0) AS tokens_in,
             coalesce(sum(max(output_tokens, 0)), 0) AS tokens_out
      FROM requests WHERE status = 'success'
      GROUP BY platform, model_id, substr(created_at, 1, 10)
      ORDER BY day DESC, requests DESC LIMIT ${MAX_MODEL_ROWS}
    `).all() as UsageRow[];
    const snapshot: FreeLlmApiSnapshot = { captured_at: capturedAt.toISOString(), models, usage };
    return { endpoint: "local-db", url: `file://${path}`, status: 200, body: JSON.stringify(snapshot), json: snapshot, headers: {} };
  } finally {
    db.close();
  }
}

function normalizeSnapshot(snapshot: FreeLlmApiSnapshot, capturedAt: string): UsagePoint[] {
  const limits = new Map(snapshot.models.map((model) => [`${model.platform}/${model.model_id}`, model]));
  const points = snapshot.usage.flatMap((row) => {
    const model = `${row.platform}/${row.model_id}`;
    const point = usagePoint(row, capturedAt, model);
    const limit = limits.get(model);
    const quota = numericLimitPoint(row, limit, capturedAt, model);
    return quota === null ? [point] : [point, quota];
  });
  const currentDay = capturedAt.slice(0, 10);
  const currentRows = snapshot.usage.filter((row) => row.day === currentDay);
  points.push(dailyAggregatePoint(currentRows, capturedAt, currentDay));
  const monthlyEstimate = monthlyEstimatePoint(snapshot, capturedAt);
  if (monthlyEstimate !== null) points.push(monthlyEstimate);
  for (const model of snapshot.models) {
    const modelId = `${model.platform}/${model.model_id}`;
    const currentUsage = snapshot.usage.find((row) => row.day === currentDay && `${row.platform}/${row.model_id}` === modelId);
    if (currentUsage === undefined && model.tpd_limit !== null) {
      points.push(numericLimitPoint({ platform: model.platform, model_id: model.model_id, day: currentDay, requests: 0, tokens_in: 0, tokens_out: 0 }, model, capturedAt, modelId)!);
    }
  }
  return points;
}

function monthlyEstimatePoint(snapshot: FreeLlmApiSnapshot, capturedAt: string): UsagePoint | null {
  const ranges = snapshot.models.map((model) => parseBudget(model.monthly_token_budget)).filter(isRange);
  if (ranges.length === 0) return null;
  const month = capturedAt.slice(0, 7);
  const used = snapshot.usage
    .filter((row) => row.day.startsWith(month))
    .reduce((total, row) => total + row.tokens_in + row.tokens_out, 0);
  const requests = snapshot.usage
    .filter((row) => row.day.startsWith(month))
    .reduce((total, row) => total + row.requests, 0);
  const minimum = ranges.reduce((total, range) => total + range.minimum, 0);
  const maximum = ranges.reduce((total, range) => total + range.maximum, 0);
  const nextMonth = new Date(`${month}-01T00:00:00.000Z`);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  return {
    provider: PROVIDER_ID,
    kind: "quota",
    label: "freellmapi-monthly-estimate",
    model: null,
    used,
    limit: minimum,
    remaining: Math.max(minimum - used, 0),
    unit: "tokens",
    window_start: `${month}-01T00:00:00.000Z`,
    window_end: nextMonth.toISOString(),
    reset_at: nextMonth.toISOString(),
    day: null,
    requests,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    captured_at: capturedAt,
    source: `freellmapi-catalog-estimate:${formatBudget(minimum)}-${formatBudget(maximum)}`,
    quota_window: "monthly",
    stale: false,
  };
}

interface BudgetRange {
  minimum: number;
  maximum: number;
}

function parseBudget(value: string): BudgetRange | null {
  const matches = [...value.matchAll(/(\d+(?:\.\d+)?)\s*([KMB])/gi)];
  if (matches.length === 0) return null;
  const values = matches.map((match) => Number(match[1]) * multiplier(match[2]!.toUpperCase()));
  return { minimum: Math.min(...values), maximum: Math.max(...values) };
}

function multiplier(unit: string): number {
  return unit === "B" ? 1_000_000_000 : unit === "M" ? 1_000_000 : 1_000;
}

function isRange(value: BudgetRange | null): value is BudgetRange {
  return value !== null;
}

function formatBudget(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function dailyAggregatePoint(rows: UsageRow[], capturedAt: string, day: string): UsagePoint {
  const used = rows.reduce((total, row) => total + row.tokens_in + row.tokens_out, 0);
  const requests = rows.reduce((total, row) => total + row.requests, 0);
  return {
    provider: PROVIDER_ID,
    kind: "quota",
    label: "freellmapi-daily-pool",
    model: null,
    used,
    limit: null,
    remaining: null,
    unit: "tokens",
    window_start: `${day}T00:00:00.000Z`,
    window_end: `${day}T23:59:59.999Z`,
    reset_at: nextDay(day),
    day: null,
    requests,
    tokens_in: rows.reduce((total, row) => total + row.tokens_in, 0),
    tokens_out: rows.reduce((total, row) => total + row.tokens_out, 0),
    cost_usd: null,
    captured_at: capturedAt,
    source: "freellmapi-db",
    quota_window: "daily",
    stale: false,
  };
}

function usagePoint(row: UsageRow, capturedAt: string, model: string): UsagePoint {
  return {
    provider: PROVIDER_ID,
    kind: "usage",
    label: DAILY_LABEL,
    model,
    used: row.tokens_in + row.tokens_out,
    limit: null,
    remaining: null,
    unit: "tokens",
    window_start: `${row.day}T00:00:00.000Z`,
    window_end: `${row.day}T23:59:59.999Z`,
    reset_at: nextDay(row.day),
    day: row.day,
    requests: row.requests,
    tokens_in: row.tokens_in,
    tokens_out: row.tokens_out,
    cost_usd: null,
    captured_at: capturedAt,
    source: "freellmapi-db",
    quota_window: null,
    stale: false,
  };
}

function numericLimitPoint(row: UsageRow, model: ModelRow | undefined, capturedAt: string, modelId: string): UsagePoint | null {
  if (model?.tpd_limit === null || model?.tpd_limit === undefined) return null;
  const used = row.tokens_in + row.tokens_out;
  return {
    provider: PROVIDER_ID,
    kind: "quota",
    label: "freellmapi-daily-token-limit",
    model: modelId,
    used,
    limit: model.tpd_limit,
    remaining: Math.max(model.tpd_limit - used, 0),
    unit: "tokens",
    window_start: `${row.day}T00:00:00.000Z`,
    window_end: `${row.day}T23:59:59.999Z`,
    reset_at: nextDay(row.day),
    day: row.day,
    requests: row.requests,
    tokens_in: row.tokens_in,
    tokens_out: row.tokens_out,
    cost_usd: null,
    captured_at: capturedAt,
    source: "freellmapi-db",
    quota_window: "daily",
    stale: false,
  };
}

function nextDay(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}
