import { ADAPTERS_BY_ID } from "./adapters";
import { loadConfig } from "./config";
import { openDb } from "./db";
import { createNotifier } from "./notify";
import { Scheduler } from "./scheduler";
import { resolveEnv } from "./secrets";

// usage: bun run src/cli.ts poll [--provider <id>] [--json]
const argv = process.argv.slice(2);
const command = argv[0];
if (command !== "poll") {
  console.error("usage: bun run src/cli.ts poll [--provider <id>] [--json]");
  process.exit(2);
}
const providerArg = argv.includes("--provider") ? argv[argv.indexOf("--provider") + 1] : undefined;
const asJson = argv.includes("--json");

const config = loadConfig();
const env = resolveEnv(process.env as Record<string, string | undefined>);
const db = openDb(env.MODELIZER_DB ?? "data/modelizer.db");
const enabled = [...ADAPTERS_BY_ID.values()].filter((a) => config.providers[a.id]?.enabled === true);
const targets = providerArg ? enabled.filter((a) => a.id === providerArg) : enabled;

if (targets.length === 0) {
  console.error(providerArg ? `provider not found or not enabled: ${providerArg}` : "no providers enabled");
  db.close();
  process.exit(1);
}

const sessionId = db.startSession(new Date().toISOString(), process.pid);
const log = (m: string) => console.error(m);
const notifier = createNotifier({ db, env, log });
const scheduler = new Scheduler({
  adapters: targets,
  db,
  env,
  log,
  audit: (e) => db.addAudit(sessionId, e.at, e.provider, e.level, e.event, e.detail),
  ...(notifier ? { notifier } : {}),
});
for (const adapter of targets) {
  const outcome = await scheduler.runProvider(adapter.id);
  if (asJson) {
    console.log(JSON.stringify(outcome, null, 2));
    continue;
  }
  if (!outcome.ok) {
    console.error(`${adapter.id}: FAILED — ${outcome.error}`);
    continue;
  }
  console.log(`\n${adapter.id} — ${outcome.points.length} point(s)`);
  for (const p of outcome.points) {
    const fields = [
      `${p.kind}/${p.label}`,
      p.used !== null ? `used ${fmt(p.used)}` : null,
      p.limit !== null ? `limit ${fmt(p.limit)}` : null,
      p.remaining !== null ? `left ${fmt(p.remaining)}` : null,
      p.unit,
      p.reset_at ? `resets ${p.reset_at}` : null,
    ].filter(Boolean);
    console.log(`  ${fields.join(" · ")}`);
  }
}
await scheduler.notifyDue();
db.endSession(sessionId, new Date().toISOString());
db.close();

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n * 100) / 100}`;
}
