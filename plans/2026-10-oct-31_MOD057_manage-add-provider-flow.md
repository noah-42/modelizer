# MOD057 — Manage: add provider (+ icon, typed id, key)

| Field | Value |
|---|---|
| **Plan ID** | MOD057 |
| **Status** | proposed |
| **Audience** | pi |
| **Mode** | interview |
| **Created** | 2026-10-oct-31 |

## TL;DR

Replace the current “pick a disabled integration chip” add flow on `/manage` with a **+ control** that opens a small form: **provider** (typed id) and **key** (password field). Storing the key follows MOD005 validation rules. Provider ids and auth expectations live in an explicit **registry** document in code — not ad hoc UI chips.

## Problem (owner-reported 2026-10-31)

1. **Wrong affordance:** “Add provider integration” shows a row of preset buttons (e.g. Kimi only). That reads like a fake feature, not “I add what I want.”
2. **Wrong interaction:** Owner wants **click + → type provider → paste key** (TBD auth paths like Freebuff/OpenCode can defer key until auth method is known, but **api-key** providers must accept a key in this flow now).
3. **Registry gap:** New integrations (Freebuff, OpenCode, future ids) must be **registered** with display name, auth method (`TBD` | `api-key` | `app: …` | `oauth`), and optional secret name(s) — not hard-coded only in React label maps.
4. **Page width:** Manage must stay on the **600px** frame (MOD001); no `page-wide` without owner sign-off (reverted 2026-10-31).

## Target UX (acceptance)

| Step | Behavior |
|---|---|
| 1 | Top of Providers section: **+ icon button** (always visible while add is allowed). |
| 2 | Click + → inline panel: label **Provider**, text input (id slug, e.g. `freebuff`, `zai`). |
| 3 | Second field **Key** (password), shown when registry says `authMethod === "api-key"`; hidden/disabled with explanation when `TBD` or `app:` (copy points to future flow or Subscriptions). |
| 4 | **Add** (or **Save**) runs one atomic user action: register/enable in `modelizer.toml` + store key when applicable + refresh manage list. |
| 5 | On failure: banner with server message (422 validation, unknown id, duplicate). |
| 6 | Remove the preset **chip list** of disabled providers as the primary add path. |

## Registry contract (code)

Extend `src/provider-registry.ts` (or split `src/integration-registry.ts`) to be the **single source** for:

- `id` (slug, `[a-z0-9_-]+`)
- `displayName`
- `authMethod` (`TBD` | `api-key` | `app: …` | `oauth`)
- `secretNames?: readonly SecretName[]` — when `api-key`, which env/keychain names the manage form binds to
- `collectorStatus`: `live` | `pending` | `plan-only` (for dashboard/manage messaging)

**Open product decision:** typed id must match a registry entry **vs** owner can invent new ids that append to a user-editable registry file (`integrations.toml`?). See interview Q1.

## Backend (likely)

| Piece | Change |
|---|---|
| `POST /api/providers` or extend `PUT …/enabled` + token | Accept `{ id, key? }`; validate id against registry; enable provider; optional `setToken` with MOD005 validation |
| `config.ts` | Allow enabling ids present in registry (already partially true for `PENDING_INTEGRATIONS`) |
| `PROVIDER_SECRETS` | Drive from registry, not scattered maps |
| Manage GET | Still lists enabled + dashboard-visible; add panel uses registry for validation hints (not a chip mall) |

## Out of scope (this plan)

- Implementing Freebuff/OpenCode **poll adapters** (collector still pending; `statusNotes` explain).
- Subscriptions **add** flow (separate; already has “add subscription” on `/subscriptions`).
- Widening manage page past 600px.

## Testing

- Route test: unknown id → 404/422 with message; valid id + bad key → 422 before keychain write (MOD005).
- Playwright: + opens panel; type `zai` + key → card appears; `TBD` provider enables without key field.
- Registry unit test: every `api-key` entry has `secretNames.length >= 1`.

## Open interview (owner)

1. **Registry scope:** Add flow only for **pre-registered** ids, or **any typed slug** persisted to config?
2. **Key field for `TBD`:** Omit key entirely until auth decided, or show disabled field + explanation?
3. **Display name:** Owner types id only — display name always from registry, or optional second field?
4. **Duplicate:** Provider already enabled — error or focus existing card?

## Decisions (owner)

- **2026-10-oct-31:** Add flow is **user-defined, one provider at a time** — owner types the id in the + form; not limited to a preset chip list from the compiled registry alone (implementation must persist new ids; see backend section).

## Changelog

- **2026-10-oct-31** — Created (proposed). Original goal: + icon add flow with typed provider + key; registry-backed; replace chip list. Owner: “I need a plan with plan ID registered”; counter allocated MOD057.
- **2026-10-oct-31 17:59** — Interview Q1 answered (proposed): user-defined integrations, one provider at a time. Per user direction.
