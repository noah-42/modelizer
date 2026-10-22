import { readFileSync } from "node:fs";
import { parse } from "smol-toml";

export interface ProviderConfig {
  enabled: boolean;
}

export interface Config {
  server: { port: number; bind: string; token?: string | undefined };
  scheduler: { tickSeconds: number; maxBackoffSeconds: number };
  providers: Record<string, ProviderConfig>;
}

interface RawConfig {
  server?: { port?: number; bind?: string; token?: string };
  scheduler?: { tick_seconds?: number; max_backoff_seconds?: number };
  providers?: Record<string, { enabled?: boolean }>;
}

export const DEFAULT_CONFIG: Config = {
  server: { port: 7788, bind: "127.0.0.1" },
  scheduler: { tickSeconds: 30, maxBackoffSeconds: 3600 },
  providers: {},
};

export function loadConfig(path = "modelizer.toml"): Config {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // missing file is fine — defaults apply
  }
  const raw = text === "" ? ({} as RawConfig) : (parse(text) as RawConfig);

  const providers: Record<string, ProviderConfig> = {};
  for (const [id, p] of Object.entries(raw.providers ?? {})) {
    providers[id] = { enabled: p?.enabled === true };
  }
  return {
    server: {
      port: raw.server?.port ?? DEFAULT_CONFIG.server.port,
      bind: raw.server?.bind ?? DEFAULT_CONFIG.server.bind,
      token: raw.server?.token?.trim() || undefined,
    },
    scheduler: {
      tickSeconds: raw.scheduler?.tick_seconds ?? DEFAULT_CONFIG.scheduler.tickSeconds,
      maxBackoffSeconds: raw.scheduler?.max_backoff_seconds ?? DEFAULT_CONFIG.scheduler.maxBackoffSeconds,
    },
    providers,
  };
}
