# MOD004 - auth-failure surfacing

## TL;DR
When a provider rejects the stored API key, modelizer must say so in plain language on the
dashboard — "auth failed: key rejected" with the provider's own message — not the generic
"no usable data" that looks like a scrape drift. Discovered 2026-10-31: the ZAI key was
rejected (Z.AI `code 1000 Authentication Failed`) for 98 consecutive polls (~15 hours) while
the card kept showing a stale 19% and the error string gave no hint the key was the problem.

## Problem statement (user-reported 2026-10-31)
A provider whose credentials have been revoked will never recover by itself. Retrying with
backoff is correct, but the user must be told *the key is the problem* on the first failed
poll, because the fix is human action (generate a new key, update the keychain), not waiting.
Today auth rejections collapse into per-adapter generic NormalizeError strings, and the UI
shows them only inside the card body with a generic `failing ×N` badge.

## Design
1. **Contract:** `Adapter` gains an optional `authFailure?(polls: RawPoll[]): string | null`.
   Pure; returns a human-readable reason when the polls show the provider rejecting the
   credentials, else null. Adapters keep heuristics per provider (body codes, HTTP 401/403).
2. **Error type:** `AuthError extends Error` in `src/adapters/types.ts`. The scheduler calls
   `authFailure` after collect and before normalize; a non-null result throws `AuthError`.
3. **Message convention:** auth errors are stored as `auth: <reason>` in `adapter_state.last_error`.
   No schema change — the prefix is the machine-readable signal.
4. **Scheduler:** on `AuthError`, keep the existing failure bookkeeping and backoff (a dead key
   should not be hammered), but do not let backoff exceed `max_backoff_seconds` (already true).
5. **UI:** when `lastError` starts with `auth:`, the provider badge reads `auth failed`
   (bad tone) and the card shows the reason after the prefix, first line, no truncation.
6. **ZAI adapter:** implements `authFailure` — body `code: 1000` / `msg` containing
   "Authentication Failed" on any required-ish poll (quota-limit, coding-usage), or HTTP 401/403
   from them. Reason: `ZAI_API_KEY rejected by api.z.ai (code 1000 Authentication Failed) —
   generate a new key and update it (keychain: modelizer / ZAI_API_KEY)`.
7. **Docs:** AGENTS.md adapter contract row notes `authFailure` + the `auth:` prefix rule.
   Other adapters can adopt incrementally; none required by this plan.

## Non-goals
- No key rotation UI, no write path to the keychain from the app.
- No change to polling cadence or backoff math.
- No migration of existing adapters beyond zai.

## Todos
- [x] 1. `AuthError` + `authFailure?` on the Adapter contract in `src/adapters/types.ts`.
      Test plan: typecheck; contract test that a null return never throws.
- [x] 2. Scheduler: call `authFailure` after collect, throw `AuthError`, store `auth:`-prefixed
      message in `adapter_state.last_error`. Audit event says `auth failed`.
      Test plan: bun test with a stub adapter whose polls carry an auth-reject body — assert
      state message starts with `auth:` and backoff still applies.
- [x] 3. ZAI adapter `authFailure` implementation (body code 1000 / "Authentication Failed",
      HTTP 401/403 on quota-limit or coding-usage).
      Test plan: bun table test — real observed body `{"code":1000,"msg":"Authentication
      Failed","success":false}`, a 401, and a healthy 200 all classified correctly.
- [x] 4. UI: `auth failed` badge + prominent reason line when `lastError` starts with `auth:`.
      Test plan: Playwright — fixture server with an `auth:` last_error renders badge and reason;
      generic error unchanged.
- [x] 5. Docs: AGENTS.md WHERE TO LOOK + adapter contract notes; INDEX entry moved to archived.
- [x] 6. Live verification: fixture suite green (`bun test`), then confirm the running server
      shows `auth failed` for zai against the real rejected key (read-only pass).

## Success criteria
- With a rejected key, the zai card shows the `auth failed` badge and a message naming the key
  and the fix, on the first failed poll — never a bare "no usable data".
- Healthy keys are unaffected; no false positives on 429/5xx/known-quirk bodies
  (coding-usage `code 500 / 404 NOT_FOUND` must NOT classify as auth).
- All existing tests stay green.
