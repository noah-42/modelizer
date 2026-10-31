import { spawnSync } from "node:child_process";

/**
 * Secret resolution: environment first, then the macOS Keychain.
 * Keychain entries are created by the user:
 *   security add-generic-password -s modelizer -a ZAI_API_KEY -w '<key>'
 * Nothing here logs secret values, and the DB never stores them.
 */
export const SECRET_NAMES = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_MANAGEMENT_KEY",
  "ZAI_API_KEY",
  "MOONSHOT_API_KEY",
  "OPENAI_ADMIN_API_KEY",
  "ANTHROPIC_ADMIN_API_KEY",
  "MODELIZER_WEBHOOK_SECRET",
] as const;

export const KEYCHAIN_SERVICE = "modelizer";

export type SecurityRunner = (args: string[]) => { status: number | null; stdout: string };
export type SecretName = (typeof SECRET_NAMES)[number];
export interface SecretOptions {
  platform?: NodeJS.Platform;
  run?: SecurityRunner;
  log?: (msg: string) => void;
  /**
   * Isolate keychain writes to this keychain FILE instead of the user's login keychain.
   * Test and fixture processes MUST set this (directly or via MODELIZER_KEYCHAIN_FILE) —
   * the default is the real login keychain, and QA must never touch user credentials.
   */
  keychainFile?: string;
}
export interface TokenStatus {
  set: boolean;
  source: "env" | "keychain" | "absent";
  shadowed: boolean;
}
type Env = Record<string, string | undefined>;
interface CredentialSnapshot {
  base: Env;
  statuses: Record<string, TokenStatus>;
  options: SecretOptions;
}
const snapshots = new WeakMap<Env, CredentialSnapshot>();

export class KeychainError extends Error {
  constructor() {
    super("Could not update the modelizer Keychain entry");
  }
}

function runSecurity(args: string[]): { status: number | null; stdout: string } {
  const res = spawnSync("security", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return { status: res.status, stdout: res.stdout ?? "" };
}

/**
 * The effective secret options: the caller's, plus the keychain-file isolation from
 * MODELIZER_KEYCHAIN_FILE when set. The `security` CLI takes the keychain path as its
 * trailing positional argument for find/add/delete-generic-password.
 */
function withIsolation(opts: SecretOptions): SecretOptions {
  const keychainFile = opts.keychainFile ?? (process.env.MODELIZER_KEYCHAIN_FILE?.trim() || undefined);
  if (keychainFile === undefined || opts.run !== undefined) return opts;
  return {
    ...opts,
    keychainFile,
    run: (args) => runSecurity([...args, keychainFile]),
  };
}

export function resolveEnv(
  base: Record<string, string | undefined>,
  opts: SecretOptions = {},
): Record<string, string | undefined> {
  const options = withIsolation(opts);
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runSecurity;
  const log = options.log ?? (() => {});
  const env: Record<string, string | undefined> = { ...base };

  const statuses: Record<string, TokenStatus> = {};
  for (const name of SECRET_NAMES) {
    const res = platform === "darwin"
      ? run(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name, "-w"])
      : { status: 44, stdout: "" };
    const secret = res.status === 0 ? res.stdout.trim() : "";
    statuses[name] = {
      set: Boolean(base[name] || secret),
      source: base[name] ? "env" : secret ? "keychain" : "absent",
      shadowed: Boolean(base[name] && secret),
    };
    if (!env[name] && secret !== "") {
      env[name] = secret;
      log(`${name}: loaded from macOS keychain`);
    }
  }
  snapshots.set(env, { base, statuses, options });
  return env;
}

/** Refresh only managed credentials in place so existing poll contexts see the new values. */
export function refreshCredentials(env: Env, opts: SecretOptions = {}): void {
  const snapshot = snapshots.get(env);
  const fresh = resolveEnv(snapshot?.base ?? { ...env }, { ...snapshot?.options, ...opts });
  for (const name of SECRET_NAMES) {
    if (fresh[name]) env[name] = fresh[name];
    else delete env[name];
  }
  const refreshed = snapshots.get(fresh);
  if (refreshed) snapshots.set(env, refreshed);
}

/** Return credential provenance only, never the effective or stored value. */
export function credentialStatus(env: Env, name: SecretName): TokenStatus {
  return snapshots.get(env)?.statuses[name] ?? {
    set: Boolean(env[name]), source: env[name] ? "env" : "absent", shadowed: false,
  };
}

/** Store a modelizer-owned Keychain entry; runner output is never exposed. */
export function writeSecret(name: SecretName, value: string, opts: SecretOptions = {}): void {
  const options = withIsolation(opts);
  if ((options.platform ?? process.platform) !== "darwin") throw new KeychainError();
  const result = (options.run ?? runSecurity)([
    "add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", name, "-w", value,
  ]);
  if (result.status !== 0) throw new KeychainError();
}

/** Remove only a modelizer-owned entry, treating an already absent entry as removed. */
export function removeSecret(name: SecretName, opts: SecretOptions = {}): void {
  const options = withIsolation(opts);
  if ((options.platform ?? process.platform) !== "darwin") throw new KeychainError();
  const result = (options.run ?? runSecurity)(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name]);
  if (result.status !== 0 && result.status !== 44) throw new KeychainError();
}
