# Claude usage calibration log

Manual `/usage` observations from Claude Code, paired with modelizer's counters at the same
moment. This file is the durable record — conversation context is not. Append one row per
observation; the more rows, the better the drift correction (Anthropic adjusts limits silently).

**How to add a row** (when a screenshot/reading arrives):
1. Note the `/usage` numbers: session %, session reset time, weekly %, weekly reset.
2. Fetch modelizer's counters at the same time:
   `curl -s http://127.0.0.1:7788/api/providers/claude/points?days=1` — latest `claude-5h`
   `used` (tokens) and `requests`.
3. Derived budget = counter ÷ (percentage / 100). If it moved materially (±15% from current),
   update `CLAUDE_SESSION_TOKENS` / `CLAUDE_SESSION_TURNS` in `.env` and note it here.
4. Record conditions: model + effort ("Opus 5.5 medium"), plan (Pro), anything unusual
   (heavy tool loops, long thinking) — budgets are per-condition.

## Observations

| Observed at (UTC) | Plan | Session % | Session resets | Weekly % | modelizer tokens | modelizer requests | Model (effort) | Derived full window | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 2026-10-06 ~20:35 | Pro | 19% | Wed 02:40 Berlin | 3% (resets Sun 20:00 Berlin) | 8,918,908 | 40 | Opus 5.5 (medium) | ~47M tokens ≈ 210 requests | First calibration; screenshot. Anthropic anchor 21:40 Berlin predates transcript start (21:52) by 12 min — local data cannot see it. `/usage` % is integer-rounded → ±5% noise. |

## Current applied budgets

- `CLAUDE_SESSION_TOKENS=47000000`, `CLAUDE_SESSION_TURNS=210` (in `.env`, 2026-10-06, from the row above)
- Valid for **Opus 5.5 on medium, Pro plan** only. Sonnet / high effort / Max plans need their own row.
- Weekly budget: not yet calibrated — needs a weekly % reading once modelizer holds a full week
  of its own data (to also show the weekly trend), plus the same divide-by-percent math.

## Drift rules of thumb

- Two independent rows agreeing within ~10% → trust the average.
- A sudden jump in derived budget after a row gap → Anthropic changed limits (or conditions
  differed); re-derive from the newest row, keep the old ones for history.
- Turns budget is noisier than tokens (tool-loop counts vary); prefer the token budget as
  the primary signal, turns as a sanity check.
