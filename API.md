# modelizer API

modelizer is API-first: the web UI is a client of the same JSON API, so anything a page shows,
another service can read. Every endpoint returns JSON (`Content-Type: application/json`) and is
served from the same process as the dashboard.

Base URL: `http://127.0.0.1:7788` (bind and port are set in `modelizer.toml`).

## Authentication

Off by default: a default install answers anyone who can reach the port, which is only this
machine (`127.0.0.1`).

To let other machines read it, set a shared secret — either `[server] token` in `modelizer.toml`
or the `MODELIZER_TOKEN` environment variable (the environment wins). When a token is set:

- Requests **originating on this machine** are trusted (the dashboard in your browser, local
  scripts). Nothing changes for them.
- Requests **from anywhere else** must present it, as `Authorization: Bearer <token>` or
  `?token=<token>`. Anything else answers:

```sh
curl -s http://modelizer.example.lan:7788/api/overview
# → 401 {"error":"unauthorized — pass the token as `Authorization: Bearer …` or `?token=…`"}

curl -s -H "Authorization: Bearer $MODELIZER_TOKEN" http://modelizer.example.lan:7788/api/overview
```

There is no scope model: the token reads and writes everything, including `POST /api/models`.
Keep the bind on loopback unless you need the remote access, and treat the token like a key.

## Endpoints

### `GET /api/overview`

One object per provider — the dashboard, as data. Polled adapters come first in card order,
then `planOnly: true` entries for subscriptions with no API behind them.

```jsonc
{
  "generatedAt": "2026-10-22T17:30:15.000Z",
  "providers": [
    {
      "id": "cursor",
      "configured": true,
      "stale": false,
      "lastSuccess": "2026-10-22T17:25:40.000Z",
      "lastError": null,
      "degradedEndpoints": [],
      "status": [],
      "notes": [],
      "points": [
        {
          "kind": "quota",
          "label": "cursor-included-usage",
          "used": 90.27,
          "limit": 100,
          "unit": "percent",
          "reset_at": "2026-10-24T14:01:19.604Z",
          "quota_window": "weekly",
          "source": "cursor-api"
        }
      ],
      "windows": [{ "window": "weekly", "usedPercent": 90.27, "resetsAt": "2026-10-24T14:01:19.604Z" }],
      "subscription": { "plan": "Premium", "price": 15.5, "currency": "EUR" },
      "planOnly": false
    }
  ]
}
```

`windows[]` is the authoritative view for an outside assistant: the tightest window that gates a
working session on that provider (`five_hour`, `weekly`, `monthly`), how much of it is used, and
when it resets. A window with nothing spent carries `resetsAt: null` — providers only start the
clock on the first request, and modelizer does not invent a time.

### `GET /api/subscriptions`

```jsonc
{
  "totals": [{ "currency": "EUR", "monthly": 59.92 }],
  "subscriptions": [
    {
      "provider": "codex",
      "plan": "ChatGPT Plus",
      "price": 23.0,
      "priceNext": null,
      "currency": "EUR",
      "current": 23.0,
      "monthly": 23.0,
      "recurring": true,
      "prepaid": false,
      "counts": true,
      "state": "active",
      "renewsAt": "2026-11-05T00:00:00.000Z",
      "endsAt": null,
      "note": null,
      "source": "codex-auth+config",
      "configured": true
    }
  ]
}
```

`totals` sums the plans that are active **now** (`counts: true`), per currency — currencies are
never converted or added together. A prepaid term or a cancelled plan stays in `subscriptions`
with `counts: false`. A malformed `subscriptions.toml` answers `422` with `error` set.

### `GET /api/models`

The model → provider catalogue from `models.toml`:

```jsonc
{
  "generatedAt": "2026-10-22T17:30:15.000Z",
  "path": "models.toml",
  "models": [
    {
      "id": "moonshotai/kimi-k3",
      "name": "MoonshotAI: Kimi K3",
      "provider": "moonshot",
      "sourceUrl": "https://openrouter.ai/moonshotai/kimi-k3",
      "contextLength": 1048576,
      "promptUsdPerMTok": 0.239,
      "completionUsdPerMTok": 11.936
    }
  ],
  "error": null
}
```

Matching helpers (`resolve`, `providerOf`) are case-insensitive and prefix-aware, so a versioned
model string finds its base entry; an unmatched model stays unknown rather than being attributed.

### `POST /api/models`

Add a catalogue entry from an OpenRouter link. The link supplies only the id; every stored field
comes from OpenRouter's catalogue endpoint.

```sh
curl -s -X POST http://127.0.0.1:7788/api/models \
  -H "content-type: application/json" \
  -d '{"url": "https://openrouter.ai/deepseek/deepseek-v3.2", "provider": "deepseek"}'
# → 201 {"model": { "id": "deepseek/deepseek-v3.2", … }, "path": "models.toml"}
```

`provider` is optional (default `openrouter`) and decides the section the model files under.
Errors: `400` not an OpenRouter link, `404` unknown model, `409` already catalogued, `422`
broken config, `502` OpenRouter unreachable.

### `DELETE /api/models/:id`

Remove a catalogue entry by id (URL-encoded in the path). Matching is case-insensitive and
trimmed, like resolution. The `[[model]]` block is cut out textually, so every other byte of
`models.toml` — comments, field order, hand-added fields — is preserved, and removal works even
when the rest of the file is currently unparsable.

```sh
curl -s -X DELETE http://127.0.0.1:7788/api/models/deepseek%2Fdeepseek-v3.2
# → 200 {"removed": "deepseek/deepseek-v3.2", "path": "models.toml"}
```

Errors: `404` not in the catalogue, `422` removal failed.

### `GET /api/diary?days=14`

Per-day usage summaries per provider — the diary page as data. `days` is capped at 90.

### `GET /api/sessions` · `GET /api/audit?session=ID&limit=300`

Session records and the audit log of every poll and event, newest first.

### `GET /api/providers/:id/points?days=30` · `GET /api/providers/:id/raw?limit=10`

Point history per provider, and the raw archived provider responses — repair evidence when an
undocumented endpoint drifts.

## Conventions

- **Ids over names.** `provider` is the stable key (`claude`, `codex`, `cursor`, `zai`,
  `openrouter`, `opencode`, `freellmapi`, `deepseek`, `moonshot`, …); display names are
  presentation. Model ids are the strings adapters report.
- **Money is never converted.** Amounts carry their `currency`; totals are per currency.
- **Unknown stays unknown.** A reset time, price or provider the data does not state arrives as
  `null`, never as an estimate.
- **No versioning yet.** Fields are additive; breaking changes would be announced in the README
  before they land.
