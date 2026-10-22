# modelizer

One local dashboard for all your LLM subscriptions and APIs — quotas, balances, and spend across
OpenRouter, Cursor, Copilot, Z.AI, Claude, Kimi, OpenCode, and more, without logging into each
provider's website.

Runs as a single process on your machine: a scheduler polls provider APIs every 15 minutes,
normalizes everything into SQLite, and serves a small web dashboard. No traffic is proxied —
modelizer only reads the usage each provider already records.

## Quick start

```sh
bun install
cp .env.example .env        # add the keys you have; every provider is optional
bun run web:build           # once (or skip and use `bun run web:dev` for UI work)
bun run dev                 # → http://127.0.0.1:7788
```

Enable the providers you use in `modelizer.toml` (`[providers.openrouter] enabled = true`, …).
Secrets live only in `.env` (or your shell) — never in the config file or the database.

## Commands

| Command | What it does |
|---|---|
| `bun run dev` | Start scheduler + dashboard on `127.0.0.1:7788` |
| `bun run poll [-- --provider openrouter] [-- --json]` | Poll once from the CLI (debugging) |
| `bun run web:dev` | Vite dev server for UI work (proxies `/api` to :7788) |
| `bun run test` / `bun run typecheck` | Tests / types |
| `bun run scripts/mock-openrouter.ts` | Fake OpenRouter on :9801 for UI dev |
| `bun run scripts/mock-claude.ts` | Fake Claude Code transcripts under `data/mock-claude` for UI dev |
| `bun run scripts/mock-codex.ts` | Fake Codex session logs under `data/mock-codex` for UI dev |
| `bun scripts/claude-statusline.ts` | Optional Claude Code statusLine command (records `rate_limits`) |
| `bun scripts/claude-rate-limit-hook.ts` | Optional Claude Code StopFailure hook (records a rate-limit reset) |

Point a provider at the mock with `OPENROUTER_BASE_URL=http://127.0.0.1:9801` and any non-empty
key, plus `MODELIZER_DB=data/dev-mock.db` to keep demo data out of your real database.
Codex and Claude mocks also write a rate-limit fixture: `CODEX_APP_SERVER_FIXTURE=data/mock-codex/app-server.json`
and `CLAUDE_USAGE_FILE=data/mock-claude/usage.txt`.

## Status API

- `GET /api/overview` — one object per provider: state (last poll, errors, staleness) + latest points.
  Each provider also has `windows[]`: `{ window, usedPercent, resetsAt, source, stale }` for the
  authoritative quota windows (`five_hour`, `weekly`, and Z.AI's `monthly` / `mcp`). `source` is
  `statusline`, `app-server`, `session-log`, `usage-command`, `hook`, or `zai-api`. `stale` is true when a
  Claude source is missing or unsupported, or a Codex/Z.AI reset was rolled forward or discarded.
- `GET /api/providers/:id/points?days=30` — point history
- `GET /api/providers/:id/raw?limit=10` — raw archived responses (repair evidence when an
  undocumented endpoint drifts)
- `GET /api/subscriptions` — the Subscriptions page: one row per provider with `plan`, `state`,
  `price`, `priceNext`, `currency`, `monthly`, `recurring`, `renewsAt`/`endsAt`, `source`, plus
  `totals[]` (recurring monthly spend **per currency** — USD and EUR are never added together).
  A plan that will not renew is out of `totals[]` and carries `recurring: false`. A malformed
  `subscriptions.toml` answers 422 with `error` set, and the page shows the message.

## Subscriptions

A separate page lists what you pay for: plan, billing state, monthly cost and the next charge
date. Two sources are merged, because no provider exposes both halves:

| Source | Supplies | Where it comes from |
|---|---|---|
| provider facts | plan, billing state, seats, billing period | Claude `/api/oauth/profile` (`CLAUDE_OAUTH_USAGE=1`), Cursor `/auth/full_stripe_profile`, OpenAI via Codex `~/.codex/auth.json` |
| `subscriptions.toml` | price, currency, renewal day, paid-through date | your own file (gitignored, see `subscriptions.example.toml`) |

Facts win for plan and state — the provider knows. Config wins for price and renewal, because
none of those APIs states a charge date (Claude reports `subscription_created_at`, Codex nothing,
Cursor nothing). Nothing is guessed: an unpriced plan shows "set price", a missing charge day
shows "set renews_day", and an unknown plan id keeps a null name unless the config gives it a
`label`.

Money stays in the currency it is billed in: `currency = "EUR"` is shown as euros and totalled
separately from dollars, because converting would invent an exchange rate. `price_next` models an
intro rate (charged 15 now, 30 from the next renewal): the row shows both, the total uses the
recurring amount. `renews_day` is a day of month (clamped in short months), `renews_at` rolls an
annual charge forward, and `ends_at` marks a plan that will not renew — an annual term paid up
front, or a subscription with auto-renew switched off. Such a plan shows its last day ("ends Nov
12 · in 20d · won't renew") instead of a renewal, and stays out of the header total: that figure
counts only what actually leaves the account each month, and the page names what it left out.

One row per provider, so a plan that is billed under one provider id gets one block: a Cursor
subscription charged in euros is still `provider = "cursor"`, with `currency`/`price` overriding
the dollar list price. Duplicate provider blocks are rejected rather than silently losing one.
xAI has no programmatic path — its API exposes credits for API keys, not the SuperGrok
subscription — so it is config-only if you hold one.

Cursor's access token is read read-only from Cursor's own `state.vscdb`
(`cursorAuth/accessToken`), sent only to `api2.cursor.sh`, and never logged or written back.
`/api/usage-summary` needs a cursor.com cookie session, so Cursor contributes plan facts and no
usage points; its card points at the Subscriptions tab.

## Security

- **Dedicated, revocable keys.** Z.AI (and most providers here) have no read-only scope — a key
  that reads usage can also run inference. Create a separate key per tool at the provider's
  console, name it `modelizer`, and revoke it independently if anything leaks. Never reuse the
  key your coding agents run on.
- **macOS Keychain over `.env`.** Secrets resolve from the environment first, then the keychain —
  no plaintext file needed:
  ```sh
  security add-generic-password -s modelizer -a ZAI_API_KEY -w '<your key>'
  # rotate:  security delete-generic-password -s modelizer -a ZAI_API_KEY  (then re-add)
  ```
  If you do use `.env`, keep it `chmod 600` (it is gitignored).
- **Minimal egress.** Each adapter GETs only its documented endpoints with the key in the
  `Authorization` header over TLS. Keys never appear in URLs, logs, the database, or API
  responses (`raw_polls` archives response bodies only — providers never echo your key back).
- **Localhost only.** The dashboard binds `127.0.0.1` by default. Do not expose it without
  adding auth — the data itself (quotas, spend) is sensitive.
- **Gentle polling.** 15-minute default cadence with exponential backoff and `retry-after`
  honoring; the failure state of one provider never affects another.
- **Reset notices.** When `MODELIZER_WEBHOOK_URL` is set, a passed reset (or a sharp usage drop)
  is POSTed once. The URL and `MODELIZER_WEBHOOK_SECRET` are never written to logs. The secret
  can live in the keychain under the same service (`-a MODELIZER_WEBHOOK_SECRET`).

## Reset notices

Off unless `MODELIZER_WEBHOOK_URL` is set. After each scheduler tick, modelizer compares the
latest quota windows with the previous snapshot. A notice fires when a window's `resetsAt` has
passed, or when `usedPercent` drops by 25 points or more (a refresh the clock did not announce).
Each `(provider, window, reset)` is delivered once. Failures retry with backoff and then stop;
the dashboard is unaffected.

`MODELIZER_WEBHOOK_FORMAT` is `json` or `ntfy`. When the format is unset and the URL host is
`ntfy.sh`, the body is ntfy plain text. The topic is whatever you put in the URL — modelizer
does not ship a topic name.

JSON body:

```json
{ "provider": "claude", "window": "five_hour", "resetAt": "2026-10-18T15:00:00.000Z", "usedPercent": 0, "detectedAt": "2026-10-18T15:00:05.000Z" }
```

ntfy body (headers `Title: Modelizer: Claude credits reset` and `Tags: white_check_mark`):

```
Claude 5-hour window reset, 0% used
```

If `MODELIZER_WEBHOOK_SECRET` is set it is sent as `Authorization: Bearer …` and as
`X-Modelizer-Signature: sha256=<hmac of the raw body>`. Redirects are not followed.

```sh
# phone/Mac push via your own ntfy topic
MODELIZER_WEBHOOK_URL=https://ntfy.sh/<topic>
# MODELIZER_WEBHOOK_FORMAT=ntfy   # optional; ntfy.sh is detected
# MODELIZER_WEBHOOK_SECRET=       # only if the topic is protected
```

A sharp drop uses the detection time as `resetAt`, because the provider did not name the instant
the window actually rolled.

## How data is collected

Each provider is an adapter (`src/adapters/`) with a stability tier:

- **T1** official documented APIs (OpenRouter today; Anthropic/OpenAI admin APIs planned)
- **T2** undocumented endpoints the community relies on (Z.AI, personal Cursor, personal Copilot).
  These can break; failures are isolated per provider, raw responses are archived, and the UI
  shows staleness instead of hiding it. The one opt-in exception is Claude's account-wide usage
  endpoint (`CLAUDE_OAUTH_USAGE=1`, read-only, token never refreshed) — it is the only way to see
  usage outside this machine. Modelizer does not scrape claude.ai or chatgpt.com.
- **T3** local files and local CLIs. Claude Code transcripts under `~/.claude/projects` supply
  token counts. Quota windows prefer the opt-in account-wide usage endpoint, then the statusLine
  file, then `claude -p /usage --output-format json` (stdin closed, 5s timeout; failure is stale
  and skipped for 6 hours), then a StopFailure hook. Codex prefers the documented
  `codex app-server` method `account/rateLimits/read` (no model turn) and falls back to
  `token_count` rate-limit snapshots in `~/.codex/sessions`. Windows are identified by length
  (300 minutes = 5h, 10080 = weekly), not by primary/secondary slot.
- **T4** UI-only, no programmatic path (ChatGPT subscription, OpenCode Zen credits — placeholder cards)

### Claude Code quota windows

Transcripts do not include a reset time. Modelizer reads four sources, in order:

0. **Account-wide usage (opt-in).** Set `CLAUDE_OAUTH_USAGE=1` to call Anthropic's usage endpoint
   with the Claude Code login token from the macOS keychain. It returns the real `five_hour` and
   `seven_day` percentages and reset times for the whole account, so it also covers claude.ai and
   other machines — the same source CodexBar uses. Read-only: the token is never refreshed or
   written back (two refreshers would race and log Claude Code out). A 401, 403, 429 or unexpected
   body backs off for an hour. Unset, nothing leaves the machine.

1. **Status line.** `scripts/claude-statusline.ts` reads the JSON Claude Code passes to a statusLine command and, when `rate_limits` is present, writes `~/.modelizer/claude-statusline.json`. Those fields (`five_hour` / `seven_day` `used_percentage` and `resets_at`) shipped in Claude Code 2.1.80. Older builds omit them; the script still exits 0 and modelizer ignores the file. A snapshot older than 6 hours is ignored. Add this to `~/.claude/settings.json`. If you already have a statusLine command, put it after `--` so this script records the limits and then runs yours with the same JSON on stdin:

```json
{
  "statusLine": {
    "type": "command",
    "command": "bun /absolute/path/to/modelizer/scripts/claude-statusline.ts -- ~/.claude/statusline.sh",
    "refreshInterval": 60
  }
}
```

Drop the `-- …` part when you have no existing command. Stdout is then a short line such as `5h 23% · 7d 41%`.

2. **`claude -p /usage --output-format json`**. Stdin is closed and the process is killed after 5 seconds, so it cannot hang the scheduler. On Claude Code 2.1.307+ it answers with a `local_command` result (`Usage: 0 input, 0 output`) and no window data at all, so it is a dead end on current builds; on 2.1.7 it returned `Unknown skill: usage`. Either way the failure marks both windows stale and is not retried for 6 hours. Set `CLAUDE_USAGE=0` to skip the command.

3. **StopFailure hook.** When a turn dies on a rate limit, the hook writes the message's reset time to `~/.modelizer/claude-rate-limit.json` (override with `MODELIZER_CLAUDE_HOOK_FILE`). That exact instant overrides the matching window from the sources above. Add this to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "StopFailure": [
      {
        "matcher": "rate_limit",
        "hooks": [
          { "type": "command", "command": "bun /absolute/path/to/modelizer/scripts/claude-rate-limit-hook.ts" }
        ]
      }
    ]
  }
}
```

Set `CLAUDE_USAGE=0` to skip the `/usage` command, or `CODEX_APP_SERVER=0` to skip the Codex
app-server read. Both fall back without failing the other providers.

### Claude cost (API-equivalent)

A subscription has no per-token bill, so modelizer prices the local tokens at list rates and shows
the result as per-model spend ("API-equivalent"). Prices live in `src/pricing/anthropic.json`
(USD per million tokens for input, output, cache read and cache write) and are checked in, so a
poll never depends on a third-party host. They come from models.dev — the table CodexBar uses —
and `bun run scripts/refresh-pricing.ts` regenerates the file. Unknown models (for example the
`<synthetic>` turns Claude Code logs for local errors) simply carry no spend row.

Plans live in [`plans/`](plans/) — see [MOD001](plans/2026-10-oct-03_MOD001_llm-usage-dashboard.md)
for the roadmap (phases: walking skeleton → regulars → occasionals → polish/deploy).
