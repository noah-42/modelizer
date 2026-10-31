# MOD005 - agent-blind keys + write-time credential validation

## TL;DR
Keys are validated at the moment they are stored, from every entry path, and agents never
need to touch key material. The MOD004 incident (a placeholder-wrapped dead value sitting in
the keychain for 15 hours, plus an unsafe paste instruction) cannot recur.

## Problem statements (2026-10-31)
1. A QA write and a user paste both stored malformed key values; nothing in the chain
   validated anything at write time; the poll error ("no usable data") never named the key.
2. The user's fix instruction (`-w '<new-key>'`) had placeholder brackets that were pasted
   verbatim — the terminal path is paste-unsafe by construction.
3. Diagnosis required the agent to read the raw key — unacceptable as a standing practice.

## Decisions
- **Web path is primary:** the manage tab stores a token only after the provider answers
  HTTP 200 for it (`src/key-validation.ts`, route returns 422 with a readable reason;
  the value is never echoed). Format gate first: `<`, `>`, whitespace refused offline.
- **Terminal path:** `scripts/set-key.sh <KEY_NAME>` — hidden prompt, same gates, PASS/FAIL only.
- **Agent-blind rule (AGENTS.md):** agents never read or echo key material; verification goes
  through the dashboard API (`consecutiveFailures` reaching 0 is the proof a key works).
- Validators exist for ZAI_API_KEY and OPENROUTER_API_KEY; other credentials store unvalidated.
- Network trouble during validation does not block a possibly-good key (fail open, loudly).

## Done
- [x] `src/key-validation.ts` + tests (format gate, 401 rejection, fail-open, no-validator).
- [x] Route wiring in `src/api-providers.ts` + hermetic route tests (422 before keychain write).
- [x] `scripts/set-key.sh` (hidden prompt, validation, PASS/FAIL).
- [x] AGENTS.md secrets row documents the agent-blind rule; README page contract updated.

## Success criteria
- Storing a dead or malformed key from the manage tab or the script is impossible without a
  deliberate `MODELIZER_KEYCHAIN_FILE`-style bypass; both paths say why on failure.
- A valid key stores on the first try; verification never needs the raw value.
