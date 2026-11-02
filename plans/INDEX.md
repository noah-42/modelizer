# Modelizer plans

- **ID scheme:** `MOD` (first three letters of `modelizer`, uppercase); next ID: see `plans/.plan_counter` (allocated through planning helper).
- **Filename convention:** `YYYY-MM-mmm-DD_<PlanID>_<slug>.md`; the date is the plan's creation date.

## Active and proposed

[proposed] MOD057 2026-10-oct-31 manage-add-provider-flow — Manage add flow: + icon, typed provider id, key field; registry-backed; replaces disabled-provider chip list.

[proposed] MOD056 2026-10-oct-31 manage-page-design — Manage page redesigned around a stated job-to-be-done; currently in design interview, decisions landing in the plan file.

## Archived

[completed] MOD005 2026-10-oct-31 agent-blind-keys — Write-time credential validation on manage + set-key.sh; agents verify through the dashboard API, never key material.
[completed] MOD004 2026-10-oct-31 auth-failure-surfacing — Providers that reject the stored key say so on the dashboard (`auth failed` badge + fix instructions) instead of a generic scrape error.
[completed] MOD003 2026-10-oct-31 management-ux-freshness-hardening — Subscriptions editing in place, changelog page, stale-while-revalidate freshness, models table, deployment hardening.
[completed] MOD001 2026-10-oct-30 modelizer-dashboard-layout — Separate quota usage from reset timing and document the provider-management gap.
