#!/usr/bin/env bun
/**
 * Regenerate src/pricing/anthropic.json from models.dev (the table CodexBar uses).
 * Run when a Claude model shows up unpriced: `bun run scripts/refresh-pricing.ts`.
 * Pricing is data, not configuration — the adapter never calls this host at runtime.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PRICING_PROVIDER, PRICING_SOURCE_URL, type ModelPrice } from "../src/pricing";

const TARGET = join(import.meta.dir, "..", "src", "pricing", "anthropic.json");

interface ModelsDevModel {
  cost?: Partial<ModelPrice>;
}

interface ModelsDevProvider {
  models?: Record<string, ModelsDevModel>;
}

async function main(): Promise<void> {
  const res = await fetch(PRICING_SOURCE_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`models.dev returned HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, ModelsDevProvider>;
  const provider = body[PRICING_PROVIDER];
  if (provider?.models === undefined) throw new Error(`models.dev has no "${PRICING_PROVIDER}" provider`);

  const table: Record<string, ModelPrice> = {};
  for (const [id, model] of Object.entries(provider.models)) {
    const c = model.cost;
    if (c === undefined) continue;
    if ([c.input, c.output, c.cache_read, c.cache_write].some((v) => typeof v !== "number")) continue;
    table[id] = {
      input: c.input as number,
      output: c.output as number,
      cache_read: c.cache_read as number,
      cache_write: c.cache_write as number,
    };
  }
  const sorted = Object.fromEntries(Object.entries(table).sort(([a], [b]) => (a < b ? -1 : 1)));
  writeFileSync(TARGET, `${JSON.stringify(sorted, null, 2)}\n`);
  process.stdout.write(`wrote ${Object.keys(sorted).length} models to ${TARGET}\n`);
}

await main();
