import { buildApi } from "./api";
import { ADAPTERS } from "./adapters";
import { loadConfig } from "./config";
import { openDb } from "./db";
import { createNotifier } from "./notify";
import { Scheduler } from "./scheduler";
import { resolveEnv } from "./secrets";

/** Start the local server, including with no enabled providers; return its shutdown hook. */
export function startModelizer(env = resolveEnv(process.env)) {
  const configPath = env.MODELIZER_CONFIG?.trim() || "modelizer.toml";
  const config = loadConfig(configPath);
  const dbPath = env.MODELIZER_DB ?? "data/modelizer.db";
  const db = openDb(dbPath);
  const enabled = ADAPTERS.filter((a) => config.providers[a.id]?.enabled === true);
  const bootedAt = new Date().toISOString();
  const sessionId = db.startSession(bootedAt, process.pid);
  const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);
  db.addAudit(sessionId, bootedAt, null, "info", "session started", `pid ${process.pid}, db ${dbPath}`);

  const notifier = createNotifier({ db, env, log, isProviderEnabled: (id) => enabled.some((a) => a.id === id) });
  const scheduler = new Scheduler({
    adapters: enabled,
    db,
    env,
    maxBackoffMs: config.scheduler.maxBackoffSeconds * 1000,
    log,
    audit: (e) => db.addAudit(sessionId, e.at, e.provider, e.level, e.event, e.detail),
    ...(notifier ? { notifier } : {}),
  });
  // buildApi retains this array: mutate it on writes so its read routes see live order and enablement.
  const onProvidersChanged = () => {
    const latest = loadConfig(configPath);
    const ranks = new Map((latest.order ?? []).map((id, index) => [id, index]));
    const selected = ADAPTERS.filter((a) => latest.providers[a.id]?.enabled === true);
    selected.sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity));
    scheduler.reconfigure(selected);
    enabled.splice(0, enabled.length, ...selected);
  };
  onProvidersChanged();
  const stopTimer = scheduler.start(config.scheduler.tickSeconds * 1000);
  void scheduler.tick().catch(() => log("initial tick failed"));

  const app = buildApi({
    db,
    adapters: enabled,
    env,
    envRef: env,
    onProvidersChanged,
    configPath,
    currentSessionId: sessionId,
    ...(config.server.token ? { token: config.server.token } : {}),
  });
  const server = Bun.serve({
    port: config.server.port,
    hostname: config.server.bind,
    // The peer address decides whether a request is local (trusted) or must present the token.
    fetch: (request, server) => app.fetch(request, { ip: server.requestIP(request) }),
  });
  log(`modelizer session #${sessionId}: ${enabled.map((a) => a.id).join(", ")} → http://${config.server.bind}:${server.port} (db: ${dbPath})`);

  const shutdown = () => {
    stopTimer();
    server.stop(true);
    const at = new Date().toISOString();
    db.addAudit(sessionId, at, null, "info", "session stopped");
    db.endSession(sessionId, at);
    db.close();
  };
  return { server, scheduler, shutdown };
}

if (import.meta.main) {
  const { shutdown } = startModelizer();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
