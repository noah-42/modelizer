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

### Subscription management (manage tab)

These write `subscriptions.toml` textually: comments, field order, and hand-added fields
survive, and a malformed file is an error (`422`), never overwritten.

**`GET /api/subscriptions/config`** — the saved `[[subscription]]` blocks only, as written —
not the merged rows the Subscriptions page shows.

```sh
curl -s http://127.0.0.1:7788/api/subscriptions/config
# → 200 {"path": "subscriptions.toml", "entries": [{"provider": "cursor", "price": 60}]}
```

Errors: `422` the file could not be parsed.

**`POST /api/subscriptions`** — add a block. `provider` is required and unique; every other
field is optional: `plan`, `label`, `note`, `price` (>= 0), `priceNext`, `currency` (3 letters),
`period` (`monthly`/`annual`), `renewsDay` (1–31), `renewsAt`, `endsAt`, `state` (`active`,
`trialing`, `cancelled`, `past_due`, `unknown`), `seats` (>= 1).

```sh
curl -s -X POST http://127.0.0.1:7788/api/subscriptions \
  -H "content-type: application/json" -d '{"provider": "zai", "price": 19, "renewsDay": 5}'
# → 201 {"entry": {"provider": "zai", "price": 19, "renews_day": 5}, "path": "subscriptions.toml"}
```

Errors: `400` malformed body, `409` the provider already has a block (file unchanged), `422` a
value fails the parse rules or the write failed.

**`PUT /api/subscriptions/:provider`** — edit one block. A field absent from the body keeps its
saved value; `null` (or `""` for a text field) clears it. The response is the saved entry, not
a merged row. Errors: `400`/`422` as above, `404` no such block.

**`DELETE /api/subscriptions/:provider`** — remove the saved override **only**. A plan the
provider reports lives in the database facts and keeps appearing with `source != config`;
deleting your note cancels nothing. Errors: `404` no such block, `422` removal failed.

**`PUT /api/subscriptions/order`** — `"providers": ["zai", "cursor"]` in the wanted display
sequence (first gets `order = 1`). Ids not listed keep the price sort after the ranked ones.
Errors: `400` malformed list, `404` an id is not configured (nothing written), `409`
duplicates, `422` write failed.

### `GET /api/changes?kind=subscription|provider|token&limit=200`

The changelog page's data: every user-made change, newest first, capped at 1000.

```jsonc
{
  "changes": [{
    "at": "2026-10-31T01:30:00.000Z",
    "kind": "subscription",          // subscription | provider | token
    "target": "cursor",              // provider id, or "cursor/OPENAI_ADMIN_API_KEY" for a token
    "action": "update",              // add · update · delete · reorder · enable · disable · remove · set · oauth
    "detail": "{\"fields\":{\"price\":{\"before\":60,\"after\":65}}}"
  }]
}
```

`detail` is JSON: subscription updates carry field-level `before`/`after`; token rows carry
`{source}` status only — **the submitted value is never recorded**.

### `GET /api/version`

Build stamp for the page's server-older-than-UI check. Unknown `/api/*` paths answer JSON
`404 {"error":"no such API route"}` — never the SPA's `index.html` — so a server older than
the page produces a readable "restart modelizer" banner instead of an HTML parse error.

### `GET /api/providers/manage`

The manage tab's listing: every built-in adapter with its lifecycle state. Reads never make a
live provider call and never include credential material.

```jsonc
{
  "providers": [{
    "id": "codex",
    "displayName": "Codex",
    "enabled": true,
    "order": 4,
    "missingCredentials": [],
    "tokens": { "OPENAI_ADMIN_API_KEY": { "set": true, "source": "keychain", "shadowed": false } },
    "authMethod": "app: ChatGPT login",   // api-key | app: <name> | oauth
    "appAuthPresent": true,
    "authHealth": "ok"                     // no-token | rejected | quota | ok | unknown
  }],
  "tokens": { "ZAI_API_KEY": { "set": true, "source": "env", "shadowed": false } }
}
```

- `tokens[name].source` is `env` (read-only, wins while present), `keychain`, or `absent` — the
  value itself is never included anywhere in the response.
- `authHealth` is derived from stored poll state only: `no-token` (not configured), `rejected`
  (last error was 401/403), `quota` (429/exhausted — an exhausted subscription is never
  reported as a broken token), `ok` (recent success), `unknown` (never polled).
- App-backed providers (`claude`, `codex`, `cursor`, `freellmapi`) carry `appAuthPresent`;
  `claude` additionally carries `oauthUsageEnabled`.

Errors: `422` the provider config could not be read.

### Provider management (manage tab)

All apply live: the running scheduler reconfigures by the next tick, and the server stays up
even with zero providers enabled.

**`PUT /api/providers/:id/enabled`** — `{"enabled": false}` flips that provider only. Errors:
`400` non-boolean, `404` unknown id, `422` write failed.

**`DELETE /api/providers/:id`** — remove an integration: disables it and drops it from the
saved order. Subscriptions, usage history, models, and Keychain tokens are all kept. Errors:
`404` unknown id, `422` write failed.

**`PUT /api/providers/order`** — `{"ids": ["zai", "claude"]}` in the wanted card order; missing
ids keep registry order after the ranked ones. Errors: `400` malformed list, `404` unknown id,
`409` duplicates, `422` write failed.

**`PUT` / `POST` / `DELETE /api/providers/:id/tokens/:name`** — store, shadow-store, or remove a
credential in the macOS Keychain (`modelizer` service). `PUT` sets the effective value;
`POST` stores a Keychain entry even when the environment shadows it; `DELETE` removes. The
next poll picks the change up without a restart (the in-process credential snapshot is
refreshed). Responses carry status only — `{set, source}` plus, for a shadowed entry,
`"message": "shadowed by environment"` — never the value, which also means no log or response
ever echoes what you sent.

```sh
curl -s -X PUT http://127.0.0.1:7788/api/providers/zai/tokens/ZAI_API_KEY \
  -H "content-type: application/json" -d '{"value": "zk-…"}'
# → 200 {"set": true, "source": "keychain", "shadowed": false}
```

Errors: `400` empty value, `404` the credential name does not belong to that provider, `409`
the credential is environment-supplied (`PUT`/`DELETE` refuse; env wins while present), `422`
Keychain or refresh failure.

**`PUT /api/providers/claude/oauth-usage`** — `{"enabled": true}` sets `CLAUDE_OAUTH_USAGE` for
the running process only: the opt-in for Claude's account-wide OAuth usage reporting. Nothing
is written to Claude's own auth stores, and no token is refreshed. Errors: `400` non-boolean.

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

### `PUT /api/models/order`

Set the display order: the ids come in the wanted sequence, the first getting `order = 1` in its
`models.toml` block, and so on. Ids not listed keep their current rank and sort after the ranked
ones, by name. Blocks are edited textually — comments and hand-added fields survive.

```sh
curl -s -X PUT http://127.0.0.1:7788/api/models/order \
  -H "content-type: application/json" \
  -d '{"ids": ["glm-5.3", "claude-opus-5-5"]}'
# → 200 {"ordered": 2, "path": "models.toml"}
```

Errors: `404` an id is not in the catalogue (nothing is written), `422` reorder failed.

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
