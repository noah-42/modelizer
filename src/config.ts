import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { parse } from "smol-toml";
import { ADAPTERS } from "./adapters";

export interface ProviderConfig {
  enabled: boolean;
}

export interface Config {
  server: { port: number; bind: string; token?: string | undefined };
  scheduler: { tickSeconds: number; maxBackoffSeconds: number };
  providers: Record<string, ProviderConfig>;
  order?: string[];
}

interface RawConfig {
  server?: { port?: number; bind?: string; token?: string };
  scheduler?: { tick_seconds?: number; max_backoff_seconds?: number };
  providers?: Record<string, { enabled?: boolean }>;
  order?: string[];
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
    order: raw.order ?? ADAPTERS.map((adapter) => adapter.id),
  };
}

const DEFAULT_CONFIG_PATH = "modelizer.toml";

/** Persist a provider's enablement without changing other TOML content. */
export function setProviderEnabled(id: string, enabled: boolean, path = DEFAULT_CONFIG_PATH): void {
  validateProviderIds([id], path);
  const text = readConfigText(path);
  const lines = text.split("\n");
  const header = `[providers.${id}]`;
  const section = findProviderSection(lines, header);
  if (section === null) {
    const current = lines.join("\n");
    const separator = current.trim() === "" ? "" : current.endsWith("\n") ? "\n" : "\n\n";
    const block = `${separator}${header}\nenabled = ${enabled}\n`;
    writeConfigText(path, `${current}${block}`);
    return;
  } else {
    const enabledLine = section.body.findIndex((line) => /^\s*enabled\s*=/.test(line));
    if (enabledLine >= 0) {
      lines[section.start + enabledLine + 1] = `enabled = ${enabled}`;
    } else {
      lines.splice(section.end, 0, `enabled = ${enabled}`);
    }
  }
  writeConfigText(path, lines.join("\n"));
}

/** Persist provider display order after validating every id against the compiled registry. */
export function setProviderOrder(ids: string[], path = DEFAULT_CONFIG_PATH): void {
  validateProviderIds(ids, path);
  const text = readConfigText(path);
  const lines = text.split("\n");
  const firstSection = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootEnd = firstSection < 0 ? lines.length : firstSection;
  const orderLine = lines.slice(0, rootEnd).findIndex((line) => /^\s*order\s*=/.test(line));
  const value = `order = [${ids.map((id) => JSON.stringify(id)).join(", ")}]`;
  if (orderLine >= 0) lines[orderLine] = value;
  else {
    lines.splice(rootEnd, 0, value);
  }
  writeConfigText(path, lines.join("\n"));
}

function validateProviderIds(ids: string[], path: string): void {
  const known = new Set(ADAPTERS.map((adapter) => adapter.id));
  for (const id of ids) {
    if (!known.has(id)) throw new Error(`${path}: unknown provider "${id}"`);
  }
}

function readConfigText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

function writeConfigText(path: string, text: string): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}

function findProviderSection(lines: string[], header: string): {
  start: number;
  end: number;
  body: string[];
} | null {
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line));
  const sectionEnd = end < 0 ? lines.length : end;
  return { start, end: sectionEnd, body: lines.slice(start + 1, sectionEnd) };
}
