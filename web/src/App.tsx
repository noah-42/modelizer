import { useEffect, useState } from "react";
import {
  fetchAudit,
  fetchDiary,
  fetchOverview,
  fetchSessions,
  fetchSubscriptions,
  type AuditEventRow,
  type DiaryDay,
  type Overview,
  type OverviewProvider,
  type SessionInfo,
  type SessionsResponse,
  type Subscription,
  type SubscriptionsResponse,
  type UsagePoint,
} from "./api";

const REFRESH_MS = 30_000;
const HIDDEN_KEY = "modelizer.hiddenProviders";

function loadHidden(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

const LABELS: Record<string, string> = {
  "coding-5h": "5-hour token window",
  "claude-5h": "5h tokens (estimated)",
  "claude-5h-percent": "5-hour window (Claude)",
  "claude-weekly-percent": "Weekly window (Claude)",
  "claude-5h-turns": "5-hour session turns",
  "codex-5h": "5h tokens (estimated)",
  "codex-5h-percent": "5-hour window (OpenAI)",
  "codex-weekly-percent": "Weekly window (OpenAI)",
  "codex-5h-turns": "5-hour session turns",
  monthly: "Monthly token pool",
  "token-window": "Token window",
  mcp: "MCP tool calls",
  "coding-window-by-model": "Window usage",
  "model-daily": "Daily usage",
  "model-spend": "Daily spend (API-equivalent)",
  "payg-balance": "PAYG balance",
  "key-spend-limit": "Key spend limit",
  "key-lifetime-spend": "Key lifetime spend",
  "spend-daily": "Spend · today",
  "spend-weekly": "Spend · this week",
  "spend-monthly": "Spend · this month",
  "free-model-requests-daily": "Free-model requests · daily",
  credits: "Account credits",
};

function friendlyLabel(label: string): string {
  return LABELS[label] ?? label;
}

type Tab = "dashboard" | "subscriptions" | "audit" | "diary";

export function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  return (
    <div className="page">
      <header className="header">
        <h1>modelizer</h1>
      </header>
      <nav className="tabs">
        {(["dashboard", "subscriptions", "audit", "diary"] as const).map((t) => (
          <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>
      {tab === "dashboard" && <DashboardView />}
      {tab === "subscriptions" && <SubscriptionsView />}
      {tab === "audit" && <AuditView />}
      {tab === "diary" && <DiaryView />}
    </div>
  );
}

function DashboardView() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [hidden, setHidden] = useState<string[]>(loadHidden);

  useEffect(() => {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(hidden));
  }, [hidden]);

  const toggle = (id: string) =>
    setHidden((h) => (h.includes(id) ? h.filter((x) => x !== id) : [...h, id]));

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const ov = await fetchOverview();
        if (alive) {
          setOverview(ov);
          setError(null);
        }
      } catch (err) {
        if (alive) setError((err as Error).message);
      }
    };
    void load();
    const timer = setInterval(load, REFRESH_MS);
    const ticker = setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      alive = false;
      clearInterval(timer);
      clearInterval(ticker);
    };
  }, []);

  const visible = overview?.providers.filter((p) => !hidden.includes(p.id)) ?? [];
  const upcoming = visible
    .flatMap((p) =>
      p.points
        .filter((pt) => pt.reset_at !== null && Date.parse(pt.reset_at) > Date.now())
        .map((pt) => ({ provider: p.id, label: pt.label, resetAt: pt.reset_at as string })),
    )
    .sort((a, b) => Date.parse(a.resetAt) - Date.parse(b.resetAt));
  const nextReset = upcoming[0];

  return (
    <>
      <div className="head-line">
        <span className="muted">
          {overview ? `updated ${relTime(overview.generatedAt, tick)}` : error ? "…" : "loading"}
        </span>
      </div>

      {error && (
        <div className="banner error">
          Can't reach the modelizer server ({error}). Is <code>bun run dev</code> running?
        </div>
      )}

      {overview?.providers.length === 0 && (
        <div className="banner">No providers enabled — edit modelizer.toml.</div>
      )}

      {nextReset && (
        <div className="next-reset" title={nextReset.resetAt}>
          <span className="status-dot" />
          <span>
            next reset: <strong>{nextReset.provider} · {friendlyLabel(nextReset.label)}</strong> in{" "}
            <strong className="countdown">{countdownLong(nextReset.resetAt, tick)}</strong> · at{" "}
            {fmtLocalClock(nextReset.resetAt)}
          </span>
        </div>
      )}

      <div className="cards">
        {overview?.providers
          .filter((p) => !hidden.includes(p.id))
          .map((p) => (
            <ProviderCard key={p.id} provider={p} tick={tick} onHide={() => toggle(p.id)} />
          ))}
      </div>

      {overview && hidden.length > 0 && (
        <div className="hidden-strip">
          <span className="muted">hidden:</span>
          {hidden
            .filter((id) => overview.providers.some((p) => p.id === id))
            .map((id) => (
              <button key={id} className="chip" onClick={() => toggle(id)} aria-label={`show ${id}`}>
                {id} <span className="chip-plus">+</span>
              </button>
            ))}
        </div>
      )}
    </>
  );
}

function AuditView() {
  const [sessions, setSessions] = useState<SessionsResponse | null>(null);
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const [events, setEvents] = useState<AuditEventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const s = await fetchSessions();
        if (alive) {
          setSessions(s);
          if (selected === undefined && s.currentSessionId !== null) setSelected(s.currentSessionId);
        }
      } catch (err) {
        if (alive) setError((err as Error).message);
      }
    };
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [selected]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetchAudit(selected);
        if (alive) {
          setEvents(res.events);
          setError(null);
        }
      } catch (err) {
        if (alive) setError((err as Error).message);
      }
    };
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [selected]);

  const sessionLabel = (s: SessionInfo): string => {
    const running = s.stopped_at === null;
    return `#${s.id} · ${new Date(s.started_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}${running ? " · running" : ""}`;
  };

  return (
    <>
      <div className="head-line">
        <select
          className="session-select"
          value={selected ?? ""}
          onChange={(e) => setSelected(e.target.value === "" ? undefined : Number(e.target.value))}
          aria-label="session"
        >
          {sessions?.sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {sessionLabel(s)}
            </option>
          ))}
        </select>
        <span className="muted">
          {events === null ? "…" : `${events.length} event${events.length === 1 ? "" : "s"}`}
        </span>
      </div>
      {error && <div className="banner error">{error}</div>}
      <div className="card">
        {events !== null && events.length === 0 && (
          <p className="muted">No events recorded for this session yet.</p>
        )}
        {events?.map((e) => (
          <div key={e.id} className="audit-row">
            <span className="audit-time">{fmtClock(e.at)}</span>
            <span className={`level level-${e.level}`}>{e.level}</span>
            <span className="audit-provider">{e.provider ?? "server"}</span>
            <span className="audit-event">
              {e.event}
              {e.detail && <span className="muted audit-detail"> — {e.detail}</span>}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function DiaryView() {
  const [days, setDays] = useState<DiaryDay[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetchDiary(14);
        if (alive) {
          setDays(res.days);
          setError(null);
        }
      } catch (err) {
        if (alive) setError((err as Error).message);
      }
    };
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <>
      {error && <div className="banner error">{error}</div>}
      {days !== null && days.length === 0 && (
        <div className="banner">No recorded days yet — the diary fills as modelizer runs.</div>
      )}
      {days?.map((day) => (
        <section key={day.date} className="card diary-day">
          <div className="card-head">
            <h2>{new Date(day.date + "T12:00:00Z").toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}</h2>
            {(day.warnings > 0 || day.errors > 0) && (
              <div className="badges">
                {day.errors > 0 && <span className="badge bad">{day.errors} error{day.errors === 1 ? "" : "s"}</span>}
                {day.warnings > 0 && <span className="badge warn">{day.warnings} warning{day.warnings === 1 ? "" : "s"}</span>}
              </div>
            )}
          </div>
          {day.providers.map((prov) => (
            <div key={prov.id} className="diary-provider">
              <div className="diary-provider-name">{prov.id}</div>
              {prov.entries.map((en, i) => (
                <div key={`${en.label}/${en.model ?? ""}/${i}`} className="diary-entry">
                  <span className="diary-entry-label">
                    {friendlyLabel(en.label)}
                    {en.model && <span className="model-line-inline"> · {en.model}</span>}
                  </span>
                  <span className="diary-entry-value">{diaryValue(en)}</span>
                </div>
              ))}
            </div>
          ))}
        </section>
      ))}
    </>
  );
}

function SubscriptionsView() {
  const [data, setData] = useState<SubscriptionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetchSubscriptions();
        if (alive) {
          setData(res);
          setError(null);
        }
      } catch (err) {
        if (alive) setError((err as Error).message);
      }
    };
    void load();
    const timer = setInterval(load, 60_000);
    const ticker = setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      alive = false;
      clearInterval(timer);
      clearInterval(ticker);
    };
  }, []);

  const rows = data?.subscriptions ?? [];
  return (
    <>
      <div className="head-line">
        <span className="muted">
          {data === null
            ? "loading"
            : `${fmtUsd(data.totalMonthlyUsd)} per month · price and charge day from ${data.configPath}`}
        </span>
      </div>
      {error && <div className="banner error">Can't reach the modelizer server ({error}).</div>}
      {data?.error && <div className="banner error">{data.error} — fix the file; no restart needed.</div>}
      {data !== null && data.error === null && rows.length === 0 && (
        <div className="banner">
          No subscriptions yet — copy <code>subscriptions.example.toml</code> to <code>{data.configPath}</code> and list
          what you pay for.
        </div>
      )}
      {rows.length > 0 && data !== null && (
        <div className="subs-summary">
          <strong>{fmtUsd(data.totalMonthlyUsd)}</strong>
          <span className="muted">
            per month · {rows.length} subscription{rows.length === 1 ? "" : "s"}
          </span>
        </div>
      )}
      <div className="cards">
        {rows.map((s) => (
          <SubscriptionCard key={s.provider} s={s} tick={tick} />
        ))}
      </div>
    </>
  );
}

function SubscriptionCard({ s, tick }: { s: Subscription; tick: number }) {
  const seats = s.seats !== null && s.seats > 1 ? ` · ${s.seats} seats` : "";
  return (
    <section className="card">
      <div className="card-head">
        <h2>{s.provider}</h2>
        <div className="badges">
          <span className={`badge ${stateTone(s.state)}`}>{s.state}</span>
        </div>
      </div>
      <div className="sub-plan">
        {s.plan}
        <span className="muted">
          {s.period === "annual" ? " · billed yearly" : " · billed monthly"}
          {seats}
        </span>
      </div>
      <div className="sub-line">
        <span className="muted">monthly cost</span>
        <span>
          {s.monthlyUsd === null ? (
            <span className="muted">set price_usd</span>
          ) : (
            <strong>{fmtUsd(s.monthlyUsd)}</strong>
          )}
        </span>
      </div>
      <div className="sub-line">
        <span className="muted">next charge</span>
        <span>
          {s.renewsAt === null ? (
            <span className="muted">set renews_day</span>
          ) : (
            <span title={s.renewsAt}>
              {fmtRenewalDay(s.renewsAt)} · in {countdown(s.renewsAt, tick)}
            </span>
          )}
        </span>
      </div>
      <div className="sub-line">
        <span className="muted">source</span>
        <span className={s.configured ? "muted" : "warn-text"}>
          {s.configured ? s.source : `${s.source} · not in subscriptions.toml`}
        </span>
      </div>
    </section>
  );
}

function stateTone(state: Subscription["state"]): string {
  if (state === "active") return "good";
  if (state === "trialing") return "warn";
  if (state === "past_due" || state === "cancelled") return "bad";
  return "muted-badge";
}

function fmtUsd(n: number): string {
  return fmtValue(n, "usd");
}

/** The charge day is a calendar fact, so read the instant in UTC — not the browser's offset. */
function fmtRenewalDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric" });
}

function diaryValue(en: { used: number | null; limit: number | null; remaining: number | null; unit: string }): string {
  if (en.unit === "percent" && en.used !== null) return `${Math.round(en.used)}%`;
  if (en.used !== null && en.limit !== null) return `${fmtValue(en.used, en.unit)} / ${fmtValue(en.limit, en.unit)}`;
  if (en.used !== null) return fmtValue(en.used, en.unit);
  if (en.remaining !== null) return `${fmtValue(en.remaining, en.unit)} left`;
  return "—";
}

function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function statusOf(p: OverviewProvider): { label: string; className: string } {
  if (!p.configured) return { label: "not configured", className: "badge muted-badge" };
  if (p.consecutiveFailures > 0 && p.lastError)
    return { label: `failing ×${p.consecutiveFailures}`, className: "badge bad" };
  if (p.stale) return { label: "stale", className: "badge warn" };
  return { label: "ok", className: "badge good" };
}

/** Aggregate per-model daily history (tokens or spend) into today/total totals, busiest first. */
interface ModelRow {
  label: string;
  model: string;
  unit: UsagePoint["unit"];
  today: number;
  total: number;
  /** Cost derived from list prices rather than reported by the provider. */
  equivalent: boolean;
}

function modelRows(points: UsagePoint[]): ModelRow[] {
  const todayStr = new Date().toISOString().slice(0, 10);
  const by = new Map<string, ModelRow>();
  for (const pt of points) {
    if (!pt.model || pt.day === null) continue;
    if (pt.label !== "model-daily" && pt.label !== "model-spend") continue;
    const value = pt.used ?? pt.cost_usd ?? 0;
    const key = `${pt.label}|${pt.model}`;
    const cur = by.get(key) ?? {
      label: pt.label,
      model: pt.model,
      unit: pt.unit,
      today: 0,
      total: 0,
      equivalent: pt.source === "pricing",
    };
    cur.total += value;
    if (pt.day === todayStr) cur.today += value;
    by.set(key, cur);
  }
  return [...by.values()].sort((a, b) => b.total - a.total);
}

/** One row per model: today's figure first, then the recorded total in the same unit. */
function ModelTable({ rows, suffix }: { rows: ModelRow[]; suffix: string }) {
  return (
    <>
      {rows.map((m) => (
        <div key={`${m.label}/${m.model}`} className="model-row">
          <span className="model-name">{m.model}</span>
          <span className="model-nums">
            <strong>{fmtValue(m.today, m.unit)}</strong> today · {fmtValue(m.total, m.unit)} {suffix}
          </span>
        </div>
      ))}
    </>
  );
}

function ProviderCard({
  provider: p,
  tick,
  onHide,
}: {
  provider: OverviewProvider;
  tick: number;
  onHide: () => void;
}) {
  const status = statusOf(p);
  return (
    <section className="card">
      <div className="card-head">
        <h2>{p.id}</h2>
        <div className="badges">
          <span className="badge tier" title={`polls every ${p.pollEverySeconds}s`}>
            T{p.stabilityTier}
          </span>
          <span className={status.className}>{status.label}</span>
          <button className="icon-btn" onClick={onHide} aria-label={`hide ${p.id}`} title="hide card">
            ✕
          </button>
        </div>
      </div>
      {p.status.map((s) => (
        <div key={s.label} className={`status-line ${s.tone}`} title={s.until ?? undefined}>
          <span className="status-dot" />
          <span>
            {s.label}: <strong>{s.state}</strong>
            {s.until && <> · until {fmtLocalClock(s.until)}</>}
          </span>
        </div>
      ))}
      {p.lastError && (
        <p className="card-error" title={`at ${p.lastErrorAt ?? "?"}`}>
          {p.lastError}
        </p>
      )}
      {p.points.length === 0 ? (
        <p className="muted">
          {p.subscription !== null
            ? `${p.subscription.plan} — plan only, no usage numbers; see the subscriptions tab`
            : p.configured
              ? "no data yet — first poll may still be running"
              : "waiting for credentials in .env"}
        </p>
      ) : (
        <div className="points">
          {p.points
            .filter((x) => x.day === null)
            .map((point) => (
              <PointRow
                key={`${point.kind}/${point.label}/${point.model ?? ""}/${point.day ?? ""}`}
                point={point}
                tick={tick}
              />
            ))}
        </div>
      )}
      {(() => {
        const rows = modelRows(p.points);
        const tokenRows = rows.filter((r) => r.label === "model-daily");
        const spendRows = rows.filter((r) => r.label === "model-spend");
        const spendIsEquivalent = spendRows.length > 0 && spendRows.every((r) => r.equivalent);
        const feedFailed = p.degradedEndpoints.find(
          (d) => d.endpoint === "model-usage" || d.endpoint === "activity",
        );
        const feedName = feedFailed?.endpoint === "activity" ? "spend" : "token usage";
        if (rows.length === 0 && feedFailed === undefined) return null;
        const degraded = feedFailed !== undefined && (
          <span className="degraded-note" title={`${feedFailed.endpoint} endpoint failed at ${p.lastSuccess ?? "?"}`}>
            {" "}
            ⚠ {feedName} check failed (HTTP {feedFailed.status}) — data below may be stale
          </span>
        );
        return (
          <>
            {tokenRows.length > 0 && (
              <details className="notes models">
                <summary>
                  Per-model usage · 7 days
                  {feedFailed?.endpoint === "model-usage" && degraded}
                </summary>
                <ModelTable rows={tokenRows} suffix="7d" />
              </details>
            )}
            {spendRows.length > 0 && (
              <details className="notes models">
                <summary>
                  {spendIsEquivalent ? "Per-model spend · API-equivalent" : "Per-model spend · 30 days"}
                  {feedFailed?.endpoint === "activity" && degraded}
                </summary>
                <ModelTable rows={spendRows} suffix={spendIsEquivalent ? "recorded" : "30d"} />
              </details>
            )}
            {rows.length === 0 && feedFailed !== undefined && (
              <p className="note">No {feedName} data — the {feedFailed.endpoint} endpoint is failing.</p>
            )}
          </>
        );
      })()}
      {p.notes.length > 0 && (
        <details className="notes">
          <summary>Pricing &amp; notes</summary>
          {p.notes.map((n) => (
            <p key={n.title} className="note">
              <strong>{n.title}.</strong> {n.text}
            </p>
          ))}
        </details>
      )}
      <p className="muted card-foot">
        {p.lastSuccess
          ? `last poll ${relTime(p.lastSuccess, tick)} · next in ${nextIn(p.lastSuccess, p.pollEverySeconds, tick)}`
          : "never polled"}
      </p>
    </section>
  );
}

function PointRow({ point: p, tick }: { point: UsagePoint; tick: number }) {
  const hasBar = p.used !== null && p.limit !== null && p.limit > 0;
  const pct = hasBar ? Math.min(100, ((p.used as number) / (p.limit as number)) * 100) : null;
  const isPercent = p.unit === "percent";
  return (
    <div className="point-row">
      <div className="point-label">
        <span className={`kind kind-${p.kind}`}>{p.kind}</span>
        <span>{friendlyLabel(p.label)}</span>
        {p.model && <span className="model-line">{p.model}</span>}
      </div>
      <div className="point-values">
        {isPercent && p.used !== null && <strong>{fmtValue(p.used, p.unit)}</strong>}
        {!isPercent && (p.used !== null || p.limit !== null) && (
          <>
            {p.used !== null && <strong>{fmtValue(p.used, p.unit)}</strong>}
            {p.limit !== null && <span className="muted"> / {fmtValue(p.limit, p.unit)}</span>}
          </>
        )}
        {p.remaining !== null && p.kind === "balance" && (
          <span className="remaining"> · {fmtValue(p.remaining, p.unit)} left</span>
        )}
        {pct !== null && (
          <div className="bar">
            <div className={`bar-fill ${pct > 85 ? "hot" : ""}`} style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      <div className="point-meta">
        {p.reset_at && (
          <span title={p.reset_at}>
            ↻ {countdown(p.reset_at, tick)} · {fmtLocalClock(p.reset_at)}
          </span>
        )}
        <span className="muted">{relTime(p.captured_at, tick)}</span>
      </div>
    </div>
  );
}

function fmtValue(n: number, unit: string): string {
  if (unit === "usd") return `$${n.toFixed(n < 100 ? 2 : 0)}`;
  if (unit === "cny") return `¥${n.toFixed(n < 100 ? 2 : 0)}`;
  if (unit === "percent") return `${Math.round(n)}%`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

function relTime(iso: string, _tick: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function countdown(iso: string, _tick: number): string {
  const seconds = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if (seconds <= 0) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

// Precise ticking countdown for the banner: "2h 13m", "4m 09s", "28d 3h".
function countdownLong(iso: string, _tick: number): string {
  const total = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 1000));
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (total >= 86_400) return `${d}d ${h}h`;
  if (total >= 3600) return `${h}h ${pad(m)}m`;
  return `${m}m ${pad(s)}s`;
}

function nextIn(lastSuccessIso: string, pollEverySeconds: number, _tick: number): string {
  const remaining = Math.round((Date.parse(lastSuccessIso) + pollEverySeconds * 1000 - Date.now()) / 1000);
  if (remaining <= 0) return "moments";
  if (remaining < 90) return `${remaining}s`;
  return `${Math.round(remaining / 60)}m`;
}

// Browser-local timezone (so Berlin CET/CEST for you), DST handled by Intl.
function fmtLocalClock(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return time;
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${date}, ${time}`;
}
