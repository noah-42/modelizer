import type { Adapter, RawPoll, UsagePoint } from "./adapters/types";
import type { AuditLevel, Db } from "./db";

export interface AuditEvent {
  at: string;
  provider: string | null;
  level: AuditLevel;
  event: string;
  detail?: string | undefined;
}

export type AuditSink = (event: AuditEvent) => void;

export interface PollOutcome {
  provider: string;
  ok: boolean;
  points: UsagePoint[];
  error?: string;
  nextDueInMs: number;
}

export interface SchedulerDeps {
  adapters: Adapter[];
  db: Db;
  env: Record<string, string | undefined>;
  /** Injectable for tests; defaults to real time. */
  clock?: () => Date;
  fetchFn?: typeof fetch;
  maxBackoffMs?: number;
  /** Injectable jitter source in [0,1); defaults to Math.random. Spreads polls ±10%. */
  random?: () => number;
  log?: (msg: string) => void;
  /** Optional audit sink; every poll outcome and skip is recorded. */
  audit?: AuditSink;
}

class HttpPollError extends Error {
  retryAfterMs: number | null;
  constructor(poll: RawPoll) {
    const snippet = poll.body.slice(0, 200).replace(/\s+/g, " ");
    super(`${poll.endpoint} ${poll.url} → HTTP ${poll.status}${snippet ? `: ${snippet}` : ""}`);
    this.retryAfterMs = retryAfterMs(poll);
  }
}

function retryAfterMs(poll: RawPoll): number | null {
  const retryAfter = poll.headers["retry-after"];
  const seconds = retryAfter !== undefined ? Number(retryAfter) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

export class Scheduler {
  private readonly adapters: Adapter[];
  private readonly db: Db;
  private readonly env: Record<string, string | undefined>;
  private readonly clock: () => Date;
  private readonly fetchFn: typeof fetch;
  private readonly maxBackoffMs: number;
  private readonly random: () => number;
  private readonly log: (msg: string) => void;
  private readonly audit: AuditSink | undefined;
  private nextDue = new Map<string, number>();

  constructor(deps: SchedulerDeps) {
    this.adapters = deps.adapters;
    this.db = deps.db;
    this.env = deps.env;
    this.clock = deps.clock ?? (() => new Date());
    this.fetchFn = deps.fetchFn ?? fetch;
    this.maxBackoffMs = deps.maxBackoffMs ?? 3600_000;
    this.random = deps.random ?? Math.random;
    this.log = deps.log ?? (() => {});
    this.audit = deps.audit;
  }

  private emitAudit(atIso: string, provider: string | null, level: AuditLevel, event: string, detail?: string) {
    if (this.audit) this.audit({ at: atIso, provider, level, event, detail });
  }

  adapter(id: string): Adapter | undefined {
    return this.adapters.find((a) => a.id === id);
  }

  private nowMs(): number {
    return this.clock().getTime();
  }

  isDue(id: string): boolean {
    return (this.nextDue.get(id) ?? 0) <= this.nowMs();
  }

  async runProvider(id: string): Promise<PollOutcome> {
    const adapter = this.adapter(id);
    if (!adapter) throw new Error(`unknown provider: ${id}`);
    const capturedAt = new Date(this.nowMs()).toISOString();

    if (!adapter.isConfigured(this.env)) {
      const error = `missing credentials: ${adapter.missingCredentials(this.env).join(", ")}`;
      this.db.updateAdapterState(id, { ok: false, error, at: capturedAt });
      this.nextDue.set(id, this.nowMs() + adapter.pollEveryMs);
      this.log(`${id}: ${error}`);
      this.emitAudit(capturedAt, id, "warn", "missing credentials", adapter.missingCredentials(this.env).join(", "));
      return { provider: id, ok: false, points: [], error, nextDueInMs: adapter.pollEveryMs };
    }

    try {
      const polls = await adapter.collect({
        fetchFn: this.fetchFn,
        env: this.env,
        now: new Date(this.nowMs()),
        log: this.log,
      });
      const failed = polls.find((p) => (p.status < 200 || p.status >= 300) && p.optional !== true);
      if (failed) throw new HttpPollError(failed);
      if (polls.length === 0) throw new Error("adapter collected nothing");
      const skipped: string[] = [];
      for (const p of polls) {
        if (p.status < 200 || p.status >= 300) {
          const msg = `optional poll ${p.endpoint} failed (HTTP ${p.status}) — skipping`;
          this.log(`${id}: ${msg}`);
          skipped.push(`${p.endpoint} HTTP ${p.status}`);
        }
      }

      const points = adapter.normalize(polls, capturedAt);
      this.db.insertRawPolls(id, polls, capturedAt);
      this.db.insertPoints(points);
      this.db.updateAdapterState(id, { ok: true, at: capturedAt });

      // ±10% jitter keeps providers from polling in lockstep bursts; a retry-after on a
      // degraded (optional-poll) run delays the next visit further.
      const jittered = Math.round(adapter.pollEveryMs * (0.9 + 0.2 * this.random()));
      const degraded429 = polls
        .filter((p) => p.status === 429 && p.optional === true)
        .map((p) => retryAfterMs(p) ?? 0);
      const waitMs = Math.max(jittered, ...degraded429);
      this.nextDue.set(id, this.nowMs() + waitMs);
      this.log(`${id}: ok (${points.length} points)`);
      this.emitAudit(
        capturedAt,
        id,
        "info",
        `poll ok — ${points.length} points`,
        skipped.length > 0 ? `skipped: ${skipped.join(", ")}` : undefined,
      );
      return { provider: id, ok: true, points, nextDueInMs: waitMs };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const failures = (this.db.getAdapterState(id)?.consecutive_failures ?? 0) + 1;
      const backoff = Math.min(adapter.pollEveryMs * 2 ** failures, this.maxBackoffMs);
      const retryAfter = err instanceof HttpPollError ? err.retryAfterMs : null;
      const waitMs = Math.max(backoff, retryAfter ?? 0);
      this.db.updateAdapterState(id, { ok: false, error, at: capturedAt });
      this.nextDue.set(id, this.nowMs() + waitMs);
      this.log(`${id}: FAILED (${error}); backing off ${Math.round(waitMs / 1000)}s`);
      this.emitAudit(capturedAt, id, "error", "poll failed", `${error}; backing off ${Math.round(waitMs / 1000)}s`);
      return { provider: id, ok: false, points: [], error, nextDueInMs: waitMs };
    }
  }

  /** Poll every adapter whose interval elapsed. Returns outcomes; never throws. */
  async tick(): Promise<PollOutcome[]> {
    const due = this.adapters.filter((a) => this.isDue(a.id)).map((a) => a.id);
    const outcomes: PollOutcome[] = [];
    for (const id of due) {
      try {
        outcomes.push(await this.runProvider(id));
      } catch (err) {
        // runProvider only throws for unknown ids; treat as fatal-but-contained
        this.log(`tick: ${id}: ${(err as Error).message}`);
      }
    }
    return outcomes;
  }

  start(tickIntervalMs: number): () => void {
    const timer = setInterval(() => {
      void this.tick().catch((err) => this.log(`tick crashed: ${(err as Error).message}`));
    }, tickIntervalMs);
    return () => clearInterval(timer);
  }
}
