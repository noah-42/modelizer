import type { Adapter } from "./types";
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import { cursorAdapter } from "./cursor";
import { openRouterAdapter } from "./openrouter";
import { zaiAdapter } from "./zai";

/** Registry of every adapter compiled into the binary; grows one file per provider.
 *  Array order = dashboard display order (zai first per user preference). */
export const ADAPTERS: Adapter[] = [zaiAdapter, claudeAdapter, cursorAdapter, codexAdapter, openRouterAdapter];

export const ADAPTERS_BY_ID: ReadonlyMap<string, Adapter> = new Map(ADAPTERS.map((a) => [a.id, a]));
