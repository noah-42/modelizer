# Plan: LLM Usage Dashboard (modelizer)

- **Plan ID:** MOD001
- **Date:** 2026-10-oct-03
- **Status:** active
- **Audience:** pi
- **Mode:** standard
- **Scope:** One self-hosted web dashboard that polls usage/balance/quota across all my LLM subscriptions and APIs, so I never log into each provider's site separately.
- **Source:** ZCode (planning session, 2026-10-03)

## Goal

A single local web page answers, at a glance: **"How much of each LLM service have I used, what's left, and when does it reset?"** — covering subscriptions (quota windows like Claude's 5h/weekly, Cursor's plan cycle, Copilot credits, GLM Coding Plan) and pay-as-you-go accounts (balances and spend history, e.g. OpenRouter, Z.AI payg, Moonshot).

Success criteria:

1. Open `http://localhost:PORT` → one card per provider showing used/limit (or balance), reset countdown, and data freshness.
2. Regular providers — **OpenRouter, Cursor, Copilot, Z.AI** — fully tracked automatically.
3. Occasional providers — **Claude, ChatGPT, Kimi, OpenCode** — tracked where a data path exists; documented as UI-only where none does.
4. History retained in SQLite: spend-over-time and usage-over-time charts per provider.
5. One provider's API breaking degrades only that provider's card (stale badge + last error), never the dashboard.
6. Keys never leave env vars / local token files; nothing committed, nothing rendered in the UI.

## Context

### Why now

I use a rotating set of LLM services (OpenRouter, Cursor, Copilot, Z.AI regularly; Claude, ChatGPT, Kimi, OpenCode sometimes) and each exposes usage in a different place with different semantics. Checking means logging into ~6 dashboards. Verified research (2026-10-03, see matrix) shows every provider is machine-readable except ChatGPT subscription and OpenCode Zen credits — so aggregation is possible today.

### What exists (and why we still build)

| Tool | What it does | Why it doesn't solve this |
|---|---|---|
| LiteLLM / Helicone / Langfuse | Full observability via proxy/SDK | Only see traffic routed through them; blind to native apps (Cursor app, VS Code Copilot, Claude Code in terminal, web ChatGPT) |
| ccusage (~19k★) | Parses local agent logs (Claude Code, OpenCode, Codex, …), `--json` output | CLI report only, no web UI, no provider APIs/balances — but we **reuse it as a data source** |
| openusage (~4k★) | macOS menu-bar app; Cursor/Copilot/Claude personal endpoints | Native app, not web; not extensible into a dashboard |
| CostMon (commercial) | Polls Anthropic/OpenAI admin APIs | Cost-only, closed, misses subscriptions/quotas |

### Provider data matrix (verified 2026-10-03)

Stability tiers: **T1** = official documented API · **T2** = undocumented, community-established (live tools depend on it) · **T3** = local files on my machine · **T4** = no programmatic path.

| Provider | Data | Entry point | Auth | Stability |
|---|---|---|---|---|
| **OpenRouter** | Key usage + limits | `GET openrouter.ai/api/v1/key` | `OPENROUTER_API_KEY` | **T1** |
| | Account credits | `GET /api/v1/credits` | `OPENROUTER_MANAGEMENT_KEY` | **T1** |
| | 30-day per-model spend | `GET /api/v1/activity`, `POST /api/v1/analytics/query` | management key | **T1** |
| **Z.AI** | Payg balance | `GET api.z.ai/api/paas/v4/balance` | `ZAI_API_KEY` | **T2** (no official usage API exists) |
| | Coding Plan quota (5h/month windows) | `GET api.z.ai/api/coding/usage`; `GET /api/monitor/usage/quota/limit` | coding-plan key | **T2** |
| | Per-model token time series | `GET /api/monitor/usage/model-usage` | key | **T2** |
| **Cursor** (personal plan) | Plan-cycle usage, model pools, request count | `POST api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` (+ `GetPlanInfo`, `GetCreditGrantsBalance`) | Cursor access token from local app state | **T2** — highest brittleness risk |
| | Per-day usage history (CSV) | `GET cursor.com/api/dashboard/export-usage-events-csv` | `WorkosCursorSessionToken` cookie | **T2** |
| **Copilot** (personal) | Quota buckets % remaining, `credits_used`, reset countdown | `GET api.github.com/copilot_internal/user` | token from `~/.config/github-copilot/apps.json` or `gh` (scheme: `token`, not `Bearer`; needs editor headers) | **T2** (same endpoint VS Code's usage view reads) |
| **Claude** (Pro/Max sub) | 5h + weekly quota windows, per-model split | `GET api.anthropic.com/api/oauth/usage` | OAuth token from `~/.claude.json` (`claudeAiOauth.accessToken`) | **T2** |
| | Full local usage history | `~/.claude/projects/**/*.jsonl` → run `ccusage daily --json` | local files | **T3** (ccusage is maintained; it also parses OpenCode) |
| **Claude/OpenAI API** (if payg) | Daily tokens + USD | Anthropic `GET /v1/organizations/{usage_report/messages,cost_report}` (admin key); OpenAI `GET /v1/organization/{usage/completions,costs}` (org admin key, ~100d depth) | `ANTHROPIC_ADMIN_API_KEY` / `OPENAI_ADMIN_API_KEY` | **T1** |
| **Kimi** | Payg balance | `GET api.moonshot.ai/v1/users/me/balance` | `MOONSHOT_API_KEY` | **T1** (balance only) |
| | Kimi Coding Plan pools | `GET {apiBase}/coding/v1/usages` | coding-plan key | **T2** |
| **OpenCode** | Token/cost stats per session/day | `opencode stats` CLI; or read `~/.local/share/opencode/opencode.db` | local | **T3** |
| **ChatGPT** (Plus/Pro sub) | — | none; Usage API explicitly excludes ChatGPT | — | **T4** |
| **OpenCode Zen** | prepaid credits | none found; web dashboard only | — | **T4** |

### Constraints

- Local-first personal tool: single process, SQLite, no multi-user auth (bind localhost by default).
- T2 endpoints will break eventually: adapters must be isolated, raw responses archived so a broken adapter is a quick fix, and staleness visible in the UI.
- Poll gently: default 15 min per provider (Cursor history CSV 1×/day), honor `retry-after`, back off on repeated failure.
- Secrets stay in env vars / existing local token files (framework §14) — never in the DB, config file, or UI.

## Architecture

**Stack (recommendation):** TypeScript throughout — Bun runtime, Hono server, `better-sqlite3`, Vite + React front end. One language for collectors and UI, single process, trivially runnable on a Mac (`bun run src/index.ts`). Alternatives if rejected: Python/FastAPI (collectors are HTTP+JSON, fine either way); Go (single binary, more upfront work for charts ecosystem).

**Shape:** scheduler → adapters → normalizer → SQLite → HTTP API → React dashboard.

```
src/
  index.ts            # start scheduler + server (localhost:7788 default)
  config.ts           # load modelizer.toml + env; provider enablement
  db.ts               # SQLite schema + queries
  scheduler.ts        # per-provider cadence, backoff, retry-after
  adapters/
    types.ts          # Adapter interface
    openrouter.ts     zai.ts   cursor.ts   copilot.ts
    claude.ts         kimi.ts  openai.ts   opencode.ts
  normalize.ts        # raw response → UsagePoint
  routes/             # JSON API for the front end
web/                  # Vite + React SPA
```

**Adapter contract** (every provider implements the same interface):

- `id`, `stabilityTier`, `pollEvery` (default 15m)
- `collect(): RawResult[]` — fetch, never throw past the adapter boundary
- `normalize(raw): UsagePoint[]` — pure, unit-testable against fixtures

**Normalized record** (`usage_points` table) covers all three data shapes:

| kind | fields that matter |
|---|---|
| `quota` | used, limit, remaining, window_start/window_end, reset_at (Claude 5h/week, Cursor cycle, Copilot credits, GLM windows) |
| `balance` | amount, currency (Z.AI, OpenRouter credits, Kimi, Cursor grants) |
| `usage` | day, model, tokens_in/out, cached, requests, cost_usd (OpenRouter activity, Anthropic/OpenAI reports, ccusage) |

Plus `raw_polls` (archived JSON per poll — repair material when a T2 endpoint drifts) and `adapter_state` (last_success, last_error, consecutive_failures → drives stale badges and backoff).

**Config** (`modelizer.toml`, committed; secrets referenced by env-var name only):

```toml
[server] port = 7788
[providers.openrouter] enabled = true
[providers.zai]        enabled = true   # key: $ZAI_API_KEY
[providers.cursor]     enabled = true   # token: read from local Cursor app state
[providers.copilot]    enabled = true   # token: gh / ~/.config/github-copilot/apps.json
[providers.claude]     enabled = true   # oauth from ~/.claude.json + `ccusage --json`
# ...kimi, openai, opencode
```

## Steps

Phase completion = running code, not intent.

### Phase 0 — Walking skeleton ✅ (done 2026-10-oct-03)
1. Scaffold repo (bun, hono, better-sqlite3, vite/react, `modelizer.toml` loader, `.env.example`).
2. Adapter interface + scheduler + persistence (schema above) with tests.
3. **OpenRouter adapter end-to-end** (T1, easiest): `/key` + `/credits` → quota + balance rows.
4. Minimal page: table of latest points per provider, auto-refresh. *Milestone: one provider live in the browser.*

### Phase 1 — The regulars
5. Z.AI adapter: balance + coding-plan quota (+ model-usage time series). Fixture tests from a real captured response. ✅ (done 2026-10-oct-03)
6. Cursor adapter: token discovery from local app state → `GetCurrentPeriodUsage` (+plan info, credit grants); daily CSV backfill once/day; local token pricing for spend estimate. Accept and flag brittleness.
7. Copilot adapter: token from `gh`/apps.json, editor headers, `copilot_internal/user` → quota buckets + credits_used.
8. Dashboard v1: per-provider card (ring for quota, balance line, reset countdown, staleness badge), 30-day spend chart.

### Phase 2 — The occasionals
9. Claude: OAuth `/api/oauth/usage` (windows) + `ccusage daily --json` subprocess (history; also covers OpenCode via its adapters).
10. Kimi: official balance + coding-plan pools (T2).
11. OpenAI: enable only if I actually have payg keys (org admin key → usage + costs); else skip.
12. OpenCode: prefer `ccusage` (already parses `opencode.db`); direct `opencode stats` only if gaps.
13. ChatGPT + OpenCode Zen: render "UI-only" placeholder cards linking to the dashboards — honest dead ends, documented.

### Phase 3 — Polish & run
14. Charts: stacked spend by provider, per-provider model breakdown.
15. Failure UX: stale badge → last error + raw payload viewer (debug view) for quick adapter repair.
16. Run always-on: `launchd` agent on the Mac (recommended) or Dockerfile + compose for a box.
17. Manual-entry provider type as escape hatch for any future T4 service.

**Testing:** every adapter ships with recorded fixture JSONs (captured from its first real poll) + normalize unit tests; scheduler tested with fake timers; each adapter runnable standalone via `modelizer poll --provider <id>` for live debugging; browser-verified UI at each phase gate.

## Out of scope (v1)

- Routing my LLM traffic through a proxy (LiteLLM/Helicone model) — different product; we poll, not intercept.
- Multi-user / auth / public exposure (localhost only; revisit before ever binding elsewhere).
- Alerts/notifications (email/Slack/push) — candidate follow-up once data flows.
- Scraping logged-in web UIs with headless browsers (only tolerated path is existing documented-ish JSON endpoints; if Cursor kills its RPC, card goes stale, not hacked around).
- Cost accounting beyond what providers report (no local token-price modeling except Cursor CSV estimate).

## Open questions

1. **Hosting:** Mac at login (launchd) vs always-on box/Docker — default plan is launchd on this Mac; decide at Phase 3.
2. **Cursor plan type:** personal Pro/Ultra (T2 path) or team admin (then switch to the official Admin API — much sturdier). Assume personal until confirmed.
3. **Claude/OpenAI flavor:** subscription only, or also payg API keys? Determines whether Anthropic/OpenAI T1 adapters are worth building in Phase 2.
4. Stack sign-off: Bun+TS recommended; veto early (Phase 0) if a different runtime is preferred.

## Changelog

- **2026-oct-13 20:21** — "Claude/OpenAI windows off + reset not detected" (user report; both confirmed). Codex: telemetry only arrives with requests, so a passed `resets_at` showed stale pre-reset % — fixed with roll-forward (passed reset ⇒ 0% used / 100% left / reset unknown until next request). Live after fix: 17%/83% left, resets 23:49 Berlin. Claude: card was transcript-ESTIMATES with a hand-calibrated 210-turn budget (showed 242→544/210 — meaningless after the user's reset). Implemented Anthropic OAuth usage poll (api.anthropic.com/api/oauth/usage, anthropic-beta oauth-2025-04-20; schema pinned from ccstatusline: flat five_hour/seven_day buckets win, limits[] session/weekly_all fallback, percent-0-without-reset = placeholder): real % + resets when a fresh OAuth token exists; graceful 401/absent fallback to estimates; elapsed transcript blocks roll forward to fresh 0; expired-token status hint ("run `claude /login`"). Discovery on this machine: the keychain "Claude Code-credentials" blob holds an accessToken expired 2026-03-02 (401 invalid) even though Claude Code works daily — current auth must not flow through this blob, so claude shows estimates + the /login hint until a fresh OAuth login lands. 75 tests green.
- **2026-oct-13 16:05** — "OpenAI usage/amount left" (user request; note: claude+codex adapters landed from another session during the Oct 3–13 gap). The codex card (OpenAI/ChatGPT plan) previously showed only estimated tokens with no "left" unless manual CODEX_SESSION_* budgets were set. Discovery: Codex CLI writes OpenAI's authoritative rate_limits telemetry into session JSONL (event_msg payloads: primary 5h/secondary weekly used_percent, resets_at epoch-seconds, plan_type — verified against live ~/.codex/sessions). Adapter now harvests the latest snapshot → real quota points codex-5h-percent / codex-weekly-percent (used/left/reset) feeding bars and the next-reset banner. Also: OpenRouter gained /api/v1/activity polling (mgmt key, optional; 30-day per-model spend → "Per-model spend · 30 days" section) plus a muted "add OPENROUTER_MANAGEMENT_KEY…" hint when absent; credits/normalized gated on status 200; generic per-model UI section handles tokens+spend. 67 tests green; live: codex 43%/57% left (resets 18:48 Berlin), weekly 7%/93% (resets Oct 20).
- **2026-oct-13** — (external session) claude + codex adapters added, both enabled; claude shows 5h-turns quota, codex reads ~/.codex/sessions transcripts.
- **2026-10-oct-03 09:30** — Degraded-endpoint visibility (user request): overview API now reports `degradedEndpoints` (endpoints that soft-failed in the latest poll batch, from raw_polls); the zai "Per-model usage" section shows "⚠ token check failed (HTTP 404) — data below may be stale" next to its title when model-usage fails, and renders a no-data note instead of silently disappearing. Balance-404 on coding-plan keys stays unannotated (permanent/expected). `scripts/mock-zai.ts` gained DEGRADED=1 mode; verified visually against it, then restored the real server. 49 tests green.
- **2026-10-oct-03 08:40** — "Next reset" banner on the dashboard (user request): picks the earliest upcoming reset_at across visible (non-hidden) cards, renders as a highlighted strip with a precise ticking countdown ("2h 59m"; seconds shown under an hour) + local wall-clock time. Respects card visibility toggles.
- **2026-10-oct-03 08:15** — Audit log + diary (user request), as dashboard tabs. New `sessions` and `audit_events` tables; every server run opens a session (start/stop audited; CLI poll runs count too). Scheduler takes an `audit` sink and emits info/warn/error events for every poll outcome (ok + points, optional-poll skips, missing credentials, failures + backoff). New endpoints: `/api/sessions`, `/api/audit?session=`, `/api/diary?days=` (day rollups: model-daily filed under usage day, other points under capture date keeping the day's last value, warn/error counts per day). UI: tab nav (dashboard/audit/diary); audit view with session picker + event table (15s auto-refresh); diary view with day cards reaching back through the model-usage backfill. 48 tests green. Verified live in browser.
- **2026-10-oct-03 07:30** — "Not updating" report + earlier zai 429/stale sighting (previous process; log truncated). Diagnosis: server was healthy all along (15.5-min cadence, zero failures since 15:36 restart); staleness perception = backgrounded tab throttling + no visibility into poll timing + a transient 429 episode in the prior process. Hardening: quota-limit is now an optional poll (429 → degrade to coding-usage fallback or per-model data instead of failing the provider); normalize throws only on zero usable points; retry-after on degraded runs extends the next poll; ±10% jitter on success intervals (injectable random for tests); card footer now shows "next poll in Xm" countdown. 44 tests green.
- **2026-10-oct-03 06:40** — Per-model token usage surfaced (user request): overview API now includes model-daily history rows again; zai card renders a collapsible "Per-model usage · 7 days" section (today + 7d totals per model, busiest first). Live data: GLM-5.3-Flash ~588M today / 3.03B 7d, GLM-5.3 ~25M / 150M — Flash is ~95% of token volume. Note: long-term history accumulates in DB (each poll snapshots all 7 rolling days); model *settings* in the user's tools are not exposed by Z.AI, only actual consumption.
- **2026-10-oct-03 05:55** — UI polish per user: zai card first (adapter registry order = display order, single-column layout), point rows rebuilt on CSS grid (kind chips colored per kind, friendly label map, model/tool names on their own line, percent unit renders "67%" instead of "67 / 100") — fixes text overflowing the card. New `notes` field on adapters rendered as a collapsed "Pricing & notes" section (Z.AI: subscription vs credits, peak 1×/off-peak 0.5×, 5h window is %-only on lite, MCP monthly quota; OpenRouter: per-token USD pricing incl. how a per-token rate derives from per-1M prices, key-scoped vs account-wide data). 41 tests green. Verified via DOM measurement: no element exceeds card bounds.
- **2026-10-oct-03 03:15** — Z.AI user request: peak/off-peak indicator + local-time resets. Peak definition verified against docs.z.ai devpack (official): Mon–Fri 14:00–18:00 SGT = 06:00–10:00 UTC, off-peak = 50% credit rate; promo Sept 25–Oct 7 2026 = all-day off-peak. New `liveStatus(now)` adapter hook (clock-derived rows evaluated per overview request, not per poll) → renders as "pricing: off-peak · 0.5× credits · until <local time>". Reset rows now show countdown + local wall-clock (browser tz → Berlin CET/CEST, DST via Intl; verified Nov 1 reset renders CET correctly after the Oct 25 switch). 40 tests green (6 new for peak boundaries/weekends/promo).
- **2026-10-oct-03 02:50** — Z.AI went LIVE on real account (keychain-stored dedicated key; keychain resolution verified in production). First real poll exposed four shape drifts vs community sources, fixed same session from archived raw_polls: (1) `nextResetTime` is epoch-ms numbers, not ISO strings; (2) on the lite coding plan the 5h token window arrives percentage-only (`unit=3 number=5`, no absolute tokens) → new percent-unit quota points; (3) `model-usage` x_time is HOURLY → now aggregated to daily totals per model (was 350 noisy rows, now 16); (4) `coding/usage` returns HTTP 200 with `{code:500,success:false}` on this account → body-level success check, fallback logic hardened. Overview API now excludes daily history rows from cards (kept in /points for future charts). `/api/paas/v4/balance` 404s on api.z.ai for coding-plan keys — left as optional poll in case payg keys activate it. Observed but unused: `data.level` plan tier field. 34 tests green. Card shows: coding-5h (percent + reset), mcp (requests + ~29d reset), per-tool MCP usage.
- **2026-10-oct-03 02:30** — Phase 1 item 5 (Z.AI) complete. Security approach decided with user: dedicated revocable key + macOS Keychain secret resolution (env vars still win; `security add-generic-password -s modelizer -a <NAME> -w`), keys never in URLs/logs/DB/API responses. Adapter polls 4 undocumented endpoints (quota-limit required; coding-usage as fallback, model-usage 7d history, payg balance — all optional soft-fail). New `optional` poll flag in the adapter contract so a 404 on a payg-only endpoint can't fail a subscription-key run. Fixtures pinned from CodexBar zai.js + TokenStep sources; bogus 5h-reset guard (>6h away → dropped). 32 tests green. To go live: user creates dedicated Z.AI key → keychain or .env. Open: first real response may drift from community shapes; raw_polls archived for quick normalize fixes.
- **2026-10-oct-03 02:20** — Phase 0 complete. Walking skeleton runs end-to-end: scaffold, config (TOML+env), SQLite persistence, injected-clock scheduler (backoff + retry-after + credential-aware), OpenRouter adapter (T1), Hono API (/api/overview, points, raw), CLI `poll`, React overview page with auto-refresh, staleness and failure badges. 19 tests green incl. mock-server e2e. **Deviation:** swapped better-sqlite3 → `bun:sqlite` (Bun 1.3.9 crashed in NAPI with better-sqlite3's native binding; bun:sqlite is built-in, same API). Note: bun:sqlite named-param binding requires `$`-prefixed object keys. Verified in browser against `scripts/mock-openrouter.ts` (no real OPENROUTER_API_KEY yet — user to add to .env). Server left running at 127.0.0.1:7788 with mock data.
- **2026-10-oct-03 01:46** — Status → active. User said "please start" (no extra comment); began Phase 0 (walking skeleton: scaffold, core, OpenRouter adapter, minimal page).
- **2026-10-oct-03 01:42** — Created (proposed). Original goal: single web dashboard for usage across LLM subscriptions/APIs instead of per-site logins. Provider set from user: regulars OpenRouter/Cursor/Copilot/Z.AI, occasionals OpenCode/Claude/ChatGPT/Kimi (user answered in planning interview, no extra comment). All endpoints in the data matrix verified via official docs + community tool sources on 2026-10-03.
