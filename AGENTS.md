# modelizer

Communicate in English only: chat, commits, pull requests, and code comments.

## OVERVIEW

Local Bun/TypeScript dashboard for LLM quotas, balances, and spend. One process polls providers on a ~15 minute cadence, normalizes into SQLite, and serves `http://127.0.0.1:7788`. It reads usage the providers already record. It does not proxy traffic.

## Cross-machine coordination

New here? Read `~/code/agent-hub/docs/START-HERE.md`, then run `hub who` and
`hub inbox <your-agent-name>` before starting work. Claims and handoffs live in that repo;
modelizer's own rules below still win for modelizer work.

## STRUCTURE

```
src/index.ts          scheduler + HTTP server
src/cli.ts            one-shot poll
src/api.ts            JSON API (Hono)
src/scheduler.ts      cadence, backoff, reset notices
src/db.ts             bun:sqlite schema and queries
src/config.ts         modelizer.toml
src/secrets.ts        env, then macOS keychain
src/notify.ts         optional reset webhook
src/windows.ts        overview window shape
src/pricing.ts        API-equivalent list prices for local usage
src/subscriptions.ts  plan + price + renewal merge for the Subscriptions page
src/adapters/         one provider per file; index.ts is display order
web/                  Vite + React
scripts/              mocks and the Claude StopFailure hook
plans/                MOD plans (see plans/INDEX.md)
```

## WHERE TO LOOK

| Task | Location |
|---|---|
| Adapter contract | `src/adapters/types.ts` |
| Register a provider | `src/adapters/<id>.ts` and `src/adapters/index.ts` |
| Overview windows | `src/windows.ts`, `src/api.ts` |
| Codex rate limits | `src/adapters/codex-app-server.ts`, `codex-limits.ts`, `codex.ts` |
| Claude resets | `src/adapters/claude.ts`, `src/usage-text.ts`, `scripts/claude-statusline.ts`, `scripts/claude-rate-limit-hook.ts` |
| Claude cost / list prices | `src/pricing.ts`, `src/pricing/anthropic.json`, `scripts/refresh-pricing.ts` |
| Subscriptions page | `src/subscriptions.ts`, `src/adapters/cursor.ts`, `subscriptions.example.toml` |
| Z.AI limits | `src/adapters/zai.ts` |
| Reset notices / ntfy | `src/notify.ts` |
| Schema | `src/db.ts` |
| Dashboard | `web/src/App.tsx` |
| Secrets | `src/secrets.ts`, `.env.example` |
| Roadmap | `plans/INDEX.md` |

## CONVENTIONS

- TypeScript is strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`). Omit an optional property; do not pass `undefined`.
- `bun:sqlite` named parameters use a `$` prefix.
- An adapter `collect` returns `RawPoll[]` and does not throw past its boundary. `normalize` is pure and throws `NormalizeError` on an unexpected shape. Optional polls do not fail the run. Archive response bodies in `raw_polls`.
- One provider's failure never changes another's schedule or card.
- `ADAPTERS` array order is dashboard order.
- Set `quota_window` only on authoritative quota windows. Transcript token estimates leave it empty.
- Stability tiers: **T1** official documented API (OpenRouter). **T2** undocumented community endpoints (Z.AI; Cursor and Copilot when added) — isolate failures, archive raw bodies, show staleness. **T3** local files and CLIs (Claude transcripts, then status line, `claude -p /usage --output-format json`, and the StopFailure hook; Codex `account/rateLimits/read` with session logs as fallback). **T4** no programmatic path (placeholder cards).
- Claude windows resolve in this order: account-wide OAuth usage (only when `CLAUDE_OAUTH_USAGE=1`), statusLine snapshot, `claude -p /usage`, StopFailure hook. The OAuth call is read-only — never refresh or write the token, because Claude Code and CodexBar hold the same keychain item and a second refresher logs one of them out. 401/403/429/odd body backs off for an hour; never retry it on every tick.
- Claude `/usage` runs with stdin closed and a 5s timeout. Any failure is stale and is not retried for 6 hours. Do not let that command hang the scheduler. It is a dead end on Claude Code 2.1.307+ (returns a `local_command` result), so do not treat its success as window data.
- Cost is API-equivalent only: list prices from `src/pricing/anthropic.json` (refresh with `bun run scripts/refresh-pricing.ts`), never a guessed invoice. Unpriced models emit no `model-spend` row rather than a zero.
- Subscriptions merge provider-stated facts (plan, billing state — `Adapter.subscriptionFacts`) with `subscriptions.toml` (price, currency, `renews_day`/`ends_at`). Facts win plan/state, config wins price/renewal; neither half is invented — an unknown plan keeps a null name (unless config sets `label`) and an unset price renders as "set price". `renews_day` is a day of month (clamped), not an instant. Money is never converted: rows carry `currency` and the API returns `totals[]` per currency. `totals[]` is the value of the plans active now at the price in force this period (`current`, never `priceNext`), so a plan inside its intro rate counts cheap and a free plan counts zero. `counts` decides membership (live and not prepaid); a plan paid up front carries `prepaid: true` because that money is spent, not monthly, and `ends_at` with `recurring: false` marks a plan that will not renew. The page names the plans it left out. Provider marks live in `web/public/providers/<id>.svg`, mapped by `PROVIDER_ICONS` in `web/src/App.tsx` with a letter tile as fallback. Cursor is T2 and contributes facts only: its usage needs a cursor.com cookie session. One `[[subscription]]` block per provider (duplicates are a config error); a euro-billed plan keeps its provider id and overrides `currency`/`price`. OpenAI's plan comes from the Codex id token (plan type only); the token is never archived.
- Codex windows follow length (300 minutes = 5-hour, 10080 = weekly), not the primary/secondary slot. Do not invent a reset from the window length.
- Secrets resolve from the environment, then the macOS keychain service `modelizer`. They stay out of `modelizer.toml`, the database, logs, URLs, and API responses. `.env` is gitignored; if used, `chmod 600`.
- Egress is the adapter's documented endpoints only, key in the `Authorization` header, TLS. Do not call undocumented OAuth usage endpoints. Do not scrape claude.ai or chatgpt.com.
- Bind `127.0.0.1`. Do not expose the server without adding auth.
- Reset notices are off unless `MODELIZER_WEBHOOK_URL` is set. Never log the URL, the topic path, or `MODELIZER_WEBHOOK_SECRET`. Do not hardcode a topic. Host `ntfy.sh` selects ntfy format when `MODELIZER_WEBHOOK_FORMAT` is unset.
- Tests sit next to the code (`*.test.ts`) and stay hermetic. Default test context turns live CLIs off (`CODEX_APP_SERVER=0`, `CLAUDE_USAGE=0`).
- Plan ids come from `plans/.plan_counter` via the `/pl` helper. Do not hand-edit the counter.

## ANTI-PATTERNS

- Refreshing, writing, or logging the Claude OAuth token; calling the usage endpoint unless `CLAUDE_OAUTH_USAGE=1`; scraping claude.ai / chatgpt.com.
- Putting a key, webhook URL, or topic in config, the database, logs, or the UI.
- Hardcoding an ntfy topic name.
- Guessing `resetsAt` from a window duration, or guessing a subscription price or charge date.
- Sending Codex `thread/start` or `turn/start` while reading rate limits.
- Letting `collect` throw, or letting one adapter's error fail the tick.
- `any`, `@ts-ignore`, `@ts-expect-error`, or a non-null assertion.
- Binding a non-loopback address, or committing `.env` or `*.db`.

## COMMANDS

| Command | What it does |
|---|---|
| `bun install` | Install dependencies |
| `bun run dev` | Scheduler + dashboard on `127.0.0.1:7788` |
| `bun run poll` | Poll once (`-- --provider openrouter`, `-- --json`) |
| `bun run web:dev` | Vite UI; proxies `/api` to :7788 |
| `bun run web:build` | Production UI build |
| `bun test` | Tests |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run scripts/mock-openrouter.ts` | Fake OpenRouter on :9801 |
| `bun run scripts/mock-claude.ts` | Fake Claude transcripts + usage fixture |
| `bun run scripts/mock-codex.ts` | Fake Codex session logs + app-server fixture |
| `bun run scripts/mock-zai.ts` | Fake Z.AI |
| `bun scripts/claude-statusline.ts` | Optional Claude Code statusLine command |
| `bun scripts/claude-rate-limit-hook.ts` | Optional Claude Code StopFailure hook |

Run `bun test` and `bun run typecheck` before handing work off.

## Act, don't ask

Do what was asked. Run the command yourself; never hand the user a command you could run. Questions and proposals are fine when something is actually ambiguous or you are offering a choice. Pause only before irreversible destruction (deleting data, force-push, dropping a database, revoking a key). The global rule is `~/.agents/CONSTITUTION.md`. This file does not override it.

## Parallel agents and git

One task, one branch, one worktree, cut from `origin/main`. Leave the main checkout clean — do not commit on it.

```sh
git fetch origin
git worktree add ../modelizer-<task> -b <branch> origin/main
```

When the task branch is ready, from the clean main checkout: `git merge --ff-only <branch>`, then `git push`. If it is not a fast-forward, rebase the task branch onto `origin/main` first. No merge commits.
