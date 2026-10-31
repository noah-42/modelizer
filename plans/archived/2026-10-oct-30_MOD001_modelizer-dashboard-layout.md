# Plan: Make provider quota cards easier to scan

- **Plan ID:** MOD001
- **Date:** 2026-10-oct-30
- **Status:** completed
- **Audience:** human
- **Mode:** standard
- **Scope:** Separate quota usage from reset timing in provider cards and document the provider-management gap.
- **Source:** OmO session

## Goal

Make the important quota information legible at a glance: retain the provider mark and name at the top of each dashboard card, then show usage and refresh schedule in distinct columns below. Preserve truthful provider-reported reset data and existing provider-specific windows.

## Context

The live dashboard at `http://127.0.0.1:7788/` currently puts usage and reset details together in one-line entries beneath each card header. `ProviderCard` and `windowsAboveTheFold` in `web/src/App.tsx` select the visible quota windows; `web/src/styles.css` defines the card layout. `/api/overview` already supplies usage points and reset timestamps, so this presentation change should not need a backend or schema change.

The project correctly avoids inventing reset times. Some providers do not report them, and some cards have a quota window other than five-hour or weekly. Keep those cases explicit rather than displaying a guessed time or an empty column.

The existing controls are distinct: the dashboard's ✕ hides a provider card and the hidden strip can restore it; the Models tab adds and removes catalogue models. The catalogue add/remove work is present in `origin/main` (including `07d2e9c`, `53d63d5`, and `47b304b`). No UI for adding or removing provider integrations was found. Provider integrations are adapter-backed; adding an entirely new provider is not equivalent to adding a model catalogue row.

## Steps

1. **Define the card information hierarchy.** Keep the provider favicon, name, health/tier badges, and hide control in the existing header. Below it, present each quota window as a row with two aligned regions: usage on the left and reset timing on the right. Label the windows clearly, particularly five-hour and weekly windows.
2. **Reuse authoritative window data.** Use the selected `UsagePoint` values already rendered by `ProviderCard`. Show provider-supplied reset day/time and a live countdown when `reset_at` exists. When absent, preserve the current distinction between an idle window and a provider that has not reported a refresh time; do not derive reset timestamps from a nominal window duration.
3. **Preserve other providers' useful windows.** Keep the existing fallback behavior for providers without five-hour or weekly windows, such as Cursor's included-usage cycle and other quota windows. Keep plan-only subscription cards and expanded per-model details working.
4. **Implement responsive card styling.** Add a dedicated inner layout for the usage and refresh columns in `web/src/App.tsx` and `web/src/styles.css`. Use two columns where there is room; stack the regions on narrow viewports. Keep the page's existing one-card-wide dashboard grid and collapsed-details behavior.
5. **Verify the rendered behavior.** Exercise the dashboard with five-hour and weekly windows, a single nonstandard quota window, multiple windows, an idle window, and a missing reset timestamp. Check a desktop viewport and a narrow mobile viewport for clipping, overlap, and clear association between each usage value and its reset time. Run `bun test`, `bun run typecheck`, and `bun run web:build`.
6. **Keep provider integration management separate.** Do not present model catalogue add/remove as provider integration management. If the intended future behavior is to enable or disable already-registered adapters from the UI, scope that separately around configuration persistence and polling behavior. If it means adding arbitrary providers, each integration still needs adapter implementation and must not be represented as a generic model-entry form.

## Acceptance criteria

- Every quota row visibly separates usage from refresh timing beneath the existing provider header.
- Five-hour and weekly windows are easy to compare when both are available.
- Reset display uses provider-reported timestamps only; missing and idle cases remain accurately labeled.
- Nonstandard quota windows, plan-only cards, card hide/show, and expanded details continue to work.
- Two-column content is readable on desktop and stacks without overflow on narrow screens.
- The project tests, typecheck, and production web build pass.
- Provider integration management is not conflated with model catalogue management.

## Out of scope

- Changing adapter collection, API payloads, reset calculations, database schema, or polling cadence.
- Adding support for new provider integrations or a provider enable/disable settings UI.
- Changing provider order, dashboard card collapse behavior, or catalogue model management.

## Changelog

- **2026-10-oct-30 19:15 UTC** — Status → completed. Implemented and verified on the isolated `modelizer-dashboard-layout` worktree: quota usage/reset split, responsive stacking, idle and missing-reset states, light-only theme, and the final white canvas. `bun test` passed with 239 tests; typecheck and production build passed; both independent visual reviews returned PASS. User direction: "By default the modelizer must always use a white background. I do not use dark backgrounds. I don't mind if another user is able to choose a dark background if they want with a toggle switch, but I never want to see it dark unless I choose that. It has to be by default white." The live API timed out during final screenshots, so the visual fixture was route-intercepted. No commit, merge, or push was made; code remains uncommitted in the worktree.
- **2026-10-oct-30 16:56 UTC** — Status → proposed. Created after the user clarified that the requested plan should be written as a project artifact; the live dashboard and Git state were inspected first. No code changes made.
