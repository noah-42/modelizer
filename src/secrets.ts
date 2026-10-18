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

const KEYCHAIN_SERVICE = "modelizer";

type SecurityRunner = (args: string[]) => { status: number | null; stdout: string };

function runSecurity(args: string[]): { status: number | null; stdout: string } {
  const res = spawnSync("security", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return { status: res.status, stdout: res.stdout ?? "" };
}

export function resolveEnv(
  base: Record<string, string | undefined>,
  opts: { platform?: NodeJS.Platform; run?: SecurityRunner; log?: (msg: string) => void } = {},
): Record<string, string | undefined> {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? runSecurity;
  const log = opts.log ?? (() => {});
  const env: Record<string, string | undefined> = { ...base };

  if (platform !== "darwin") return env;
  for (const name of SECRET_NAMES) {
    if (env[name]) continue;
    const res = run(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name, "-w"]);
    const secret = res.status === 0 ? res.stdout.trim() : "";
    if (secret !== "") {
      env[name] = secret;
      log(`${name}: loaded from macOS keychain`);
    }
  }
  return env;
}
