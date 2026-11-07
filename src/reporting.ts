import { createHash } from "node:crypto";
import type { Adapter, RawPoll } from "./adapters/types";
import { pollOrigin } from "./adapters/types";
import type { AdapterStateRow } from "./db";
import type { OverviewWindow } from "./windows";
import type { Subscription } from "./subscriptions";

/**
 * Runtime provenance: proof that a reading belongs to the running real account, without ever
 * returning key material. A source label like `zai-api` alone proves nothing — the effective
 * upstream origin and a non-secret account reference do.
 */
export interface Provenance {
  /** real = latest successful poll hit a production origin; demo = any other origin; unknown = no evidence yet. */
  mode: "real" | "demo" | "unknown";
  /** Effective upstream origin of the latest poll (raw URL origin; never includes credentials). */
  upstreamOrigin: string | null;
  /** Adapter id + server build, so a stale deployment is visible from outside. */
  adapterVersion: string;
  /** Non-secret plan/account label when the provider states one (e.g. "GLM Coding Plan (level: lite)"). */
  accountLabel: string | null;
  /** Stable opaque account reference (e.g. `zai-coding-level:lite`) — never a key, token or email. */
  accountRef: string | null;
  /** Where the account evidence came from, e.g. `quota-limit payload data.level`. */
  accountEvidence: string | null;
  /** Last successful poll against the real account (mode `real`), else null. */
  lastRealCheck: string | null;
}

export function provenanceOf(
  adapter: Adapter,
  buildVersion: string,
  state: AdapterStateRow | undefined,
  raws: ReadonlyArray<Pick<RawPoll, "endpoint" | "url" | "status" | "body">>,
  env: Record<string, string | undefined>,
): Provenance {
  // accountFacts reads parsed json when present; archived rows carry the body only, so parse it here.
  const polls = raws.map((r) => {
    let json: unknown = null;
    try {
      json = JSON.parse(r.body);
    } catch {
      // keep raw body only
    }
    return { ...r, json };
  });
  const account = adapter.accountFacts?.(polls, env) ?? null;
  const latest = raws.find((r) => r.status >= 200 && r.status < 300);
  const origin = latest !== undefined ? pollOrigin(latest.url) : null;
  const real = adapter.upstreamOrigins?.includes(origin ?? "") === true;
  const mode: Provenance["mode"] =
    latest === undefined || latest.status < 200 || latest.status >= 300
      ? "unknown"
      : adapter.upstreamOrigins === undefined
        ? "unknown"
        : real
          ? "real"
          : "demo";
  return {
    mode,
    upstreamOrigin: origin,
    adapterVersion: `${adapter.id}@${buildVersion}`,
    accountLabel: account?.label ?? null,
    accountRef: account?.ref ?? null,
    accountEvidence: account !== null ? "latest successful poll payload" : null,
    lastRealCheck: mode === "real" ? state?.last_success ?? null : null,
  };
}

/** What a provider can and cannot answer — each value is explicit, never guessed from presence alone. */
export type Capability = "supported" | "unsupported" | "auth-required" | "unknown";

export interface CapabilityMatrix {
  usage: Capability;
  shortWindow: Capability;
  weeklyWindow: Capability;
  monthlyWindow: Capability;
  resetTimestamps: Capability;
  billingRenewal: Capability;
  expiry: Capability;
  accountVerification: Capability;
}

function isAuthError(error: string | null): boolean {
  return error !== null && error.startsWith("auth:");
}

export function capabilitiesOf(args: {
  adapter: Adapter;
  state: AdapterStateRow | undefined;
  hasSuccessfulPoints: boolean;
  windows: OverviewWindow[];
  planOnly: boolean;
  subscription: Subscription | null;
}): CapabilityMatrix {
  const { adapter, state, hasSuccessfulPoints, windows, planOnly, subscription } = args;
  const authRequired = isAuthError(state?.last_error ?? null);
  const windowCap = (kind: string): Capability => {
    const supported = windows.some((w) => w.window === kind && !w.stale);
    if (supported) return "supported";
    if (windows.some((w) => w.window === kind && w.stale)) return authRequired ? "auth-required" : "unknown";
    if ((adapter.unsupportedWindows ?? []).includes(kind)) return "unsupported";
    if (planOnly) return "unsupported";
    if (authRequired) return "auth-required";
    return "unknown";
  };
  const usage: Capability = planOnly
    ? "unsupported"
    : hasSuccessfulPoints && !authRequired
      ? "supported"
      : authRequired
        ? "auth-required"
        : "unknown";
  return {
    usage,
    shortWindow: windowCap("five_hour"),
    weeklyWindow: windowCap("weekly"),
    monthlyWindow: windowCap("monthly"),
    resetTimestamps: windows.some((w) => w.reset.resetsAt !== null && !w.stale)
      ? "supported"
      : planOnly
        ? "unsupported"
        : "unknown",
    billingRenewal:
      subscription?.renewsAt != null
        ? "supported"
        : planOnly
          ? "unsupported"
          : subscription === null
            ? "unknown"
            : "unsupported",
    expiry: subscription?.endsAt != null ? "supported" : "unknown",
    accountVerification: "unknown",
  };
}

/**
 * One read-only change event, classified so a watcher never has to guess. Access recovery is
 * not quota recovery: a successful poll after an outage says nothing about allowance.
 */
export interface ProviderEvent {
  at: string;
  provider: string;
  type:
    | "quota-exhausted"
    | "observed-recovery"
    | "provider-confirmed-new-window"
    | "reset-schedule-changed"
    | "renewal-approaching"
    | "stale"
    | "auth-failure"
    | "poll-error"
    | "access-recovered";
  detail: string | null;
}

/** Hash over stable window identities and values — changes only when something a watcher cares about changed. */
export function snapshotVersionOf(items: Array<Record<string, unknown>>): string {
  const hash = createHash("sha256");
  for (const item of items) hash.update(JSON.stringify(item));
  return `v1_${hash.digest("hex").slice(0, 16)}`;
}
