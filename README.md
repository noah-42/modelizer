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

Point a provider at the mock with `OPENROUTER_BASE_URL=http://127.0.0.1:9801` and any non-empty
key, plus `MODELIZER_DB=data/dev-mock.db` to keep demo data out of your real database.

## Status API

- `GET /api/overview` — one object per provider: state (last poll, errors, staleness) + latest points
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

## How data is collected

Each provider is an adapter (`src/adapters/`) with a stability tier:

- **T1** official documented APIs (OpenRouter today; Anthropic/OpenAI admin APIs planned)
- **T2** undocumented endpoints the community relies on (Z.AI, personal Cursor, personal Copilot,
  Claude subscription OAuth — planned). These can break; failures are isolated per provider,
  raw responses are archived, and the UI shows staleness instead of hiding it.
- **T3** local files (Claude Code transcripts under `~/.claude/projects`, Codex session logs
  under `~/.codex/sessions` — no API exists for the Claude Pro/Max and ChatGPT-plan
  subscriptions they meter. OpenCode logs planned)
- **T4** UI-only, no programmatic path (ChatGPT subscription, OpenCode Zen credits — placeholder cards)

Plans live in [`plans/`](plans/) — see [MOD001](plans/2026-10-oct-03_MOD001_llm-usage-dashboard.md)
for the roadmap (phases: walking skeleton → regulars → occasionals → polish/deploy).
