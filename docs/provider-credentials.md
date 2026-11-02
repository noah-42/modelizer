# Provider credentials & platform notes — 2026-10-31

Owner decisions and platform facts established in the 2026-10-31 session. This file is the
durable record; the conversation that produced it is not a reference.

## Owner directives (binding)

1. **Verbatim key storage.** Credential values are stored exactly as pasted — no provider
   round-trip, no format gate, no rejection. Route: `PUT/POST /api/providers/:id/tokens/:name`
   (`src/api-providers.ts`). MOD005's write-time validation (`src/key-validation.ts`) was
   removed at owner direction. The nonempty check is the only gate. `scripts/set-key.sh`
   stores verbatim too (hidden prompt kept).
2. **Canonical provider names on Manage.** Subscription labels never name a provider
   ("Premium" is a plan, not a provider). `manageDisplayName()` in `src/provider-registry.ts`
   is the single source; subscription labels appear only on the Subscriptions tab.
3. **Agent-blind rule stands.** No agent reads or echoes key material; verification happens
   through the dashboard API (see verify endpoint below).
4. **Provider marks are 36×36** (`--provider-mark` in `web/src/styles.css`); site header logo
   stays 26×26. Manage page stays on the 600px column (MOD001); no `page-wide`.

## Cursor / The X Subscription (SpaceX card)

- Cursor encrypts its local access token at rest: `state.vscdb` value is wrapped in a
  `cursor-safe-storage:` envelope (observed 2026-10-31, `cursor.storage.authTokenEncryptionAtRest = true`).
  **Resolved 2026-11-02:** the envelope is Chromium os_crypt (`v1:` + base64 of the `v10` AES-128-CBC blob);
  the wrapping key is PBKDF2-SHA1 of the login keychain's `Cursor Safe Storage` / `Cursor Key` password
  over the fixed salt `saltysalt` (1003 iterations, 16 bytes, IV 16×0x20). The cursor adapter decrypts
  this at poll time (`decryptCursorToken` in `src/adapters/cursor.ts`) — read-only keychain read, nothing
  written back, token never logged. Verified live the same day: both api2.cursor.sh poll endpoints answer
  200 with the decrypted bearer. If the keychain item is missing or rotated, the card pauses with a named
  error instead of sending ciphertext.
- The owner's X Subscription unifies Grok + Cursor into one workspace and one weekly included
  pool, managed at grok.com/dashboard.
- Dashboard API keys (`grok_…` prefix, from grok.com/dashboard/api-keys) are **workspace
  credentials for the unified platform**: they authenticate on `https://api.cursor.com/v1/me`
  with **Basic auth** (`key:` as username) → HTTP 200. They are rejected by `api.x.ai` (HTTP 400)
  and have no documented usage endpoint.
- `XAI_API_KEY` (keys from console.x.ai, `xai-…` prefix) is the credential for the developer
  plane `https://api.x.ai/v1` — different plane, different prefix.
- **No public endpoint serves the weekly included-usage meter to individual plans** (checked
  2026-10-31): Cursor API usage endpoints are Admin/Team-scope; `/v1/me` returns identity only;
  grok.com REST is not public. The Grok (xAI) card is therefore plan-only until that changes.

## Grok (xAI) integration

- Registered as a pending integration (`src/provider-registry.ts`), auth `api-key`, secret
  `XAI_API_KEY`. Key storage from the manage card works even without an adapter — the token
  route checks `isKnownProviderId`, not adapter presence.
- Verify endpoint (agent-blind): `POST /api/providers/:id/tokens/:name/verify` — the server
  checks the stored credential against provider planes and returns only statuses:
  - `XAI_API_KEY`: api.x.ai (bearer), api.x.ai/v1/models, grok.com rest paths,
    api.cursor.com/v1/me (basic + bearer)
  - `CURSOR_API_KEY`: api2.cursor.sh profile (bearer), api.cursor.com/v1/me (basic)

## Legacy secrets still on the books

- `CURSOR_API_KEY` (manage key slot on the SpaceX card): preferred over the local token by the
  adapter when set. Useful only if Cursor starts accepting a stored key on its usage endpoints.
- Keychain service is `modelizer`; accounts are the secret names (`SECRET_NAMES` in
  `src/secrets.ts`).
