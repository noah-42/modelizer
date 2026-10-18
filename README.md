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
| `bun scripts/claude-rate-limit-hook.ts` | Optional Claude Code StopFailure hook (records a rate-limit reset) |

Point a provider at the mock with `OPENROUTER_BASE_URL=http://127.0.0.1:9801` and any non-empty
key, plus `MODELIZER_DB=data/dev-mock.db` to keep demo data out of your real database.
Codex and Claude mocks also write a rate-limit fixture: `CODEX_APP_SERVER_FIXTURE=data/mock-codex/app-server.json`
and `CLAUDE_USAGE_FILE=data/mock-claude/usage.txt`.

## Status API

- `GET /api/overview` — one object per provider: state (last poll, errors, staleness) + latest points.
  Each provider also has `windows[]`: `{ window, usedPercent, resetsAt, source, stale }` for the
  authoritative quota windows (`five_hour`, `weekly`, and Z.AI's `monthly` / `mcp`). `source` is
  `app-server`, `session-log`, `usage-command`, `hook`, or `zai-api`. `stale` is true when a
  Claude `/usage` parse failed or a Codex/Z.AI reset was rolled forward or discarded.
- `GET /api/providers/:id/points?days=30` — point history
- `GET /api/providers/:id/raw?limit=10` — raw archived responses (repair evidence when an
  undocumented endpoint drifts)

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
  shows staleness instead of hiding it. Modelizer does not call undocumented OAuth usage
  endpoints and does not scrape claude.ai or chatgpt.com.
- **T3** local files and local CLIs. Claude Code transcripts under `~/.claude/projects` supply
  token counts. Reset times come from `claude -p "/usage"` (prose; archived; marked stale if
  parsing fails) and, optionally, a StopFailure hook. Codex prefers the documented
  `codex app-server` method `account/rateLimits/read` (no model turn) and falls back to
  `token_count` rate-limit snapshots in `~/.codex/sessions`. Windows are identified by length
  (300 minutes = 5h, 10080 = weekly), not by primary/secondary slot.
- **T4** UI-only, no programmatic path (ChatGPT subscription, OpenCode Zen credits — placeholder cards)

### Claude Code reset hook

Transcripts do not include a reset time. `claude -p "/usage"` is the regular reader. When a turn
dies on a rate limit, Claude Code can also run a StopFailure hook that writes the message's
reset time to `~/.modelizer/claude-rate-limit.json` (override with `MODELIZER_CLAUDE_HOOK_FILE`).
Modelizer prefers that exact instant for the matching window. Add this to `~/.claude/settings.json`:

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

Plans live in [`plans/`](plans/) — see [MOD001](plans/2026-10-oct-03_MOD001_llm-usage-dashboard.md)
for the roadmap (phases: walking skeleton → regulars → occasionals → polish/deploy).
