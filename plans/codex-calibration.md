# Codex (ChatGPT plan) usage calibration log

Manual `/status` observations from Codex, paired with modelizer's counters at the same
moment. Same procedure as [claude-calibration.md](claude-calibration.md) — that file explains
the why; this one is the Codex record.

**How to add a row:**
1. Run `/status` inside Codex — note the rate-limit percentages and reset times.
2. Fetch modelizer's counters at the same time:
   `curl -s http://127.0.0.1:7788/api/providers/codex/points?days=1` — latest `codex-5h`
   `used` (tokens) and `requests`.
3. Derived budget = counter ÷ (percentage / 100). If it moved materially (±15%), update
   `CODEX_SESSION_TOKENS` / `CODEX_SESSION_TURNS` in `.env` and note it here.
4. Record conditions: model + effort (e.g. "gpt-6.1-sol, low") — budgets are per-condition.

## Observations

| Observed at (UTC) | Plan | Session % | Session resets | Weekly % | modelizer tokens | modelizer turns | Model (effort) | Derived full window | Notes |
|---|---|---|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — | — | — | No observations yet. Run `/status` in Codex and send a screenshot to seed the first row. |

## Current applied budgets

- None yet — `CODEX_SESSION_TOKENS` / `CODEX_SESSION_TURNS` unset, so the card shows absolute
  tokens/turns without a "left" estimate until the first calibration lands.
- Sessions seen on this machine span gpt-5.2 … gpt-6.1-sol at low/medium effort; budgets only
  transfer between sessions at similar per-turn cost.

## Drift rules of thumb

See [claude-calibration.md](claude-calibration.md) — same rules. Codex notes:
- `/status` shows rate limits as percentages per window; readings near the end of a window
  (80–95%) calibrate best.
- `total_tokens` in Codex records = input (incl. cached) + output, so the token budget is a
  blended-cost unit — a heavy-cached session stretches further than the raw number suggests.
