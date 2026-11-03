/**
 * Per-provider info pages (MOD-R013): how each provider meters what modelizer
 * watches — five-hour, weekly and monthly windows, plus the known limits.
 *
 * Ground rules mirrored from the adapters (src/adapters/*):
 *  - Only provider-documented or locally-verified facts go in here.
 *  - Where a fact is NOT exposed by the provider, the page says so plainly
 *    instead of inventing a number (the same rule the adapters follow for
 *    resetsAt: never guess).
 *  - Sources name where each claim comes from so staleness is auditable.
 */

import type { ReactNode } from "react";

export interface GuideSection {
  title: string;
  body: ReactNode;
}

export interface ProviderGuide {
  /** What this provider meters, in one line. */
  summary: string;
  /** How modelizer gets the data (stability tier + source). */
  source: string;
  sections: GuideSection[];
}

const p = (...children: ReactNode[]): ReactNode => <p>{children}</p>;
const ul = (items: ReactNode[]): ReactNode => <ul>{items.map((it, i) => <li key={i}>{it}</li>)}</ul>;

export const PROVIDER_GUIDES: Record<string, ProviderGuide> = {
  claude: {
    summary:
      "Claude Pro/Max is metered by Anthropic as a rolling 5-hour window plus a weekly cap. Anthropic exposes no usage API for personal plans — everything modelizer knows is read locally.",
    source:
      "Stability tier 3 (local files and CLIs). Sources: ~/.claude/projects transcripts (token totals), the Claude Code statusLine payload and StopFailure hook (percentages), opt-in account-wide usage endpoint (CLAUDE_OAUTH_USAGE=1).",
    sections: [
      {
        title: "Five-hour window",
        body: (
          <>
            {p(
              "A rolling 300-minute window. It is NOT clockwork on the hour: the window opens at your first request after the previous window expires, so the reset time drifts with your usage pattern. Only the duration is fixed.",
            )}
            {ul([
              "Percentages arrive only when Claude Code reports them — via the statusLine payload (rate_limits, present on some versions/invocations), the StopFailure hook (an exact reset recorded when a rate limit fires), or the opt-in account-wide usage endpoint.",
              "modelizer never invents a reset time from the window duration — a blank means unknown, not soon.",
              "Token totals for the window come from session transcripts, so they cover this machine only.",
            ])}
          </>
        ),
      },
      {
        title: "Weekly window",
        body: (
          <>
            {p(
              "A fixed-in-time weekly cap (7×24 hours = 10080 minutes as a window length). Anthropic anchors it to your plan; modelizer shows a reset time only when a source reports one — it does not project it from the window length.",
            )}
          </>
        ),
      },
      {
        title: "Monthly / billing",
        body: (
          <>
            {p(
              "The plan itself (Pro, Max) renews monthly. modelizer merges provider-detected facts (plan name from the OAuth profile) with subscriptions.toml (price, renewal day). Money shown is the configured price, never a guessed invoice.",
            )}
          </>
        ),
      },
      {
        title: "Limits and known gaps",
        body: (
          <>
            {ul([
              "Anthropic publishes no message caps or usage API for personal plans — the dashboard's percentages are the only machine-readable view.",
              "`claude -p /usage` is a dead end on Claude Code 2.1.307+ (returns a local_command result).",
              "Statusline rate_limits arrive intermittently on 2.1.316+ — the 5h percentage may be stale between sessions.",
              "Claude Code 2.1.316+ stores no usable OAuth token in the legacy keychain item, so the account-wide usage endpoint answers 401 until modelizer learns the new credential store.",
              "Token totals are local-only: claude.ai usage and other devices are invisible unless CLAUDE_OAUTH_USAGE=1 works.",
            ])}
          </>
        ),
      },
    ],
  },

  zai: {
    summary:
      "The GLM Coding Plan meters a rolling 5-hour window (as a percentage only) plus a monthly token pool, billed in credits with peak/off-peak pricing.",
    source:
      "Stability tier 2 (undocumented community endpoints). Sources: Z.AI API poll, archived raw bodies, staleness shown on the card.",
    sections: [
      {
        title: "Five-hour window",
        body: (
          <>
            {p(
              "A rolling 5-hour window shared by coding-plan models. Z.AI reports it only as a percentage on this plan — the absolute token pool is not exposed, so the card shows %. The reset timestamp, when present, comes from the API response, never from the window length.",
            )}
          </>
        ),
      },
      {
        title: "Monthly pool",
        body: (
          <>
            {p(
              "The plan includes a monthly token pool on top of the 5-hour window. Its exact size is not exposed by the API on this plan; modelizer does not display an invented number.",
            )}
          </>
        ),
      },
      {
        title: "Credits and peak pricing",
        body: (
          <>
            {ul([
              "Usage is metered in credits: peak hours (weekdays 14:00–18:00 Singapore time = 06:00–10:00 UTC) cost 1×, off-peak 0.5×. Verified against docs.z.ai, 2026-10-03.",
              "Promotions can make all day off-peak (e.g. Sept 25 – Oct 7, 2026).",
              "The dashboard shows the current peak/off-peak state computed from the clock.",
            ])}
          </>
        ),
      },
      {
        title: "MCP tools and other limits",
        body: (
          <>
            {ul([
              "search-prime, web-reader and zread share a separate monthly request quota (100 calls on lite) — shown as its own meter.",
              "Cached input is billed cheaper than fresh input/output per Z.AI's discount schedule.",
              "The balance endpoint is not available on this plan (404) — shown as a degraded endpoint, never as a zero.",
            ])}
          </>
        ),
      },
    ],
  },

  codex: {
    summary:
      "ChatGPT-plan Codex usage has no API surface. Codex itself writes per-turn usage into local session logs, and exposes rate-limit windows through its app-server.",
    source:
      "Stability tier 3 (local files, app-server). Sources: ~/.codex/sessions/*.jsonl (tokens per model), account/rateLimits/read (windows). The plan type comes from the Codex id token, which is never archived.",
    sections: [
      {
        title: "Five-hour window",
        body: (
          <>
            {p(
              "A 300-minute rate-limit window. Windows follow their reported length, and a reset time is shown only when the app-server reports one — modelizer does not invent a reset from the duration.",
            )}
          </>
        ),
      },
      {
        title: "Weekly window",
        body: (
          <>
            {p(
              "A 10080-minute (weekly) window alongside the 5-hour one, same treatment: length from the payload, reset time only when reported.",
            )}
          </>
        ),
      },
      {
        title: "Monthly / billing",
        body: (
          <>
            {p(
              "The ChatGPT subscription renews monthly; modelizer shows the plan from the Codex id token (plan type only) and the price/renewal from subscriptions.toml. Platform-org API billing is a different surface and is not mixed in.",
            )}
          </>
        ),
      },
      {
        title: "Limits and known gaps",
        body: (
          <>
            {ul([
              "Everything is local: no network call carries your prompts or tokens.",
              "modelizer never sends thread/start or turn/start while reading rate limits — reads are side-effect free.",
              "If the app-server is unavailable, session logs are the fallback for token totals.",
            ])}
          </>
        ),
      },
    ],
  },

  cursor: {
    summary:
      "Cursor contributes subscription facts (plan, billing state) and current-period usage from the same endpoints the Cursor app itself reads.",
    source:
      "Stability tier 2 (undocumented endpoints; bearer read from Cursor's local state.vscdb, the same source CodexBar and ccursor use).",
    sections: [
      {
        title: "Billing-period usage",
        body: (
          <>
            {p(
              "Cursor meters included usage per billing period (monthly or yearly, per the plan), not in 5-hour windows. modelizer reads the period start and the included usage so the card shows where you are in the period.",
            )}
          </>
        ),
      },
      {
        title: "Monthly / billing",
        body: (
          <>
            {p(
              "Plan and subscription status come from the Stripe profile endpoint; price and renewal day come from subscriptions.toml. Facts win plan/state, config wins price/renewal — neither half is invented.",
            )}
          </>
        ),
      },
      {
        title: "Limits and known gaps",
        body: (
          <>
            {ul([
              "Undocumented endpoints can change without notice; raw bodies are archived and staleness is shown.",
              "The session token expires when you log out of Cursor — the card then shows the auth failure instead of stale zeros.",
              "Contributes facts only; it does not join the Subscriptions page's totals unless subscriptions.toml sets a price.",
            ])}
          </>
        ),
      },
    ],
  },

  openrouter: {
    summary:
      "OpenRouter is prepaid API credit, not a subscription: usage draws down a credit balance, with per-key limits and a free-model daily allowance.",
    source:
      "Stability tier 1 (official documented API). Sources: /api/v1/key, /api/v1/credits and /api/v1/activity (management key).",
    sections: [
      {
        title: "Credits (no rolling windows)",
        body: (
          <>
            {p(
              "There is no 5-hour or weekly cap to track. The meters are the credit balance (limit and remaining, when a limit is set), total usage, and the free-model daily request allowance.",
            )}
          </>
        ),
      },
      {
        title: "Daily / weekly / monthly usage",
        body: (
          <>
            {p(
              "The key endpoint reports usage_daily, usage_weekly and usage_monthly aggregates, and the activity endpoint gives per-model daily totals for the last 30 completed UTC days. These are reporting windows, not caps.",
            )}
          </>
        ),
      },
      {
        title: "Limits",
        body: (
          <>
            {ul([
              "Free models carry a daily request allowance (used/limit/remaining), tracked as its own meter.",
              "Unpriced models produce no cost row — the diary never shows a guessed zero-dollar spend.",
            ])}
          </>
        ),
      },
    ],
  },

  freellmapi: {
    summary:
      "A self-hosted free-LLM proxy: usage and any configured per-model daily limit are read from its own database.",
    source: "Stability tier 3 (local database). Sources: the proxy's SQLite usage records.",
    sections: [
      {
        title: "Daily limit and usage",
        body: (
          <>
            {p(
              "If the proxy records a numeric daily token limit beside a model's usage, modelizer shows used vs limit for the day. Otherwise the card reports plain token counts.",
            )}
          </>
        ),
      },
      {
        title: "Windows",
        body: (
          <>
            {p(
              "There are no provider-imposed 5-hour or weekly windows. Whatever quota exists is whatever the proxy's operator configured — shown exactly as recorded, never extrapolated.",
            )}
          </>
        ),
      },
    ],
  },

  moonshot: {
    summary:
      "Moonshot (Kimi) is prepaid API balance: the account holds a granted amount and usage draws it down.",
    source:
      "Stability tier 1 (documented endpoint /v1/users/me/balance, verified on api.moonshot.ai and api.moonshot.cn, 2026-10-30).",
    sections: [
      {
        title: "Balance",
        body: (
          <>
            {p(
              "The card shows available balance, voucher balance, total granted and total used. The .ai platform bills in USD, the .cn platform in CNY — currencies are never converted, totals stay per currency.",
            )}
          </>
        ),
      },
      {
        title: "Windows",
        body: (
          <>
            {p(
              "No provider-imposed 5-hour or weekly windows are exposed; the meter is the balance itself. Any rate limits Moonshot applies server-side are not reported to this endpoint.",
            )}
          </>
        ),
      },
    ],
  },

  xai: {
    summary:
      "Grok via xAI OAuth (the same login pi uses) — an experimental local read of pi's auth store plus xAI's usage endpoints.",
    source:
      "Stability tier 3 (experimental). Sources: pi's auth store (~/.pi/agent/auth.json) read at poll time; xAI API.",
    sections: [
      {
        title: "Tokens and windows",
        body: (
          <>
            {p(
              "modelizer never refreshes the xAI OAuth token — pi owns it, and a second refresher would log pi out. The access token is read only at poll time; if pi is not logged in, the card says so instead of guessing.",
            )}
          </>
        ),
      },
      {
        title: "Limits",
        body: (
          <>
            {p(
              "As an experimental adapter, treat its numbers as best-effort: whatever xAI exposes is shown, and missing fields stay blank rather than inferred.",
            )}
          </>
        ),
      },
    ],
  },
};

/** Providers with no compiled adapter yet — config can name them, the guide cannot. */
export const guideFor = (id: string): ProviderGuide | null => PROVIDER_GUIDES[id] ?? null;
