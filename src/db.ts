import { Database } from "bun:sqlite";
import type { RawPoll, UsagePoint } from "./adapters/types";

export interface AdapterStateRow {
  provider: string;
  last_success: string | null;
  last_error: string | null;
  last_error_at: string | null;
  consecutive_failures: number;
  updated_at: string;
}

export interface RawPollRow {
  endpoint: string;
  url: string;
  status: number;
  body: string;
  captured_at: string;
}

/** One modelizer run (server start → stop, or a one-off CLI poll). */
export interface SessionRow {
  id: number;
  started_at: string;
  stopped_at: string | null;
  pid: number | null;
}

export type AuditLevel = "info" | "warn" | "error";

export interface AuditEventRow {
  id: number;
  session_id: number;
  at: string;
  provider: string | null;
  level: AuditLevel;
  event: string;
  detail: string | null;
}

export interface Db {
  raw: Database;
  insertPoints(points: UsagePoint[]): void;
  insertRawPolls(provider: string, polls: RawPoll[], capturedAt: string): void;
  updateAdapterState(provider: string, patch: { ok: boolean; error?: string; at: string }): void;
  getAdapterState(provider: string): AdapterStateRow | undefined;
  getAllAdapterStates(): AdapterStateRow[];
  /** Latest captured_at per (provider, kind, label, model, day) — the dashboard's main read. */
  latestPoints(): UsagePoint[];
  pointsSince(provider: string, sinceIso: string): UsagePoint[];
  pointsAllSince(sinceIso: string): UsagePoint[];
  lastRawPolls(provider: string, limit: number): RawPollRow[];
  startSession(at: string, pid: number): number;
  endSession(id: number, at: string): void;
  listSessions(limit: number): SessionRow[];
  addAudit(sessionId: number, at: string, provider: string | null, level: AuditLevel, event: string, detail?: string | undefined): void;
  auditEvents(opts: { sessionId?: number | undefined; limit: number }): AuditEventRow[];
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  model TEXT,
  used REAL,
  limit_value REAL,
  remaining REAL,
  unit TEXT NOT NULL,
  window_start TEXT,
  window_end TEXT,
  reset_at TEXT,
  day TEXT,
  requests INTEGER,
  tokens_in REAL,
  tokens_out REAL,
  cost_usd REAL,
  captured_at TEXT NOT NULL,
  quota_window TEXT,
  source TEXT,
  stale INTEGER NOT NULL DEFAULT 0,
  used_percent REAL
);
CREATE INDEX IF NOT EXISTS idx_points_group ON usage_points(provider, kind, label, captured_at);
CREATE INDEX IF NOT EXISTS idx_points_day ON usage_points(provider, day);

CREATE TABLE IF NOT EXISTS raw_polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  url TEXT NOT NULL,
  status INTEGER NOT NULL,
  body TEXT NOT NULL,
  captured_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_raw_provider ON raw_polls(provider, id);

CREATE TABLE IF NOT EXISTS adapter_state (
  provider TEXT PRIMARY KEY,
  last_success TEXT,
  last_error TEXT,
  last_error_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  stopped_at TEXT,
  pid INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  provider TEXT,
  level TEXT NOT NULL,
  event TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_events(session_id, id);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_events(at);

CREATE TABLE IF NOT EXISTS window_snapshots (
  provider TEXT NOT NULL,
  quota_window TEXT NOT NULL,
  used_percent REAL,
  resets_at TEXT,
  source TEXT,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (provider, quota_window)
);

CREATE TABLE IF NOT EXISTS reset_notices (
  dedupe_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  quota_window TEXT NOT NULL,
  payload TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  delivered_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT
);
`;

const INSERT_POINT = `
INSERT INTO usage_points
  (provider, kind, label, model, used, limit_value, remaining, unit,
   window_start, window_end, reset_at, day, requests, tokens_in, tokens_out, cost_usd, captured_at,
   quota_window, source, stale, used_percent)
VALUES
  ($provider, $kind, $label, $model, $used, $limit, $remaining, $unit,
   $window_start, $window_end, $reset_at, $day, $requests, $tokens_in, $tokens_out, $cost_usd, $captured_at,
   $quota_window, $source, $stale, $used_percent)
`;

const UPSERT_STATE = `
INSERT INTO adapter_state (provider, last_success, last_error, last_error_at, consecutive_failures, updated_at)
VALUES ($provider, $last_success, $last_error, $last_error_at, $failures, $at)
ON CONFLICT(provider) DO UPDATE SET
  last_success = COALESCE($last_success, last_success),
  last_error = CASE WHEN $is_fail = 1 THEN $last_error ELSE last_error END,
  last_error_at = CASE WHEN $is_fail = 1 THEN COALESCE($last_error_at, $at) ELSE last_error_at END,
  consecutive_failures = CASE WHEN $is_fail = 1 THEN adapter_state.consecutive_failures + 1 ELSE 0 END,
  updated_at = $at
`;

const LATEST_POINTS = `
SELECT p.* FROM usage_points p
JOIN (
  SELECT provider, kind, label, COALESCE(model, '') AS m, COALESCE(day, '') AS d, MAX(captured_at) AS max_at
  FROM usage_points
  GROUP BY provider, kind, label, m, d
) latest
  ON p.provider = latest.provider AND p.kind = latest.kind AND p.label = latest.label
  AND COALESCE(p.model, '') = latest.m AND COALESCE(p.day, '') = latest.d
  AND p.captured_at = latest.max_at
ORDER BY p.provider, p.kind, p.label
`;

interface PointRow {
  provider: string;
  kind: string;
  label: string;
  model: string | null;
  used: number | null;
  limit_value: number | null;
  remaining: number | null;
  unit: string;
  window_start: string | null;
  window_end: string | null;
  reset_at: string | null;
  day: string | null;
  requests: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  captured_at: string;
  quota_window: string | null;
  source: string | null;
  stale: number;
  used_percent: number | null;
}

function rowToPoint(r: PointRow): UsagePoint {
  return {
    provider: r.provider,
    kind: r.kind as UsagePoint["kind"],
    label: r.label,
    model: r.model,
    used: r.used,
    limit: r.limit_value,
    remaining: r.remaining,
    unit: r.unit as UsagePoint["unit"],
    window_start: r.window_start,
    window_end: r.window_end,
    reset_at: r.reset_at,
    day: r.day,
    requests: r.requests,
    tokens_in: r.tokens_in,
    tokens_out: r.tokens_out,
    cost_usd: r.cost_usd,
    captured_at: r.captured_at,
    quota_window: r.quota_window,
    source: r.source,
    stale: r.stale === 1,
    used_percent: r.used_percent,
  };
}

// bun:sqlite binds named params by exact key including the "$" prefix.
function pointBindings(p: UsagePoint) {
  return {
    $provider: p.provider,
    $kind: p.kind,
    $label: p.label,
    $model: p.model,
    $used: p.used,
    $limit: p.limit,
    $remaining: p.remaining,
    $unit: p.unit,
    $window_start: p.window_start,
    $window_end: p.window_end,
    $reset_at: p.reset_at,
    $day: p.day,
    $requests: p.requests,
    $tokens_in: p.tokens_in,
    $tokens_out: p.tokens_out,
    $cost_usd: p.cost_usd,
    $captured_at: p.captured_at,
    $quota_window: p.quota_window ?? null,
    $source: p.source ?? null,
    $stale: p.stale ? 1 : 0,
    $used_percent: p.used_percent ?? null,
  };
}

function migrate(db: Database): void {
  const cols = new Set(
    (db.prepare("PRAGMA table_info(usage_points)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has("quota_window")) db.exec("ALTER TABLE usage_points ADD COLUMN quota_window TEXT");
  if (!cols.has("source")) db.exec("ALTER TABLE usage_points ADD COLUMN source TEXT");
  if (!cols.has("stale")) db.exec("ALTER TABLE usage_points ADD COLUMN stale INTEGER NOT NULL DEFAULT 0");
  if (!cols.has("used_percent")) db.exec("ALTER TABLE usage_points ADD COLUMN used_percent REAL");
}

export function openDb(path: string): Db {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  migrate(db);

  const insertPoint = db.prepare(INSERT_POINT);
  const insertRaw = db.prepare(
    "INSERT INTO raw_polls (provider, endpoint, url, status, body, captured_at) VALUES ($provider, $endpoint, $url, $status, $body, $captured_at)",
  );
  const insertPointsTx = db.transaction((points: UsagePoint[]) => {
    for (const p of points) insertPoint.run(pointBindings(p));
  });
  const insertRawTx = db.transaction((provider: string, polls: RawPoll[], capturedAt: string) => {
    for (const p of polls)
      insertRaw.run({
        $provider: provider,
        $endpoint: p.endpoint,
        $url: p.url,
        $status: p.status,
        $body: p.body,
        $captured_at: capturedAt,
      });
  });
  const upsertState = db.prepare(UPSERT_STATE);

  return {
    raw: db,
    insertPoints(points) {
      insertPointsTx(points);
    },
    insertRawPolls(provider, polls, capturedAt) {
      insertRawTx(provider, polls, capturedAt);
    },
    updateAdapterState(provider, patch) {
      if (patch.ok) {
        upsertState.run({
          $provider: provider,
          $last_success: patch.at,
          $last_error: null,
          $last_error_at: null,
          $failures: 0,
          $at: patch.at,
          $is_fail: 0,
        });
      } else {
        upsertState.run({
          $provider: provider,
          $last_success: null,
          $last_error: patch.error ?? "unknown error",
          $last_error_at: patch.at,
          $failures: 1,
          $at: patch.at,
          $is_fail: 1,
        });
      }
    },
    getAdapterState(provider) {
      return db.prepare("SELECT * FROM adapter_state WHERE provider = $provider").get({ $provider: provider }) as
        | AdapterStateRow
        | undefined;
    },
    getAllAdapterStates() {
      return db.prepare("SELECT * FROM adapter_state").all() as AdapterStateRow[];
    },
    latestPoints() {
      return (db.prepare(LATEST_POINTS).all() as PointRow[]).map(rowToPoint);
    },
    pointsSince(provider, sinceIso) {
      return (
        db
          .prepare("SELECT * FROM usage_points WHERE provider = $provider AND captured_at >= $since ORDER BY captured_at")
          .all({ $provider: provider, $since: sinceIso }) as PointRow[]
      ).map(rowToPoint);
    },
    pointsAllSince(sinceIso) {
      return (
        db
          .prepare("SELECT * FROM usage_points WHERE captured_at >= $since ORDER BY captured_at")
          .all({ $since: sinceIso }) as PointRow[]
      ).map(rowToPoint);
    },
    lastRawPolls(provider, limit) {
      return db
        .prepare(
          "SELECT endpoint, url, status, body, captured_at FROM raw_polls WHERE provider = $provider ORDER BY id DESC LIMIT $limit",
        )
        .all({ $provider: provider, $limit: limit }) as RawPollRow[];
    },
    startSession(at, pid) {
      const res = db
        .prepare("INSERT INTO sessions (started_at, pid) VALUES ($at, $pid)")
        .run({ $at: at, $pid: pid });
      return Number(res.lastInsertRowid);
    },
    endSession(id, at) {
      db.prepare("UPDATE sessions SET stopped_at = $at WHERE id = $id").run({ $at: at, $id: id });
    },
    listSessions(limit) {
      return db
        .prepare("SELECT * FROM sessions ORDER BY id DESC LIMIT $limit")
        .all({ $limit: limit }) as SessionRow[];
    },
    addAudit(sessionId, at, provider, level, event, detail) {
      db.prepare(
        "INSERT INTO audit_events (session_id, at, provider, level, event, detail) VALUES ($session, $at, $provider, $level, $event, $detail)",
      ).run({ $session: sessionId, $at: at, $provider: provider, $level: level, $event: event, $detail: detail ?? null });
    },
    auditEvents(opts) {
      if (opts.sessionId !== undefined) {
        return db
          .prepare("SELECT * FROM audit_events WHERE session_id = $session ORDER BY id DESC LIMIT $limit")
          .all({ $session: opts.sessionId, $limit: opts.limit }) as AuditEventRow[];
      }
      return db.prepare("SELECT * FROM audit_events ORDER BY id DESC LIMIT $limit").all({ $limit: opts.limit }) as AuditEventRow[];
    },
    close() {
      db.close();
    },
  };
}
