import { Database } from "bun:sqlite";
import type { RawPoll, UsagePoint } from "./adapters/types";
import type { SubscriptionFacts } from "./subscriptions";

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

/** Latest provider-stated plan facts (plan, billing state, seats) for the Subscriptions page. */
export interface SubscriptionFactsRow {
  provider: string;
  facts: SubscriptionFacts;
  observed_at: string;
}

export interface AuditEventRow {
  id: number;
  session_id: number;
  at: string;
  provider: string | null;
  level: AuditLevel;
  event: string;
  detail: string | null;
}

/** One user-made change, recorded for the changelog page. Never carries secret values. */
export interface ChangeRow {
  id: number;
  at: string;
  /** `subscription` | `provider` | `token` — what part of the config moved. */
  kind: "subscription" | "provider" | "token";
  /** What changed: a provider id, or `provider/SECRET_NAME` for a token. */
  target: string;
  /** add · update · delete · reorder · enable · disable · remove · set · oauth */
  action: string;
  /** Field-level before→after (JSON); token rows carry status only, never values. */
  detail: string | null;
}

export interface Db {
  raw: Database;
  insertPoints(points: UsagePoint[]): void;
  insertRawPolls(provider: string, polls: RawPoll[], capturedAt: string): void;
  updateAdapterState(provider: string, patch: { ok: boolean; error?: string; at: string }): void;
  getAdapterState(provider: string): AdapterStateRow | undefined;
  getAllAdapterStates(): AdapterStateRow[];
  addChange(at: string, kind: ChangeRow["kind"], target: string, action: string, detail?: string): void;
  listChanges(opts: { limit: number; kind?: ChangeRow["kind"] | undefined }): ChangeRow[];
  /** Latest captured_at per (provider, kind, label, model, day) — the dashboard's main read. */
  latestPoints(): UsagePoint[];
  pointsSince(provider: string, sinceIso: string): UsagePoint[];
  pointsAllSince(sinceIso: string): UsagePoint[];
  lastRawPolls(provider: string, limit: number): RawPollRow[];
  /** Replace the stored plan facts for a provider; one row per provider, latest wins. */
  upsertSubscriptionFacts(provider: string, facts: SubscriptionFacts, observedAt: string): void;
  getSubscriptionFacts(): SubscriptionFactsRow[];
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

CREATE TABLE IF NOT EXISTS subscription_facts (
  provider TEXT PRIMARY KEY,
  facts TEXT NOT NULL,
  observed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_changes_at ON changes(at);

-- Latest point per (provider, kind, label, model, day), maintained by insertPoints. The dashboard
-- reads this on every overview request; computing it from usage_points (a 300k-row GROUP BY with
-- COALESCE keys SQLite cannot index for) took seconds per hit.
CREATE TABLE IF NOT EXISTS points_latest (
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  model_key TEXT NOT NULL DEFAULT '',
  day_key TEXT NOT NULL DEFAULT '',
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
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd REAL,
  captured_at TEXT NOT NULL,
  quota_window TEXT,
  source TEXT,
  stale INTEGER,
  used_percent REAL,
  PRIMARY KEY (provider, kind, label, model_key, day_key)
);
`;

const UPSERT_LATEST = `
INSERT INTO points_latest
  (provider, kind, label, model_key, day_key, model, used, limit_value, remaining, unit,
   window_start, window_end, reset_at, day, requests, tokens_in, tokens_out, cost_usd, captured_at,
   quota_window, source, stale, used_percent)
VALUES
  ($provider, $kind, $label, $model_key, $day_key, $model, $used, $limit, $remaining, $unit,
   $window_start, $window_end, $reset_at, $day, $requests, $tokens_in, $tokens_out, $cost_usd, $captured_at,
   $quota_window, $source, $stale, $used_percent)
ON CONFLICT(provider, kind, label, model_key, day_key) DO UPDATE SET
  model = excluded.model, used = excluded.used, limit_value = excluded.limit_value,
  remaining = excluded.remaining, unit = excluded.unit, window_start = excluded.window_start,
  window_end = excluded.window_end, reset_at = excluded.reset_at, day = excluded.day,
  requests = excluded.requests, tokens_in = excluded.tokens_in, tokens_out = excluded.tokens_out,
  cost_usd = excluded.cost_usd, captured_at = excluded.captured_at, quota_window = excluded.quota_window,
  source = excluded.source, stale = excluded.stale, used_percent = excluded.used_percent
WHERE excluded.captured_at >= points_latest.captured_at
`;

const BACKFILL_LATEST = `
INSERT INTO points_latest
  (provider, kind, label, model_key, day_key, model, used, limit_value, remaining, unit,
   window_start, window_end, reset_at, day, requests, tokens_in, tokens_out, cost_usd, captured_at,
   quota_window, source, stale, used_percent)
SELECT provider, kind, label, COALESCE(model, ''), COALESCE(day, ''), model, used, limit_value, remaining, unit,
   window_start, window_end, reset_at, day, requests, tokens_in, tokens_out, cost_usd, captured_at,
   quota_window, source, stale, used_percent
FROM usage_points p
WHERE captured_at = (
  SELECT MAX(captured_at) FROM usage_points q
  WHERE q.provider = p.provider AND q.kind = p.kind AND q.label = p.label
    AND COALESCE(q.model, '') = COALESCE(p.model, '') AND COALESCE(q.day, '') = COALESCE(p.day, '')
)
ORDER BY captured_at
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
  last_error = CASE WHEN $is_fail = 1 THEN $last_error ELSE NULL END,
  last_error_at = CASE WHEN $is_fail = 1 THEN COALESCE($last_error_at, $at) ELSE NULL END,
  consecutive_failures = CASE WHEN $is_fail = 1 THEN adapter_state.consecutive_failures + 1 ELSE 0 END,
  updated_at = $at
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
  // A queued write waits instead of failing the poll with SQLITE_BUSY when another process
  // (a CLI run, another process holding the database mid-write) waits on the lock instead of
  // failing the poll with SQLITE_BUSY.
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  migrate(db);
  // One-time backfill: the mirror starts empty on a database that predates it. The per-group
  // MAX scan is slow (seconds on a large table) but runs exactly once.
  const latestCount = (db.prepare("SELECT COUNT(*) AS n FROM points_latest").get() as { n: number }).n;
  const pointCount = (db.prepare("SELECT COUNT(*) AS n FROM usage_points").get() as { n: number }).n;
  if (latestCount === 0 && pointCount > 0) {
    db.transaction(() => {
      db.exec(BACKFILL_LATEST);
    })();
  }

  const insertPoint = db.prepare(INSERT_POINT);
  const upsertLatest = db.prepare(UPSERT_LATEST);
  const insertRaw = db.prepare(
    "INSERT INTO raw_polls (provider, endpoint, url, status, body, captured_at) VALUES ($provider, $endpoint, $url, $status, $body, $captured_at)",
  );
  const insertPointsTx = db.transaction((points: UsagePoint[]) => {
    for (const p of points) {
      insertPoint.run(pointBindings(p));
      upsertLatest.run({
        ...pointBindings(p),
        $model_key: p.model ?? "",
        $day_key: p.day ?? "",
      });
    }
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
      return (db.prepare("SELECT * FROM points_latest ORDER BY provider, kind, label").all() as PointRow[]).map(
        rowToPoint,
      );
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
    upsertSubscriptionFacts(provider, facts, observedAt) {
      db.prepare(
        `INSERT INTO subscription_facts (provider, facts, observed_at) VALUES ($provider, $facts, $observed_at)
         ON CONFLICT(provider) DO UPDATE SET facts = $facts, observed_at = $observed_at`,
      ).run({ $provider: provider, $facts: JSON.stringify(facts), $observed_at: observedAt });
    },
    getSubscriptionFacts() {
      const rows = db.prepare("SELECT provider, facts, observed_at FROM subscription_facts").all() as Array<{
        provider: string;
        facts: string;
        observed_at: string;
      }>;
      const out: SubscriptionFactsRow[] = [];
      for (const row of rows) {
        try {
          out.push({ provider: row.provider, facts: JSON.parse(row.facts) as SubscriptionFacts, observed_at: row.observed_at });
        } catch {
          // A half-written row is not worth failing the page over; the next poll rewrites it.
        }
      }
      return out;
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
    addChange(at, kind, target, action, detail) {
      db.prepare(
        "INSERT INTO changes (at, kind, target, action, detail) VALUES ($at, $kind, $target, $action, $detail)",
      ).run({ $at: at, $kind: kind, $target: target, $action: action, $detail: detail ?? null });
    },
    listChanges(opts) {
      if (opts.kind !== undefined) {
        return db
          .prepare("SELECT * FROM changes WHERE kind = $kind ORDER BY id DESC LIMIT $limit")
          .all({ $kind: opts.kind, $limit: opts.limit }) as ChangeRow[];
      }
      return db.prepare("SELECT * FROM changes ORDER BY id DESC LIMIT $limit").all({ $limit: opts.limit }) as ChangeRow[];
    },
    close() {
      db.close();
    },
  };
}
