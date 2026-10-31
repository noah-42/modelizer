# modelizer

One local dashboard for all your LLM subscriptions and APIs — quotas, balances, and spend across
OpenRouter, Cursor, Copilot, Z.AI, Claude, Kimi, OpenCode, and more, without logging into each
provider's website.

- **Single process, your machine** — a scheduler polls provider APIs every 15 minutes
- **SQLite at the core** — everything is normalized into one local database
- **Small web dashboard** — served at `127.0.0.1:7788`
- **No proxying** — modelizer only reads the usage each provider already records

## Quick start

```sh
bun install
cp .env.example .env                  # add the keys you have; every provider is optional
cp modelizer.example.toml modelizer.toml   # pick your providers; defaults are sane
cp subscriptions.example.toml subscriptions.toml   # what you pay (optional)
cp models.example.toml models.toml    # which models belong to which provider (optional)
bun run web:build           # once (or skip and use `bun run web:dev` for UI work)
bun run dev                 # → http://127.0.0.1:7788
```

**Where secrets and personal data live** — never in a config file, the database or git:

| File | Gitignored | Committed template | Contents |
|---|---|---|---|
| `.env` | yes | `.env.example` | API keys (or keep them in the keychain) |
| `modelizer.toml` | yes | `modelizer.example.toml` | provider toggles, server settings |
| `subscriptions.toml` | yes | `subscriptions.example.toml` | what you pay |
| `models.toml` | yes | `models.example.toml` | model → provider mapping |

A fresh clone plus four copies is a working install.

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

Full reference for other services lives in [API.md](API.md) — endpoints, token auth, payload
shapes.

| Endpoint | Returns |
|---|---|
| `GET /api/overview` | One object per provider: state (last poll, errors, staleness) + latest points |
| `GET /api/providers/:id/points?days=30` | Point history |
| `GET /api/providers/:id/raw?limit=10` | Raw archived responses (repair evidence when an undocumented endpoint drifts) |
| `GET /api/models` | Model → provider associations from `models.toml`, with context and per-million pricing where known |
| `POST /api/models` | Add an entry from an OpenRouter link (`{url, provider?}`); the server reads the metadata from OpenRouter and appends the block |
| `GET /api/subscriptions` | The Subscriptions page: plan, billing state, price, renewal dates, totals per currency |
| `GET /api/subscriptions/config` | The saved `[[subscription]]` overrides only — what the manage tab edits, without merged provider facts |
| `POST` / `PUT` / `DELETE /api/subscriptions…` | Add, edit, and remove saved entries; `PUT /api/subscriptions/order` reorders them (see [API.md](API.md)) |
| `GET /api/providers/manage` | The manage listing: per provider — enabled, order, auth method, auth health, and token *status* (never values) |

Notes on the two richest endpoints:

- **`/api/overview`** — each provider carries `windows[]`: `{ window, usedPercent, resetsAt, source, stale }`
  for the authoritative quota windows (`five_hour`, `weekly`, and Z.AI's `monthly` / `mcp`).
  - `source` is one of `statusline`, `app-server`, `session-log`, `usage-command`, `hook`, `zai-api`.
  - `stale` is true when a Claude source is missing or unsupported, or a Codex/Z.AI reset was
    rolled forward or discarded.
- **`/api/models`** — a broken file answers 422 with `error` set. Matching is case-insensitive and
  prefix-aware, so a versioned id finds its base model; an unmatched model stays unknown rather
  than being attributed to a guess.
- **`/api/subscriptions`** — rows carry `plan`, `state`, `price`, `priceNext`, `currency`,
  `current`, `monthly`, `recurring`, `prepaid`, `counts`, `renewsAt`/`endsAt`, `source`, plus
  `totals[]` (the value of the plans active **now**, per currency — USD and EUR are never added
  together). `current` is the price in force this period and is what the total sums; a plan paid
  up front or cancelled carries `counts: false`. A malformed `subscriptions.toml` answers 422
  with `error` set, and the page shows the message.

## Models

`models.toml` (gitignored, `models.example.toml` tracked) declares which provider serves which
model — the same model can reach you through more than one provider.

| Rule | Behaviour |
|---|---|
| Matching | Case-insensitive, prefix-aware; the longest match wins |
| Unmatched model | Resolves to null — never guessed |
| Display order | By the entry's `order` field, then alphabetically by name; the models page's ↑/↓ buttons write `order` for you |
| Where declared models show up | Inside the provider's dashboard card |
| Managing entries | Add by OpenRouter link, remove, and reorder — all from the models page; edits are textual, so hand-written comments and fields survive |
| Implementation | `src/models.ts` holds `LlmModel` and `ModelCatalog` |

## Subscriptions

A separate page lists what you pay for: plan, billing state, monthly cost and the next charge
date. Two sources are merged, because no provider exposes both halves:

| Source | Supplies | Where it comes from |
|---|---|---|
| provider facts | plan, billing state, seats, billing period | Claude `/api/oauth/profile` (`CLAUDE_OAUTH_USAGE=1`), Cursor `/auth/full_stripe_profile`, OpenAI via Codex `~/.codex/auth.json` |
| `subscriptions.toml` | price, currency, renewal day, paid-through date | your own file (gitignored, see `subscriptions.example.toml`) |

**Precedence:** facts win for plan and state — the provider knows. Config wins for price and
renewal, because none of those APIs states a charge date. Nothing is guessed:

- an unpriced plan shows "set price"
- a missing charge day shows "set renews_day"
- an unknown plan id keeps a null name unless the config gives it a `label`

**Config fields:**

| Field | Meaning |
|---|---|
| `price` / `currency` | Amount per billing period (default USD); overrides the provider's list price |
| `price_next` | Intro rate: charged 15 now, 30 from the next renewal — the row shows both, the total uses the recurring amount |
| `period` | `"monthly"` (default) or `"annual"` |
| `renews_day` | Day of month it charges (1–31, clamped in short months) |
| `renews_at` | ISO date of a known past charge, rolled forward — for annual auto-renewals |
| `ends_at` | Last day of a plan that will not renew (prepaid term, or auto-renew off) — the card shows "ends Nov 12 · in 20d · won't renew" |
| `label` | Display name; wins over the catalogue and the provider's own wording |
| `note` | A fact the card should carry, e.g. "free daily messages, reset 2:00 AM" |
| `seats` | Seat count, when the plan is per seat |

**Money rules:**

- Currency is never converted: `currency = "EUR"` is totalled separately from dollars, because
  converting would invent an exchange rate.
- The header total is the value of the plans active right now, at the price in force this period:
  - a plan whose intro rate has not ended yet counts at the cheap rate
  - a free plan counts at zero
  - a term paid up front is left out (that money is already spent, not monthly) — the page names
    what it left out under the total instead of dropping it silently
- One row per provider: duplicate provider blocks are rejected rather than silently losing one.
- xAI has no programmatic path — its API exposes credits for API keys, not the SuperGrok
  subscription — so it is config-only if you hold one.

**Cursor note:** the access token is read read-only from Cursor's own `state.vscdb`
(`cursorAuth/accessToken`), sent only to `api2.cursor.sh`, and never logged or written back.
`/api/usage-summary` needs a cursor.com cookie session, so Cursor contributes plan facts and no
usage points; its card points at the Subscriptions tab.

## Manage tab

The manage tab handles the lifecycle the other pages only display: your saved billing entries
and the built-in provider integrations. Changes apply live — the running process reconfigures
its polling by the next tick, no restart needed — and the dashboard stays view-only.

**Subscriptions section.** Add, edit, and delete entries in `subscriptions.toml`, and order
them with ↑/↓. Deleting removes **only the saved override**: a plan the provider itself reports
keeps showing on the Subscriptions page, honestly labelled — removing your note cancels
nothing. The manage tab lists the saved entries alone (`GET /api/subscriptions/config`), never
the merged rows.

**Providers section.** Enable, remove, and reorder the built-in integrations. Removing one
disables it and drops it from the saved order — subscriptions, usage history, models, and
Keychain tokens are all kept, so re-enabling later picks up where it left off. Each row shows:

- **Auth method** — `api-key`, or which app login backs it (`app: ChatGPT login` for Codex,
  `app: Claude Code login`, `app: Cursor login`). These are read-only views of credentials
  those apps already own; modelizer never refreshes, copies, or writes them. The one opt-in is
  Claude's account-wide OAuth usage toggle (`CLAUDE_OAUTH_USAGE` for the running process).
- **Auth health** — derived from stored poll results only, never a live provider call:
  `no token`, `token rejected` (401/403), `quota` (429/exhausted — an exhausted subscription is
  never shown as a broken token), `ok`, or `not polled yet`.
- **Tokens** — add, replace, or remove API keys. Values go into the macOS Keychain
  (`modelizer` service) and are **never returned, displayed, or logged** — the UI shows only
  `{set, source}` status. A key supplied by the environment is read-only and wins while
  present: a Keychain write for it is stored but flagged "shadowed by environment".

Saved order (subscriptions and providers alike) persists in the TOML files and survives
restart; unlisted entries keep their default sort after the ranked ones.

## Security

| Principle | What modelizer does |
|---|---|
| Dedicated, revocable keys | Z.AI (and most providers here) have no read-only scope — a key that reads usage can also run inference. Create a separate key per tool, name it `modelizer`, revoke it independently. Never reuse the key your coding agents run on. |
| Keychain over `.env` | Secrets resolve from the environment first, then the macOS keychain — no plaintext file needed (see below). |
| Tokens are write-only from the app | The manage tab stores and removes Keychain keys, but no endpoint ever returns a token value — responses carry `{set, source}` status only. |
| Minimal egress | Each adapter GETs only its documented endpoints, key in the `Authorization` header over TLS. Keys never appear in URLs, logs, the database, or API responses (`raw_polls` archives response bodies only — providers never echo your key back). |
| Localhost only | The dashboard binds `127.0.0.1` by default; the data itself (quotas, spend) is sensitive. |
| Token for the rest | Set `[server] token` (or `MODELIZER_TOKEN`) to let other machines read the API: local callers stay trusted, anything remote must present it as `Authorization: Bearer …` or `?token=…`. The token has no scopes — treat it like a key and keep the bind narrow. |
| Gentle polling | 15-minute default cadence with exponential backoff and `retry-after` honoring; one provider's failure never affects another. |
| Reset notices | With `MODELIZER_WEBHOOK_URL` set, a passed reset is POSTed once; the URL and secret never reach logs. |

Keychain usage:

```sh
security add-generic-password -s modelizer -a ZAI_API_KEY -w '<your key>'
# rotate:  security delete-generic-password -s modelizer -a ZAI_API_KEY  (then re-add)
```

If you do use `.env`, keep it `chmod 600` (it is gitignored).

## MCP server

`bun run mcp` starts a read-only [MCP](https://modelcontextprotocol.io) server over stdio, so coding
agents can check quota state themselves — call `get_overview` before a long task and pick the
provider with headroom. Three tools, all GET-only:

| Tool | Returns |
|---|---|
| `get_overview` | Per-provider quota windows (`five_hour`, `weekly`, …) with used % and reset times, health, and the plan each provider is on |
| `get_subscriptions` | Plan, price, renewal date per provider + per-currency totals |
| `get_models` | The catalogue, optionally filtered by `provider` |

The server talks to the local HTTP API (default `http://127.0.0.1:7788`, override with
`MODELIZER_URL`; set `MODELIZER_TOKEN` when the dashboard is token-protected). Provider keys never
leave the modelizer process, and nothing here can write — catalogue edits stay dashboard-only.

Claude Code:

```sh
claude mcp add modelizer --env MODELIZER_TOKEN=… -- bun --cwd /absolute/path/to/modelizer run mcp
```

Cursor (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "modelizer": {
      "command": "bun",
      "args": ["--cwd", "/absolute/path/to/modelizer", "run", "mcp"]
    }
  }
}
```

## Dashboard cards

- Each provider card **collapses**: the head keeps the provider name, its health badges and the
  refresh times of the windows that gate a working session (the five-hour window and the weekly
  budget above it); usage bars, per-model tables and notes fold away behind it.
- A plan without a five-hour window still shows its weekly refresh (SpaceX/Cursor is metered by
  the week only).
- A window with nothing spent reads "idle — nothing used, no reset to wait for": some providers
  only report a reset time while the window is running, and an unused window has no figure to
  wait on.
- Provider headings use display names (`Codex (OpenAI)`, `SpaceX (Cursor)`, `ZAI`, `Open Router`);
  the provider id stays the key in config, the API and the database, and shows in the heading's
  tooltip.

## Reset notices

Off unless `MODELIZER_WEBHOOK_URL` is set.

| Behaviour | Detail |
|---|---|
| Trigger | A window's `resetsAt` has passed, or `usedPercent` drops by 25+ points (a refresh the clock did not announce) |
| Deduplication | Each `(provider, window, reset)` is delivered once |
| Failure handling | Retries with backoff, then stops; the dashboard is unaffected |
| Sharp-drop timing | Uses the detection time as `resetAt`, because the provider did not name the instant the window rolled |
| Formats | `MODELIZER_WEBHOOK_FORMAT` = `json` or `ntfy`; unset + `ntfy.sh` host → ntfy plain text. The topic is whatever you put in the URL — modelizer does not ship a topic name |

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

## How data is collected

Each provider is an adapter (`src/adapters/`) with a stability tier:

| Tier | Meaning | Providers |
|---|---|---|
| **T1** | Official documented APIs | OpenRouter, Moonshot (Kimi) today; Anthropic/OpenAI admin APIs planned |
| **T2** | Undocumented endpoints the community relies on — can break; failures are isolated per provider, raw responses are archived, the UI shows staleness instead of hiding it | Z.AI, personal Cursor, personal Copilot |
| **T3** | Local files and local CLIs | Claude Code transcripts under `~/.claude/projects`; Codex app-server + session logs |
| **T4** | UI-only, no programmatic path — placeholder cards | ChatGPT subscription, OpenCode Zen credits, Freebuff |

**T2 exception:** Claude's account-wide usage endpoint (`CLAUDE_OAUTH_USAGE=1`, read-only, token
never refreshed) is the one opt-in way to see usage outside this machine. Modelizer does not
scrape claude.ai or chatgpt.com.

### Claude Code quota windows

Transcripts do not include a reset time. Modelizer reads four sources, in order:

| # | Source | Notes |
|---|---|---|
| 0 | **Account-wide usage (opt-in)** | `CLAUDE_OAUTH_USAGE=1` calls Anthropic's usage endpoint with the Claude Code login token from the macOS keychain. Real `five_hour` / `seven_day` percentages + reset times for the whole account (covers claude.ai and other machines — the same source CodexBar uses). Read-only: the token is never refreshed or written back (two refreshers would race and log Claude Code out). A 401/403/429 or unexpected body backs off for an hour. Unset, nothing leaves the machine. |
| 1 | **Status line** | `scripts/claude-statusline.ts` writes `~/.modelizer/claude-statusline.json` when Claude Code passes `rate_limits` (shipped in 2.1.80). Older builds omit them; the script still exits 0. Snapshots older than 6 hours are ignored. |
| 2 | **`claude -p /usage --output-format json`** | Stdin closed, killed after 5s so it cannot hang the scheduler. Dead end on current builds (2.1.307+ answers with no window data); failure marks both windows stale, not retried for 6 hours. Skip with `CLAUDE_USAGE=0`. |
| 3 | **StopFailure hook** | When a turn dies on a rate limit, the hook writes the message's reset time to `~/.modelizer/claude-rate-limit.json` (override with `MODELIZER_CLAUDE_HOOK_FILE`). That instant overrides the matching window from the sources above. |

Status line setup — add to `~/.claude/settings.json`. If you already have a statusLine command,
put it after `--` so this script records the limits and then runs yours with the same JSON on
stdin:

```json
{
  "statusLine": {
    "type": "command",
    "command": "bun /absolute/path/to/modelizer/scripts/claude-statusline.ts -- ~/.claude/statusline.sh",
    "refreshInterval": 60
  }
}
```

Drop the `-- …` part when you have no existing command. Stdout is then a short line such as
`5h 23% · 7d 41%`.

StopFailure hook setup — add to `~/.claude/settings.json`:

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

Skip flags: `CLAUDE_USAGE=0` skips the `/usage` command, `CODEX_APP_SERVER=0` skips the Codex
app-server read. Both fall back without failing the other providers.

### Codex window identification

Windows are identified by length (300 minutes = 5h, 10080 = weekly), not by primary/secondary
slot. Codex prefers the documented `codex app-server` method `account/rateLimits/read` (no model
turn) and falls back to `token_count` rate-limit snapshots in `~/.codex/sessions`.

### Claude cost (API-equivalent)

A subscription has no per-token bill, so modelizer prices the local tokens at list rates and shows
the result as per-model spend ("API-equivalent").

| Fact | Detail |
|---|---|
| Prices | `src/pricing/anthropic.json` — USD per million tokens for input, output, cache read, cache write |
| Checked in | A poll never depends on a third-party host |
| Origin | models.dev — the table CodexBar uses |
| Refresh | `bun run scripts/refresh-pricing.ts` regenerates the file |
| Unknown models | Carry no spend row (e.g. the `<synthetic>` turns Claude Code logs for local errors) |
