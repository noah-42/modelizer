# MOD003 - management-ux-freshness-hardening

## TL;DR
You manage your subscriptions and provider tokens from one page (manage), see the results on
the subscriptions page and dashboard, and every change is recorded on a dedicated changelog
page. Every page paints instantly from data on disk and refreshes in the background. The
models page is a calm, columnar table with rules between rows. Nothing ships without the
tests for it running against a fixture server AND the live server.

## Problem statements (all user-reported 2026-10-31)
1. **P1 JSON-parse error on manage.** A long-running server process predating the manage API
   served the new UI from disk but answered new API calls with `index.html` →
   `Unexpected token '<'`. Two gaps: no graceful degradation when the API is missing, and no
   deployment-lifecycle testing.
2. **P2 No editing where you look.** The subscriptions page is read-only; editing lives only
   on manage, with no path from the row you are looking at.
3. **P3 No change log.** Subscription/token changes leave no visible trail. Audit DB events
   exist for polls but not for user changes.
4. **P4 Slow first paint.** Pages spin on load although all data is already in SQLite.
5. **P5 Models page is disjointed** — no columnar rhythm, no row rules, floating whitespace.

## Page relationship contract (to be documented in README + AGENTS.md)
| Page | Role | Talks to |
|---|---|---|
| Dashboard | Monitor (read-only, live) | displays; links to manage to fix things |
| Subscriptions | Read + edit entry point (merged facts + overrides) | edits route to manage form; shows changelog links |
| Manage | Write (only mutating page) | writes config + changelog events; dashboard/subscriptions reflect by next refresh |
| Changelog | Record (new page) | reads the change log: subscriptions + provider/token changes, field-level before→after |
| Audit | Machine record (polls + changes) | changelog is the human view of the change subset |
| Diary | History (read-only) | untouched by manage |

## Todos
- [ ] 1. Hardening: unknown `/api/*` returns JSON 404 (never HTML); UI fetch helpers raise a
      readable "server responded with HTML — is the server older than the UI?" error; a
      `/api/version` (build stamp) compared against a UI stamp with a visible "restart the
      server" banner on skew. Deployment-lifecycle test: boot an old-routes server, point the
      new UI at it, assert graceful banners (Playwright + bun test).
      Test plan: fixture server without new routes; curl matrix of unknown routes; UI pass
      asserting error banners, no raw JSON exceptions. Evidence: lifecycle test output + shot.
- [ ] 2. Subscription editing on the subscriptions page: every row gets an Edit affordance →
      prefilled form (on the subscriptions page, flipping back to the card on save). All
      fields the manage form supports; duplicate/invalid states reuse the existing 4xx
      mapping; provider-detected rows without an override get "create override" prefilled
      from the merged row.
      Test plan: Playwright CRUD round-trip on fixture; invalid input shows server message;
      fact-only row becomes an override; live-server read-only pass afterwards.
- [ ] 3. Change log (backend): every mutation (subscription add/edit/delete/reorder with
      field-level before→after; provider enable/remove/reorder; token add/replace/remove —
      never the value) appends a change event to the DB (new table `changes`, or audit events
      tagged `kind=change`). Query API: `GET /api/changes?limit=&type=`.
      Test plan: bun test — one mutation of each type asserts exactly one row with correct
      before/after shape and no secret material.
- [ ] 4. Changelog page (new tab): columnar list, newest first, filter by type
      (subscriptions/providers/tokens), each row shows what/who (local)/when + before→after.
      Test plan: Playwright — perform mutations, see them on the page, filter works.
- [ ] 5. Freshness (stale-while-revalidate) on dashboard, subscriptions, models, manage:
      first paint from last-known data (in-memory cache or instant DB read), background
      refetch on an interval and on tab focus; "as of X min ago" stamp; no spinners after
      first ever load.
      Test plan: bun test timing assertions on the data hooks; Playwright: cold load has no
      spinner frame after cache warm; stale stamp appears when API is slowed (route delay).
- [ ] 6. Models page redesign: single columnar table — one row per model, columns: model,
      provider, context, price in/out; hairline rules between rows; section headers instead
      of floating cards; no mixed-width cards.
      Test plan: Playwright screenshot at 1440/390; assert row count == model count, rules
      present (computed border), no horizontal overflow.
- [ ] 7. Docs + registration: README page-relationship table, AGENTS.md conventions (change
      events, SWR rule), this INDEX entry moved to archived on completion.

- [x] 8. Keychain isolation (incident follow-up): a QA pass exercised the token-remove flow
      against the real login keychain and deleted the user's ZAI_API_KEY (2026-10-31 ~00:45).
      Fix: `MODELIZER_KEYCHAIN_FILE` / `SecretOptions.keychainFile` routes all `security` CLI
      calls to a scratch keychain file; test proves writes land there and the login keychain
      is untouched. AGENTS.md now mandates it for every test/fixture process.

## Final verification wave
- F1 plan compliance · F2 code review · F3 Playwright against fixture AND live server
  (read-only) · F4 ideal-state fidelity vs the problem statements above. All must approve.

## Success criteria
- Manage page never shows a JSON/HTML parse error, even against a stale server (banner instead).
- Every subscription visible on the subscriptions page can be edited from that page.
- Every subscription/provider/token change appears on the changelog page within one refresh.
- Every page paints instantly from cached data; refreshes never block the UI.
- Models page reads as one table with rules; user approves the screenshot.
