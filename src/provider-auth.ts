import { existsSync } from "node:fs";
import { authJsonPath } from "./adapters/codex";
import type { Adapter } from "./adapters/types";

export type AuthMethod = "api-key" | `app: ${string}` | "oauth";
type Env = Record<string, string | undefined>;

interface AuthDescriptor {
  readonly authMethod: AuthMethod;
  readonly appAuthPresent?: (adapter: Adapter, env: Env) => boolean;
  readonly optInFlag?: string;
}

export interface ProviderAuth {
  readonly authMethod: AuthMethod;
  readonly appAuthPresent?: boolean;
  readonly oauthUsageEnabled?: boolean;
}

const configuredApp = (adapter: Adapter, env: Env): boolean => adapter.isConfigured(env);
const AUTH_METHODS: Readonly<Record<string, AuthDescriptor>> = {
  zai: { authMethod: "api-key" },
  openrouter: { authMethod: "api-key" },
  moonshot: { authMethod: "api-key" },
  claude: { authMethod: "app: Claude Code login", appAuthPresent: configuredApp, optInFlag: "CLAUDE_OAUTH_USAGE" },
  codex: { authMethod: "app: ChatGPT login", appAuthPresent: (_adapter, env) => existsSync(authJsonPath(env)) },
  cursor: { authMethod: "app: Cursor login", appAuthPresent: configuredApp },
  freellmapi: { authMethod: "app: FreeLLMAPI local ledger", appAuthPresent: configuredApp },
};

/** Describe an adapter's auth source using presence checks only; never open credential stores. */
export function providerAuth(adapter: Adapter, env: Env): ProviderAuth {
  const descriptor = AUTH_METHODS[adapter.id] ?? { authMethod: "api-key" };
  return {
    authMethod: descriptor.authMethod,
    ...(descriptor.appAuthPresent ? { appAuthPresent: descriptor.appAuthPresent(adapter, env) } : {}),
    ...(descriptor.optInFlag ? { oauthUsageEnabled: env[descriptor.optInFlag] === "1" } : {}),
  };
}
