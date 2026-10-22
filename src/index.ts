import { buildApi } from "./api";
import { ADAPTERS } from "./adapters";
import { loadConfig } from "./config";
import { openDb } from "./db";
import { createNotifier } from "./notify";
import { Scheduler } from "./scheduler";
import { resolveEnv } from "./secrets";

const config = loadConfig();
const env = resolveEnv(process.env as Record<string, string | undefined>, {
  log: (msg) => console.log(`[${new Date().toISOString()}] ${msg}`),
});
const dbPath = env.MODELIZER_DB ?? "data/modelizer.db";
const db = openDb(dbPath);
const enabled = ADAPTERS.filter((a) => config.providers[a.id]?.enabled === true);

if (enabled.length === 0) {
  console.error(
    "No providers enabled. Edit modelizer.toml ([providers.<id>] enabled = true) and restart.",
  );
  process.exit(1);
}

const bootedAt = new Date().toISOString();
const sessionId = db.startSession(bootedAt, process.pid);
const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);
db.addAudit(sessionId, bootedAt, null, "info", "session started", `pid ${process.pid}, db ${dbPath}`);

const notifier = createNotifier({ db, env, log });
const scheduler = new Scheduler({
  adapters: enabled,
  db,
  env,
  maxBackoffMs: config.scheduler.maxBackoffSeconds * 1000,
  log,
  audit: (e) => db.addAudit(sessionId, e.at, e.provider, e.level, e.event, e.detail),
  ...(notifier ? { notifier } : {}),
});
const stopTimer = scheduler.start(config.scheduler.tickSeconds * 1000);
void scheduler.tick().catch((err) => console.error(`initial tick failed: ${(err as Error).message}`));

const app = buildApi({
  db,
  adapters: enabled,
  env,
  currentSessionId: sessionId,
  token: config.server.token,
});
const server = Bun.serve({
  port: config.server.port,
  hostname: config.server.bind,
  // The peer address decides whether a request is local (trusted) or must present the token.
  fetch: (request, server) => app.fetch(request, { ip: server.requestIP(request) }),
});
log(`modelizer session #${sessionId}: ${enabled.map((a) => a.id).join(", ")} → http://${config.server.bind}:${server.port} (db: ${dbPath})`);

function shutdown() {
  stopTimer();
  server.stop(true);
  const at = new Date().toISOString();
  db.addAudit(sessionId, at, null, "info", "session stopped");
  db.endSession(sessionId, at);
  db.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
