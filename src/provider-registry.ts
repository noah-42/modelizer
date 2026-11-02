import { ADAPTERS, ADAPTERS_BY_ID } from "./adapters";
import type { AuthMethod } from "./provider-auth";

/** Integrations we ship in the UI before the usage collector lands. */
export interface PendingIntegration {
  readonly id: string;
  readonly displayName: string;
  readonly authMethod: AuthMethod;
}

export const COLLECTOR_PENDING_MESSAGE =
  "Usage collector is not implemented in modelizer yet. Set plan, price, and renewal on the Subscriptions tab; the dashboard shows your saved plan until collection is wired.";

export const COLLECTOR_NO_SUBSCRIPTION_MESSAGE =
  "No subscriptions.toml entry yet — use Add subscription on the Subscriptions tab to show a dashboard card for this integration.";

export const PENDING_INTEGRATIONS: readonly PendingIntegration[] = [
  { id: "freebuff", displayName: "Free Buff", authMethod: "TBD" },
  { id: "opencode", displayName: "Open Code", authMethod: "TBD" },
  { id: "xai", displayName: "Grok (xAI)", authMethod: "api-key" },
] as const;

export const PENDING_BY_ID: ReadonlyMap<string, PendingIntegration> = new Map(
  PENDING_INTEGRATIONS.map((p) => [p.id, p]),
);

/** @deprecated use PENDING_BY_ID */
export const PLACEHOLDER_BY_ID = PENDING_BY_ID;

const ADAPTER_IDS = new Set(ADAPTERS.map((a) => a.id));
const PENDING_IDS = new Set(PENDING_INTEGRATIONS.map((p) => p.id));

export function isKnownProviderId(id: string): boolean {
  return ADAPTER_IDS.has(id) || PENDING_IDS.has(id);
}

/** Every id that may appear on the manage tab (integrations + subscription-backed dashboard cards). */
export function allManageProviderIds(configOrder: string[] | undefined, subscriptionProviders: string[]): string[] {
  return [
    ...new Set([
      ...(configOrder ?? []),
      ...ADAPTERS.map((a) => a.id),
      ...PENDING_INTEGRATIONS.map((p) => p.id),
      ...subscriptionProviders,
    ]),
  ];
}

/** Canonical manage-page names. Subscription labels NEVER name a provider ("Premium" is a plan, not a provider). */
export function manageDisplayName(id: string): string {
  const pending = PENDING_BY_ID.get(id);
  if (pending) return pending.displayName;
  return DISPLAY_NAMES[id] ?? id;
}

const DISPLAY_NAMES: Record<string, string> = {
  zai: "ZAI",
  claude: "Claude (Anthropic)",
  cursor: "SpaceX (Cursor)",
  codex: "Codex (OpenAI)",
  openrouter: "Open Router",
  freellmapi: "freellmapi.co",
  moonshot: "Kimi (Moonshot)",
  deepseek: "DeepSeek",
  xai: "Grok (xAI)",
};
