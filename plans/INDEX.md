# Plans Index — modelizer

- **ID scheme:** prefix `MOD` (first 3 of repo basename, uppercase). Counter: `plans/.plan_counter` (next: MOD002). IDs allocated atomically via the `/pl` helper — never hand-edit the counter.
- **Filename convention:** `YYYY-MM-mmm-DD_<PlanID>_slug.md` (folders: `<PlanID>_slug/PLAN.md`). Date = plan birthday, never changes.

## Plans

[active]    MOD001 2026-10-oct-03 llm-usage-dashboard — self-hosted web dashboard polling usage/quota/balance across all LLM subscriptions & APIs (OpenRouter, Cursor, Copilot, Z.AI + occasional Claude/ChatGPT/Kimi/OpenCode)
