# MOD056 - manage page design

## Status
PROPOSAL — in design interview. This file is updated as decisions land; nothing is
implemented until the interview resolves the open questions below.

## Context
Manage is providers-only (MOD005): provider integrations and their tokens, with
subscription editing having moved to the subscriptions page. The user rejected the
current layout ("looks like shit") and wants a designed page, not a patched one.
Constraints already fixed by earlier plans: the 600px single-column frame (MOD001),
the dashboard look-and-feel as reference (26px brand marks, aligned two-column rows),
unique URLs per page.

## Open questions (the interview)
1. What is this page FOR — what job does the user come here to do, and how often?
2. What is the primary object: the provider, the credential, or the health state?
3. What density — dashboard-like calm cards, or a tighter operational table?
4. What must be visible at a glance vs one click away?
5. What did the previous layouts actually get wrong, concretely?
6. Anything on this page the user never uses and wants gone?

## Decisions
1. **Job: all of (a) repair, (b) administer, (c) glance.** The page must serve one-glance health,
   fast repair, and routine admin — so: clear per-card health, edits one obvious control away,
   and a scannable uniform rhythm.
2. **Icon buttons, not words:** pencil = edit (token replace), trash = remove, plus = add.
   Text labels disappear; icons carry the action (aria-labels keep the words for a11y).
3. **Card anatomy (top row):** provider name, health badge immediately next to the name,
   auth method ("app: Claude Code login" / "api-key") pushed to the far right corner of the card.
4. **Reorder row:** arrow buttons sit below the title row, much shorter height than now
   (current 44px touch-target height reads as clunky on desktop).
5. **"enabled" becomes a toggle switch** (iOS-style on/off control), not a checkbox with a
   word. Same font family in both states (locked). Purpose unchanged: on = poll + dashboard
   card, off = stop polling, keep credentials/history.
6. Placement of the toggle on the card: pending question 2 follow-up — card face vs edit flow.
7. **Errors become icons, not prose:** error/missing messages (e.g. "missing: FreeLLMAPI
   database/container not found: …") render as an error icon that flashes (subtle pulse) to
   attract the eye; rolling over it reveals the full error text (tooltip / hover card).
   Card face stays clean; details are one hover away.
8. **Two-column card grid (user directive, repeated):** providers sit in a 2×N grid of smaller
   cards; the manage page frame widens to ~1000px. The 600px MOD001 frame stays for the other
   pages unless the user says otherwise. Toggle placement resolved with it: the enabled switch
   sits on the card face (glance layer) — user-implied, cheap to override.

## Answers given during interview
- Font: system stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`) —
  SF Pro on the user's Mac. **Locked: no new fonts may be introduced, site-wide, in any
  element state (user directive).**
- "enabled" purpose (explained): the per-provider on/off switch — checked = modelizer polls
  it and shows it on the dashboard; unchecked = polling stops, dashboard card hides,
  credentials/history kept. Writes `enabled` in modelizer.toml. Not the credential itself.

## Success criteria
(to be defined when the decisions are in)

## Interview round 2 (user directives)
14. Multiple keys collapse: when a provider has more than one key, the card shows a collapsed
    summary by default; clicking expands the card to reveal all key rows (each key row: name,
    status, pencil/trash). Providers with a single key show it directly, no expansion needed.
