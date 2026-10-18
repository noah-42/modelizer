import { createHmac } from "node:crypto";
import type { Db } from "./db";
import { providerDisplayName, windowPhrase, windowsFromPoints } from "./windows";

/**
 * Optional reset notifier. Off unless MODELIZER_WEBHOOK_URL is set.
 * A window fires once when its reset time passes, or when usedPercent drops
 * by USAGE_DROP_POINTS (a refresh the clock did not announce). Delivery retries
 * with backoff. The URL and MODELIZER_WEBHOOK_SECRET are never logged.
 *
 * MODELIZER_WEBHOOK_FORMAT=json|ntfy. Host ntfy.sh selects ntfy when unset.
 * ntfy posts plain text with Title and Tags headers (the topic is only in the URL).
 */

export const USAGE_DROP_POINTS = 25;

export interface ResetEvent {
  provider: string;
  window: string;
  resetAt: string;
  usedPercent: number | null;
  detectedAt: string;
  dedupeKey: string;
}

export interface SnapshotWindow {
  provider: string;
  window: string;
  usedPercent: number | null;
  resetsAt: string | null;
  observedAt: string;
}

export interface Notifier {
  scan(at: Date): Promise<void>;
}

export function webhookFormat(env: Record<string, string | undefined>, url: string): "json" | "ntfy" {
  const raw = (env.MODELIZER_WEBHOOK_FORMAT ?? "").trim().toLowerCase();
  if (raw === "json" || raw === "ntfy") return raw;
  try {
    if (new URL(url).hostname.toLowerCase() === "ntfy.sh") return "ntfy";
  } catch {
    // invalid URL — caller treats the notifier as off
  }
  return "json";
}

export function detectReset(
  prev: SnapshotWindow,
  curr: { provider: string; window: string; usedPercent: number | null; resetsAt: string | null },
  now: Date,
): ResetEvent | null {
  const detectedAt = now.toISOString();
  const passed = prev.resetsAt !== null && Date.parse(prev.resetsAt) <= now.getTime();
  if (passed && prev.resetsAt !== null) {
    const fresh = curr.resetsAt !== null && curr.resetsAt !== prev.resetsAt && Date.parse(curr.resetsAt) > now.getTime();
    return {
      provider: curr.provider,
      window: curr.window,
      resetAt: prev.resetsAt,
      usedPercent: fresh ? (curr.usedPercent ?? 0) : 0,
      detectedAt,
      dedupeKey: `${curr.provider}|${curr.window}|reset|${prev.resetsAt}`,
    };
  }
  const drop = prev.usedPercent !== null
    && curr.usedPercent !== null
    && prev.usedPercent - curr.usedPercent >= USAGE_DROP_POINTS;
  if (!drop || curr.usedPercent === null) return null;
  return {
    provider: curr.provider,
    window: curr.window,
    // The provider did not name the instant; the detection time is the refresh we observed.
    resetAt: detectedAt,
    usedPercent: curr.usedPercent,
    detectedAt,
    dedupeKey: `${curr.provider}|${curr.window}|drop|${prev.observedAt}|${curr.usedPercent}`,
  };
}

export function ntfyMessage(event: Pick<ResetEvent, "provider" | "window" | "usedPercent">): { title: string; body: string; tags: string } {
  const name = providerDisplayName(event.provider);
  const phrase = windowPhrase(event.window);
  const pct = event.usedPercent === null ? null : `${Math.round(event.usedPercent)}% used`;
  const body = pct === null ? `${name} ${phrase} window reset` : `${name} ${phrase} window reset, ${pct}`;
  return { title: `Modelizer: ${name} credits reset`, body, tags: "white_check_mark" };
}

export interface WebhookRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
}

export function buildWebhookRequest(opts: {
  url: string;
  format: "json" | "ntfy";
  secret?: string | undefined;
  event: ResetEvent;
}): WebhookRequest {
  const payload = {
    provider: opts.event.provider,
    window: opts.event.window,
    resetAt: opts.event.resetAt,
    usedPercent: opts.event.usedPercent,
    detectedAt: opts.event.detectedAt,
  };
  let body: string;
  const headers: Record<string, string> = {};
  if (opts.format === "ntfy") {
    const msg = ntfyMessage(opts.event);
    body = msg.body;
    headers["Content-Type"] = "text/plain; charset=utf-8";
    headers.Title = msg.title;
    headers.Tags = msg.tags;
  } else {
    body = JSON.stringify(payload);
    headers["Content-Type"] = "application/json";
  }
  const secret = opts.secret?.trim() ?? "";
  if (secret !== "") {
    headers.Authorization = `Bearer ${secret}`;
    headers["X-Modelizer-Signature"] = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  }
  return { url: opts.url, body, headers };
}

export function redact(text: string, url: string, secret: string | undefined): string {
  let out = text;
  const trimmed = secret?.trim() ?? "";
  if (trimmed !== "") out = out.split(trimmed).join("[redacted]");
  try {
    const u = new URL(url);
    out = out.split(u.href).join("[webhook]");
    out = out.split(url).join("[webhook]");
    if (u.pathname.length > 1) out = out.split(u.pathname).join("/[redacted]");
    if (u.username) out = out.split(decodeURIComponent(u.username)).join("[redacted]");
    if (u.password) out = out.split(decodeURIComponent(u.password)).join("[redacted]");
  } catch {
    if (url !== "") out = out.split(url).join("[webhook]");
  }
  return out.slice(0, 300);
}

const MAX_ATTEMPTS = 6;

export function createNotifier(deps: {
  db: Db;
  env: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  /** Delays between in-process retries. Defaults to 500ms then 2s. */
  retryDelaysMs?: number[];
}): Notifier | undefined {
  const url = deps.env.MODELIZER_WEBHOOK_URL?.trim() ?? "";
  if (url === "") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    (deps.log ?? (() => {}))("notifier: MODELIZER_WEBHOOK_URL is not a valid URL; notices are off");
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    (deps.log ?? (() => {}))("notifier: MODELIZER_WEBHOOK_URL must be http(s); notices are off");
    return undefined;
  }

  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const log = deps.log ?? (() => {});
  const retryDelaysMs = deps.retryDelaysMs ?? [500, 2_000];
  const secret = deps.env.MODELIZER_WEBHOOK_SECRET;
  const format = webhookFormat(deps.env, url);
  const db = deps.db.raw;

  db.exec(`
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
  `);

  const listSnapshots = db.prepare(
    "SELECT provider, quota_window, used_percent, resets_at, observed_at FROM window_snapshots",
  );
  const upsertSnapshot = db.prepare(`
    INSERT INTO window_snapshots (provider, quota_window, used_percent, resets_at, source, observed_at)
    VALUES ($provider, $window, $used, $resets, $source, $at)
    ON CONFLICT(provider, quota_window) DO UPDATE SET
      used_percent = $used, resets_at = $resets, source = $source, observed_at = $at
  `);
  const getNotice = db.prepare("SELECT dedupe_key, payload, detected_at, delivered_at, attempts, next_attempt_at FROM reset_notices WHERE dedupe_key = $key");
  const insertNotice = db.prepare(`
    INSERT OR IGNORE INTO reset_notices (dedupe_key, provider, quota_window, payload, detected_at, attempts)
    VALUES ($key, $provider, $window, $payload, $detected, 0)
  `);
  const listPending = db.prepare(`
    SELECT dedupe_key, payload, detected_at, delivered_at, attempts, next_attempt_at, provider, quota_window
    FROM reset_notices
    WHERE delivered_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= $now)
  `);
  const markDelivered = db.prepare(
    "UPDATE reset_notices SET delivered_at = $at, attempts = attempts + 1, next_attempt_at = NULL WHERE dedupe_key = $key",
  );
  const markRetry = db.prepare(
    "UPDATE reset_notices SET attempts = $attempts, next_attempt_at = $next WHERE dedupe_key = $key",
  );
  const markAbandoned = db.prepare(
    "UPDATE reset_notices SET delivered_at = $at, attempts = $attempts, next_attempt_at = NULL WHERE dedupe_key = $key",
  );

  async function postOnce(event: ResetEvent): Promise<void> {
    const req = buildWebhookRequest({ url, format, secret, event });
    let lastError = "delivery failed";
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
      try {
        const res = await fetchFn(req.url, {
          method: "POST",
          headers: req.headers,
          body: req.body,
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status >= 200 && res.status < 300) return;
        lastError = `HTTP ${res.status}`;
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable) break;
      } catch (err) {
        lastError = redact((err as Error).message, url, secret);
      }
      const delay = retryDelaysMs[attempt];
      if (delay === undefined) break;
      await sleep(delay);
    }
    throw new Error(lastError);
  }

  async function tryDeliver(event: ResetEvent, now: Date): Promise<void> {
    const row = getNotice.get({ $key: event.dedupeKey }) as
      | { delivered_at: string | null; attempts: number; next_attempt_at: string | null }
      | undefined;
    if (row?.delivered_at) return;
    if (row?.next_attempt_at && Date.parse(row.next_attempt_at) > now.getTime()) return;
    const attempts = (row?.attempts ?? 0) + 1;
    try {
      await postOnce(event);
      markDelivered.run({ $key: event.dedupeKey, $at: now.toISOString() });
      log(`notifier: delivered ${event.provider} ${event.window}`);
    } catch (err) {
      const message = redact((err as Error).message, url, secret);
      if (attempts >= MAX_ATTEMPTS) {
        markAbandoned.run({ $key: event.dedupeKey, $at: now.toISOString(), $attempts: attempts });
        log(`notifier: gave up on ${event.provider} ${event.window} after ${attempts} attempts (${message})`);
        return;
      }
      const wait = Math.min(15 * 60_000, 30_000 * 2 ** (attempts - 1));
      const next = new Date(now.getTime() + wait).toISOString();
      markRetry.run({ $key: event.dedupeKey, $attempts: attempts, $next: next });
      log(`notifier: ${event.provider} ${event.window} delivery failed (${message}); retrying`);
    }
  }

  return {
    async scan(at: Date) {
      const nowIso = at.toISOString();
      const pending = listPending.all({ $now: nowIso }) as Array<{
        dedupe_key: string;
        payload: string;
        provider: string;
        quota_window: string;
      }>;
      for (const row of pending) {
        try {
          const payload = JSON.parse(row.payload) as ResetEvent;
          await tryDeliver(payload, at);
        } catch (err) {
          log(`notifier: could not retry ${row.provider} ${row.quota_window} (${redact((err as Error).message, url, secret)})`);
        }
      }

      const current = windowsFromPoints(deps.db.latestPoints());
      const snaps = listSnapshots.all() as Array<{
        provider: string;
        quota_window: string;
        used_percent: number | null;
        resets_at: string | null;
        observed_at: string;
      }>;
      const prevByKey = new Map(snaps.map((s) => [`${s.provider}|${s.quota_window}`, s]));

      for (const w of current) {
        const key = `${w.provider}|${w.window}`;
        const prev = prevByKey.get(key);
        if (prev) {
          const event = detectReset(
            {
              provider: prev.provider,
              window: prev.quota_window,
              usedPercent: prev.used_percent,
              resetsAt: prev.resets_at,
              observedAt: prev.observed_at,
            },
            w,
            at,
          );
          if (event) {
            insertNotice.run({
              $key: event.dedupeKey,
              $provider: event.provider,
              $window: event.window,
              $payload: JSON.stringify(event),
              $detected: event.detectedAt,
            });
            await tryDeliver(event, at);
          }
        }
        upsertSnapshot.run({
          $provider: w.provider,
          $window: w.window,
          $used: w.usedPercent,
          $resets: w.resetsAt,
          $source: w.source,
          $at: nowIso,
        });
      }
    },
  };
}
